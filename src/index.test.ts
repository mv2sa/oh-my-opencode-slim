import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MultiplexerConfig } from './config';
import { RuntimeConfig } from './config/runtime';
import { CooldownRegistry } from './hooks/foreground-fallback/cooldown-registry';
import pluginModuleDefault, {
  consumeCompletedManagerTask,
  OhMyOpenCodeLite as plugin,
  sessionManagerMultiplexerConfig,
  shouldEnableMultiplexer,
} from './index';
import {
  type OutcomeRecord,
  serializeOutcomeRecord,
} from './outcome/controller-schema';
import { readTuiSnapshot } from './tui-state';
import { BackgroundJobBoard } from './utils/background-job-board';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';
import { SessionMetadataStore } from './utils/session-metadata';

function createPluginClient(
  noop: () => Promise<unknown>,
  abort?: (input: { path: { id: string } }) => Promise<unknown>,
) {
  const session = new Proxy(abort ? { abort } : {}, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      return noop;
    },
  }) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return new Proxy({}, { get: () => noop });
      },
    },
  );
}

function createHostTimerHarness() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeout = (callback: () => void, delay = 0) => {
    const id = ++nextID;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };

  return { now: () => now, setTimeout, clearTimeout, advanceTo };
}

describe('plugin env disable', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns empty hooks without reading plugin context', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';

    const ctx = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`disabled plugin read ctx.${String(property)}`);
        },
      },
    );

    const hooks = await plugin(ctx as Parameters<typeof plugin>[0]);

    expect(hooks).toEqual({});
    expect(hooks.config).toBeUndefined();
    expect(hooks.event).toBeUndefined();
    expect(hooks.tool).toBeUndefined();
  });
});

describe('Outcome Manager board consumption composition', () => {
  test('accepts exact completed identity repeatedly after reconciliation', () => {
    const board = new BackgroundJobBoard();
    const task = board.registerLaunch({
      taskID: 'manager_completed',
      parentSessionID: 'root-1',
      agent: 'outcome-manager',
    });
    board.updateStatus({
      taskID: task.taskID,
      state: 'completed',
      expectedGeneration: task.generation,
    });

    expect(
      consumeCompletedManagerTask(
        board,
        task.parentSessionID,
        task.taskID,
        task.generation,
      ),
    ).toBe(true);
    expect(board.get(task.taskID)).toMatchObject({
      state: 'reconciled',
      terminalState: 'completed',
      generation: task.generation,
    });
    expect(
      consumeCompletedManagerTask(
        board,
        task.parentSessionID,
        task.taskID,
        task.generation,
      ),
    ).toBe(true);
  });

  test('rejects wrong parent, task, generation, and terminal outcome', () => {
    const board = new BackgroundJobBoard();
    const completed = board.registerLaunch({
      taskID: 'manager_completed',
      parentSessionID: 'root-1',
      agent: 'outcome-manager',
    });
    board.updateStatus({ taskID: completed.taskID, state: 'completed' });

    expect(
      consumeCompletedManagerTask(
        board,
        'wrong-root',
        completed.taskID,
        completed.generation,
      ),
    ).toBe(false);
    expect(
      consumeCompletedManagerTask(
        board,
        completed.parentSessionID,
        'wrong-task',
        completed.generation,
      ),
    ).toBe(false);
    expect(
      consumeCompletedManagerTask(
        board,
        completed.parentSessionID,
        completed.taskID,
        completed.generation + 1,
      ),
    ).toBe(false);

    for (const terminalState of ['error', 'cancelled'] as const) {
      const task = board.registerLaunch({
        taskID: `manager_${terminalState}`,
        parentSessionID: 'root-1',
        agent: 'outcome-manager',
      });
      board.updateStatus({ taskID: task.taskID, state: terminalState });
      board.markReconciled(task.taskID);
      expect(
        consumeCompletedManagerTask(
          board,
          task.parentSessionID,
          task.taskID,
          task.generation,
        ),
      ).toBe(false);
    }
  });
});

