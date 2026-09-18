/**
 * Constructor overload-shim routing guard.
 *
 * `ForegroundFallbackManager`'s constructor takes the long positional
 * signature production uses (upstream's parameters followed by the fork's
 * appended parameters 11-13) and disambiguates the union-typed middle
 * parameters by argument type. The audit hazard: a future upstream positional
 * parameter can be silently bound to a fork parameter and swallowed, and the
 * `as any` casts inside the shim stop the compiler from catching the shift.
 *
 * These tests construct the manager with the exact production argument order
 * (mirroring `src/index.ts`'s `new ForegroundFallbackManager(...)`) and assert
 * the observable consequence of every binding that matters:
 *
 *   arg 9  backgroundFallbackHandoff   -> handoff.prepare/admit are invoked
 *   arg 10 readBackgroundGeneration    -> the pre-await generation reaches
 *                                         handoff.prepare (the boundary slot
 *                                         that collides if upstream inserts a
 *                                         new positional parameter)
 *   arg 11 cooldownRegistryParam       -> the injected registry governs
 *                                         selectInitialModel()
 *   arg 12 modelVariantsParam          -> the injected variant is replayed
 *   arg 13 isTaskSessionParam          -> task-owned sessions suppress generic
 *                                         synthetic-quota recovery
 *   arg 6  onSessionModelChanged       -> notified after the switch
 *
 * Each assertion fails if its parameter routes to the wrong property.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { FailureVerdict } from './classify-failure';
import { CooldownRegistry } from './cooldown-registry';
import { ForegroundFallbackManager } from './index';

// `execFallback` and `tryFallbackWithAbort` resolve the client through the
// module-level `getClient`, so the fallback scenario controls it here.
let currentSession: Record<string, unknown> = {};
mock.module('../../utils/opencode-client', () => ({
  getClient: () => ({ session: currentSession }),
}));

let cooldownTempDir: string;
beforeEach(() => {
  cooldownTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-ctor-shim-'));
  process.env.OMOS_COOLDOWN_FILE = path.join(cooldownTempDir, 'cooldowns.json');
  delete process.env.OMOS_COOLDOWN_DISABLED;
  const globalInProgress = globalThis as typeof globalThis & {
    [key: symbol]: Set<string> | undefined;
  };
  globalInProgress[
    Symbol.for('oh-my-opencode-slim.foreground-fallback.in-progress')
  ]?.clear();
  currentSession = {};
});
afterEach(() => {
  delete process.env.OMOS_COOLDOWN_FILE;
  delete process.env.OMOS_COOLDOWN_DISABLED;
  fs.rmSync(cooldownTempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Production positional argument order
// ---------------------------------------------------------------------------

/** Narrow cast: only `directory` is read by the paths under test; the real
 *  host always supplies the rest of `PluginInput` at plugin init. */
const pluginInput = {
  directory: '/test',
  worktree: '/test',
} as unknown as PluginInput;

type ForegroundCtorArgs = ConstructorParameters<
  typeof ForegroundFallbackManager
>;
type SessionModelChanged = (sessionID: string, model: string) => void;

interface Handoff {
  prepare: (
    sessionID: string,
    preparedGeneration: number | undefined,
    baselineMessageID: string | undefined,
  ) => boolean;
  admit: (sessionID: string, preparedGeneration: number | undefined) => void;
  reject: (sessionID: string, preparedGeneration: number | undefined) => void;
  settleUnresolved: (
    sessionID: string,
    preparedGeneration: number | undefined,
  ) => void;
}

/**
 * Builds the exact argument tuple `src/index.ts` passes. The tuple type is
 * `ConstructorParameters`, so if the constructor gains/loses a parameter the
 * tuple assignment fails to compile — a cheap count/ordering tripwire that
 * complements the runtime routing assertions below.
 */
