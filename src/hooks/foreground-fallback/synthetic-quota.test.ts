import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import type { ForegroundFallbackManager } from './index';
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

describe('synthetic quota quarantine bound', () => {
  const fallbackManager = {
    markModelCooldown: () => {},
    prepareNextModel: () => ({
      model: 'anthropic/claude-opus-4-5',
      commit: () => true,
    }),
  } as unknown as ForegroundFallbackManager;

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 1_000,
  ): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('waitFor timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  test('records when quarantine began and reports the held duration against a 2x transport bound', async () => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'child-quarantine-bound',
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
    });
    const now = { value: 1_000 };
    const quota = createSyntheticQuotaCoordinator({
      terminalGate: gate,
      callerWaitTimeoutMs: 5,
      hardTransportTimeoutMs: 20,
      now: () => now.value,
    });
    try {
      // The continuation transport never resolves, so the hard quarantine
      // deadline (20ms) is the only disposition the incident can reach.
      const outcome = await quota.handleTaskQuotaIncident({
        taskID: run.taskID,
        text: quotaText,
        verifiedEvidence: {
          model: 'google/antigravity-gemini-3-flash',
          failedMessageID: 'asst-quota',
        },
        client: { session: { promptAsync: async () => new Promise(() => {}) } },
        directory: '/tmp',
        backgroundJobBoard: board,
        fallbackManager,
      });
      expect(outcome.status).toBe('launched');
      expect(outcome.quarantineBoundMs).toBeUndefined();

      await waitFor(
        () =>
          board
            .get(run.taskID)
            ?.lastStatusError?.includes('quarantine deadline exceeded') ===
          true,
      );
      expect(board.get(run.taskID)?.state).toBe('running');

      // A duplicate observation reports how long the incident has been held
      // against the bound derived from the configured transport timeout.
      const withinBound = await quota.handleTaskQuotaIncident({
        taskID: run.taskID,
        text: quotaText,
        verifiedEvidence: {
          model: 'google/antigravity-gemini-3-flash',
          failedMessageID: 'asst-quota',
        },
        client: { session: { promptAsync: async () => new Promise(() => {}) } },
        directory: '/tmp',
        backgroundJobBoard: board,
        fallbackManager,
      });
      expect(withinBound.status).toBe('quarantined');
      expect(withinBound.quarantineHeldMs).toBe(0);
      expect(withinBound.quarantineBoundMs).toBe(40);

      // Past the bound the coordinator reports the exceeded duration; the
      // gate evidence hook turns this into the error override.
      now.value = 1_041;
      const pastBound = await quota.handleTaskQuotaIncident({
        taskID: run.taskID,
        text: quotaText,
        verifiedEvidence: {
          model: 'google/antigravity-gemini-3-flash',
          failedMessageID: 'asst-quota',
        },
        client: { session: { promptAsync: async () => new Promise(() => {}) } },
        directory: '/tmp',
        backgroundJobBoard: board,
        fallbackManager,
      });
      expect(pastBound.status).toBe('quarantined');
      expect(pastBound.quarantineHeldMs).toBe(41);
      expect(pastBound.quarantineBoundMs).toBe(40);
    } finally {
      quota.dispose();
      gate.dispose();
    }
  });
});