describe('plugin tool registration', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    process.env.OPENCODE_CONFIG_DIR =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-config';
    process.env.XDG_CONFIG_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-xdg';
    process.env.XDG_DATA_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-data';
    process.env.XDG_CACHE_HOME =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-cache';
    process.env.OPENCODE_LOG_DIR =
      '/private/tmp/oh-my-opencode-slim-hitl-empty-logs';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('registers wait_for_user and recovers a stale orchestrator session mapping', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-hitl-project',
      worktree: '/private/tmp/oh-my-opencode-slim-hitl-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.tool?.task_status).toBeDefined();
    expect(hooks.tool?.task_result).toBeDefined();
    expect(hooks.tool?.task_message).toBeDefined();
    expect(hooks.tool?.task_cancel).toBeDefined();
    expect(hooks.tool?.task_revive).toBeDefined();
    expect(hooks.tool?.wait_for_user).toBeDefined();
    await expect(
      hooks.tool?.wait_for_user?.execute(
        { reason: 'Complete the external approval.' },
        { sessionID: 'parent-after-reload', agent: 'orchestrator' } as never,
      ),
    ).resolves.toContain('state: waiting_for_user');
  });

  test('does not retain loop-guard state when search-path validation rejects', async () => {
    const projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-search-hook-');
    const client = createPluginClient(async () => ({}));
    let hooks: Awaited<ReturnType<typeof plugin>> | undefined;

    try {
      hooks = await plugin({
        client,
        directory: projectDir,
        worktree: projectDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);

      const rejectedPath = path.join(projectDir, 'created-after-rejection');
      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID: 'rejected' },
          { args: { path: rejectedPath } },
        ),
      ).rejects.toThrow(/Search path does not exist/);

      // A host should not emit `after` after a rejected `before`, but this
      // simulates that stray completion to ensure it cannot poison tracking.
      await mkdir(rejectedPath);
      await hooks['tool.execute.after']?.(
        { tool: 'glob', sessionID: 'search-loop', callID: 'rejected' },
        { output: 'same', metadata: {} },
      );

      for (let i = 0; i < 4; i++) {
        const callID = `valid-${i}`;
        await hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID },
          { args: { path: rejectedPath } },
        );
        await hooks['tool.execute.after']?.(
          { tool: 'glob', sessionID: 'search-loop', callID },
          { output: 'same', metadata: {} },
        );
      }

      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID: 'valid-4' },
          { args: { path: rejectedPath } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await hooks?.dispose?.();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('exposes an idempotent top-level dispose finalizer', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-dispose-project',
      worktree: '/private/tmp/oh-my-opencode-slim-dispose-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.dispose).toBeFunction();
    await hooks.dispose?.();
    await hooks.dispose?.();
  });

  test('disposes generation one timers and fresh generation two supervises launches', async () => {
    const originalEnv = { ...process.env };
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalNow = Date.now;
    const clock = createHostTimerHarness();
    const abortCalls: string[] = [];
    const noop = async () => ({});
    const client = createPluginClient(noop, async ({ path }) => {
      abortCalls.push(path.id);
      return {};
    });
    const configDir = await mkdtemp('/tmp/oh-my-opencode-slim-phase-2r-');
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
          abortGraceMs: 1_000,
        },
      }),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    globalThis.setTimeout = clock.setTimeout as typeof globalThis.setTimeout;
    globalThis.clearTimeout =
      clock.clearTimeout as typeof globalThis.clearTimeout;
    Date.now = clock.now;

    const launch = async (
      hooks: Awaited<ReturnType<typeof plugin>>,
      callID: string,
      taskID: string,
    ) => {
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          args: {
            subagent_type: 'explorer',
            background: true,
            description: taskID,
          },
        },
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'parent-1', callID },
        {
          output: [
            `task_id: ${taskID}`,
            'state: running',
            '',
            '<task_result>',
            'started',
            '</task_result>',
          ].join('\n'),
        },
      );
    };

    let generationOne: Awaited<ReturnType<typeof plugin>> | undefined;
    let generationTwo: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      generationOne = await plugin({
        client,
        directory: configDir,
        worktree: configDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      expect(generationOne.dispose).toBeFunction();
      await launch(generationOne, 'call-1', 'child-generation-1');

      await clock.advanceTo(59_999);
      expect(abortCalls).toEqual([]);
      await generationOne.dispose?.();
      await generationOne.dispose?.();
      await clock.advanceTo(60_000);
      expect(abortCalls).toEqual([]);

      generationTwo = await plugin({
        client,
        directory: configDir,
        worktree: configDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      expect(generationTwo.dispose).toBeFunction();
      await launch(generationTwo, 'call-2', 'child-generation-2');
      await clock.advanceTo(119_999);
      expect(abortCalls).toEqual([]);
      await clock.advanceTo(120_000);
      expect(abortCalls).toEqual(['child-generation-2']);
    } finally {
      await generationTwo?.dispose?.();
      await generationOne?.dispose?.();
      process.env = originalEnv;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      Date.now = originalNow;
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('Outcome Manager host config boundary', () => {
  let originalEnv: typeof process.env;
  let configDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    configDir = await mkdtemp('/tmp/omos-outcome-manager-host-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await writeFile(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        autoUpdate: false,
        agents: {
          'outcome-manager': {
            displayName: 'auditor',
          },
        },
      }),
    );
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(configDir, { recursive: true, force: true });
  });

  test('final config merge protects canonical and display-alias registrations', async () => {
    const noop = async () => ({});
    const hooks = await plugin({
      client: createPluginClient(noop),
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    const hostile = {
      prompt: 'Hostile host prompt',
      description: 'Hostile host description',
      mode: 'primary',
      hidden: false,
      permission: {
        '*': 'allow',
        bash: 'allow',
        edit: 'allow',
        task: 'allow',
        skill: { '*': 'allow' },
      },
      mcps: ['*', 'context7'],
      unknownFutureAuthority: 'allow',
      model: 'host/manager-model',
      variant: 'host-variant',
      temperature: 0.4,
      options: { textVerbosity: 'low' },
    };
    const host: Record<string, unknown> = {
      agent: {
        'outcome-manager': { ...hostile },
        auditor: { ...hostile, model: 'host/alias-model' },
        oracle: {
          prompt: 'Host Oracle prompt',
          permission: { bash: 'allow' },
          unknownFutureAuthority: 'preserved',
        },
      },
    };

    await hooks.config?.(host);

    const configured = host.agent as Record<string, Record<string, unknown>>;
    for (const [name, expectedModel] of [
      ['outcome-manager', 'host/manager-model'],
      ['auditor', 'host/alias-model'],
    ] as const) {
      const manager = configured[name];
      expect(manager.prompt).toContain('You are Outcome Manager');
      expect(manager.prompt).not.toContain('Hostile host prompt');
      expect(manager.description).toContain('Read-only outcome manager');
      expect(manager.mode).toBe('subagent');
      expect(manager.mcps).toEqual([]);
      expect(manager.unknownFutureAuthority).toBeUndefined();
      expect(manager.model).toBe(expectedModel);
      expect(manager.variant).toBe('host-variant');
      expect(manager.temperature).toBe(0.4);
      expect(manager.options).toEqual({ textVerbosity: 'low' });

      const permission = manager.permission as Record<string, unknown>;
      expect(permission['*']).toBe('deny');
      expect(permission.bash).toBe('deny');
      expect(permission.edit).toBe('deny');
      expect(permission.task).toBe('deny');
      expect(permission.question).toBe('deny');
      expect(permission.wait_for_user).toBe('deny');
      expect(permission.skill).toEqual({ '*': 'deny' });
    }

    expect(configured['outcome-manager'].hidden).toBe(true);
    expect(configured.auditor.hidden).toBeUndefined();
    expect(configured.oracle).toMatchObject({
      prompt: 'Host Oracle prompt',
      permission: { bash: 'allow' },
      unknownFutureAuthority: 'preserved',
    });
    await hooks.dispose?.();
  });
});

describe('Outcome Controller plugin integration', () => {
  let originalEnv: typeof process.env;
  let configDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    configDir = await mkdtemp('/tmp/omos-outcome-plugin-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await writeFile(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ autoUpdate: false }),
    );
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(configDir, { recursive: true, force: true });
  });

  async function createOutcomeHooks(promptCalls: unknown[] = []) {
    const noop = async () => ({});
    const promptAsync = mock(async (request: unknown) => {
      promptCalls.push(request);
      return {};
    });
    const client = createPluginClient(noop) as {
      session: Record<string, unknown>;
    };
    client.session.promptAsync = promptAsync;
    const hooks = await plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    const root = 'ses_outcome_plugin';
    await hooks['chat.message']?.(
      {
        sessionID: root,
        agent: 'orchestrator',
        messageID: 'msg_outcome_plugin',
        parts: [{ type: 'text', text: 'Manage this outcome' }],
      } as never,
      {
        message: {
          id: 'msg_outcome_plugin',
          sessionID: root,
          role: 'user',
          agent: 'orchestrator',
        },
        parts: [{ type: 'text', text: 'Manage this outcome' }],
      } as never,
    );

    return { hooks, root, promptAsync };
  }

  async function pendingOutcomeInstruction(
    hooks: Awaited<ReturnType<typeof plugin>>,
    root: string,
  ): Promise<string> {
    const output = {
      messages: [
        {
          info: { id: 'msg_instruction_anchor', role: 'user', sessionID: root },
          parts: [{ type: 'text', text: 'Continue managed outcome' }],
        },
      ],
    };
    await hooks['experimental.chat.messages.transform']?.(
      {} as never,
      output as never,
    );
    for (const message of output.messages as Array<{
      parts?: Array<{ text?: string }>;
    }>) {
      for (const part of message.parts ?? []) {
        if (part.text?.includes('OMOS_DISPATCH_MARKER')) return part.text;
      }
    }
    throw new Error('volatile Outcome Manager instruction missing');
  }

  function contract(sourceMessageId: string) {
    return {
      classification: 'non_trivial' as const,
      objective: 'Exercise Outcome Controller plugin integration',
      deliverables: ['Integrated hook behavior'],
      goals: [
        {
          id: 'goal_plugin',
          description: 'Complete plugin integration checks',
          status: 'in_progress' as const,
        },
      ],
      inScope: ['src/index.ts'],
      outOfScope: [],
      constraints: ['Use real plugin hooks'],
      safetyBoundaries: ['Do not bypass controller state'],
      handoffRequirements: ['Regression checks pass'],
      sourceMessageIds: [sourceMessageId],
      rules: [],
      exceptions: [],
    };
  }

  test('routes normal idle through Outcome Controller once with canonical promptAsync', async () => {
    const calls: unknown[] = [];
    const { hooks, root, promptAsync } = await createOutcomeHooks(calls);
    try {
      await hooks.tool?.outcome_control?.execute(
        { action: 'begin', contract: contract('msg_outcome_plugin') },
        { sessionID: root, agent: 'orchestrator' } as never,
      );

      for (let index = 0; index < 2; index += 1) {
        await hooks.event?.({
          event: {
            type: 'session.status',
            properties: { sessionID: root, status: { type: 'idle' } },
          },
        });
      }

      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(calls[0]).toMatchObject({
        path: { id: root },
        query: { directory: configDir },
        body: {
          agent: 'orchestrator',
          parts: [{ type: 'text', synthetic: true }],
        },
        throwOnError: true,
      });
      expect(
        (
          calls[0] as {
            body: { parts: Array<{ text: string }> };
          }
        ).body.parts[0].text,
      ).toStartWith(
        'Action required on outcome protocol. Check outcome_control status or pending checkpoint instructions.',
      );
    } finally {
      await hooks.dispose?.();
    }
  });

  test('task-session terminal reconciliation runs before Outcome Controller idle wake', async () => {
    const calls: unknown[] = [];
    const { hooks, root, promptAsync } = await createOutcomeHooks(calls);
    try {
      await hooks.tool?.outcome_control?.execute(
        { action: 'begin', contract: contract('msg_outcome_plugin') },
        { sessionID: root, agent: 'orchestrator' } as never,
      );
      const instruction = await pendingOutcomeInstruction(hooks, root);
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: root, callID: 'call_running_manager' },
        {
          args: {
            subagent_type: 'outcome-manager',
            background: true,
            description: 'Running Outcome Manager review',
            prompt: instruction,
          },
        },
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: root, callID: 'call_running_manager' },
        {
          output:
            '<task id="mgr_running" state="running">\n<summary>Running Outcome Manager review</summary>\n</task>',
        },
      );

      await hooks.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });
      expect(promptAsync).toHaveBeenCalledTimes(0);

      await hooks.event?.({
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_mgr_running_terminal',
              sessionID: root,
              messageID: 'msg_mgr_running_terminal',
              type: 'text',
              synthetic: true,
              text: '<task id="mgr_running" state="error">\n<summary>Background task failed: Running Outcome Manager review</summary>\n<task_error>Manager failed</task_error>\n</task>',
            },
          },
        },
      });
      const terminalOutput = {
        messages: [
          {
            info: {
              id: 'msg_mgr_running_terminal',
              role: 'user',
              sessionID: root,
            },
            parts: [
              {
                id: 'part_mgr_running_terminal',
                sessionID: root,
                messageID: 'msg_mgr_running_terminal',
                type: 'text',
                synthetic: true,
                text: '<task id="mgr_running" state="error">\n<summary>Background task failed: Running Outcome Manager review</summary>\n<task_error>Manager failed</task_error>\n</task>',
              },
            ],
          },
        ],
      };
      await hooks['experimental.chat.messages.transform']?.(
        {} as never,
        terminalOutput as never,
      );
      await hooks.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });

      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(calls[0]).toMatchObject({ path: { id: root } });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('retires a reserved Manager claim when task-session preflight rejects', async () => {
    const { hooks, root } = await createOutcomeHooks();
    try {
      await hooks.tool?.outcome_control?.execute(
        { action: 'begin', contract: contract('msg_outcome_plugin') },
        { sessionID: root, agent: 'orchestrator' } as never,
      );
      const instruction = await pendingOutcomeInstruction(hooks, root);

      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: root, callID: 'call_existing' },
        {
          args: {
            subagent_type: 'outcome-manager',
            background: true,
            description: 'Outcome Manager review',
            prompt: instruction,
          },
        },
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: root, callID: 'call_existing' },
        {
          output:
            '<task id="mgr_existing" state="completed">\n<summary>Background task completed: Outcome Manager review</summary>\n<task_result>done</task_result>\n</task>',
        },
      );

      const recordPath = `${configDir}/.opencode/outcomes`;
      const files = await Array.fromAsync(
        new Bun.Glob('*.json').scan({ cwd: recordPath, absolute: true }),
      );
      const recordFiles = files.filter(
        (f) => !f.endsWith('.manifest.json') && !f.endsWith('.intake.json'),
      );
      expect(recordFiles).toHaveLength(1);
      const record = JSON.parse(
        await Bun.file(recordFiles[0]).text(),
      ) as OutcomeRecord;
      const checkpoint = record.checkpoint;
      expect(checkpoint).toBeDefined();
      if (!checkpoint) return;
      const claimed = {
        outcomeId: record.outcomeId,
        rootSessionId: record.rootSessionId,
        checkpointId: checkpoint.checkpointId,
        kind: checkpoint.kind,
        reason: checkpoint.reason,
        claimGeneration: checkpoint.claimGeneration,
        claimTokenDigest: checkpoint.claimTokenDigest,
        checkpointFingerprint: checkpoint.checkpointFingerprint,
        contractDigest: checkpoint.contractDigest,
        outcomeRevision: checkpoint.outcomeRevision,
        serverEpoch: checkpoint.serverEpoch,
        claimedAt: checkpoint.claimedAt,
        expiresAt: checkpoint.expiresAt,
        candidateFingerprint: checkpoint.candidateFingerprint,
        includedDecisionIds: checkpoint.includedDecisionIds,
        includedExceptionRuleIds: checkpoint.includedExceptionRuleIds,
        includedEvidenceAttestationIds:
          checkpoint.includedEvidenceAttestationIds,
        state: 'claimed' as const,
      };
      record.checkpoint = claimed;
      record.phase = 'checkpointing';
      record.actionsRequired = [];
      record.operations = [];
      record.receipts.evidence = [];
      record.revision += 1;
      await Bun.write(recordFiles[0], serializeOutcomeRecord(record));

      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'task', sessionID: root, callID: 'call_rejected' },
          {
            args: {
              subagent_type: 'outcome-manager',
              background: true,
              description: 'Outcome Manager review',
              prompt: instruction,
            },
          },
        ),
      ).rejects.toThrow('same objective already finished');

      const status = JSON.parse(
        String(
          await hooks.tool?.outcome_control?.execute({ action: 'status' }, {
            sessionID: root,
            agent: 'orchestrator',
          } as never),
        ),
      );
      expect(status).toMatchObject({
        phase: 'action_required',
        checkpoint: { state: 'retired' },
        activeOperations: [],
      });

      const rejectedRecord = JSON.parse(
        await Bun.file(recordFiles[0]).text(),
      ) as OutcomeRecord;
      expect(rejectedRecord.operations).toEqual([]);
      expect(
        rejectedRecord.actionsRequired.some(
          (action) => action.code === 'interrupted_operation',
        ),
      ).toBe(false);

      const retryStatus = JSON.parse(
        String(
          await hooks.tool?.outcome_control?.execute({ action: 'status' }, {
            sessionID: root,
            agent: 'orchestrator',
          } as never),
        ),
      );
      expect(retryStatus).toMatchObject({
        checkpoint: { state: 'retired' },
        activeOperations: [],
      });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('successful Manager dispatch binds normally without a generic operation', async () => {
    const { hooks, root } = await createOutcomeHooks();
    try {
      await hooks.tool?.outcome_control?.execute(
        { action: 'begin', contract: contract('msg_outcome_plugin') },
        { sessionID: root, agent: 'orchestrator' } as never,
      );
      const instruction = await pendingOutcomeInstruction(hooks, root);
      await hooks['tool.execute.before']?.(
        { tool: 'task', sessionID: root, callID: 'call_manager_success' },
        {
          args: {
            subagent_type: 'outcome-manager',
            background: true,
            description: 'Fresh Outcome Manager review',
            prompt: instruction,
          },
        },
      );
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: root, callID: 'call_manager_success' },
        {
          output:
            '<task id="mgr_success" state="running">\n<summary>Running</summary>\n</task>',
        },
      );

      const recordPath = `${configDir}/.opencode/outcomes`;
      const files = await Array.fromAsync(
        new Bun.Glob('*.json').scan({ cwd: recordPath, absolute: true }),
      );
      const recordFiles = files.filter(
        (f) => !f.endsWith('.manifest.json') && !f.endsWith('.intake.json'),
      );
      expect(recordFiles).toHaveLength(1);
      const record = JSON.parse(
        await Bun.file(recordFiles[0]).text(),
      ) as OutcomeRecord;
      expect(record.operations).toEqual([]);
      expect(record.checkpoint).toMatchObject({
        state: 'running',
        managerTaskId: 'mgr_success',
      });
      expect(record.checkpoint?.managerGeneration).toBeNumber();
    } finally {
      await hooks.dispose?.();
    }
  });

  test('integration JSON enumeration distinguishes outcome records from both manifest and staged intake', async () => {
    const { hooks, root } = await createOutcomeHooks();
    try {
      await hooks.tool?.outcome_control?.execute(
        { action: 'begin', contract: contract('msg_enum_init') },
        { sessionID: root, agent: 'orchestrator' } as never,
      );

      // Write a simulated staged intake file in outcomes directory
      const recordDir = `${configDir}/.opencode/outcomes`;
      const intakePath = `${recordDir}/fake_hash.g00000002.intake.json`;
      await Bun.write(
        intakePath,
        JSON.stringify({
          schema: 'omos_outcome_intake',
          schemaVersion: 1,
          rootSessionId: root,
          generation: 2,
          boundaryMessageId: 'msg_enum_init',
          userMessages: [],
        }),
      );

      const allFiles = await Array.fromAsync(
        new Bun.Glob('*.json').scan({ cwd: recordDir, absolute: true }),
      );
      expect(allFiles.length).toBeGreaterThanOrEqual(3); // record, manifest, and intake

      const outcomeRecordsOnly = allFiles.filter(
        (f) => !f.endsWith('.manifest.json') && !f.endsWith('.intake.json'),
      );
      expect(outcomeRecordsOnly).toHaveLength(1);
      expect(outcomeRecordsOnly[0]).toMatch(/\.json$/);
      expect(outcomeRecordsOnly[0]).not.toContain('.manifest.');
      expect(outcomeRecordsOnly[0]).not.toContain('.intake.');
    } finally {
      await hooks.dispose?.();
    }
  });
});

