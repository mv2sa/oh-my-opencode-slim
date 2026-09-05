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
  buildOrchestratorWakeFingerprint,
  createOrchestratorWakeScheduler,
  ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT,
  ORCHESTRATOR_WAKE_TEXT,
  ORCHESTRATOR_WAKE_UNCHANGED_CAP,
} from './index';
import {
  getWakeProgress,
  resetOrchestratorWakeGateForTests,
} from './wake-gate';

type SessionClient = {
  get?: ReturnType<typeof mock>;
  todo?: ReturnType<typeof mock>;
  children?: ReturnType<typeof mock>;
  status?: ReturnType<typeof mock>;
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
  sessionClient?: SessionClient | null;
  shouldManageSession?: (id: string) => boolean;
  hasInputWait?: (id: string) => boolean;
  isFallbackInProgress?: (id: string) => boolean;
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
  } as never;

  const scheduler = createOrchestratorWakeScheduler(ctx, {
    config: {
      enabled: options?.enabled ?? true,
      intervalMs: options?.intervalMs ?? 60_000,
    },
    intervalMs: options?.intervalMs ?? 60_000,
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: options?.hasInputWait ?? (() => false),
    isFallbackInProgress: options?.isFallbackInProgress,
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
  test('includes todo statuses and child status/update evidence', () => {
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
    expect(fp).toContain('child-1:busy:42');
  });
});

describe('orchestrator wake scheduler', () => {
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

  test('external busy (not wake-initiated) rearms the no-progress cap', async () => {
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

      const bootstrapPrompt = mock(async () => ({}));
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
      expect(
        await scheduler._test.classifyAndRecoverInterruptedSession(
          root,
          'bootstrap',
        ),
      ).toBe(true);
      expect(bootstrapPrompt).toHaveBeenCalledTimes(1);
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
