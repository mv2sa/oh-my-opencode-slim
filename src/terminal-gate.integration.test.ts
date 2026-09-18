import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as hookFactories from './hooks';
import * as runtimeFactories from './hooks/task-session-manager/runtime-status-reconciliation';
import { OhMyOpenCodeLite as plugin } from './index';
import type { BackgroundJobRecord } from './utils/background-job-board';
import type { BackgroundJobCoordinator } from './utils/background-job-coordinator';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';
import * as gateFactories from './utils/background-job-terminal-gate';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type StatusResponse = { data: { child: { type: 'busy' | 'idle' } } };
const transcript = () => ({
  data: [
    {
      info: {
        id: 'answer',
        role: 'assistant',
        time: { completed: Date.now() },
        finish: 'stop',
      },
      parts: [{ type: 'text', text: 'confirmed result' }],
    },
  ],
});

async function assembly(
  onHookCreated?: (
    board: BackgroundJobCoordinator,
    gate: gateFactories.BackgroundJobTerminalGate,
  ) => void,
  setup: {
    statusTimeoutMs?: number;
    statusAvailable?: boolean;
    graceMs?: number;
  } = {},
) {
  const env = { ...process.env };
  const directory = await mkdtemp('/tmp/slim-terminal-assembly-');
  process.env.OPENCODE_CONFIG_DIR = directory;
  process.env.XDG_CONFIG_HOME = directory;
  process.env.XDG_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  await Bun.write(
    `${directory}/oh-my-opencode-slim.json`,
    JSON.stringify({
      backgroundJobs: {
        concurrency: { defaultConcurrency: 1 },
        readContextMinLines: 1,
      },
    }),
  );
  let board!: BackgroundJobCoordinator;
  let gate!: gateFactories.BackgroundJobTerminalGate;
  let taskHook!: ReturnType<typeof hookFactories.createTaskSessionManagerHook>;
  let runtime!: ReturnType<
    typeof runtimeFactories.createRuntimeStatusReconciler
  >;
  const originalRuntime = runtimeFactories.createRuntimeStatusReconciler;
  const runtimeSpy = spyOn(
    runtimeFactories,
    'createRuntimeStatusReconciler',
  ).mockImplementation((options) => {
    runtime = originalRuntime({
      ...options,
      statusTimeoutMs: setup.statusTimeoutMs ?? options.statusTimeoutMs,
    });
    return runtime;
  });
  const originalGate = gateFactories.createBackgroundJobTerminalGate;
  const gateSpy = spyOn(
    gateFactories,
    'createBackgroundJobTerminalGate',
  ).mockImplementation((options) => {
    board = options.backgroundJobBoard as BackgroundJobCoordinator;
    gate = originalGate({
      ...options,
      graceMs: setup.graceMs ?? options.graceMs,
    });
    return gate;
  });
  const originalHook = hookFactories.createTaskSessionManagerHook;
  let prune!: ReturnType<typeof spyOn>;
  const hookSpy = spyOn(
    hookFactories,
    'createTaskSessionManagerHook',
  ).mockImplementation((...args) => {
    taskHook = originalHook(...args);
    prune = spyOn(taskHook, 'pruneTaskContext');
    onHookCreated?.(board, gate);
    return taskHook;
  });
  let busy = false;
  const heldStatuses: ReturnType<typeof deferred<StatusResponse>>[] = [];
  const statusMetrics = { activeReads: 0, maxActiveReads: 0 };
  const status = mock(async (): Promise<StatusResponse> => {
    statusMetrics.maxActiveReads = Math.max(
      statusMetrics.maxActiveReads,
      ++statusMetrics.activeReads,
    );
    try {
      const held = heldStatuses.shift();
      return held
        ? await held.promise
        : { data: { child: { type: busy ? 'busy' : 'idle' } } };
    } finally {
      statusMetrics.activeReads--;
    }
  });
  const messages = mock(
    async (_args: unknown): Promise<unknown> => transcript(),
  );
  const get = mock(
    async (_args: unknown): Promise<unknown> => ({
      data: { parentID: 'parent', outcome: 'succeeded' },
    }),
  );
  const noop = async () => ({ data: [] });
  const session = new Proxy(
    {
      status,
      messages,
      get,
    },
    {
      get: (target, key) =>
        key === 'status' && setup.statusAvailable === false
          ? undefined
          : (Reflect.get(target, key) ?? noop),
    },
  );
  const client = new Proxy(
    { session, app: { log: noop } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ?? new Proxy({}, { get: () => noop }),
    },
  );
  const instance: { hooks?: Awaited<ReturnType<typeof plugin>> } = {};
  cleanups.push(async () => {
    await instance.hooks?.dispose?.();
    prune?.mockRestore();
    hookSpy.mockRestore();
    gateSpy.mockRestore();
    runtimeSpy.mockRestore();
    process.env = env;
    await rm(directory, { recursive: true, force: true });
  });
  const hooks = await plugin({
    client,
    directory,
    worktree: directory,
    serverUrl: new URL('http://127.0.0.1:4096'),
  } as never);
  instance.hooks = hooks;
  expect(gate).toBeDefined();
  expect(taskHook).toBeDefined();
  const event = (type: string, properties?: Record<string, unknown>) =>
    hooks.event?.({ event: { type, properties } } as never);
  const call = { tool: 'task', sessionID: 'parent', callID: 'native' };
  const requestTask = (callID: string, description: string) =>
    hooks['tool.execute.before']?.(
      { ...call, callID },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description,
        },
      },
    );
  const begin = async () => {
    await requestTask('native', 'ordinary task');
    await event('session.created', {
      info: { id: 'child', parentID: 'parent', agent: 'explorer' },
    });
  };
  const after = (state: string) =>
    hooks['tool.execute.after']?.(call, {
      output: `task_id: child\nstate: ${state}\n<task_result>confirmed result</task_result>`,
    });
  const idle = () => event('session.idle', { sessionID: 'child' });
  const busySignal = (activityAt?: number) =>
    event('session.status', {
      sessionID: 'child',
      status: { type: 'busy' },
      activityAt,
    });
  return {
    hooks,
    board,
    gate,
    taskHook,
    runtime,
    prune,
    status,
    statusMetrics,
    messages,
    get,
    directory,
    begin,
    requestTask,
    after,
    idle,
    event,
    busySignal,
    holdStatus: () => {
      const held = deferred<StatusResponse>();
      heldStatuses.push(held);
      return () => held.resolve({ data: { child: { type: 'busy' } } });
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

type Assembly = Awaited<ReturnType<typeof assembly>>;
function publicationOf(h: Assembly) {
  const publication = h.board.get('child');
  if (publication?.completedAt === undefined)
    throw new Error('missing publication');
  expect(publication.state).toBe('completed');
  return publication;
}
async function complete(h: Assembly) {
  await h.begin();
  await h.after('completed');
  return publicationOf(h);
}
async function completeWhileBusy(h: Assembly) {
  await h.begin();
  const oldTranscript = transcript();
  const held = deferred<unknown>();
  h.messages.mockImplementationOnce(() => held.promise);
  const completion = h.after('completed');
  await flush();
  expect(h.messages).toHaveBeenCalledTimes(1);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  h.setBusy(true);
  const activityAt = Date.now();
  // Keep the pre-publication case distinct from the equality boundary.
  await Bun.sleep(2);
  held.resolve(oldTranscript);
  await completion;
  const publication = publicationOf(h);
  expect(activityAt).toBeLessThan(publication.completedAt);
  return { publication, activityAt };
}
function expectReopened(h: Assembly, publication: BackgroundJobRecord) {
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    generation: publication.generation,
    terminalRevision: publication.terminalRevision + 1,
    resultSummary: undefined,
  });
}