describe('plugin TUI agent activity', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;
  let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
  const createActivityPlugin = () =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-tui-activity-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false } }),
    );

    hooks = await createActivityPlugin();
  });

  afterEach(async () => {
    await hooks?.dispose?.();
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('keeps an agent active until all of its sessions stop', async () => {
    const chatMessage = hooks?.['chat.message'];
    expect(chatMessage).toBeFunction();

    await chatMessage?.(
      { sessionID: 'fixer-a', agent: 'fixer' } as never,
      {} as never,
    );
    await chatMessage?.(
      { sessionID: 'fixer-b', agent: 'fixer' } as never,
      {} as never,
    );

    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'fixer-a', status: { type: 'idle' } },
      },
    } as never);

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'fixer-b': 'fixer',
    });

    await hooks?.event?.({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'fixer-b' } },
      },
    } as never);

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('clears active sessions when plugin disposes', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-a', agent: 'oracle' } as never,
      {} as never,
    );

    await hooks?.dispose?.();

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('server disposal preserves activity owned by another plugin instance', async () => {
    const otherHooks = await createActivityPlugin();

    try {
      await hooks?.['chat.message']?.(
        { sessionID: 'oracle-a', agent: 'oracle' } as never,
        {} as never,
      );
      await otherHooks['chat.message']?.(
        { sessionID: 'explorer-b', agent: 'explorer' } as never,
        {} as never,
      );

      await hooks?.event?.({
        event: { type: 'server.instance.disposed' },
      } as never);

      expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
        'explorer-b': 'explorer',
      });
    } finally {
      await otherHooks.dispose?.();
    }
  });
});

