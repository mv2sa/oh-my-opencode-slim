/**
 * Periodic orchestrator wake scheduler.
 *
 * After continuous parent-idle time, capability-gated host session APIs may
 * receive a static internal wake prompt when incomplete todos remain. Active
 * children suppress periodic wakes. Host responses are authoritative; the local
 * job board is never consulted. Progress/reservation state is process-global
 * so independently created hook instances share one-flight and the two-wake
 * no-progress cap.
 *
 * v2 hosts (hostFlavor 'v2', stamped by the client shim) have no todo/
 * children/status surfaces, so the scheduler runs there in a children-driven
 * degraded mode: children are enumerated via `session.list({parentID})`
 * (event-tracked fallback when the listing is unavailable), the wake
 * condition is "children without a terminal outcome" plus stopped-job
 * recovery, and the wake prompt is delivered with `delivery: 'queue'`
 * (v1 prompt_async queued; v2 steer would hijack an in-flight run). All new
 * behavior is behind the host-flavor/capability probe — the v1 code path is
 * unchanged.
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
import type { SessionSelection } from '../../utils/session-selection';
import { externalMessage } from '../external-message';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../task-session-manager/continuation-model-selection';
import { isActiveStatus } from '../task-session-manager/status-utils';
import { isMessageWithParts } from '../types';
import {
  admitWakeSession,
  canAttemptRestartRecovery,
  clearExpectingWakeBusy,
  clearWakeSession,
  commitRestartRecoverySuccess,
  commitWakeReservation,
  getObservedWakeModel,
  getWakeProgress,
  isExpectingWakeBusy,
  isWakeRunning,
  noteExternalWakeMessage,
  noteHostProgress,
  observeWakeEvent,
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

/** All automatic prompt attempts, including transport errors, share this cap. */
/**
 * True only for a genuine external operator message. Plugin-injected nudges
 * must never rearm the no-progress cap or clear wait state:
 * - synthetic parts (board tails, phase reminders, revived-run terminal
 *   notifications, internal-initiator wake replays) are host/internal, not
 *   operator input;
 * - `noReply` prompts (task_message child nudges, interview URL
 *   notifications) never expect an operator turn;
 * - v2 command-marker submits (`ctx.session.prompt` text-only submits) carry
 *   no chat.message messageID identity, so they fail the operator-identity
 *   gate below.
 *
 * Exported for unit tests and shared with task-session-manager (single
 * source of truth for the genuine-operator verdict).
 */
export function isGenuineOperatorMessage(
  inputMessage: Record<string, unknown> | undefined,
  outputMessage: Record<string, unknown> | undefined,
  parts: unknown,
): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;
  for (const part of parts) {
    if (!isObjectRecord(part)) continue;
    // Any synthetic or internal-initiator part vetoes the whole message:
    // a single plugin-injected part marks the turn as plugin-injected even
    // when it rides alongside genuine operator text (e.g. a wake replay
    // appended to an operator turn). Fail closed toward no-rearm.
    if (part.synthetic === true || isInternalInitiatorPart(part)) return false;
    // Non-text/non-file/non-image parts (e.g. step-start markers) carry no
    // operator content.
    if (
      !(
        (part.type === 'text' && typeof part.text === 'string') ||
        part.type === 'file' ||
        part.type === 'image'
      )
    ) {
      continue;
    }
    // Tagged synthetic-adjacent injections (board/phase metadata keys) that
    // survived without the synthetic flag are still not operator input.
    if (isObjectRecord(part.metadata)) {
      const metadata = part.metadata as Record<string, unknown>;
      if (
        metadata['oh-my-opencode-slim.backgroundJobBoard'] === true ||
        metadata['oh-my-opencode-slim.phaseReminder'] === true ||
        metadata['oh-my-opencode-slim.internalInitiator'] === true
      ) {
        return false;
      }
    }
  }
  // Operator identity: the host assigns a messageID to real chat.message
  // turns. v2 command submits and bare notify injections arrive without one.
  // Upstream's messageIdentity seam (input.messageID → output.message.id →
  // same-process output.message object, fail closed) is the identity half
  // of this verdict; the checks above are the genuineness half. Both must
  // pass: callers keep their own messageIdentity computation and additionally
  // require this helper, so neither seam can pass an injection alone.
  const inputMessageID = inputMessage?.messageID;
  const outputMessageID = outputMessage?.id;
  const hasOperatorIdentity =
    (typeof inputMessageID === 'string' && inputMessageID.length > 0) ||
    (typeof outputMessageID === 'string' && outputMessageID.length > 0);
  if (!hasOperatorIdentity) return false;
  // noReply injections never expect an operator turn.
  if (inputMessage?.noReply === true || outputMessage?.noReply === true) {
    return false;
  }
  return true;
}

/** Self-contained terminal delta appended to the stopped-job recovery wake.
 * The board snapshot path cannot serve this wake: under the
 * `checkpoint-compatible` injection strategy, internal-initiator messages
 * (which this wake is) are excluded from creating a board snapshot, so the
 * first snapshot the parent sees after the wake reflects a board state from
 * BEFORE the job stopped. A wake that says "check the board" with no board
 * entry behind it leaves the parent guessing. The delta carries the facts
 * of the triggering stop inline: alias, task id, run generation, state, and
 * why it stopped. Deduplicated per execution by the caller. */
export function formatStoppedJobDelta(record: {
  alias: string;
  taskID: string;
  generation: number;
  state: string;
  reason: string;
}): string {
  return `<stopped-job>\nalias: ${record.alias}\ntask: ${record.taskID}\ngeneration: ${record.generation}\nstate: ${record.state}\nreason: ${record.reason}\n</stopped-job>`;
}

/** Children-mode variant (v2 degraded mode): watchdog over background
 * children and unreconciled jobs instead of the todo list. */
export const ORCHESTRATOR_CHILDREN_WAKE_TEXT =
  '<system-reminder>\nCheck on unfinished background child sessions and unreconciled jobs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

/** After this many successful wakes with an unchanged fingerprint, stop. */
export const ORCHESTRATOR_WAKE_UNCHANGED_CAP = 2;

/** Max stopped-job deltas queued per parent. Oldest entries are dropped
 * when a new distinct stop would exceed the cap, so a busy/waiting parent
 * cannot grow an unbounded recovery prompt. */
