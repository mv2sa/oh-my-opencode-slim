import { afterEach, describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../../utils/background-job-terminal-gate';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils/internal-initiator';
import { createRevivedRunTracker } from './revived-run-tracker';

const gates: BackgroundJobTerminalGate[] = [];

function createHarness(
  messages: () => unknown,
  prompt = mock(async () => ({})),
  assertBound = false,
  options: {
    stabilizationProbeDelayMs?: number;
    handoffExpiryMs?: number;
    resolveSelection?: (sessionID: string) => Promise<{
      agent?: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      provenance: 'host-persisted' | 'observed-external' | 'unknown';
    }>;
  } = {},
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
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    readRuntime: async (_run, readStartedAt) => ({
      kind: 'quiescent',
      origin: 'test-host',
      readStartedAt,
    }),
    baselineFor: (taskID, generation) =>
      tracker.baselineFor(taskID, generation),
    observationRevisionFor: (taskID, generation) =>
      tracker.revisionFor(taskID, generation),
    isObservationPending: (taskID, generation) =>
      tracker.isObservationPending(taskID, generation),
    graceMs: options.stabilizationProbeDelayMs ?? 150,
  });
  gates.push(gate);
  const tracker = createRevivedRunTracker({
    input,
    terminalGate: gate,
    backgroundJobBoard: board,
    notificationRetryDelayMs: 0,
    ...options,
    onSettled: settled,
    pruneContext: pruned,
  });
  return {
    board,
    run,
    tracker,
    gate,
    prompt: session.promptAsync,
    settled,
    pruned,
  };
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** notifyParent is fire-and-forget from probe(); drain its microtasks. */
async function flushNotify(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Toggle-able transcript: baseline only until `probe` flips true, then a
 * completed assistant turn after the baseline. */
function completedTranscript(
  probe: () => boolean,
  text = 'new result',
): () => unknown {
  return () =>
    probe()
      ? {
          data: [
            { info: { id: 'baseline', role: 'user' }, parts: [] },
            {
              info: {
                id: 'assistant-1',
                role: 'assistant',
                time: { completed: 2 },
              },
              parts: [{ type: 'text', text }],
            },
          ],
        }
      : { data: [{ info: { id: 'baseline', role: 'user' }, parts: [] }] };
}

afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe('revived run tracker', () => {
  test('publishes a newer completed assistant turn and notifies the parent', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
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
        // The notification part must carry the internal-initiator metadata
        // (and marker suffix) so the v2 client-shim routes it through
        // session.synthetic — a bare `synthetic: true` part drops its flag
        // in the flat prompt translation and regresses into a visible
        // user message + external-user-activity classification (#1157).
        parts: [
          {
            type: 'text',
            synthetic: true,
            metadata: { 'oh-my-opencode-slim.internalInitiator': true },
          },
        ],
      },
    });
    const notifiedText = (
      harness.prompt.mock.calls[0]?.[0] as
        | { body?: { parts?: Array<{ text?: string }> } }
        | undefined
    )?.body?.parts?.[0]?.text;
    expect(notifiedText).toContain('<task ');
    expect(notifiedText).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    expect(
      (harness.prompt.mock.calls[0]?.[0] as { delivery?: string } | undefined)
        ?.delivery,
    ).toBe('queue');
  });

  test('notifies the parent in its current selection instead of hardcoded orchestrator', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
      {
        resolveSelection: async () => ({
          agent: 'plan',
          model: { providerID: 'test', modelID: 'plan-model' },
          provenance: 'host-persisted',
        }),
      },
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
    await flushNotify();

    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      delivery: 'queue',
      body: {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'plan-model' },
      },
    });
  });

  test('forwards the resolved variant as modelVariant on the notification', async () => {
    let probe = false;
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
      {
        resolveSelection: async () => ({
          agent: 'plan',
          model: { providerID: 'test', modelID: 'plan-model' },
          variant: 'max',
          provenance: 'host-persisted',
        }),
      },
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
    await flushNotify();

    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      delivery: 'queue',
      modelVariant: 'max',
      body: {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'plan-model' },
      },
    });
  });

  test('does not send after dispose during selection resolve', async () => {
    let probe = false;
    let entered = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness(
      completedTranscript(() => probe),
      undefined,
      false,
      {
        resolveSelection: async () => {
          entered = true;
          await gate;
          return { agent: 'plan', provenance: 'host-persisted' };
        },
      },
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
    const pending = harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    for (let i = 0; i < 20 && !entered; i += 1) await Promise.resolve();
    expect(entered).toBe(true);
    harness.tracker.dispose();
    release?.();
    await pending;
    expect(harness.prompt).not.toHaveBeenCalled();
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

  test('delegates inspection without maintaining a terminal policy or stabilization timer', async () => {
    const harness = createHarness(() => {
      throw new Error('tracker must not read evidence');
    });
    const inspect = mock(async () => ({
      kind: 'deferred' as const,
      record: harness.run,
    }));
    harness.gate.reconcile = inspect;
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
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        taskID: harness.run.taskID,
        generation: harness.run.generation,
      }),
      { kind: 'inspect' },
    );
    expect(harness.board.get('ses_child')?.state).toBe('running');
    expect(harness.prompt).not.toHaveBeenCalled();
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

  test('re-resolves agent and model on each notification retry', async () => {
    let attempts = 0;
    const prompt = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('parent unavailable');
      return {};
    });
    const selections = [
      {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
        provenance: 'host-persisted' as const,
      },
      {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'model-b' },
        provenance: 'host-persisted' as const,
      },
    ];
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
      false,
      {
        resolveSelection: async () =>
          selections[Math.min(attempts, selections.length - 1)] ??
          selections[0],
      },
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });
    await harness.tracker.probe(harness.run.taskID, harness.run.generation);
    await flushNotify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushNotify();

    expect(harness.prompt).toHaveBeenCalledTimes(2);
    expect(harness.prompt.mock.calls[0]?.[0]).toMatchObject({
      body: {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
      },
    });
    expect(harness.prompt.mock.calls[1]?.[0]).toMatchObject({
      body: {
        agent: 'plan',
        model: { providerID: 'test', modelID: 'model-b' },
      },
    });
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

  test('retains cancelled ownership for repairs, clearing pending context without notifying', () => {
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
    ).toBe(true);
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

  // Controlled clock for the transport-timeout scenarios below: capture
  // timer registrations so the 10s transport timeout can be fired without
  // waiting, and track clearTimeout so a cancelled retry is provable.
  function installCapturedTimers() {
    const timers = new Map<number, { delay: number; callback: () => void }>();
    const cleared = new Set<number>();
    let nextId = 0;
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = ++nextId;
      timers.set(id, { delay, callback });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      cleared.add(id);
      timers.delete(id);
    }) as typeof clearTimeout;
    const settle = async () => {
      for (let i = 0; i < 15; i += 1) await Promise.resolve();
    };
    const fire = (delay: number) => {
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.delay !== delay) continue;
        timers.delete(id);
        timer.callback();
        return id;
      }
      return undefined;
    };
    const soleSurviving = (delay: number) =>
      [...timers.values()].find((timer) => timer.delay === delay);
    return { timers, cleared, settle, fire, soleSurviving };
  }

  test('late transport success after timeout marks sent and cancels the retry', async () => {
    const clock = installCapturedTimers();
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const prompt = mock(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );
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
    await clock.settle();
    expect(harness.prompt).toHaveBeenCalledTimes(1);

    // Local 10s transport timeout fires while promptAsync is still pending.
    clock.fire(10_000);
    await clock.settle();
    const retryTimer = clock.soleSurviving(0);
    expect(retryTimer).toBeDefined();

    // The original transport settles successfully AFTER the timeout.
    resolvePrompt?.({});
    await clock.settle();

    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect([...clock.timers.values()]).not.toContain(retryTimer);
  });

  test('late transport failure after timeout keeps the retry path', async () => {
    const clock = installCapturedTimers();
    let rejectPrompt: ((reason: unknown) => void) | undefined;
    const prompt = mock(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
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
    await clock.settle();

    clock.fire(10_000);
    await clock.settle();
    expect(clock.soleSurviving(0)).toBeDefined();

    // The original transport fails after the timeout: the retry must stay
    // armed and deliver the notification on the next attempt.
    rejectPrompt?.(new Error('host unavailable'));
    await clock.settle();
    expect(clock.soleSurviving(0)).toBeDefined();

    clock.fire(0);
    await clock.settle();
    expect(harness.prompt).toHaveBeenCalledTimes(2);
  });

  test('late transport error envelope after timeout is not delivery', async () => {
    const clock = installCapturedTimers();
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const prompt = mock(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );
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
    await clock.settle();
    expect(harness.prompt).toHaveBeenCalledTimes(1);

    clock.fire(10_000);
    await clock.settle();

    // The transport PROMISE resolves, but with a host error envelope —
    // a resolved SDK call without throwOnError is not a delivered
    // notification. The retry must stay armed.
    resolvePrompt?.({ error: { message: 'host rejected' } });
    await clock.settle();
    expect(clock.soleSurviving(0)).toBeDefined();

    clock.fire(0);
    await clock.settle();
    expect(harness.prompt).toHaveBeenCalledTimes(2);
  });

  test('late success while a retry waits on selection prevents a second send', async () => {
    const clock = installCapturedTimers();
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const prompt = mock(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    // First selection resolves immediately (attempt 1 sends); the second
    // call (retry) blocks until released, modeling a slow host read.
    let selectionCalls = 0;
    let releaseSecondSelection: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecondSelection = resolve;
    });
    const harness = createHarness(() => ({ data: [] }), prompt, false, {
      resolveSelection: async () => {
        selectionCalls += 1;
        if (selectionCalls >= 2) await secondGate;
        return { agent: 'plan', provenance: 'host-persisted' };
      },
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
    await clock.settle();
    expect(harness.prompt).toHaveBeenCalledTimes(1);

    // Local timeout: retry armed and fired; the retry passes its entry
    // guard (sent is still false) and parks on the selection await.
    clock.fire(10_000);
    await clock.settle();
    clock.fire(0);
    await clock.settle();
    expect(selectionCalls).toBeGreaterThanOrEqual(2);

    // The ORIGINAL transport settles successfully after everything: the
    // notification is delivered, sent is marked, and the parked retry
    // must not acquire the lease or send again.
    resolvePrompt?.({});
    await clock.settle();
    releaseSecondSelection?.();
    await clock.settle();
    await clock.settle();

    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('a pending probe replaced by another same-generation registration does not terminalize', async () => {
    let resolveMessages: ((value: unknown) => void) | undefined;
    const harness = createHarness(
      () =>
        new Promise((resolve) => {
          resolveMessages = resolve;
        }),
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline-1',
      description: 'first fallback',
    });
    const firstProbe = harness.tracker.probe(
      harness.run.taskID,
      harness.run.generation,
    );
    harness.tracker.register({
      taskID: harness.run.taskID,
      generation: harness.run.generation,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline-2',
      description: 'second fallback',
    });
    resolveMessages?.({
      data: [
        { info: { id: 'baseline-1', role: 'user' }, parts: [] },
        {
          info: {
            id: 'assistant-1',
            role: 'assistant',
            time: { completed: 2 },
          },
          parts: [{ type: 'text', text: 'stale first-run answer' }],
        },
      ],
    });
    expect(await firstProbe).toBe(false);
    expect(harness.board.get('ses_child')?.state).toBe('running');
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  test('handoff: prepare defers, admit enrolls and probes immediately', async () => {
    // A fallback re-prompt whose result is ALREADY persisted must be
    // delivered on admission — no idle event will fire again.
    const harness = createHarness(
      completedTranscript(() => true),
      undefined,
      false,
      {
        stabilizationProbeDelayMs: 0,
      },
    );
    const gen = harness.run.generation;

    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    expect(
      harness.tracker.prepareObservation({
        taskID: 'ses_child',
        generation: gen,
        parentSessionID: 'parent',
        baselineMessageID: 'baseline',
        description: 'inspect the change',
      }),
    ).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);

    expect(harness.tracker.admitObservation('ses_child', gen)).toBe(true);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);

    await flushNotify();
    expect(harness.board.get('ses_child')?.state).toBe('completed');
    expect(harness.board.get('ses_child')?.resultSummary).toBe('new result');
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('handoff: reject withdraws the preparation without enrolling', () => {
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;
    harness.tracker.prepareObservation({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    harness.tracker.rejectObservation('ses_child', gen);

    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(false);
  });

  test('handoff: promotion keeps fencing the gate and a late admit delivers without reinstalling', async () => {
    // Expiry converts the preparation into the owning run, but the
    // ADMISSION is still unresolved — the gate must stay deferred
    // (no absent→stopped while the re-prompt may yet start). The late
    // acceptance then resolves it: probe runs and the already persisted
    // result is delivered exactly once, without resetting the installed
    // owner's identity.
    let resultReady = false;
    const harness = createHarness(
      completedTranscript(() => resultReady),
      undefined,
      false,
      { handoffExpiryMs: 40, stabilizationProbeDelayMs: 0 },
    );
    const gen = harness.run.generation;

    expect(
      harness.tracker.prepareObservation({
        taskID: 'ses_child',
        generation: gen,
        parentSessionID: 'parent',
        baselineMessageID: 'baseline',
        description: 'inspect the change',
      }),
    ).toBe(true);

    // First expiry promotes; the unresolved-admission bound is a second
    // window of the same length. Assert the fenced promoted state in
    // between, then admit before that bound lifts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);
    expect(harness.board.get('ses_child')?.state).toBe('running');

    // The late acceptance resolves it and fires the delivering probe.
    resultReady = true;
    expect(harness.tracker.admitObservation('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    await flushNotify();
    expect(harness.board.get('ses_child')?.state).toBe('completed');
    expect(harness.board.get('ses_child')?.resultSummary).toBe('new result');
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  test('handoff: unresolved transport failure converts the preparation into the owner', () => {
    // A transport failure without a response does not prove refusal —
    // ownership converts instead of being dropped.
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;
    harness.tracker.prepareObservation({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    expect(harness.tracker.settleObservationUnresolved('ses_child', gen)).toBe(
      true,
    );
    // Owner installed, admission still unresolved → gate still fenced.
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);

    // A subsequent explicit host refusal releases it.
    harness.tracker.rejectObservation('ses_child', gen);
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
  });

  test('handoff: unresolved admission lifts the fence after a bound without dropping the owner', async () => {
    const harness = createHarness(
      completedTranscript(() => false),
      undefined,
      false,
      { handoffExpiryMs: 5, stabilizationProbeDelayMs: 0 },
    );
    const gen = harness.run.generation;
    harness.tracker.prepareObservation({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'inspect the change',
    });

    expect(harness.tracker.settleObservationUnresolved('ses_child', gen)).toBe(
      true,
    );
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(true);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.tracker.isObservationPending('ses_child', gen)).toBe(false);
    expect(harness.tracker.isTracked('ses_child', gen)).toBe(true);
  });

  test('handoff: prepare refuses a stale generation', () => {
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;

    expect(
      harness.tracker.prepareObservation({
        taskID: 'ses_child',
        generation: gen + 1,
        parentSessionID: 'parent',
        description: 'stale attempt',
      }),
    ).toBe(false);
    expect(harness.tracker.isObservationPending('ses_child', gen + 1)).toBe(
      false,
    );
  });

  test('revision changes on re-registration even with an identical baseline', () => {
    // Baseline value alone is not an observation identity — two
    // fallback observations can both carry undefined (or the same)
    // baseline; the monotonic revision fences them.
    const harness = createHarness(completedTranscript(() => false));
    const gen = harness.run.generation;
    harness.tracker.register({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'first',
    });
    const first = harness.tracker.revisionFor('ses_child', gen);
    expect(typeof first).toBe('number');

    harness.tracker.register({
      taskID: 'ses_child',
      generation: gen,
      parentSessionID: 'parent',
      baselineMessageID: 'baseline',
      description: 'second',
    });
    expect(harness.tracker.revisionFor('ses_child', gen)).not.toBe(first);

    // Stale generations never resolve a revision.
    expect(harness.tracker.revisionFor('ses_child', gen + 1)).toBeUndefined();
  });
});