describe('background task admission model resolution', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;
  let hooks: Awaited<ReturnType<typeof plugin>> | undefined;

  const createPlugin = () =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4098'),
    } as never);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-concurrency-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { openai: 1 },
          },
        },
        agents: { fixer: { inheritModelFrom: 'session' } },
      }),
    );
    hooks = await createPlugin();
  });

  afterEach(async () => {
    await hooks?.dispose?.();
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('chat.message records the session model so session-inheriting tasks queue behind the parent provider cap', async () => {
    // chat.message fires before message.updated and carries the message's
    // model. Without recording it, a session-inheriting fixer task would be
    // admitted with no model (default tier, no provider cap).
    await hooks?.['chat.message']?.(
      {
        sessionID: 'orchestrator-1',
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );

    const before = hooks?.['tool.execute.before'];
    expect(before).toBeFunction();

    const first = before?.(
      { tool: 'task', sessionID: 'orchestrator-1', callID: 'call-1' } as never,
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'first task',
        },
      } as never,
    );
    const second = before?.(
      { tool: 'task', sessionID: 'orchestrator-1', callID: 'call-2' } as never,
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'second task',
        },
      } as never,
    );

    // The first fixer task holds the single openai slot (resolved from the
    // parent's model recorded by chat.message); the second must stay queued.
    // (Slot release happens via board terminal outcomes, out of scope here.)
    await first;
    const outcome = await Promise.race([
      second?.then(
        () => 'admitted',
        (e) => `rejected:${String(e)}`,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-queued'), 100),
      ),
    ]);
    expect(outcome).toBe('still-queued');
  });
});

