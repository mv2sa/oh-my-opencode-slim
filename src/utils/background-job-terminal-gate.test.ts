import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createTaskSessionManagerHook } from '../hooks/task-session-manager';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { createTaskResultTool } from '../tools/task-result';
import { buildPluginInput } from '../v2/client-shim';
import { BackgroundJobBoard } from './background-job-board';
import { BackgroundJobCoordinator } from './background-job-coordinator';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
  type RuntimeObservation,
  runtimeObservationFromSnapshot,
} from './background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { classifyTerminalEvidence } from './child-transcript';
import { COMPLETED_WITHOUT_TEXT_DIAGNOSTIC } from './task';

const gates: BackgroundJobTerminalGate[] = [];
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const answer = (text = 'answer') => ({
  data: [
    { info: { id: 'baseline', role: 'user' }, parts: [] },
    {
      info: {
        id: 'answer',
        role: 'assistant',
        time: { completed: 100 },
        finish: 'stop',
      },
      parts: [{ type: 'text', text }],
    },
  ],
});
function harness(
  options: Partial<Parameters<typeof createBackgroundJobTerminalGate>[0]> = {},
) {
  const board = new BackgroundJobBoard();
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'fixer',
    background: true,
    now: 0,
  });
  let now = 1;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    baselineFor: () => 'baseline',
    readTerminalEvidence: async () => answer(),
    graceMs: 5,
    now: () => now,
    ...options,
  });
  gates.push(gate);
  const observe = (
    kind: 'busy' | 'quiescent' | 'unknown' | 'deleted',
    stable = false,
  ) => {
    const token = gate.capture(run);
    if (!token) throw new Error('missing observation');
    return gate.observe(token, {
      kind,
      readStartedAt: token.readStartedAt,
      origin: 'test',
      stable,
    });
  };
  return {
    board,
    run,
    gate,
    observe,
    advance: (time: number) => {
      now = time;
    },
  };
}

describe('terminal evidence policy (migrated from stop confirmation)', () => {
  test.each([
    undefined,
    {},
    { data: [], error: 'unavailable' },
    { data: [null] },
    { data: [{ info: { role: 'assistant' }, parts: 1 }] },
    { data: [{ info: { role: 'assistant' } }, 1] },
  ])('unknown or malformed evidence never means absence: %j', (response) => {
    expect(classifyTerminalEvidence(response).verdict).toBe('retry');
  });
  test('valid empty post-baseline segment is absent', () => {
    expect(
      classifyTerminalEvidence(
        { data: answer().data.slice(0, 1) },
        { baselineMessageID: 'baseline' },
      ),
    ).toEqual({ verdict: 'absent' });
  });
  test.each(['user', 'assistant'])(
    'new pending %s after a completed answer blocks N-1 retrieval',
    (role) => {
      const response = answer();
      response.data.push({ info: { id: 'pending', role }, parts: [] } as never);
      expect(
        classifyTerminalEvidence(response, { baselineMessageID: 'baseline' })
          .verdict,
      ).toBe('retry');
    },
  );
  test('a pending tool anywhere in the segment blocks completion', () => {
    const response = answer();
    response.data[1].parts.push({
      type: 'tool',
      state: { status: 'running' },
    } as never);
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'baseline' })
        .verdict,
    ).toBe('retry');
  });
  test('terminal errors take precedence over leftover finish flags', () => {
    const response = answer();
    Object.assign(response.data[1].info, {
      error: 'failed',
      finish: 'tool-calls',
    });
    expect(
      classifyTerminalEvidence(response, { baselineMessageID: 'baseline' }),
    ).toEqual({ verdict: 'error', text: 'failed' });
  });
  test('missing baseline cannot recover historical answers', () => {
    expect(
      classifyTerminalEvidence(answer(), { baselineMessageID: 'missing' })
        .verdict,
    ).toBe('retry');
  });
});

