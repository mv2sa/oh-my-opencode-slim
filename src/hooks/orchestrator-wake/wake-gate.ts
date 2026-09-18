/**
 * Process-local gate for orchestrator-wake reservation, progress cap, and
 * in-flight ownership. Shared across independently created hook instances in
 * the same JS process via globalThis + Symbol.for.
 */

import { getGlobalStore } from '../../utils/global-store';
import type { ContinuationModelSelection } from '../task-session-manager/continuation-model-selection';

export type WakeProgressState = {
  unchangedWakeCount: number;
  lastFingerprint: string | undefined;
  stopped: boolean;
  /** Transport attribution for restart safety only; never reset authority. */
  expectingWakeBusy: boolean;
  observedModel: ContinuationModelSelection | undefined;
  fingerprints: Map<string, string>;
  externalMessageIDs: Set<string>;
  narration?: { cause: string; turns: Set<string> };
  idlePrompted: boolean;
  running: boolean;
  pendingLegacyIdle?: boolean;
};

export type RestartRecoveryState = {
  succeeded: boolean;
  attempts: number;
  inFlight: boolean;
};

type InFlightState = { owner: symbol; wakeCommitted: boolean };

type WakeGateStore = {
  progress: Map<string, WakeProgressState>;
  inFlight: Map<string, InFlightState>;
  releaseWaiters: Map<
    string,
    Map<symbol, { retry: () => void; retire: () => void }>
  >;
  lifecycleEvents?: WeakSet<object>;
  /** Insertion-ordered session keys for bounded eviction. */
  order: string[];
  restartRecovery: Map<string, RestartRecoveryState>;
  outcomeIdleWoken: Set<string>;
};

const STORE_KEY = 'oh-my-opencode-slim.orchestrator-wake-gate';
const MAX_TRACKED_SESSIONS = 256;

function getStore(): WakeGateStore {
  const store = getGlobalStore<WakeGateStore>(STORE_KEY, () => ({
    progress: new Map(),
    inFlight: new Map(),
    releaseWaiters: new Map(),
    order: [],
    restartRecovery: new Map(),
    outcomeIdleWoken: new Set(),
  }));
  store.restartRecovery ??= new Map();
  store.outcomeIdleWoken ??= new Set();
  return store;
}

function touchOrder(sessionID: string): void {
  const store = getStore();
  if (!store.progress.has(sessionID)) return;
  const idx = store.order.indexOf(sessionID);
  if (idx >= 0) store.order.splice(idx, 1);
  store.order.push(sessionID);
  // Never evict live budgets/owners: eviction would silently refill attempts.
  // Only the ancillary recency list is bounded; deletion retires session state.
  if (store.order.length > MAX_TRACKED_SESSIONS) store.order.shift();
}

function emptyProgress(): WakeProgressState {
  return {
    unchangedWakeCount: 0,
    lastFingerprint: undefined,
    stopped: false,
    expectingWakeBusy: false,
    observedModel: undefined,
    fingerprints: new Map(),
    externalMessageIDs: new Set(),
    idlePrompted: false,
    running: false,
  };
}

export function getWakeProgress(sessionID: string): WakeProgressState {
  const store = getStore();
  const existing = store.progress.get(sessionID);
  if (existing) {
    touchOrder(sessionID);
    return existing;
  }
  if (store.progress.size >= MAX_TRACKED_SESSIONS) {
    return {
      ...emptyProgress(),
      stopped: true,
      unchangedWakeCount: 2,
      idlePrompted: true,
    };
  }
  const created = emptyProgress();
  store.progress.set(sessionID, created);
  touchOrder(sessionID);
  return created;
}

/**
 * Atomically claim the single in-flight evaluation slot for a session.
 * Returns an owner token, or null if another evaluation owns the slot.
 */
export function tryBeginWakeEvaluation(sessionID: string): symbol | null {
  const store = getStore();
  if (!admitWakeSession(sessionID)) return null;
  if (store.inFlight.has(sessionID)) return null;
  const owner = Symbol(sessionID);
  store.inFlight.set(sessionID, { owner, wakeCommitted: false });
  touchOrder(sessionID);
  return owner;
}

/**
 * Release an in-flight evaluation only when still owned by `owner`.
 */
