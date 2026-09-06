import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
  createToolLoopGuardHook,
  LOOP_GUARD_WARNING,
} from '../hooks/tool-loop-guard/hook';
import { createV2InterviewBridge, markerText } from './interview-bridge';
import { createSessionSubmit } from './session-submit';
import {
  applyCommandMarkerToContext,
  createCommandRegistration,
  createSessionContextHandler,
  createToolExecuteBridges,
  parseCommandMarker,
  registerSynthCommands,
  stripCommandMarker,
  type V1CommandBeforeHook,
  wrapCommandMarker,
} from './setup';
import type {
  V2CommandDefinition,
  V2CommandDraft,
  V2SessionContextEvent,
} from './types';

function makeEvent(
  messages: Array<{ id?: string; role: string; content: unknown[] }>,
  overrides?: Partial<V2SessionContextEvent>,
): V2SessionContextEvent {
  return {
    sessionID: 'ses_cmd',
    agent: 'orchestrator',
    model: {},
    system: [],
    tools: {},
    messages: messages as V2SessionContextEvent['messages'],
    ...overrides,
  };
}

describe('command marker wrap/parse', () => {
  test('round-trips empty, simple, and multiline args', () => {
    for (const args of ['', 'focus 25m', 'line one\nline two\nline three']) {
      expect(parseCommandMarker(wrapCommandMarker('deepwork', args))).toEqual({
        name: 'deepwork',
        args,
      });
    }
  });

  test('round-trips widened name charsets (\\w . -)', () => {
    for (const name of ['git_commit', 'Task.v2', 'deepwork', 'a-b-c']) {
      expect(parseCommandMarker(wrapCommandMarker(name, 'args'))).toEqual({
        name,
        args: 'args',
      });
    }
  });

  test('renders the exact marker shape', () => {
    expect(wrapCommandMarker('deepwork', 'focus')).toBe(
      '<omos-cmd-command data-name="deepwork">focus</omos-cmd-command>',
    );
    expect(wrapCommandMarker('loop', '')).toBe(
      '<omos-cmd-command data-name="loop"></omos-cmd-command>',
    );
  });

  test('whole-text anchored: embedded markers never match', () => {
    expect(
      parseCommandMarker(
        'before <omos-cmd-command data-name="reflect">a b</omos-cmd-command> after',
      ),
    ).toBeUndefined();
  });

  test('whole-text anchored: surrounding whitespace is tolerated', () => {
    expect(
      parseCommandMarker(`  \n${wrapCommandMarker('reflect', 'a b')}\n  `),
    ).toEqual({ name: 'reflect', args: 'a b' });
  });

  test('returns undefined without a marker', () => {
    expect(parseCommandMarker('plain user text')).toBeUndefined();
    expect(parseCommandMarker(markerText('x'))).toBeUndefined();
  });

  test('stripCommandMarker leaves the raw args on marker-only text', () => {
    expect(stripCommandMarker(wrapCommandMarker('deepwork', 'focus 25m'))).toBe(
      'focus 25m',
    );
    // Only runs on marker-only text (anchored pattern): other text is a no-op.
    expect(
      stripCommandMarker(`pre ${wrapCommandMarker('deepwork', 'x')} post`),
    ).toBe(`pre ${wrapCommandMarker('deepwork', 'x')} post`);
  });
});