describe('terminal gate', () => {
  test('board rejects freely fabricated terminal authorization', async () => {
    const h = harness();
    const validate = mock(() => true);
    h.board.commitTerminal(
      { taskID: h.run.taskID, state: 'completed', resultSummary: 'forged' },
      { taskID: h.run.taskID, generation: h.run.generation, validate } as never,
    );
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    expect(validate).not.toHaveBeenCalled();
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.resultSummary).toBe('answer');
  });
  test('terminal authorization belongs to the currently bound gate and is single-use', async () => {
    const h = harness();
    const commit = h.board.commitTerminal.bind(h.board);
    const intercepted = spyOn(h.board, 'commitTerminal').mockImplementation(
      () => h.board.get(h.run.taskID),
    );
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    const [input, token] = intercepted.mock.calls[0];
    intercepted.mockRestore();
    const replacement = createBackgroundJobTerminalGate({
      backgroundJobBoard: h.board,
    });
    gates.push(replacement);
    commit(input, token);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.board.bindTerminalGate(h.gate);
    commit(input, token);
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
    const terminal = h.board.get(h.run.taskID);
    if (!terminal) throw new Error('missing terminal publication');
    const busy = h.gate.capture(terminal);
    if (!busy) throw new Error('missing current observation');
    h.gate.observe(busy, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: busy.readStartedAt,
    });
    commit(input, token);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
  test('late busy event does not become fresh activity at reception', async () => {
    const h = harness();
    h.advance(20);
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    h.advance(100);
    const token = h.gate.capture(h.run);
    if (!token) throw new Error('missing current observation');
    expect(
      h.gate.observe(token, {
        kind: 'busy',
        origin: 'session.status-event',
        observedAt: 10,
        readStartedAt: token.readStartedAt,
      }).kind,
    ).toBe('deferred');
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
    expect(
      h.gate.observe(token, {
        kind: 'busy',
        origin: 'session.status-event',
        observedAt: 30,
        readStartedAt: token.readStartedAt,
      }).kind,
    ).toBe('stale');
    const freshToken = h.gate.capture(h.run);
    if (!freshToken) throw new Error('missing fresh observation');
    h.gate.observe(freshToken, {
      kind: 'busy',
      origin: 'session.status-event',
      observedAt: 30,
      readStartedAt: freshToken.readStartedAt,
    });
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      lastLiveBusyAt: 30,
    });
  });
  test('task_result leaves a differing native result unacknowledged rather than substituting text', async () => {
    let response: unknown;
    const h = harness({ readTerminalEvidence: async () => response });
    h.observe('quiescent');
    await h.gate.reconcile(h.run, {
      kind: 'output',
      origin: { kind: 'native', run: h.run, callID: 'native' },
      status: {
        taskID: h.run.taskID,
        state: 'completed',
        timedOut: false,
        result: 'native result',
      },
    });
    response = answer('different transcript result');
    const input = {
      directory: '/tmp',
      client: {
        session: { get: async () => ({ data: { parentID: 'parent' } }) },
      },
    } as never;
    const result = createTaskResultTool({
      input,
      backgroundJobBoard: h.board,
      terminalGate: h.gate,
    }).task_result;
    expect(
      await result.execute({ task_id: h.run.taskID }, {
        sessionID: 'parent',
      } as never),
    ).toContain('unconfirmed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      resultSummary: 'native result',
      terminalRevision: 1,
      terminalUnreconciled: true,
    });
  });
  test('a hung child read does not block confirmation of another child', async () => {
    let release!: (value: unknown) => void;
    const h = harness({
      graceMs: 1000,
      readTerminalEvidence: (taskID) =>
        taskID === 'ses_child'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(answer('other result')),
    });
    h.observe('quiescent');
    const pending = h.gate.reconcile(h.run);
    await tick();
    const other = h.board.registerLaunch({
      taskID: 'other',
      parentSessionID: 'parent',
      agent: 'fixer',
      now: 0,
    });
    const token = h.gate.capture(other);
    if (!token) throw new Error('missing other child observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: token.readStartedAt,
    });
    await h.gate.reconcile(other);
    expect(h.board.get('other')).toMatchObject({
      state: 'completed',
      resultSummary: 'other result',
    });
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    release(undefined);
    await pending;
  });
  test.each(['transcript', 'outcome', 'v2-outcome'])(
    'handoff activated during %s await blocks publication',
    async (stage) => {
      let blocked = false;
      let release!: (value: unknown) => void;
      const held = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const h = harness({
        input: {
          directory: '/tmp',
          client: { session: { get: held } },
        } as never,
        readRuntime:
          stage === 'v2-outcome'
            ? undefined
            : async (_run, readStartedAt) => ({
                kind: 'quiescent',
                origin: 'test',
                readStartedAt,
              }),
        readTerminalEvidence:
          stage === 'transcript' ? held : async () => ({ data: [] }),
        isObservationPending: () => blocked,
        graceMs: 1000,
      });
      const pending = h.gate.reconcile(h.run);
      await tick();
      expect(release).toBeFunction();
      blocked = true;
      release(
        stage === 'transcript' ? answer() : { data: { outcome: 'failed' } },
      );
      await pending;
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test('late resolution after timeout and identity replacement cannot be reused', async () => {
    let release!: (value: unknown) => void;
    const read = mock(
      (): Promise<unknown> =>
        read.mock.calls.length === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(answer('new identity')),
    );
    const h = harness({
      readTerminalEvidence: read,
      readTimeoutMs: 2,
      graceMs: 1000,
    });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    const replacement = h.board.registerLaunch({
      taskID: h.run.taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      now: 10,
    });
    const token = h.gate.capture(replacement);
    if (!token) throw new Error('missing replacement observation');
    h.gate.observe(token, {
      kind: 'quiescent',
      origin: 'test',
      readStartedAt: token.readStartedAt,
    });
    await h.gate.reconcile(replacement);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    release(answer('obsolete'));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      generation: replacement.generation,
      resultSummary: 'new identity',
    });
  });
  test('completed transcript without quiescence stays running', async () => {
    const h = harness();
    expect((await h.gate.reconcile(h.run)).kind).toBe('deferred');
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
  });
  test.each(['completed', 'error', 'cancelled'] as const)(
    'parsed %s is only a candidate while busy',
    async (state) => {
      const h = harness();
      h.observe('busy');
      await h.gate.reconcile(h.run, {
        kind: 'output',
        status: {
          taskID: h.run.taskID,
          state,
          result: 'historical',
          timedOut: false,
        },
        origin: { kind: 'native', run: h.run, callID: 'call' },
      });
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test('quiescence plus attributable transcript commits exactly once', async () => {
    const h = harness();
    const listener = mock(() => {});
    h.board.addTerminalStateListener(listener);
    h.observe('quiescent');
    expect((await h.gate.reconcile(h.run)).kind).toBe('committed');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'answer',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  test('valid absence stops only after grace', async () => {
    const h = harness({
      readTerminalEvidence: async () => ({ data: [] }),
      baselineFor: () => undefined,
    });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.advance(7);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('stopped');
  });
  test('unknown never becomes stopped by exhausting retries', async () => {
    const h = harness({
      readTerminalEvidence: async () => undefined,
      maxEvidenceRetries: 1,
    });
    h.observe('quiescent');
    h.advance(20);
    for (let i = 0; i < 4; i++) await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
    });
  });
  test.each(['status', 'no runtime API'])(
    'runtime unknown retries are bounded for %s',
    async (source) => {
      const readRuntime = mock(
        async (
          _run: unknown,
          readStartedAt: number,
        ): Promise<RuntimeObservation> => ({
          kind: 'unknown',
          origin: 'session.status',
          readStartedAt,
        }),
      );
      const inspect = mock(() => {});
      const h = harness({
        readRuntime: source === 'status' ? readRuntime : undefined,
        observationRevisionFor: () => {
          inspect();
          return 1;
        },
        graceMs: 5,
      });
      await h.gate.reconcile(h.run);
      for (
        let i = 0;
        i < 100 &&
        h.board.get(h.run.taskID)?.lastStatusError !==
          EVIDENCE_UNAVAILABLE_DIAGNOSTIC;
        i++
      )
        await tick();
      expect(h.board.get(h.run.taskID)).toMatchObject({
        state: 'running',
        statusUncertain: true,
        lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
      });
      expect(readRuntime).toHaveBeenCalledTimes(source === 'status' ? 4 : 0);
      const calls = inspect.mock.calls.length;
      await Bun.sleep(25);
      expect(inspect).toHaveBeenCalledTimes(calls);
    },
  );
  test('busy during an evidence await immediately invalidates it', async () => {
    let resolve!: (value: unknown) => void;
    const h = harness({
      readTerminalEvidence: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    h.observe('quiescent');
    const pending = h.gate.reconcile(h.run);
    await tick();
    h.observe('busy');
    resolve(answer());
    await pending;
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'running',
      resultSummary: undefined,
    });
  });
  test('textless completion needs independent host termination and stabilization, never a parsed label', async () => {
    let terminated = false;
    const h = harness({
      maxEvidenceRetries: 1,
      readTerminalEvidence: async () => answer(''),
      readRuntime: async (_run, readStartedAt) => ({
        kind: 'quiescent',
        origin: 'host',
        readStartedAt,
        terminalOutcome: terminated ? 'succeeded' : undefined,
      }),
    });
    for (let i = 0; i < 3; i++)
      await h.gate.reconcile(h.run, {
        kind: 'output',
        status: {
          taskID: h.run.taskID,
          state: 'completed',
          timedOut: false,
          result: '',
        },
        origin: { kind: 'native', run: h.run, callID: 'call' },
      });
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    terminated = true;
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    h.advance(10);
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('error');
  });
  test('consumer timeouts never accumulate underlying reads', async () => {
    const read = mock(() => new Promise(() => {}));
    const h = harness({
      readTerminalEvidence: read,
      readTimeoutMs: 2,
      graceMs: 1000,
    });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    await h.gate.reconcile(h.run);
    expect(read).toHaveBeenCalledTimes(1);
    h.observe('busy');
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(read).toHaveBeenCalledTimes(1);
  });
  test.each([
    'coalesced',
    'new-episode-requested',
    'episode',
    'generation',
    'dispose',
  ] as const)(
    'pending runtime contrast handles %s without duplicate or stale reads',
    async (change) => {
      let release!: () => void;
      const readSettled = new Promise<void>((resolve) => {
        release = resolve;
      });
      let open = true;
      const readRuntime = mock(
        async (
          _run: unknown,
          readStartedAt: number,
        ): Promise<RuntimeObservation> => ({
          kind: open ? 'unknown' : 'busy',
          origin: 'session.status',
          readStartedAt,
          retryAfter: open ? readSettled : undefined,
        }),
      );
      const h = harness({ readRuntime });
      await h.gate.reconcile(h.run);
      await h.gate.reconcile(h.run);
      if (change === 'episode' || change === 'new-episode-requested')
        h.observe('unknown');
      if (change === 'new-episode-requested') await h.gate.reconcile(h.run);
      if (change === 'generation')
        h.board.registerLaunch({
          ...h.run,
          parentSessionID: 'parent',
          agent: 'fixer',
        });
      if (change === 'dispose') h.gate.dispose();
      const readsBeforeRelease = readRuntime.mock.calls.length;
      open = false;
      release();
      await tick();
      const freshReads =
        change === 'coalesced' || change === 'new-episode-requested' ? 1 : 0;
      expect(readRuntime).toHaveBeenCalledTimes(
        readsBeforeRelease + freshReads,
      );
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test.each(['baseline', 'revision', 'episode', 'generation', 'dispose'])(
    'late evidence cannot cross changed %s',
    async (change) => {
      let baseline = 'baseline';
      let revision = 1;
      let resolve!: (value: unknown) => void;
      const h = harness({
        baselineFor: () => baseline,
        observationRevisionFor: () => revision,
        readTerminalEvidence: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      h.observe('quiescent');
      const pending = h.gate.reconcile(h.run);
      await tick();
      if (change === 'baseline') baseline = 'new';
      if (change === 'revision') revision++;
      if (change === 'episode') {
        h.observe('busy');
        h.observe('quiescent');
      }
      if (change === 'generation')
        h.board.registerLaunch({
          ...h.run,
          parentSessionID: 'parent',
          agent: 'fixer',
        });
      if (change === 'dispose') h.gate.dispose();
      resolve(answer());
      await pending;
      expect(h.board.get(h.run.taskID)?.state).toBe('running');
    },
  );
  test('handoff blocks publication without discarding ownership', async () => {
    let blocked = true;
    const h = harness({ isObservationPending: () => blocked });
    h.observe('quiescent');
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('running');
    blocked = false;
    await h.gate.reconcile(h.run);
    expect(h.board.get(h.run.taskID)?.state).toBe('completed');
  });
  test('valid absence and malformed map entry have distinct observations', () => {
    expect(
      runtimeObservationFromSnapshot(
        { statuses: new Map(), malformedSessionIDs: new Set() },
        'child',
        1,
      ).kind,
    ).toBe('quiescent');
    expect(
      runtimeObservationFromSnapshot(
        { statuses: new Map(), malformedSessionIDs: new Set(['child']) },
        'child',
        1,
      ).kind,
    ).toBe('unknown');
  });
  test('deadline deletion commits synchronously before drop', () => {
    const h = harness();
    h.board.claimWallClockDeadline(h.run);
    const result = h.observe('deleted');
    expect(result.kind).toBe('committed');
    expect(h.board.get(h.run.taskID)).toMatchObject({
      state: 'error',
      timedOut: true,
    });
  });
});

test('integration: historical replay + rehydration + busy host publishes nothing and retains capacity', async () => {
  const board = new BackgroundJobBoard();
  const coordinator = new BackgroundJobCoordinator(board);
  const capacity = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const release = mock((taskID: string) => capacity.releaseTask(taskID));
  coordinator.addTerminalOutcomeListener((record) => release(record.taskID));
  const input = {
    directory: '/tmp',
    client: {
      session: {
        status: async () => ({ data: { ses_child: { type: 'busy' } } }),
        get: async () => ({
          data: { parentID: 'parent', outcome: 'succeeded' },
        }),
        messages: async () => answer('historical answer'),
      },
    },
  } as never;
  const gate = createBackgroundJobTerminalGate({
    input,
    backgroundJobBoard: coordinator,
  });
  gates.push(gate);
  const hook = createTaskSessionManagerHook(input, {
    backgroundJobBoard: coordinator,
    terminalGate: gate,
    backgroundTaskConcurrency: capacity,
    shouldManageSession: () => true,
    maxSessionsPerAgent: 10,
    maxRetainedSnapshots: 10,
  });
  const messages = [
    {
      info: {
        id: 'm1',
        sessionID: 'parent',
        role: 'assistant',
        agent: 'orchestrator',
      },
      parts: [
        {
          id: 'p1',
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            input: { background: true, subagent_type: 'fixer' },
            output: 'task_id: ses_child\nstate: running',
          },
        },
      ],
    },
    {
      info: {
        id: 'm2',
        sessionID: 'parent',
        role: 'user',
        agent: 'orchestrator',
      },
      parts: [
        {
          id: 'p2',
          type: 'text',
          synthetic: true,
          text: '<task id="ses_child" state="completed"><task_result>historical answer</task_result></task>',
        },
      ],
    },
  ];
  await hook['experimental.chat.messages.transform']({}, { messages });
  expect(board.get('ses_child')?.state).toBe('running');
  expect(release).not.toHaveBeenCalled();
  let admitted = false;
  const ticket = capacity.acquire({});
  void ticket.ready.then(
    () => {
      admitted = true;
    },
    () => {},
  );
  await tick();
  expect(admitted).toBe(false);
  ticket.release();
  capacity.dispose();
  await hook.event({ event: { type: 'server.instance.disposed' } });
});

test('integration: late acknowledgement and transport success for A cannot consume terminal B', async () => {
  const board = new BackgroundJobBoard();
  const run = board.registerLaunch({
    taskID: 'ses_child',
    parentSessionID: 'parent',
    agent: 'fixer',
    background: true,
    now: 0,
  });
  let text = 'A';
  let resolveA!: (value: unknown) => void;
  const transport = mock(
    (_input: { body: { parts: Array<{ text: string }> } }) =>
      transport.mock.calls.length === 1
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve({}),
  );
  const input = {
    directory: '/tmp',
    client: {
      session: { promptAsync: transport, messages: async () => answer(text) },
    },
  } as never;
  let tracker: ReturnType<typeof createRevivedRunTracker>;
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
    baselineFor: () => 'baseline',
    onTerminal: (record) => tracker.onTerminal(record),
  });
  gates.push(gate);
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    maxNotificationRetries: 1,
    notificationRetryDelayMs: 1,
  });
  tracker.register({ ...run, baselineMessageID: 'baseline' });
  const hook = createTaskSessionManagerHook(input, {
    backgroundJobBoard: board,
    terminalGate: gate,
    shouldManageSession: () => true,
    maxSessionsPerAgent: 10,
    maxRetainedSnapshots: 10,
  });
  try {
    const observe = (kind: 'busy' | 'quiescent') => {
      const token = gate.capture(run);
      if (!token) throw new Error('missing observation');
      gate.observe(token, {
        kind,
        origin: 'test',
        readStartedAt: token.readStartedAt,
      });
    };
    observe('quiescent');
    await gate.reconcile(run);
    await tick();
    const a = board.get(run.taskID);
    if (!a) throw new Error('missing terminal A');
    const messages = [
      {
        info: {
          id: 'parent-before',
          sessionID: 'parent',
          role: 'user',
          agent: 'orchestrator',
        },
        parts: [{ type: 'text', text: 'inspect results' }],
      },
    ];
    await hook['experimental.chat.messages.transform']({}, { messages });
    await hook.injectBackgroundJobBoard({}, { messages });
    observe('busy');
    text = 'B';
    observe('quiescent');
    await gate.reconcile(run);
    await tick();
    const b = board.get(run.taskID);
    if (!b) throw new Error('missing terminal B');
    tracker.onTerminal(a); // A delayed adapter callback must not replace B's notification state.
    for (let i = 0; i < 4; i++) await tick(); // Lease contention is not a failed send attempt for B.
    expect(b.terminalRevision).toBeGreaterThan(a.terminalRevision);
    messages.push({
      info: {
        id: 'parent-after',
        sessionID: 'parent',
        role: 'assistant',
        agent: 'orchestrator',
      },
      parts: [{ type: 'text', text: 'received the previous board' }],
    });
    const acknowledge = spyOn(board, 'markReconciled');
    await hook['experimental.chat.messages.transform']({}, { messages });
    await hook.injectBackgroundJobBoard({}, { messages });
    // The adapter rejects A before invoking the board's acknowledgement method.
    expect(acknowledge).not.toHaveBeenCalled();
    resolveA({});
    await tick();
    await tick();
    await tick();
    expect(board.get(run.taskID)).toMatchObject({
      state: 'completed',
      resultSummary: 'B',
      terminalUnreconciled: true,
      terminalRevision: b.terminalRevision,
    });
    expect(transport.mock.calls.length).toBe(2);
    expect(transport.mock.calls[1][0].body.parts[0].text).toContain(
      '<task_result>\nB\n</task_result>',
    );
    messages.push({
      info: {
        id: 'consume-B',
        sessionID: 'parent',
        role: 'assistant',
        agent: 'orchestrator',
      },
      parts: [{ type: 'text', text: 'received B' }],
    });
    await hook['experimental.chat.messages.transform']({}, { messages });
    await hook.injectBackgroundJobBoard({}, { messages });
    expect(
      acknowledge.mock.calls.some(
        ([taskID, , generation, revision]) =>
          taskID === run.taskID &&
          generation === run.generation &&
          revision === b.terminalRevision,
      ),
    ).toBe(true);
    acknowledge.mockRestore();
  } finally {
    resolveA?.({});
    tracker.dispose();
    await hook.event({ event: { type: 'server.instance.disposed' } });
  }
});

