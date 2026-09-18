import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobRecord,
  BackgroundJobTerminalInput,
} from './background-job-board';
import type { BackgroundJobStore } from './background-job-store';
import {
  classifyTerminalEvidence,
  fetchChildTranscript,
  responseError,
} from './child-transcript';
import { isRecord } from './guards';
import { getClient } from './opencode-client';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from './session-runtime-status';
import {
  COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
  guardCompletedStatusText,
  type TaskStatusOutput,
} from './task';

export const STOP_CONFIRMATION_GRACE_MS = 5_000;
export const DEFAULT_EVIDENCE_READ_TIMEOUT_MS = 5_000;
export const STOPPED_WITHOUT_TERMINAL_RESULT =
  'Background session stopped before a terminal task result was received.';
export const EVIDENCE_UNAVAILABLE_DIAGNOSTIC =
  'Terminal evidence could not be read after repeated attempts; task termination is unconfirmed (observation unavailable).';

export type RunRef = { taskID: string; generation: number };
export type ObservationToken = Readonly<
  RunRef & {
    activityRevision: number;
    terminalRevision: number;
    attemptRevision: number | undefined;
    baselineMessageID: string | undefined;
    episode: number;
    readStartedAt: number;
  }
>;
export type RuntimeObservation = {
  kind: 'busy' | 'retry' | 'quiescent' | 'unknown' | 'deleted';
  origin: string;
  readStartedAt: number;
  /** Timestamp supplied by an event, distinct from reception/read time. */
  observedAt?: number;
  diagnostic?: string;
  /** A collided runtime request can retry after this slot is released. */
  retryAfter?: Promise<void>;
  /** A cancellation verifier already checked its stable interval. */
  stable?: boolean;
  terminalOutcome?: string;
};
export type TaskOutputOrigin =
  | {
      kind: 'native';
      run: RunRef;
      callID: string;
      /** Host matched this pending by exact callID; parsed identity is not enough. */
      callIDConfirmed?: boolean;
    }
  | {
      kind: 'synthetic';
      occurrenceID: string;
      run?: RunRef;
      provenance: string;
    };
export type TerminalSignal =
  | { kind: 'inspect' }
  | { kind: 'output'; status: TaskStatusOutput; origin: TaskOutputOrigin }
  | { kind: 'session-error'; message: string }
  | { kind: 'cancel'; lease: BackgroundJobLease; reason?: string }
  | { kind: 'deadline' };
export type GateResult =
  | { kind: 'deferred'; record: BackgroundJobRecord }
  | { kind: 'committed'; record: BackgroundJobRecord }
  | { kind: 'stale' };
export interface BackgroundJobTerminalGate {
  capture(run: RunRef): ObservationToken | undefined;
  observe(token: ObservationToken, runtime: RuntimeObservation): GateResult;
  reconcile(run: RunRef, signal?: TerminalSignal): Promise<GateResult>;
  dispose(): void;
}

const terminalCommitBrand = Symbol('terminal-commit');
/** Opaque, single-use, bound to the issuing gate, record and exact transition. */
export type TerminalCommitToken = Readonly<{ [terminalCommitBrand]: true }>;
interface TerminalAuthorization {
  record: BackgroundJobRecord;
  input: BackgroundJobTerminalInput;
  validate(): boolean;
}
const authorizedByGate = new WeakMap<
  BackgroundJobTerminalGate,
  WeakMap<TerminalCommitToken, TerminalAuthorization>
>();

/** Board-side consumption only. There is intentionally no exported issuer. */
export function consumeTerminalCommitToken(
  gate: BackgroundJobTerminalGate | undefined,
  token: TerminalCommitToken,
  record: BackgroundJobRecord,
  input: BackgroundJobTerminalInput,
): boolean {
  const authorizations = gate && authorizedByGate.get(gate);
  const authorization = authorizations?.get(token);
  if (!authorization) return false;
  authorizations?.delete(token);
  return (
    authorization.record === record &&
    authorization.input === input &&
    authorization.validate()
  );
}