export function releaseWakeEvaluation(sessionID: string, owner: symbol): void {
  const store = getStore();
  const state = store.inFlight.get(sessionID);
  if (state?.owner === owner) {
    store.inFlight.delete(sessionID);
    const waiters = store.releaseWaiters.get(sessionID);
    store.releaseWaiters.delete(sessionID);
    for (const waiter of waiters?.values() ?? []) waiter.retire();
    if (!state.wakeCommitted)
      for (const waiter of waiters?.values() ?? []) waiter.retry();
  }
}

/** Disposal may retire a read-only evaluation, but never an active transport. */
export function releaseUncommittedWakeEvaluation(
  sessionID: string,
  owner: symbol,
): void {
  const flight = getStore().inFlight.get(sessionID);
  if (flight?.owner === owner && !flight.wakeCommitted)
    releaseWakeEvaluation(sessionID, owner);
}

/**
 * Retry an evaluation that lost the shared in-flight reservation. Registering
 * and checking the reservation happen against the same store, so an owner
 * release cannot be missed between them.
 */
export function retryAfterWakeEvaluation(
  sessionID: string,
  retry: () => void,
  source: 'scheduler' | 'controller' = 'scheduler',
  retire: () => void = () => {},
): () => void {
  const store = getStore();
  if (!store.progress.has(sessionID)) {
    queueMicrotask(retire);
    return () => {};
  }
  if (!store.inFlight.has(sessionID)) {
    let cancelled = false;
    queueMicrotask(() => {
      retire();
      if (!cancelled) retry();
    });
    return () => {
      cancelled = true;
      retire();
    };
  }
  const waiters =
    store.releaseWaiters.get(sessionID) ??
    new Map<symbol, { retry: () => void; retire: () => void }>();
  if (waiters.size >= 256) {
    queueMicrotask(retire);
    return () => {};
  }
  const key = Symbol(source);
  waiters.set(key, { retry, retire });
  store.releaseWaiters.set(sessionID, waiters);
  return () => {
    const current = store.releaseWaiters.get(sessionID);
    if (current?.delete(key)) retire();
    if (current?.size === 0) store.releaseWaiters.delete(sessionID);
  };
}

/**
 * Record a wake reservation before promptAsync. Owner-safe: only the current
 * in-flight owner may commit once. All sources debit the same two-attempt cap.
 */
export function commitWakeReservation(
  sessionID: string,
  owner: symbol,
  fingerprint?: string,
): boolean {
  const store = getStore();
  const flight = store.inFlight.get(sessionID);
  if (flight?.owner !== owner || flight.wakeCommitted) return false;
  if (fingerprint !== undefined) noteHostProgress(sessionID, fingerprint);
  const progress = getWakeProgress(sessionID);
  if (progress.unchangedWakeCount >= 2 || progress.idlePrompted) return false;
  flight.wakeCommitted = true;
  progress.unchangedWakeCount += 1;
  progress.expectingWakeBusy = true;
  if (progress.unchangedWakeCount >= 2) {
    progress.stopped = true;
  }
  return true;
}

/** Host fingerprint changed: reset the two-wake no-progress cap. */
export function noteHostProgress(
  sessionID: string,
  fingerprint: string,
  component: 'todo-child' | 'controller' = 'todo-child',
): void {
  const progress = getWakeProgress(sessionID);
  const previous = progress.fingerprints.get(component);
  progress.fingerprints.set(component, fingerprint);
  progress.lastFingerprint = fingerprint;
  // First observation of another component is a baseline, not progress.
  if (previous !== undefined && previous !== fingerprint)
    rearmWakeProgress(sessionID);
}

export function noteExternalWakeMessage(
  sessionID: string,
  messageID: string,
): boolean {
  const progress = getWakeProgress(sessionID);
  if (
    !admitWakeSession(sessionID) ||
    progress.externalMessageIDs.has(messageID) ||
    progress.externalMessageIDs.size >= 256
  )
    return false;
  progress.externalMessageIDs.add(messageID);
  rearmWakeProgress(sessionID);
  return true;
}