test.each(['transcript', 'outcome'])(
  'v2 real shim resumes after %s retry cutoff on the next idle event and returns an idempotent result',
  async (source) => {
    let valid = false;
    const context = mock(async () => {
      if (!valid) throw new Error('context temporarily unavailable');
      return [
        { id: 'baseline', role: 'user', content: [] },
        {
          id: 'result',
          role: 'assistant',
          content: [{ type: 'text', text: 'v2 result' }],
        },
      ];
    });
    const get = mock(
      async (): Promise<{
        id: string;
        parentID: string;
        outcome?: 'succeeded';
      }> => ({
        id: 'ses_v2child',
        parentID: 'parent',
        outcome: source === 'transcript' || valid ? 'succeeded' : undefined,
      }),
    );
    const input = buildPluginInput({
      location: { directory: '/tmp' },
      session: {
        get,
        context,
      },
    } as never) as never;
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_v2child',
      parentSessionID: 'parent',
      agent: 'fixer',
      now: 0,
    });
    const gate = createBackgroundJobTerminalGate({
      input,
      backgroundJobBoard: board,
      baselineFor: () => 'baseline',
      maxEvidenceRetries: source === 'transcript' ? 1 : 3,
      graceMs: 5,
    });
    gates.push(gate);
    const hook = createTaskSessionManagerHook(input, {
      terminalGate: gate,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      maxSessionsPerAgent: 10,
      maxRetainedSnapshots: 10,
    });
    const idle = () =>
      hook.event({
        event: { type: 'session.idle', properties: { sessionID: run.taskID } },
      });
    try {
      await idle();
      for (
        let i = 0;
        i < 50 &&
        board.get(run.taskID)?.lastStatusError !==
          EVIDENCE_UNAVAILABLE_DIAGNOSTIC;
        i++
      )
        await tick();
      expect(board.get(run.taskID)).toMatchObject({
        state: 'running',
        statusUncertain: true,
        lastStatusError: EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
      });
      const calls = context.mock.calls.length;
      const runtimeCalls = get.mock.calls.length;
      if (source === 'outcome') {
        expect(runtimeCalls).toBe(4);
        expect(context).not.toHaveBeenCalled();
      }
      await Bun.sleep(25); // More than graceMs * 4: neither reader may keep polling.
      expect(context).toHaveBeenCalledTimes(calls);
      expect(get).toHaveBeenCalledTimes(runtimeCalls);
      if (source === 'outcome') {
        // The host signal must renew the budget even if its first lookup still
        // lacks outcome. The next automatic retry, not another signal, succeeds.
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        get.mockImplementationOnce(async () => {
          await pending;
          return { id: 'ses_v2child', parentID: 'parent' };
        });
        await idle();
        for (let i = 0; i < 50 && get.mock.calls.length === runtimeCalls; i++)
          await tick();
        expect(get).toHaveBeenCalledTimes(runtimeCalls + 1);
        valid = true;
        release();
      } else {
        valid = true;
        await idle();
      }
      for (let i = 0; i < 50 && board.get(run.taskID)?.state === 'running'; i++)
        await tick();
      expect(board.get(run.taskID)).toMatchObject({
        state: 'completed',
        resultSummary: 'v2 result',
      });
      const result = createTaskResultTool({
        input,
        backgroundJobBoard: board,
        terminalGate: gate,
      }).task_result;
      expect(
        await result.execute({ task_id: run.taskID }, {
          sessionID: 'parent',
        } as never),
      ).toBe('v2 result');
      expect(
        await result.execute({ task_id: run.taskID }, {
          sessionID: 'parent',
        } as never),
      ).toBe('v2 result');
      expect(context).toHaveBeenCalledWith({ sessionID: run.taskID });
    } finally {
      await hook.event({ event: { type: 'server.instance.disposed' } });
    }
  },
);

