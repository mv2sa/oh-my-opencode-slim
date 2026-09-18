import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';

/** Only parent prompt-lifecycle timers live here. Child terminal policy and
 * its one retry timer belong to the shared terminal gate. */
export function createIdleReconciler(options: {
  terminalGate: BackgroundJobTerminalGate;
  reconcileInjectedTerminalJobs: (parentSessionID: string) => void;
  idleReconcileDelayMs: number;
  isFallbackInProgress?: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  getIdleSessionToken: (sessionID: string) => symbol;
  isCurrentIdleSessionToken: (sessionID: string, token: symbol) => boolean;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleIdleReconciliation(parentSessionID: string): void {
    if (
      timers.has(parentSessionID) ||
      options.hasInputWait(parentSessionID) ||
      options.isFallbackInProgress?.(parentSessionID)
    )
      return;
    const token = options.getIdleSessionToken(parentSessionID);
    const timer = setTimeout(() => {
      timers.delete(parentSessionID);
      if (!options.isCurrentIdleSessionToken(parentSessionID, token)) return;
      options.reconcileInjectedTerminalJobs(parentSessionID);
    }, options.idleReconcileDelayMs);
    timer.unref?.();
    timers.set(parentSessionID, timer);
  }

  function scheduleChildIdleReconciliation(
    sessionID: string,
    idleObservedAt: number,
    generation: number,
    error?: string,
  ): void {
    const run = { taskID: sessionID, generation };
    const token = options.terminalGate.capture(run);
    if (!token) return;
    // A host event is a candidate, not a substitute for the current runtime.
    const observation = options.terminalGate.observe(token, {
      kind: 'quiescent',
      origin: 'session.idle',
      readStartedAt: token.readStartedAt,
      observedAt: idleObservedAt,
    });
    if (observation.kind === 'stale') return;
    void options.terminalGate.reconcile(
      run,
      error ? { kind: 'session-error', message: error } : { kind: 'inspect' },
    );
  }

  function clearIdleTimers(sessionID: string): void {
    const timer = timers.get(sessionID);
    if (timer) clearTimeout(timer);
    timers.delete(sessionID);
  }

  return {
    scheduleIdleReconciliation,
    scheduleChildIdleReconciliation,
    clearIdleTimers,
    clearAllTimers() {
      const sessions = [...timers.keys()];
      for (const sessionID of sessions) clearIdleTimers(sessionID);
      return sessions;
    },
    onInvalidateIdle: clearIdleTimers,
  };
}
