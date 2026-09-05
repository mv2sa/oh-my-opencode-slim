/**
 * Periodic orchestrator wake scheduler.
 *
 * After continuous parent-idle time, capability-gated host session APIs may
 * receive a static internal wake prompt when incomplete todos remain. Active
 * children suppress periodic wakes. Host responses are authoritative; the local
 * job board is never consulted. Progress/reservation state is process-global
 * so independently created hook instances share one-flight and the two-wake
 * no-progress cap.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { OutcomeController } from '../../outcome/controller';
import { canonicalDigest } from '../../outcome/controller-schema';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../task-session-manager/continuation-model-selection';
import { isActiveStatus } from '../task-session-manager/status-utils';
import { isMessageWithParts } from '../types';
import {
  canAttemptRestartRecovery,
  clearExpectingWakeBusy,
  clearWakeSession,
  commitRestartRecoverySuccess,
  commitWakeReservation,
  getObservedWakeModel,
  getRestartRecoveryState,
  getWakeProgress,
  isExpectingWakeBusy,
  noteHostProgress,
  rearmWakeProgress,
  recordRestartRecoveryFailure,
  releaseRestartRecovery,
  releaseWakeEvaluation,
  retryAfterWakeEvaluation,
  setObservedWakeModel,
  tryBeginRestartRecovery,
  tryBeginWakeEvaluation,
} from './wake-gate';

export const ORCHESTRATOR_WAKE_TEXT =
  '<system-reminder>\nFinish any incomplete TODOs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

export const ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT =
  '<system-reminder>\nA background job stopped without a terminal result. Consult the Background Job Board, recover or reroute the work as needed, and do not wait for that job as if it were still running. Do not respond to this reminder.\n</system-reminder>';

export const ORCHESTRATOR_RESTART_RECOVERY_TEXT =
  '<system-reminder>\nThe previous OpenCode process was restarted while a foreground tool was running. That operation was interrupted and must not be blindly re-executed. Inspect authoritative local and background state (via outcome_control, task_status, or git/filesystem checks) to determine whether the operation completed or needs targeted recovery before proceeding. Do not respond to this reminder.\n</system-reminder>';

/** After this many successful wakes with an unchanged fingerprint, stop. */
export const ORCHESTRATOR_WAKE_UNCHANGED_CAP = 2;

const SUPPORTED_TODO_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

type SessionClient = OpencodeClient['session'];

type LocalSessionState = {
  /** Invalidates local timers/async work for this hook instance. */
  generation: symbol;
  timer: ReturnType<typeof setTimeout> | undefined;
  continuousIdle: boolean;
};

export type OrchestratorWakeConfig = {
  enabled: boolean;
  intervalMs: number;
};

export type OrchestratorWakeOptions = {
  config: OrchestratorWakeConfig;
  shouldManageSession: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  isFallbackInProgress?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
  /** Test seam: override interval without changing config validation. */
  intervalMs?: number;
  outcomeController?: OutcomeController;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
  startupSettleDelayMs?: number;
  restartSnapshotSettleDelayMs?: number;
  maxBootstrapRoots?: number;
  bootstrapConcurrency?: number;
};

function hasRequiredSessionApis(
  session: SessionClient | undefined,
): session is SessionClient & {
  get: NonNullable<SessionClient['get']>;
  todo: NonNullable<SessionClient['todo']>;
  children: NonNullable<SessionClient['children']>;
  status: NonNullable<SessionClient['status']>;
  promptAsync: NonNullable<SessionClient['promptAsync']>;
  messages?: NonNullable<SessionClient['messages']>;
  list?: NonNullable<SessionClient['list']>;
} {
  return (
    typeof session?.get === 'function' &&
    typeof session.todo === 'function' &&
    typeof session.children === 'function' &&
    typeof session.status === 'function' &&
    typeof session.promptAsync === 'function'
  );
}

function isInteractiveOrPermissionTool(toolName: string): boolean {
  return (
    toolName === 'question' ||
    toolName === 'wait_for_user' ||
    toolName.startsWith('permission.') ||
    toolName.startsWith('question.')
  );
}

function isIncompleteTodoStatus(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

function todosHaveValidStatuses(
  todos: Array<Record<string, unknown>>,
): boolean {
  return todos.every(
    (todo) =>
      typeof todo.status === 'string' &&
      SUPPORTED_TODO_STATUSES.has(todo.status),
  );
}

function hasIncompleteTodos(todos: Array<Record<string, unknown>>): boolean {
  return todos.some(
    (todo) =>
      typeof todo.status === 'string' && isIncompleteTodoStatus(todo.status),
  );
}

function hasActiveChild(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): boolean {
  return children.some(
    (child) => typeof child.id === 'string' && isActiveStatus(status, child.id),
  );
}

function todoFingerprint(todos: Array<Record<string, unknown>>): string {
  return todos
    .map((todo) => {
      const id =
        typeof todo.id === 'string'
          ? todo.id
          : typeof todo.content === 'string'
            ? todo.content
            : '';
      return `${id}:${String(todo.status)}`;
    })
    .sort()
    .join('\n');
}

function childUpdateEvidence(child: Record<string, unknown>): string {
  const time = isObjectRecord(child.time) ? child.time : undefined;
  const candidates = [
    time?.updated,
    time?.completed,
    child.updatedAt,
    child.updated,
    time?.created,
    child.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' || typeof value === 'string') {
      return String(value);
    }
  }
  return '';
}

