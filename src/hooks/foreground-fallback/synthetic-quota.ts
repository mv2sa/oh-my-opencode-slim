import type { BackgroundJobStore } from '../../utils/background-job-store';
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { parseModelReference } from '../../utils/session';
import type { RevivedRunTracker } from '../task-session-manager/revived-run-tracker';
import type { ForegroundFallbackManager } from './index';

/**
 * Exact Antigravity quota-exhaustion templates from @cortexkit/opencode-antigravity-auth 2.1.0.
 *
 * Matching semantics: Trim-normalized. Leading and trailing whitespace is trimmed,
 * while the entire payload body is strictly anchored (^...$) against the exact templates.
 * Quotes, prefixes, suffixes, and generic/unanchored quota prose are rejected.
 */
export const ANTIGRAVITY_TEMPLATE_1 =
  /^All \d+ account\(s\) rate-limited for .+?\. Quota resets in .+?\. Add more accounts with `opencode auth login` or wait and retry\.$/;

export const ANTIGRAVITY_TEMPLATE_2 =
  /^Quota protection: All \d+ account\(s\) are over \d+(?:\.\d+)?% usage for .+?\. Quota resets in .+?\. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable\.$/;

export const DEFAULT_CONTINUATION_CALLER_WAIT_MS = 2_000;
export const DEFAULT_CONTINUATION_TRANSPORT_TIMEOUT_MS = 10_000;

export class ContinuationTransportTimeoutError extends Error {
  constructor() {
    super('Continuation prompt transport timed out');
    this.name = 'ContinuationTransportTimeoutError';
  }
}

export interface AntigravityMessageEvidence {
  role?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  model?: unknown;
  finish?: unknown;
  finishReason?: unknown;
  error?: unknown;
  tokens?: { input?: unknown; prompt?: unknown } | unknown;
  inputTokens?: unknown;
}

export function isAntigravitySyntheticQuotaText(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return (
    ANTIGRAVITY_TEMPLATE_1.test(trimmed) || ANTIGRAVITY_TEMPLATE_2.test(trimmed)
  );
}

export function isAntigravitySyntheticQuotaMessage(
  evidence: AntigravityMessageEvidence | undefined | null,
  text: string,
): boolean {
  if (!evidence || typeof evidence !== 'object') return false;

  // 1. Positive role gate: must be assistant
  if (evidence.role !== 'assistant') return false;

  // 2. Positive error gate: must have no assistant error
  if (evidence.error !== undefined && evidence.error !== null) return false;

  // 3. Positive finish gate: must be stop (case-normalized)
  const finish = evidence.finish ?? evidence.finishReason;
  if (typeof finish !== 'string' || finish.trim().toLowerCase() !== 'stop') {
    return false;
  }

  // 4. Positive tokens gate: input tokens must be strictly 0
  let inputTokens: unknown = evidence.inputTokens;
  if (
    inputTokens === undefined &&
    typeof evidence.tokens === 'object' &&
    evidence.tokens !== null
  ) {
    const tokens = evidence.tokens as Record<string, unknown>;
    inputTokens = tokens.input ?? tokens.prompt;
  }
  if (
    typeof inputTokens !== 'number' ||
    !Number.isFinite(inputTokens) ||
    inputTokens !== 0
  ) {
    return false;
  }

  // 5. Positive model gate: provider must be google, modelID must start with antigravity-
  let providerID =
    typeof evidence.providerID === 'string' ? evidence.providerID : undefined;
  let modelID =
    typeof evidence.modelID === 'string' ? evidence.modelID : undefined;
  if (!providerID && !modelID && typeof evidence.model === 'string') {
    const parsed = parseModelReference(evidence.model);
    if (parsed) {
      providerID = parsed.providerID;
      modelID = parsed.modelID;
    }
  } else if (
    !providerID &&
    !modelID &&
    typeof evidence.model === 'object' &&
    evidence.model !== null
  ) {
    const m = evidence.model as Record<string, unknown>;
    providerID = typeof m.providerID === 'string' ? m.providerID : undefined;
    modelID = typeof m.modelID === 'string' ? m.modelID : undefined;
  }
  if (
    providerID !== 'google' ||
    !modelID ||
    !modelID.startsWith('antigravity-')
  ) {
    return false;
  }

  // 6. Positive text gate: exact template match (trim-normalized)
  return isAntigravitySyntheticQuotaText(text);
}

export async function verifyChildAntigravityEvidence(
  client: unknown,
  taskID: string,
  text: string,
  directory?: string,
): Promise<
  { model: string; agent?: string; failedMessageID: string } | undefined
