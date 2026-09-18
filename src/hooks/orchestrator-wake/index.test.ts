import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutcomeController } from '../../outcome/controller';
import {
  type OutcomeContract,
  OutcomeContractSchema,
} from '../../outcome/controller-schema';
import { createInternalAgentTextPart } from '../../utils';
import { createOutcomeControllerHook } from '../outcome-controller';
import { SessionLifecycle } from '../session-lifecycle';
import { resetUserWaitGateForTests } from '../task-session-manager/user-wait-gate';
import {
  buildChildrenWakeFingerprint,
  buildOrchestratorWakeFingerprint,
  CHILD_STALENESS_INTERVALS,
  childUpdateEvidenceMs,
  createOrchestratorWakeScheduler,
  formatStoppedJobDelta,
  isWakeChildActive,
  mapWakeChild,
  ORCHESTRATOR_CHILDREN_WAKE_TEXT,
  ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT,
  ORCHESTRATOR_WAKE_TEXT,
  ORCHESTRATOR_WAKE_UNCHANGED_CAP,
  resolveWakeMode,
  STOPPED_RECOVERY_OVERFLOW_TEXT,
  STOPPED_RECOVERY_QUEUE_CAP,
  STOPPED_RECOVERY_WAKE_CHUNK,
} from './index';
import {
  getWakeProgress,
  observeWakeLifecycle,
  resetOrchestratorWakeGateForTests,
  wakeGateSizesForTests,
} from './wake-gate';

type SessionClient = {
  get?: ReturnType<typeof mock>;
  todo?: ReturnType<typeof mock>;
  children?: ReturnType<typeof mock>;
  status?: ReturnType<typeof mock>;
  list?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
  messages?: ReturnType<typeof mock>;
  list?: ReturnType<typeof mock>;
};

function createClock() {
  let now = 0;
  let nextID = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeoutImpl = ((callback: () => void, delay?: number) => {
    const id = nextID++;
    timers.set(id, { at: now + (delay ?? 0), callback });
    const handle = {
      __id: id,
      unref() {
        return handle;
      },
    };
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const clearTimeoutImpl = ((handle: unknown) => {
    if (handle == null) return;
    const id =
      typeof handle === 'object' &&
      handle !== null &&
      '__id' in handle &&
      typeof (handle as { __id: unknown }).__id === 'number'
        ? (handle as { __id: number }).__id
        : Number(handle);
    timers.delete(id);
  }) as unknown as typeof clearTimeout;

  async function flushMicrotasks(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    async advance(ms: number) {
      now += ms;
      for (let round = 0; round < 5; round++) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
        }
        await flushMicrotasks();
      }
      await flushMicrotasks();
    },
    pendingCount() {
      return timers.size;
    },
  };
}

type SessionClientFactory = Partial<SessionClient> & {
  todos?: Array<Record<string, unknown>>;
  childrenData?: Array<Record<string, unknown>>;
  statusData?: Record<string, unknown>;
  model?: unknown;
  messagesData?: Array<Record<string, unknown>>;
  listData?: Array<Record<string, unknown>>;
};

function makeClient(overrides?: SessionClientFactory): SessionClient {
  const todos = overrides?.todos ?? [{ id: 't1', status: 'pending' }];
  const childrenData = overrides?.childrenData ?? [];
  const statusData = overrides?.statusData ?? {};
  return {
    get:
      overrides?.get ??
      mock(async () => ({
        data: {
          model: overrides?.model ?? {
            providerID: 'test',
            id: 'model-a',
            variant: 'high',
          },
        },
      })),
    todo: overrides?.todo ?? mock(async () => ({ data: todos })),
    children: overrides?.children ?? mock(async () => ({ data: childrenData })),
    status: overrides?.status ?? mock(async () => ({ data: statusData })),
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
    messages:
      overrides?.messages ??
      mock(async () => ({ data: overrides?.messagesData ?? [] })),
    list:
      overrides?.list ??
      mock(async () => ({ data: overrides?.listData ?? [] })),
  };
}

function createScheduler(options?: {
  enabled?: boolean;
  intervalMs?: number;
  mode?: 'auto' | 'todo' | 'children';
  hostFlavor?: string;
  sessionClient?: SessionClient | null;
  shouldManageSession?: (id: string) => boolean;
  hasInputWait?: (id: string) => boolean;
  isFallbackInProgress?: (id: string) => boolean;
  isStoppedJobRecoveryCurrent?: (taskID: string, generation: number) => boolean;
  hasPendingDelegatedWork?: (id: string) => boolean;
  resolveSelection?: (sessionID: string) => Promise<{
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
    provenance: 'host-persisted' | 'observed-external' | 'unknown';
  }>;
  coordinator?: SessionLifecycle;
  directory?: string;
  outcomeController?: OutcomeController;
  registerSessionAsOrchestrator?: (id: string) => void;
  startupSettleDelayMs?: number;
  restartSnapshotSettleDelayMs?: number;
  maxBootstrapRoots?: number;
  bootstrapConcurrency?: number;
}) {
  const client = options?.sessionClient;
  const session = client === null ? undefined : (client ?? makeClient());
  const ctx = {
    directory: options?.directory ?? '/project',
    client: { session },
    ...(options?.hostFlavor ? { hostFlavor: options.hostFlavor } : {}),
  } as never;

  const scheduler = createOrchestratorWakeScheduler(ctx, {
    config: {
      enabled: options?.enabled ?? true,
      intervalMs: options?.intervalMs ?? 60_000,
      ...(options?.mode ? { mode: options.mode } : {}),
    },
    intervalMs: options?.intervalMs ?? 60_000,
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: options?.hasInputWait ?? (() => false),
    isFallbackInProgress: options?.isFallbackInProgress,
    isStoppedJobRecoveryCurrent: options?.isStoppedJobRecoveryCurrent,
    hasPendingDelegatedWork: options?.hasPendingDelegatedWork,
    resolveSelection: options?.resolveSelection,
    coordinator: options?.coordinator,
    outcomeController: options?.outcomeController,
    registerSessionAsOrchestrator: options?.registerSessionAsOrchestrator,
    startupSettleDelayMs: options?.startupSettleDelayMs,
    restartSnapshotSettleDelayMs: options?.restartSnapshotSettleDelayMs ?? 0,
    maxBootstrapRoots: options?.maxBootstrapRoots,
    bootstrapConcurrency: options?.bootstrapConcurrency,
  });

  return { scheduler, session: session as SessionClient | undefined };
}

/** v2-flavored session surface: list + promptAsync (get optional). */
function makeV2Client(overrides?: {
  listChildren?: Array<Record<string, unknown>>;
  listImpl?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
  get?: ReturnType<typeof mock>;
  omitList?: boolean;
}): SessionClient {
  const client: SessionClient = {
    promptAsync: overrides?.promptAsync ?? mock(async () => ({})),
  };
  if (!overrides?.omitList) {
    client.list =
      overrides?.listImpl ??
      mock(async () => ({ data: overrides?.listChildren ?? [] }));
  }
  if (overrides?.get) client.get = overrides.get;
  return client;
}

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let clock = createClock();