export const STOPPED_RECOVERY_QUEUE_CAP = 32;

/** Max deltas appended to one recovery wake. Remaining entries stay queued
 * for the next wake so a failed oversized join cannot wedge the batch. */
export const STOPPED_RECOVERY_WAKE_CHUNK = 8;

/** Recovery facts that overflow the bounded detail queue still produce a
 * durable, actionable signal. The parent can consult the board for the facts
 * whose inline details were coalesced. */
export const STOPPED_RECOVERY_OVERFLOW_TEXT =
  '<stopped-job-overflow>\nAdditional stopped-job recovery facts were queued beyond the inline detail limit. Consult the Background Job Board for all unreconciled stopped jobs.\n</stopped-job-overflow>';

/**
 * Children-driven mode: a child with `outcome === undefined` counts as
 * inactive once its newest update evidence (host `time.updated` or a
 * tracked status change) is older than this multiple of the wake interval.
 * Bounds wakes when a child crashes mid-run without recording an outcome;
 * stopped-job recovery remains the explicit path for such children.
 */
export const CHILD_STALENESS_INTERVALS = 3;

const SUPPORTED_TODO_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

type SessionClient = OpencodeClient['session'];

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

/** Todo-mode host snapshot (v1): todos + children + live status map. */
type TodoModeSnapshot = {
  kind: 'todo';
  todos: Array<Record<string, unknown>>;
  children: Array<Record<string, unknown>>;
  status: Record<string, unknown>;
  model?: ContinuationModelSelection;
  archiveState?: boolean;
};

/** Children-mode snapshot (v2 degraded mode / explicit 'children'). */
type ChildrenModeSnapshot = {
  kind: 'children';
  children: Array<WakeChildInfo>;
  /** v1 status-map parent activity (v2 has no status map; the event-tracked
   * race guard covers it). */
  hostParentActive: boolean;
  model?: ContinuationModelSelection;
  archiveState?: boolean;
};

type WakeSnapshot = TodoModeSnapshot | ChildrenModeSnapshot;

/** Checkpoint verdict shared by both wake modes. */
type SnapshotVerdict = 'parent-active' | 'children-active' | 'no-work' | 'wake';

type LocalSessionState = {
  /** Invalidates local timers/async work for this hook instance. */
  generation: symbol;
  timer: ReturnType<typeof setTimeout> | undefined;
  continuousIdle: boolean;
  archived: boolean;
};

export type OrchestratorWakeConfig = {
  enabled: boolean;
  intervalMs: number;
  /** Wake-condition source; resolved against host capabilities (see
   * `resolveWakeMode`). Optional for callers built before the field
   * existed — absent means 'auto'. */
  mode?: 'auto' | 'todo' | 'children';
};

export type OrchestratorWakeOptions = {
  config: OrchestratorWakeConfig;
  shouldManageSession: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  isFallbackInProgress?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
  /** Revalidate a queued stop immediately before delivering its recovery wake.
   * The callback must check both the task generation and that the current
   * record is still stopped and terminal-unreconciled. */
  isStoppedJobRecoveryCurrent?: (taskID: string, generation: number) => boolean;
  /** Resolve the session's CURRENT agent/model selection at send time
   * (#1079): a lifecycle wake must continue the parent in the mode the
   * session uses now, never a hardcoded `orchestrator`. When absent or
   * unresolved, behavior falls back to the historical orchestrator wake. */
  resolveSelection?: (sessionID: string) => Promise<SessionSelection>;
  /** True when the parent session has delegated work pending: live
   * children or terminal-unreconciled records (#1079). In that state a
   * lifecycle wake stays eligible even when the user switched the
   * session to a non-orchestrator agent — the wake continues in the
   * CURRENT selection instead of forcing `orchestrator`. */
  hasPendingDelegatedWork?: (sessionID: string) => boolean;
  /** Test seam: override interval without changing config validation. */
  intervalMs?: number;
  outcomeController?: OutcomeController;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
  startupSettleDelayMs?: number;
  restartSnapshotSettleDelayMs?: number;
  maxBootstrapRoots?: number;
  bootstrapConcurrency?: number;
};

/**
 * Capability record for the host session surface. The v1 branch keeps
 * exactly the historical probe set (get/todo/children/status/promptAsync);
 * the v2 branch (hostFlavor 'v2', stamped by the client shim) requires only
 * list+promptAsync — `get` is optional enrichment and todo/children/status
 * have no v2 equivalent (children-driven degraded mode covers them).
 */
export type WakeSessionApis = {
  flavor: 'v1' | 'v2';
  hasGet: boolean;
  hasTodo: boolean;
  hasChildren: boolean;
  hasStatus: boolean;
  hasList: boolean;
  hasPromptAsync: boolean;
  /** True when the scheduler can operate against this host surface. */
  ready: boolean;
};

function probeSessionApis(
  session: SessionClient | undefined,
  hostFlavor: string | undefined,
): WakeSessionApis {
  const flavor = hostFlavor === 'v2' ? ('v2' as const) : ('v1' as const);
  const caps = {
    flavor,
    hasGet: typeof session?.get === 'function',
    hasTodo: typeof session?.todo === 'function',
    hasChildren: typeof session?.children === 'function',
    hasStatus: typeof session?.status === 'function',
    hasList: typeof session?.list === 'function',
    hasPromptAsync: typeof session?.promptAsync === 'function',
  } as WakeSessionApis;
  caps.ready =
    flavor === 'v2'
      ? caps.hasList && caps.hasPromptAsync
      : caps.hasGet &&
        caps.hasTodo &&
        caps.hasChildren &&
        caps.hasStatus &&
        caps.hasPromptAsync;
  return caps;
}

export type ResolvedWakeMode = 'todo' | 'children';

/**
 * Resolve the configured wake mode against host capabilities: 'auto' uses
 * todo-gating on v1 and children-driven degraded mode on v2; an explicit
 * 'todo' degrades to children on hosts without the todo API (v2).
 */
