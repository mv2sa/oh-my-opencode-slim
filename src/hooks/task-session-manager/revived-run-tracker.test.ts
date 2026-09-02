import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { CooldownRegistry } from '../foreground-fallback/cooldown-registry';
import { ForegroundFallbackManager } from '../foreground-fallback/index';
import { createSyntheticQuotaCoordinator } from '../foreground-fallback/synthetic-quota';
import { createRevivedRunTracker } from './revived-run-tracker';

let cooldownTempDir: string | undefined;

function createTestCooldownRegistry(): CooldownRegistry {
  cooldownTempDir ??= fs.mkdtempSync(
    path.join(os.tmpdir(), 'omos-cooldown-revived-test-'),
  );
  return new CooldownRegistry(
    path.join(cooldownTempDir, `${randomUUID()}.json`),
  );
}

afterEach(() => {
  if (!cooldownTempDir) return;
  for (const entry of fs.readdirSync(cooldownTempDir)) {
    fs.rmSync(path.join(cooldownTempDir, entry), {
      recursive: true,
      force: true,
    });
  }
});

afterAll(() => {
  if (cooldownTempDir) {
    fs.rmSync(cooldownTempDir, { recursive: true, force: true });
    cooldownTempDir = undefined;
  }
});

function createHarness(
  messages: () => unknown,
  prompt = mock(async () => ({})),
  assertBound = false,
  fallbackManager?: ForegroundFallbackManager,
) {
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    background: true,
  });
  board.updateStatus({
    taskID: 'ses_child',
    state: 'completed',
    resultSummary: 'old result',
  });
  board.markReconciled('ses_child');
  const lease = board.acquireRelaunchLease('ses_child', 1);
  if (!lease) throw new Error('missing relaunch lease');
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'explorer',
    description: 'inspect the change',
    background: true,
    relaunchLease: lease,
  });
  board.releaseLease(lease);
  let session: {
    messages: ReturnType<typeof mock>;
    promptAsync: ReturnType<typeof mock>;
  };
  session = {
    messages: mock(function (this: unknown) {
      if (assertBound) expect(this).toBe(session);
      return messages();
    }),
    promptAsync: mock(function (this: unknown, ..._args: unknown[]) {
      if (assertBound) expect(this).toBe(session);
      return prompt();
    }),
  };
  const input = {
    directory: '/test',
    client: {
      session,
    },
  } as never;
  const settled = mock(() => {});
  const pruned = mock(() => {});
  const tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    notificationRetryDelayMs: 0,
    onSettled: settled,
    pruneContext: pruned,
    fallbackManager,
    syntheticQuotaCoordinator: fallbackManager
      ? createSyntheticQuotaCoordinator()
      : undefined,
  });
  return {
    board,
    run,
    tracker,
    prompt: session.promptAsync,
    settled,
    pruned,
  };
}