beforeEach(() => {
  resetUserWaitGateForTests();
  resetOrchestratorWakeGateForTests();
  clock = createClock();
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('buildOrchestratorWakeFingerprint', () => {
  test('includes todo and child activity but excludes timestamp churn', () => {
    const fp = buildOrchestratorWakeFingerprint(
      [
        { id: 'b', status: 'pending' },
        { id: 'a', status: 'in_progress' },
      ],
      [{ id: 'child-1', time: { updated: 42 } }],
      { 'child-1': { type: 'busy' } },
    );
    expect(fp).toContain('a:in_progress');
    expect(fp).toContain('b:pending');
    expect(fp).toContain('child-1:active');
    expect(fp).not.toContain('42');
  });
});

describe('orchestrator wake scheduler', () => {
  test('interleaved busy cannot let original idle or its legacy pair close the new run', async () => {
    const base = {
      outcomeId: 'o',
      contractDigest: 'd',
      phase: 'action_required',
      contract: { goals: [] },
      actionsRequired: [],
      operations: [],
      receipts: { evidence: [] },
    };
    const controller = {
      readRecord: () => ({ success: true, data: base }),
      store: {
        read: () => ({ success: true, data: base }),
        reconcileIdleOperations: () => ({ success: true, data: base }),
      },
      validateManagedWait: () => ({ allowed: false }),
    } as unknown as OutcomeController;
    let dispatch: (type: string) => Promise<void>;
    const promptAsync = mock(async () => {
      await dispatch('busy');
      return {};
    });
    const session = makeClient({ promptAsync, todos: [] });
    const hook = createOutcomeControllerHook(
      { client: { session } },
      { controller, shouldManageSession: () => true },
    );
    const { scheduler } = createScheduler({ sessionClient: session });
    dispatch = async (type) => {
      const input = {
        event: {
          type: 'session.status',
          properties: { sessionID: 'root', status: { type } },
        },
      };
      await hook.event(input);
      await scheduler.event(input);
    };
    await dispatch('idle');
    const legacy = {
      event: { type: 'session.idle', properties: { sessionID: 'root' } },
    };
    await hook.event(legacy);
    await scheduler.event(legacy);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(getWakeProgress('root').running).toBe(true);
    await dispatch('idle'); // actual run completion
    expect(promptAsync).toHaveBeenCalledTimes(2);
    await hook.event({ event: { type: 'server.instance.disposed' } });
    await scheduler.event({ event: { type: 'server.instance.disposed' } });
  });
  test('real Controller-before-scheduler order: alternating wakes and synthetic lifecycle share two attempts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-integration-'));
    const root = 'integration-root';
    const controller = new OutcomeController({ storeDirectory: dir });
    controller.begin(
      root,
      OutcomeContractSchema.parse({
        classification: 'non_trivial',
        objective: 'Repair source only',
        deliverables: ['repair'],
        goals: [{ id: 'g', description: 'repair', status: 'in_progress' }],
        inScope: ['src'],
        outOfScope: [],
        constraints: [],
        safetyBoundaries: [],
        handoffRequirements: ['report checks'],
        sourceMessageIds: ['initial'],
        rules: [],
        exceptions: [],
      }),
    );
    const todos = [{ id: 't1', status: 'pending' }];
    const promptAsync = mock(async () => ({}));
    const session = makeClient({ todos, promptAsync });
    const hook = createOutcomeControllerHook(
      { directory: dir, client: { session } },
      {
        controller,
        shouldManageSession: () => true,
      },
    );
    const { scheduler } = createScheduler({
      sessionClient: session,
      outcomeController: controller,
    });
    const event = async (type: string) => {
      const input = {
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type } },
        },
      };
      await hook.event(input);
      await scheduler.event(input);
    };
    try {
      await event('idle'); // Controller spends first attempt.
      await hook.event({
        event: { type: 'session.idle', properties: { sessionID: root } },
      });
      await scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: root } },
      });
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(1); // Paired idle after SDK ack is the same cycle.
      await event('busy');
      observeWakeLifecycle(root, 'idle');
      scheduler.triggerStoppedJobRecovery(root); // scheduler spends second.
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(2);
      const before = controller.store.read(root);
      for (let i = 0; i < 5; i++) {
        await event('busy');
        await event('retry');
        await event('idle');
        const synthetic = {
          sessionID: root,
          messageID: `synthetic-${i}`,
          parts: [
            { type: 'text', text: 'Stop' },
            createInternalAgentTextPart('Still stopped'),
          ],
        };
        await hook['chat.message'](synthetic);
        scheduler.observeChatMessage(synthetic, undefined);
        scheduler.triggerStoppedJobRecovery(root);
        await scheduler.event({
          event: { type: 'session.error', properties: { sessionID: root } },
        });
        await clock.advance(60_000);
      }
      expect(promptAsync).toHaveBeenCalledTimes(2);
      expect(controller.store.read(root)).toEqual(before);
      // Manual input refills liveness only, not governance or certification.
      const manual = {
        sessionID: root,
        messageID: 'human-1',
        parts: [
          {
            type: 'text',
            text: 'Source-only UNCERTIFIED; no outcome_control. Stop.',
          },
        ],
      };
      await hook['chat.message'](manual);
      scheduler.observeChatMessage(manual, undefined);
      await event('idle');
      await event('busy');
      await event('idle');
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(4);
      await hook['chat.message'](manual);
      scheduler.observeChatMessage(manual, undefined);
      await event('busy');
      await event('idle');
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(4);
      const record = controller.store.read(root);
      expect(record.success && record.data.receipts.userMessages.length).toBe(
        1,
      );
      expect(record.success && record.data.receipts.decisions.length).toBe(0);
      expect(record.success && record.data.finalCertificate).toBeUndefined();
      todos[0].status = 'in_progress';
      await event('idle');
      await clock.advance(0);
      expect(promptAsync).toHaveBeenCalledTimes(5);
      await clock.advance(60_000);
      await event('busy');
      await event('idle');
      expect(promptAsync).toHaveBeenCalledTimes(6);
      for (let i = 0; i < 300; i++) {
        const message = {
          sessionID: root,
          messageID: `external-${i}`,
          parts: [{ type: 'text', text: 'manual' }],
        };
        // Receipt capacity is independently fail-closed at 32. Exercise wake
        // admission through both hooks without changing that durable policy.
        if (i < 31) await hook['chat.message'](message);
        else
          await expect(hook['chat.message'](message)).rejects.toThrow(
            'userMessages',
          );
        scheduler.observeChatMessage(message, undefined);
      }
      await event('idle');
      await event('busy');
      await event('idle');
      const exhausted = promptAsync.mock.calls.length;
      const replay = {
        sessionID: root,
        messageID: 'external-0',
        parts: [{ type: 'text', text: 'manual' }],
      };
      await hook['chat.message'](replay);
      scheduler.observeChatMessage(replay, undefined);
      await event('idle');
      await clock.advance(60_000);
      expect(promptAsync).toHaveBeenCalledTimes(exhausted);
      expect(getWakeProgress(root).unchangedWakeCount).toBe(2);
    } finally {
      await scheduler.event({ event: { type: 'server.instance.disposed' } });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Controller retries once when periodic read owner releases a no-TODO evaluation', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = {
      outcomeId: 'o',
      contractDigest: 'd',
      phase: 'action_required',
      contract: { goals: [] },
      actionsRequired: [],
      operations: [],
      receipts: { evidence: [] },
    };
    const controller = {
      readRecord: () => ({ success: true, data: base }),
      store: {
        read: () => ({ success: true, data: base }),
        reconcileIdleOperations: () => ({ success: true, data: base }),
      },
      validateManagedWait: () => ({ allowed: false }),
    } as unknown as OutcomeController;
    const promptAsync = mock(async () => ({}));
    const session = makeClient({
      promptAsync,
      todo: mock(async () => {
        await blocked;
        return { data: [] };
      }),
    });
    const { scheduler } = createScheduler({ sessionClient: session });
    const hook = createOutcomeControllerHook(
      { client: { session } },
      { controller, shouldManageSession: () => true },
    );
    const idle = {
      event: { type: 'session.idle', properties: { sessionID: 'root' } },
    };
    await scheduler.event(idle);
    await clock.advance(60_000);
    await hook.event(idle);
    await hook.event(idle);
    expect(promptAsync).not.toHaveBeenCalled();
    release();
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    await hook.event({ event: { type: 'server.instance.disposed' } });
    await scheduler.event({ event: { type: 'server.instance.disposed' } });
  });

  test('unknown restart candidates do not allocate process-global state', async () => {
    const controller = {
      store: { read: () => ({ success: false, code: 'missing' }) },
    } as unknown as OutcomeController;
    const { scheduler } = createScheduler({
      outcomeController: controller,
      shouldManageSession: () => false,
    });
    for (let i = 0; i < 2000; i++) {
      await scheduler._test.classifyAndRecoverInterruptedSession(
        `unknown-${i}`,
        'event',
      );
    }
    expect(wakeGateSizesForTests()).toEqual({
      progress: 0,
      restart: 0,
      owners: 0,
      waiters: 0,
      order: 0,
      outcomeIdle: 0,
    });
    await scheduler.event({ event: { type: 'server.instance.disposed' } });
  });

  test('immediately wakes an idle parent after a stopped child with an active sibling', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            createInternalAgentTextPart(ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT),
          ],
        }),
      }),
    );
  });

  test('recovery wake carries the self-contained stop delta inline', async () => {
    // Issue #1051: the recovery wake is an internal-initiator message, so
    // under checkpoint-compatible it cannot create a board snapshot, and
    // any retained snapshot predates the stop. The wake must carry the
    // stop facts itself.
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'ora-7',
        taskID: 'ses_x',
        generation: 3,
        state: 'stopped',
        reason: 'stopped without a terminal result',
      }),
      'ses_x:3',
    );
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { parts: Array<{ text: string }> } }]
      >
    )[0]?.[0];
    expect(call?.body.parts[0]?.text).toContain(
      ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT,
    );
    expect(call?.body.parts[0]?.text).toContain('alias: ora-7');
    expect(call?.body.parts[0]?.text).toContain('task: ses_x');
    expect(call?.body.parts[0]?.text).toContain('state: stopped');
    expect(call?.body.parts[0]?.text).toContain('generation: 3');
    expect(call?.body.parts[0]?.text).toContain(
      'reason: stopped without a terminal result',
    );
  });

  test('a delta arriving while a recovery wake is in flight is delivered by the next wake', async () => {
    // Race from the review of this fix: stop A is in flight, stop B arrives
    // before A's delivery resolves. B must survive A's confirmation and be
    // carried by the next recovery wake.
    let resolveA: () => void = () => {};
    const promptAsync = mock(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveA = () => resolve({});
        }),
    );
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'a1',
        taskID: 'ses_a',
        generation: 1,
        state: 'stopped',
        reason: 'stopped without a terminal result',
      }),
      'ses_a:1',
    );
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Stop B lands while wake A is still awaiting delivery.
    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'b1',
        taskID: 'ses_b',
        generation: 2,
        state: 'stopped',
        reason: 'runtime status uncertain',
      }),
      'ses_b:2',
    );

    resolveA();
    await clock.advance(0);
    // A's delivery resolved; no new wake fires until the parent goes idle
    // again with B still pending.
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const secondCall = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { parts: Array<{ text: string }> } }]
      >
    )[1]?.[0];
    expect(secondCall?.body.parts[0]?.text).toContain('task: ses_b');
    expect(secondCall?.body.parts[0]?.text).not.toContain('task: ses_a');
  });

  test('duplicate stops for the same task and generation are deduplicated', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    const delta = formatStoppedJobDelta({
      alias: 'a1',
      taskID: 'ses_a',
      generation: 4,
      state: 'stopped',
      reason: 'stopped without a terminal result',
    });
    scheduler.triggerStoppedJobRecovery('p1', delta, 'ses_a:4');
    scheduler.triggerStoppedJobRecovery('p1', delta, 'ses_a:4');
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { parts: Array<{ text: string }> } }]
      >
    )[0]?.[0];
    expect(call?.body.parts[0]?.text.match(/task: ses_a/g)?.length).toBe(1);
  });

  test('revalidates queued stop facts before delivering recovery', async () => {
    const promptAsync = mock(async () => ({}));
    let waiting = true;
    const current = new Set(['ses_current:3']);
    const isCurrent = mock((taskID: string, generation: number) =>
      current.has(`${taskID}:${generation}`),
    );
    const { scheduler } = createScheduler({
      hasInputWait: () => waiting,
      isStoppedJobRecoveryCurrent: isCurrent,
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    for (const [taskID, generation] of [
      ['ses_stale', 1],
      ['ses_revived', 2],
      ['ses_current', 3],
    ] as const) {
      scheduler.triggerStoppedJobRecovery(
        'p1',
        formatStoppedJobDelta({
          alias: taskID,
          taskID,
          generation,
          state: 'stopped',
          reason: 'stopped without a terminal result',
        }),
        `${taskID}:${generation}`,
      );
    }

    // The first two executions have been revived or reconciled before the
    // parent is able to receive its queued recovery wake.
    current.delete('ses_stale:1');
    current.delete('ses_revived:2');
    waiting = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const text =
      (
        promptAsync.mock.calls as unknown as Array<
          [{ body: { parts: Array<{ text: string }> } }]
        >
      )[0]?.[0]?.body.parts[0]?.text ?? '';
    expect(text).toContain('task: ses_current\n');
    expect(text).not.toContain('task: ses_stale\n');
    expect(text).not.toContain('task: ses_revived\n');
    expect(isCurrent).toHaveBeenCalledWith('ses_stale', 1);
    expect(isCurrent).toHaveBeenCalledWith('ses_revived', 2);
    expect(isCurrent).toHaveBeenCalledWith('ses_current', 3);
  });

  test('a failed recovery delivery restores the batch for the next wake', async () => {
    let fail = true;
    const promptAsync = mock(async () => {
      if (fail) throw new Error('sdk error');
      return {};
    });
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'a1',
        taskID: 'ses_a',
        generation: 7,
        state: 'stopped',
        reason: 'stopped without a terminal result',
      }),
      'ses_a:7',
    );
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    fail = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const secondCall = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { parts: Array<{ text: string }> } }]
      >
    )[1]?.[0];
    expect(secondCall?.body.parts[0]?.text).toContain('task: ses_a');
  });

  test('a delivered recovery does not re-fire on the next idle', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'a1',
        taskID: 'ses_a',
        generation: 1,
        state: 'stopped',
        reason: 'stopped without a terminal result',
      }),
      'ses_a:1',
    );
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('caps queued stop deltas without losing the overflow recovery signal', async () => {
    const promptAsync = mock(async () => ({}));
    let waiting = true;
    const { scheduler } = createScheduler({
      hasInputWait: () => waiting,
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    for (let i = 0; i < STOPPED_RECOVERY_QUEUE_CAP + 1; i++) {
      scheduler.triggerStoppedJobRecovery(
        'p1',
        formatStoppedJobDelta({
          alias: `a${i}`,
          taskID: `ses_${i}`,
          generation: 1,
          state: 'stopped',
          reason: 'stopped without a terminal result',
        }),
        `ses_${i}:1`,
      );
    }
    expect(promptAsync).not.toHaveBeenCalled();

    waiting = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const text =
      (
        promptAsync.mock.calls as unknown as Array<
          [{ body: { parts: Array<{ text: string }> } }]
        >
      )[0]?.[0]?.body.parts[0]?.text ?? '';
    expect(text).not.toContain('task: ses_0\n');
    expect(text).toContain('task: ses_1\n');
    expect(text).not.toContain(`task: ses_${STOPPED_RECOVERY_QUEUE_CAP}\n`);
    expect(text).toContain(STOPPED_RECOVERY_OVERFLOW_TEXT);
    expect(text.match(/<stopped-job>/g)?.length).toBe(
      STOPPED_RECOVERY_WAKE_CHUNK,
    );
  });

  test('preserves overflow that arrives while recovery delivery is in flight', async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    const promptAsync = mock(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Record<string, unknown>>((resolve) => {
          releaseFirst = () => resolve({});
        });
      }
      return Promise.resolve({});
    });
    let waiting = true;
    const { scheduler } = createScheduler({
      hasInputWait: () => waiting,
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    // Fill the detail queue and create the first overflow marker.
    for (let i = 0; i < STOPPED_RECOVERY_QUEUE_CAP + 1; i++) {
      scheduler.triggerStoppedJobRecovery(
        'p1',
        formatStoppedJobDelta({
          alias: `a${i}`,
          taskID: `ses_${i}`,
          generation: 1,
          state: 'stopped',
          reason: 'stopped without a terminal result',
        }),
        `ses_${i}:1`,
      );
    }

    waiting = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // This stop arrives after the first wake captured its overflow count. It
    // overflows the still-full queue again and must survive first delivery.
    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'during',
        taskID: 'ses_during',
        generation: 1,
        state: 'stopped',
        reason: 'stopped without a terminal result',
      }),
      'ses_during:1',
    );

    releaseFirst();
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const second =
      (
        promptAsync.mock.calls as unknown as Array<
          [{ body: { parts: Array<{ text: string }> } }]
        >
      )[1]?.[0]?.body.parts[0]?.text ?? '';
    expect(second).toContain(STOPPED_RECOVERY_OVERFLOW_TEXT);
  });

  test('delivers overflow stop deltas on a later recovery wake', async () => {
    const promptAsync = mock(async () => ({}));
    let waiting = true;
    const { scheduler } = createScheduler({
      hasInputWait: () => waiting,
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });

    for (let i = 0; i < STOPPED_RECOVERY_WAKE_CHUNK + 1; i++) {
      scheduler.triggerStoppedJobRecovery(
        'p1',
        formatStoppedJobDelta({
          alias: `a${i}`,
          taskID: `ses_${i}`,
          generation: 1,
          state: 'stopped',
          reason: 'stopped without a terminal result',
        }),
        `ses_${i}:1`,
      );
    }

    waiting = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const first =
      (
        promptAsync.mock.calls as unknown as Array<
          [{ body: { parts: Array<{ text: string }> } }]
        >
      )[0]?.[0]?.body.parts[0]?.text ?? '';
    expect(first.match(/<stopped-job>/g)?.length).toBe(
      STOPPED_RECOVERY_WAKE_CHUNK,
    );
    expect(first).toContain('task: ses_0\n');
    expect(first).not.toContain(`task: ses_${STOPPED_RECOVERY_WAKE_CHUNK}\n`);

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const second =
      (
        promptAsync.mock.calls as unknown as Array<
          [{ body: { parts: Array<{ text: string }> } }]
        >
      )[1]?.[0]?.body.parts[0]?.text ?? '';
    expect(second).toContain(`task: ses_${STOPPED_RECOVERY_WAKE_CHUNK}\n`);
    expect(second).not.toContain('task: ses_0\n');
  });

  test('does not recover-wake when disabled, waiting for input, busy, or disposed', async () => {
    const cases = [
      createScheduler({ enabled: false }),
      createScheduler({ hasInputWait: () => true }),
      createScheduler({
        sessionClient: makeClient({ statusData: { p1: { type: 'busy' } } }),
      }),
      createScheduler(),
    ];
    const disposed = cases[3];
    await disposed?.scheduler.event({
      event: { type: 'server.instance.disposed' },
    });

    for (const item of cases) item?.scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);

    for (const item of cases) {
      expect(item?.session?.promptAsync).not.toHaveBeenCalled();
    }
  });
  test('does nothing when disabled', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      enabled: false,
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(120_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('is inactive when required session APIs are missing', async () => {
    const { scheduler } = createScheduler({
      sessionClient: {
        todo: mock(async () => ({ data: [{ status: 'pending' }] })),
      },
    });
    expect(scheduler._test.hasRequiredSessionApis()).toBe(false);
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(120_000);
    expect(clock.pendingCount()).toBe(0);
  });

  test('wakes after continuous idle interval with exact prompt text and directory query', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler, session } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(59_999);
    expect(promptAsync).not.toHaveBeenCalled();

    await clock.advance(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as {
      path: { id: string };
      query: { directory: string };
      body: {
        agent: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
        parts: Array<{ text: string }>;
      };
    };
    expect(call.path).toEqual({ id: 'p1' });
    expect(call.query).toEqual({ directory: '/project' });
    expect(call.body.agent).toBe('orchestrator');
    expect(call.body.model).toEqual({
      providerID: 'test',
      modelID: 'model-a',
    });
    expect(call.body.variant).toBeUndefined();
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );

    expect(session?.todo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'p1' },
        query: { directory: '/project' },
      }),
    );
    expect(session?.status).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { directory: '/project' },
      }),
    );
  });

  test('does not wake an archived v1 session', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        get: mock(async () => ({
          data: {
            time: { created: 1, updated: 1, archived: 123 },
          },
        })),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('treats a null archive timestamp as unarchived for v1', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        get: mock(async () => ({
          data: {
            time: { created: 1, updated: 1, archived: null },
          },
        })),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('archive update cancels an armed timer', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(clock.pendingCount()).toBe(1);

    await scheduler.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'p1', time: { archived: 123 } } },
      },
    });
    await clock.advance(60_000);

    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('archive update during evaluation blocks promptAsync', async () => {
    const promptAsync = mock(async () => ({}));
    let getCalls = 0;
    let releaseLatestGet!: () => void;
    const latestGet = new Promise<void>((resolve) => {
      releaseLatestGet = resolve;
    });
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        get: mock(async () => {
          if (getCalls++ === 1) await latestGet;
          return { data: { time: { created: 1, updated: 1 } } };
        }),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(getCalls).toBe(2);

    await scheduler.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'p1', time: { archived: 123 } } },
      },
    });
    releaseLatestGet();
    await clock.advance(0);

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('suppresses stopped-job recovery for an archived v1 session', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        get: mock(async () => ({
          data: { time: { created: 1, updated: 1, archived: 123 } },
        })),
      }),
    });

    scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('unarchive allows future normal lifecycle activity', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'p1', time: { archived: 123 } } },
      },
    });
    await scheduler.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'p1', time: { created: 1, updated: 2 } } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('unrelated session updates do not cancel the parent timer', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.updated',
        properties: { info: { id: 'other', time: { archived: 123 } } },
      },
    });
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('targets only orchestrator-managed sessions', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: (id) => id === 'orch',
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'child' } },
    });
    await clock.advance(120_000);
    expect(promptAsync).not.toHaveBeenCalled();

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'orch' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('suppresses a periodic wake when the initial snapshot has an active child', async () => {
    const promptAsync = mock(async () => ({}));
    let statusReads = 0;
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'child-1', time: { updated: 1 } }],
        status: mock(async () => ({
          data: statusReads++ === 0 ? { 'child-1': { type: 'busy' } } : {},
        })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('suppresses a periodic wake when a child becomes active before the latest snapshot', async () => {
    const promptAsync = mock(async () => ({}));
    let statusReads = 0;
    let releaseFirstGet!: () => void;
    const firstGet = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    let getCalls = 0;
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'child-1' }],
        status: mock(async () => ({
          data: statusReads++ === 0 ? {} : { 'child-1': { type: 'busy' } },
        })),
        get: mock(async () => {
          if (getCalls++ === 0) await firstGet;
          return {
            data: {
              model: { providerID: 'test', id: 'model-a', variant: 'high' },
            },
          };
        }),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(statusReads).toBe(1);

    releaseFirstGet();
    await clock.advance(0);

    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);
  });

  test('wakes when host children have no active status', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'child-1', time: { updated: 1 } }],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does not wake when parent is busy according to host status', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        statusData: { p1: { type: 'busy' } },
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not wake when todos are only completed or cancelled', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        todos: [
          { id: 't1', status: 'completed' },
          { id: 't2', status: 'cancelled' },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('fails closed on unknown todo status', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        todos: [
          { id: 't1', status: 'pending' },
          { id: 't2', status: 'blocked' },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('fails closed on malformed host responses', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        todo: mock(async () => ({ data: 'not-array' })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('suppresses on input wait, fallback, busy, and disposal without stuck in-flight', async () => {
    const promptAsync = mock(async () => ({}));
    let waiting = false;
    let fallback = false;
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
      hasInputWait: () => waiting,
      isFallbackInProgress: () => fallback,
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(clock.pendingCount()).toBe(1);

    waiting = true;
    scheduler.suppress('p1');
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);

    waiting = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    fallback = true;
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();

    fallback = false;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: { type: 'server.instance.disposed' },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('disposal releases a reservation blocked on host reads', async () => {
    let releaseReads!: () => void;
    const blockedReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const a = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({
        todo: mock(async () => {
          await blockedReads;
          return { data: [{ id: 't1', status: 'pending' }] };
        }),
        children: mock(async () => {
          await blockedReads;
          return { data: [] };
        }),
        status: mock(async () => {
          await blockedReads;
          return { data: {} };
        }),
      }),
    });
    const promptAsync = mock(async () => ({}));
    const b = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await a.scheduler.event({ event: { type: 'server.instance.disposed' } });

    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    releaseReads();
  });

  test('clears in-flight ownership when suppress races an evaluation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptAsync = mock(async () => {
      await gate;
      return {};
    });
    const todo = mock(async () => {
      await gate;
      return { data: [{ id: 't1', status: 'pending' }] };
    });
    const { scheduler } = createScheduler({
      intervalMs: 10_000,
      sessionClient: makeClient({
        promptAsync,
        todo,
        children: mock(async () => {
          await gate;
          return { data: [] };
        }),
        status: mock(async () => {
          await gate;
          return { data: {} };
        }),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(10_000);
    // Evaluation is blocked on host reads.
    scheduler.suppress('p1');
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A later idle must be able to claim in-flight again.
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(10_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('session deletion clears scheduled wakes via coordinator', async () => {
    const promptAsync = mock(async () => ({}));
    const coordinator = new SessionLifecycle(() => {});
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
      coordinator,
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    expect(clock.pendingCount()).toBe(1);
    coordinator.dispatchSessionDeleted('p1');
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('external user message re-arms and cancels pending wake', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'm1' },
      {
        message: { id: 'm1', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'continue please' }],
      },
    );
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(getWakeProgress('p1').stopped).toBe(false);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(0);
  });

  test('internal initiator parts do not re-arm as external user messages', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'm-internal' },
      {
        message: { id: 'm-internal', role: 'user', sessionID: 'p1' },
        parts: [createInternalAgentTextPart(ORCHESTRATOR_WAKE_TEXT)],
      },
    );
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('inject-no-rearm: injected non-operator nudges do not rearm the no-progress cap', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(getWakeProgress('p1').stopped).toBe(true);

    // task_message-style noReply nudge with an operator-looking text part.
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'nudge-1', noReply: true },
      {
        message: { id: 'nudge-1', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'status nudge' }],
      },
    );
    // v2 command-marker submit: plain text with no message identity.
    scheduler.observeChatMessage(
      { sessionID: 'p1' },
      {
        message: { role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: '/deepwork marker' }],
      },
    );
    // Board-tagged injection that lost its synthetic flag.
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'nudge-2' },
      {
        message: { id: 'nudge-2', role: 'user', sessionID: 'p1' },
        parts: [
          {
            type: 'text',
            text: 'board snapshot',
            metadata: { 'oh-my-opencode-slim.backgroundJobBoard': true },
          },
        ],
      },
    );
    expect(getWakeProgress('p1').stopped).toBe(true);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(2);

    // A genuine external operator message still rearms.
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'user-real' },
      {
        message: { id: 'user-real', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'keep going' }],
      },
    );
    expect(getWakeProgress('p1').stopped).toBe(false);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(0);
  });

  test('wake→busy→idle preserves the two-wake no-progress cap', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Realistic host reaction to promptAsync: busy then idle again.
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);

    // Cap stops further wakes even after another busy→idle from the second wake.
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);
  });

  test('distinct external user rearms the cap after two actual idle cycles', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(getWakeProgress('p1').stopped).toBe(true);

    // External user message rearms.
    scheduler.observeChatMessage(
      { sessionID: 'p1', messageID: 'user-rearm' },
      {
        message: { id: 'user-rearm', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'keep going' }],
      },
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  test('host-observed progress rearms the unchanged cap', async () => {
    const promptAsync = mock(async () => ({}));
    let todos: Array<Record<string, unknown>> = [
      { id: 't1', status: 'pending' },
    ];
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({
        promptAsync,
        todo: mock(async () => ({ data: todos })),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    // Simulate wake busy→idle without rearm (cap preserved at 1).
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    todos = [{ id: 't1', status: 'in_progress' }];
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    // Progress reset count; this is wake #1 of the new fingerprint.
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(1);
    expect(getWakeProgress('p1').stopped).toBe(false);
  });

  test('failed promptAsync does not storm retries within the interval', async () => {
    let calls = 0;
    const promptAsync = mock(async () => {
      calls += 1;
      throw new Error('boom');
    });
    const { scheduler } = createScheduler({
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(calls).toBe(1);
    await clock.advance(1_000);
    expect(calls).toBe(1);
    await clock.advance(59_000);
    expect(calls).toBe(2);
  });

  test('two hook instances share process-global in-flight and progress', async () => {
    const promptAsync = mock(async () => ({}));
    const client = makeClient({ promptAsync });
    const a = createScheduler({ sessionClient: client, intervalMs: 60_000 });
    const b = createScheduler({ sessionClient: client, intervalMs: 60_000 });

    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    // Two local timers may exist; process gate dedupes wakes.
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await a.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await b.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await a.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('disposing one hook leaves another hook’s shared progress cap intact', async () => {
    const promptAsync = mock(async () => ({}));
    const client = makeClient({ promptAsync });
    const a = createScheduler({ sessionClient: client, intervalMs: 60_000 });
    const b = createScheduler({ sessionClient: client, intervalMs: 60_000 });

    await a.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await a.scheduler.event({ event: { type: 'server.instance.disposed' } });
    await b.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await b.scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    await b.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('uses observed external model when session.get model is unavailable', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({
        promptAsync,
        get: mock(async () => {
          throw new Error('no model field');
        }),
      }),
    });
    scheduler.observeChatMessage(
      {
        sessionID: 'p1',
        messageID: 'm1',
        model: { providerID: 'obs', modelID: 'seen' },
        variant: 'low',
      },
      {
        message: { id: 'm1', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'go' }],
      },
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { directory: '/project' },
        body: expect.objectContaining({
          model: { providerID: 'obs', modelID: 'seen' },
        }),
      }),
    );
    const call = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { variant?: string } }]
      >
    )[0]?.[0];
    expect(call?.body.variant).toBeUndefined();
  });

  test('paired idle events do not create duplicate timers on one instance', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'idle' } },
      },
    });
    expect(clock.pendingCount()).toBe(1);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  describe('interrupted foreground-turn restart recovery', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-wake-restart-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function testContract(
      overrides: Partial<OutcomeContract> = {},
    ): OutcomeContract {
      return OutcomeContractSchema.parse({
        classification: 'non_trivial',
        objective: 'Test restart recovery',
        deliverables: ['deliverable'],
        goals: [
          {
            id: 'goal_1',
            description: 'Test goal',
            status: 'in_progress',
          },
        ],
        inScope: ['src/'],
        outOfScope: ['dist/'],
        constraints: ['No unreviewed volatile inputs'],
        safetyBoundaries: ['Never claim attestations are machine-verified'],
        handoffRequirements: ['Verification passes all test suites'],
        sourceMessageIds: ['msg_initial'],
        rules: [],
        exceptions: [],
        ...overrides,
      });
    }

    test('exact live regression: startup bootstrap scan recovers managed root orchestrator session interrupted by process restart', async () => {
      const root = 'ses_f960f4f75ffeV4OYrU2ctFdQ0K';
      const oldEpoch = 'epoch_restart_old';
      const newEpoch = 'epoch_restart_new';

      // 1. Setup durable outcome in prior epoch with running tool operation
      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
      });
      const beginRes = oldCtrl.begin(root, testContract());
      expect(beginRes.success).toBe(true);

      const toolInput = { command: 'npm test -- --watch' };
      const observeRes = oldCtrl.observeToolBefore(
        root,
        'call_fg_1',
        'bash',
        toolInput,
      );
      expect(observeRes.success).toBe(true);

      // New controller in new epoch
      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });

      // 2. Setup host session client
      const promptAsync = mock(async () => ({}));
      const messages = [
        {
          info: {
            id: 'msg_user_start',
            role: 'user',
            sessionID: root,
          },
          parts: [{ type: 'text', text: 'Run the tests' }],
        },
        {
          info: {
            id: 'msg_asst_interrupted',
            role: 'assistant',
            sessionID: root,
            modelID: 'claude-3-7-sonnet',
            providerID: 'anthropic',
            time: { created: 1000 },
          },
          parts: [
            {
              type: 'tool',
              id: 'tool_fg_completed',
              callID: 'call_fg_completed',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: '/project/package.json' },
                output: 'done',
                title: 'read package.json',
                metadata: {},
                time: { start: 900, end: 950 },
              },
            },
            {
              type: 'tool',
              id: 'call_fg_1',
              callID: 'call_fg_1',
              tool: 'bash',
              state: {
                status: 'running',
                input: toolInput,
                time: { start: 1005 },
              },
            },
          ],
        },
      ];

      const sessionClient = makeClient({
        listData: [
          { id: root, directory: '/project', time: { updated: 1000 } },
        ],
        get: mock(async () => ({
          data: {
            id: root,
            directory: '/project',
            parentID: undefined,
            model: { providerID: 'anthropic', id: 'claude-3-7-sonnet' },
          },
        })),
        statusData: {},
        todos: [{ id: 't1', status: 'in_progress' }],
        messagesData: messages,
        promptAsync,
      });

      const registeredAgents = new Map<string, string>();
      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: (id) =>
          registeredAgents.get(id) === 'orchestrator',
        registerSessionAsOrchestrator: (id) => {
          registeredAgents.set(id, 'orchestrator');
        },
        startupSettleDelayMs: 20,
      });

      // Before recovery: sessionMetadata is empty (unknown)
      expect(registeredAgents.has(root)).toBe(false);

      // Advance clock past startup settle delay
      await clock.advance(25);

      // Assert: promptAsync called with ORCHESTRATOR_RESTART_RECOVERY_TEXT
      expect(promptAsync).toHaveBeenCalledTimes(1);
      const promptArg = promptAsync.mock.calls[0]?.[0] as {
        body?: {
          parts?: Array<{ text?: string }>;
          model?: { providerID: string; modelID: string };
        };
      };
      expect(promptArg.body?.parts?.[0]?.text).toContain(
        'The previous OpenCode process was restarted while a foreground tool was running',
      );
      expect(promptArg.body?.parts?.[0]?.text).toContain(
        'must not be blindly re-executed',
      );
      expect(promptArg.body?.model).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-3-7-sonnet',
      });

      // Assert: registered in sessionMetadata as orchestrator
      expect(registeredAgents.get(root)).toBe('orchestrator');

      // Assert: durable operation was recovered to interrupted with standard error + unresolved action
      const rec = newCtrl.readRecord(root);
      expect(rec.success).toBe(true);
      if (!rec.success) return;
      const op = rec.data.operations.find((o) => o.callId === 'call_fg_1');
      expect(op?.status).toBe('interrupted');
      expect(op?.error).toBe('Operation interrupted by process restart');
      const action = rec.data.actionsRequired.find(
        (a) => a.resolvedAt === undefined,
      );
      expect(action).toBeDefined();

      // Assert: no external user receipt minted
      expect(rec.data.receipts.userMessages).toHaveLength(0);

      // Assert: never second prompt after success
      await scheduler.runStartupScan();
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    test('first idle/status event fallback recovers unknown session and shares process-global gate with startup scan', async () => {
      const root = 'ses_event_fallback_recovery';
      const oldEpoch = 'epoch_event_old';
      const newEpoch = 'epoch_event_new';

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
      });
      oldCtrl.begin(root, testContract());
      const toolInput = { command: 'cargo build' };
      oldCtrl.observeToolBefore(root, 'call_ev_1', 'bash', toolInput);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });

      const promptAsync = mock(async () => ({}));
      const messages = [
        {
          info: {
            id: 'm1',
            role: 'assistant',
            sessionID: root,
            time: { created: 100 },
          },
          parts: [
            {
              type: 'tool',
              id: 'tool_ev_1',
              callID: 'call_ev_1',
              tool: 'bash',
              state: {
                status: 'running',
                input: toolInput,
                time: { start: 105 },
              },
            },
          ],
        },
      ];

      const sessionClient = makeClient({
        listData: [], // Startup scan sees nothing
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID: undefined },
        })),
        statusData: {},
        todos: [{ id: 't1', status: 'pending' }],
        messagesData: messages,
        promptAsync,
      });

      const registeredAgents = new Map<string, string>();
      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: (id) =>
          registeredAgents.get(id) === 'orchestrator',
        registerSessionAsOrchestrator: (id) => {
          registeredAgents.set(id, 'orchestrator');
        },
        startupSettleDelayMs: 100, // Long delay so scan does not run before event
      });

      // Deliver first session.idle event to unknown session
      await scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: root } },
      });

      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(registeredAgents.get(root)).toBe('orchestrator');

      // Subsequent idle event does not second-prompt
      await scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: root } },
      });
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    test('second snapshot fences TODO and tool-input drift while preserving an exact retry', async () => {
      const root = 'ses_second_snapshot_drift';
      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_snapshot_old',
      });
      expect(oldCtrl.begin(root, testContract()).success).toBe(true);
      const durableInput = { command: 'gh run watch 123 --exit-status' };
      expect(
        oldCtrl.observeToolBefore(root, 'call_snapshot', 'bash', durableInput)
          .success,
      ).toBe(true);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_snapshot_new',
      });
      let todoReads = 0;
      let messageReads = 0;
      let drift: 'todo' | 'input' | 'none' = 'todo';
      const promptAsync = mock(async () => ({}));
      const sessionClient = makeClient({
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID: undefined },
        })),
        statusData: {},
        todo: mock(async () => {
          todoReads += 1;
          return {
            data:
              drift === 'todo' && todoReads % 2 === 0
                ? [{ id: 't1', status: 'completed' }]
                : [{ id: 't1', status: 'in_progress' }],
          };
        }),
        messages: mock(async () => {
          messageReads += 1;
          const input =
            drift === 'input' && messageReads % 2 === 0
              ? { command: 'gh run watch 999 --exit-status' }
              : durableInput;
          return {
            data: [
              {
                info: {
                  id: 'msg_snapshot',
                  role: 'assistant',
                  sessionID: root,
                  time: { created: 100 },
                },
                parts: [
                  {
                    type: 'tool',
                    id: 'tool_snapshot',
                    callID: 'call_snapshot',
                    tool: 'bash',
                    state: {
                      status: 'running',
                      input,
                      time: { start: 101 },
                    },
                  },
                ],
              },
            ],
          };
        }),
        promptAsync,
      });
      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });

      expect(
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(false);
      expect(promptAsync).not.toHaveBeenCalled();

      drift = 'input';
      todoReads = 0;
      messageReads = 0;
      expect(
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(false);
      expect(promptAsync).not.toHaveBeenCalled();

      drift = 'none';
      todoReads = 0;
      messageReads = 0;
      expect(
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(true);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    test('restart recovery waits for the configured second-snapshot settle window', async () => {
      const root = 'ses_snapshot_settle_window';
      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_settle_old',
      });
      expect(oldCtrl.begin(root, testContract()).success).toBe(true);
      const toolInput = { command: 'npm run ci:all' };
      expect(
        oldCtrl.observeToolBefore(root, 'call_settle', 'bash', toolInput)
          .success,
      ).toBe(true);
      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_settle_new',
      });
      const promptAsync = mock(async () => ({}));
      const { scheduler } = createScheduler({
        sessionClient: makeClient({
          get: mock(async () => ({
            data: { id: root, directory: '/project', parentID: undefined },
          })),
          statusData: {},
          todos: [{ id: 't1', status: 'pending' }],
          messagesData: [
            {
              info: {
                id: 'msg_settle',
                role: 'assistant',
                sessionID: root,
                time: { created: 100 },
              },
              parts: [
                {
                  type: 'tool',
                  id: 'tool_settle',
                  callID: 'call_settle',
                  tool: 'bash',
                  state: {
                    status: 'running',
                    input: toolInput,
                    time: { start: 101 },
                  },
                },
              ],
            },
          ],
          promptAsync,
        }),
        outcomeController: newCtrl,
        shouldManageSession: () => false,
        startupSettleDelayMs: 10_000,
        restartSnapshotSettleDelayMs: 250,
      });

      const recovery = scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      await clock.advance(0);
      expect(promptAsync).not.toHaveBeenCalled();
      await clock.advance(249);
      expect(promptAsync).not.toHaveBeenCalled();
      await clock.advance(1);
      expect(await recovery).toBe(true);
      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    test('rejects child sessions, completed turns, tool errors, pending tools, interactive tools, and argument mismatches', async () => {
      const root = 'ses_rejections_test';
      const oldEpoch = 'epoch_rej_old';
      const newEpoch = 'epoch_rej_new';

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
      });
      oldCtrl.begin(root, testContract());
      const toolInput = { cmd: 'run' };
      oldCtrl.observeToolBefore(root, 'call_r1', 'bash', toolInput);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });

      let parentID: string | undefined;
      let completedTime: number | undefined;
      let assistantError: unknown;
      let toolStateStatus = 'running';
      let toolName = 'bash';
      let callID = 'call_r1';
      let inputArgs: unknown = toolInput;
      let multipleTools = false;
      let messageID: string | undefined = 'asst_msg';
      let messageSessionID: string | undefined = root;
      let toolPartID: string | undefined = 'tool_r1';
      let toolStart: number | undefined = 105;
      let additionalToolStatus: unknown = 'running';

      const promptAsync = mock(async () => ({}));
      const sessionClient = makeClient({
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID },
        })),
        statusData: {},
        todos: [{ id: 't1', status: 'pending' }],
        messages: mock(async () => ({
          data: [
            {
              info: {
                id: messageID,
                role: 'assistant',
                sessionID: messageSessionID,
                time: { created: 100, completed: completedTime },
                error: assistantError,
              },
              parts: [
                {
                  type: 'tool',
                  id: toolPartID,
                  callID,
                  tool: toolName,
                  state: {
                    status: toolStateStatus,
                    input: inputArgs,
                    time: { start: toolStart },
                  },
                },
                ...(multipleTools
                  ? [
                      {
                        type: 'tool',
                        id: 'tool_r2',
                        callID: 'call_r2',
                        tool: 'bash',
                        state: {
                          status: additionalToolStatus,
                          input: { cmd: 'other' },
                          time: { start: 106 },
                        },
                      },
                    ]
                  : []),
              ],
            },
          ],
        })),
        promptAsync,
      });

      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });

      // 1. Child session rejected
      parentID = 'ses_parent_root';
      let success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      parentID = undefined;

      // 2. Completed assistant turn rejected
      completedTime = 200;
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      completedTime = undefined;

      // 3. Assistant error rejected
      assistantError = { message: 'Model error' };
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      assistantError = undefined;

      // 4. Multiple tool parts rejected
      multipleTools = true;
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      multipleTools = false;

      // 5. Malformed/unknown additional tool states are not terminal evidence.
      multipleTools = true;
      additionalToolStatus = 'unknown';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      additionalToolStatus = undefined;
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      multipleTools = false;
      additionalToolStatus = 'running';

      // 6. Pinned SDK pending state rejected
      toolStateStatus = 'pending';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);

      // 7. Tool completed state rejected
      toolStateStatus = 'completed';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);

      // 8. Tool error state rejected
      toolStateStatus = 'error';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      toolStateStatus = 'running';

      // 9. Interactive question tool rejected
      toolName = 'question';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);

      // 10. Interactive wait_for_user tool rejected
      toolName = 'wait_for_user';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);

      // 11. Permission/HITL tool rejected
      toolName = 'permission.ask';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      toolName = 'bash';

      // 12. Tool callID mismatch rejected
      callID = 'call_wrong';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      callID = 'call_r1';

      // 13. Tool argument digest mismatch rejected
      inputArgs = { cmd: 'different_cmd' };
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      inputArgs = toolInput;

      // 14. Missing assistant message ID rejected
      messageID = undefined;
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      messageID = 'asst_msg';

      // 15. Wrong/missing assistant session identity rejected
      messageSessionID = 'ses_other';
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      messageSessionID = root;

      // 16. Missing tool-part ID rejected
      toolPartID = undefined;
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      toolPartID = 'tool_r1';

      // 17. Missing running-state start time rejected
      toolStart = undefined;
      success = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(success).toBe(false);
      toolStart = 105;

      // No prompts were sent during all rejections
      expect(promptAsync).toHaveBeenCalledTimes(0);
    });

    test('coordination & caps: SDK failure cap at 2 attempts, bounded 256 scan, and cancellation on disposal', async () => {
      const root = 'ses_caps_test';
      const oldEpoch = 'epoch_caps_old';
      const newEpoch = 'epoch_caps_new';

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
      });
      oldCtrl.begin(root, testContract());
      const toolInput = { cmd: 'test' };
      oldCtrl.observeToolBefore(root, 'call_c1', 'bash', toolInput);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });

      const promptAsync = mock(async () => {
        throw new Error('SDK transport failure');
      });

      const messages = [
        {
          info: {
            id: 'm1',
            role: 'assistant',
            sessionID: root,
            time: { created: 100 },
          },
          parts: [
            {
              type: 'tool',
              id: 'tool_c1',
              callID: 'call_c1',
              tool: 'bash',
              state: {
                status: 'running',
                input: toolInput,
                time: { start: 105 },
              },
            },
          ],
        },
      ];

      const sessionClient = makeClient({
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID: undefined },
        })),
        statusData: {},
        todos: [{ id: 't1', status: 'pending' }],
        messagesData: messages,
        promptAsync,
      });

      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });

      // Attempt 1: SDK failure
      let res = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(res).toBe(false);
      expect(promptAsync).toHaveBeenCalledTimes(1);

      // Attempt 2: SDK failure
      observeWakeLifecycle(root, 'busy');
      observeWakeLifecycle(root, 'idle');
      res = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(res).toBe(false);
      expect(promptAsync).toHaveBeenCalledTimes(2);

      // Attempt 3: Suppressed by 2-attempt cap
      res = await scheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      expect(res).toBe(false);
      expect(promptAsync).toHaveBeenCalledTimes(2); // No 3rd call!

      // Disposal cancels delayed startup work
      const delayedScheduler = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: () => false,
        startupSettleDelayMs: 50,
      }).scheduler;
      expect(delayedScheduler._test.getStartupTimer()).toBeDefined();

      await delayedScheduler.event({
        event: { type: 'server.instance.disposed' },
      });
      expect(delayedScheduler._test.getStartupTimer()).toBeUndefined();
    });

    test('race between startup scan and event fallback triggers only one prompt', async () => {
      const root = 'ses_race_test';
      const oldEpoch = 'epoch_race_old';
      const newEpoch = 'epoch_race_new';

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
      });
      oldCtrl.begin(root, testContract());
      const toolInput = { run: 'parallel' };
      oldCtrl.observeToolBefore(root, 'call_race_1', 'bash', toolInput);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });

      const promptAsync = mock(async () => ({}));
      const messages = [
        {
          info: {
            id: 'm1',
            role: 'assistant',
            sessionID: root,
            time: { created: 100 },
          },
          parts: [
            {
              type: 'tool',
              id: 'tool_race_1',
              callID: 'call_race_1',
              tool: 'bash',
              state: {
                status: 'running',
                input: toolInput,
                time: { start: 105 },
              },
            },
          ],
        },
      ];

      const sessionClient = makeClient({
        listData: [
          { id: root, directory: '/project', time: { updated: 1000 } },
        ],
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID: undefined },
        })),
        statusData: {},
        todos: [{ id: 't1', status: 'pending' }],
        messagesData: messages,
        promptAsync,
      });

      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });

      // Concurrently run startup scan and idle event
      const p1 = scheduler.runStartupScan();
      const p2 = scheduler.event({
        event: { type: 'session.idle', properties: { sessionID: root } },
      });
      await Promise.all([p1, p2]);

      expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    test('bootstrap and Outcome idle wake coordination: cannot double-prompt', async () => {
      const root = 'ses_outcome_idle_race';
      const oldEpoch = 'epoch_outcome_idle_old';
      const newEpoch = 'epoch_outcome_idle_new';

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
      });
      oldCtrl.begin(root, testContract());
      const toolInput = { cmd: 'status' };
      oldCtrl.observeToolBefore(root, 'call_oi_1', 'bash', toolInput);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });

      const promptAsync = mock(async () => ({}));
      const sessionClient = makeClient({
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID: undefined },
        })),
        statusData: {},
        todos: [{ id: 't1', status: 'pending' }],
        messagesData: [
          {
            info: {
              id: 'm1',
              role: 'assistant',
              sessionID: root,
              time: { created: 100 },
            },
            parts: [
              {
                type: 'tool',
                id: 'tool_oi_1',
                callID: 'call_oi_1',
                tool: 'bash',
                state: {
                  status: 'running',
                  input: toolInput,
                  time: { start: 105 },
                },
              },
            ],
          },
        ],
        promptAsync,
      });

      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });

      // Run bootstrap recovery
      const recovered =
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        );
      expect(recovered).toBe(true);
      expect(promptAsync).toHaveBeenCalledTimes(1);

      // Now create OutcomeController hook on the same root session
      const outcomePromptAsync = mock(async () => ({}));
      const ctx = {
        directory: '/project',
        client: { session: { promptAsync: outcomePromptAsync } },
      };
      const outcomeHook = createOutcomeControllerHook(ctx as never, {
        controller: newCtrl,
        shouldManageSession: () => true,
      });

      // Outcome idle event arrives
      await outcomeHook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });

      // Outcome idle wake does NOT double-prompt because bootstrap already completed and wake is reserved
      expect(outcomePromptAsync).toHaveBeenCalledTimes(0);

      // The recovery prompt's immediate busy→idle lifecycle must not produce a
      // second Outcome prompt. Periodic recovery may re-evaluate later.
      await outcomeHook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'busy' } },
        },
      });
      await outcomeHook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });
      expect(outcomePromptAsync).toHaveBeenCalledTimes(0);
    });

    test('failed Outcome idle wake releases shared markers so bootstrap recovery can claim', async () => {
      const root = 'ses_outcome_prompt_failure_release';
      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_outcome_failure_old',
      });
      expect(oldCtrl.begin(root, testContract()).success).toBe(true);
      const toolInput = { command: 'gh run watch 456 --exit-status' };
      expect(
        oldCtrl.observeToolBefore(
          root,
          'call_outcome_failure',
          'bash',
          toolInput,
        ).success,
      ).toBe(true);
      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_outcome_failure_new',
      });
      expect(newCtrl.readRecord(root).success).toBe(true);

      const failingOutcomePrompt = mock(async () => {
        throw new Error('transport down');
      });
      const outcomeHook = createOutcomeControllerHook(
        {
          directory: '/project',
          client: { session: { promptAsync: failingOutcomePrompt } },
        } as never,
        { controller: newCtrl, shouldManageSession: () => true },
      );
      await outcomeHook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });
      expect(failingOutcomePrompt).toHaveBeenCalledTimes(1);
      observeWakeLifecycle(root, 'busy');
      observeWakeLifecycle(root, 'idle');

      let preAwaitEvents: (() => Promise<void>) | undefined;
      const bootstrapPrompt = mock(async () => {
        expect(getWakeProgress(root).unchangedWakeCount).toBe(2);
        expect(getWakeProgress(root).expectingWakeBusy).toBe(true);
        await preAwaitEvents?.();
        return {};
      });
      const { scheduler } = createScheduler({
        sessionClient: makeClient({
          get: mock(async () => ({
            data: { id: root, directory: '/project', parentID: undefined },
          })),
          statusData: {},
          todos: [{ id: 't1', status: 'in_progress' }],
          messagesData: [
            {
              info: {
                id: 'msg_outcome_failure',
                role: 'assistant',
                sessionID: root,
                time: { created: 100 },
              },
              parts: [
                {
                  type: 'tool',
                  id: 'tool_outcome_failure',
                  callID: 'call_outcome_failure',
                  tool: 'bash',
                  state: {
                    status: 'running',
                    input: toolInput,
                    time: { start: 101 },
                  },
                },
              ],
            },
          ],
          promptAsync: bootstrapPrompt,
        }),
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });
      preAwaitEvents = async () => {
        for (const type of ['busy', 'retry', 'idle', 'idle']) {
          const event = {
            event: {
              type: 'session.status',
              properties: { sessionID: root, status: { type } },
            },
          };
          await outcomeHook.event(event);
          await scheduler.event(event);
        }
      };
      expect(
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(true);
      expect(bootstrapPrompt).toHaveBeenCalledTimes(1);
      expect(failingOutcomePrompt).toHaveBeenCalledTimes(1);
    });

    test('disposal during the second snapshot prevents stale prompt and replacement instance can recover', async () => {
      const root = 'ses_disposal_mid_recovery';
      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_dispose_old',
      });
      expect(oldCtrl.begin(root, testContract()).success).toBe(true);
      const toolInput = { command: 'npm run verify' };
      expect(
        oldCtrl.observeToolBefore(root, 'call_dispose', 'bash', toolInput)
          .success,
      ).toBe(true);
      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_dispose_new',
      });
      let statusCalls = 0;
      let releaseSecondStatus: (() => void) | undefined;
      const secondStatusStarted = new Promise<void>((resolve) => {
        releaseSecondStatus = resolve;
      });
      let unblockSecondStatus: (() => void) | undefined;
      const blockedStatus = new Promise<void>((resolve) => {
        unblockSecondStatus = resolve;
      });
      const stalePrompt = mock(async () => ({}));
      const sessionData = {
        get: mock(async () => ({
          data: { id: root, directory: '/project', parentID: undefined },
        })),
        status: mock(async () => {
          statusCalls += 1;
          if (statusCalls === 2) {
            releaseSecondStatus?.();
            await blockedStatus;
          }
          return { data: {} };
        }),
        todos: [{ id: 't1', status: 'in_progress' }],
        messagesData: [
          {
            info: {
              id: 'msg_dispose',
              role: 'assistant',
              sessionID: root,
              time: { created: 100 },
            },
            parts: [
              {
                type: 'tool',
                id: 'tool_dispose',
                callID: 'call_dispose',
                tool: 'bash',
                state: {
                  status: 'running',
                  input: toolInput,
                  time: { start: 101 },
                },
              },
            ],
          },
        ],
      };
      const oldScheduler = createScheduler({
        sessionClient: makeClient({ ...sessionData, promptAsync: stalePrompt }),
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      }).scheduler;
      const inFlight = oldScheduler._test.classifyAndRecoverInterruptedSession(
        root,
        'bootstrap',
      );
      await secondStatusStarted;
      await oldScheduler.event({ event: { type: 'server.instance.disposed' } });
      unblockSecondStatus?.();
      expect(await inFlight).toBe(false);
      expect(stalePrompt).not.toHaveBeenCalled();

      const replacementPrompt = mock(async () => ({}));
      const replacement = createScheduler({
        sessionClient: makeClient({
          ...sessionData,
          status: mock(async () => ({ data: {} })),
          promptAsync: replacementPrompt,
        }),
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      }).scheduler;
      expect(
        await replacement._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(true);
      expect(replacementPrompt).toHaveBeenCalledTimes(1);
    });

    test('final durable recheck suppresses acknowledgement or wait races', async () => {
      for (const race of ['acknowledge', 'wait'] as const) {
        const root = `ses_final_durable_${race}`;
        const oldCtrl = new OutcomeController({
          storeDirectory: tempDir,
          serverEpoch: `epoch_final_${race}_old`,
        });
        expect(oldCtrl.begin(root, testContract()).success).toBe(true);
        const toolInput = { command: `verify-${race}` };
        const observed = oldCtrl.observeToolBefore(
          root,
          `call_final_${race}`,
          'bash',
          toolInput,
        );
        expect(observed.success).toBe(true);
        if (!observed.success) continue;

        const newCtrl = new OutcomeController({
          storeDirectory: tempDir,
          serverEpoch: `epoch_final_${race}_new`,
        });
        let statusCalls = 0;
        const promptAsync = mock(async () => ({}));
        const sessionClient = makeClient({
          get: mock(async () => ({
            data: { id: root, directory: '/project', parentID: undefined },
          })),
          status: mock(async () => {
            statusCalls += 1;
            if (statusCalls === 3) {
              if (race === 'acknowledge') {
                expect(
                  newCtrl.acknowledgeOperation(root, {
                    operationId: observed.data.operationId,
                  }).success,
                ).toBe(true);
              } else {
                expect(
                  newCtrl.externalHandoff(root, {
                    instructions: 'Wait for explicit external recovery',
                    expectedPostRestartCheck: 'Verify recovery manually',
                  }).success,
                ).toBe(true);
              }
            }
            return { data: {} };
          }),
          todos: [{ id: 't1', status: 'in_progress' }],
          messagesData: [
            {
              info: {
                id: `msg_final_${race}`,
                role: 'assistant',
                sessionID: root,
                time: { created: 100 },
              },
              parts: [
                {
                  type: 'tool',
                  id: `tool_final_${race}`,
                  callID: `call_final_${race}`,
                  tool: 'bash',
                  state: {
                    status: 'running',
                    input: toolInput,
                    time: { start: 101 },
                  },
                },
              ],
            },
          ],
          promptAsync,
        });
        const { scheduler } = createScheduler({
          sessionClient,
          outcomeController: newCtrl,
          shouldManageSession: () => false,
        });
        expect(
          await scheduler._test.classifyAndRecoverInterruptedSession(
            root,
            'bootstrap',
          ),
        ).toBe(false);
        expect(promptAsync).not.toHaveBeenCalled();
      }
    });

    test('final status recheck suppresses a child that becomes active after snapshot two', async () => {
      const root = 'ses_final_child_race';
      const child = 'ses_final_child';
      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_child_race_old',
      });
      expect(oldCtrl.begin(root, testContract()).success).toBe(true);
      const toolInput = { command: 'verify-child-race' };
      expect(
        oldCtrl.observeToolBefore(root, 'call_child_race', 'bash', toolInput)
          .success,
      ).toBe(true);
      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_child_race_new',
      });
      let statusCalls = 0;
      const promptAsync = mock(async () => ({}));
      const { scheduler } = createScheduler({
        sessionClient: makeClient({
          get: mock(async () => ({
            data: { id: root, directory: '/project', parentID: undefined },
          })),
          status: mock(async () => {
            statusCalls += 1;
            return {
              data: statusCalls === 3 ? { [child]: { type: 'busy' } } : {},
            };
          }),
          childrenData: [{ id: child, time: { created: 50, updated: 50 } }],
          todos: [{ id: 't1', status: 'in_progress' }],
          messagesData: [
            {
              info: {
                id: 'msg_child_race',
                role: 'assistant',
                sessionID: root,
                time: { created: 100 },
              },
              parts: [
                {
                  type: 'tool',
                  id: 'tool_child_race',
                  callID: 'call_child_race',
                  tool: 'bash',
                  state: {
                    status: 'running',
                    input: toolInput,
                    time: { start: 101 },
                  },
                },
              ],
            },
          ],
          promptAsync,
        }),
        outcomeController: newCtrl,
        shouldManageSession: () => false,
      });
      expect(
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(false);
      expect(promptAsync).not.toHaveBeenCalled();
    });

    test('bounded startup scan: filters child sessions, sorts newest first, and caps at 256 roots', async () => {
      const scanned: string[] = [];
      const promptAsync = mock(async () => ({}));

      // Generate 300 sessions: 280 roots and 20 children
      const allSessions: Array<{
        id: string;
        parentID?: string;
        time: { updated: number };
      }> = [];
      for (let i = 1; i <= 300; i++) {
        allSessions.push({
          id: `ses_root_${i}`,
          parentID: i % 15 === 0 ? 'ses_parent' : undefined,
          directory: '/project',
          time: { updated: i * 1000 },
        });
      }

      const sessionClient = makeClient({
        listData: allSessions,
        get: mock(async (req: { path?: { id?: string } }) => {
          if (req.path?.id) scanned.push(req.path.id);
          return {
            data: {
              id: req.path?.id,
              directory: '/project',
              parentID: undefined,
            },
          };
        }),
        statusData: {},
        todos: [],
        promptAsync,
      });

      const { scheduler } = createScheduler({
        sessionClient,
        outcomeController: new OutcomeController({
          storeDirectory: tempDir,
          serverEpoch: 'epoch_scan',
        }),
        shouldManageSession: () => false,
        maxBootstrapRoots: 999,
      });

      await scheduler.runStartupScan();

      // Scanned count should not exceed 256 roots
      expect(scanned.length).toBeLessThanOrEqual(256);
      // Children were excluded (e.g. ses_root_15)
      expect(scanned).not.toContain('ses_root_15');
      expect(scanned).not.toContain('ses_root_30');
      // Newest sessions scanned first
      const idx299 = scanned.indexOf('ses_root_299');
      const idx50 = scanned.indexOf('ses_root_50');
      if (idx299 !== -1 && idx50 !== -1) {
        expect(idx299).toBeLessThan(idx50);
      }
    });

    test('validates pinned SDK ToolStatePending vs ToolStateRunning distinction through fixture types', () => {
      type ToolStatePendingFixture = {
        status: 'pending';
        input: Record<string, unknown>;
        raw: string;
      };
      type ToolStateRunningFixture = {
        status: 'running';
        input: Record<string, unknown>;
        title?: string;
        metadata?: Record<string, unknown>;
        time: { start: number };
      };

      const pendingState: ToolStatePendingFixture = {
        status: 'pending',
        input: { cmd: 'test' },
        raw: '{"cmd":"test"}',
      };

      const runningState: ToolStateRunningFixture = {
        status: 'running',
        input: { cmd: 'test' },
        time: { start: 1000 },
      };

      expect(pendingState.status).toBe('pending');
      expect(runningState.status).toBe('running');
      expect(typeof runningState.time.start).toBe('number');
    });
  });
});