describe('createCommandRegistration', () => {
  test('add-only draft registers via add and execute submits the marker', async () => {
    const added: V2CommandDefinition[] = [];
    const submit = mock(async () => {});
    createCommandRegistration(
      { add: (def) => added.push(def) },
      'deepwork',
      { description: 'Start a deep work block' },
      submit,
    );

    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe('deepwork');
    expect(added[0]?.description).toBe('Start a deep work block');
    expect(added[0]?.execute).toBeTypeOf('function');

    await added[0]?.execute({
      sessionID: 'ses_1',
      prompt: { text: 'focus on tests' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      'ses_1',
      wrapCommandMarker('deepwork', 'focus on tests'),
    );
  });

  test('execute swallows submit errors and empty prompts', async () => {
    const added: V2CommandDefinition[] = [];
    const submit = mock(async () => {
      throw new Error('transport down');
    });
    createCommandRegistration(
      { add: (def) => added.push(def) },
      'loop',
      {},
      submit,
    );

    await expect(
      added[0]?.execute({ sessionID: 'ses_2', prompt: { text: '' } }),
    ).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledWith('ses_2', wrapCommandMarker('loop', ''));
  });

  test('a throwing draft.add propagates to the caller (no internal catch)', () => {
    const draft: V2CommandDraft = {
      add: () => {
        throw new Error('draft rejected');
      },
    };
    expect(() =>
      createCommandRegistration(draft, 'loop', {}, async () => {}),
    ).toThrow('draft rejected');
  });

  test('draft without add is a logged no-op', () => {
    expect(() =>
      createCommandRegistration(
        {} as V2CommandDraft,
        'loop',
        {},
        async () => {},
      ),
    ).not.toThrow();
  });
});

describe('registerSynthCommands (generic loop skips bridge-owned interview)', () => {
  test('interview is NOT add()ed from the generic path; the bridge registers it', () => {
    const added: V2CommandDefinition[] = [];
    const draft: V2CommandDraft = { add: (def) => added.push(def) };

    registerSynthCommands(
      draft,
      [
        ['interview', { description: 'Open a localhost interview UI' }],
        ['deepwork', { description: 'Start a deep work block' }],
      ],
      async () => {},
    );
    expect(added.map((def) => def.name)).toEqual(['deepwork']);

    const bridge = createV2InterviewBridge({ session: {} } as never, undefined);
    bridge.registerCommand(draft);
    expect(added.map((def) => def.name)).toEqual(['deepwork', 'interview']);
    bridge.dispose();
  });

  test('a failing command is skipped without blocking the rest', () => {
    const added: V2CommandDefinition[] = [];
    const draft: V2CommandDraft = {
      add: (def) => {
        if (def.name === 'deepwork') throw new Error('draft rejected');
        added.push(def);
      },
    };

    registerSynthCommands(
      draft,
      [
        ['deepwork', {}],
        ['loop', {}],
      ],
      async () => {},
    );
    expect(added.map((def) => def.name)).toEqual(['loop']);
  });
});

describe('createSessionSubmit', () => {
  test('submits via ctx.session.prompt only', async () => {
    const prompt = mock(async () => ({}));
    await createSessionSubmit({
      session: { prompt },
    } as never)('ses_a', 'hello');
    expect(prompt).toHaveBeenCalledWith({ sessionID: 'ses_a', text: 'hello' });
  });

  test('logs and gives up when prompt is unavailable', async () => {
    await expect(
      createSessionSubmit({ session: {} } as never)('ses_c', 'hello'),
    ).resolves.toBeUndefined();
  });

  test('undefined session domain resolves without throwing', async () => {
    // Reduced hosts may omit ctx.session entirely; the probe inside must
    // take the unavailable path, not die on `session.prompt` of undefined.
    await expect(
      createSessionSubmit({} as never)('ses_e', 'hello'),
    ).resolves.toBeUndefined();
  });

  test('never throws on transport errors', async () => {
    const prompt = mock(async () => {
      throw new Error('boom');
    });
    await expect(
      createSessionSubmit({ session: { prompt } } as never)('ses_d', 'x'),
    ).resolves.toBeUndefined();
  });
});

describe('interview registerCommand (add-only draft)', () => {
  test('registers via add and execute submits the interview marker', async () => {
    const prompt = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { prompt } } as never,
      undefined,
    );
    const added: V2CommandDefinition[] = [];
    bridge.registerCommand({ add: (def) => added.push(def) });

    expect(added).toHaveLength(1);
    expect(added[0]?.name).toBe('interview');
    expect(added[0]?.description).toBe(
      'Open a localhost interview UI for a feature idea',
    );

    await added[0]?.execute({
      sessionID: 'ses_iv',
      prompt: { text: 'build a notes app' },
    });
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'ses_iv',
      text: markerText('build a notes app'),
    });
    bridge.dispose();
  });
});