function childStatusEvidence(
  childID: string,
  status: Record<string, unknown>,
): string {
  if (!Object.hasOwn(status, childID)) return 'absent';
  const entry = status[childID];
  if (!isObjectRecord(entry)) return 'malformed';
  return typeof entry.type === 'string' ? entry.type : 'active';
}

function childrenFingerprint(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return children
    .map((child) => {
      const id = String(child.id);
      return `${id}:${childStatusEvidence(id, status)}:${childUpdateEvidence(child)}`;
    })
    .sort()
    .join('\n');
}

export function buildOrchestratorWakeFingerprint(
  todos: Array<Record<string, unknown>>,
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return `${todoFingerprint(todos)}\n--\n${childrenFingerprint(children, status)}`;
}

function extractSessionID(event: {
  properties?: { info?: { id?: string }; sessionID?: string };
}): string | undefined {
  return event.properties?.info?.id || event.properties?.sessionID;
}

function isIdleEvent(
  type: string,
  properties?: { status?: { type?: string } },
) {
  return (
    type === 'session.idle' ||
    (type === 'session.status' && properties?.status?.type === 'idle')
  );
}

function isBusyEvent(
  type: string,
  properties?: { status?: { type?: string } },
): boolean {
  return type === 'session.status' && properties?.status?.type === 'busy';
}

function isInputWaitAskEvent(type: string): boolean {
  return type === 'permission.asked' || type === 'question.asked';
}

function isBootstrapActiveStatus(
  status: Record<string, unknown>,
  sessionID: string,
): boolean {
  if (!Object.hasOwn(status, sessionID)) return false;
  const entry = status[sessionID];
  if (!isObjectRecord(entry) || typeof entry.type !== 'string') return true;
  return entry.type !== 'idle';
}