test('regression: idle-with-busy-host must query status and publish nothing', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  h.setBusy(true);
  h.status.mockClear();
  const terminal = mock(() => {});
  h.board.addTerminalOutcomeListener(terminal);
  await h.idle();
  await flush();
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')?.state).toBe('running');
  expect(terminal).not.toHaveBeenCalled();
});

test.each(['missing outcome', 'lookup failure'])(
  'final idle without status retries a transient %s and releases capacity without another signal',
  async (failure) => {
    const h = await assembly(undefined, {
      statusAvailable: false,
      graceMs: 20,
    });
    await h.begin();
    await h.after('running');
    h.get.mockClear();
    h.get.mockImplementationOnce(async () => {
      if (failure === 'lookup failure')
        throw new Error('temporarily unavailable');
      return { data: { parentID: 'parent' } };
    });
    const release = spyOn(BackgroundTaskConcurrency.prototype, 'releaseTask');
    cleanups.push(async () => {
      release.mockRestore();
    });
    let admitted = false;
    const extra = h.requestTask('extra', 'queued before final idle').then(
      () => {
        admitted = true;
      },
      () => {},
    );
    await flush();
    expect(admitted).toBe(false);
    await h.idle();
    await flush();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.board.get('child')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(release).not.toHaveBeenCalled();
    // No more host events, transforms or manual gate reconciliations.
    for (let i = 0; i < 100 && h.board.get('child')?.state === 'running'; i++)
      await Bun.sleep(2);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'confirmed result',
    });
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.status).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await extra;
    expect(admitted).toBe(true);
  },
);