/** Called only for completed, authoritative narration-only host turns. */
export function allowRecoveryNarration(
  sessionID: string,
  cause: string,
  turnID?: string,
): boolean {
  const progress = getWakeProgress(sessionID);
  if (progress.narration?.cause !== cause)
    progress.narration = { cause, turns: new Set() };
  const turns = progress.narration.turns;
  if (turnID && turns.size < 2) turns.add(turnID);
  return turns.size < 2;
}

/**
 * Whether busy belongs to a scheduler wake. The marker persists through
 * duplicate status delivery from independently-created hook instances.
 */
export function isExpectingWakeBusy(sessionID: string): boolean {
  const progress = getWakeProgress(sessionID);
  return progress.expectingWakeBusy;
}

/** Clear the scheduler busy marker once the corresponding idle arrives. */
export function clearExpectingWakeBusy(sessionID: string): void {
  const progress = getStore().progress.get(sessionID);
  if (progress) progress.expectingWakeBusy = false;
}

/** No eviction: unknown sessions fail closed at capacity. */
export function admitWakeSession(sessionID: string): boolean {
  getWakeProgress(sessionID);
  return getStore().progress.has(sessionID);
}

/** Shared transition admission, independent of the no-progress budget. */
export function observeWakeLifecycle(sessionID: string, status: string): void {
  const progress = getStore().progress.get(sessionID);
  if (!progress) return;
  if (status === 'busy') progress.running = true;
  if (status === 'idle' && progress.running) {
    progress.running = false;
    progress.idlePrompted = false;
    progress.expectingWakeBusy = false;
  }
}

/** Observe once, before either consumer awaits transport. A legacy idle paired
 * with status-idle belongs to that older transition, even if busy interleaves. */
export function observeWakeEvent(
  sessionID: string,
  event: {
    type: string;
    properties?: { status?: { type?: string } };
  },
): void {
  const store = getStore();
  const progress = store.progress.get(sessionID);
  if (!progress) return;
  store.lifecycleEvents ??= new WeakSet();
  if (store.lifecycleEvents.has(event)) return;
  store.lifecycleEvents.add(event);
  if (event.type === 'session.idle') {
    if (progress.pendingLegacyIdle) {
      progress.pendingLegacyIdle = false;
      return;
    }
    observeWakeLifecycle(sessionID, 'idle');
  } else if (event.type === 'session.status') {
    const status = event.properties?.status?.type;
    if (status === 'idle') progress.pendingLegacyIdle = true;
    observeWakeLifecycle(sessionID, status ?? '');
  }
}

export function isWakeRunning(sessionID: string): boolean {
  return getStore().progress.get(sessionID)?.running ?? false;
}

/** Only distinct external messages or meaningful component changes rearm. */
export function rearmWakeProgress(sessionID: string): void {
  const progress = getWakeProgress(sessionID);
  progress.unchangedWakeCount = 0;
  progress.stopped = false;
  progress.narration = undefined;
  progress.idlePrompted = false;
  progress.expectingWakeBusy = false;
  getStore().outcomeIdleWoken.delete(sessionID);
}

export function setObservedWakeModel(
  sessionID: string,
  model: ContinuationModelSelection | undefined,
): void {
  getWakeProgress(sessionID).observedModel = model;
}

export function getObservedWakeModel(
  sessionID: string,
): ContinuationModelSelection | undefined {
  return getStore().progress.get(sessionID)?.observedModel;
}

export function getRestartRecoveryState(
  sessionID: string,
): RestartRecoveryState {
  const store = getStore();
  if (!admitWakeSession(sessionID))
    return { succeeded: false, attempts: 2, inFlight: false };
  let state = store.restartRecovery.get(sessionID);
  if (!state) {
    state = { succeeded: false, attempts: 0, inFlight: false };
    store.restartRecovery.set(sessionID, state);
  }
  touchOrder(sessionID);
  return state;
}

export function canReserveOutcomeIdleWake(sessionID: string): boolean {
  const store = getStore();
  const recovery = store.restartRecovery.get(sessionID);
  if (recovery?.inFlight || store.outcomeIdleWoken.has(sessionID)) {
    return false;
  }
  const progress = getWakeProgress(sessionID);
  return !progress.stopped && !progress.idlePrompted;
}

export function commitOutcomeIdleWake(
  sessionID: string,
  owner: symbol,
): boolean {
  const progress = getWakeProgress(sessionID);
  if (progress.idlePrompted) return false;
  if (!commitWakeReservation(sessionID, owner)) return false;
  progress.idlePrompted = true;
  return true;
}