export function createOrchestratorWakeScheduler(
  ctx: PluginInput,
  options: OrchestratorWakeOptions,
) {
  const intervalMs = options.intervalMs ?? options.config.intervalMs;
  const enabled = options.config.enabled === true;
  const directory = ctx.directory;
  const restartSnapshotSettleDelayMs =
    options.restartSnapshotSettleDelayMs ?? 250;
  const sessionSdk = (ctx.client as OpencodeClient).session;

  /** Local timer/generation state only; progress lives in the process gate. */
  const localSessions = new Map<string, LocalSessionState>();
  /** Reservations this hook owns and must release when it is disposed. */
  const localWakeOwners = new Map<string, symbol>();
  const pendingStoppedRecoveries = new Set<string>();
  let disposed = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  async function classifyAndRecoverInterruptedSession(
    sessionID: string,
    _source: 'bootstrap' | 'event',
  ): Promise<boolean> {
    if (disposed || !enabled) return false;
    if (!options.outcomeController) return false;
    if (!hasRequiredSessionApis(sessionSdk)) return false;
    if (typeof sessionSdk.messages !== 'function') return false;

    // Must not have process-local input wait or fallback in progress
    if (options.hasInputWait(sessionID)) return false;
    if (options.isFallbackInProgress?.(sessionID)) return false;

    // Check shared process-global restart recovery gate
    if (!canAttemptRestartRecovery(sessionID)) return false;

    const controller = options.outcomeController;

    getRestartRecoveryState(sessionID);

    // 1. Raw prior-epoch Outcome store read (or an exact already-recovered
    // interrupted operation when a previous classification lost a host race).
    const rawRes = controller.store.read(sessionID);
    if (!rawRes.success) return false; // corrupt or missing records rejected
    const rawRecord = rawRes.data;

    // Reject accepted outcomes
    if (rawRecord.phase === 'accepted') return false;

    // No durable user/external wait
    if (rawRecord.waitCondition !== undefined) return false;

    const eligibleOperations = rawRecord.operations.filter(
      (operation) =>
        operation.serverEpoch !== controller.serverEpoch &&
        (operation.status === 'running' ||
          (operation.status === 'interrupted' &&
            operation.error === 'Operation interrupted by process restart')),
    );
    if (eligibleOperations.length !== 1) return false;
    const priorRunningOp = eligibleOperations[0];
    const requiresRecovery = priorRunningOp.status === 'running';
    if (requiresRecovery && rawRecord.serverEpoch === controller.serverEpoch) {
      return false;
    }

    // 2. Authoritative host snapshot 1
    // Root session check
    let sessionGet:
      | {
          data?: {
            parentID?: string | null;
            directory?: string;
            model?: unknown;
          };
        }
      | undefined;
    try {
      sessionGet = (await sessionSdk.get({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      })) as {
        data?: {
          parentID?: string | null;
          directory?: string;
          model?: unknown;
        };
      };
    } catch {
      return false;
    }
    const sessionData = isObjectRecord(sessionGet?.data)
      ? sessionGet.data
      : undefined;
    if (
      !sessionData ||
      sessionData.parentID ||
      (typeof sessionData.directory === 'string' &&
        sessionData.directory !== directory)
    ) {
      return false;
    }

    // Inactive check in snapshot 1
    let statusRes1: { data?: Record<string, unknown> } | undefined;
    try {
      statusRes1 = (await sessionSdk.status({
        query: { directory },
        throwOnError: true,
      })) as { data?: Record<string, unknown> };
    } catch {
      return false;
    }
    if (
      !isObjectRecord(statusRes1?.data) ||
      isBootstrapActiveStatus(statusRes1.data, sessionID)
    ) {
      return false;
    }

    let childrenRes1: { data?: unknown } | undefined;
    try {
      childrenRes1 = await sessionSdk.children({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      });
    } catch {
      return false;
    }
    if (!Array.isArray(childrenRes1?.data)) return false;
    const children1 = childrenRes1.data as Array<Record<string, unknown>>;
    if (hasActiveChild(children1, statusRes1.data)) return false;
    const childrenFingerprint1 = childrenFingerprint(
      children1,
      statusRes1.data,
    );

    // Incomplete TODOs check
    let todoRes: { data?: unknown } | undefined;
    try {
      todoRes = await sessionSdk.todo({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      });
    } catch {
      return false;
    }
    if (!Array.isArray(todoRes?.data)) return false;
    const todos = todoRes.data as Array<Record<string, unknown>>;
    if (
      !todos.every((t) => isObjectRecord(t) && typeof t.status === 'string') ||
      !todosHaveValidStatuses(todos) ||
      !hasIncompleteTodos(todos)
    ) {
      return false;
    }

    // Messages snapshot 1
    let messagesRes1: { data?: unknown } | undefined;
    try {
      messagesRes1 = await sessionSdk.messages({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      });
    } catch {
      return false;
    }
    if (!Array.isArray(messagesRes1?.data) || messagesRes1.data.length === 0) {
      return false;
    }
    const messages1 = messagesRes1.data;
    const latest1 = messages1[messages1.length - 1];
    if (!isMessageWithParts(latest1)) return false;

    // Must be exactly one incomplete assistant turn with no error
    if (latest1.info.role !== 'assistant') return false;
    const infoRecord = latest1.info as Record<string, unknown>;
    if (
      typeof infoRecord.id !== 'string' ||
      infoRecord.id.length === 0 ||
      infoRecord.sessionID !== sessionID
    ) {
      return false;
    }
    if (infoRecord.error !== undefined) return false;
    const timeRecord = isObjectRecord(infoRecord.time)
      ? infoRecord.time
      : undefined;
    if (timeRecord?.completed !== undefined) return false;
    if (infoRecord.finish !== undefined && infoRecord.finish !== null) {
      return false;
    }

    // Allow earlier terminal tools in the same assistant turn, but require
    // exactly one active tool and require that active tool to be running.
    const toolParts1 = latest1.parts.filter(
      (p) => isObjectRecord(p) && p.type === 'tool',
    ) as Array<Record<string, unknown>>;
    const toolStatuses1 = toolParts1.map((part) => {
      const state = isObjectRecord(part.state) ? part.state : undefined;
      return typeof state?.status === 'string' ? state.status : undefined;
    });
    if (
      toolStatuses1.some(
        (status) =>
          status !== 'pending' &&
          status !== 'running' &&
          status !== 'completed' &&
          status !== 'error',
      )
    ) {
      return false;
    }
    const activeToolParts1 = toolParts1.filter((_, index) =>
      ['pending', 'running'].includes(toolStatuses1[index] ?? ''),
    );
    if (activeToolParts1.length !== 1) return false;
    const toolPart1 = activeToolParts1[0];

    const toolState1 = isObjectRecord(toolPart1.state)
      ? toolPart1.state
      : undefined;
    if (toolState1?.status !== 'running') return false;
    const toolTime1 = isObjectRecord(toolState1.time)
      ? toolState1.time
      : undefined;
    if (typeof toolTime1?.start !== 'number') return false;

    if (typeof toolPart1.id !== 'string' || toolPart1.id.length === 0) {
      return false;
    }

    const toolName1 = typeof toolPart1.tool === 'string' ? toolPart1.tool : '';
    if (!toolName1 || isInteractiveOrPermissionTool(toolName1)) return false;

    const callID1 =
      typeof toolPart1.callID === 'string' ? toolPart1.callID : '';
    if (!callID1) return false;

    if (!isObjectRecord(toolState1.input)) return false;
    const toolInput1 = toolState1.input;
    const argumentDigest1 = canonicalDigest('omos/tool-args/v1', toolInput1);

    if (
      priorRunningOp.callId !== callID1 ||
      priorRunningOp.toolName !== toolName1 ||
      priorRunningOp.argumentDigest !== argumentDigest1
    ) {
      return false;
    }

    // Claim the shared wake slot before durable recovery so an Outcome idle
    // event cannot race this classifier and double-prompt the root.
    const owner = tryBeginRestartRecovery(sessionID);
    if (!owner) return false;

    try {
      // 3. Normal controller.readRecord recovery
      const recoveredRes = requiresRecovery
        ? controller.readRecord(sessionID)
        : rawRes;
      if (!recoveredRes.success) return false;
      const recoveredRecord = recoveredRes.data;

      // Require exact operation interrupted with standard restart error
      const recoveredOp = recoveredRecord.operations.find(
        (operation) => operation.id === priorRunningOp.id,
      );
      if (
        recoveredOp?.status !== 'interrupted' ||
        recoveredOp.error !== 'Operation interrupted by process restart'
      ) {
        return false;
      }

      // Require matching unresolved action
      const matchingAction = recoveredRecord.actionsRequired.find(
        (action) =>
          action.resolvedAt === undefined &&
          action.code === 'interrupted_operation' &&
          action.referenceId === priorRunningOp.id,
      );
      if (!matchingAction) return false;

      // Give the host a bounded window to restore or advance a real live turn.
      if (restartSnapshotSettleDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, restartSnapshotSettleDelayMs);
          timer.unref?.();
        });
        if (disposed) return false;
      }

      // 4. Second authoritative host snapshot: must be identical and inactive
      if (options.hasInputWait(sessionID)) return false;
      if (options.isFallbackInProgress?.(sessionID)) return false;
      const latestDurable = controller.store.read(sessionID);
      if (!latestDurable.success || latestDurable.data.waitCondition) {
        return false;
      }

      let statusRes2: { data?: Record<string, unknown> } | undefined;
      try {
        statusRes2 = (await sessionSdk.status({
          query: { directory },
          throwOnError: true,
        })) as { data?: Record<string, unknown> };
      } catch {
        return false;
      }
      if (
        !isObjectRecord(statusRes2?.data) ||
        isBootstrapActiveStatus(statusRes2.data, sessionID)
      ) {
        return false;
      }

      let childrenRes2: { data?: unknown } | undefined;
      try {
        childrenRes2 = await sessionSdk.children({
          path: { id: sessionID },
          query: { directory },
          throwOnError: true,
        });
      } catch {
        return false;
      }
      if (!Array.isArray(childrenRes2?.data)) return false;
      const children2 = childrenRes2.data as Array<Record<string, unknown>>;
      if (
        hasActiveChild(children2, statusRes2.data) ||
        childrenFingerprint(children2, statusRes2.data) !== childrenFingerprint1
      ) {
        return false;
      }

      let todoRes2: { data?: unknown } | undefined;
      try {
        todoRes2 = await sessionSdk.todo({
          path: { id: sessionID },
          query: { directory },
          throwOnError: true,
        });
      } catch {
        return false;
      }
      if (!Array.isArray(todoRes2?.data)) return false;
      const todos2 = todoRes2.data as Array<Record<string, unknown>>;
      if (
        !todos2.every((todo) =>
          isObjectRecord(todo) ? typeof todo.status === 'string' : false,
        ) ||
        !todosHaveValidStatuses(todos2) ||
        !hasIncompleteTodos(todos2) ||
        todoFingerprint(todos2) !== todoFingerprint(todos)
      ) {
        return false;
      }

      let messagesRes2: { data?: unknown } | undefined;
      try {
        messagesRes2 = await sessionSdk.messages({
          path: { id: sessionID },
          query: { directory },
          throwOnError: true,
        });
      } catch {
        return false;
      }
      if (!Array.isArray(messagesRes2?.data)) return false;
      const messages2 = messagesRes2.data;
      if (messages2.length !== messages1.length) return false;
      const latest2 = messages2[messages2.length - 1];
      if (!isMessageWithParts(latest2)) return false;
      if (latest2.info.id !== latest1.info.id) return false;
      if (latest2.info.role !== 'assistant') return false;
      const infoRecord2 = latest2.info as Record<string, unknown>;
      if (
        typeof infoRecord2.id !== 'string' ||
        infoRecord2.id.length === 0 ||
        infoRecord2.sessionID !== sessionID
      ) {
        return false;
      }
      const timeRecord2 = isObjectRecord(infoRecord2.time)
        ? infoRecord2.time
        : undefined;
      if (timeRecord2?.completed !== undefined) return false;
      if (infoRecord2.finish !== undefined && infoRecord2.finish !== null) {
        return false;
      }
      if (infoRecord2.error !== undefined) return false;

      const toolParts2 = latest2.parts.filter(
        (p) => isObjectRecord(p) && p.type === 'tool',
      ) as Array<Record<string, unknown>>;
      const toolStatuses2 = toolParts2.map((part) => {
        const state = isObjectRecord(part.state) ? part.state : undefined;
        return typeof state?.status === 'string' ? state.status : undefined;
      });
      if (
        toolStatuses2.some(
          (status) =>
            status !== 'pending' &&
            status !== 'running' &&
            status !== 'completed' &&
            status !== 'error',
        )
      ) {
        return false;
      }
      const activeToolParts2 = toolParts2.filter((_, index) =>
        ['pending', 'running'].includes(toolStatuses2[index] ?? ''),
      );
      if (activeToolParts2.length !== 1) return false;
      const toolPart2 = activeToolParts2[0];
      const toolState2 = isObjectRecord(toolPart2.state)
        ? toolPart2.state
        : undefined;
      if (toolState2?.status !== 'running') return false;
      const toolTime2 = isObjectRecord(toolState2.time)
        ? toolState2.time
        : undefined;
      if (typeof toolTime2?.start !== 'number') return false;
      if (toolPart2.id !== toolPart1.id) return false;
      const toolName2 =
        typeof toolPart2.tool === 'string' ? toolPart2.tool : '';
      if (toolName2 !== toolName1) return false;
      const callID2 =
        typeof toolPart2.callID === 'string' ? toolPart2.callID : '';
      if (callID2 !== callID1) return false;
      if (!isObjectRecord(toolState2.input)) return false;
      const toolInput2 = toolState2.input;
      if (
        canonicalDigest('omos/tool-args/v1', toolInput2) !== argumentDigest1
      ) {
        return false;
      }

      // 5. Final active-state check immediately before the prompt.
      const finalStatus = await sessionSdk.status({
        query: { directory },
        throwOnError: true,
      });
      if (
        !isObjectRecord(finalStatus?.data) ||
        isBootstrapActiveStatus(finalStatus.data, sessionID) ||
        hasActiveChild(children2, finalStatus.data)
      ) {
        return false;
      }
      if (options.hasInputWait(sessionID)) return false;
      if (options.isFallbackInProgress?.(sessionID)) return false;
      if (disposed) return false;

      const finalDurable = controller.store.read(sessionID);
      if (!finalDurable.success || finalDurable.data.waitCondition)
        return false;
      const finalOperation = finalDurable.data.operations.find(
        (operation) => operation.id === priorRunningOp.id,
      );
      if (
        finalOperation?.status !== 'interrupted' ||
        finalOperation.error !== 'Operation interrupted by process restart'
      ) {
        return false;
      }
      const finalAction = finalDurable.data.actionsRequired.find(
        (action) =>
          action.resolvedAt === undefined &&
          action.code === 'interrupted_operation' &&
          action.referenceId === priorRunningOp.id,
      );
      if (!finalAction) return false;

      const modelSelection =
        parseContinuationModelSelection(latest1.info) ??
        parseContinuationModelSelection(sessionData.model) ??
        getObservedWakeModel(sessionID);

      try {
        await sessionSdk.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body: {
            agent: 'orchestrator',
            ...(modelSelection ? { model: modelSelection.model } : {}),
            parts: [
              createInternalAgentTextPart(ORCHESTRATOR_RESTART_RECOVERY_TEXT),
            ],
          },
          throwOnError: true,
        });
      } catch (error) {
        recordRestartRecoveryFailure(sessionID, owner);
        log('[orchestrator-wake] restart recovery prompt failed', {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }

      commitRestartRecoverySuccess(sessionID, owner);
      options.registerSessionAsOrchestrator?.(sessionID);
      return true;
    } finally {
      releaseRestartRecovery(sessionID, owner);
    }
  }

  function runStartupScan(): Promise<void> {
    if (disposed || !enabled) return Promise.resolve();
    if (!hasRequiredSessionApis(sessionSdk)) return Promise.resolve();
    if (typeof sessionSdk.list !== 'function') return Promise.resolve();

    return (async () => {
      try {
        const listRes = await sessionSdk.list({
          query: { directory },
          throwOnError: true,
        });
        if (!Array.isArray(listRes?.data)) return;
        const allSessions = listRes.data as Array<Record<string, unknown>>;
        const rootCandidates = allSessions.filter(
          (session) =>
            !session.parentID &&
            typeof session.directory === 'string' &&
            session.directory === directory,
        );
        rootCandidates.sort((a, b) => {
          const timeA = isObjectRecord(a.time)
            ? typeof a.time.updated === 'number'
              ? a.time.updated
              : typeof a.time.created === 'number'
                ? a.time.created
                : 0
            : 0;
          const timeB = isObjectRecord(b.time)
            ? typeof b.time.updated === 'number'
              ? b.time.updated
              : typeof b.time.created === 'number'
                ? b.time.created
                : 0
            : 0;
          return timeB - timeA;
        });
        const maxBootstrapRoots = Math.max(
          1,
          Math.min(options.maxBootstrapRoots ?? 256, 256),
        );
        const candidates = rootCandidates
          .slice(0, maxBootstrapRoots)
          .map((s) => String(s.id))
          .filter((id) => Boolean(id));

        const concurrency = Math.min(options.bootstrapConcurrency ?? 4, 4);
        let index = 0;
        async function worker() {
          while (index < candidates.length && !disposed) {
            const sessionID = candidates[index++];
            if (!sessionID) break;
            try {
              await classifyAndRecoverInterruptedSession(
                sessionID,
                'bootstrap',
              );
            } catch (err) {
              log(
                '[orchestrator-wake] error scanning session for restart recovery',
                {
                  sessionID,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
            }
          }
        }
        const workers = Array.from(
          { length: Math.min(concurrency, candidates.length) },
          () => worker(),
        );
        await Promise.all(workers);
      } catch (err) {
        log('[orchestrator-wake] startup scan failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  function touchLocal(sessionID: string): LocalSessionState {
    const existing = localSessions.get(sessionID);
    if (existing) return existing;
    const created: LocalSessionState = {
      generation: Symbol(sessionID),
      timer: undefined,
      continuousIdle: false,
    };
    localSessions.set(sessionID, created);
    return created;
  }

  function clearTimer(state: LocalSessionState): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  function bumpGeneration(state: LocalSessionState): void {
    state.generation = Symbol('wake-generation');
  }

  function clearLocalSession(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state) return;
    clearTimer(state);
    bumpGeneration(state);
    localSessions.delete(sessionID);
  }

  function releaseLocalWakeOwner(sessionID: string): void {
    const owner = localWakeOwners.get(sessionID);
    if (!owner) return;
    localWakeOwners.delete(sessionID);
    releaseWakeEvaluation(sessionID, owner);
  }

  function clearSession(sessionID: string): void {
    releaseLocalWakeOwner(sessionID);
    clearLocalSession(sessionID);
    clearWakeSession(sessionID);
    pendingStoppedRecoveries.delete(sessionID);
  }

  /**
   * Suppress scheduling without dropping process-global progress.
   * Used for input waits and temporary blocks.
   */
  function suppress(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state) return;
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    releaseLocalWakeOwner(sessionID);
  }

  /**
   * End a continuous idle spell. When `rearmProgress` is true, reset the
   * process-global no-progress cap (external busy / lifecycle). Wake-initiated
   * busy must pass false so the two-wake cap survives busy→idle.
   */
  function endIdleSpell(sessionID: string, rearmProgress: boolean): void {
    const state = localSessions.get(sessionID);
    if (state) {
      clearTimer(state);
      bumpGeneration(state);
      state.continuousIdle = false;
    }
    releaseLocalWakeOwner(sessionID);
    if (rearmProgress) rearmWakeProgress(sessionID);
  }

  function canSchedule(sessionID: string): boolean {
    if (!enabled) return false;
    if (!hasRequiredSessionApis(sessionSdk)) return false;
    if (!options.shouldManageSession(sessionID)) return false;
    if (options.hasInputWait(sessionID)) return false;
    if (options.isFallbackInProgress?.(sessionID)) return false;
    if (getWakeProgress(sessionID).stopped) return false;
    return true;
  }

  function schedule(sessionID: string): void {
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    if (!state.continuousIdle || state.timer !== undefined) return;
    if (getWakeProgress(sessionID).stopped) return;

    const generation = state.generation;
    const timer = setTimeout(() => {
      state.timer = undefined;
      if (state.generation !== generation) return;
      void evaluate(sessionID, generation);
    }, intervalMs);
    timer.unref?.();
    state.timer = timer;
  }

  function beginContinuousIdle(sessionID: string): void {
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    if (state.continuousIdle && state.timer !== undefined) return;
    state.continuousIdle = true;
    if (getWakeProgress(sessionID).stopped) return;
    if (state.timer === undefined) schedule(sessionID);
  }

  async function readHostSnapshot(sessionID: string): Promise<
    | {
        todos: Array<Record<string, unknown>>;
        children: Array<Record<string, unknown>>;
        status: Record<string, unknown>;
        model?: ContinuationModelSelection;
      }
    | undefined
  > {
    if (!hasRequiredSessionApis(sessionSdk)) return undefined;

    const dirQuery = { directory };
    const [todoResponse, childrenResponse, statusResponse] = await Promise.all([
      sessionSdk.todo({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      }),
      sessionSdk.children({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      }),
      sessionSdk.status({
        query: dirQuery,
        throwOnError: true,
      }),
    ]);

    if (
      !Array.isArray(todoResponse.data) ||
      !Array.isArray(childrenResponse.data) ||
      !isObjectRecord(statusResponse.data)
    ) {
      return undefined;
    }

    const todos = todoResponse.data;
    const children = childrenResponse.data;
    const status = statusResponse.data;

    if (
      !todos.every(
        (todo) => isObjectRecord(todo) && typeof todo.status === 'string',
      ) ||
      !todosHaveValidStatuses(todos as Array<Record<string, unknown>>) ||
      !children.every(
        (child) => isObjectRecord(child) && typeof child.id === 'string',
      )
    ) {
      return undefined;
    }

    let model: ContinuationModelSelection | undefined;
    try {
      const sessionResponse = await sessionSdk.get({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      });
      // Session.model is version-dependent; read via record shape.
      const session = isObjectRecord(sessionResponse?.data)
        ? sessionResponse.data
        : undefined;
      model = parseContinuationModelSelection(
        session ? (session as Record<string, unknown>).model : undefined,
      );
    } catch {
      // Model enrichment is fail-soft.
    }

    return {
      todos: todos as Array<Record<string, unknown>>,
      children: children as Array<Record<string, unknown>>,
      status,
      model,
    };
  }

  async function evaluate(
    sessionID: string,
    generation: symbol,
    recoveryWake = false,
  ): Promise<void> {
    const state = localSessions.get(sessionID);
    if (!state || state.generation !== generation) return;
    if (!state.continuousIdle) return;
    if (!canSchedule(sessionID)) {
      suppress(sessionID);
      return;
    }

    const owner = tryBeginWakeEvaluation(sessionID);
    if (!owner) {
      retryAfterWakeEvaluation(sessionID, () => {
        const current = localSessions.get(sessionID);
        if (
          current === state &&
          current.generation === generation &&
          current.continuousIdle
        ) {
          void evaluate(sessionID, generation, recoveryWake);
        }
      });
      return;
    }
    localWakeOwners.set(sessionID, owner);

    try {
      const snapshot = await readHostSnapshot(sessionID);
      if (!snapshot || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }

      if (isActiveStatus(snapshot.status, sessionID)) {
        endIdleSpell(sessionID, true);
        return;
      }
      if (!recoveryWake && hasActiveChild(snapshot.children, snapshot.status)) {
        schedule(sessionID);
        return;
      }
      if (!recoveryWake && !hasIncompleteTodos(snapshot.todos)) {
        // No incomplete work: end the spell; do not keep polling.
        endIdleSpell(sessionID, false);
        return;
      }

      const fingerprint = buildOrchestratorWakeFingerprint(
        snapshot.todos,
        snapshot.children,
        snapshot.status,
      );
      noteHostProgress(sessionID, fingerprint);

      const progress = getWakeProgress(sessionID);
      if (
        progress.stopped ||
        (progress.lastFingerprint === fingerprint &&
          progress.unchangedWakeCount >= ORCHESTRATOR_WAKE_UNCHANGED_CAP)
      ) {
        progress.stopped = true;
        state.continuousIdle = false;
        return;
      }

      // Recheck host status/waits immediately before promptAsync.
      const latest = await readHostSnapshot(sessionID);
      if (!latest || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }
      if (isActiveStatus(latest.status, sessionID)) {
        endIdleSpell(sessionID, true);
        return;
      }
      if (!recoveryWake && hasActiveChild(latest.children, latest.status)) {
        schedule(sessionID);
        return;
      }
      if (!recoveryWake && !hasIncompleteTodos(latest.todos)) {
        endIdleSpell(sessionID, false);
        return;
      }

      const latestFingerprint = buildOrchestratorWakeFingerprint(
        latest.todos,
        latest.children,
        latest.status,
      );
      noteHostProgress(sessionID, latestFingerprint);

      const latestProgress = getWakeProgress(sessionID);
      if (
        latestProgress.stopped ||
        latestProgress.unchangedWakeCount >= ORCHESTRATOR_WAKE_UNCHANGED_CAP
      ) {
        latestProgress.stopped = true;
        state.continuousIdle = false;
        return;
      }

      const modelSelection =
        latest.model ?? snapshot.model ?? getObservedWakeModel(sessionID);

      // Reserve before promptAsync so a failed call cannot storm retries and
      // concurrent hook instances cannot double-wake.
      if (!commitWakeReservation(sessionID, owner, latestFingerprint)) {
        return;
      }

      if (!hasRequiredSessionApis(sessionSdk)) return;

      await sessionSdk.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          agent: 'orchestrator',
          ...(modelSelection ? { model: modelSelection.model } : {}),
          parts: [
            createInternalAgentTextPart(
              recoveryWake
                ? ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT
                : ORCHESTRATOR_WAKE_TEXT,
            ),
          ],
        },
        throwOnError: true,
      });
      if (recoveryWake) pendingStoppedRecoveries.delete(sessionID);
    } catch (error) {
      // Failed promptAsync already reserved; clear expecting-busy so a later
      // unrelated busy can rearm normally.
      clearExpectingWakeBusy(sessionID);
      log('[orchestrator-wake] wake suppressed after SDK error', {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Always release ownership — even when suppress/endIdle bumped generation.
      releaseWakeEvaluation(sessionID, owner);
      if (localWakeOwners.get(sessionID) === owner) {
        localWakeOwners.delete(sessionID);
      }

      const current = localSessions.get(sessionID);
      if (
        current &&
        current.generation === generation &&
        current.continuousIdle &&
        current.timer === undefined &&
        !getWakeProgress(sessionID).stopped
      ) {
        schedule(sessionID);
      }
    }
  }

  function observeChatMessage(input: unknown, output: unknown): void {
    const inputMessage = isObjectRecord(input) ? input : undefined;
    const outputRecord = isObjectRecord(output) ? output : undefined;
    const outputMessage = isObjectRecord(outputRecord?.message)
      ? outputRecord.message
      : undefined;
    const sessionID =
      typeof outputMessage?.sessionID === 'string'
        ? outputMessage.sessionID
        : typeof inputMessage?.sessionID === 'string'
          ? inputMessage.sessionID
          : undefined;
    const parts = Array.isArray(outputRecord?.parts)
      ? outputRecord.parts
      : inputMessage?.parts;
    if (
      !sessionID ||
      (typeof outputMessage?.role === 'string' &&
        outputMessage.role !== 'user') ||
      !options.shouldManageSession(sessionID) ||
      !Array.isArray(parts) ||
      parts.some(isInternalInitiatorPart) ||
      !parts.some(
        (part) =>
          isObjectRecord(part) &&
          part.synthetic !== true &&
          !isInternalInitiatorPart(part) &&
          ((part.type === 'text' && typeof part.text === 'string') ||
            part.type === 'file' ||
            part.type === 'image'),
      )
    ) {
      return;
    }

    const outputModel = isObjectRecord(outputMessage?.model)
      ? outputMessage.model
      : undefined;
    const variant =
      typeof inputMessage?.variant === 'string'
        ? inputMessage.variant
        : outputModel?.variant;
    const modelSelection =
      parseContinuationModelSelection(inputMessage?.model, variant) ??
      parseContinuationModelSelection(outputModel, variant);

    setObservedWakeModel(sessionID, modelSelection);

    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    // External user activity rearms the process-global no-progress cap.
    rearmWakeProgress(sessionID);
  }

  /**
   * Immediately evaluate an idle orchestrator after a child stops without a
   * native terminal result. This is deliberately separate from the periodic
   * TODO wake: stopped work needs recovery even when its parent has no todo.
   */
  function triggerStoppedJobRecovery(sessionID: string): void {
    if (
      disposed ||
      !enabled ||
      !hasRequiredSessionApis(sessionSdk) ||
      !options.shouldManageSession(sessionID)
    ) {
      return;
    }
    pendingStoppedRecoveries.add(sessionID);
    rearmWakeProgress(sessionID);
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = true;
    rearmWakeProgress(sessionID);
    void evaluate(sessionID, state.generation, true);
  }

  async function event(input: {
    event: {
      type: string;
      properties?: {
        info?: { id?: string };
        sessionID?: string;
        status?: { type?: string };
      };
    };
  }): Promise<void> {
    const { type, properties } = input.event;

    if (type === 'server.instance.disposed') {
      disposed = true;
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      pendingStoppedRecoveries.clear();
      for (const sessionID of [...localWakeOwners.keys()]) {
        releaseLocalWakeOwner(sessionID);
      }
      for (const sessionID of [...localSessions.keys()]) {
        clearLocalSession(sessionID);
      }
      return;
    }

    const sessionID = extractSessionID(input.event);
    if (!sessionID) return;

    if (type === 'session.deleted') {
      clearSession(sessionID);
      return;
    }

    if (isInputWaitAskEvent(type)) {
      if (options.shouldManageSession(sessionID)) {
        suppress(sessionID);
      }
      return;
    }

    if (isIdleEvent(type, properties)) {
      if (options.shouldManageSession(sessionID)) {
        clearExpectingWakeBusy(sessionID);
        if (pendingStoppedRecoveries.has(sessionID)) {
          triggerStoppedJobRecovery(sessionID);
          return;
        }
        beginContinuousIdle(sessionID);
      } else {
        // First idle/status event fallback for unknown sessions
        await classifyAndRecoverInterruptedSession(sessionID, 'event');
      }
      return;
    }

    if (isBusyEvent(type, properties)) {
      if (options.shouldManageSession(sessionID)) {
        // Wake-initiated busy preserves the no-progress cap; external busy rearms.
        const wakeBusy = isExpectingWakeBusy(sessionID);
        endIdleSpell(sessionID, !wakeBusy);
      } else {
        clearExpectingWakeBusy(sessionID);
      }
      return;
    }

    if (type === 'session.error' || type === 'session.status') {
      if (
        type === 'session.error' ||
        (type === 'session.status' &&
          properties?.status?.type !== 'idle' &&
          properties?.status?.type !== 'busy')
      ) {
        if (options.shouldManageSession(sessionID)) {
          // Errors / retry are external lifecycle — rearm.
          clearExpectingWakeBusy(sessionID);
          endIdleSpell(sessionID, true);
        }
      }
    }
  }

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionID) => {
      clearSession(sessionID);
    });
  }

  if (
    enabled &&
    options.outcomeController &&
    hasRequiredSessionApis(sessionSdk) &&
    typeof sessionSdk.list === 'function'
  ) {
    const settleDelayMs = options.startupSettleDelayMs ?? 50;
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      void runStartupScan();
    }, settleDelayMs);
    startupTimer.unref?.();
  }

  return {
    event,
    observeChatMessage,
    triggerStoppedJobRecovery,
    /** Clear timers when wait_for_user or fallback begins. */
    suppress,
    /** Run startup scan immediately */
    runStartupScan,
    /** Test seam */
    _test: {
      localSessions,
      intervalMs,
      enabled,
      hasRequiredSessionApis: () => hasRequiredSessionApis(sessionSdk),
      classifyAndRecoverInterruptedSession,
      runStartupScan,
      getStartupTimer: () => startupTimer,
    },
  };
}

export type OrchestratorWakeScheduler = ReturnType<
  typeof createOrchestratorWakeScheduler
>;