describe('plugin config model inheritance', () => {
  let originalEnv: typeof process.env;
  const configDirs: string[] = [];

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    while (configDirs.length > 0) {
      const configDir = configDirs.pop();
      if (configDir) {
        await rm(configDir, { recursive: true, force: true });
      }
    }
  });

  async function loadConfiguredPlugin(config: Record<string, unknown>) {
    const configDir = await mkdtemp('/tmp/oh-my-opencode-inheritance-');
    configDirs.push(configDir);
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify(config),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };

    const client = createPluginClient(async () => ({}));
    return plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
  }

  async function assertAdmissionUsesFinalModel(
    subagentType: string,
    config: Record<string, unknown>,
    hostAgent: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await loadConfiguredPlugin(config);
    try {
      await hooks.config?.({ agent: hostAgent });
      await hooks['chat.message']?.(
        {
          sessionID: 'orchestrator-1',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'parent' },
        } as never,
        {} as never,
      );
      const first = hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-1',
        } as never,
        {
          args: {
            background: true,
            subagent_type: subagentType,
            description: 'first admission',
          },
        } as never,
      );
      const second = hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-2',
        } as never,
        {
          args: {
            background: true,
            subagent_type: subagentType,
            description: 'second admission',
          },
        } as never,
      );

      await first;
      const queued = await Promise.race([
        second?.then(
          () => 'admitted',
          () => 'rejected',
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still-queued'), 30),
        ),
      ]);
      expect(queued).toBe('still-queued');

      await hooks['tool.execute.after']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-1',
        } as never,
        {
          output: 'task_id: child-1\nstate: completed\nresult: done',
        } as never,
      );
      await second;
    } finally {
      await hooks.dispose?.();
    }
  }

  test('session inheritance removes a stale host model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        librarian: { model: 'local/librarian' },
        fixer: { inheritModelFrom: 'session' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.2 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.2);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('orchestrator inheritance uses the host orchestrator model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        librarian: { inheritModelFrom: 'orchestrator' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        librarian: { model: 'host/stale-librarian' },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.librarian?.model).toBe('host/orchestrator');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('preset inheritance clears a stale host model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      preset: 'split',
      presets: {
        split: {
          orchestrator: { model: 'preset/orchestrator' },
          fixer: { inheritModelFrom: 'session' },
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.4 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.4);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('admission uses a direct host override from final agent config', async () => {
    await assertAdmissionUsesFinalModel(
      'fixer',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { host: 1 },
          },
        },
        agents: { fixer: { model: 'plugin/fixer' } },
      },
      { fixer: { model: 'host/fixer' } },
    );
  });

  test('admission uses a display-name host override before alias resolution', async () => {
    await assertAdmissionUsesFinalModel(
      'researcher',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { host: 1 },
          },
        },
        agents: {
          explorer: { model: 'plugin/explorer', displayName: 'researcher' },
        },
      },
      { researcher: { model: 'host/researcher' } },
    );
  });

  test('admission resolves a legacy agent alias to the final canonical entry', async () => {
    await assertAdmissionUsesFinalModel(
      'explore',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { host: 1 },
          },
        },
        agents: { explorer: { model: 'plugin/explorer' } },
      },
      { explorer: { model: 'host/explorer' } },
    );
  });

  test('ACP admission falls back to the parent only when its final config is model-less', async () => {
    await assertAdmissionUsesFinalModel(
      'external',
      {
        backgroundJobs: {
          concurrency: {
            defaultConcurrency: 0,
            providerConcurrency: { openai: 1 },
          },
        },
        acpAgents: { external: { command: 'bridge-acp' } },
      },
      { orchestrator: { model: 'openai/parent' } },
    );
  });
});

