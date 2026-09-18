import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobRecord,
  ContextFile,
} from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import {
  fetchChildTranscript,
  responseError,
  stringifyError,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { getClient } from '../../utils/opencode-client';
import type { SessionSelection } from '../../utils/session-selection';

const DEFAULT_NOTIFICATION_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TERMINAL_NOTIFICATION_TIMEOUT_MS = 10_000;
const DEFAULT_HANDOFF_EXPIRY_MS = 30_000;

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    error?: unknown;
    finish?: string;
    time?: { completed?: number };
  };
  parts?: Array<{
    type?: string;
    text?: string;
    state?: { status?: string };
  }>;
};

type RevivedRun = {
  taskID: string;
  generation: number;
  parentSessionID: string;
  baselineMessageID?: string;
  description: string;
  /** Monotonic observation identity: incremented on every
   * registration so evidence consumers can fence a snapshot against a
   * same-generation substitution. */
  revision: number;
  notification: {
    attempts: number;
    sent: boolean;
    pending: boolean;
    retryTimer?: ReturnType<typeof setTimeout>;
  };
  terminalState?: 'completed' | 'error';
  terminalRevision?: number;
};

export interface RevivedRunTracker {
  captureBaseline(taskID: string): Promise<string | undefined>;
  register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void;
  isTracked(taskID: string, generation: number): boolean;
  /** Baseline anchor for a tracked run, so transcript-evidence consumers
   * (stop gate) can attribute the trailing answer to THIS run instead of
   * a substituted attempt. Undefined for untracked/stale generations. */
  baselineFor(taskID: string, generation: number): string | undefined;
  probe(taskID: string, generation: number): Promise<boolean>;
  onTerminal(record: BackgroundJobRecord): void;
  /** Fallback observation handoff: prepare before the admission await
   * so the stop gate defers terminal publication until a delivery owner
   * exists. Admit converts the preparation into a tracked run
   * (immediate probe, no reinstall). Reject withdraws on an explicit
   * host refusal (error envelope / capability rejection). A hung
   * admission PROMOTES the preparation into the owning run instead of
   * dropping it. `isObservationPending` stays true until admit/reject
   * OR a bounded unresolved-admission timer lifts the fence (owner
   * kept) so a valid empty transcript can still confirm stopped. */
  prepareObservation(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): boolean;
  admitObservation(taskID: string, generation: number): boolean;
  /** Explicit host refusal (error envelope / capability rejection):
   * nothing was admitted, ownership is released. */
  rejectObservation(taskID: string, generation: number): void;
  /** Unknown admission outcome (transport failed without a response):
   * the prepared ownership CONVERTS into a tracked run instead of being
   * dropped — the host may still have accepted the replay. The gate
   * fence lifts after one more expiry window if admit/reject never
   * arrive; the owner stays. */
  settleObservationUnresolved(taskID: string, generation: number): boolean;
  isObservationPending(taskID: string, generation: number): boolean;
  /** Observation-identity fence for the stop gate: a monotonic
   * revision per tracked run; changes on re-registration even when the
   * baseline value is identical (especially undefined). */
  revisionFor(taskID: string, generation: number): number | undefined;
  dispose(): void;
}

