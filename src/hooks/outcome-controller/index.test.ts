import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutcomeController } from '../../outcome/controller';
import {
  type OutcomeContract,
  OutcomeContractSchema,
} from '../../outcome/controller-schema';
import { BackgroundJobBoard } from '../../utils';
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { isTaggedPart } from '../cache-safe-injection';
import {
  createOutcomeControllerHook,
  isRecognizableDirectOpenCodeRestart,
  OUTCOME_CONTROLLER_METADATA_KEY,
  OUTCOME_CONTROLLER_WAKE_TEXT,
} from './index';

function sampleContract(): OutcomeContract {
  return OutcomeContractSchema.parse({
    classification: 'non_trivial',
    objective: 'Test outcome controller hook',
    deliverables: ['hook deliverable'],
    goals: [
      {
        id: 'goal-hook',
        description: 'Verify hook integration',
        status: 'in_progress',
      },
    ],
    inScope: ['src/hooks'],
    outOfScope: [],
    constraints: ['No unreviewed volatile inputs'],
    safetyBoundaries: ['Never claim attestations are machine-verified'],
    handoffRequirements: ['Verification steps ready'],
    sourceMessageIds: ['msg_hook_init'],
    rules: [],
    exceptions: [],
  });
}

function dispatchInstruction(
  controller: OutcomeController,
  rootSessionId: string,
): string {
  const nudge = controller.getPendingNudge(rootSessionId);
  if (nudge?.kind !== 'dispatch') throw new Error('dispatch nudge missing');
  return nudge.instruction;
}

