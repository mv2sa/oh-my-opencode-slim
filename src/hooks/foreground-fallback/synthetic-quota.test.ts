import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import {
  createSyntheticQuotaCoordinator,
  verifyChildAntigravityEvidence,
} from './synthetic-quota';

const quotaText =
  'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';

/**
 * The exact shape that used to defeat `data.at(-1)`: the Antigravity quota
 * assistant turn is followed by a trailing structural/system item. The quota
 * notice is still the terminal assistant turn, not the raw last array entry.
 */
function transcriptWithTrailingSystemItem(): unknown {
  return {
    data: [
      { info: { id: 'baseline', role: 'user' }, parts: [] },
      {
        info: {
          id: 'asst-quota',
          role: 'assistant',
          providerID: 'google',
          modelID: 'antigravity-gemini-3-flash',
          agent: 'oracle',
          finish: 'stop',
          tokens: { input: 0, output: 33 },
          time: { completed: 2 },
        },
        parts: [{ type: 'text', text: quotaText }],
      },
      {
        info: { id: 'sys-structural', role: 'system' },
        parts: [{ type: 'text', text: 'internal bookkeeping' }],
      },
    ],
  };
}

describe('verifyChildAntigravityEvidence', () => {
  test('verifies the trailing assistant quota turn past a trailing system item', async () => {
    const messages = mock(async () => transcriptWithTrailingSystemItem());
    await expect(
      verifyChildAntigravityEvidence(
        { session: { messages } },
        'child',
        quotaText,
        '/tmp',
      ),
    ).resolves.toEqual({
      model: 'google/antigravity-gemini-3-flash',
      agent: 'oracle',
      failedMessageID: 'asst-quota',
    });
    expect(messages).toHaveBeenCalledTimes(1);
  });
});

describe('synthetic quota publication with a trailing system item', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  test('does not publish completed; the gate commits the quota error instead', async () => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'child-quota',
      parentSessionID: 'parent',
      agent: 'oracle',
      background: true,
    });
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      readRuntime: async (_run, readStartedAt) => ({
        kind: 'quiescent' as const,
        origin: 'test',
        readStartedAt,
      }),
      readTerminalEvidence: async () => transcriptWithTrailingSystemItem(),
      baselineFor: () => 'baseline',
    });
    const messages = mock(async () => transcriptWithTrailingSystemItem());
    const quota = createSyntheticQuotaCoordinator({
      terminalGate: gate,
      callerWaitTimeoutMs: 50,
      hardTransportTimeoutMs: 100,
    });
    try {
      // No `verifiedEvidence`: the coordinator must verify against the real
      // transcript. A trailing system item used to fail that verification,
      // leaving `handled: false` for the caller to publish completed.
      const outcome = await quota.handleTaskQuotaIncident({
        taskID: 'child-quota',
        text: quotaText,
        client: { session: { messages } },
        directory: '/tmp',
        backgroundJobBoard: board,
      });
      expect(outcome).toMatchObject({ handled: true, status: 'exhausted' });

      // Reconcile the gate the way an idle observation would; the held claim
      // for the quota notice must win over the completed transcript verdict.
      await flush();
      await gate.reconcile(run);
      await flush();
      expect(board.get('child-quota')).toMatchObject({
        state: 'error',
        terminalRevision: 1,
        resultSummary: quotaText,
      });
      expect(board.get('child-quota')?.state).not.toBe('completed');
      expect(run.generation).toBe(1);
    } finally {
      quota.dispose();
      gate.dispose();
    }
  });
});