describe('applyCommandMarkerToContext', () => {
  test('replaces the trailing marker with hook parts; other messages untouched', async () => {
    const earlier = {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'earlier context' }],
    };
    const trailing = {
      id: 'm2',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('deepwork', 'focus 25m') },
      ],
    };
    const event = makeEvent([earlier, trailing]);
    const earlierBefore = structuredClone(earlier);

    const calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }> = [];
    const commandBefore: V1CommandBeforeHook = async (input, output) => {
      calls.push(input);
      output.parts.push({
        type: 'text',
        text: 'DEEPWORK EXPANDED',
        synthetic: true,
      });
    };

    await applyCommandMarkerToContext(event, commandBefore);

    expect(earlier).toEqual(earlierBefore);
    expect(calls).toEqual([
      { command: 'deepwork', sessionID: 'ses_cmd', arguments: 'focus 25m' },
    ]);
    expect(trailing.content).toEqual([
      { type: 'text', text: 'DEEPWORK EXPANDED', synthetic: true },
    ]);
  });

  test('empty hook parts strip the marker and leave the raw args', async () => {
    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('reflect', 'standup notes') },
      ],
    };
    const event = makeEvent([trailing]);
    const calls: unknown[] = [];
    const commandBefore: V1CommandBeforeHook = async (input) => {
      calls.push(input);
    };

    await applyCommandMarkerToContext(event, commandBefore);

    expect(calls).toHaveLength(1);
    expect(trailing.content).toEqual([{ type: 'text', text: 'standup notes' }]);
  });

  test('no-ops for assistant trailing messages and marker-less text', async () => {
    const calls: unknown[] = [];
    const commandBefore: V1CommandBeforeHook = async (input) => {
      calls.push(input);
    };

    const assistant = makeEvent([
      { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    await applyCommandMarkerToContext(assistant, commandBefore);

    const plain = makeEvent([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'plain' }] },
    ]);
    await applyCommandMarkerToContext(plain, commandBefore);

    expect(calls).toEqual([]);
  });
});

describe('createSessionContextHandler (merged context hook seam)', () => {
  function recordCommandCalls(): {
    calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }>;
    hook: V1CommandBeforeHook;
  } {
    const calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }> = [];
    return {
      calls,
      hook: async (input) => {
        calls.push(input);
      },
    };
  }

  test('(a) interview-marker-only tail: interview handler fires, generic dispatch no-op', async () => {
    const directory = `.tmp-v2-seam-a-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const rename = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { synthetic, rename } } as never,
      { outputFolder: directory } as never,
    );
    const { calls, hook } = recordCommandCalls();
    const handler = createSessionContextHandler({
      interviewHandleContext: (event) => bridge.handleContext(event),
      commandBefore: hook,
    });

    const earlier = {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'earlier context' }],
    };
    const trailing = {
      id: 'm2',
      role: 'user',
      content: [{ type: 'text', text: markerText('build a notes app') }],
    };
    const event = makeEvent([earlier, trailing]);
    const earlierBefore = structuredClone(earlier);

    await handler(event);

    expect(calls).toEqual([]); // generic dispatch no-op
    expect(earlier).toEqual(earlierBefore);
    // The interview bridge consumed the marker (tail rewritten).
    expect(JSON.stringify(trailing.content)).toContain('<interview_state>');

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });

  test('(b) generic-marker-only tail: generic dispatch fires, interview no-op', async () => {
    const directory = `.tmp-v2-seam-b-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { synthetic } } as never,
      { outputFolder: directory } as never,
    );
    const calls: Array<{
      command: string;
      sessionID: string;
      arguments: string;
    }> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: (event) => bridge.handleContext(event),
      commandBefore: async (input, output) => {
        calls.push(input);
        output.parts.push({ type: 'text', text: 'GENERIC EXPANDED' });
      },
    });

    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: wrapCommandMarker('deepwork', 'focus 25m') },
      ],
    };
    const event = makeEvent([trailing]);

    await handler(event);

    expect(calls).toEqual([
      { command: 'deepwork', sessionID: 'ses_cmd', arguments: 'focus 25m' },
    ]);
    expect(trailing.content).toEqual([
      { type: 'text', text: 'GENERIC EXPANDED' },
    ]);
    // Interview bridge no-op on generic markers: no synthetic notification.
    expect(synthetic).not.toHaveBeenCalled();

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });

  test('(c) system/messages transforms + chat.message run on the same event', async () => {
    const chatCalls: Array<{ sessionID: string; agent?: string }> = [];
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      chatMessage: async (input) => {
        chatCalls.push(input);
      },
      systemTransform: async (_input, output) => {
        output.system.push('INJECTED');
      },
      messagesTransform: async (_input, output) => {
        output.messages[0]?.parts.push({ type: 'text', text: 'APPENDED' });
      },
    });

    const message = {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const event = makeEvent([message], {
      system: [{ type: 'text', text: 'base' }],
    });

    await handler(event);

    expect(chatCalls).toEqual([
      { sessionID: 'ses_cmd', agent: 'orchestrator', messageID: 'u' },
    ]);
    expect(event.system).toEqual([
      { type: 'text', text: 'base' },
      { type: 'text', text: 'INJECTED' },
    ]);
    expect(message.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'APPENDED' },
    ]);
  });

  test('(d) embedded markers inside other text never fire either dispatcher', async () => {
    const directory = `.tmp-v2-seam-d-${Date.now()}`;
    const synthetic = mock(async () => ({}));
    const bridge = createV2InterviewBridge(
      { session: { synthetic } } as never,
      { outputFolder: directory } as never,
    );
    const { calls, hook } = recordCommandCalls();
    const handler = createSessionContextHandler({
      interviewHandleContext: (event) => bridge.handleContext(event),
      commandBefore: hook,
    });

    const trailing = {
      id: 'm1',
      role: 'user',
      content: [
        {
          type: 'text',
          text: `look at ${wrapCommandMarker('deepwork', 'x')} and ${markerText('idea')} please`,
        },
      ],
    };
    const event = makeEvent([trailing]);
    const contentBefore = structuredClone(trailing.content);

    await handler(event);

    expect(calls).toEqual([]);
    expect(synthetic).not.toHaveBeenCalled();
    expect(trailing.content).toEqual(contentBefore);

    bridge.dispose();
    await fs.rm(`${process.cwd()}/${directory}`, {
      recursive: true,
      force: true,
    });
  });
});

