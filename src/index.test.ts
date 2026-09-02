import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { RuntimeConfig } from './config/runtime';
import { CooldownRegistry } from './hooks/foreground-fallback/cooldown-registry';
import { OhMyOpenCodeLite as plugin } from './index';

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
});