describe('persistent cooldown plugin hooks', () => {
  let originalEnv: typeof process.env;
  let configDir: string;
  let cooldownFile: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    configDir = await mkdtemp('/tmp/omos-cooldown-plugin-');
    cooldownFile = `${configDir}/cooldowns.json`;
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
      OMOS_COOLDOWN_FILE: cooldownFile,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await writeFile(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        autoUpdate: false,
        preset: 'quality',
        presets: {
          quality: {
            fixer: {
              model: [
                { id: 'a/primary', variant: 'low' },
                { id: 'b/fallback', variant: 'high' },
              ],
              variant: 'medium',
              skills: [],
              mcps: [],
            },
          },
          runtime: {
            fixer: {
              model: [
                { id: 'a/primary', variant: 'low' },
                { id: 'b/fallback', variant: 'high' },
              ],
              variant: 'medium',
              skills: [],
              mcps: [],
            },
          },
        },
      }),
    );
    new CooldownRegistry(cooldownFile).markFailure('a/primary', {
      class: 'quota',
      cooldownMs: 60_000,
      reason: 'test',
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(configDir, { recursive: true, force: true });
  });

  async function createHooks() {
    const noop = async () => ({});
    return plugin({
      client: createPluginClient(noop),
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
  }

  test('config hook selects cooled fallback with its variant on repeated initialization', async () => {
    for (let generation = 0; generation < 2; generation++) {
      const hooks = await createHooks();
      const host: Record<string, unknown> = { agent: {} };
      await hooks.config?.(host);
      expect((host.agent as Record<string, any>).fixer).toEqual(
        expect.objectContaining({ model: 'b/fallback', variant: 'high' }),
      );
      await hooks.dispose?.();
    }
  });

  test('config hook preserves an explicit user model override', async () => {
    const hooks = await createHooks();
    const host: Record<string, unknown> = {
      agent: { fixer: { model: 'user/model', variant: 'custom' } },
    };
    await hooks.config?.(host);
    expect((host.agent as Record<string, any>).fixer).toEqual(
      expect.objectContaining({ model: 'user/model', variant: 'custom' }),
    );
    await hooks.dispose?.();
  });

  test('config hook preserves an existing chain-member model without disabling fallback', async () => {
    const hooks = await createHooks();
    const host: Record<string, unknown> = {
      agent: { fixer: { model: 'b/fallback', variant: 'high' } },
    };
    await hooks.config?.(host);
    expect((host.agent as Record<string, any>).fixer).toEqual(
      expect.objectContaining({ model: 'b/fallback', variant: 'high' }),
    );
    await hooks.dispose?.();
  });

  test('active runtime preset selects the soonest-reset model when all are cooling', async () => {
    const registry = new CooldownRegistry(cooldownFile);
    registry.markFailure('b/fallback', {
      class: 'quota',
      cooldownMs: 20_000,
      reason: 'test',
    });
    const hooks = await createHooks();
    RuntimeConfig.get(configDir).setRuntimePreset('runtime');
    const host: Record<string, unknown> = { agent: {} };
    await hooks.config?.(host);
    expect((host.agent as Record<string, any>).fixer).toEqual(
      expect.objectContaining({ model: 'b/fallback', variant: 'medium' }),
    );
    await hooks.dispose?.();
  });

  test('chat.message selects fallback model and variant for a delegated child', async () => {
    const hooks = await createHooks();
    const input = {
      sessionID: 'child',
      agent: 'fixer',
      variant: 'low',
    };
    const output = {
      message: {
        agent: 'fixer',
        model: { providerID: 'a', modelID: 'primary' },
      },
      parts: [],
    };
    await hooks['chat.message']?.(input as never, output as never);
    expect(output.message.model).toEqual({
      providerID: 'b',
      modelID: 'fallback',
    });
    expect(input.variant).toBe('high');
    await hooks.dispose?.();
  });

  test('chat.message accounts for the final cooldown-selected output model', async () => {
    const setModel = spyOn(
      SessionMetadataStore.prototype,
      'setModel',
    ).mockImplementation(() => {});
    const migrateTask = spyOn(
      BackgroundTaskConcurrency.prototype,
      'migrateTask',
    ).mockImplementation(() => {});
    const hooks = await createHooks();
    const input = {
      sessionID: 'child-accounting',
      agent: 'fixer',
      model: { providerID: 'a', modelID: 'primary' },
      variant: 'low',
    };
    const output = {
      message: {
        agent: 'fixer',
        model: { providerID: 'a', modelID: 'primary' },
      },
      parts: [],
    };

    try {
      await hooks['chat.message']?.(input as never, output as never);

      expect(output.message.model).toEqual({
        providerID: 'b',
        modelID: 'fallback',
      });
      expect(setModel).toHaveBeenCalledWith('child-accounting', 'b/fallback');
      expect(migrateTask).toHaveBeenCalledWith(
        'child-accounting',
        'b/fallback',
      );
      expect(setModel).not.toHaveBeenCalledWith(
        'child-accounting',
        'a/primary',
      );
      expect(migrateTask).not.toHaveBeenCalledWith(
        'child-accounting',
        'a/primary',
      );
    } finally {
      await hooks.dispose?.();
      setModel.mockRestore();
      migrateTask.mockRestore();
    }
  });

  test('chat.message clears a stale variant when fallback has none', async () => {
    await writeFile(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        autoUpdate: false,
        preset: 'quality',
        presets: {
          quality: {
            fixer: {
              model: [{ id: 'a/primary', variant: 'low' }, 'b/fallback'],
              skills: [],
              mcps: [],
            },
          },
        },
      }),
    );
    const hooks = await createHooks();
    const input: { sessionID: string; agent: string; variant?: string } = {
      sessionID: 'child-no-variant',
      agent: 'fixer',
      variant: 'low',
    };
    const output = {
      message: {
        agent: 'fixer',
        model: { providerID: 'a', modelID: 'primary' },
      },
      parts: [],
    };
    await hooks['chat.message']?.(input as never, output as never);
    expect(output.message.model).toEqual({
      providerID: 'b',
      modelID: 'fallback',
    });
    expect(input.variant).toBeUndefined();
    await hooks.dispose?.();
  });

  test('plugin handles Antigravity synthetic quota false completion in foreground event', async () => {
    let promptBody: unknown;
    const promptAsync = mock(async (args: unknown) => {
      promptBody = args;
      return {};
    });
    const messages = mock(async () => ({
      data: [
        {
          info: { role: 'user', id: 'u1' },
          parts: [{ type: 'text', text: 'analyze code' }],
        },
      ],
    }));

    const client = {
      app: { log: async () => ({}) },
      session: {
        abort: mock(async () => ({})),
        promptAsync,
        messages,
      },
      tui: { showToast: mock(async () => ({})) },
    };

    await writeFile(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        autoUpdate: false,
        preset: 'quality',
        presets: {
          quality: {
            oracle: {
              model: [
                'google/antigravity-gemini-3-flash',
                'google/antigravity-gemini-3.7-flash',
              ],
              skills: [],
              mcps: [],
            },
          },
        },
      }),
    );

    const hooks = await plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    const host: Record<string, unknown> = { agent: {} };
    await hooks.config?.(host);

    const quotaText =
      'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h 50m. Add more accounts with `opencode auth login` or wait and retry.';

    await hooks.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'ses-integrated-fg',
            role: 'assistant',
            agent: 'oracle',
            providerID: 'google',
            modelID: 'antigravity-gemini-3-flash',
            finish: 'stop',
            tokens: { input: 0, output: 33 },
            time: { completed: Date.now() },
          },
          parts: [{ type: 'text', text: quotaText }],
        },
      },
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect((promptBody as any)?.body?.model).toEqual({
      providerID: 'google',
      modelID: 'antigravity-gemini-3.7-flash',
    });

    await hooks.dispose?.();
  });

  test('plugin registers outcome_control and enforces immutable deny for outcome-manager after host merge', async () => {
    const hooks = await createHooks();
    expect(hooks.tool?.outcome_control).toBeDefined();

    const hostConfig: Record<string, any> = {
      agent: {
        'outcome-manager': {
          permission: {
            '*': 'allow',
            outcome_control: 'allow',
          },
        },
      },
    };
    await hooks.config?.(hostConfig);

    const outcomeMgr = hostConfig.agent['outcome-manager'];
    expect(outcomeMgr.permission.outcome_control).toBe('deny');
    expect(outcomeMgr.permission['*']).toBe('deny');

    await hooks.dispose?.();
  });

  test('plugin outcome_control tool rejects unmanaged session and absent agent caller', async () => {
    const hooks = await createHooks();
    const outcomeControl = hooks.tool?.outcome_control;
    expect(outcomeControl).toBeDefined();

    // Absent agent
    await expect(
      outcomeControl.execute({ action: 'status' }, {
        sessionID: 'ses-unmanaged',
      } as never),
    ).rejects.toThrow('requires an explicit caller agent');

    // Unmanaged session
    await expect(
      outcomeControl.execute({ action: 'status' }, {
        sessionID: 'ses-unmanaged',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('not managed');

    await hooks.dispose?.();
  });
});

describe('multiplexer host gating', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('multiplexer is host-gated off on v2', () => {
    // Minimal base input satisfying every v1 condition: a configured
    // multiplexer type plus a live inside-session env marker (TMUX).
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    const baseInput = {
      multiplexerConfig: {
        type: 'tmux',
        layout: 'main-vertical',
        main_pane_size: 60,
        zellij_pane_mode: 'agent-tab',
      } satisfies MultiplexerConfig,
    };

    expect(shouldEnableMultiplexer(baseInput)).toBe(true); // v1 unchanged
    expect(shouldEnableMultiplexer({ hostFlavor: 'v2', ...baseInput })).toBe(
      false,
    );
  });

  test('multiplexer session manager config is forced off on v2 hosts', () => {
    const multiplexerConfig = {
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    } satisfies MultiplexerConfig;

    // v2: type forced to 'none' so the manager's env-based self-gate
    // (which would fire inside tmux) cannot re-enable pane management.
    expect(sessionManagerMultiplexerConfig('v2', multiplexerConfig).type).toBe(
      'none',
    );
    // v1: the exact same config object is passed through untouched.
    expect(sessionManagerMultiplexerConfig(undefined, multiplexerConfig)).toBe(
      multiplexerConfig,
    );
  });
});

describe('v1 host plugin module contract', () => {
  // OpenCode v1.18.23+ validates a plugin module's default export before
  // loading it:
  //   - `server`, when present, must be a function
  //   - `tui`, when present, must be a function
  //   - a module must not declare both `server` and `tui`
  // A boolean `tui: true` marker on the server entry violates the second
  // and third rules, so the whole plugin fails to load with
  // "Plugin ... has invalid tui export" (observed on v1.18.25). The TUI
  // entry ships separately via the `./tui` package export.
  test('server entry keeps a callable server export and no tui key', () => {
    expect(typeof pluginModuleDefault).toBe('object');
    expect(pluginModuleDefault).not.toBeNull();

    const module = pluginModuleDefault as Record<string, unknown>;

    // v1 loader: `server` present must be a function.
    expect(typeof module.server).toBe('function');
    // v1 loader: `tui` must be absent (or a function in a tui-only module);
    // a server module declaring `tui` is rejected outright.
    expect('tui' in module).toBe(false);
  });
});