export function canAttemptRestartRecovery(sessionID: string): boolean {
  const store = getStore();
  const state = store.restartRecovery.get(sessionID);
  if (state?.succeeded) return false;
  if (state && state.attempts >= 2) return false;
  if (state?.inFlight) return false;
  if (store.inFlight.has(sessionID)) return false;
  if (store.progress.get(sessionID)?.stopped) return false;
  if (
    !store.progress.has(sessionID) &&
    store.progress.size >= MAX_TRACKED_SESSIONS
  )
    return false;
  if (store.progress.get(sessionID)?.expectingWakeBusy) return false;
  return true;
}

export function tryBeginRestartRecovery(sessionID: string): symbol | null {
  if (!canAttemptRestartRecovery(sessionID)) return null;
  if (!admitWakeSession(sessionID)) return null;
  const store = getStore();
  const state = getRestartRecoveryState(sessionID);
  state.inFlight = true;
  const owner = Symbol(`restart-recovery-${sessionID}`);
  store.inFlight.set(sessionID, { owner, wakeCommitted: false });
  touchOrder(sessionID);
  return owner;
}

export function commitRestartRecoverySuccess(
  sessionID: string,
  owner: symbol,
): void {
  const store = getStore();
  const flight = store.inFlight.get(sessionID);
  if (flight?.owner !== owner || !flight.wakeCommitted) return;
  const state = getRestartRecoveryState(sessionID);
  state.succeeded = true;
  state.inFlight = false;
  const progress = getWakeProgress(sessionID);
  progress.expectingWakeBusy = true;
  store.outcomeIdleWoken.add(sessionID);
  touchOrder(sessionID);
}

export function recordRestartRecoveryFailure(
  sessionID: string,
  owner: symbol,
): void {
  const store = getStore();
  if (store.inFlight.get(sessionID)?.owner !== owner) return;
  const state = getRestartRecoveryState(sessionID);
  if (!state.inFlight) return;
  state.attempts += 1;
  state.inFlight = false;
  clearExpectingWakeBusy(sessionID);
  touchOrder(sessionID);
}

export function releaseRestartRecovery(sessionID: string, owner: symbol): void {
  const store = getStore();
  if (store.inFlight.get(sessionID)?.owner !== owner) return;
  const state = store.restartRecovery.get(sessionID);
  if (state?.inFlight) {
    state.inFlight = false;
  }
  releaseWakeEvaluation(sessionID, owner);
}

export function clearOutcomeIdleWake(sessionID: string): void {
  const store = getStore();
  store.outcomeIdleWoken.delete(sessionID);
  clearExpectingWakeBusy(sessionID);
}

/** Full session cleanup (deletion or disposal). */
export function clearWakeSession(sessionID: string): void {
  const store = getStore();
  for (const waiter of store.releaseWaiters.get(sessionID)?.values() ?? [])
    waiter.retire();
  store.progress.delete(sessionID);
  store.inFlight.delete(sessionID);
  store.releaseWaiters.delete(sessionID);
  store.restartRecovery.delete(sessionID);
  store.outcomeIdleWoken.delete(sessionID);
  const idx = store.order.indexOf(sessionID);
  if (idx >= 0) store.order.splice(idx, 1);
}

/** Server/instance disposal: drop all process-local wake state. */
export function clearAllWakeSessions(): void {
  const store = getStore();
  for (const waiters of store.releaseWaiters.values())
    for (const waiter of waiters.values()) waiter.retire();
  store.lifecycleEvents = new WeakSet();
  store.progress.clear();
  store.inFlight.clear();
  store.releaseWaiters.clear();
  store.restartRecovery.clear();
  store.outcomeIdleWoken.clear();
  store.order.length = 0;
}

/** Test seam. */
export function resetOrchestratorWakeGateForTests(): void {
  clearAllWakeSessions();
}

export function wakeGateSizesForTests() {
  const store = getStore();
  return {
    progress: store.progress.size,
    restart: store.restartRecovery.size,
    owners: store.inFlight.size,
    waiters: store.releaseWaiters.size,
    order: store.order.length,
    outcomeIdle: store.outcomeIdleWoken.size,
  };
}