test('regression: native-after-releases-reopened-run releases once and retains capacity', async () => {
  const h = await assembly();
  await h.begin();
  const release = spyOn(BackgroundTaskConcurrency.prototype, 'releaseTask');
  cleanups.push(async () => {
    release.mockRestore();
  });
  h.board.addTerminalOutcomeListener((record) => {
    const token = h.gate.capture(record);
    if (!token) throw new Error('missing current publication observation');
    h.gate.observe(token, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: token.readStartedAt,
    });
  });
  await h.after('completed');
  let extraTaskAdmitted = false;
  const pending = h.requestTask('extra', 'extra');
  void pending?.then(
    () => {
      extraTaskAdmitted = true;
    },
    () => {},
  );
  await flush();
  expect(h.board.get('child')?.state).toBe('running');
  expect(
    release.mock.calls.filter(([taskID]) => taskID === 'child'),
  ).toHaveLength(1);
  expect(extraTaskAdmitted).toBe(false);
});

test('untimestamped busy needs a runtime contrast; reception alone cannot reopen', async () => {
  const h = await assembly();
  await complete(h);
  h.status.mockClear();
  await h.busySignal();
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')?.state).toBe('completed');
  h.setBusy(true);
  await h.busySignal();
  expect(h.board.get('child')?.state).toBe('running');
});

test('busy during transcript read delivered after commit triggers a fresh runtime contrast', async () => {
  const h = await assembly();
  const { publication, activityAt } = await completeWhileBusy(h);
  h.status.mockClear();
  await h.busySignal(activityAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expectReopened(h, publication);
});

test('busy at the exact publication timestamp triggers a runtime contrast', async () => {
  const h = await assembly();
  const publication = await complete(h);
  h.setBusy(true);
  h.status.mockClear();
  await h.busySignal(publication.completedAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expectReopened(h, publication);
});

test.each(['open', 'timed-out'] as const)(
  'deferred contrast survives collision with held polling and repairs without another signal (%s)',
  async (readState) => {
    const h = await assembly(undefined, {
      statusTimeoutMs: readState === 'timed-out' ? 1 : undefined,
    });
    const { publication, activityAt } = await completeWhileBusy(h);
    h.status.mockClear();
    const releaseStatus = h.holdStatus();
    // Drive the real polling pass, with its pre-event observation token.
    const polling = h.runtime.reconcile();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
    await h.busySignal(activityAt);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      terminalRevision: publication.terminalRevision,
    });
    expect(h.status).toHaveBeenCalledTimes(1);

    if (readState === 'timed-out') {
      await polling;
      expect(h.board.get('child')?.state).toBe('completed');
      expect(h.status).toHaveBeenCalledTimes(1);
    }
    releaseStatus();
    await polling;
    // No further event, tool call or manual reconciliation may drive recovery.
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expectReopened(h, publication);
  },
);

test('busy during the fresh gate read retains contrast through both read registries', async () => {
  const h = await assembly();
  const { publication, activityAt } = await completeWhileBusy(h);
  h.status.mockClear();
  const releasePolling = h.holdStatus();
  const releaseGateRead = h.holdStatus();
  const polling = h.runtime.reconcile();
  await flush();
  expect(h.status).toHaveBeenCalledTimes(1);
  await h.busySignal(activityAt);
  expect(h.status).toHaveBeenCalledTimes(1);
  releasePolling();
  await polling;
  await flush();
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.statusMetrics.activeReads).toBe(1);

  // This signal invalidates the fresh gate read while it is still open.
  await h.busySignal(activityAt);
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    terminalRevision: publication.terminalRevision,
  });
  releaseGateRead();
  // Recovery must not require another event, tool call or manual reconcile.
  await flush();
  expect(h.status).toHaveBeenCalledTimes(3);
  expect(h.statusMetrics).toEqual({ activeReads: 0, maxActiveReads: 1 });
  expectReopened(h, publication);
});

