import { expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
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

const quotaText =
  'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';

function quotaTranscript() {
  return {
    data: [
      { info: { id: 'baseline', role: 'user' }, parts: [] },
      {
        info: {
          id: 'asst-quota',
          role: 'assistant',
          providerID: 'google',
          modelID: 'antigravity-gemini-3-flash',
          finish: 'stop',
          tokens: { input: 0, output: 33 },
          time: { completed: 2 },
        },
        parts: [{ type: 'text', text: quotaText }],
      },
    ],
  };
}

function quotaGate(options: { onTerminalEvidence?: () => { kind: 'hold' } }) {
  const board = new BackgroundJobBoard();
  const run = board.registerLaunch({
    taskID: 'child',
    parentSessionID: 'parent',
    agent: 'fixer',
    background: true,
    now: 0,
  });
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    readRuntime: async (_run, readStartedAt) => ({
      kind: 'quiescent',
      origin: 'test',
      readStartedAt,
    }),
    readTerminalEvidence: async () => quotaTranscript(),
    ...options,
  });
  const reconciler = createIdleReconciler({
    terminalGate: gate,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 0,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
  });
  return { board, run, gate, reconciler };
}

test('child idle does not publish a synthetic-quota transcript as completed', async () => {
  const h = quotaGate({ onTerminalEvidence: () => ({ kind: 'hold' }) });
  h.reconciler.scheduleChildIdleReconciliation('child', 1, h.run.generation);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    terminalRevision: 0,
  });
  h.gate.dispose();
});

test('control: without the evidence hook the quota transcript is published completed', async () => {
  const h = quotaGate({});
  h.reconciler.scheduleChildIdleReconciliation('child', 1, h.run.generation);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    terminalRevision: 1,
    resultSummary: quotaText,
  });
  h.gate.dispose();
});