describe('tool execute bridge normalization', () => {
  test('before bridge maps subagent call into v1 task shape and writes back', async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const before = async (
      i: { tool: string; sessionID: string; callID: string },
      o: { args: unknown },
    ) => {
      seen.push({ tool: i.tool, args: { ...(o.args as object) } });
      (o.args as Record<string, unknown>).task_id = 'ses_rewritten';
    };
    const event = {
      tool: 'subagent',
      sessionID: 'ses_parent',
      agent: 'orchestrator',
      messageID: 'msg_1',
      id: 'call_1',
      input: {
        agent: 'fixer',
        description: 'd',
        prompt: 'p',
        sessionID: 'ses_old',
      },
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await beforeBridge(event);
    expect(seen[0]).toMatchObject({ tool: 'task' });
    expect(seen[0]?.args).toMatchObject({
      subagent_type: 'fixer',
      task_id: 'ses_old',
    });
    expect(event.input).toEqual({
      agent: 'fixer',
      description: 'd',
      prompt: 'p',
      sessionID: 'ses_rewritten',
    });
  });

  test('before bridge rethrows hook rejection so v2 refuses the call', async () => {
    const before = async () => {
      throw new Error('duplicate spawn refused');
    };
    const { beforeBridge } = createToolExecuteBridges(before, undefined);
    await expect(
      beforeBridge({
        tool: 'subagent',
        sessionID: 's',
        agent: 'a',
        messageID: 'm',
        id: 'c',
        input: {},
      }),
    ).rejects.toThrow('duplicate spawn refused');
  });

  test('after bridge presents subagent output under task name', async () => {
    const seen: Array<{ tool: string; output: unknown }> = [];
    const after = async (_i: unknown, o: { output: unknown }) => {
      seen.push({ tool: 'task', output: o.output });
    };
    const { afterBridge } = createToolExecuteBridges(undefined, after);
    await afterBridge({
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed',
      result: {
        content:
          'The subagent is working in the background (sessionID: ses_x).',
      },
    });
    expect(seen[0]?.output).toContain('(sessionID: ses_x)');
  });

  test('after bridge leaves unchanged mixed content untouched', async () => {
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'url', url: 'image://one' } },
      { type: 'text', text: 'after' },
    ];
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { content },
    };
    const { afterBridge } = createToolExecuteBridges(undefined, async () => {});

    await afterBridge(event);

    expect(event.result.content).toBe(content);
    expect(event.result.content).toEqual(content);
  });

  test('after bridge retains output-only result fallback', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { output: 'fallback output' },
    };
    const { afterBridge } = createToolExecuteBridges(undefined, async () => {});

    await afterBridge(event);

    expect(event.result).toEqual({ output: 'fallback output' });
  });

  test('after bridge renders changing structured outputs distinctly', async () => {
    const seen: unknown[] = [];
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_input, output: { output: unknown }) => {
        seen.push(output.output);
      },
    );
    const makeEvent = (value: number) => ({
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: `c-${value}`,
      input: {},
      status: 'completed' as const,
      result: { content: [], output: { value } },
    });

    await afterBridge(makeEvent(1));
    await afterBridge(makeEvent(2));

    expect(seen).toEqual(['{"value":1}', '{"value":2}']);
  });

  test('after bridge keeps structured output when appending warning text', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { content: [], output: { value: 1 } },
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_input, output: { output: unknown }) => {
        output.output = `${output.output}\nwarning`;
      },
    );

    await afterBridge(event);

    expect(event.result.output).toEqual({ value: 1 });
    expect(event.result.content).toBe('{"value":1}\nwarning');
  });

  test('after bridge preserves string content when the v1 output changes', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: { content: 'original' },
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (_input, output: { output: unknown }) => {
        output.output = 'rewritten';
      },
    );

    await afterBridge(event);

    expect(event.result.content).toBe('rewritten');
  });

  test('after bridge appends warnings without disturbing mixed content order', async () => {
    const event = {
      tool: 'subagent',
      sessionID: 's',
      agent: 'a',
      messageID: 'm',
      id: 'c',
      input: {},
      status: 'completed' as const,
      result: {
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { type: 'url', url: 'image://one' } },
          { type: 'text', text: 'after' },
        ],
      },
    };
    const { afterBridge } = createToolExecuteBridges(
      undefined,
      async (
        _input,
        output: { output: unknown; metadata: Record<string, unknown> },
      ) => {
        output.output = 'beforeafter\nwarning';
      },
    );

    await afterBridge(event);

    expect(event.result.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'url', url: 'image://one' } },
      { type: 'text', text: 'after\nwarning' },
    ]);
  });

  test('context continuations do not reset alternating poll detection', async () => {
    const loopGuard = createToolLoopGuardHook();
    const handler = createSessionContextHandler({
      interviewHandleContext: async () => {},
      chatMessage: async (input) => {
        if (input.messageID) {
          loopGuard.observeNewUserMessage(input.sessionID, input.messageID);
        }
      },
    });
    const context = makeEvent(
      [
        {
          id: 'user-1',
          role: 'user',
          content: [{ type: 'text', text: 'poll' }],
        },
      ],
      { sessionID: 'ses_parent' },
    );
    const poll = async (
      tool: string,
      callID: string,
      output: string,
    ): Promise<unknown> => {
      await loopGuard['tool.execute.before'](
        { tool, sessionID: 'ses_parent', callID },
        { args: { task_id: 'ses_child' } },
      );
      const result = { output };
      await loopGuard['tool.execute.after'](
        { tool, sessionID: 'ses_parent', callID },
        result,
      );
      return result.output;
    };

    await handler(context);
    await poll('task_status', 'poll-1', 'task_id: ses_child\nstate: busy');
    await handler(context);
    await poll('task_result', 'poll-2', 'task_id: ses_child\nstate: running');
    await handler(context);
    const third = await poll(
      'task_status',
      'poll-3',
      'task_id: ses_child\nstate: busy',
    );

    expect(third).toContain(LOOP_GUARD_WARNING);

    await handler(
      makeEvent(
        [
          {
            id: 'user-2',
            role: 'user',
            content: [{ type: 'text', text: 'next' }],
          },
        ],
        { sessionID: 'ses_parent' },
      ),
    );
    const nextTurn = await poll(
      'task_result',
      'poll-4',
      'task_id: ses_child\nstate: running',
    );
    expect(nextTurn).not.toContain(LOOP_GUARD_WARNING);
  });
});