test('historical busy with a quiescent host contrasts without withdrawing the publication', async () => {
  const h = await assembly();
  const publication = await complete(h);
  const activityAt = publication.lastLiveBusyAt ?? publication.runStartedAt;
  expect(activityAt).toBeLessThanOrEqual(publication.completedAt);
  h.setBusy(false);
  h.status.mockClear();
  const terminal = mock(() => {});
  h.board.addTerminalOutcomeListener(terminal);
  await h.busySignal(activityAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    generation: publication.generation,
    terminalRevision: publication.terminalRevision,
    activityRevision: publication.activityRevision,
    resultSummary: publication.resultSummary,
  });
  expect(terminal).not.toHaveBeenCalled();
});

test('initialization failure disposes the gate owned by the production assembly', async () => {
  let assertDisposed: (() => Promise<void>) | undefined;
  await expect(
    assembly((board, gate) => {
      const run = board.registerLaunch({
        taskID: 'child',
        parentSessionID: 'parent',
        agent: 'explorer',
      });
      const token = gate.capture(run);
      if (!token) throw new Error('missing initial observation');
      const dispose = spyOn(gate, 'dispose');
      cleanups.push(async () => {
        dispose.mockRestore();
      });
      assertDisposed = async () => {
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(gate.capture(run)).toBeUndefined();
        expect(
          gate.observe(token, {
            kind: 'quiescent',
            origin: 'session.status',
            readStartedAt: token.readStartedAt,
          }),
        ).toEqual({ kind: 'stale' });
        expect(await gate.reconcile(run)).toEqual({ kind: 'stale' });
        expect(board.get(run.taskID)?.state).toBe('running');
      };
      throw new Error('forced assembly initialization failure');
    }),
  ).rejects.toThrow('forced assembly initialization failure');
  if (!assertDisposed) throw new Error('failure injection was not reached');
  await assertDisposed();
});

test.each(['dispose', 'event'] as const)(
  'regression: shared-gate-after-dispose through production %s',
  async (path) => {
    const h = await assembly();
    await h.begin();
    await h.after('running');
    const held = deferred<unknown>();
    h.messages.mockImplementationOnce(() => held.promise);
    const terminal = mock(() => {});
    h.board.addTerminalOutcomeListener(terminal);
    const run = h.board.get('child');
    if (!run) throw new Error('missing child run');
    const pending = h.gate.reconcile(run);
    await flush();
    expect(held.resolve).toBeFunction();
    expect(h.messages).toHaveBeenCalledTimes(1);
    if (path === 'dispose') await h.hooks.dispose?.();
    else await h.event('server.instance.disposed');
    held.resolve(transcript());
    await pending;
    await flush();
    expect(terminal).not.toHaveBeenCalled();
    expect(h.board.get('child')?.state).not.toBe('completed');
    expect(h.gate.capture({ taskID: 'child', generation: 1 })).toBeUndefined();
  },
);

test('regression: terminal-context-not-attached consolidates and prunes ordinary tasks', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  await h.hooks['tool.execute.after']?.(
    { tool: 'read', sessionID: 'child', callID: 'read' },
    { output: `<path>${h.directory}/source.ts</path>\n1: first\n2: second` },
  );
  const trackerFiles = h.taskHook.contextFilesForTask('child');
  expect(trackerFiles).toHaveLength(1);
  h.prune.mockClear();
  await h.idle();
  await flush();
  expect(h.board.get('child')?.state).toBe('completed');
  expect(h.board.get('child')?.contextFiles).toEqual(trackerFiles);
  expect(h.prune).toHaveBeenCalledTimes(1);
  h.board.drop('child');
  h.taskHook.pruneTaskContext();
  expect(h.taskHook.contextFilesForTask('child')).toEqual([]);
});