export function createRevivedRunTracker(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  terminalGate: BackgroundJobTerminalGate;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  maxNotificationRetries?: number;
  notificationRetryDelayMs?: number;
  handoffExpiryMs?: number;
  onRegister?: (taskID: string) => void;
  onSettled?: (taskID: string) => void;
  contextFilesForPrompt?: (taskID: string) => ContextFile[];
  pruneContext?: () => void;
  /** Resolve the parent session's CURRENT agent/model selection at send
   * time (#1079): a terminal notification must continue the parent in
   * the mode the session uses now, never a hardcoded `orchestrator`.
   * Resolved on EVERY attempt (retries re-enter the send path). When
   * absent or unresolved, behavior falls back to `orchestrator`. */
  resolveSelection?: (sessionID: string) => Promise<SessionSelection>;
}): RevivedRunTracker {
  const runs = new Map<string, RevivedRun>();
  // Monotonic observation identity across registrations (fence for the
  // stop gate's evidence snapshot; see RevivedRun.revision).
  let revisionSequence = 0;
  const maxNotificationRetries =
    options.maxNotificationRetries ?? DEFAULT_NOTIFICATION_RETRIES;
  const retryDelayMs =
    options.notificationRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let disposed = false;

  const captureBaseline = async (
    taskID: string,
  ): Promise<string | undefined> => {
    const response = await fetchChildTranscript(
      getClient(options.input),
      taskID,
      options.input.directory,
    );
    if (response === undefined) return undefined;
    const data =
      isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const last = data.at(-1) as SessionMessage | undefined;
    return typeof last?.info?.id === 'string' ? last.info.id : undefined;
  };

  const isTracked = (taskID: string, generation: number): boolean => {
    const run = runs.get(taskID);
    return run?.generation === generation;
  };

  const probe = async (
    taskID: string,
    generation: number,
  ): Promise<boolean> => {
    const run = runs.get(taskID);
    if (!run || run.generation !== generation || disposed) return false;
    const result = await options.terminalGate.reconcile(run, {
      kind: 'inspect',
    });
    if (disposed || runs.get(taskID) !== run || result.kind === 'stale')
      return false;
    onTerminal(result.record);
    return result.record.state !== 'running';
  };

  const onTerminal = (record: BackgroundJobRecord): void => {
    const run = runs.get(record.taskID);
    if (!run || run.generation !== record.generation) return;
    const current = options.backgroundJobBoard.get(record.taskID);
    if (
      !current ||
      current.generation !== record.generation ||
      current.terminalRevision !== record.terminalRevision ||
      current.state === 'running'
    )
      return;
    if (record.state === 'cancelled') {
      settleRun(run, record);
      options.backgroundJobSupervisor?.onTerminal(record);
      return;
    }
    if (record.state !== 'completed' && record.state !== 'error') {
      return;
    }
    finish(run, record);
  };

  const dispose = (): void => {
    disposed = true;
    for (const run of runs.values()) {
      if (run.notification.retryTimer) {
        clearTimeout(run.notification.retryTimer);
      }
    }
    runs.clear();
  };

  function finish(run: RevivedRun, record: BackgroundJobRecord): boolean {
    if (disposed || runs.get(run.taskID) !== run) return false;
    if (record.state !== 'completed' && record.state !== 'error') return false;
    if (run.terminalRevision !== record.terminalRevision) {
      if (run.notification.retryTimer)
        clearTimeout(run.notification.retryTimer);
      run.notification = { attempts: 0, sent: false, pending: false };
      run.terminalRevision = record.terminalRevision;
    }
    run.terminalState = record.state;
    settleRun(run, record);
    options.backgroundJobSupervisor?.onTerminal(record);
    if (run.notification.sent || run.notification.pending) return true;
    void notifyParent(run, record);
    return true;
  }

  function settleRun(run: RevivedRun, record: BackgroundJobRecord): void {
    options.backgroundJobBoard.addContext(
      record.taskID,
      options.contextFilesForPrompt?.(record.taskID) ?? [],
    );
    options.backgroundJobBoard.addContext(record.taskID, record.contextFiles);
    options.pruneContext?.();
    options.onSettled?.(run.taskID);
  }

  async function notifyParent(
    run: RevivedRun,
    record: BackgroundJobRecord,
  ): Promise<void> {
    if (disposed || run.notification.sent || run.notification.pending) return;
    if (run.terminalRevision !== record.terminalRevision) return;
    const notification = run.notification;
    run.notification.pending = true;
    run.notification.attempts += 1;
    try {
      const session = getClient(options.input).session;
      const promptAsync =
        typeof session.promptAsync === 'function'
          ? session.promptAsync.bind(session)
          : undefined;
      if (typeof promptAsync !== 'function') {
        throw new Error('session.promptAsync unavailable');
      }
      const current = options.backgroundJobBoard.get(run.taskID);
      if (
        !current ||
        current.generation !== run.generation ||
        current.terminalRevision !== record.terminalRevision ||
        terminalOutcome(current) !== run.terminalState ||
        record.state !== run.terminalState
      ) {
        return;
      }
      const state = record.state === 'completed' ? 'completed' : 'error';
      const tag = state === 'completed' ? 'task_result' : 'task_error';
      const summary =
        state === 'completed'
          ? `Background task completed: ${run.description}`
          : `Background task failed: ${run.description}`;
      // Resolve BEFORE acquiring the lease: a hung host read must not
      // pin the notification lease. Host `session.get` is bounded inside
      // resolveCurrentSelection; metadata still completes the hierarchy
      // if that read times out (#1079).
      const selection = options.resolveSelection
        ? await options
            .resolveSelection(run.parentSessionID)
            .catch((): undefined => undefined)
        : undefined;
      if (
        disposed ||
        runs.get(run.taskID) !== run ||
        notification.sent ||
        run.notification !== notification
      ) {
        return;
      }
      // Revalidate AFTER the selection await: a late success from a
      // previous attempt may have marked this notification sent while the
      // retry was pending here — sending again would duplicate the
      // terminal result.
      const latestBeforeSend = options.backgroundJobBoard.get(run.taskID);
      if (
        !latestBeforeSend ||
        latestBeforeSend.generation !== run.generation ||
        latestBeforeSend.terminalRevision !== record.terminalRevision ||
        terminalOutcome(latestBeforeSend) !== run.terminalState
      ) {
        return;
      }
      const lease = options.backgroundJobBoard.acquireTerminalNotificationLease(
        run.taskID,
        run.generation,
        record.terminalRevision,
      );
      if (!lease) {
        // Waiting for an older publication's transport does not spend this
        // publication's send budget: no transport attempt has started.
        notification.attempts -= 1;
        scheduleNotificationRetry(run, record);
        return;
      }
      const notifyAgent = selection?.agent ?? 'orchestrator';
      const text = [
        `<task id="${run.taskID}" state="${state}">`,
        `<summary>${summary}</summary>`,
        `<${tag}>`,
        record.resultSummary ??
          (state === 'completed' ? 'Completed.' : 'Failed.'),
        `</${tag}>`,
        '</task>',
      ].join('\n');
      const response = await awaitNotificationTransport(
        options.backgroundJobBoard,
        lease,
        () =>
          (promptAsync as (args: Record<string, unknown>) => Promise<unknown>)({
            path: { id: run.parentSessionID },
            query: { directory: options.input.directory },
            // v1 prompt_async queues; 'queue' preserves that on v2 hosts
            // ('steer' — the shim default — would hijack an in-flight
            // parent run, the same TOCTOU #1192 closed for task-revive).
            // Extra root fields are dropped by the v1 SDK RequestInit
            // path (same pattern as task-revive #1192).
            delivery: 'queue',
            // Lifecycle continuation (#1079): on v2 the shim inherits the
            // host's persisted selection instead of re-pinning the resolved
            // snapshot model. On v1 the flag is dropped by the SDK and the
            // explicit body model applies.
            modelSelection: 'inherit',
            ...(selection?.variant ? { modelVariant: selection.variant } : {}),
            body: {
              agent: notifyAgent,
              ...(selection?.model ? { model: selection.model } : {}),
              // Internal-initiator part (synthetic flag + metadata + marker):
              // the v2 client-shim routes these through session.synthetic so
              // the notification stays machine-context instead of a visible
              // user message, and the session-prompt bridge classifies the
              // admission as internal (not external user activity). A bare
              // `synthetic: true` part loses its flag in the flat v2 prompt
              // translation (#1157).
              parts: [createInternalAgentTextPart(text)],
            },
          }),
        // Late settlement after the local timeout: a SUCCESS means the
        // host DID accept the notification — mark it delivered and cancel
        // the pending retry so the same terminal result is never sent to
        // the parent twice. A late FAILURE keeps the retry scheduled.
        (outcome) => {
          if (!outcome.ok) return;
          if (disposed || runs.get(run.taskID) !== run) return;
          const current = options.backgroundJobBoard.get(run.taskID);
          if (
            run.notification !== notification ||
            current?.generation !== record.generation ||
            current.terminalRevision !== record.terminalRevision
          )
            return;
          run.notification.sent = true;
          if (run.notification.retryTimer) {
            clearTimeout(run.notification.retryTimer);
            run.notification.retryTimer = undefined;
          }
        },
      );
      const error = responseError(response);
      if (error !== undefined) throw new Error(stringifyError(error));
      const latest = options.backgroundJobBoard.get(run.taskID);
      if (
        !latest ||
        latest.generation !== run.generation ||
        latest.terminalRevision !== record.terminalRevision ||
        terminalOutcome(latest) !== run.terminalState
      ) {
        return;
      }
      run.notification.sent = true;
    } catch {
      scheduleNotificationRetry(run, record);
    } finally {
      notification.pending = false;
    }
  }

  function scheduleNotificationRetry(
    run: RevivedRun,
    record: BackgroundJobRecord,
  ): void {
    if (
      disposed ||
      runs.get(run.taskID) !== run ||
      run.terminalRevision !== record.terminalRevision ||
      run.notification.attempts >= maxNotificationRetries ||
      run.notification.retryTimer
    ) {
      return;
    }
    run.notification.retryTimer = setTimeout(() => {
      run.notification.retryTimer = undefined;
      void notifyParent(run, record);
    }, retryDelayMs);
    run.notification.retryTimer.unref?.();
  }

  function register(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void {
    // External registration (e.g. task_revive) supersedes any pending
    // fallback handoff for this task: it replaces the prepared owner
    // with its own observation identity.
    deleteHandoff(input.taskID);
    installRun(input);
  }

  function discardRun(run: RevivedRun): void {
    if (runs.get(run.taskID) !== run) return;
    if (run.notification.retryTimer) clearTimeout(run.notification.retryTimer);
    runs.delete(run.taskID);
  }

  const baselineFor = (
    taskID: string,
    generation: number,
  ): string | undefined => {
    const run = runs.get(taskID);
    if (run?.generation !== generation) return undefined;
    return run.baselineMessageID;
  };

  // --- Fallback observation handoff -----------------------------------
  // A prepared handoff fences the stop gate from publishing a terminal
  // state while a fallback's admission await is still pending: the job
  // may ALREADY hold the re-prompted result, but no delivery owner
  // exists yet — publishing then would strand the result again (the
  // exact false-stop-incident shape).
  //
  // Preparing SUPPLANTS the previous publisher (an in-flight probe of
  // the substituted observation fences out on its identity check
  // instead of publishing), and an UNRESOLVED outcome (expiry / unknown
  // transport failure) CONVERTS the preparation into a tracked run —
  // the prepared owner — so a late admission finds delivery already
  // owned. The preparation is never dropped while the admission
  // outcome is unknown.
  const pendingHandoffs = new Map<
    string,
    {
      generation: number;
      parentSessionID: string;
      baselineMessageID?: string;
      description: string;
      state: 'pending' | 'promoted';
      expiryTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  const handoffExpiryMs = options.handoffExpiryMs ?? DEFAULT_HANDOFF_EXPIRY_MS;

  function deleteHandoff(taskID: string): void {
    const pending = pendingHandoffs.get(taskID);
    if (!pending) return;
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    pendingHandoffs.delete(taskID);
  }

  function isObservationPending(taskID: string, generation: number): boolean {
    // BOTH states fence the gate: 'pending' = admission await in
    // flight; 'promoted' = the owner was installed by expiry or an
    // unresolved transport failure, but the ADMISSION itself is still
    // unresolved — the re-prompt may yet start, so an `absent` verdict
    // must not become a terminal stop meanwhile. The entry is cleaned
    // on admit/reject, external registration, or the bounded
    // unresolved-admission timer (owner kept).
    const pending = pendingHandoffs.get(taskID);
    return pending?.generation === generation;
  }

  /** Install a run WITHOUT touching handoff bookkeeping (admit/expiry
   * manage their own entries); public register() resolves any pending
   * handoff first — an external registration (revive) supersedes it. */
  function installRun(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): void {
    const old = runs.get(input.taskID);
    if (old?.notification.retryTimer) clearTimeout(old.notification.retryTimer);
    runs.set(input.taskID, {
      ...input,
      revision: ++revisionSequence,
      notification: { attempts: 0, sent: false, pending: false },
    });
    options.onRegister?.(input.taskID);
  }

  /** After promotion the owner is installed but admission is still
   * unknown. Keep fencing the gate for one more expiry window, then
   * probe again and lift the fence WITHOUT discarding the owner — a
   * still-empty transcript can confirm stopped, a late result still
   * has a delivery owner. */
  function armPromotedResolution(taskID: string, generation: number): void {
    const pending = pendingHandoffs.get(taskID);
    if (pending?.state !== 'promoted' || pending.generation !== generation) {
      return;
    }
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    pending.expiryTimer = setTimeout(() => {
      const current = pendingHandoffs.get(taskID);
      if (current?.state !== 'promoted' || current.generation !== generation) {
        return;
      }
      deleteHandoff(taskID);
      void probe(taskID, generation);
    }, handoffExpiryMs);
    pending.expiryTimer.unref?.();
  }

  /** Convert a pending preparation into the owning tracked run. Used
   * by expiry (hung admission) and unresolved transport failures: the
   * prepared owner must survive so a late acceptance — or the
   * already-persisted result — is still delivered. */
  function promoteHandoffToOwner(taskID: string): boolean {
    const pending = pendingHandoffs.get(taskID);
    if (pending?.state !== 'pending') return false;
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    pending.state = 'promoted';
    pending.expiryTimer = undefined;
    const record = options.backgroundJobBoard.get(taskID);
    if (
      record?.state !== 'running' ||
      record.generation !== pending.generation ||
      record.background !== true
    ) {
      // The execution was superseded while the admission was unknown:
      // nothing to own.
      deleteHandoff(taskID);
      return false;
    }
    installRun({
      taskID,
      generation: pending.generation,
      parentSessionID: pending.parentSessionID,
      baselineMessageID: pending.baselineMessageID,
      description: pending.description,
    });
    // The re-prompt may already be persisted (admission is async): own
    // it now rather than waiting for an idle that already happened.
    void probe(taskID, pending.generation);
    armPromotedResolution(taskID, pending.generation);
    return true;
  }

  function prepareObservation(input: {
    taskID: string;
    generation: number;
    parentSessionID: string;
    baselineMessageID?: string;
    description: string;
  }): boolean {
    if (disposed) return false;
    const record = options.backgroundJobBoard.get(input.taskID);
    if (
      record?.state !== 'running' ||
      record.generation !== input.generation ||
      record.background !== true
    ) {
      return false;
    }
    // Supplant the previous publisher: the run being substituted is
    // discarded NOW — its in-flight probe fences out on the identity
    // check instead of publishing the substituted attempt's terminal.
    const old = runs.get(input.taskID);
    if (old) discardRun(old);
    deleteHandoff(input.taskID);
    const expiryTimer = setTimeout(() => {
      // Hung admission: the preparation converts into the owning run;
      // responsibility is never dropped on a timer.
      void promoteHandoffToOwner(input.taskID);
    }, handoffExpiryMs);
    expiryTimer.unref?.();
    pendingHandoffs.set(input.taskID, {
      generation: input.generation,
      parentSessionID: input.parentSessionID,
      baselineMessageID: input.baselineMessageID,
      description: input.description,
      state: 'pending',
      expiryTimer,
    });
    return true;
  }

  function admitObservation(taskID: string, generation: number): boolean {
    const pending = pendingHandoffs.get(taskID);
    if (!pending || pending.generation !== generation) return false;
    if (pending.state === 'promoted') {
      // Late acceptance of an already-promoted owner: the admission is
      // NOW resolved — clean the preparation and run the probe WITHOUT
      // reinstalling the run or resetting sent/pending (the installed
      // owner keeps its identity and notification state). The probe is
      // the missing trigger when the result was persisted while the
      // admission ack was in flight and no idle event will fire again.
      deleteHandoff(taskID);
      void probe(taskID, generation);
      return true;
    }
    deleteHandoff(taskID);
    const record = options.backgroundJobBoard.get(taskID);
    if (
      record?.state !== 'running' ||
      record.generation !== generation ||
      record.background !== true
    ) {
      return false;
    }
    installRun({
      taskID,
      generation,
      parentSessionID: pending.parentSessionID,
      baselineMessageID: pending.baselineMessageID,
      description: pending.description,
    });
    // Immediate probe: the re-prompt admission is async — if the
    // substituted run already went idle (fast answer + delayed
    // admission accounting), no idle event will fire again.
    void probe(taskID, generation);
    return true;
  }

  /** Explicit host refusal (error envelope, capability rejection): no
   * work was admitted, so nothing is owned. Unknown transport failures
   * must use settleObservationUnresolved instead. */
  function rejectObservation(taskID: string, generation: number): void {
    const pending = pendingHandoffs.get(taskID);
    if (!pending || pending.generation !== generation) return;
    deleteHandoff(taskID);
    if (pending.state === 'promoted') {
      const run = runs.get(taskID);
      if (run?.generation === generation) discardRun(run);
    }
  }

  /** Unknown admission outcome (transport failed without a response —
   * the host may still have accepted the replay): the prepared
   * ownership CONVERTS into a tracked run instead of being dropped. */
  function settleObservationUnresolved(
    taskID: string,
    generation: number,
  ): boolean {
    const pending = pendingHandoffs.get(taskID);
    if (!pending || pending.generation !== generation) return false;
    return promoteHandoffToOwner(taskID);
  }

  return {
    captureBaseline,
    register,
    isTracked,
    baselineFor,
    probe,
    onTerminal,
    prepareObservation,
    admitObservation,
    rejectObservation,
    settleObservationUnresolved,
    isObservationPending,
    revisionFor: (taskID, generation) => {
      const run = runs.get(taskID);
      return run?.generation === generation ? run.revision : undefined;
    },
    dispose: () => {
      disposed = true;
      for (const pending of pendingHandoffs.values()) {
        clearTimeout(pending.expiryTimer);
      }
      pendingHandoffs.clear();
      dispose();
    },
  };
}

async function awaitNotificationTransport<T>(
  backgroundJobBoard: BackgroundJobStore,
  lease: BackgroundJobLease,
  operation: () => Promise<T>,
  onLateSettlement?: (outcome: { ok: boolean }) => void,
): Promise<T> {
  let settled = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport = Promise.resolve()
    .then(operation)
    .then(
      (value) => {
        settled = true;
        if (timedOut) {
          backgroundJobBoard.releaseLease(lease);
          // A resolved promise is NOT delivery: the SDK can resolve with
          // an `{ error }` envelope when throwOnError is off. Classify
          // with the same check the normal path uses.
          onLateSettlement?.({
            ok: responseError(value) === undefined,
          });
        }
        return value;
      },
      (error: unknown) => {
        settled = true;
        if (timedOut) {
          backgroundJobBoard.releaseLease(lease);
          onLateSettlement?.({ ok: false });
        }
        throw error;
      },
    );

  try {
    return await Promise.race([
      transport,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NotificationTransportTimeoutError()),
          TERMINAL_NOTIFICATION_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof NotificationTransportTimeoutError) {
      timedOut = true;
      if (settled) backgroundJobBoard.releaseLease(lease);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (!timedOut) backgroundJobBoard.releaseLease(lease);
  }
}

class NotificationTransportTimeoutError extends Error {
  constructor() {
    super('Parent terminal notification transport timed out');
    this.name = 'NotificationTransportTimeoutError';
  }
}

function terminalOutcome(
  record: BackgroundJobRecord,
): 'completed' | 'error' | undefined {
  if (record.state === 'reconciled') {
    return record.terminalState === 'completed' ||
      record.terminalState === 'error'
      ? record.terminalState
      : undefined;
  }
  return record.state === 'completed' || record.state === 'error'
    ? record.state
    : undefined;
}