export function resolveWakeMode(
  configured: 'auto' | 'todo' | 'children' | undefined,
  caps: Pick<WakeSessionApis, 'flavor' | 'hasTodo'>,
): ResolvedWakeMode {
  if (configured === 'children') return 'children';
  if (configured === 'todo') {
    return caps.flavor === 'v2' || !caps.hasTodo ? 'children' : 'todo';
  }
  return caps.flavor === 'v2' ? 'children' : 'todo';
}

/** Normalized child view for children-driven wake decisions. */
export type WakeChildInfo = {
  id: string;
  /** v2 Session.Info.outcome — present only on terminal transition
   * (succeeded|failed|interrupted). */
  outcome?: string;
  /** Workspace directory when the host reports it (scope filter). */
  directory?: string;
  /** Newest update-evidence timestamp (epoch ms) when known. */
  evidenceAt?: number;
};

/** Event-tracked session status (busy-set + parent-active race guard). */
export type TrackedSessionStatus = { status: 'busy' | 'idle'; at: number };

/** Numeric variant of the update-evidence cascade (staleness bound). */
export function childUpdateEvidenceMs(
  child: Record<string, unknown>,
): number | undefined {
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
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** Map one host child/list entry to the normalized children-mode view. */
export function mapWakeChild(
  child: Record<string, unknown>,
): WakeChildInfo | undefined {
  if (typeof child.id !== 'string' || !child.id) return undefined;
  const info: WakeChildInfo = { id: child.id };
  if (typeof child.outcome === 'string' && child.outcome) {
    info.outcome = child.outcome;
  }
  if (typeof child.directory === 'string' && child.directory) {
    info.directory = child.directory;
  }
  const evidence = childUpdateEvidenceMs(child);
  if (evidence !== undefined) {
    info.evidenceAt = evidence;
  }
  return info;
}

/**
 * Active-child determination for children-driven mode: a terminal outcome
 * always wins; otherwise the child is active while its newest evidence —
 * host update time OR tracked status change (the event busy-set) — is
 * fresher than the staleness bound. Children with no evidence at all are
 * inactive (cannot be proven active).
 */
export function isWakeChildActive(
  child: WakeChildInfo,
  tracked: TrackedSessionStatus | undefined,
  now: number,
  stalenessMs: number,
): boolean {
  if (child.outcome !== undefined) return false;
  const evidenceAt = Math.max(child.evidenceAt ?? 0, tracked?.at ?? 0);
  if (evidenceAt <= 0) return false;
  return now - evidenceAt <= stalenessMs;
}

/** Children-mode fingerprint: id + outcome + tracked status + evidence. */
export function buildChildrenWakeFingerprint(
  children: Array<WakeChildInfo>,
  trackedStatuses: ReadonlyMap<string, TrackedSessionStatus>,
): string {
  return children
    .map((child) => {
      const tracked = trackedStatuses.get(child.id);
      return [
        child.id,
        child.outcome ?? '',
        tracked?.status ?? '',
        String(child.evidenceAt ?? ''),
      ].join(':');
    })
    .sort()
    .join('\n');
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

function childStatusEvidence(
  childID: string,
  status: Record<string, unknown>,
): string {
  if (!Object.hasOwn(status, childID)) return 'idle';
  const entry = status[childID];
  if (!isObjectRecord(entry)) return 'malformed';
  return entry.type === 'idle' ? 'idle' : 'active';
}

function childrenFingerprint(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return children
    .map((child) => {
      const id = String(child.id);
      return `${id}:${childStatusEvidence(id, status)}`;
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
  properties?: unknown;
  data?: unknown;
}): string | undefined {
  const payload = isObjectRecord(event.data)
    ? event.data
    : isObjectRecord(event.properties)
      ? event.properties
      : undefined;
  const info = isObjectRecord(payload?.info) ? payload.info : payload;
  if (typeof info?.id === 'string' && info.id) return info.id;
  if (typeof payload?.sessionID === 'string' && payload.sessionID) {
    return payload.sessionID;
  }
  return undefined;
}

function readSessionArchiveState(session: unknown): boolean | undefined {
  if (
    !isObjectRecord(session) ||
    Array.isArray(session) ||
    !isObjectRecord(session.time) ||
    Array.isArray(session.time)
  ) {
    return undefined;
  }
  const archived = session.time.archived;
  if (archived === undefined || archived === null) return false;
  return typeof archived === 'number' && Number.isFinite(archived)
    ? true
    : undefined;
}

function readEventArchiveState(event: {
  properties?: unknown;
  data?: unknown;
}): boolean | undefined {
  const payload = isObjectRecord(event.data)
    ? event.data
    : isObjectRecord(event.properties)
      ? event.properties
      : undefined;
  const info = isObjectRecord(payload?.info) ? payload.info : payload;
  return readSessionArchiveState(info);
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

  /** Static host-surface capability record (the client never changes). */
  const capabilities = probeSessionApis(
    sessionSdk,
    (ctx as PluginInput & { hostFlavor?: string }).hostFlavor,
  );
  const wakeMode = resolveWakeMode(options.config.mode, capabilities);
  if (enabled && capabilities.flavor === 'v2' && !capabilities.hasTodo) {
    log(
      '[orchestrator-wake] host provides no session todo API; running in children-driven degraded mode',
      { directory },
    );
  }

  /** Local timer/generation state only; progress lives in the process gate. */
  const localSessions = new Map<string, LocalSessionState>();
  /** Reservations this hook owns and must release when it is disposed. */
  const localWakeOwners = new Map<string, symbol>();
  type PendingStoppedRecovery = {
    deltas: Map<string, string>;
    /** Number of detail entries coalesced beyond the bounded queue. */
    overflowCount: number;
  };

  /** Sessions with a stopped job awaiting a recovery wake, carrying the
   * self-contained terminal deltas of the triggering stops (see
   * `formatStoppedJobDelta`), deduplicated per execution by
   * `(taskID, generation)`. Bounded per parent (`STOPPED_RECOVERY_QUEUE_CAP`);
   * each wake sends at most `STOPPED_RECOVERY_WAKE_CHUNK` entries. Overflow
   * is represented by a durable count and an inline signal rather than being
   * silently discarded. Deltas that arrive while a recovery wake is in flight
   * must survive its confirmation: only the keys actually sent are retired on
   * delivery. */
  const pendingStoppedRecoveries = new Map<string, PendingStoppedRecovery>();

  function parseRecoveryKey(
    key: string,
  ): { taskID: string; generation: number } | undefined {
    const separator = key.lastIndexOf(':');
    if (separator <= 0) return undefined;
    const taskID = key.slice(0, separator);
    const generation = Number(key.slice(separator + 1));
    return taskID && Number.isSafeInteger(generation) && generation >= 0
      ? { taskID, generation }
      : undefined;
  }

  /** Drop stop facts that are no longer current. Repeat after every
   * await so a child revived during selection resolve is not sent. */
  function pruneStoppedRecoveryDeltas(
    batch: PendingStoppedRecovery | undefined,
  ): boolean {
    if (!batch) return false;
    const hadRecoveryDetails = batch.deltas.size > 0;
    if (options.isStoppedJobRecoveryCurrent) {
      for (const key of batch.deltas.keys()) {
        const parsed = parseRecoveryKey(key);
        if (!parsed) {
          batch.deltas.delete(key);
          continue;
        }
        let current = false;
        try {
          current = options.isStoppedJobRecoveryCurrent(
            parsed.taskID,
            parsed.generation,
          );
        } catch {
          current = false;
        }
        if (!current) batch.deltas.delete(key);
      }
    }
    return hadRecoveryDetails;
  }

  /** Queue a stop delta for the session's next recovery wake. */
  const addStoppedRecoveryDelta = (
    sessionID: string,
    delta: string,
    dedupeKey?: string,
  ): void => {
    let batch = pendingStoppedRecoveries.get(sessionID);
    if (!batch) {
      batch = { deltas: new Map(), overflowCount: 0 };
      pendingStoppedRecoveries.set(sessionID, batch);
    }
    const key = dedupeKey ?? delta;
    if (batch.deltas.has(key)) {
      batch.deltas.set(key, delta);
      return;
    }
    while (batch.deltas.size >= STOPPED_RECOVERY_QUEUE_CAP) {
      const oldest = batch.deltas.keys().next().value;
      if (oldest === undefined) break;
      batch.deltas.delete(oldest);
      batch.overflowCount += 1;
    }
    batch.deltas.set(key, delta);
  };
  /** Event-tracked session statuses (busy-set + parent race guard). */
  const lastStatusBySession = new Map<string, TrackedSessionStatus>();
  /** parentID → child session ids observed via session.created events. */
  const childSessions = new Map<string, Set<string>>();
  /** Newest event evidence (created/status change) per child, epoch ms. */
  const childEvidence = new Map<string, number>();
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

    // 1. Raw prior-epoch Outcome store read (or an exact already-recovered
    // interrupted operation when a previous classification lost a host race).
    const rawRes = controller.store.read(sessionID);
    if (!rawRes.success) return false; // corrupt or missing records rejected
    const rawRecord = rawRes.data;
    if (!admitWakeSession(sessionID)) return false;

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
      if (
        !finalDurable.success ||
        finalDurable.data.waitCondition ||
        finalDurable.data.phase === 'accepted'
      )
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

      if (
        !commitWakeReservation(
          sessionID,
          owner,
          buildOrchestratorWakeFingerprint(todos2, children2, finalStatus.data),
        )
      )
        return false;
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

  /** Bound for the event-tracked bookkeeping maps (FIFO eviction). */
  const MAX_EVENT_TRACKED_SESSIONS = 512;

  function boundTrackedMap<T>(map: Map<string, T>): void {
    while (map.size > MAX_EVENT_TRACKED_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function recordTrackedStatus(
    sessionID: string,
    status: 'busy' | 'idle',
  ): void {
    const now = Date.now();
    lastStatusBySession.set(sessionID, { status, at: now });
    boundTrackedMap(lastStatusBySession);
    if (childEvidence.has(sessionID)) {
      childEvidence.set(sessionID, now);
      boundTrackedMap(childEvidence);
    }
  }

  function recordChildSession(parentID: string, childID: string): void {
    let kids = childSessions.get(parentID);
    if (!kids) {
      kids = new Set();
      childSessions.set(parentID, kids);
      boundTrackedMap(childSessions);
    }
    kids.add(childID);
    childEvidence.set(childID, Date.now());
    boundTrackedMap(childEvidence);
  }

  function forgetSessionEvents(sessionID: string): void {
    lastStatusBySession.delete(sessionID);
    childEvidence.delete(sessionID);
    childSessions.delete(sessionID);
    for (const kids of childSessions.values()) {
      kids.delete(sessionID);
    }
  }

  function isParentActiveByEvents(sessionID: string): boolean {
    return lastStatusBySession.get(sessionID)?.status === 'busy';
  }

  function touchLocal(sessionID: string): LocalSessionState {
    const existing = localSessions.get(sessionID);
    if (existing) return existing;
    const created: LocalSessionState = {
      generation: Symbol(sessionID),
      timer: undefined,
      continuousIdle: false,
      archived: false,
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

  function suppressArchivedSession(sessionID: string): void {
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    state.archived = true;
    releaseLocalWakeOwner(sessionID);
  }

  function restoreArchivedSession(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state?.archived) return;
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    state.archived = false;
    releaseLocalWakeOwner(sessionID);
    rearmWakeProgress(sessionID);
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
  }

  /**
   * Lifecycle activity invalidates local work, never progress or live ownership.
   */
  function endIdleSpell(sessionID: string, _rearmProgress: boolean): void {
    const state = localSessions.get(sessionID);
    if (state) {
      clearTimer(state);
      bumpGeneration(state);
      state.continuousIdle = false;
    }
  }

  /** #1079: a parent with delegated work pending stays wake-eligible
   * even after the user switched it to a non-orchestrator agent — the
   * wake then continues in the CURRENT selection (resolveSelection)
   * instead of being dropped or forcing `orchestrator`. Without
   * pending delegated work, only orchestrator sessions schedule wakes
   * (a random Plan/Build TODO must not become a wake reason). */
  function canObserveSelection(sessionID: string): boolean {
    return (
      options.shouldManageSession(sessionID) ||
      (options.hasPendingDelegatedWork?.(sessionID) ?? false)
    );
  }

  function canSchedule(sessionID: string): boolean {
    if (!enabled) return false;
    if (!capabilities.ready) return false;
    if (!admitWakeSession(sessionID)) return false;
    if (!canObserveSelection(sessionID)) return false;
    if (localSessions.get(sessionID)?.archived) return false;
    if (options.hasInputWait(sessionID)) return false;
    if (options.isFallbackInProgress?.(sessionID)) return false;
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
    const state = localSessions.get(sessionID);
    if (state?.archived) {
      if (
        enabled &&
        capabilities.ready &&
        typeof sessionSdk.get === 'function'
      ) {
        void refreshArchivedSession(sessionID, state.generation);
      }
      return;
    }
    if (!canSchedule(sessionID)) return;
    const idleState = touchLocal(sessionID);
    if (idleState.continuousIdle && idleState.timer !== undefined) return;
    idleState.continuousIdle = true;
    if (getWakeProgress(sessionID).stopped) return;
    if (idleState.timer === undefined) schedule(sessionID);
  }

  type SessionMetadata = {
    model?: ContinuationModelSelection;
    archiveState?: boolean;
  };

  /** Fail-soft session-model and archive-state enrichment. */
  async function readSessionModel(sessionID: string): Promise<SessionMetadata> {
    if (typeof sessionSdk?.get !== 'function') return {};
    try {
      const sessionResponse = await sessionSdk.get({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      });
      // Session.model is version-dependent; read via record shape.
      const session = isObjectRecord(sessionResponse?.data)
        ? sessionResponse.data
        : undefined;
      return {
        model: parseContinuationModelSelection(
          session ? (session as Record<string, unknown>).model : undefined,
        ),
        archiveState: readSessionArchiveState(session),
      };
    } catch {
      // Model and archive enrichment are fail-soft; lifecycle events remain
      // the v2 source when session.get is unavailable or fails.
      return {};
    }
  }

  async function refreshArchivedSession(
    sessionID: string,
    generation: symbol,
  ): Promise<void> {
    const { archiveState } = await readSessionModel(sessionID);
    const state = localSessions.get(sessionID);
    if (
      !state ||
      state.generation !== generation ||
      !state.archived ||
      archiveState !== false
    ) {
      return;
    }
    restoreArchivedSession(sessionID);
  }

  function applyArchiveState(
    sessionID: string,
    state: LocalSessionState,
    archiveState: boolean | undefined,
  ): boolean {
    if (state.archived) {
      if (archiveState === false) {
        restoreArchivedSession(sessionID);
      } else {
        suppressArchivedSession(sessionID);
      }
      return true;
    }
    if (archiveState === true) {
      suppressArchivedSession(sessionID);
      return true;
    }
    return false;
  }

  async function readHostSnapshot(
    sessionID: string,
  ): Promise<TodoModeSnapshot | undefined> {
    if (!capabilities.ready) return undefined;

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
      ) ||
      !children.every((child) => {
        if (!Object.hasOwn(status, child.id)) return true;
        const entry = status[child.id];
        return (
          isObjectRecord(entry) &&
          ['idle', 'busy', 'retry'].includes(String(entry.type))
        );
      })
    ) {
      return undefined;
    }

    const { model, archiveState } = await readSessionModel(sessionID);

    return {
      kind: 'todo',
      todos: todos as Array<Record<string, unknown>>,
      children: children as Array<Record<string, unknown>>,
      status,
      model,
      archiveState,
    };
  }

  /**
   * Children-driven degraded mode snapshot (v2, or explicit 'children' on
   * v1). Children are enumerated via `session.list({parentID})` through the
   * shim; when the listing is unavailable (missing/erroring/empty) the
   * event-tracked bookkeeping (session.created parentID links + tracked
   * statuses) is the fallback. Results are scoped to this workspace and
   * enriched with the session model (fail-soft).
   */
  async function readChildrenSnapshot(
    sessionID: string,
  ): Promise<ChildrenModeSnapshot | undefined> {
    if (!capabilities.ready) return undefined;

    let children: Array<WakeChildInfo> | undefined;
    let hostParentActive = false;

    if (capabilities.flavor === 'v2') {
      try {
        const response = (await sessionSdk.list({
          query: { parentID: sessionID, directory },
        } as Parameters<SessionClient['list']>[0])) as { data?: unknown };
        if (Array.isArray(response?.data)) {
          children = response.data
            .filter(isObjectRecord)
            .map(mapWakeChild)
            .filter((child): child is WakeChildInfo => child !== undefined);
        }
      } catch (error) {
        log(
          '[orchestrator-wake] session.list child enumeration failed; using event-tracked fallback',
          {
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } else {
      const dirQuery = { directory };
      const [childrenResponse, statusResponse] = await Promise.all([
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
        !Array.isArray(childrenResponse.data) ||
        !isObjectRecord(statusResponse.data)
      ) {
        return undefined;
      }
      if (
        !childrenResponse.data.every(
          (child) => isObjectRecord(child) && typeof child.id === 'string',
        )
      ) {
        return undefined;
      }
      children = childrenResponse.data
        .filter(isObjectRecord)
        .map(mapWakeChild)
        .filter((child): child is WakeChildInfo => child !== undefined);
      hostParentActive = isActiveStatus(statusResponse.data, sessionID);
    }

    if (children === undefined || children.length === 0) {
      const trackedKids = childSessions.get(sessionID);
      children = trackedKids
        ? [...trackedKids].map((id) => {
            const evidenceAt = childEvidence.get(id);
            return evidenceAt === undefined ? { id } : { id, evidenceAt };
          })
        : [];

      // Event-tracked children carry no `outcome` and their local evidence
      // can go stale while the child is still running. The host is
      // authoritative on every evaluation, so refresh EVERY fallback child
      // via session.get: a live child never drops out of the watchdog on
      // stale local evidence, and a discovered terminal outcome stays in the
      // snapshot so the wake fingerprint does not flip between terminal and
      // unknown (which would spuriously rearm the no-progress cap). Fail-soft
      // per child; extra calls are bounded by the tracked-children set and
      // the evaluation cadence.
      const getSession = sessionSdk.get;
      if (
        capabilities.flavor === 'v2' &&
        typeof getSession === 'function' &&
        children.length > 0
      ) {
        children = await Promise.all(
          children.map(async (child) => {
            try {
              const response = (await getSession({
                path: { id: child.id },
                query: { directory },
                throwOnError: true,
              })) as { data?: unknown };
              const session = isObjectRecord(response?.data)
                ? response.data
                : undefined;
              if (!session) return child;
              const outcome =
                typeof session.outcome === 'string' && session.outcome
                  ? session.outcome
                  : undefined;
              const evidence = childUpdateEvidenceMs(session);
              const enriched: WakeChildInfo = { ...child };
              if (outcome) enriched.outcome = outcome;
              if (
                evidence !== undefined &&
                (child.evidenceAt === undefined || evidence > child.evidenceAt)
              ) {
                enriched.evidenceAt = evidence;
              }
              return enriched;
            } catch {
              return child;
            }
          }),
        );
      }
    }

    // Workspace scoping: drop children the host reports under another
    // directory (only when the info is available).
    children = children.filter(
      (child) => child.directory === undefined || child.directory === directory,
    );

    const { model, archiveState } = await readSessionModel(sessionID);

    return {
      kind: 'children',
      children,
      hostParentActive,
      model,
      archiveState,
    };
  }

  /** Active-child check for children-driven mode (see isWakeChildActive). */
  function hasActiveWakeChild(children: Array<WakeChildInfo>): boolean {
    const now = Date.now();
    const stalenessMs = intervalMs * CHILD_STALENESS_INTERVALS;
    return children.some((child) =>
      isWakeChildActive(
        child,
        lastStatusBySession.get(child.id),
        now,
        stalenessMs,
      ),
    );
  }

  /**
   * Classify a snapshot at a wake checkpoint. The todo branch is the exact
   * v1 check sequence (host status map → active-child suppression →
   * incomplete-todo condition); children mode replaces the status-map
   * lookups with the event-tracked parent guard and the outcome-based child
   * check (active children ARE the wake condition there — recovery wakes
   * bypass it, as on v1).
   */
  function classifyTodoSnapshot(
    snapshot: TodoModeSnapshot,
    sessionID: string,
    recoveryWake: boolean,
  ): SnapshotVerdict {
    if (isActiveStatus(snapshot.status, sessionID)) return 'parent-active';
    if (!recoveryWake && hasActiveChild(snapshot.children, snapshot.status)) {
      return 'children-active';
    }
    if (!recoveryWake && !hasIncompleteTodos(snapshot.todos)) {
      return 'no-work';
    }
    return 'wake';
  }

  function classifyChildrenSnapshot(
    snapshot: ChildrenModeSnapshot,
    sessionID: string,
    recoveryWake: boolean,
  ): SnapshotVerdict {
    if (snapshot.hostParentActive || isParentActiveByEvents(sessionID)) {
      return 'parent-active';
    }
    if (!recoveryWake && !hasActiveWakeChild(snapshot.children)) {
      return 'no-work';
    }
    return 'wake';
  }

  function classifySnapshot(
    snapshot: WakeSnapshot,
    sessionID: string,
    recoveryWake: boolean,
  ): SnapshotVerdict {
    return snapshot.kind === 'children'
      ? classifyChildrenSnapshot(snapshot, sessionID, recoveryWake)
      : classifyTodoSnapshot(snapshot, sessionID, recoveryWake);
  }

  function buildSnapshotFingerprint(snapshot: WakeSnapshot): string {
    return snapshot.kind === 'children'
      ? buildChildrenWakeFingerprint(snapshot.children, lastStatusBySession)
      : buildOrchestratorWakeFingerprint(
          snapshot.todos,
          snapshot.children,
          snapshot.status,
        );
  }

  /** Apply a checkpoint verdict; false means the evaluation ended. */
  function applySnapshotVerdict(
    sessionID: string,
    verdict: SnapshotVerdict,
  ): boolean {
    if (verdict === 'parent-active') {
      endIdleSpell(sessionID, true);
      return false;
    }
    if (verdict === 'children-active') {
      schedule(sessionID);
      return false;
    }
    if (verdict === 'no-work') {
      // No incomplete work: end the spell; do not keep polling.
      endIdleSpell(sessionID, false);
      return false;
    }
    return true;
  }

  async function evaluate(
    sessionID: string,
    generation: symbol,
    recoveryWake = false,
  ): Promise<void> {
    const state = localSessions.get(sessionID);
    if (!state || state.generation !== generation) return;
    if (!state.continuousIdle) return;
    if (state.archived) return;
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
      const snapshot =
        wakeMode === 'children'
          ? await readChildrenSnapshot(sessionID)
          : await readHostSnapshot(sessionID);
      if (!snapshot || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (applyArchiveState(sessionID, state, snapshot.archiveState)) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }

      const outcome = options.outcomeController?.store.read(sessionID);
      if (
        outcome?.success &&
        (outcome.data.phase === 'accepted' ||
          options.outcomeController?.validateManagedWait(sessionID).allowed)
      )
        return;

      if (
        !applySnapshotVerdict(
          sessionID,
          classifySnapshot(snapshot, sessionID, recoveryWake),
        )
      ) {
        return;
      }

      const fingerprint = buildSnapshotFingerprint(snapshot);
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
      const latest =
        wakeMode === 'children'
          ? await readChildrenSnapshot(sessionID)
          : await readHostSnapshot(sessionID);
      if (!latest || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (applyArchiveState(sessionID, state, latest.archiveState)) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }
      const latestOutcome = options.outcomeController?.store.read(sessionID);
      if (
        latestOutcome?.success &&
        (latestOutcome.data.phase === 'accepted' ||
          options.outcomeController?.validateManagedWait(sessionID).allowed)
      )
        return;

      if (
        !applySnapshotVerdict(
          sessionID,
          classifySnapshot(latest, sessionID, recoveryWake),
        )
      ) {
        return;
      }

      const latestFingerprint = buildSnapshotFingerprint(latest);
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

      const recoveryBatch = recoveryWake
        ? pendingStoppedRecoveries.get(sessionID)
        : undefined;
      if (recoveryBatch) {
        const hadRecoveryDetails = pruneStoppedRecoveryDeltas(recoveryBatch);
        // A stale, revived, or already-reconciled detail must not cause a
        // recovery wake by itself. An overflow marker remains actionable even
        // when all retained details have since gone stale.
        if (
          hadRecoveryDetails &&
          recoveryBatch.deltas.size === 0 &&
          recoveryBatch.overflowCount === 0
        ) {
          pendingStoppedRecoveries.delete(sessionID);
          return;
        }
      }

      const modelSelection =
        latest.model ?? snapshot.model ?? getObservedWakeModel(sessionID);

      const finalOutcome = options.outcomeController?.store.read(sessionID);
      if (
        finalOutcome?.success &&
        (finalOutcome.data.phase === 'accepted' ||
          options.outcomeController?.validateManagedWait(sessionID).allowed)
      )
        return;

      // #1079: resolve the session's CURRENT selection at send time. A
      // lifecycle wake continues the parent in the agent/model it uses
      // now; `orchestrator` is only the fallback when nothing else is
      // observable (matching the historical behavior for sessions that
      // always ran orchestrator).
      const selection = options.resolveSelection
        ? await options.resolveSelection(sessionID).catch(() => undefined)
        : undefined;
      // The await above is a new race window: an external message can
      // bump generation / end idle, and a Plan/Build host selection
      // must not ride in on stale orchestrator metadata.
      if (state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }
      const wakeAgent = selection?.agent ?? 'orchestrator';
      if (
        wakeAgent !== 'orchestrator' &&
        !(options.hasPendingDelegatedWork?.(sessionID) ?? false)
      ) {
        return;
      }
      // Re-prune stop facts after the selection await: a child can leave
      // stopped/unreconciled while parent generation stays put (#1079 r2).
      if (recoveryBatch) {
        const hadRecoveryDetails = pruneStoppedRecoveryDeltas(recoveryBatch);
        if (
          hadRecoveryDetails &&
          recoveryBatch.deltas.size === 0 &&
          recoveryBatch.overflowCount === 0
        ) {
          pendingStoppedRecoveries.delete(sessionID);
          return;
        }
      }
      // Keep model+variant as one selection. Mixing a new model with a
      // leftover variant from another model produces B/max from A/max.
      const wakeModel = selection?.model ?? modelSelection?.model;
      const wakeVariant = selection?.model
        ? selection.variant
        : modelSelection?.variant;

      // Reserve before promptAsync so a failed call cannot storm retries and
      // concurrent hook instances cannot double-wake.
      if (!commitWakeReservation(sessionID, owner, latestFingerprint)) {
        return;
      }

      const wakeText = recoveryWake
        ? ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT
        : wakeMode === 'children'
          ? ORCHESTRATOR_CHILDREN_WAKE_TEXT
          : ORCHESTRATOR_WAKE_TEXT;
      // Snapshot keys/values at send time. Do not detach the map: a stop
      // arriving during promptAsync lands in the same entry and must survive
      // confirmation. After delivery, retire only the keys that were sent.
      const sentKeys = recoveryBatch
        ? [...recoveryBatch.deltas.keys()].slice(0, STOPPED_RECOVERY_WAKE_CHUNK)
        : [];
      const sentOverflowCount = recoveryBatch?.overflowCount ?? 0;
      const recoveryDelta = sentKeys
        .map((key) => recoveryBatch?.deltas.get(key))
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      const overflowDelta =
        recoveryBatch && recoveryBatch.overflowCount > 0
          ? STOPPED_RECOVERY_OVERFLOW_TEXT
          : '';
      const recoveryDetails = [overflowDelta, recoveryDelta]
        .filter(Boolean)
        .join('\n');
      const body = {
        agent: wakeAgent,
        ...(wakeModel ? { model: wakeModel } : {}),
        parts: [
          createInternalAgentTextPart(
            recoveryDetails ? `${wakeText}\n${recoveryDetails}` : wakeText,
          ),
        ],
      };
      if (wakeMode === 'children' && capabilities.flavor === 'v2') {
        // v1 prompt_async queued; 'queue' preserves that on v2 ('steer'
        // would hijack an in-flight run). The v1 prompt body has no variant
        // slot, so the wake model's reasoning-effort variant travels as the
        // v2-only `modelVariant`; the shim merges it into the switchModel
        // ref. Absent variant leaves the call shape unchanged.
        // `modelSelection: 'inherit'` marks this as a lifecycle
        // continuation (#1079): the v2 shim takes the host's persisted
        // selection instead of re-pinning this snapshot model.
        await (
          sessionSdk.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: sessionID },
          query: { directory },
          body,
          delivery: 'queue',
          modelSelection: 'inherit',
          ...(wakeVariant ? { modelVariant: wakeVariant } : {}),
          throwOnError: true,
        });
      } else {
        // v1 path: the send-time-resolved body model is applied directly
        // by the host (no switchModel, so no stale-pin revert race). The
        // cast drops nothing on v1 — the SDK discards unknown root fields
        // (same RequestInit path as `delivery`, #1192) — while v2 hosts
        // in todo mode read `modelSelection` and get the same
        // lifecycle-inherit semantics as children mode.
        await (
          sessionSdk.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: sessionID },
          query: { directory },
          body,
          modelSelection: 'inherit',
          throwOnError: true,
        });
      }
      if (recoveryWake) {
        const remaining = pendingStoppedRecoveries.get(sessionID);
        if (remaining) {
          for (const key of sentKeys) remaining.deltas.delete(key);
          remaining.overflowCount = Math.max(
            0,
            remaining.overflowCount - sentOverflowCount,
          );
          if (remaining.deltas.size === 0 && remaining.overflowCount === 0) {
            pendingStoppedRecoveries.delete(sessionID);
          } else {
            rearmWakeProgress(sessionID);
          }
        }
      }
    } catch (error) {
      // Failed promptAsync already reserved; clear expecting-busy so a later
      // unrelated busy can rearm normally. Pending deltas stay queued.
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
    const external = externalMessage(input, output);
    if (
      !external ||
      (options.shouldManageSession &&
        !options.shouldManageSession(external.sessionID))
    )
      return;
    if (
      !external.parts.some(
        (part) =>
          (part.type === 'text' &&
            typeof part.text === 'string' &&
            part.text.trim()) ||
          part.type === 'file' ||
          part.type === 'image',
      )
    )
      return;
    const { sessionID, messageID } = external;
    const inputMessage = isObjectRecord(input) ? input : undefined;
    const outputRecord = isObjectRecord(output) ? output : undefined;
    const outputMessage = isObjectRecord(outputRecord?.message)
      ? outputRecord.message
      : undefined;

    const parts = Array.isArray(outputRecord?.parts)
      ? outputRecord.parts
      : inputMessage?.parts;
    if (
      !sessionID ||
      (typeof outputMessage?.role === 'string' &&
        outputMessage.role !== 'user') ||
      !Array.isArray(parts) ||
      parts.some(isInternalInitiatorPart) ||
      !isGenuineOperatorMessage(inputMessage, outputMessage, parts) ||
      !canObserveSelection(sessionID)
    ) {
      return;
    }

    if (!admitWakeSession(sessionID)) return;
    // Both hooks see the same host message; only the first observation refills.
    noteExternalWakeMessage(sessionID, messageID);

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
  }

  /**
   * Immediately evaluate an idle orchestrator after a child stops without a
   * native terminal result. This is deliberately separate from the periodic
   * TODO wake: stopped work needs recovery even when its parent has no todo.
   */
  function triggerStoppedJobRecovery(
    sessionID: string,
    delta?: string,
    dedupeKey?: string,
  ): void {
    if (
      disposed ||
      !enabled ||
      !capabilities.ready ||
      !canObserveSelection(sessionID)
    ) {
      return;
    }
    if (!admitWakeSession(sessionID)) return;
    if (delta) {
      addStoppedRecoveryDelta(sessionID, delta, dedupeKey);
    } else if (!pendingStoppedRecoveries.has(sessionID)) {
      pendingStoppedRecoveries.set(sessionID, {
        deltas: new Map(),
        overflowCount: 0,
      });
    }
    if (localSessions.get(sessionID)?.archived) {
      return;
    }
    if (!options.shouldManageSession(sessionID)) {
      rearmWakeProgress(sessionID);
    }
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = true;
    void evaluate(sessionID, state.generation, true);
  }

  async function event(input: {
    event: {
      type: string;
      properties?: unknown;
      data?: unknown;
    };
  }): Promise<void> {
    const { type } = input.event;
    const properties = (
      isObjectRecord(input.event.data)
        ? input.event.data
        : isObjectRecord(input.event.properties)
          ? input.event.properties
          : {}
    ) as {
      info?: { id?: string; parentID?: string; time?: unknown };
      sessionID?: string;
      parentID?: string;
      status?: { type?: string };
    };

    if (type === 'server.instance.disposed') {
      disposed = true;
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      pendingStoppedRecoveries.clear();
      lastStatusBySession.clear();
      childSessions.clear();
      childEvidence.clear();
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
    if (options.shouldManageSession(sessionID)) admitWakeSession(sessionID);
    observeWakeEvent(
      sessionID,
      input.event as Parameters<typeof observeWakeEvent>[1],
    );

    if (type === 'session.updated') {
      if (canObserveSelection(sessionID)) {
        const archiveState = readEventArchiveState(input.event);
        if (archiveState === true) {
          suppressArchivedSession(sessionID);
        } else if (archiveState === false) {
          restoreArchivedSession(sessionID);
        }
      }
      return;
    }

    // Event bookkeeping (children-driven mode + parent-active race guard).
    // Status tracking covers ALL sessions: child entries feed the busy-set
    // and update evidence, the parent entry is the race guard on hosts
    // without a live status map (v2).
    if (type === 'session.status') {
      const statusType = properties?.status?.type;
      if (statusType === 'busy' || statusType === 'idle') {
        recordTrackedStatus(sessionID, statusType);
      }
    } else if (type === 'session.created') {
      const parentID =
        typeof properties?.info?.parentID === 'string'
          ? properties.info.parentID
          : typeof properties?.parentID === 'string'
            ? properties.parentID
            : undefined;
      if (parentID) recordChildSession(parentID, sessionID);
    }

    if (type === 'session.deleted') {
      forgetSessionEvents(sessionID);
      clearSession(sessionID);
      return;
    }

    if (isInputWaitAskEvent(type)) {
      if (canObserveSelection(sessionID)) {
        suppress(sessionID);
      }
      return;
    }

    if (isIdleEvent(type, properties)) {
      if (isWakeRunning(sessionID)) return;
      if (canObserveSelection(sessionID)) {
        clearExpectingWakeBusy(sessionID);
        if (!admitWakeSession(sessionID)) return;
        if (pendingStoppedRecoveries.has(sessionID)) {
          if (localSessions.get(sessionID)?.archived) {
            beginContinuousIdle(sessionID);
          } else {
            triggerStoppedJobRecovery(sessionID);
          }
          return;
        }
        beginContinuousIdle(sessionID);
        // Exhaustion stops periodic polling. An idle event permits one bounded
        // telemetry evaluation, without refilling or sending at the cap.
        if (getWakeProgress(sessionID).stopped) {
          const state = touchLocal(sessionID);
          void evaluate(sessionID, state.generation);
        }
      } else {
        // First idle/status event fallback for unknown sessions
        await classifyAndRecoverInterruptedSession(sessionID, 'event');
      }
      return;
    }

    if (isBusyEvent(type, properties)) {
      if (canObserveSelection(sessionID)) {
        if (options.shouldManageSession(sessionID)) {
          endIdleSpell(sessionID, false);
        } else {
          // Wake-initiated busy preserves the no-progress cap; external busy rearms.
          const wakeBusy = isExpectingWakeBusy(sessionID);
          endIdleSpell(sessionID, !wakeBusy);
        }
      }
      return;
    }

    if (
      type === 'session.error' ||
      (type === 'session.status' &&
        properties?.status?.type !== 'idle' &&
        properties?.status?.type !== 'busy')
    ) {
      if (canObserveSelection(sessionID)) {
        // Errors / retry are external lifecycle — rearm.
        clearExpectingWakeBusy(sessionID);
        const shouldRearm = !options.shouldManageSession?.(sessionID);
        endIdleSpell(sessionID, shouldRearm);
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
      hasRequiredSessionApis: () => capabilities.ready,
      capabilities: () => capabilities,
      wakeMode: () => wakeMode,
      lastStatusBySession,
      childEvidence,
      childSessions,
      classifyAndRecoverInterruptedSession,
      runStartupScan,
      getStartupTimer: () => startupTimer,
    },
  };
}