describe('session API capability probe', () => {
  test('v1 requires the exact historical probe set (get/todo/children/status/promptAsync)', () => {
    const base = makeClient() as Record<string, unknown>;
    expect(
      createScheduler({
        sessionClient: base as SessionClient,
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(true); // list is NOT required on v1

    for (const key of ['get', 'todo', 'children', 'status', 'promptAsync']) {
      const partial = { ...base };
      delete partial[key];
      expect(
        createScheduler({
          sessionClient: partial as SessionClient,
        }).scheduler._test.hasRequiredSessionApis(),
      ).toBe(false);
    }
  });

  test('v2 requires only list + promptAsync; get is optional', () => {
    expect(
      createScheduler({
        hostFlavor: 'v2',
        sessionClient: makeV2Client(),
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(true);
    expect(
      createScheduler({
        hostFlavor: 'v2',
        sessionClient: makeV2Client({ omitList: true }),
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(false);
    expect(
      createScheduler({
        hostFlavor: 'v2',
        sessionClient: { list: mock(async () => ({ data: [] })) },
      }).scheduler._test.hasRequiredSessionApis(),
    ).toBe(false);
  });

  test('v2 without todo resolves auto to children-driven mode', () => {
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      sessionClient: makeV2Client(),
    });
    expect(scheduler._test.wakeMode()).toBe('children');
    expect(scheduler._test.capabilities().flavor).toBe('v2');
  });

  test('explicit todo mode on v2 degrades to children; children pins children', () => {
    expect(
      createScheduler({
        hostFlavor: 'v2',
        mode: 'todo',
        sessionClient: makeV2Client(),
      }).scheduler._test.wakeMode(),
    ).toBe('children');
    expect(
      createScheduler({
        hostFlavor: 'v2',
        mode: 'children',
        sessionClient: makeV2Client(),
      }).scheduler._test.wakeMode(),
    ).toBe('children');
    // v1 with a todo API keeps explicit todo mode.
    expect(createScheduler({ mode: 'todo' }).scheduler._test.wakeMode()).toBe(
      'todo',
    );
    expect(
      createScheduler({ mode: 'children' }).scheduler._test.wakeMode(),
    ).toBe('children');
    expect(createScheduler().scheduler._test.wakeMode()).toBe('todo');
  });

  test('resolveWakeMode: auto maps per flavor; todo degrades without the todo API', () => {
    expect(resolveWakeMode('auto', { flavor: 'v1', hasTodo: true })).toBe(
      'todo',
    );
    expect(resolveWakeMode('auto', { flavor: 'v2', hasTodo: false })).toBe(
      'children',
    );
    expect(resolveWakeMode(undefined, { flavor: 'v1', hasTodo: true })).toBe(
      'todo',
    );
    expect(resolveWakeMode('todo', { flavor: 'v1', hasTodo: false })).toBe(
      'children',
    );
    expect(resolveWakeMode('children', { flavor: 'v1', hasTodo: true })).toBe(
      'children',
    );
  });
});

describe('children-driven degraded mode (v2)', () => {
  test('wakes with active children using the children wake text and queue delivery', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler, session } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          {
            id: 'child-1',
            parentID: 'p1',
            directory: '/project',
            time: { updated: Date.now() },
          },
        ],
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      path: { id: string };
      query: { directory: string };
      delivery?: string;
      body: { agent: string; parts: Array<{ text: string }> };
    };
    expect(call.path).toEqual({ id: 'p1' });
    expect(call.query).toEqual({ directory: '/project' });
    expect(call.delivery).toBe('queue');
    expect(call.body.agent).toBe('orchestrator');
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_CHILDREN_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
    expect(session?.list).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { parentID: 'p1', directory: '/project' },
      }),
    );
  });

  test('v2 children wake carries the session model variant as modelVariant', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
        get: mock(async () => ({
          data: {
            model: { providerID: 'test', id: 'model-a', variant: 'max' },
          },
        })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as { modelVariant?: string };
    expect(call.modelVariant).toBe('max');
  });

  test('v2 children wake does not mix a new model with a leftover variant', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      resolveSelection: async () => ({
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-b' },
        provenance: 'host-persisted',
      }),
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
        get: mock(async () => ({
          data: {
            model: { providerID: 'test', id: 'model-a', variant: 'high' },
          },
        })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      modelVariant?: string;
      body: { model?: { providerID: string; modelID: string } };
    };
    expect(call.body.model).toEqual({
      providerID: 'test',
      modelID: 'model-b',
    });
    expect(call.modelVariant).toBeUndefined();
  });

  test('v2 children wake omits modelVariant when the model has none', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
        get: mock(async () => ({ data: {} })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as { modelVariant?: string; body: { model?: unknown } };
    expect(call.body.model).toBeUndefined();
    expect(call.modelVariant).toBeUndefined();
  });

  test('does not wake an archived v2 session', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
        get: mock(async () => ({
          data: { time: { created: 1, updated: 1, archived: 123 } },
        })),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('treats a null archive timestamp as unarchived for v2', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
        get: mock(async () => ({
          data: {
            time: { created: 1, updated: 1, archived: null },
          },
        })),
      }),
    });

    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[{ delivery?: string }]>
    )[0]?.[0];
    expect(call?.delivery).toBe('queue');
  });

  test('v2 without get uses observed archive state and preserves queue delivery', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
      }),
    });

    await scheduler.event({
      event: {
        type: 'session.updated',
        data: { sessionID: 'p1', time: { archived: 123 } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();

    await scheduler.event({
      event: {
        type: 'session.updated',
        data: { sessionID: 'p1', time: { created: 1, updated: 2 } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[{ delivery?: string }]>
    )[0]?.[0];
    expect(call?.delivery).toBe('queue');
  });

  test('does not wake when every child has a terminal outcome', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          { id: 'c1', outcome: 'succeeded', time: { updated: Date.now() } },
          { id: 'c2', outcome: 'failed', time: { updated: Date.now() } },
          { id: 'c3', outcome: 'interrupted', time: { updated: Date.now() } },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('treats a child as inactive once its update evidence is stale', async () => {
    const promptAsync = mock(async () => ({}));
    const stalenessMs = 60_000 * CHILD_STALENESS_INTERVALS;
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [
          { id: 'c1', time: { updated: Date.now() - stalenessMs - 1 } },
        ],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('scopes children to the session workspace via reported directory', async () => {
    const promptAsyncLocal = mock(async () => ({}));
    const fresh = () => Date.now();
    const local = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync: promptAsyncLocal,
        listChildren: [
          { id: 'c-local', directory: '/project', time: { updated: fresh() } },
          {
            id: 'c-other',
            directory: '/elsewhere',
            time: { updated: fresh() },
          },
        ],
      }),
    });
    await local.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsyncLocal).toHaveBeenCalledTimes(1); // local child qualifies

    // Only a foreign-directory child: scoped out → no wake, spell ends.
    const promptAsyncOther = mock(async () => ({}));
    const other = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync: promptAsyncOther,
        listChildren: [
          {
            id: 'c-other',
            directory: '/elsewhere',
            time: { updated: fresh() },
          },
        ],
      }),
    });
    await other.scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p2' } },
    });
    await clock.advance(60_000);
    expect(promptAsyncOther).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('stops after the unchanged cap when children make no progress', async () => {
    const promptAsync = mock(async () => ({}));
    const frozen = Date.now();
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: frozen } }],
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);
    expect(getWakeProgress('p1').stopped).toBe(true);
    await clock.advance(180_000);
    expect(promptAsync).toHaveBeenCalledTimes(ORCHESTRATOR_WAKE_UNCHANGED_CAP);
  });

  test('child update progress resets the unchanged cap', async () => {
    const promptAsync = mock(async () => ({}));
    let updated = Date.now();
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listImpl: mock(async () => ({
          data: [{ id: 'c1', time: { updated } }],
        })),
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    // Each interval the host reports fresh child progress: every wake sees a
    // new fingerprint, so the two-wake cap keeps resetting.
    updated += 5_000;
    await clock.advance(60_000);
    updated += 5_000;
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(getWakeProgress('p1').stopped).toBe(false);
    expect(getWakeProgress('p1').unchangedWakeCount).toBe(1);
  });

  test('recovery wake bypasses the children condition', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    scheduler.triggerStoppedJobRecovery('p1');
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<
        [{ body: { parts: Array<{ text: string }> }; delivery?: string }]
      >
    )[0]?.[0];
    expect(call?.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
    expect(call?.delivery).toBe('queue');
  });

  test('parent-active race guard: tracked busy parent blocks the wake', async () => {
    const promptAsync = mock(async () => ({}));
    let managed = false;
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      shouldManageSession: (id) => managed && id === 'p1',
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1', time: { updated: Date.now() } }],
      }),
    });
    // Busy while unmanaged: endIdleSpell does not run, but the status is
    // tracked (the race-guard source on hosts without a status map).
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'p1', status: { type: 'busy' } },
      },
    });
    managed = true;
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
    expect(scheduler._test.lastStatusBySession.get('p1')?.status).toBe('busy');
  });

  test('event-tracked busy-set marks a child active without list evidence', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1' }], // no time fields at all
      }),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'c1', status: { type: 'busy' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('stale tracked busy child is bounded by the staleness window', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listChildren: [{ id: 'c1' }],
      }),
    });
    await scheduler.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'c1', status: { type: 'busy' } },
      },
    });
    // Backdate the tracked evidence past the staleness bound.
    scheduler._test.lastStatusBySession.set('c1', {
      status: 'busy',
      at: Date.now() - 60_000 * CHILD_STALENESS_INTERVALS - 1,
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('children enumeration fallback (v2)', () => {
  test('falls back to event-tracked bookkeeping when the list yields nothing', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    // Synthesized v1-shape session.created carrying parentID.
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('accepts the raw flat v2 session.created shape too', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 'c1', parentID: 'p1' },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('falls back when session.list rejects', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({
        promptAsync,
        listImpl: mock(async () => {
          throw new Error('list unavailable');
        }),
      }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('event child gone stale no longer wakes', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    scheduler._test.childEvidence.set(
      'c1',
      Date.now() - 60_000 * CHILD_STALENESS_INTERVALS - 1,
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('session.deleted forgets event-tracked children', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'c1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(scheduler._test.childEvidence.has('c1')).toBe(false);
  });

  test('terminal outcome from session.get suppresses the fallback wake', async () => {
    const promptAsync = mock(async () => ({}));
    const get = mock(async () => ({
      data: { outcome: 'succeeded', time: { updated: Date.now() } },
    }));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [], get }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  test('fallback child without an outcome still wakes on fresh evidence', async () => {
    const promptAsync = mock(async () => ({}));
    const get = mock(async () => ({
      data: { time: { updated: Date.now() } },
    }));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [], get }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('session.get failure keeps the evidence-based fallback verdict', async () => {
    const promptAsync = mock(async () => ({}));
    const get = mock(async () => {
      throw new Error('get unavailable');
    });
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [], get }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('session.get unavailable leaves the event-tracked fallback unchanged', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [] }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('host evidence keeps a child active despite stale local evidence', async () => {
    const promptAsync = mock(async () => ({}));
    const get = mock(async () => ({
      data: { time: { updated: Date.now() } },
    }));
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [], get }),
    });
    await scheduler.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      },
    });
    // The event-tracked evidence goes stale, but the child is still running
    // and the host reports fresh time.updated — it must not drop out of the
    // watchdog on stale local evidence alone.
    scheduler._test.childEvidence.set(
      'c1',
      Date.now() - 60_000 * CHILD_STALENESS_INTERVALS - 1,
    );
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('mixed fallback children: terminal suppressed, running wakes, get failure is fail-soft', async () => {
    const promptAsync = mock(async () => ({}));
    const get = mock(async (args: { path?: { id?: string } }) => {
      const id = args?.path?.id;
      if (id === 'c-terminal') {
        return {
          data: { outcome: 'succeeded', time: { updated: Date.now() } },
        };
      }
      if (id === 'c-running') {
        return { data: { time: { updated: Date.now() } } };
      }
      if (id === 'c-throws') throw new Error('get unavailable');
      return { data: {} };
    });
    const { scheduler } = createScheduler({
      hostFlavor: 'v2',
      intervalMs: 60_000,
      sessionClient: makeV2Client({ promptAsync, listChildren: [], get }),
    });
    for (const id of ['c-terminal', 'c-running', 'c-throws']) {
      await scheduler.event({
        event: {
          type: 'session.created',
          properties: { info: { id, parentID: 'p1' } },
        },
      });
    }
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('wakes a non-orchestrator parent in its current selection when delegated work is pending', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: (id) => id === 'orch',
      hasPendingDelegatedWork: (id) => id === 'plan',
      resolveSelection: async () => ({
        agent: 'plan',
        model: { providerID: 'test', modelID: 'plan-model' },
        variant: 'max',
        provenance: 'host-persisted',
      }),
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'plan' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      body: {
        agent: string;
        model?: { providerID: string; modelID: string };
      };
    };
    expect(call.body.agent).toBe('plan');
    expect(call.body.model).toEqual({
      providerID: 'test',
      modelID: 'plan-model',
    });
  });

  test('does not wake a non-orchestrator parent with no delegated work', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: (id) => id === 'orch',
      hasPendingDelegatedWork: () => false,
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'plan' } },
    });
    await clock.advance(120_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('recovers a stopped job on a Plan parent with pending delegated work', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: () => false,
      hasPendingDelegatedWork: (id) => id === 'plan',
      resolveSelection: async () => ({
        agent: 'plan',
        provenance: 'observed-external',
      }),
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });
    scheduler.triggerStoppedJobRecovery('plan');
    await clock.advance(0);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as { body: { agent: string } };
    expect(call.body.agent).toBe('plan');
  });

  test('does not mix a new model with a leftover variant from another model', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: () => true,
      resolveSelection: async () => ({
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-b' },
        provenance: 'host-persisted',
      }),
      sessionClient: makeClient({
        promptAsync,
        model: { providerID: 'test', id: 'model-a', variant: 'high' },
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      modelVariant?: string;
      body: { model?: { providerID: string; modelID: string } };
    };
    expect(call.body.model).toEqual({
      providerID: 'test',
      modelID: 'model-b',
    });
    expect(call.modelVariant).toBeUndefined();
  });

  test('aborts the wake when an external message arrives during selection resolve', async () => {
    const promptAsync = mock(async () => ({}));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler } = createScheduler({
      shouldManageSession: () => true,
      resolveSelection: async () => {
        await gate;
        return { agent: 'orchestrator', provenance: 'host-persisted' };
      },
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    scheduler.observeChatMessage(
      {
        sessionID: 'p1',
        messageID: 'm-user',
        model: { providerID: 'obs', modelID: 'seen' },
      },
      {
        message: { id: 'm-user', role: 'user', sessionID: 'p1' },
        parts: [{ type: 'text', text: 'user typed' }],
      },
    );
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not wake Plan when host selection is Plan and no delegated work remains', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      shouldManageSession: () => true,
      hasPendingDelegatedWork: () => false,
      resolveSelection: async () => ({
        agent: 'plan',
        provenance: 'host-persisted',
      }),
      sessionClient: makeClient({ promptAsync }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('drops a stop fact that goes stale during selection resolve', async () => {
    const promptAsync = mock(async () => ({}));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = new Set(['ses_stale:1']);
    const { scheduler } = createScheduler({
      isStoppedJobRecoveryCurrent: (taskID, generation) =>
        current.has(`${taskID}:${generation}`),
      hasPendingDelegatedWork: () => true,
      resolveSelection: async () => {
        await gate;
        return { agent: 'orchestrator', provenance: 'host-persisted' };
      },
      sessionClient: makeClient({
        todos: [],
        promptAsync,
        childrenData: [{ id: 'child-2' }],
        statusData: { 'child-2': { type: 'busy' } },
      }),
    });
    scheduler.triggerStoppedJobRecovery(
      'p1',
      formatStoppedJobDelta({
        alias: 'ses_stale',
        taskID: 'ses_stale',
        generation: 1,
        state: 'stopped',
        reason: 'stopped without a terminal result',
      }),
      'ses_stale:1',
    );
    await clock.advance(0);
    current.delete('ses_stale:1');
    release?.();
    // Drain microtasks past the resolver continuation, the post-await
    // guards and the second prune before asserting the negative (#1079
    // Oracle r3 P2: two ticks could observe the pre-await state).
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(promptAsync).not.toHaveBeenCalled();
  });
});

describe('children mode on v1 (explicit opt-in)', () => {
  test('enumerates via session.children and keeps the v1 promptAsync call shape', async () => {
    const promptAsync = mock(async () => ({}));
    const children = mock(async () => ({
      data: [{ id: 'c1', time: { updated: Date.now() } }],
    }));
    const status = mock(async () => ({ data: {} }));
    const { scheduler } = createScheduler({
      mode: 'children',
      intervalMs: 60_000,
      sessionClient: makeClient({ promptAsync, children, status }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = (
      promptAsync.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as {
      delivery?: string;
      modelVariant?: string;
      body: { parts: Array<{ text: string }> };
    };
    expect(call.delivery).toBeUndefined(); // v1 call shape unchanged
    // The default makeClient get reports a 'high' variant; v1 must still
    // never receive the v2-only modelVariant argument.
    expect(call.modelVariant).toBeUndefined();
    expect(call.body.parts[0]?.text).toBe(
      `${ORCHESTRATOR_CHILDREN_WAKE_TEXT}\n<!-- SLIM_INTERNAL_INITIATOR -->`,
    );
  });

  test('v1 status-map parent activity ends the idle spell', async () => {
    const promptAsync = mock(async () => ({}));
    const { scheduler } = createScheduler({
      mode: 'children',
      intervalMs: 60_000,
      sessionClient: makeClient({
        promptAsync,
        childrenData: [{ id: 'c1', time: { updated: Date.now() } }],
        statusData: { p1: { type: 'busy' } },
      }),
    });
    await scheduler.event({
      event: { type: 'session.idle', properties: { sessionID: 'p1' } },
    });
    await clock.advance(60_000);
    expect(promptAsync).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('children-mode helpers', () => {
  test('childUpdateEvidenceMs follows the update-evidence cascade numerically', () => {
    expect(
      childUpdateEvidenceMs({ id: 'c', time: { updated: 42, created: 1 } }),
    ).toBe(42);
    expect(childUpdateEvidenceMs({ id: 'c', updatedAt: 7 })).toBe(7);
    expect(childUpdateEvidenceMs({ id: 'c', time: { created: 3 } })).toBe(3);
    expect(childUpdateEvidenceMs({ id: 'c', time: { updated: 'x' } })).toBe(
      undefined,
    );
    expect(childUpdateEvidenceMs({ id: 'c' })).toBe(undefined);
  });

  test('mapWakeChild copies id/outcome/directory/evidence and drops unknowns', () => {
    expect(
      mapWakeChild({
        id: 'c1',
        outcome: 'succeeded',
        directory: '/project',
        time: { updated: 10 },
      }),
    ).toEqual({
      id: 'c1',
      outcome: 'succeeded',
      directory: '/project',
      evidenceAt: 10,
    });
    expect(mapWakeChild({ nope: 1 })).toBeUndefined();
    expect(mapWakeChild({ id: '' })).toBeUndefined();
  });

  test('isWakeChildActive: outcome wins, freshness bounds both branches', () => {
    const now = 1_000_000;
    const staleness = 180_000;
    expect(
      isWakeChildActive(
        { id: 'c', outcome: 'failed', evidenceAt: now },
        undefined,
        now,
        staleness,
      ),
    ).toBe(false);
    expect(
      isWakeChildActive(
        { id: 'c', evidenceAt: now - staleness },
        undefined,
        now,
        staleness,
      ),
    ).toBe(true);
    expect(
      isWakeChildActive(
        { id: 'c', evidenceAt: now - staleness - 1 },
        undefined,
        now,
        staleness,
      ),
    ).toBe(false);
    // Busy-set with no list evidence.
    expect(
      isWakeChildActive(
        { id: 'c' },
        { status: 'busy', at: now },
        now,
        staleness,
      ),
    ).toBe(true);
    // Stale busy-set is bounded.
    expect(
      isWakeChildActive(
        { id: 'c' },
        { status: 'busy', at: now - staleness - 1 },
        now,
        staleness,
      ),
    ).toBe(false);
    // No evidence at all → inactive.
    expect(isWakeChildActive({ id: 'c' }, undefined, now, staleness)).toBe(
      false,
    );
  });

  test('buildChildrenWakeFingerprint includes outcome, tracked status, and evidence', () => {
    const tracked = new Map([['c1', { status: 'busy' as const, at: 5 }]]);
    const fp = buildChildrenWakeFingerprint(
      [
        { id: 'c1', evidenceAt: 42 },
        { id: 'c2', outcome: 'succeeded' },
      ],
      tracked,
    );
    expect(fp).toContain('c1::busy:42');
    expect(fp).toContain('c2:succeeded::');
    expect(buildChildrenWakeFingerprint([], tracked)).toBe('');
  });
});
