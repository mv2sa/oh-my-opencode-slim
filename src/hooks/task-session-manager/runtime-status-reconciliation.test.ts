import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';

function createReconciler(
  status: () => Promise<unknown>,
  statusTimeoutMs?: number,
  stopConfirmationGraceMs?: number,
  parentActivity?: {
    get: (
      parentSessionID: string,
    ) => { active: boolean; revision: number } | undefined;
    clear?: (parentSessionID: string, expectedRevision: number) => void;
    fallback?: (parentSessionID: string) => boolean;
  },
  sessionMessages: (request?: unknown) => Promise<unknown> = async () => ({
    data: [],
  }),
  resultProbeTimeoutMs?: number,
) {
  const board = new BackgroundJobBoard();
  const contextFilesForPrompt = mock(() => []);
  const prune = mock(() => {});
  const pendingManagedTaskIds = new Set(['child-1']);
  const reconciler = createRuntimeStatusReconciler({
    input: {
      directory: '/test/project',
      client: { session: { status, messages: sessionMessages } },
    } as never,
    backgroundJobBoard: board,
    statusTimeoutMs,
    resultProbeTimeoutMs,
    stopConfirmationGraceMs,
    getParentActivity: parentActivity?.get,
    clearParentActivityIfUnchanged: parentActivity?.clear,
    isParentFallbackInProgress: parentActivity?.fallback,
    taskContextTracker: {
      pendingManagedTaskIds,
      contextFilesForPrompt,
      prune,
    },
  });
  board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'fix reconciliation',
    now: 0,
  });
  return {
    board,
    reconciler,
    pendingManagedTaskIds,
    contextFilesForPrompt,
    prune,
  };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('Deferred promise resolver is unavailable');
      resolve(value);
    },
  };
}