export function raceEvidenceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const settled = promise.catch(() => undefined);
  if (timeoutMs <= 0) return settled;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    settled,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function runtimeObservationFromSnapshot(
  snapshot: RuntimeSessionStatusSnapshot,
  taskID: string,
  readStartedAt: number,
): RuntimeObservation {
  const status = runtimeSessionStatus(snapshot, taskID);
  return {
    kind:
      snapshot.error || snapshot.malformedSessionIDs.has(taskID)
        ? 'unknown'
        : status === 'busy' || status === 'retry'
          ? status
          : 'quiescent',
    origin: 'session.status',
    readStartedAt,
    diagnostic: snapshot.error,
    retryAfter: snapshot.retryAfter,
  };
}

interface Observation {
  generation: number;
  activityRevision: number;
  episode: number;
  runtime?: RuntimeObservation;
  pendingRuntime?: boolean;
  pendingRuntimeContrast?: {
    token: ObservationToken;
    readSettled: Promise<void>;
  };
  idleCandidate?: RuntimeObservation;
  quiescentSince?: number;
  candidate?: { signal: TerminalSignal; token: ObservationToken };
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
}

type ReadResult =
  | { kind: 'ready'; value: unknown }
  | { kind: 'blocked'; retryAfter: Promise<void> };

/** A foreground run's synchronous native terminal return is itself
 * terminal evidence — the host call bound to this exact run has already
 * come back — but only when the host attributed the output by its exact
 * callID (callIDConfirmed); text-parsed identity could be a quoted
 * foreign task header. Background runs never qualify. */
function isForegroundNativeTerminal(
  signal: TerminalSignal | undefined,
  background: boolean,
): boolean {
  return (
    signal?.kind === 'output' &&
    signal.origin.kind === 'native' &&
    signal.origin.callIDConfirmed === true &&
    signal.status.state !== 'running' &&
    !background
  );
}

function hostOutcome(response: unknown): string | undefined {
  if (!isRecord(response) || responseError(response) !== undefined)
    return undefined;
  const info = isRecord(response.data) ? response.data : response;
  const outcome = info.outcome;
  return typeof outcome === 'string' &&
    ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(outcome)
    ? outcome
    : undefined;
}

function observationIdentity(token: ObservationToken): string {
  return JSON.stringify([
    token.generation,
    token.activityRevision,
    token.terminalRevision,
    token.attemptRevision,
    token.baselineMessageID,
    token.episode,
  ]);
}

const sessionInfoReads = new WeakMap<
  object,
  Map<string, { identity: string; promise: Promise<unknown> }>
>();

/** Share the raw, still-open host read with the rehydration existence probe.
 * A consumer deadline must not release this slot or authorize a new read. */
export function readSessionInfoForObservation(
  input: PluginInput,
  token: ObservationToken,
): Promise<unknown> {
  const client = getClient(input);
  const session = client?.session;
  if (typeof session?.get !== 'function') return Promise.resolve(undefined);
  let reads = sessionInfoReads.get(session);
  if (!reads) {
    reads = new Map();
    sessionInfoReads.set(session, reads);
  }
  const identity = observationIdentity(token);
  const existing = reads.get(token.taskID);
  if (existing)
    return existing.identity === identity
      ? existing.promise
      : Promise.reject(
          new Error('An earlier session-info observation is still in flight.'),
        );
  const promise = Promise.resolve().then(() =>
    session.get({
      path: { id: token.taskID },
      query: { directory: input.directory },
    }),
  );
  reads.set(token.taskID, { identity, promise });
  const release = () => {
    if (reads.get(token.taskID)?.promise === promise)
      reads.delete(token.taskID);
  };
  void promise.then(release, release);
  return promise;
}