> {
  if (!client || typeof client !== 'object') return undefined;
  const sessionClient = (client as Record<string, unknown>).session;
  if (
    !sessionClient ||
    typeof sessionClient !== 'object' ||
    typeof (sessionClient as Record<string, unknown>).messages !== 'function'
  ) {
    return undefined;
  }
  try {
    const response = await (
      sessionClient as {
        messages: (args: unknown) => Promise<unknown>;
      }
    ).messages({
      path: { id: taskID },
      ...(directory ? { query: { directory } } : {}),
    });
    const data =
      response &&
      typeof response === 'object' &&
      Array.isArray((response as { data?: unknown }).data)
        ? (response as { data: unknown[] }).data
        : [];
    if (data.length === 0) return undefined;
    const last = data.at(-1);
    if (!last || typeof last !== 'object') return undefined;
    const info = (last as { info?: Record<string, unknown> }).info;
    if (!info || typeof info !== 'object') return undefined;
    const failedMessageID =
      typeof info.id === 'string' && info.id.trim() !== ''
        ? info.id.trim()
        : undefined;
    if (!failedMessageID) return undefined;

    const modelObj =
      info.model && typeof info.model === 'object'
        ? (info.model as Record<string, unknown>)
        : undefined;
    const providerID =
      typeof info.providerID === 'string'
        ? info.providerID
        : typeof modelObj?.providerID === 'string'
          ? modelObj.providerID
          : undefined;
    const modelID =
      typeof info.modelID === 'string'
        ? info.modelID
        : typeof modelObj?.modelID === 'string'
          ? modelObj.modelID
          : undefined;
    const evidence: AntigravityMessageEvidence = {
      role: info.role,
      providerID,
      modelID,
      finish: info.finish ?? info.finishReason,
      error: info.error,
      tokens: info.tokens,
    };
    if (isAntigravitySyntheticQuotaMessage(evidence, text)) {
      return {
        model: `${providerID}/${modelID}`,
        agent: typeof info.agent === 'string' ? info.agent : undefined,
        failedMessageID,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function responseError(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const res = response as { error?: unknown };
  return res.error === undefined || res.error === null ? undefined : res.error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function launchContinuationPrompt(options: {
  client: unknown;
  directory?: string;
  taskID: string;
  agent?: string;
  model?: string;
  variant?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!options.client || typeof options.client !== 'object') {
    throw new Error('client unavailable');
  }
  const sessionClient = (options.client as Record<string, unknown>).session;
  if (
    !sessionClient ||
    typeof sessionClient !== 'object' ||
    typeof (sessionClient as Record<string, unknown>).promptAsync !== 'function'
  ) {
    throw new Error('session.promptAsync unavailable');
  }
  const ref = options.model ? parseModelReference(options.model) : undefined;
  const promptBody = {
    path: { id: options.taskID },
    ...(options.directory ? { query: { directory: options.directory } } : {}),
    body: {
      parts: [
        createInternalAgentTextPart(
          "<system-reminder>\nThe previous model request failed and is being retried with a fallback model. Continue processing the user's original request above. Do not respond to this reminder.\n</system-reminder>",
        ),
      ],
      ...(ref ? { model: ref } : {}),
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
    },
  };

  const dispatchPromise = (async (): Promise<void> => {
    const response = await (
      sessionClient as {
        promptAsync: (args: unknown) => Promise<unknown>;
      }
    ).promptAsync(promptBody);
    const err = responseError(response);
    if (err !== undefined) {
      throw new Error(errorText(err));
    }
  })();

  const timeoutMs =
    options.timeoutMs ?? DEFAULT_CONTINUATION_TRANSPORT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ContinuationTransportTimeoutError());
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([dispatchPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type SyntheticQuotaIncidentStatus =
  | 'launching'
  | 'launched'
  | 'already_active'
  | 'exhausted'
  | 'transport_failed'
  | 'quarantined'
  | 'aborted';

export function isSyntheticQuotaContinuationActiveStatus(
  status: SyntheticQuotaIncidentStatus | string | undefined,
): boolean {
  return (
    status === 'launched' ||
    status === 'already_active' ||
    status === 'quarantined'
  );
}

export interface SyntheticQuotaCoordinatorOptions {
  callerWaitTimeoutMs?: number;
  hardTransportTimeoutMs?: number;
}

export interface SyntheticQuotaCoordinator {
  isIncidentActive(
    taskID: string,
    generation: number,
    messageID: string,
  ): boolean;
  clearSession(taskID: string): void;
  dispose(): void;
  handleTaskQuotaIncident(input: {
    taskID: string;
    text: string;
    failedMessageID?: string;
    verifiedEvidence?: {
      model: string;
      agent?: string;
      failedMessageID: string;
    };
    client: unknown;
    directory: string;
    backgroundJobBoard: BackgroundJobStore;
    fallbackManager?: ForegroundFallbackManager;
    revivedRunTracker?: RevivedRunTracker;
    pendingParentSessionId?: string;
    pendingLabel?: string;
    pendingAgent?: string;
    callerWaitTimeoutMs?: number;
    hardTransportTimeoutMs?: number;
  }): Promise<{
    handled: boolean;
    status: SyntheticQuotaIncidentStatus;
    nextModel?: string;
    variant?: string;
    failedMessageID?: string;
  }>;
}

interface IncidentReservation {
  token: symbol;
  status: SyntheticQuotaIncidentStatus;
  model: string;
  quarantineTimer?: ReturnType<typeof setTimeout>;
  activeLease?: {
    board: BackgroundJobStore;
    lease: NonNullable<ReturnType<BackgroundJobStore['acquireMessageLease']>>;
  };
}

export function createSyntheticQuotaCoordinator(
  options?: SyntheticQuotaCoordinatorOptions,
): SyntheticQuotaCoordinator {
  const defaultCallerWaitTimeoutMs =
    options?.callerWaitTimeoutMs ?? DEFAULT_CONTINUATION_CALLER_WAIT_MS;
  const defaultHardTransportTimeoutMs =
    options?.hardTransportTimeoutMs ??
    DEFAULT_CONTINUATION_TRANSPORT_TIMEOUT_MS;

  // taskID:generation:failedMessageID -> reservation state
  const incidentReservations = new Map<string, IncidentReservation>();
  let disposed = false;

  const clearReservationTimer = (reservation: IncidentReservation): void => {
    if (!reservation.quarantineTimer) return;
    clearTimeout(reservation.quarantineTimer);
    reservation.quarantineTimer = undefined;
  };

  const releaseReservationLease = (reservation: IncidentReservation): void => {
    const active = reservation.activeLease;
    if (!active) return;
    reservation.activeLease = undefined;
    active.board.releaseLease(active.lease);
  };

  const incidentKey = (
    taskID: string,
    generation: number,
    messageID: string,
  ): string => `${taskID}\u001f${generation}\u001f${messageID}`;

  const isIncidentActive = (
    taskID: string,
    generation: number,
    messageID: string,
  ): boolean => {
    const entry = incidentReservations.get(
      incidentKey(taskID, generation, messageID),
    );
    return entry !== undefined;
  };

  const clearSession = (taskID: string): void => {
    const prefix = `${taskID}\u001f`;
    for (const [key, reservation] of Array.from(
      incidentReservations.entries(),
    )) {
      if (key.startsWith(prefix)) {
        clearReservationTimer(reservation);
        releaseReservationLease(reservation);
        incidentReservations.delete(key);
      }
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const reservation of incidentReservations.values()) {
      clearReservationTimer(reservation);
      releaseReservationLease(reservation);
    }
    incidentReservations.clear();
  };

  const handleTaskQuotaIncident: SyntheticQuotaCoordinator['handleTaskQuotaIncident'] =
    async (input) => {
      if (disposed) return { handled: false, status: 'aborted' };
      if (!isAntigravitySyntheticQuotaText(input.text)) {
        return { handled: false, status: 'aborted' };
      }

      // 1. Evidence lookup (Point 2)
      const evidence =
        input.verifiedEvidence ??
        (await verifyChildAntigravityEvidence(
          input.client,
          input.taskID,
          input.text,
          input.directory,
        ));
      if (
        !evidence ||
        (input.failedMessageID !== undefined &&
          input.failedMessageID !== evidence.failedMessageID)
      ) {
        return { handled: false, status: 'aborted' };
      }
      const failedModel = evidence.model;
      const failedMessageID = evidence.failedMessageID;
      const evidenceAgent = evidence.agent ?? input.pendingAgent;

      // 2. State & Generation verification (Point 4)
      const job = input.backgroundJobBoard.get(input.taskID);
      if (!job) {
        return { handled: false, status: 'aborted' };
      }
      const generation = job.generation;

      const key = incidentKey(input.taskID, generation, failedMessageID);
      const existing = incidentReservations.get(key);
      if (existing) {
        const status =
          existing.status === 'launching' || existing.status === 'launched'
            ? 'already_active'
            : existing.status;
        return {
          handled: true,
          status,
          nextModel: existing.model,
          failedMessageID,
        };
      }
      if (
        job.state !== 'running' ||
        job.cancellationRequested ||
        job.deadlineExceededAt !== undefined
      ) {
        return { handled: false, status: 'aborted' };
      }

      // Reserve incident with unique token
      const reservationToken = Symbol();
      const reservation: IncidentReservation = {
        token: reservationToken,
        status: 'launching',
        model: failedModel ?? '',
      };
      incidentReservations.set(key, reservation);

      const ownsReservation = (): boolean => {
        if (disposed) return false;
        const current = incidentReservations.get(key);
        return current !== undefined && current.token === reservationToken;
      };

      // 3. Acquire continuation lease mutually exclusive with cancellation/relaunch/message (Point 4)
      const lease = input.backgroundJobBoard.acquireMessageLease(
        input.taskID,
        generation,
      );
      if (!lease) {
        // Job is cancelled or already leased by another lifecycle operation -> do not prompt!
        if (ownsReservation()) incidentReservations.delete(key);
        return { handled: false, status: 'aborted' };
      }
      reservation.activeLease = {
        board: input.backgroundJobBoard,
        lease,
      };

      // 4. Mark cooldown and resolve next model (Points 3, 4, 5)
      input.fallbackManager?.markModelCooldown(failedModel, input.text);
      const agent = job?.agent ?? evidenceAgent ?? input.pendingAgent;
      const next = input.fallbackManager?.prepareNextModel({
        sessionID: input.taskID,
        agentName: agent,
        currentModel: failedModel,
      });

      if (!next) {
        // Chain exhausted -> release lease and update status
        releaseReservationLease(reservation);
        reservation.status = 'exhausted';
        reservation.model = failedModel;
        input.backgroundJobBoard.updateStatus({
          taskID: input.taskID,
          expectedGeneration: generation,
          state: 'error',
          resultSummary:
            input.text || 'Quota exhausted; fallback chain exhausted.',
        });
        return { handled: true, status: 'exhausted', failedMessageID };
      }

      // 5. Dispatch exactly one continuation prompt transport (Points 1, 3)
      const sessionClient = (input.client as Record<string, unknown>)?.session;
      if (
        !sessionClient ||
        typeof (sessionClient as Record<string, unknown>).promptAsync !==
          'function'
      ) {
        releaseReservationLease(reservation);
        if (ownsReservation()) incidentReservations.delete(key);
        return { handled: false, status: 'aborted' };
      }

      const ref = next.model ? parseModelReference(next.model) : undefined;
      const promptBody = {
        path: { id: input.taskID },
        ...(input.directory ? { query: { directory: input.directory } } : {}),
        body: {
          parts: [
            createInternalAgentTextPart(
              "<system-reminder>\nThe previous model request failed and is being retried with a fallback model. Continue processing the user's original request above. Do not respond to this reminder.\n</system-reminder>",
            ),
          ],
          ...(ref ? { model: ref } : {}),
          ...(next.variant ? { variant: next.variant } : {}),
          ...(agent ? { agent } : {}),
        },
      };

      const dispatchPromise = (async (): Promise<void> => {
        const response = await (
          sessionClient as { promptAsync: (args: unknown) => Promise<unknown> }
        ).promptAsync(promptBody);
        const err = responseError(response);
        if (err !== undefined) {
          throw new Error(errorText(err));
        }
      })();

      // 6. Hard transport quarantine deadline (Points 2, 3)
      const hardTransportTimeoutMs =
        input.hardTransportTimeoutMs ?? defaultHardTransportTimeoutMs;

      let quarantined = false;

      const onQuarantine = (): void => {
        if (!ownsReservation()) return;
        clearReservationTimer(reservation);

        quarantined = true;

        // Release message lease exactly once
        releaseReservationLease(reservation);

        // Deduplication disposition for that exact incident
        reservation.status = 'quarantined';
        reservation.model = next.model;

        // Mark still-current running board generation status uncertain
        const current = input.backgroundJobBoard.get(input.taskID);
        const isValid =
          current &&
          current.generation === generation &&
          current.state === 'running' &&
          !current.cancellationRequested &&
          current.deadlineExceededAt === undefined;

        if (isValid) {
          input.backgroundJobBoard.markStatusUncertain(
            input.taskID,
            'Continuation transport quarantine deadline exceeded',
            generation,
          );
        }
      };

      reservation.quarantineTimer = setTimeout(
        onQuarantine,
        hardTransportTimeoutMs,
      );
      reservation.quarantineTimer.unref?.();

      // 7. Background settlement tracker for late resolution/invalidation (Points 4, 5, 6)
      const backgroundSettlement = (async (): Promise<void> => {
        try {
          await dispatchPromise;

          if (!ownsReservation()) {
            // Ownership lost (cleared, disposed, or superseded).
            // Do not mutate maps, board, or abort.
            return;
          }
          clearReservationTimer(reservation);

          if (quarantined) {
            // Late resolution accepted after quarantine:
            // Ignored locally: no model commit, tracker registration, or newer-generation mutation.
            // Host abort is not invoked because it cannot safely target only the abandoned request.
            return;
          }

          // Validate lease and current lifecycle at resolution time
          const current = input.backgroundJobBoard.get(input.taskID);
          const isValid =
            input.backgroundJobBoard.validateLease(lease) &&
            current &&
            current.generation === generation &&
            current.state === 'running' &&
            !current.cancellationRequested &&
            current.deadlineExceededAt === undefined;

          if (isValid && next.commit()) {
            releaseReservationLease(reservation);
            reservation.status = 'launched';
            reservation.model = next.model;
            input.revivedRunTracker?.register({
              taskID: input.taskID,
              generation,
              parentSessionID:
                job.parentSessionID ?? input.pendingParentSessionId ?? '',
              description:
                job.description ?? input.pendingLabel ?? input.taskID,
              baselineMessageID: failedMessageID,
            });
          } else {
            // Invalidation occurred while transport was running:
            // Disposal, cancellation, deletion, or lease invalidated.
            releaseReservationLease(reservation);
            reservation.status = 'aborted';
            reservation.model = next.model;
            const latest = input.backgroundJobBoard.get(input.taskID);
            if (
              latest?.generation === generation &&
              latest.state === 'running' &&
              !latest.cancellationRequested &&
              latest.deadlineExceededAt === undefined
            ) {
              input.backgroundJobBoard.updateStatus({
                taskID: input.taskID,
                expectedGeneration: generation,
                state: 'error',
                resultSummary:
                  'Continuation was accepted but its lifecycle commit was invalidated.',
              });
            }
          }
        } catch (err) {
          if (!ownsReservation()) {
            // Ownership lost. Do not mutate maps or board.
            return;
          }
          clearReservationTimer(reservation);

          if (quarantined) {
            // Late rejection after quarantine must not overwrite quarantine disposition
            // or terminalize the still-running uncertain job.
            return;
          }

          releaseReservationLease(reservation);
          reservation.status = 'transport_failed';
          reservation.model = next.model;

          const current = input.backgroundJobBoard.get(input.taskID);
          const isValid =
            current &&
            current.generation === generation &&
            current.state === 'running' &&
            !current.cancellationRequested &&
            current.deadlineExceededAt === undefined;

          if (isValid) {
            input.backgroundJobBoard.updateStatus({
              taskID: input.taskID,
              expectedGeneration: generation,
              state: 'error',
              resultSummary: `Continuation launch failed: ${errorText(err)}`,
            });
          }
        }
      })();

      // 8. Bounded caller wait (Points 1, 2, 3)
      const callerWaitTimeoutMs =
        input.callerWaitTimeoutMs ?? defaultCallerWaitTimeoutMs;

      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waitPromise = new Promise<'timeout'>((resolve) => {
        waitTimer = setTimeout(() => resolve('timeout'), callerWaitTimeoutMs);
        waitTimer.unref?.();
      });

      const callerRace = await Promise.race([
        dispatchPromise.then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
        waitPromise,
      ]);
      if (waitTimer) clearTimeout(waitTimer);

      if (callerRace === 'settled') {
        await backgroundSettlement;
        const finalRes = incidentReservations.get(key);
        const finalStatus =
          finalRes?.token === reservationToken ? finalRes.status : 'aborted';
        return {
          handled: true,
          status: finalStatus,
          ...(finalStatus === 'launched'
            ? { nextModel: next.model, variant: next.variant }
            : {}),
          failedMessageID,
        };
      }

      // Caller wait timed out: delivery is uncertain, not rejected.
      // Incident reservation ('launching') and message lease remain held until transport settles or quarantines.
      // Return status 'launched' so caller rewrites to running placeholder without blocking.
      return {
        handled: true,
        status: 'launched',
        nextModel: next.model,
        variant: next.variant,
        failedMessageID,
      };
    };

  return {
    isIncidentActive,
    clearSession,
    dispose,
    handleTaskQuotaIncident,
  };
}
