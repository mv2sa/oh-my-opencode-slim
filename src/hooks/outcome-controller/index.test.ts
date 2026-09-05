import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutcomeController } from '../../outcome/controller';
import {
  canonicalDigest,
  computeOutcomeContractDigest,
  computeOutcomeSuccessorLineageDigest,
  type OutcomeContract,
  OutcomeContractSchema,
} from '../../outcome/controller-schema';
import { BackgroundJobBoard } from '../../utils';
import {
  createInternalAgentTextPart,
  INTERNAL_INITIATOR_METADATA_KEY,
} from '../../utils/internal-initiator';
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

  test('before without after reconciles running operation to interrupted exactly once on idle', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: root, callID: 'call_stale_op' },
      { args: { command: 'echo running' } },
    );

    let record = controller.readRecord(root);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data.operations).toHaveLength(1);
    expect(record.data.operations[0].status).toBe('running');
    const revBeforeIdle = record.data.revision;

    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: root },
      },
    });

    record = controller.readRecord(root);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data.operations).toHaveLength(1);
    expect(record.data.operations[0].status).toBe('interrupted');
    expect(record.data.operations[0].error).toBe(
      'Session became idle without a durable tool after-hook',
    );
    expect(record.data.revision).toBe(revBeforeIdle + 1);
  });

  test('active running child suppresses idle operation reconciliation', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['tool.execute.before'](
      { tool: 'read', sessionID: root, callID: 'call_child_suppressed' },
      { args: { filePath: '/workspace/test.ts' } },
    );

    board.registerLaunch({
      taskID: 'child_running_op',
      parentSessionID: root,
      agent: 'explorer',
      description: 'Active child running',
    });

    let record = controller.readRecord(root);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data.operations[0].status).toBe('running');
    const revBefore = record.data.revision;

    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: root },
      },
    });

    record = controller.readRecord(root);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data.operations[0].status).toBe('running');
    expect(record.data.revision).toBe(revBefore);
  });

  test('repeated idle produces no record growth or byte mutation', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: root, callID: 'call_repeat_idle' },
      { args: { command: 'echo once' } },
    );

    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: root },
      },
    });

    const recordAfterFirst = controller.readRecord(root);
    expect(recordAfterFirst.success).toBe(true);
    if (!recordAfterFirst.success) return;
    const finalRevision = recordAfterFirst.data.revision;
    const filePath = controller.store.recordPath(root);
    const bytesAfterFirst = fs.readFileSync(filePath, 'utf-8');

    // Repeated session.idle and session.status: idle events
    for (let i = 0; i < 3; i += 1) {
      await hook.event({
        event: {
          type: 'session.idle',
          properties: { sessionID: root },
        },
      });
      await hook.event({
        event: {
          type: 'session.status',
          properties: { sessionID: root, status: { type: 'idle' } },
        },
      });
    }

    const recordAfterRepeats = controller.readRecord(root);
    expect(recordAfterRepeats.success).toBe(true);
    if (!recordAfterRepeats.success) return;
    expect(recordAfterRepeats.data.revision).toBe(finalRevision);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(bytesAfterFirst);
  });

  test('whole-message external provenance rejects mixed internal and accepts pure external', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    // 1. Mixed plain + synthetic part -> rejected (0 receipts)
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_mixed_1',
      parts: [
        { type: 'text', text: 'Plain user request' },
        { type: 'text', text: 'Synthetic notice', synthetic: true },
      ],
    });

    // 2. Synthetic part alone -> rejected (0 receipts)
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_synth',
      parts: [{ type: 'text', text: 'Only synthetic', synthetic: true }],
    });

    // 3. Part with internal initiator metadata -> rejected (0 receipts)
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_internal_meta',
      parts: [
        {
          type: 'text',
          text: 'Internal initiator part',
          metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
        },
      ],
    });

    // 4. Part with compaction_continue metadata -> rejected (0 receipts)
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_compaction',
      parts: [
        {
          type: 'text',
          text: 'Compaction continuation',
          metadata: { compaction_continue: true },
        },
      ],
    });

    // 5. Part with backgroundJobBoard metadata -> rejected (0 receipts)
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_board_meta',
      parts: [
        {
          type: 'text',
          text: 'Job board metadata',
          metadata: { 'oh-my-opencode-slim.backgroundJobBoard': true },
        },
      ],
    });

    // 6. Part with outcome controller metadata -> rejected (0 receipts)
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_outcome_meta',
      parts: [
        {
          type: 'text',
          text: 'Outcome controller metadata',
          metadata: { [OUTCOME_CONTROLLER_METADATA_KEY]: true },
        },
      ],
    });

    // 7. Clean input.parts but internal output.parts -> rejected (never trust cleaner input)
    await hook['chat.message'](
      {
        sessionID: root,
        messageID: 'msg_clean_in_dirty_out',
        parts: [{ type: 'text', text: 'Clean input text' }],
      },
      {
        message: { id: 'msg_clean_in_dirty_out' },
        parts: [
          { type: 'text', text: 'Clean input text' },
          { type: 'text', text: 'Internal tail', synthetic: true },
        ],
      },
    );

    let rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(0);

    // 8. Marker text alone WITHOUT metadata -> accepted as ordinary external text
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_marker_text_only',
      parts: [
        {
          type: 'text',
          text: 'User discussion about <!-- SLIM_INTERNAL_INITIATOR --> marker',
        },
      ],
    });

    rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(1);
    expect(rec.data.receipts.userMessages[0].messageId).toBe(
      'msg_marker_text_only',
    );
    expect(rec.data.receipts.userMessages[0].provenance).toBe('external_user');
  });

  test('authoritative output parts are preferred when provided and nonempty', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['chat.message'](
      {
        sessionID: root,
        messageID: 'msg_auth_parts',
        parts: [{ type: 'text', text: 'ignored input text' }],
      },
      {
        message: { id: 'msg_auth_parts' },
        parts: [{ type: 'text', text: 'authoritative output text' }],
      },
    );

    const rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(1);
    expect(rec.data.receipts.userMessages[0].contentDigest).toBe(
      canonicalDigest('omos/user-message/v1', 'authoritative output text'),
    );
  });

  test('authoritative empty output parts never fall back to dirty input parts', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    await hook['chat.message'](
      {
        sessionID: root,
        messageID: 'msg_empty_authoritative',
        parts: [{ type: 'text', text: 'Dirty input must not be trusted' }],
      },
      { message: { id: 'msg_empty_authoritative' }, parts: [] },
    );

    const rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(0);
  });

  test('initial external turn before outcome begin remains an unmanaged no-op', async () => {
    const root = 'ses_not_begun';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });

    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_before_begin',
        parts: [{ type: 'text', text: 'Start a non-trivial outcome' }],
      }),
    ).resolves.toBeUndefined();
    expect(controller.getStatus(root).isManaged).toBe(false);
  });

  test('host message ID is required and duplicate host events are idempotent', async () => {
    const root = 'ses_managed';
    const hook = createOutcomeControllerHook({} as never, {
      controller,
      shouldManageSession: (id) => id === root,
      backgroundJobBoard: board,
    });
    controller.begin(root, sampleContract());

    // Message with no messageID anywhere -> mints nothing
    await hook['chat.message']({
      sessionID: root,
      parts: [{ type: 'text', text: 'Anonymous message without ID' }],
    });
    let rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(0);

    // Message with host ID -> mints receipt
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_idempotent_1',
      parts: [{ type: 'text', text: 'Legitimate turn' }],
    });
    rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(1);
    const revAfterFirst = rec.data.revision;

    // Duplicate event with same messageID and content -> idempotent no-op
    await hook['chat.message']({
      sessionID: root,
      messageID: 'msg_idempotent_1',
      parts: [{ type: 'text', text: 'Legitimate turn' }],
    });
    rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(1);
    expect(rec.data.revision).toBe(revAfterFirst);

    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_idempotent_1',
        parts: [{ type: 'text', text: 'Conflicting reused identity' }],
      }),
    ).rejects.toThrow('already recorded with different content');
    rec = controller.readRecord(root);
    expect(rec.success).toBe(true);
    if (!rec.success) return;
    expect(rec.data.receipts.userMessages).toHaveLength(1);
    expect(rec.data.revision).toBe(revAfterFirst);
  });

  test('post-accept chat turns stage into pending intake and ordinary tool calls proceed without error', async () => {
    const root = 'ses_post_accept_hook';
    const c = sampleContract();
    c.goals[0].status = 'satisfied';
    let currentGeneration = 1;
    let reviewResultText = '';

    const testCtrl = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: (taskId) => ({
        taskID: taskId,
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: currentGeneration,
        state: 'completed',
      }),
      readChildSessionResult: async () => ({
        text: reviewResultText,
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => true,
    });

    const promptAsync = mock(async () => ({}));
    const hook = createOutcomeControllerHook(
      { client: { session: { promptAsync } } },
      {
        controller: testCtrl,
        shouldManageSession: (id) => id === root,
      },
    );

    // Begin
    const beginRes = testCtrl.begin(root, c);
    expect(beginRes.success).toBe(true);
    if (!beginRes.success || !beginRes.data.checkpoint) return;
    const kickoffChkId = beginRes.data.checkpoint.checkpointId;

    await hook['chat.message']({
      sessionID: root,
      messageID: c.sourceMessageIds[0],
      parts: [{ type: 'text', text: 'Initial governed request' }],
    });

    // Kickoff CONTINUE
    reviewResultText = `<outcome_review>${JSON.stringify({
      summary: 'Kickoff OK',
      verdict: 'CONTINUE',
      goals: c.goals.map(({ id, description, status }) => ({
        id,
        description,
        status,
      })),
      scope: { inScope: c.inScope, outOfScope: c.outOfScope },
      rules: [],
      evidence: [],
      constraintCoherence: {
        ordering: ['rules before deliverables'],
        coherent: true,
      },
      exceptions: [],
      handoff: {
        ready: false,
        summary: 'Not yet ready',
        verificationSteps: [],
      },
      lifecycle: { stage: 'execution', receiptAgreement: true },
    })}</outcome_review>`;
    testCtrl.validateAndMarkDispatching(
      root,
      'call_k',
      dispatchInstruction(testCtrl, root),
    );
    testCtrl.bindManagerTask(root, 'call_k', 'mgr_k', 1);
    const rKickoff = await testCtrl.reconcileReview(root, {
      checkpointId: kickoffChkId,
      managerTaskId: 'mgr_k',
      managerGeneration: 1,
    });
    expect(rKickoff.success).toBe(true);

    // Evidence + final checkpoint + ACCEPT
    const cand = `sha256:${'a'.repeat(64)}`;
    const ev = testCtrl.submitEvidence(root, {
      description: 'bun test',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: cand,
    });
    expect(ev.success).toBe(true);
    if (!ev.success) return;
    const evId = ev.data.attestationId;

    const finalChk = testCtrl.checkpoint(root, {
      kind: 'final',
      reason: 'final',
      candidateFingerprint: cand,
      evidenceAttestationIds: [evId],
    });
    expect(finalChk.success).toBe(true);
    if (!finalChk.success) return;
    const finalChkId = finalChk.data.checkpointId;

    currentGeneration = 2;
    reviewResultText = `<outcome_review>${JSON.stringify({
      summary: 'Accept OK',
      verdict: 'ACCEPT',
      candidateFingerprint: cand,
      goals: c.goals.map(({ id, description, status }) => ({
        id,
        description,
        status,
      })),
      scope: { inScope: c.inScope, outOfScope: c.outOfScope },
      rules: [],
      evidence: [
        {
          id: evId,
          command: 'bun test',
          status: 'passed',
          fingerprint: cand,
          freshness: 'fresh',
          isFinalCandidate: true,
        },
      ],
      constraintCoherence: {
        ordering: ['rules before deliverables'],
        coherent: true,
      },
      exceptions: [],
      handoff: { ready: true, summary: 'done', verificationSteps: ['verify'] },
      lifecycle: { stage: 'completed', receiptAgreement: true },
    })}</outcome_review>`;
    testCtrl.validateAndMarkDispatching(
      root,
      'call_f',
      dispatchInstruction(testCtrl, root),
    );
    testCtrl.bindManagerTask(root, 'call_f', 'mgr_f', 2);
    await testCtrl.reconcileReview(root, {
      checkpointId: finalChkId,
      managerTaskId: 'mgr_f',
      managerGeneration: 2,
    });
    testCtrl.finalize(root, { summary: 'Completed' });

    // Outcome is now ACCEPTED!
    const recBefore = testCtrl.readRecord(root);
    expect(recBefore.data?.phase).toBe('accepted');

    // 1. Replayed historical host event remains a no-op and creates no intake.
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: c.sourceMessageIds[0],
        parts: [{ type: 'text', text: 'Initial governed request' }],
      }),
    ).resolves.toBeUndefined();
    expect(testCtrl.getStatus(root).pendingSuccessor).toBeUndefined();

    // 2. A new post-accept external chat turn stages into intake.
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_followup_chat',
        parts: [{ type: 'text', text: 'Can you do phase 2 now?' }],
      }),
    ).resolves.toBeUndefined();

    const pendingRes = testCtrl.readPendingIntake(root);
    expect(pendingRes.success).toBe(true);
    expect(pendingRes.data?.boundaryMessageId).toBe('msg_followup_chat');

    // 3. Attachment-only external message does not get dropped
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_attach_only',
        parts: [{ type: 'image', url: 'data:image/png;base64,BBBB' }],
      }),
    ).resolves.toBeUndefined();

    const pendingRes2 = testCtrl.readPendingIntake(root);
    expect(pendingRes2.data?.userMessages).toHaveLength(2);

    // 4. Ordinary tool calls post-accept succeed without error
    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', sessionID: root, callID: 'call_post_bash' },
        { args: { command: 'ls' } },
      ),
    ).resolves.toBeUndefined();

    await expect(
      hook['tool.execute.after'](
        { tool: 'bash', sessionID: root, callID: 'call_post_bash' },
        { output: 'file.txt' },
      ),
    ).resolves.toBeUndefined();

    // 5. Pending intake alone does not idle-wake
    await hook.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: root },
      },
    });
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('stale generation-N tool completion cannot mutate generation N+1, and read failures skip persistence cleanly', async () => {
    const root = 'ses_stale_callback_test';
    const c = sampleContract();
    const ctrl = new OutcomeController({ storeDirectory: tempDir });
    const hook = createOutcomeControllerHook(
      {},
      {
        controller: ctrl,
        shouldManageSession: (id) => id === root,
      },
    );

    expect(ctrl.begin(root, c).success).toBe(true);
    const gen1Rec = ctrl.readRecord(root);
    expect(gen1Rec.success).toBe(true);
    if (!gen1Rec.success) return;
    const gen1OutcomeId = gen1Rec.data.outcomeId;

    // Start a tool in generation 1
    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: root, callID: 'call_g1_stale' },
      { args: { command: 'long_running_task' } },
    );
    expect(
      ctrl
        .readRecord(root)
        .data?.operations.some((o) => o.callId === 'call_g1_stale'),
    ).toBe(true);

    // Now simulate generation 2 becoming active
    // Complete gen 1 accepted and promote to gen 2
    // Or simulate gen 2 promotion directly:
    const gen2Contract = sampleContract();
    gen2Contract.sourceMessageIds = ['msg_gen2_bound'];
    expect(
      ctrl.observeExternalUserTurn(root, 'msg_gen2_bound', 'Start gen 2')
        .success,
    ).toBe(true);

    // If readRecord fails in after-hook, skips persistence cleanly
    const failingCtrl = {
      readRecord: () => ({
        success: false,
        error: new Error('Read failed'),
        code: 'io_error',
      }),
      isManaged: () => true,
    } as unknown as OutcomeController;
    const failingHook = createOutcomeControllerHook(
      {},
      {
        controller: failingCtrl,
        shouldManageSession: (id) => id === root,
      },
    );
    await expect(
      failingHook['tool.execute.after'](
        { tool: 'bash', sessionID: root, callID: 'call_g1_stale' },
        { output: 'done' },
      ),
    ).resolves.toBeUndefined();

    // Now complete the tool call when the active record has a different generation / outcomeId:
    // Create a new active outcome in store
    const store = ctrl.store;
    const manifestRes = store.readManifest(root);
    expect(manifestRes.success).toBe(true);
    if (!manifestRes.success) return;
    const manifest = manifestRes.data;
    manifest.currentGeneration = 2;

    // Write generation 2 record with different outcomeId and valid lineage
    const fakeCertDigest = `sha256:${'a'.repeat(64)}`;
    const lineage = {
      predecessorOutcomeId: gen1OutcomeId,
      predecessorGeneration: 1,
      predecessorAcceptedRevision: 1,
      predecessorCertificateDigest: fakeCertDigest,
      boundaryMessageId: 'msg_gen2_bound',
      lineageDigest: computeOutcomeSuccessorLineageDigest({
        predecessorOutcomeId: gen1OutcomeId,
        predecessorGeneration: 1,
        predecessorAcceptedRevision: 1,
        predecessorCertificateDigest: fakeCertDigest,
        boundaryMessageId: 'msg_gen2_bound',
      }),
    };
    const activeRec = ctrl.readRecord(root);
    expect(activeRec.success).toBe(true);
    if (!activeRec.success) return;
    const replacementContract = {
      ...activeRec.data.contract,
      sourceMessageIds: ['msg_gen2_bound'],
    };
    const gen2ContractDigest =
      computeOutcomeContractDigest(replacementContract);
    const gen2Record = {
      ...activeRec.data,
      generation: 2,
      lineage,
      outcomeId: 'out_different_generation_2',
      contract: replacementContract,
      contractDigest: gen2ContractDigest,
      checkpoint: undefined,
      kickoffGate: {
        policyVersion: 1 as const,
        state: 'required' as const,
        contractDigest: gen2ContractDigest,
        attempts: 0,
        maxAttempts: 2 as const,
      },
      receipts: {
        ...activeRec.data.receipts,
        userMessages: [
          {
            id: 'usr_gen2_b',
            messageId: 'msg_gen2_bound',
            contentDigest: canonicalDigest(
              'omos/user-message/v1',
              'boundary text',
            ),
            observedEpoch: ctrl.serverEpoch,
            observedAt: 100,
            createdRevision: 1,
            provenance: 'external_user' as const,
          },
        ],
      },
      operations: [],
    };
    fs.writeFileSync(store.recordPath(root, 2), JSON.stringify(gen2Record));
    fs.writeFileSync(store.manifestPath(root), JSON.stringify(manifest));

    // Stale generation 1 tool callback completes
    await hook['tool.execute.after'](
      { tool: 'bash', sessionID: root, callID: 'call_g1_stale' },
      { output: 'stale output' },
    );

    // Verify generation 2 record operations array was NOT mutated!
    const gen2After = ctrl.readRecord(root);
    expect(gen2After.success).toBe(true);
    expect(gen2After.data?.generation).toBe(2);
    expect(gen2After.data?.operations).toHaveLength(0);
  });

  test('normalizes attachment-only parts into bounded deterministic projection; rejects unsupported/circular/oversized forms', async () => {
    const root = 'ses_attachment_norm_test';
    const c = sampleContract();
    const ctrl = new OutcomeController({ storeDirectory: tempDir });
    const hook = createOutcomeControllerHook(
      {},
      {
        controller: ctrl,
        shouldManageSession: (id) => id === root,
      },
    );
    expect(ctrl.begin(root, c).success).toBe(true);

    // 1. Valid attachment delivery with volatile fields
    const partWithVolatile1 = {
      type: 'image',
      url: 'data:image/png;base64,1234',
      mime: 'image/png',
      id: 'volatile_client_id_1',
      clientTimestamp: 1000000,
      metadata: { volatile: true },
    };
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_att_idemp',
        parts: [partWithVolatile1],
      }),
    ).resolves.toBeUndefined();

    const rec1Res = ctrl.readRecord(root);
    expect(rec1Res.success).toBe(true);
    if (!rec1Res.success) return;
    const rec1 = rec1Res.data;
    const receipt1 = rec1.receipts.userMessages.find(
      (m) => m.messageId === 'msg_att_idemp',
    );
    expect(receipt1).toBeDefined();

    // 2. Duplicate delivery with differing volatile host fields yields exact same digest and is idempotent no-op
    const partWithVolatile2 = {
      type: 'image',
      url: 'data:image/png;base64,1234',
      mime: 'image/png',
      id: 'different_volatile_id_2',
      clientTimestamp: 9999999,
      metadata: { otherVolatile: true },
    };
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_att_idemp',
        parts: [partWithVolatile2],
      }),
    ).resolves.toBeUndefined();

    const rec2Res = ctrl.readRecord(root);
    expect(rec2Res.success).toBe(true);
    if (!rec2Res.success) return;
    expect(rec2Res.data.revision).toBe(rec1.revision); // Noop!

    // 3. Unsupported attachment part type fails clearly
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_unsupported_part',
        parts: [{ type: 'custom_media_widget', url: 'http://foo' }],
      }),
    ).rejects.toThrow('Unsupported attachment part type');

    // 4. Circular reference in parts fails clearly
    const circularObj: Record<string, unknown> = {
      type: 'file',
      path: '/foo/bar.ts',
    };
    circularObj.self = circularObj;
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_circular_part',
        parts: [circularObj],
      }),
    ).rejects.toThrow();

    // 5. Oversized URL fails clearly
    await expect(
      hook['chat.message']({
        sessionID: root,
        messageID: 'msg_oversized_url',
        parts: [{ type: 'image', url: 'x'.repeat(40 * 1024) }],
      }),
    ).rejects.toThrow('exceeds 32 KiB');
  });
});