function productionArgs(options: {
  chains: Record<string, string[]>;
  registry: CooldownRegistry;
  modelVariants?: Record<string, Record<string, string | undefined>>;
  handoff?: Handoff;
  readGeneration?: (sessionID: string) => number | undefined;
  isTaskSession?: (sessionID: string) => boolean;
  onModelChanged?: SessionModelChanged;
  initialRetryDelayMs?: number;
  retryDelayMs?: number;
}): ForegroundCtorArgs {
  return [
    options.chains,
    true, // enabled
    pluginInput,
    3, // maxRetries
    undefined, // coordinator (SessionLifecycle)
    options.onModelChanged,
    options.initialRetryDelayMs ?? 0,
    options.retryDelayMs ?? 500,
    options.handoff,
    options.readGeneration,
    options.registry,
    options.modelVariants ?? {},
    options.isTaskSession,
  ];
}

const QUOTA_TEXT =
  'All 1 account(s) rate-limited for gemini-3-flash. Quota resets in 1h. Add more accounts with `opencode auth login` or wait and retry.';

const quotaVerdict: FailureVerdict = {
  class: 'quota',
  cooldownMs: 60_000,
  reason: 'constructor-shim test quota',
};

// ---------------------------------------------------------------------------
// arg 11 — cooldown registry
// ---------------------------------------------------------------------------