describe('foreground native terminal fast path (r2 hardening)', () => {
  test.each([
    [
      'unattributed native return keeps the full runtime discipline',
      false,
      false,
    ],
    [
      'ambiguous untimestamped busy kills a held foreground candidate',
      true,
      true,
    ],
  ] as const)('%s', async (_name, callIDConfirmed, ambiguousBusy) => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: `ses_fg_${ambiguousBusy ? 'ambiguous' : 'unattributed'}`,
      parentSessionID: 'parent',
      agent: 'fixer',
      background: false,
      now: 0,
    });
    // First row runs without a pending handoff so it isolates the
    // attribution barrier; second row holds the candidate behind one.
    let observationPending = ambiguousBusy;
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      readTerminalEvidence: async () => answer(),
      isObservationPending: () => observationPending,
      graceMs: 5,
      now: () => 1,
    });
    gates.push(gate);
    const held = await gate.reconcile(run, {
      kind: 'output',
      origin: {
        kind: 'native',
        run,
        callID: 'call',
        ...(callIDConfirmed ? { callIDConfirmed: true } : {}),
      },
      status: {
        taskID: run.taskID,
        state: 'completed',
        timedOut: false,
        result: 'done',
      },
    });
    expect(held.kind).toBe('deferred');
    expect(board.get(run.taskID)?.state).toBe('running');
    if (!ambiguousBusy) return;
    const token = gate.capture(run);
    if (!token) throw new Error('missing observation token');
    gate.observe(token, {
      kind: 'busy',
      origin: 'session.status-event',
      readStartedAt: token.readStartedAt,
    });
    observationPending = false;
    const after = await gate.reconcile(run);
    expect(after.kind).toBe('deferred');
    expect(board.get(run.taskID)?.state).toBe('running');
  });

  test('confirmed foreground textless completion publishes error, not invented success', async () => {
    const board = new BackgroundJobBoard();
    const run = board.registerLaunch({
      taskID: 'ses_fg_textless',
      parentSessionID: 'parent',
      agent: 'fixer',
      background: false,
      now: 0,
    });
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      // No terminal transcript evidence: the native return is the only
      // evidence, so guardCompletedStatusText decides the publication.
      readTerminalEvidence: async () => ({ data: [] }),
      graceMs: 5,
      now: () => 1,
    });
    gates.push(gate);
    const result = await gate.reconcile(run, {
      kind: 'output',
      origin: { kind: 'native', run, callID: 'call', callIDConfirmed: true },
      status: { taskID: run.taskID, state: 'completed', timedOut: false },
    });
    expect(result.kind).toBe('committed');
    expect(board.get(run.taskID)).toMatchObject({
      state: 'error',
      resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
    });
  });
});