describe('runtime status reconciliation', () => {
  test('keeps a runtime-busy job running', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'busy' } },
    }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
  });

  test('keeps a runtime-retrying job running without probing messages', async () => {
    const messages = mock(async () => ({ data: [] }));
    const { board, reconciler } = createReconciler(
      async () => ({ data: { 'child-1': { type: 'retry' } } }),
      undefined,
      undefined,
      undefined,
      messages,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
    expect(messages).not.toHaveBeenCalled();
  });

  test('keeps an absent runtime session provisional instead of stopping it', async () => {
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(async () => ({ data: {} }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a live session state; task termination is unconfirmed.',
    });
    expect(board.resolveReusable('parent-1', 'fix-1', 'fixer')).toBeUndefined();
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test('completes from trimmed visible text and excludes reasoning', async () => {
    const messages = mock(async () => ({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [
            { type: 'reasoning', text: 'private analysis' },
            { type: 'text', text: '  authoritative final result  ' },
          ],
        },
      ],
    }));
    const {
      board,
      reconciler,
      pendingManagedTaskIds,
      contextFilesForPrompt,
      prune,
    } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      undefined,
      undefined,
      messages,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      statusUncertain: false,
      resultSummary: 'authoritative final result',
      terminalUnreconciled: true,
    });
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith({
      path: { id: 'child-1' },
      query: { directory: '/test/project' },
    });
    expect(pendingManagedTaskIds.has('child-1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(contextFilesForPrompt).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  test('keeps an absent session running and uncertain without terminal proof', async () => {
    const messages = mock(async () => ({
      data: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'work in progress' }],
        },
      ],
    }));
    const { board, reconciler } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      undefined,
      undefined,
      messages,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a live session state; task termination is unconfirmed.',
    });
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('does not complete an absent session from an empty completed assistant turn', async () => {
    const messages = mock(async () => ({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [{ type: 'text', text: '' }],
        },
      ],
    }));
    const { board, reconciler } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      undefined,
      undefined,
      messages,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: 'reasoning-only',
      parts: [{ type: 'reasoning', text: 'private analysis' }],
    },
    {
      name: 'whitespace-only',
      parts: [{ type: 'text', text: ' \n\t ' }],
    },
  ])(
    'does not complete an absent session from a $name completed turn',
    async ({ parts }) => {
      const messages = mock(async () => ({
        data: [
          {
            info: { role: 'assistant', time: { completed: 100 } },
            parts,
          },
        ],
      }));
      const { board, reconciler } = createReconciler(
        async () => ({ data: {} }),
        undefined,
        undefined,
        undefined,
        messages,
      );

      await reconciler.reconcile();

      expect(board.get('child-1')).toMatchObject({
        state: 'running',
        statusUncertain: true,
      });
      expect(messages).toHaveBeenCalledTimes(1);
    },
  );

  test('does not complete an absent session from an error-bearing assistant turn', async () => {
    const messages = mock(async () => ({
      data: [
        {
          info: {
            role: 'assistant',
            time: { completed: 100 },
            error: { name: 'MessageAbortedError', data: {} },
          },
          parts: [{ type: 'text', text: 'partial result' }],
        },
      ],
    }));
    const { board, reconciler } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      undefined,
      undefined,
      messages,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('keeps an absent session running and uncertain when the result probe fails', async () => {
    const messages = mock(async () => {
      throw new Error('messages unavailable');
    });
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(
        async () => ({ data: {} }),
        undefined,
        undefined,
        undefined,
        messages,
      );

    await expect(reconciler.reconcile()).resolves.toBeUndefined();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a live session state; task termination is unconfirmed.',
    });
    expect(messages).toHaveBeenCalledTimes(1);
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test('bounds each missing-session probe so one hung job does not block later jobs', async () => {
    const secondProbeStarted = deferred<void>();
    const secondCompleted = deferred<void>();
    const messages = mock((request?: unknown) => {
      const taskID = (request as { path?: { id?: string } })?.path?.id;
      if (taskID === 'child-1') return new Promise<unknown>(() => {});
      secondProbeStarted.resolve(undefined);
      return Promise.resolve({
        data: [
          {
            info: { role: 'assistant', time: { completed: 100 } },
            parts: [{ type: 'text', text: 'second job completed' }],
          },
        ],
      });
    });
    const { board, reconciler } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      undefined,
      undefined,
      messages,
      20,
    );
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'second missing job',
      now: 0,
    });
    board.addTerminalStateListener((taskID) => {
      if (taskID === 'child-2') secondCompleted.resolve(undefined);
    });

    let reconciliationFinished = false;
    const reconciliation = reconciler.reconcile().then(() => {
      reconciliationFinished = true;
    });
    await secondProbeStarted.promise;
    await secondCompleted.promise;

    expect(messages).toHaveBeenCalledTimes(2);
    expect(reconciliationFinished).toBe(false);
    expect(board.get('child-2')).toMatchObject({
      state: 'completed',
      resultSummary: 'second job completed',
    });

    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('ignores a completed turn older than the relaunched run boundary', async () => {
    const messages = mock(async () => ({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [{ type: 'text', text: 'generation one result' }],
        },
      ],
    }));
    const { board, reconciler } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      undefined,
      undefined,
      messages,
    );
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'generation two',
      now: 200,
    });

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      generation: 2,
      runStartedAt: 200,
      resultSummary: undefined,
    });
    expect(messages).toHaveBeenCalledTimes(1);
  });

  test('ignores terminal proof older than a same-generation busy observation during the probe', async () => {
    const response = deferred<unknown>();
    const probeStarted = deferred<void>();
    const messages = mock(() => {
      probeStarted.resolve(undefined);
      return response.promise;
    });
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(
        async () => ({ data: {} }),
        undefined,
        undefined,
        undefined,
        messages,
      );

    const reconciliation = reconciler.reconcile();
    await probeStarted.promise;
    const generation = board.get('child-1')?.generation;
    board.markRunningFromLiveSession('child-1', 200, generation);
    response.resolve({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [{ type: 'text', text: 'older terminal result' }],
        },
      ],
    });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      generation,
      lastLiveBusyAt: 200,
      resultSummary: undefined,
    });
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test('ignores a terminal result when the generation changes during the probe', async () => {
    const response = deferred<unknown>();
    const probeStarted = deferred<void>();
    const messages = mock(() => {
      probeStarted.resolve(undefined);
      return response.promise;
    });
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(
        async () => ({ data: {} }),
        undefined,
        undefined,
        undefined,
        messages,
      );

    const reconciliation = reconciler.reconcile();
    await probeStarted.promise;
    expect(messages).toHaveBeenCalledTimes(1);
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'relaunched while result probe awaited',
      now: 1,
    });
    response.resolve({
      data: [
        {
          info: { role: 'assistant', time: { completed: 100 } },
          parts: [{ type: 'text', text: 'stale generation result' }],
        },
      ],
    });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      generation: 2,
      description: 'relaunched while result probe awaited',
      resultSummary: undefined,
    });
    expect(contextFilesForPrompt).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  test('repeated absence never starts or advances stop confirmation', async () => {
    const { board, reconciler } = createReconciler(
      async () => ({ data: {} }),
      undefined,
      0,
    );

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();
  });

  test.each(['busy', 'retry'] as const)(
    'parent %s blocks child stop confirmation',
    async (parentStatus) => {
      const { board, reconciler } = createReconciler(
        async () => ({
          data: {
            'child-1': { type: 'idle' },
            'parent-1': { type: parentStatus },
          },
        }),
        undefined,
        0,
      );
      const listener = mock(() => {});
      board.addTerminalStateListener(listener);

      await reconciler.reconcile();
      await reconciler.reconcile();

      expect(board.get('child-1')).toMatchObject({
        state: 'running',
        lastStatusError:
          'Parent session is active; terminal task delivery is pending.',
      });
      expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    },
  );

  test('parent activity resets the clock and requires fresh idle grace', async () => {
    let parentStatus: 'busy' | 'idle' = 'idle';
    const { board, reconciler } = createReconciler(
      async () => ({
        data: {
          'child-1': { type: 'idle' },
          'parent-1': { type: parentStatus },
        },
      }),
      undefined,
      0,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();

    parentStatus = 'busy';
    await reconciler.reconcile();
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();

    parentStatus = 'idle';
    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('successful snapshot releases stale local parent activity', async () => {
    let activity = { active: true, revision: 1 };
    const clear = mock((_parentSessionID: string, expectedRevision: number) => {
      if (activity.revision === expectedRevision) {
        activity = { active: false, revision: activity.revision + 1 };
      }
    });
    const { board, reconciler } = createReconciler(
      async () => ({ data: { 'child-1': { type: 'idle' } } }),
      undefined,
      0,
      { get: () => activity, clear },
    );

    await reconciler.reconcile();
    expect(clear).toHaveBeenCalledWith('parent-1', 1);
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'stopped' });
  });

  test('parent activity beginning during status lookup blocks stale snapshot', async () => {
    const response = deferred<unknown>();
    let activity = { active: false, revision: 1 };
    const { board, reconciler } = createReconciler(
      () => response.promise,
      undefined,
      0,
      { get: () => activity },
    );

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    activity = { active: true, revision: 2 };
    response.resolve({ data: { 'child-1': { type: 'idle' } } });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      lastStatusError:
        'Parent session is active; terminal task delivery is pending.',
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();
  });

  test('new local busy overrides explicit stale parent idle snapshot', async () => {
    const response = deferred<unknown>();
    let activity = { active: false, revision: 1 };
    const { board, reconciler } = createReconciler(
      () => response.promise,
      undefined,
      0,
      { get: () => activity },
    );

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    activity = { active: true, revision: 2 };
    response.resolve({
      data: {
        'child-1': { type: 'idle' },
        'parent-1': { type: 'idle' },
      },
    });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      lastStatusError:
        'Parent session is active; terminal task delivery is pending.',
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();
  });

  test('new local idle overrides explicit stale parent busy snapshot', async () => {
    const response = deferred<unknown>();
    let activity = { active: true, revision: 1 };
    const { board, reconciler } = createReconciler(
      () => response.promise,
      undefined,
      0,
      { get: () => activity },
    );

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    activity = { active: false, revision: 2 };
    response.resolve({
      data: {
        'child-1': { type: 'idle' },
        'parent-1': { type: 'busy' },
      },
    });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();
  });

  test('fallback keeps unchanged local parent activity authoritative', async () => {
    const activity = { active: true, revision: 1 };
    const clear = mock(() => {});
    const { board, reconciler } = createReconciler(
      async () => ({ data: { 'child-1': { type: 'idle' } } }),
      undefined,
      0,
      { get: () => activity, clear, fallback: () => true },
    );

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(clear).not.toHaveBeenCalled();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      lastStatusError:
        'Parent session is active; terminal task delivery is pending.',
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeUndefined();
  });

  test('does not let idle runtime observation win over a late completion', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'idle' } },
    }));
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });

    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'late result',
    });

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      resultSummary: 'late result',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('clears provisional uncertainty when a missing session becomes busy', async () => {
    let liveStatus: unknown = { data: {} };
    const { board, reconciler } = createReconciler(async () => liveStatus);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });

    liveStatus = { data: { 'child-1': { type: 'busy' } } };
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
    });
  });

  test('keeps the board running but explicitly uncertain when lookup fails', async () => {
    const { board, reconciler } = createReconciler(async () => {
      throw new Error('server restarting');
    });

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'Runtime status lookup failed: server restarting',
    });
  });

  test('marks malformed runtime status entries uncertain rather than stopped', async () => {
    const { board, reconciler } = createReconciler(async () => ({
      data: { 'child-1': { type: 'suspended' } },
    }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status response did not contain a recognized session state.',
    });
  });

  test.each([
    { type: 'idle' },
    { type: 'suspended' },
    { status: { type: 'busy' } },
  ])('marks unsupported status wrapper %j uncertain', async (data) => {
    const { board, reconciler } = createReconciler(async () => ({ data }));

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
  });

  test('turns a hung status lookup into uncertainty instead of stalling', async () => {
    const { board, reconciler } = createReconciler(
      () => new Promise(() => {}),
      1,
    );

    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError:
        'Runtime status lookup failed: Session status lookup timed out',
    });
  });

  test('does not stop a job that received busy while status lookup was in flight', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.markRunningFromLiveSession('child-1');
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('serializes overlapping reconciliation and observes jobs added in-flight', async () => {
    const firstResponse = deferred<unknown>();
    let lookupCount = 0;
    const status = mock(() => {
      lookupCount += 1;
      if (lookupCount === 1) return firstResponse.promise;
      return Promise.resolve({
        data: {
          'child-1': { type: 'busy' },
          'child-2': { type: 'idle' },
        },
      });
    });
    const { board, reconciler } = createReconciler(status);

    const firstReconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'second reconciliation job',
      now: 0,
    });
    const secondReconciliation = reconciler.reconcile();

    expect(status).toHaveBeenCalledTimes(1);
    firstResponse.resolve({ data: { 'child-1': { type: 'busy' } } });
    await Promise.all([firstReconciliation, secondReconciliation]);

    expect(status).toHaveBeenCalledTimes(2);
    expect(board.get('child-2')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    reconciler.dispose();
  });

  test('does not apply an old status response to a relaunched generation', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'relaunched fix',
      now: 1,
    });
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      description: 'relaunched fix',
      generation: 2,
    });
  });

  test('idle then busy inside grace remains running with no terminal listener', async () => {
    let liveStatus: unknown = { data: { 'child-1': { type: 'idle' } } };
    const { board, reconciler } = createReconciler(
      async () => liveStatus,
      undefined,
      60_000,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(listener).not.toHaveBeenCalled();

    liveStatus = { data: { 'child-1': { type: 'busy' } } };
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: false,
      stopConfirmationStartedAt: undefined,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test('repeated idle beyond confirmation grace becomes stopped exactly once', async () => {
    const { board, reconciler, contextFilesForPrompt, prune } =
      createReconciler(
        async () => ({ data: { 'child-1': { type: 'idle' } } }),
        undefined,
        0,
      );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(listener).not.toHaveBeenCalled();

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(contextFilesForPrompt).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);

    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'stopped' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a busy observation resets pending stop confirmation', async () => {
    let liveStatus: unknown = { data: { 'child-1': { type: 'idle' } } };
    const { board, reconciler } = createReconciler(
      async () => liveStatus,
      undefined,
      0,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();

    liveStatus = { data: { 'child-1': { type: 'busy' } } };
    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      stopConfirmationStartedAt: undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    liveStatus = { data: { 'child-1': { type: 'idle' } } };
    await reconciler.reconcile();
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('status lookup failure does not confirm a stop or wake the parent', async () => {
    let liveStatus: () => Promise<unknown> = async () => ({
      data: { 'child-1': { type: 'idle' } },
    });
    const { board, reconciler } = createReconciler(
      () => liveStatus(),
      undefined,
      0,
    );
    const listener = mock(() => {});
    board.addTerminalStateListener(listener);

    await reconciler.reconcile();
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();

    liveStatus = async () => {
      throw new Error('server restarting');
    };
    await reconciler.reconcile();

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      statusUncertain: true,
      lastStatusError: 'Runtime status lookup failed: server restarting',
    });
    expect(board.get('child-1')?.stopConfirmationStartedAt).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
  });

  test('does not let stale busy revive a confirmed stopped job after terminal wake', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    const generation = board.get('child-1')?.generation;
    board.markStopped('child-1', 'no result', 150, generation, 150);
    board.markReconciled('child-1', 160);

    board.markRunningFromLiveSession('child-1', 200, generation);

    expect(board.get('child-1')).toMatchObject({
      state: 'stopped',
      terminalUnreconciled: false,
      lastLiveBusyAt: 200,
    });
  });

  test('later live busy can still revive an unreconciled stopped job', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    const generation = board.get('child-1')?.generation;
    board.markStopped('child-1', 'no result', 150, generation, 150);

    board.markRunningFromLiveSession('child-1', 200, generation);

    expect(board.get('child-1')).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      resultSummary: undefined,
    });
  });

  test('keeps a timed-out job recoverable through repeated busy observations', () => {
    const { board } = createReconciler(async () => ({ data: {} }));
    board.updateStatus({
      taskID: 'child-1',
      state: 'running',
      timedOut: true,
    });

    board.markRunningFromLiveSession('child-1', 1);
    board.markRunningFromLiveSession('child-1', 2);

    expect(
      board.resolveRecoverable('parent-1', 'fix-1', 'fixer'),
    ).toBeDefined();
  });

  test('does not mutate after disposal while a lookup is in flight', async () => {
    const response = deferred<unknown>();
    const { board, reconciler } = createReconciler(() => response.promise);

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    reconciler.dispose();
    response.resolve({ data: {} });
    await reconciliation;

    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });
});