describe('ForegroundFallbackManager constructor positional shim', () => {
  test('routes the injected cooldown registry (arg 11) into initial model selection', () => {
    // If the registry did not route, the manager would consult the default
    // process registry (clean) and return the configured (cooling) primary.
    const registry = new CooldownRegistry(
      path.join(cooldownTempDir, 'injected.json'),
    );
    registry.markFailure('fp-test/primary', quotaVerdict);

    const manager = new ForegroundFallbackManager(
      ...productionArgs({
        chains: {
          orchestrator: ['fp-test/primary', 'fp-test/secondary'],
        },
        registry,
      }),
    );

    expect(manager.selectInitialModel('orchestrator', 'fp-test/primary')).toBe(
      'fp-test/secondary',
    );
  });

  // -------------------------------------------------------------------------
  // args 6, 9, 10, 12 — full fallback scenario
  // -------------------------------------------------------------------------

  test('routes handoff (arg 9), pre-await generation (arg 10), model variants (arg 12) and the model-changed callback (arg 6)', async () => {
    const promptAsync = mock(async () => ({}));
    const messages = mock(async () => ({
      data: [
        {
          info: { id: 'm1', role: 'user' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    }));
    currentSession = {
      promptAsync,
      messages,
      abort: mock(async () => ({})),
    };

    const prepareCalls: Array<
      [string, number | undefined, string | undefined]
    > = [];
    const admitCalls: Array<[string, number | undefined]> = [];
    const handoff: Handoff = {
      prepare: (sessionID, preparedGeneration, baselineMessageID) => {
        prepareCalls.push([sessionID, preparedGeneration, baselineMessageID]);
        return true;
      },
      admit: (sessionID, preparedGeneration) => {
        admitCalls.push([sessionID, preparedGeneration]);
      },
      reject: () => {},
      settleUnresolved: () => {},
    };
    const onModelChanged = mock(
      (_sessionID: string, _model: string): void => {},
    );
    const registry = new CooldownRegistry(
      path.join(cooldownTempDir, 'fallback.json'),
    );

    const manager = new ForegroundFallbackManager(
      ...productionArgs({
        chains: {
          orchestrator: ['fp-test/primary', 'fp-test/secondary'],
        },
        registry,
        modelVariants: { orchestrator: { 'fp-test/secondary': 'high' } },
        handoff,
        readGeneration: () => 42,
        onModelChanged,
      }),
    );

    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sess-1',
          agent: 'orchestrator',
          providerID: 'fp-test',
          modelID: 'primary',
          role: 'assistant',
        },
      },
    });
    await manager.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'sess-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    // arg 10: the pre-await generation reached prepare; arg 9: the handoff
    // object (not a task predicate) owned the call, and admit fired.
    expect(prepareCalls).toEqual([['sess-1', 42, 'm1']]);
    expect(admitCalls).toEqual([['sess-1', 42]]);
    // arg 6: the injected model-changed callback was notified.
    expect(onModelChanged).toHaveBeenCalledWith('sess-1', 'fp-test/secondary');

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const promptCall = promptAsync.mock.calls[0]?.[0] as
      | {
          body?: { model?: unknown; variant?: unknown; agent?: unknown };
        }
      | undefined;
    expect(promptCall?.body?.model).toEqual({
      providerID: 'fp-test',
      modelID: 'secondary',
    });
    // arg 12: the injected variant was preserved on the replay.
    expect(promptCall?.body?.variant).toBe('high');
  });

  // -------------------------------------------------------------------------
  // arg 13 — isTaskSession predicate
  // -------------------------------------------------------------------------

  test('routes the injected isTaskSession predicate (arg 13) to suppress generic synthetic-quota recovery', async () => {
    const promptAsync = mock(async () => ({}));
    currentSession = {
      promptAsync,
      messages: mock(async () => ({ data: [] })),
      abort: mock(async () => ({})),
    };

    const isTaskSession = mock((_sessionID: string): boolean => true);
    const registry = new CooldownRegistry(
      path.join(cooldownTempDir, 'task-session.json'),
    );
    const manager = new ForegroundFallbackManager(
      ...productionArgs({
        chains: {
          orchestrator: [
            'google/antigravity-gemini-3-flash',
            'google/antigravity-gemini-3.7-flash',
          ],
        },
        registry,
        isTaskSession,
      }),
    );

    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'ftask-1',
          agent: 'orchestrator',
          providerID: 'google',
          modelID: 'antigravity-gemini-3-flash',
          role: 'assistant',
          finish: 'stop',
          tokens: { input: 0, output: 1 },
          time: { completed: Date.now() },
        },
        parts: [{ type: 'text', text: QUOTA_TEXT }],
      },
    });

    // If arg 13 were bound elsewhere, the generic path would mark the model
    // cooling and re-prompt. Task-owned incidents are suppressed instead.
    expect(isTaskSession).toHaveBeenCalledWith('ftask-1');
    expect(promptAsync).not.toHaveBeenCalled();
    expect(registry.isDead('google/antigravity-gemini-3-flash')).toBe(false);
  });

  test('control: the same synthetic-quota event falls back when the predicate returns false', async () => {
    // Positive control for the suppression test above: proves the event would
    // otherwise drive a fallback, so "promptAsync not called" is meaningful.
    const promptAsync = mock(async () => ({}));
    currentSession = {
      promptAsync,
      messages: mock(async () => ({
        data: [
          {
            info: { id: 'm1', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      })),
      abort: mock(async () => ({})),
    };

    const registry = new CooldownRegistry(
      path.join(cooldownTempDir, 'control.json'),
    );
    const manager = new ForegroundFallbackManager(
      ...productionArgs({
        chains: {
          orchestrator: [
            'google/antigravity-gemini-3-flash',
            'google/antigravity-gemini-3.7-flash',
          ],
        },
        registry,
        isTaskSession: () => false,
      }),
    );

    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'fctrl-1',
          agent: 'orchestrator',
          providerID: 'google',
          modelID: 'antigravity-gemini-3-flash',
          role: 'assistant',
          finish: 'stop',
          tokens: { input: 0, output: 1 },
          time: { completed: Date.now() },
        },
        parts: [{ type: 'text', text: QUOTA_TEXT }],
      },
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // arg 7 — initial retry delay
  // -------------------------------------------------------------------------

  test('routes the initial retry delay (arg 7): a positive value defers, then still performs, the first fallback', async () => {
    // If arg 7 were swallowed by the union (default 0), the fallback would fire
    // synchronously and the first assertion would fail.
    const promptAsync = mock(async () => ({}));
    currentSession = {
      promptAsync,
      messages: mock(async () => ({
        data: [
          {
            info: { id: 'm1', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      })),
      abort: mock(async () => ({})),
    };

    const registry = new CooldownRegistry(
      path.join(cooldownTempDir, 'initial-delay.json'),
    );
    const manager = new ForegroundFallbackManager(
      ...productionArgs({
        chains: {
          orchestrator: ['fp-delay/primary', 'fp-delay/secondary'],
        },
        registry,
        initialRetryDelayMs: 40,
      }),
    );

    await manager.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'delay-1',
          agent: 'orchestrator',
          providerID: 'fp-delay',
          modelID: 'primary',
          role: 'assistant',
        },
      },
    });
    await manager.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'delay-1',
        error: { message: 'Rate limit exceeded' },
      },
    });

    expect(promptAsync).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