export function createBackgroundJobTerminalGate(options: {
  backgroundJobBoard: BackgroundJobStore;
  input?: PluginInput;
  readRuntime?: (run: RunRef, startedAt: number) => Promise<RuntimeObservation>;
  readTerminalEvidence?: (taskID: string) => Promise<unknown>;
  baselineFor?: (taskID: string, generation: number) => string | undefined;
  observationRevisionFor?: (
    taskID: string,
    generation: number,
  ) => number | undefined;
  isObservationPending?: (taskID: string, generation: number) => boolean;
  onRunning?: (record: BackgroundJobRecord) => void;
  onTerminal?: (record: BackgroundJobRecord) => void;
  graceMs?: number;
  readTimeoutMs?: number;
  maxEvidenceRetries?: number;
  now?: () => number;
}): BackgroundJobTerminalGate {
  const board = options.backgroundJobBoard;
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? STOP_CONFIRMATION_GRACE_MS;
  const timeoutMs = options.readTimeoutMs ?? DEFAULT_EVIDENCE_READ_TIMEOUT_MS;
  const observations = new Map<string, Observation>();
  const tokens = new WeakSet<ObservationToken>();
  const openReads = new Map<
    string,
    { identity: string; underlying: Promise<unknown>; settled: Promise<void> }
  >();
  const inFlight = new Map<string, Promise<GateResult>>();
  const authorizations = new WeakMap<
    TerminalCommitToken,
    TerminalAuthorization
  >();
  let disposed = false;

  function observation(run: RunRef): Observation | undefined {
    const record = board.get(run.taskID);
    if (disposed || record?.generation !== run.generation) return;
    let value = observations.get(run.taskID);
    if (!value || value.generation !== run.generation) {
      if (value?.timer) clearTimeout(value.timer);
      value = {
        generation: run.generation,
        activityRevision: record.activityRevision,
        episode: 0,
        retries: 0,
      };
      observations.set(run.taskID, value);
    }
    if (value.activityRevision !== record.activityRevision) {
      if (value.timer) clearTimeout(value.timer);
      value = {
        generation: run.generation,
        activityRevision: record.activityRevision,
        episode: value.episode + 1,
        retries: 0,
      };
      observations.set(run.taskID, value);
    }
    return value;
  }

  function capture(run: RunRef): ObservationToken | undefined {
    const value = observation(run);
    if (!value) return;
    const token = Object.freeze({
      taskID: run.taskID,
      generation: run.generation,
      activityRevision: value.activityRevision,
      terminalRevision: board.get(run.taskID)?.terminalRevision ?? 0,
      attemptRevision: options.observationRevisionFor?.(
        run.taskID,
        run.generation,
      ),
      baselineMessageID: options.baselineFor?.(run.taskID, run.generation),
      episode: value.episode,
      readStartedAt: now(),
    });
    tokens.add(token);
    return token;
  }

  function current(token: ObservationToken): boolean {
    const value = observation(token);
    return (
      tokens.has(token) &&
      value !== undefined &&
      value.activityRevision === token.activityRevision &&
      board.get(token.taskID)?.terminalRevision === token.terminalRevision &&
      value.episode === token.episode &&
      options.baselineFor?.(token.taskID, token.generation) ===
        token.baselineMessageID &&
      options.observationRevisionFor?.(token.taskID, token.generation) ===
        token.attemptRevision
    );
  }

  function deferred(run: RunRef, diagnostic?: string): GateResult {
    const record = diagnostic
      ? board.markStatusUncertain(run.taskID, diagnostic, run.generation)
      : board.get(run.taskID);
    return record?.generation === run.generation
      ? { kind: 'deferred', record }
      : { kind: 'stale' };
  }

  function retry(run: RunRef, diagnostic: string): GateResult {
    const value = observation(run);
    if (!value) return { kind: 'stale' };
    if (
      !value.timer &&
      value.retries <= (options.maxEvidenceRetries ?? 3) &&
      board.get(run.taskID)?.state === 'running'
    ) {
      value.timer = setTimeout(
        () => {
          value.timer = undefined;
          if (observation(run) !== value) return;
          void reconcile(run);
        },
        Math.max(1, graceMs),
      );
      value.timer.unref?.();
    }
    return deferred(run, diagnostic);
  }

  function commit(
    token: ObservationToken,
    state: 'completed' | 'error' | 'cancelled' | 'stopped',
    text: string,
    lease?: BackgroundJobLease,
  ): GateResult {
    const value = observation(token);
    const before = board.get(token.taskID);
    if (!before || !value || !current(token)) return { kind: 'stale' };
    if (before.state !== 'running') {
      const terminal =
        before.state === 'reconciled' ? before.terminalState : before.state;
      return terminal === state && before.resultSummary === text
        ? { kind: 'committed', record: before }
        : deferred(token);
    }
    const input: BackgroundJobTerminalInput = Object.freeze({
      taskID: token.taskID,
      state,
      resultSummary: text,
      cancellationLease: lease,
      now: now(),
    });
    const candidateSignal = value.candidate?.signal;
    const foregroundNativeEvidence = isForegroundNativeTerminal(
      candidateSignal,
      before.background,
    );
    const authorization: TerminalCommitToken = Object.freeze({
      [terminalCommitBrand]: true,
    });
    authorizations.set(authorization, {
      input,
      record: before,
      validate: () =>
        current(token) &&
        (value.runtime?.kind === 'deleted' ||
          !options.isObservationPending?.(token.taskID, token.generation)) &&
        (value.runtime?.kind === 'quiescent' ||
          value.runtime?.kind === 'deleted' ||
          foregroundNativeEvidence),
    });
    const record = board.commitTerminal(input, authorization);
    if (record === before || !record) return deferred(token);
    const latest = board.get(token.taskID);
    if (
      latest?.generation !== record.generation ||
      latest.terminalRevision !== record.terminalRevision ||
      latest.state === 'running'
    )
      return { kind: 'stale' };
    if (value.timer) clearTimeout(value.timer);
    value.timer = undefined;
    value.candidate = undefined;
    options.onTerminal?.(record);
    return { kind: 'committed', record };
  }

  function observe(
    token: ObservationToken,
    runtime: RuntimeObservation,
  ): GateResult {
    if (!current(token) || runtime.readStartedAt < token.readStartedAt)
      return { kind: 'stale' };
    const value = observation(token);
    if (!value) return { kind: 'stale' };
    const before = board.get(token.taskID);
    if (!before) return { kind: 'stale' };
    if (
      runtime.observedAt !== undefined &&
      runtime.observedAt < (before.lastLiveBusyAt ?? before.runStartedAt)
    )
      return { kind: 'stale' };
    const predatesPublication =
      runtime.observedAt !== undefined &&
      before.completedAt !== undefined &&
      runtime.observedAt <= before.completedAt;
    if (
      runtime.origin === 'session.status-event' &&
      (runtime.observedAt === undefined || predatesPublication)
    ) {
      // completedAt is local publication time, not proven host termination.
      // An ambiguous event needs fresh runtime, never an immediate reopen or
      // reuse of the observation that authorized the publication.
      value.episode += 1;
      value.pendingRuntime = false;
      value.runtime = undefined;
      value.quiescentSince = undefined;
      // Ambiguous busy/retry is live activity: drop held candidates.
      value.candidate = undefined;
      value.idleCandidate = undefined;
      if (value.timer) clearTimeout(value.timer);
      value.timer = undefined;
      return deferred(token);
    }
    if (predatesPublication) return { kind: 'stale' };
    if (runtime.origin === 'session.idle') {
      value.idleCandidate = runtime;
      value.pendingRuntime = false;
      value.retries = 0;
      return deferred(token);
    }
    value.pendingRuntime =
      runtime.origin === 'session.status' ||
      runtime.origin === 'cancel-verifier';
    if (runtime.kind === 'busy' || runtime.kind === 'retry') {
      value.episode += 1;
      value.quiescentSince = undefined;
      value.retries = 0;
      value.candidate = undefined;
      value.idleCandidate = undefined;
      if (value.timer) clearTimeout(value.timer);
      value.timer = undefined;
      value.runtime = runtime;
      const record = board.markRunningFromLiveSession(
        token.taskID,
        runtime.observedAt ?? runtime.readStartedAt,
        token.generation,
        runtime.observedAt === undefined ? token.terminalRevision : undefined,
      );
      if (!record) return { kind: 'stale' };
      value.activityRevision = record.activityRevision;
      options.onRunning?.(record);
      return { kind: 'deferred', record };
    }
    // Recovering runtime starts a fresh evidence budget. Repeated quiescent
    // reads must not replenish it while transcript stabilization is pending.
    if (runtime.kind === 'quiescent' && value.runtime?.kind !== 'quiescent')
      value.retries = 0;
    value.runtime = runtime;
    if (runtime.kind === 'unknown') {
      if (runtime.retryAfter) {
        // A collision is not a new runtime observation. Retain the current
        // identity and the request, even when repairing a terminal record.
        value.pendingRuntime = false;
        return requestRuntimeContrastAfterRead(
          token,
          runtime.retryAfter,
          runtime.diagnostic,
        );
      }
      value.episode += 1;
      // Unknown invalidates open evidence, but never replenishes retries.
      // inspect accounts for the failed attempt, including missing APIs.
      value.quiescentSince = undefined;
      if (value.timer) clearTimeout(value.timer);
      value.timer = undefined;
      return deferred(
        token,
        runtime.diagnostic ??
          'Runtime observation unavailable; task termination is unconfirmed.',
      );
    }
    value.quiescentSince ??= now();
    if (
      runtime.kind === 'deleted' &&
      board.get(token.taskID)?.deadlineExceededAt !== undefined
    ) {
      return commit(
        token,
        'error',
        'Background task exceeded its wall-clock deadline; session deletion confirmed the abort.',
      );
    }
    return deferred(token);
  }

  function requestRuntimeContrastAfterRead(
    token: ObservationToken,
    readSettled: Promise<void>,
    diagnostic = 'Previous evidence read is still open; task termination is unconfirmed.',
  ): GateResult {
    const value = observation(token);
    if (!value || !current(token)) return { kind: 'stale' };
    if (value.pendingRuntimeContrast?.readSettled === readSettled) {
      // Coalesce repeated requests against the same open read to the latest
      // requested episode, without adding another completion callback.
      value.pendingRuntimeContrast.token = token;
      return deferred(token, diagnostic);
    }
    const pending = { token, readSettled };
    value.pendingRuntimeContrast = pending;
    void readSettled.then(async () => {
      if (!current(pending.token)) return;
      const key = JSON.stringify([
        pending.token.taskID,
        observationIdentity(pending.token),
      ]);
      // The slot can be released before the deferred inspection's finally.
      // Wait for that existing flight, so reconcile cannot just rejoin it.
      await inFlight.get(key);
      if (value.pendingRuntimeContrast !== pending || !current(pending.token))
        return;
      value.pendingRuntimeContrast = undefined;
      value.pendingRuntime = false;
      await reconcile(pending.token);
    });
    return deferred(token, diagnostic);
  }

  // Timeout releases the consumer, NEVER the underlying operation. Identity
  // changes cannot join old evidence or start another read while it is open.
  async function read(
    key: string,
    token: ObservationToken,
    operation: () => Promise<unknown>,
  ): Promise<ReadResult> {
    const identity = observationIdentity(token);
    let entry = openReads.get(key);
    if (entry && entry.identity !== identity)
      return { kind: 'blocked', retryAfter: entry.settled };
    if (!entry) {
      const underlying = Promise.resolve().then(operation);
      const release = () => {
        if (openReads.get(key)?.underlying === underlying)
          openReads.delete(key);
      };
      // Share availability, never the previous identity's response. As with
      // the SDK registry, consumer timeout does not release this slot.
      const settled = underlying.then(release, release);
      entry = { identity, underlying, settled };
      openReads.set(key, entry);
    }
    return {
      kind: 'ready',
      value: await raceEvidenceDeadline(entry.underlying, timeoutMs),
    };
  }

  async function inspect(run: RunRef): Promise<GateResult> {
    let token = capture(run);
    if (!token) return { kind: 'stale' };
    const value = observation(run);
    if (!value) return { kind: 'stale' };
    const cancellation = value.candidate?.signal.kind === 'cancel';
    // A sealed cancellation verification is consumed as-is. Polling adapters
    // likewise pass their fresh batched observation without a second lookup.
    const suppliedRuntime = value.pendingRuntime;
    value.pendingRuntime = false;
    if (!suppliedRuntime && !(cancellation && value.runtime?.stable)) {
      if (
        options.readRuntime ||
        (options.input &&
          typeof getClient(options.input)?.session?.status === 'function')
      ) {
        const hostInput = options.input;
        const startedAt = token.readStartedAt;
        const response = await read(
          `runtime:${run.taskID}`,
          token,
          async () => {
            if (options.readRuntime) return options.readRuntime(run, startedAt);
            if (hostInput)
              return runtimeObservationFromSnapshot(
                await getRuntimeSessionStatusSnapshot(hostInput),
                run.taskID,
                startedAt,
              );
            return undefined;
          },
        );
        if (!current(token)) return { kind: 'stale' };
        if (response.kind === 'blocked')
          return requestRuntimeContrastAfterRead(token, response.retryAfter);
        const result = observe(
          token,
          (response.value as RuntimeObservation) ?? {
            kind: 'unknown',
            origin: 'timeout',
            readStartedAt: token.readStartedAt,
          },
        );
        value.pendingRuntime = false;
        if (result.kind === 'stale') return result;
        token = capture(run);
        if (!token) return { kind: 'stale' };
      } else if (options.input) {
        const client = getClient(options.input);
        const input = options.input;
        const observation = token;
        if (typeof client?.session?.get === 'function') {
          const response = await read(`outcome:${run.taskID}`, token, () =>
            readSessionInfoForObservation(input, observation),
          );
          if (!current(token)) return { kind: 'stale' };
          if (response.kind === 'blocked')
            return requestRuntimeContrastAfterRead(token, response.retryAfter);
          const outcome = hostOutcome(response.value);
          if (outcome) {
            observe(token, {
              kind: 'quiescent',
              origin: 'host-outcome',
              readStartedAt: token.readStartedAt,
              terminalOutcome: outcome,
            });
          } else if (
            !value.runtime ||
            value.runtime.origin === 'host-outcome'
          ) {
            observe(token, {
              kind: 'unknown',
              origin: 'host-outcome',
              readStartedAt: token.readStartedAt,
            });
          }
          // As with session.status, our own unknown observation advances the
          // episode. Continue with its token rather than losing the retry as stale.
          token = capture(run);
          if (!token) return { kind: 'stale' };
        }
      }
    }
    if (!current(token)) return { kind: 'stale' };
    const runtime = value.runtime;
    const job = board.get(run.taskID);
    if (!job || job.generation !== run.generation) return { kind: 'stale' };
    const candidate = value.candidate;
    let signal =
      candidate && current(candidate.token) ? candidate.signal : undefined;
    // Re-arm only a local episode bump with every other identity barrier
    // intact. Foreground only; a genuine busy already cleared the candidate.
    if (
      !signal &&
      candidate &&
      !job.background &&
      candidate.signal.kind === 'output' &&
      candidate.signal.origin.kind === 'native' &&
      candidate.signal.origin.run.taskID === run.taskID &&
      candidate.signal.origin.run.generation === run.generation &&
      candidate.token.baselineMessageID === token.baselineMessageID &&
      candidate.token.attemptRevision === token.attemptRevision &&
      candidate.token.terminalRevision === token.terminalRevision
    ) {
      value.candidate = { signal: candidate.signal, token };
      signal = candidate.signal;
    }
    const foregroundNativeTerminal = isForegroundNativeTerminal(
      signal,
      job.background,
    );
    if (
      !foregroundNativeTerminal &&
      (runtime?.kind === 'busy' || runtime?.kind === 'retry')
    )
      return deferred(run);
    if (!foregroundNativeTerminal && (!runtime || runtime.kind === 'unknown')) {
      // Occupied readers already own an availability-driven continuation;
      // they neither consume the diagnostic budget nor need a second timer.
      if (runtime?.retryAfter) return deferred(run);
      value.retries += 1;
      return retry(
        run,
        value.retries > (options.maxEvidenceRetries ?? 3)
          ? EVIDENCE_UNAVAILABLE_DIAGNOSTIC
          : 'Runtime observation unavailable; task termination is unconfirmed.',
      );
    }
    if (options.isObservationPending?.(run.taskID, run.generation))
      return retry(
        run,
        'Fallback handoff pending; task termination is unconfirmed.',
      );
    if (
      job.state !== 'running' &&
      (job.state === 'reconciled' ? job.terminalState : job.state) !==
        'completed'
    )
      return { kind: 'committed', record: job };
    if (
      signal?.kind === 'cancel' &&
      runtime?.stable === true &&
      board.validateLease(signal.lease)
    ) {
      return commit(
        token,
        'cancelled',
        signal.reason ?? 'cancelled',
        signal.lease,
      );
    }
    if (job.deadlineExceededAt !== undefined) {
      return commit(
        token,
        'error',
        'Background task exceeded its wall-clock deadline; quiescence confirmed the abort.',
      );
    }
    if (signal?.kind === 'session-error')
      return commit(token, 'error', signal.message);
    const transcriptRead = await read(`transcript:${run.taskID}`, token, () =>
      options.readTerminalEvidence
        ? options.readTerminalEvidence(run.taskID)
        : options.input
          ? fetchChildTranscript(
              getClient(options.input),
              run.taskID,
              options.input.directory,
            )
          : Promise.resolve(undefined),
    );
    if (!current(token)) return { kind: 'stale' };
    if (transcriptRead.kind === 'blocked')
      return requestRuntimeContrastAfterRead(token, transcriptRead.retryAfter);
    const response = transcriptRead.value;
    if (options.isObservationPending?.(run.taskID, run.generation))
      return retry(
        run,
        'Fallback handoff pending; task termination is unconfirmed.',
      );
    let terminalOutcome = runtime?.terminalOutcome;
    let evidence = classifyTerminalEvidence(response, {
      baselineMessageID: token.baselineMessageID,
      runStartedAt: job.runStartedAt,
      terminalOutcomeConfirmed: terminalOutcome === 'succeeded',
    });
    if (
      evidence.verdict !== 'completed' &&
      evidence.verdict !== 'error' &&
      !terminalOutcome &&
      options.input
    ) {
      const client = getClient(options.input);
      const input = options.input;
      const observation = token;
      if (typeof client?.session?.get === 'function') {
        const outcomeResponse = await read(`outcome:${run.taskID}`, token, () =>
          readSessionInfoForObservation(input, observation),
        );
        if (!current(token)) return { kind: 'stale' };
        if (outcomeResponse.kind === 'blocked')
          return requestRuntimeContrastAfterRead(
            token,
            outcomeResponse.retryAfter,
          );
        if (options.isObservationPending?.(run.taskID, run.generation))
          return retry(
            run,
            'Fallback handoff pending; task termination is unconfirmed.',
          );
        terminalOutcome = hostOutcome(outcomeResponse.value);
        if (terminalOutcome === 'succeeded')
          evidence = classifyTerminalEvidence(response, {
            baselineMessageID: token.baselineMessageID,
            runStartedAt: job.runStartedAt,
            terminalOutcomeConfirmed: true,
          });
      }
    }
    if (evidence.verdict === 'completed' || evidence.verdict === 'error')
      return commit(token, evidence.verdict, evidence.text);
    // Native return is attributable only when no transcript exists. Foreground
    // still publishes when the transcript is pending; empty result uses a
    // placeholder instead of the original whitespace.
    if (
      response === undefined &&
      signal?.kind === 'output' &&
      signal.origin.kind === 'native' &&
      signal.status.result?.trim() &&
      signal.status.state !== 'running'
    ) {
      return commit(token, signal.status.state, signal.status.result);
    }
    if (
      foregroundNativeTerminal &&
      signal?.kind === 'output' &&
      signal.status.state !== 'running'
    ) {
      const { state, result } = signal.status;
      // A textless completion is an error, same rule as every other
      // completed publication (guardCompletedStatusText): never invent a
      // success summary for a finished run that produced no text.
      const guarded = guardCompletedStatusText(
        state,
        result,
        board.get(run.taskID)?.resultSummary,
      );
      return commit(
        token,
        guarded.state,
        guarded.resultSummary ??
          `Foreground task ended with state ${guarded.state}.`,
      );
    }
    const stable = now() - (value.quiescentSince ?? now()) >= graceMs;
    if (
      terminalOutcome &&
      ['failed', 'interrupted', 'cancelled'].includes(terminalOutcome)
    )
      return commit(
        token,
        'error',
        `Host reported outcome: ${terminalOutcome}.`,
      );
    if (evidence.verdict === 'absent' && stable)
      return commit(token, 'stopped', STOPPED_WITHOUT_TERMINAL_RESULT);
    value.retries += 1;
    if (
      terminalOutcome === 'succeeded' &&
      stable &&
      evidence.verdict === 'retry' &&
      evidence.reason === 'textless' &&
      value.retries > (options.maxEvidenceRetries ?? 3)
    )
      return commit(token, 'error', COMPLETED_WITHOUT_TEXT_DIAGNOSTIC);
    // A parsed completed label is not independent termination evidence.
    // Even an empty assistant placeholder remains unknown indefinitely.
    return retry(
      run,
      value.retries > (options.maxEvidenceRetries ?? 3)
        ? EVIDENCE_UNAVAILABLE_DIAGNOSTIC
        : evidence.verdict === 'retry' && evidence.reason === 'textless'
          ? COMPLETED_WITHOUT_TEXT_DIAGNOSTIC
          : 'Runtime session is idle; task termination is unconfirmed.',
    );
  }

  function reconcile(
    run: RunRef,
    signal: TerminalSignal = { kind: 'inspect' },
  ): Promise<GateResult> {
    const token = capture(run);
    if (!token) return Promise.resolve({ kind: 'stale' });
    const value = observation(run);
    if (!value) return Promise.resolve({ kind: 'stale' });
    if (signal.kind !== 'inspect') {
      const origin = signal.kind === 'output' ? signal.origin.run : run;
      if (
        origin?.taskID === run.taskID &&
        origin.generation === run.generation
      ) {
        value.retries = 0;
        value.candidate = { signal, token };
        if (signal.kind === 'output' && signal.status.state === 'running')
          board.updateStatus({
            taskID: run.taskID,
            state: 'running',
            expectedGeneration: run.generation,
            timedOut: signal.status.timedOut,
          });
      }
    }
    const key = JSON.stringify([run.taskID, observationIdentity(token)]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = inspect(run).finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  const gate: BackgroundJobTerminalGate = {
    capture,
    observe,
    reconcile,
    dispose() {
      disposed = true;
      authorizedByGate.delete(gate);
      for (const value of observations.values())
        if (value.timer) clearTimeout(value.timer);
      observations.clear();
      inFlight.clear();
    },
  };
  authorizedByGate.set(gate, authorizations);
  board.bindTerminalGate(gate);
  return gate;
}