describe('revived run tracker', () => {
  test('publishes a newer completed assistant turn and notifies the parent', async () => {
    let probe = false;
    const harness = createHarness(
      () =>
        probe
          ? {
              data: [
                { info: { id: 'baseline', role: 'user' }, parts: [] },
                {
                  info: {
                    id: 'assistant-1',
                    role: 'assistant',
                    time: { completed: 2 },
                  },
                  parts: [{ type: 'text', text: 'new result' }],
                },
              ],
            }
          : { data: [{ info: { id: 'baseline', role: 'user' }, parts: [] }] },
      undefined,
      true,
    );
    const baseline = await harness.tracker.captureBaseline('ses_child');
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: baseline,
      description: 'inspect the change',
    });
    probe = true;
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);

    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: 'new result',
    });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'parent' },
      body: {
        agent: 'orchestrator',
        parts: [{ type: 'text', synthetic: true }],
      },
    });
  });

  test('keeps a non-terminal idle turn running and rejects historical output', async () => {
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-old',
            role: 'assistant',
            time: { completed: 1 },
          },
          parts: [{ type: 'text', text: 'old result' }],
        },
        {
          info: { id: 'assistant-new', role: 'assistant' },
          parts: [{ type: 'text', text: 'partial' }],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);

    expect(harness.board.get('ses_child')).toMatchObject({ state: 'running' });
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('publishes an explicitly empty completed turn but rejects tool-call finishes', async () => {
    let toolCallFinish = true;
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-new',
            role: 'assistant',
            time: { completed: 2 },
            finish: toolCallFinish ? 'tool-calls' : 'stop',
          },
          parts: [],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    expect(
      await harness.tracker.probe(harness.run.taskID, harness.run.generation),
    ).toBe(false);
    expect(harness.board.get('ses_child')?.state).toBe('running');

    toolCallFinish = false;
    expect(
      await harness.tracker.probe(harness.run.taskID, harness.run.generation),
    ).toBe(true);
    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: '',
    });
  });

  test('publishes immediate child errors and ignores stale generations', async () => {
    const harness = createHarness(() => ({
      data: [
        { info: { id: 'baseline', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-error',
            role: 'assistant',
            time: { completed: 3 },
            error: { message: 'provider failed' },
          },
          parts: [],
        },
      ],
    }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    const staleLease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!staleLease) throw new Error('missing stale lease');
    const newer = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: staleLease,
    });
    harness.board.releaseLease(staleLease);
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    expect(harness.board.get('ses_child')).toMatchObject({
      generation: newer.generation,
      state: 'running',
    });
  });

  test('retries parent notification without changing the terminal board state', async () => {
    let attempts = 0;
    const prompt = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('parent unavailable');
      return {};
    });
    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: {
              id: 'assistant-1',
              role: 'assistant',
              time: { completed: 2 },
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      }),
      prompt,
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.board.markReconciled(harness.run.taskID);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.board.get('ses_child')?.state).toBe('reconciled');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  test('holds the terminal notification lease while parent transport is active', async () => {
    const harness = createHarness(() => ({ data: [] }));
    let relaunchLease: unknown;
    harness.prompt.mockImplementation(async () => {
      relaunchLease = harness.board.acquireRelaunchLease(
        harness.run.taskID,
        harness.run.generation,
      );
      return {};
    });
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(relaunchLease).toBeUndefined();
    expect(harness.board.get(harness.run.taskID)).toMatchObject({
      generation: harness.run.generation,
      state: 'completed',
    });
  });

  test('forwards coordinator terminal outcomes to one parent notification', async () => {
    const harness = createHarness(() => ({ data: [] }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'error',
      resultSummary: 'timeout',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('discards a retry when the task generation is relaunched', async () => {
    const prompt = mock(async () => {
      throw new Error('parent unavailable');
    });
    const harness = createHarness(() => ({ data: [] }), prompt);
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const terminal = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'completed',
      resultSummary: 'done',
    });
    if (!terminal) throw new Error('missing terminal record');
    harness.tracker.onTerminal(terminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!lease) throw new Error('missing relaunch lease');
    const newer = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: lease,
    });
    harness.board.releaseLease(lease);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(
      harness.tracker.isTracked(harness.run.taskID, newer.generation),
    ).toBe(false);
  });

  test('clears cancelled runs and pending context without notifying the parent', () => {
    const harness = createHarness(() => ({ data: [] }));
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      description: 'inspect the change',
    });
    const cancelled = harness.board.updateStatus({
      taskID: harness.run.taskID,
      expectedGeneration: harness.run.generation,
      state: 'cancelled',
      resultSummary: 'cancelled by user',
    });
    if (!cancelled) throw new Error('missing cancelled record');
    harness.tracker.onTerminal(cancelled);

    expect(
      harness.tracker.isTracked(harness.run.taskID, harness.run.generation),
    ).toBe(false);
    expect(harness.settled).toHaveBeenCalledTimes(1);
    expect(harness.pruned).toHaveBeenCalledTimes(1);
    expect(harness.prompt).not.toHaveBeenCalled();

    const lease = harness.board.acquireRelaunchLease(
      harness.run.taskID,
      harness.run.generation,
    );
    if (!lease) throw new Error('missing revive lease');
    const next = harness.board.registerLaunch({
      taskID: harness.run.taskID,
      parentSessionID: 'parent',
      agent: 'explorer',
      background: true,
      relaunchLease: lease,
    });
    harness.board.releaseLease(lease);
    harness.tracker.register({
      taskID: next.taskID,
      generation: next.generation,
      parentSessionID: 'parent',
      description: 'second revive',
    });
    harness.tracker.onTerminal(cancelled);
    expect(harness.tracker.isTracked(next.taskID, next.generation)).toBe(true);
  });

  test('handles Antigravity synthetic quota turn by launching fallback continuation', async () => {
    const quotaText =
      'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';
    const registry = createTestCooldownRegistry();
    const fallbackMgr = new ForegroundFallbackManager(
      {
        explorer: [
          'google/antigravity-gemini-3-flash',
          'google/antigravity-gemini-3.7-flash',
        ],
      },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      registry,
    );

    let probeCount = 0;
    const harness = createHarness(
      () => {
        probeCount++;
        if (probeCount === 1) {
          return {
            data: [
              { info: { id: 'baseline', role: 'user' }, parts: [] },
              {
                info: {
                  id: 'assistant-quota',
                  role: 'assistant',
                  providerID: 'google',
                  modelID: 'antigravity-gemini-3-flash',
                  finish: 'stop',
                  tokens: { input: 0, output: 33 },
                  time: { completed: 1 },
                },
                parts: [{ type: 'text', text: quotaText }],
              },
            ],
          };
        }
        return {
          data: [
            { info: { id: 'baseline', role: 'user' }, parts: [] },
            {
              info: {
                id: 'assistant-quota',
                role: 'assistant',
                providerID: 'google',
                modelID: 'antigravity-gemini-3-flash',
                finish: 'stop',
                tokens: { input: 0, output: 33 },
                time: { completed: 1 },
              },
              parts: [{ type: 'text', text: quotaText }],
            },
            {
              info: {
                id: 'assistant-success',
                role: 'assistant',
                providerID: 'google',
                modelID: 'antigravity-gemini-3.7-flash',
                finish: 'stop',
                tokens: { input: 250, output: 50 },
                time: { completed: 2 },
              },
              parts: [{ type: 'text', text: 'successful explorer analysis' }],
            },
          ],
        };
      },
      undefined,
      false,
      fallbackMgr,
    );

    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    // Probe 1: Sees synthetic quota -> cools down failed model, launches continuation, returns false
    const probe1Result = await harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    expect(probe1Result).toBe(false);
    expect(registry.isDead('google/antigravity-gemini-3-flash')).toBe(true);
    expect(harness.board.get('ses_child')?.state).toBe('running');

    // PromptAsync was called for the continuation on the child session
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'ses_child' },
      body: {
        model: {
          providerID: 'google',
          modelID: 'antigravity-gemini-3.7-flash',
        },
      },
    });

    // Probe 2: Sees replacement success -> marks completed, delivers terminal result to parent once
    const probe2Result = await harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    expect(probe2Result).toBe(true);
    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'completed',
      resultSummary: 'successful explorer analysis',
    });
    // PromptAsync called again to notify the parent
    expect(harness.prompt).toHaveBeenCalledTimes(2);
    expect(harness.prompt.mock.calls[1]?.[0]).toMatchObject({
      path: { id: 'parent' },
      body: {
        agent: 'orchestrator',
        parts: [{ type: 'text', synthetic: true }],
      },
    });
  });

  test('marks error and notifies parent when chain is exhausted on Antigravity quota', async () => {
    const quotaText =
      'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';
    const registry = createTestCooldownRegistry();
    const fallbackMgr = new ForegroundFallbackManager(
      {
        explorer: ['google/antigravity-gemini-3-flash'], // Single-model chain
      },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      registry,
    );

    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: {
              id: 'assistant-quota',
              role: 'assistant',
              providerID: 'google',
              modelID: 'antigravity-gemini-3-flash',
              finish: 'stop',
              tokens: { input: 0, output: 33 },
              time: { completed: 1 },
            },
            parts: [{ type: 'text', text: quotaText }],
          },
        ],
      }),
      undefined,
      false,
      fallbackMgr,
    );

    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    const probeResult = await harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    expect(probeResult).toBe(true);
    expect(harness.board.get('ses_child')).toMatchObject({
      state: 'error',
    });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'parent' },
      body: {
        agent: 'orchestrator',
        parts: [{ type: 'text', synthetic: true }],
      },
    });
  });

  test('production registration sets baselineMessageID to failed message ID and avoids immediate re-cascade', async () => {
    const quotaText =
      'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';
    const registry = createTestCooldownRegistry();
    const fallbackMgr = new ForegroundFallbackManager(
      {
        explorer: [
          'google/antigravity-gemini-3-flash',
          'google/antigravity-gemini-3.7-flash',
        ],
      },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      registry,
    );

    // Initial state: child session has user prompt and failed assistant turn 'failed-msg-1'
    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'user-prompt-1', role: 'user' }, parts: [] },
          {
            info: {
              id: 'failed-msg-1',
              role: 'assistant',
              providerID: 'google',
              modelID: 'antigravity-gemini-3-flash',
              finish: 'stop',
              tokens: { input: 0, output: 33 },
              time: { completed: 1 },
            },
            parts: [{ type: 'text', text: quotaText }],
          },
        ],
      }),
      undefined,
      false,
      fallbackMgr,
    );

    // Production registration sets baselineMessageID to exact failed assistant message ID
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'failed-msg-1',
      description: 'inspect code',
    });

    // Probing while continuation is still in flight:
    // lastIndex is failed-msg-1 which equals baselineIndex -> probe returns false without re-triggering prompt
    const probeInFlight = await harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    expect(probeInFlight).toBe(false);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.board.get('ses_child')?.state).toBe('running');
  });

  test('probe does not prompt continuation if job cancellation was requested', async () => {
    const quotaText =
      'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';
    const registry = createTestCooldownRegistry();
    const fallbackMgr = new ForegroundFallbackManager(
      {
        explorer: [
          'google/antigravity-gemini-3-flash',
          'google/antigravity-gemini-3.7-flash',
        ],
      },
      true,
      { directory: '/test' } as any,
      1,
      undefined,
      registry,
    );

    const harness = createHarness(
      () => ({
        data: [
          { info: { id: 'baseline', role: 'user' }, parts: [] },
          {
            info: {
              id: 'assistant-quota',
              role: 'assistant',
              providerID: 'google',
              modelID: 'antigravity-gemini-3-flash',
              finish: 'stop',
              tokens: { input: 0, output: 33 },
              time: { completed: 1 },
            },
            parts: [{ type: 'text', text: quotaText }],
          },
        ],
      }),
      undefined,
      false,
      fallbackMgr,
    );

    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    // Mark cancellation requested on board
    const job = harness.board.get(harness.run.taskID);
    if (job) job.cancellationRequested = true;

    const probeResult = await harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    expect(probeResult).toBe(false);
    expect(harness.prompt).not.toHaveBeenCalled();
  });
});