describe('OutcomeControllerHook', () => {
  let tempDir: string;
  let controller: OutcomeController;
  let board: BackgroundJobBoard;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-hook-test-'));
    board = new BackgroundJobBoard();
    controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: (taskID) => board.get(taskID),
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('injects live token in volatile nudge message and passes validation unchanged', async () => {
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === 'ses_managed',
      backgroundJobBoard: board,
    });

    const root = 'ses_managed';
    const beginRes = controller.begin(root, sampleContract());
    expect(beginRes.success).toBe(true);

    const messages = [
      {
        info: { role: 'user', sessionID: root, id: 'm1' },
        parts: [{ type: 'text', text: 'Please begin work' }],
      },
    ];

    const output = { messages: structuredClone(messages) };
    await hook['experimental.chat.messages.transform']({} as never, output);

    expect(output.messages.length).toBe(2);
    const volatileMsg = output.messages[1] as {
      parts: Array<{
        type: string;
        text?: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    expect(
      isTaggedPart(volatileMsg.parts[0], OUTCOME_CONTROLLER_METADATA_KEY),
    ).toBe(true);
    const injectedText = volatileMsg.parts[0].text || '';
    expect(injectedText).toContain('OMOS_DISPATCH_MARKER');

    // Passing the injected prompt directly to tool.execute.before with output.args
    const beforeOutput = {
      args: {
        subagent_type: 'outcome-manager',
        prompt: injectedText,
      },
    };
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: root, callID: 'call_live_pass' },
        beforeOutput,
      ),
    ).resolves.toBeUndefined();

    // Simulate task-session-manager registering the task on the board first
    board.registerLaunch({
      taskID: 'mgr_task_1',
      parentSessionID: root,
      agent: 'outcome-manager',
      description: 'Outcome review',
      now: 100,
    });

    // Run after hook
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: root, callID: 'call_live_pass' },
      {
        output: `<task id="mgr_task_1" state="running">\n<summary>Running</summary>\n</task>`,
      },
    );

    const status = controller.getStatus(root);
    expect(status.checkpoint?.state).toBe('running');
  });

  test('tool.execute.before with real output.args enforces marker correlation and fails closed without callID', async () => {
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === 'ses_managed',
      backgroundJobBoard: board,
    });

    const root = 'ses_managed';
    const beginRes = controller.begin(root, sampleContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    // Fails closed without callID
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: root },
        {
          args: {
            subagent_type: 'outcome-manager',
            prompt: dispatchInstruction(controller, root),
          },
        },
      ),
    ).rejects.toThrow('non-empty callID');

    // Normal explorer task passes through
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: root, callID: 'call_exp' },
        { args: { subagent_type: 'explorer', prompt: 'Search files' } },
      ),
    ).resolves.toBeUndefined();

    // Outcome manager task without marker throws
    await expect(
      hook['tool.execute.before'](
        { tool: 'task', sessionID: root, callID: 'call_mgr_fail' },
        { args: { subagent_type: 'outcome-manager', prompt: 'Review please' } },
      ),
    ).rejects.toThrow('OMOS dispatch marker');
  });

  test('chat.message observes external user turns and ignores internal initiator', async () => {
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === 'ses_managed',
      backgroundJobBoard: board,
    });

    const root = 'ses_managed';
    controller.begin(root, sampleContract());

    // Internal initiator turn should be ignored
    const internalPart = createInternalAgentTextPart('Continuation message');
    await hook['chat.message']({
      sessionID: root,
      parts: [internalPart],
      messageID: 'msg_internal',
    });

    let rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages.length).toBe(0);

    // External real user turn should be recorded
    await hook['chat.message']({
      sessionID: root,
      parts: [{ type: 'text', text: 'I approve option A' }],
      messageID: 'msg_user_real',
    });

    rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages.length).toBe(1);
    expect(rec.data.receipts.userMessages[0].messageId).toBe('msg_user_real');
  });

  test('same-process hook recreation binds from durable dispatch identity', async () => {
    const root = 'ses_managed';
    const first = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    const begin = controller.begin(root, sampleContract());
    expect(begin.success).toBe(true);
    if (!begin.success) return;

    await first['tool.execute.before'](
      { tool: 'task', sessionID: root, callID: 'call_recreated' },
      {
        args: {
          subagent_type: 'outcome-manager',
          prompt: dispatchInstruction(controller, root),
        },
      },
    );
    board.registerLaunch({
      taskID: 'manager_recreated',
      parentSessionID: root,
      agent: 'outcome-manager',
      description: 'Outcome review',
    });

    const recreated = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    await recreated['tool.execute.after'](
      { tool: 'task', sessionID: root, callID: 'call_recreated' },
      { output: 'task_id: manager_recreated\nstate: running' },
    );

    expect(controller.getStatus(root).checkpoint).toMatchObject({
      state: 'running',
      claimGeneration: 1,
    });
  });

  test('invalid Manager board binding retires the claim fail closed', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    const begin = controller.begin(root, sampleContract());
    expect(begin.success).toBe(true);
    if (!begin.success) return;

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: root, callID: 'call_invalid_binding' },
      {
        args: {
          subagent_type: 'outcome-manager',
          prompt: dispatchInstruction(controller, root),
        },
      },
    );
    board.registerLaunch({
      taskID: 'manager_wrong_parent',
      parentSessionID: 'different_root',
      agent: 'outcome-manager',
      description: 'Wrong parent',
    });

    await expect(
      hook['tool.execute.after'](
        { tool: 'task', sessionID: root, callID: 'call_invalid_binding' },
        { output: 'task_id: manager_wrong_parent\nstate: running' },
      ),
    ).rejects.toThrow('invalid parent/agent identity');
    expect(controller.getStatus(root)).toMatchObject({
      phase: 'action_required',
      checkpoint: { state: 'retired' },
    });
  });

  test('reserved Manager dispatch rolls back after a later preflight rejection', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    const begin = controller.begin(root, sampleContract());
    expect(begin.success).toBe(true);
    if (!begin.success) return;
    const input = {
      tool: 'task',
      sessionID: root,
      callID: 'call_preflight_rejected',
    };
    const output = {
      args: {
        subagent_type: 'outcome-manager',
        prompt: dispatchInstruction(controller, root),
      },
    };

    const reservation = hook.reserveManagerDispatch(input, output);
    expect(reservation).toEqual({
      rootSessionId: root,
      callId: 'call_preflight_rejected',
    });
    expect(controller.getStatus(root).checkpoint?.state).toBe('dispatching');
    await hook['tool.execute.before'](input, output);
    let record = controller.readRecord(root);
    expect(record.success && record.data.operations).toHaveLength(0);
    hook.failReservedManagerDispatch(
      reservation as NonNullable<typeof reservation>,
      'Manager dispatch rejected before native launch: duplicate task',
    );

    expect(controller.getStatus(root)).toMatchObject({
      phase: 'action_required',
      checkpoint: { state: 'retired' },
    });
    record = controller.readRecord(root);
    expect(record.success && record.data.operations).toHaveLength(0);
  });

  test('successful Manager dispatch binds once without generic operation tracking', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    const begin = controller.begin(root, sampleContract());
    expect(begin.success).toBe(true);
    if (!begin.success) return;
    const input = {
      tool: 'task',
      sessionID: root,
      callID: 'call_manager_once',
    };
    const output = {
      args: {
        subagent_type: 'outcome-manager',
        prompt: dispatchInstruction(controller, root),
      },
    };

    expect(hook.reserveManagerDispatch(input, output)).toEqual({
      rootSessionId: root,
      callId: 'call_manager_once',
    });
    await hook['tool.execute.before'](input, output);
    const launched = board.registerLaunch({
      taskID: 'manager_once',
      parentSessionID: root,
      agent: 'outcome-manager',
    });
    await hook['tool.execute.after'](input, {
      output: 'task_id: manager_once\nstate: running',
    });
    await hook['tool.execute.after'](input, {
      output: 'task_id: manager_once\nstate: running',
    });

    const record = controller.readRecord(root);
    expect(record.success && record.data.operations).toHaveLength(0);
    expect(controller.getStatus(root).checkpoint).toMatchObject({
      state: 'running',
    });
    const durable = controller.readRecord(root);
    expect(durable.success && durable.data.checkpoint).toMatchObject({
      state: 'running',
      managerTaskId: launched.taskID,
      managerGeneration: launched.generation,
    });
  });

  test('ordinary managed task and tool calls remain observed', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: root, callID: 'call_explorer_observed' },
      { args: { subagent_type: 'explorer', prompt: 'Map files' } },
    );
    await hook['tool.execute.before'](
      { tool: 'read', sessionID: root, callID: 'call_read_observed' },
      { args: { filePath: '/workspace/file.ts' } },
    );

    const record = controller.readRecord(root);
    expect(
      record.success &&
        record.data.operations.map(({ callId, status }) => ({
          callId,
          status,
        })),
    ).toEqual([
      { callId: 'call_explorer_observed', status: 'running' },
      { callId: 'call_read_observed', status: 'running' },
    ]);
  });

  test('does not fabricate user IDs and accepts the host output message ID', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['chat.message']({
      sessionID: root,
      parts: [{ type: 'text', text: 'No identity yet' }],
    });
    let record = controller.readRecord(root);
    expect(record.success && record.data.receipts.userMessages).toHaveLength(0);

    await hook['chat.message'](
      {
        sessionID: root,
        parts: [{ type: 'text', text: 'Host identity exists' }],
      },
      { message: { id: 'host_message_id' } },
    );
    record = controller.readRecord(root);
    expect(
      record.success && record.data.receipts.userMessages[0],
    ).toMatchObject({ messageId: 'host_message_id' });
  });

  test('idle wake uses canonical promptAsync shape and remains one-flight', async () => {
    const calls: unknown[] = [];
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook(
      {
        directory: '/workspace',
        client: {
          session: {
            promptAsync: async (request: unknown) => {
              calls.push(request);
              return {};
            },
          },
        },
      } as never,
      {
        controller,
        shouldManageSession: (id) => id === root,
        backgroundJobBoard: board,
      },
    );
    controller.begin(root, sampleContract());

    for (let index = 0; index < 2; index += 1) {
      await hook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: { id: root },
      query: { directory: '/workspace' },
      body: { agent: 'orchestrator', parts: [{ type: 'text' }] },
      throwOnError: true,
    });
    expect(
      (calls[0] as { body?: { prompt?: unknown } }).body?.prompt,
    ).toBeUndefined();
    expect(
      (calls[0] as { body: { parts: Array<{ text?: string }> } }).body.parts[0]
        .text,
    ).toStartWith(OUTCOME_CONTROLLER_WAKE_TEXT);
  });

  test('running child and valid user or external waits suppress idle wake', async () => {
    const calls: unknown[] = [];
    const roots = new Set(['ses_running', 'ses_external']);
    const hook = createOutcomeControllerHook(
      {
        directory: '/workspace',
        client: {
          session: {
            promptAsync: async (request: unknown) => {
              calls.push(request);
              return {};
            },
          },
        },
      } as never,
      {
        controller,
        shouldManageSession: (id) => roots.has(id),
        backgroundJobBoard: board,
      },
    );

    controller.begin('ses_running', sampleContract());
    board.registerLaunch({
      taskID: 'child_running',
      parentSessionID: 'ses_running',
      agent: 'explorer',
      description: 'Still running',
    });
    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_running' },
      },
    });

    const waitingExternalController = {
      readRecord: () => ({
        success: true as const,
        data: { phase: 'waiting_external', checkpoint: undefined },
      }),
      validateManagedWait: () => ({
        isManaged: true,
        allowed: true,
        phase: 'waiting_external',
      }),
    } as unknown as OutcomeController;
    const waitingExternalHook = createOutcomeControllerHook(
      {
        directory: '/workspace',
        client: {
          session: {
            promptAsync: async (request: unknown) => {
              calls.push(request);
              return {};
            },
          },
        },
      } as never,
      {
        controller: waitingExternalController,
        shouldManageSession: (id) => id === 'ses_external',
        backgroundJobBoard: board,
      },
    );
    await waitingExternalHook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_external' },
      },
    });

    const waitingUserController = {
      readRecord: () => ({
        success: true as const,
        data: { phase: 'waiting_user', checkpoint: undefined },
      }),
      validateManagedWait: () => ({
        isManaged: true,
        allowed: true,
        phase: 'waiting_user',
      }),
    } as unknown as OutcomeController;
    const waitingUserHook = createOutcomeControllerHook(
      {
        directory: '/workspace',
        client: {
          session: {
            promptAsync: async (request: unknown) => {
              calls.push(request);
              return {};
            },
          },
        },
      } as never,
      {
        controller: waitingUserController,
        shouldManageSession: (id) => id === 'ses_user_wait',
        backgroundJobBoard: board,
      },
    );
    await waitingUserHook.event({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_user_wait',
          status: { type: 'idle' },
        },
      },
    });

    expect(calls).toHaveLength(0);
  });

  test('terminal-unreconciled child present after task-session reconciliation permits action-required wake', async () => {
    const calls: unknown[] = [];
    const root = 'ses_terminal_unreconciled';
    const hook = createOutcomeControllerHook(
      {
        directory: '/workspace',
        client: {
          session: {
            promptAsync: async (request: unknown) => {
              calls.push(request);
              return {};
            },
          },
        },
      } as never,
      {
        controller,
        shouldManageSession: (id) => id === root,
        backgroundJobBoard: board,
      },
    );
    const begin = controller.begin(root, sampleContract());
    expect(begin.success).toBe(true);
    if (!begin.success) return;
    const marked = controller.validateAndMarkDispatching(
      root,
      'call_terminal_unreconciled',
      dispatchInstruction(controller, root),
    );
    expect(marked.success).toBe(true);
    controller.failManagerDispatch(
      root,
      'call_terminal_unreconciled',
      'Native Manager launch was rejected',
    );

    const launched = board.registerLaunch({
      taskID: 'child_terminal_unreconciled',
      parentSessionID: root,
      agent: 'explorer',
      description: 'Terminal result awaiting reconciliation',
    });
    board.markStopped(
      launched.taskID,
      'Runtime stopped without terminal task output',
      launched.updatedAt + 1,
      launched.generation,
      launched.updatedAt + 1,
    );
    expect(board.hasRunning(root)).toBe(false);
    expect(board.hasTerminalUnreconciled(root)).toBe(true);

    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: root },
      },
    });

    expect(calls).toHaveLength(1);
  });

  test('idle handling surfaces blocked and corrupt Controller reads', async () => {
    const root = 'ses_corrupt';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());
    fs.writeFileSync(controller.store.recordPath(root), '{broken');

    await expect(
      hook.event({
        event: {
          type: 'session.idle',
          properties: { sessionID: root },
        },
      }),
    ).rejects.toThrow('Failed to read managed outcome during idle handling');
  });

  test('managed Bash rejects recognizable direct OpenCode restarts before observation', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    for (const command of [
      `kill -TERM ${process.pid}`,
      'pkill opencode',
      'killall opencode',
      'systemctl --user restart opencode.service',
      'service opencode restart',
    ]) {
      await expect(
        hook['tool.execute.before'](
          { tool: 'bash', sessionID: root, callID: `call_${command}` },
          { args: { command } },
        ),
      ).rejects.toThrow("outcome_control(action='external_handoff'");
    }

    const record = controller.readRecord(root);
    expect(record.success && record.data.operations).toHaveLength(0);
  });

  test('Bash restart recognizer permits unrelated commands and has documented literal scope', async () => {
    expect(isRecognizableDirectOpenCodeRestart('kill -TERM 424242', 1234)).toBe(
      false,
    );
    expect(
      isRecognizableDirectOpenCodeRestart('systemctl restart postgresql', 1234),
    ).toBe(false);
    expect(
      isRecognizableDirectOpenCodeRestart('service nginx restart', 1234),
    ).toBe(false);
    expect(
      isRecognizableDirectOpenCodeRestart('./restart-opencode', 1234),
    ).toBe(false);
    expect(
      isRecognizableDirectOpenCodeRestart(
        'alias bounce="pkill opencode"',
        1234,
      ),
    ).toBe(false);
    expect(
      isRecognizableDirectOpenCodeRestart(
        'pkill opencode && echo restarted',
        1234,
      ),
    ).toBe(false);
    expect(
      isRecognizableDirectOpenCodeRestart('kill 1234; echo restarted', 1234),
    ).toBe(false);

    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());
    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', sessionID: root, callID: 'call_unrelated_service' },
        { args: { command: 'systemctl restart postgresql' } },
      ),
    ).resolves.toBeUndefined();
  });
});
