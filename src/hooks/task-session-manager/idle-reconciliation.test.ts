import { expect, mock, test } from 'bun:test';
import { createIdleReconciler } from './idle-reconciliation';

test('child idle preserves event provenance and requests runtime inspection', () => {
  const calls: string[] = [];
  const token = { taskID: 'child', generation: 1, readStartedAt: 1 };
  const reconciler = createIdleReconciler({
    terminalGate: {
      capture: () => token,
      observe: (_token: unknown, runtime: unknown) => {
        calls.push('observe');
        expect(runtime).toEqual({
          kind: 'quiescent',
          origin: 'session.idle',
          readStartedAt: 1,
          observedAt: 1,
        });
        return { kind: 'deferred', record: {} };
      },
      reconcile: async () => {
        calls.push('inspect');
        return { kind: 'stale' };
      },
      dispose() {},
    } as never,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 1,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
  });
  reconciler.scheduleChildIdleReconciliation('child', 1, 1);
  expect(calls).toEqual(['observe', 'inspect']);
  expect(reconciler.clearAllTimers()).toEqual([]);
});
test('parent reconciliation retains its independent delay and invalidation', async () => {
  const acknowledge = mock(() => {});
  const reconciler = createIdleReconciler({
    terminalGate: {} as never,
    reconcileInjectedTerminalJobs: acknowledge,
    idleReconcileDelayMs: 1,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
  });
  reconciler.scheduleIdleReconciliation('cancelled');
  reconciler.onInvalidateIdle('cancelled');
  reconciler.scheduleIdleReconciliation('parent');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith('parent');
  reconciler.clearAllTimers();
});
