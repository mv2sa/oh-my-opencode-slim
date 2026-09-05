import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutcomeController } from '../outcome/controller';
import {
  canonicalDigest,
  computeOutcomeContractDigest,
  type OutcomeContract,
  OutcomeContractSchema,
  type OutcomeReview,
} from '../outcome/controller-schema';
import { createOutcomeControlTool } from './outcome-control';

const hash = (value: string) => canonicalDigest('test/v1', value);

function sampleContract(): OutcomeContract {
  return OutcomeContractSchema.parse({
    classification: 'non_trivial',
    objective: 'Test outcome control tool',
    deliverables: ['deliverable-1'],
    goals: [
      {
        id: 'goal-1',
        description: 'Test goal',
        status: 'in_progress',
      },
    ],
    inScope: ['src/tools'],
    outOfScope: ['other packages'],
    constraints: ['No unreviewed volatile inputs'],
    safetyBoundaries: ['Do not forge attestations'],
    handoffRequirements: ['Verification steps provided'],
    sourceMessageIds: ['msg_1'],
    rules: [],
    exceptions: [],
  });
}

function validKickoffReview(
  contract: OutcomeContract,
  verdict: OutcomeReview['verdict'] = 'CONTINUE',
  summary?: string,
): OutcomeReview {
  return {
    summary:
      summary ??
      (verdict === 'CONTINUE'
        ? 'Kickoff approved to continue execution'
        : 'Kickoff attempts exhausted: contract drift detected'),
    verdict,
    goals: contract.goals.map(({ id, description, status }) => ({
      id,
      description,
      status,
    })),
    scope: {
      inScope: contract.inScope,
      outOfScope: contract.outOfScope,
    },
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
    lifecycle: {
      stage: 'execution',
      receiptAgreement: true,
    },
  };
}

describe('outcome_control tool', () => {
  let tempDir: string;
  let controller: OutcomeController;
  let managedMap: Set<string>;
  let toolInstance: ReturnType<
    typeof createOutcomeControlTool
  >['outcome_control'];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tool-test-'));
    controller = new OutcomeController({ storeDirectory: tempDir });
    managedMap = new Set<string>(['ses_root']);
    toolInstance = createOutcomeControlTool({
      controller,
      shouldManageSession: (id) => managedMap.has(id),
      resolveAgentName: (agent) =>
        agent === 'engineer' ? 'orchestrator' : agent,
    }).outcome_control;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('enforces explicit orchestrator authority and rejects absent agent, specialists, and unmanaged sessions', async () => {
    // Absent caller agent
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
      } as never),
    ).rejects.toThrow('requires an explicit caller agent');

    // Empty caller agent
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
        agent: '   ',
      } as never),
    ).rejects.toThrow('requires an explicit caller agent');

    // Non-orchestrator agent (fixer)
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
        agent: 'fixer',
      } as never),
    ).rejects.toThrow('outcome_control can only be used by orchestrator');

    // Outcome Manager
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
        agent: 'outcome-manager',
      } as never),
    ).rejects.toThrow('outcome_control can only be used by orchestrator');

    // Unmanaged session
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_unmanaged',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('not managed');

    // Missing sessionID
    await expect(
      toolInstance.execute({ action: 'status' }, {
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('requires sessionID');

    // Managed orchestrator allowed
    const statusOutput = await toolInstance.execute({ action: 'status' }, {
      sessionID: 'ses_root',
      agent: 'orchestrator',
    } as never);
    expect(String(statusOutput)).toContain('"isManaged": false');
  });

  test('begin action requires explicit non_trivial classification and complete contract', async () => {
    const invalidContract = {
      classification: 'trivial',
      objective: 'Trivial task',
    };

    await expect(
      toolInstance.execute(
        { action: 'begin', contract: invalidContract as never },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('non_trivial');

    const validContract = sampleContract();
    const beginOutput = await toolInstance.execute(
      { action: 'begin', contract: validContract },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    const parsed = JSON.parse(String(beginOutput));
    expect(parsed.outcomeId).toBeDefined();
    expect(parsed.checkpoint.kind).toBe('kickoff');
    expect(parsed.dispatchNudgePending).toBe(true);
    expect(String(beginOutput)).not.toContain('OMOS_DISPATCH_MARKER');
    expect(String(beginOutput)).not.toContain('claimToken');
  });

  test('checkpoint and submit_evidence actions work as expected after authenticating kickoff', async () => {
    const mockTime = 1000;
    const contract = sampleContract();
    const boardRecord = {
      taskID: 'mgr_task_kickoff',
      parentSessionID: 'ses_root',
      agent: 'outcome-manager',
      generation: 1,
      state: 'completed' as const,
    };
    const reviewPayload = validKickoffReview(contract, 'CONTINUE');
    const childResult = {
      text: `<outcome_review>\n${JSON.stringify(reviewPayload, null, 2)}\n</outcome_review>`,
      empty: false,
      terminal: true,
    };

    const timeController = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => mockTime,
      getManagerTaskRecord: (id) =>
        id === 'mgr_task_kickoff' ? boardRecord : undefined,
      readChildSessionResult: async (id) =>
        id === 'mgr_task_kickoff' ? childResult : undefined,
      consumeManagerTask: () => true,
    });
    const timedTool = createOutcomeControlTool({
      controller: timeController,
      shouldManageSession: (id) => managedMap.has(id),
    }).outcome_control;

    // Begin first
    await timedTool.execute({ action: 'begin', contract }, {
      sessionID: 'ses_root',
      agent: 'orchestrator',
    } as never);
    const kickoffCheckpointId =
      timeController.getStatus('ses_root').checkpoint?.checkpointId;

    // Authenticate kickoff review before opening non-kickoff checkpoints
    timeController.validateAndMarkDispatching(
      'ses_root',
      'call_kickoff',
      timeController.getPendingNudge('ses_root')?.instruction ?? '',
    );
    timeController.bindManagerTask(
      'ses_root',
      'call_kickoff',
      'mgr_task_kickoff',
      1,
    );

    const recOutput = await timedTool.execute(
      {
        action: 'reconcile_review',
        checkpointId: kickoffCheckpointId,
        managerTaskId: 'mgr_task_kickoff',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const recParsed = JSON.parse(String(recOutput));
    expect(recParsed.verdict).toBe('CONTINUE');
    expect(recParsed.phase).toBe('active');

    const candidateFingerprint = hash('git_sha_123');
    const chkOutput = await timedTool.execute(
      {
        action: 'checkpoint',
        kind: 'decision',
        reason: 'Architecture decision needed',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const chkParsed = JSON.parse(String(chkOutput));
    expect(chkParsed.kind).toBe('decision');
    expect(chkParsed.dispatchNudgePending).toBe(true);
    expect(String(chkOutput)).not.toContain('OMOS_DISPATCH_MARKER');

    // Submit evidence
    const evOutput = await timedTool.execute(
      {
        action: 'submit_evidence',
        description: 'bun test src/tools',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint,
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const evParsed = JSON.parse(String(evOutput));
    expect(evParsed.assurance).toBe('orchestrator_attestation');
    expect(evParsed.attestationId).toBeDefined();
  });

  test('non-kickoff checkpoint fails when kickoff has not been authenticated', async () => {
    let mockTime = 1000;
    const timeController = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => mockTime,
    });
    const timedTool = createOutcomeControlTool({
      controller: timeController,
      shouldManageSession: (id) => managedMap.has(id),
    }).outcome_control;

    const contract = sampleContract();
    await timedTool.execute({ action: 'begin', contract }, {
      sessionID: 'ses_root',
      agent: 'orchestrator',
    } as never);

    mockTime += 700_000;
    const kickoffId =
      timeController.getStatus('ses_root').checkpoint?.checkpointId;
    await timedTool.execute(
      {
        action: 'expire_checkpoint',
        checkpointId: kickoffId,
        reason: 'Expired kickoff without authentication',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    await expect(
      timedTool.execute(
        {
          action: 'checkpoint',
          kind: 'decision',
          reason: 'Premature decision checkpoint',
        },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow(
      'Kickoff review must be authenticated before opening non-kickoff checkpoint',
    );
  });

  test('surfaces stable tool errors when kickoff attempts are exhausted', async () => {
    let mockTime = 1000;
    const contract = sampleContract();
    const childResult = {
      text: `<outcome_review>\n${JSON.stringify(validKickoffReview(contract, 'CORRECT_DRIFT'), null, 2)}\n</outcome_review>`,
      empty: false,
      terminal: true,
    };

    const timeController = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => mockTime,
      getManagerTaskRecord: (id) => ({
        taskID: id,
        parentSessionID: 'ses_root',
        agent: 'outcome-manager',
        generation: 1,
        state: 'completed' as const,
      }),
      readChildSessionResult: async () => childResult,
      consumeManagerTask: () => true,
    });
    const timedTool = createOutcomeControlTool({
      controller: timeController,
      shouldManageSession: (id) => managedMap.has(id),
    }).outcome_control;

    // Begin (attempt 1)
    await timedTool.execute({ action: 'begin', contract }, {
      sessionID: 'ses_root',
      agent: 'orchestrator',
    } as never);
    const chk1 = timeController.getStatus('ses_root').checkpoint?.checkpointId;

    // Attempt 1 fails with CORRECT_DRIFT
    timeController.validateAndMarkDispatching(
      'ses_root',
      'call_k1',
      timeController.getPendingNudge('ses_root')?.instruction ?? '',
    );
    timeController.bindManagerTask('ses_root', 'call_k1', 'mgr_kickoff_1', 1);
    await timedTool.execute(
      {
        action: 'reconcile_review',
        checkpointId: chk1,
        managerTaskId: 'mgr_kickoff_1',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    // Resolve the required action before opening retry kickoff
    const statusAfterFail1 = timeController.getStatus('ses_root');
    const actionToResolve = statusAfterFail1.actionsRequired[0];
    mockTime += 10;
    timeController.observeUserTurn(
      'ses_root',
      'msg_retry_user',
      'Please retry kickoff review',
    );
    const userReceipt = timeController
      .readRecord('ses_root')
      .data.receipts.userMessages.at(-1);

    await timedTool.execute(
      {
        action: 'resolve_action',
        actionId: actionToResolve.id,
        reason: 'User provided retry direction',
        sourceUserMessageReceiptId: userReceipt?.id,
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    // Attempt 2: retry kickoff checkpoint
    const retryChkRes = await timedTool.execute(
      {
        action: 'checkpoint',
        kind: 'kickoff',
        reason: 'Retry kickoff after correction',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const chk2 = JSON.parse(String(retryChkRes)).checkpointId;

    // Attempt 2 fails with CORRECT_DRIFT -> exhaustion!
    timeController.validateAndMarkDispatching(
      'ses_root',
      'call_k2',
      timeController.getPendingNudge('ses_root')?.instruction ?? '',
    );
    timeController.bindManagerTask('ses_root', 'call_k2', 'mgr_kickoff_2', 1);
    await timedTool.execute(
      {
        action: 'reconcile_review',
        checkpointId: chk2,
        managerTaskId: 'mgr_kickoff_2',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    expect(timeController.getStatus('ses_root').kickoffGate?.state).toBe(
      'exhausted',
    );

    // Attempting checkpoint on exhausted outcome throws stable error
    await expect(
      timedTool.execute(
        {
          action: 'checkpoint',
          kind: 'decision',
          reason: 'Cannot open after exhaustion',
        },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('Kickoff attempts exhausted');
  });

  test('surfaces stable tool errors when retrospective kickoff is blocked on legacy records', async () => {
    // Write a legacy record fixture with review activity but no kickoff -> normalizes to legacy_late_missing
    const c = sampleContract();
    const cDigest = computeOutcomeContractDigest(c);
    const v1Fixture = {
      schema: 'omos_outcome_record',
      schemaVersion: 1,
      outcomeId: 'out_legacy_blocked',
      rootSessionId: 'ses_root',
      serverEpoch: 'epoch_legacy',
      revision: 10,
      nextClaimGeneration: 2,
      contractDigest: cDigest,
      createdAt: 1000,
      updatedAt: 2000,
      phase: 'active',
      contract: c,
      receipts: {
        evidence: [],
        userMessages: [],
        decisions: [],
        authorizations: [],
      },
      reviewSummaries: [
        {
          reviewId: 'rev_progress_1',
          checkpointId: 'chk_progress_1',
          claimGeneration: 1,
          checkpointKind: 'decision',
          contractDigest: cDigest,
          outcomeRevision: 2,
          verdict: 'CONTINUE',
          managerTaskId: 'mgr_task_1',
          managerGeneration: 1,
          resultDigest: hash('res_1'),
          reviewDigest: hash('rev_1'),
          summary: 'Decision review without prior kickoff',
          evaluatedAt: 1500,
        },
      ],
      operations: [],
      actionsRequired: [],
    };
    fs.writeFileSync(
      controller.store.recordPath('ses_root'),
      JSON.stringify(v1Fixture, null, 2),
    );

    await expect(
      toolInstance.execute(
        {
          action: 'checkpoint',
          kind: 'kickoff',
          reason: 'Attempt retrospective kickoff',
        },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow(
      'Historical record has review activity without an authenticated kickoff review',
    );
  });

  test('external_handoff action sets waiting_external', async () => {
    await toolInstance.execute(
      { action: 'begin', contract: sampleContract() },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    const handoffOutput = await toolInstance.execute(
      {
        action: 'external_handoff',
        handoffKind: 'restart_current_opencode',
        instructions: 'Restart opencode CLI',
        expectedPostRestartCheck: 'Confirm version 2.2.18',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const handoffParsed = JSON.parse(String(handoffOutput));
    expect(handoffParsed.phase).toBe('waiting_external');
    expect(handoffParsed.instructions).toBe('Restart opencode CLI');
  });

  test('register_repository_waiver exposes only bounded repository authority', async () => {
    await toolInstance.execute(
      { action: 'begin', contract: sampleContract() },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const output = await toolInstance.execute(
      {
        action: 'register_repository_waiver',
        repositoryReference: 'governance/waivers/test.json',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const parsed = JSON.parse(String(output));
    expect(parsed.kind).toBe('repository_waiver');
    expect(parsed.authorizationId).toMatch(/^auth_/);
    expect(parsed.payloadDigest).toMatch(/^sha256:/);
    await expect(
      toolInstance.execute(
        { action: 'register_repository_waiver', repositoryReference: '   ' },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('Repository waiver reference must contain');
  });

  describe('reconcile_uncertain tool action', () => {
    test('strictly validates resolution variant and successfully awaits retire_misbound_result', async () => {
      const root = 'ses_root';
      const oldEpoch = 'epoch_tool_old';
      const newEpoch = 'epoch_tool_new';

      const oldController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_tool_task',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'running',
        }),
      });
      const beginRes = oldController.begin(root, sampleContract());
      expect(beginRes.success).toBe(true);
      const checkpointId = beginRes.data.checkpoint.checkpointId;

      const nudge = oldController.getPendingNudge(root);
      if (nudge?.kind !== 'dispatch') throw new Error('dispatch nudge missing');

      oldController.validateAndMarkDispatching(
        root,
        'call_tool_dispatch',
        nudge.instruction,
      );
      oldController.bindManagerTask(
        root,
        'call_tool_dispatch',
        'mgr_tool_task',
        1,
      );

      const visibleText = `<outcome_review>\n${JSON.stringify(validKickoffReview(sampleContract(), 'CONTINUE'), null, 2)}\n</outcome_review>`;
      const reasoningText = `<thinking>\nreasoning trace\n</thinking>\n${visibleText}`;
      const boundDigest = canonicalDigest(
        'omos/manager-result/v1',
        reasoningText,
      );

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: visibleText,
          empty: false,
          terminal: true,
        }),
      });
      newCtrl.readRecord(root); // recovers to review_uncertain

      // Mark result_available
      await newCtrl.reconcileUncertain(root, {
        checkpointId,
        resolution: {
          kind: 'result_available',
          dispatchCallId: 'call_tool_dispatch',
          managerTaskId: 'mgr_tool_task',
          managerGeneration: 1,
          resultDigest: boundDigest,
        },
      });

      const tool = createOutcomeControlTool({
        controller: newCtrl,
        shouldManageSession: (id) => id === root,
      }).outcome_control;

      // 1. Strict validation: missing boundResultDigest
      await expect(
        tool.execute(
          {
            action: 'reconcile_uncertain',
            checkpointId,
            resolution: {
              kind: 'retire_misbound_result',
              reason: 'Missing digest',
              dispatchCallId: 'call_tool_dispatch',
              managerTaskId: 'mgr_tool_task',
              managerGeneration: 1,
            } as never,
          },
          { sessionID: root, agent: 'orchestrator' } as never,
        ),
      ).rejects.toThrow();

      // 2. Strict validation: invalid digest format (not sha256:64-hex)
      await expect(
        tool.execute(
          {
            action: 'reconcile_uncertain',
            checkpointId,
            resolution: {
              kind: 'retire_misbound_result',
              reason: 'Invalid digest format',
              dispatchCallId: 'call_tool_dispatch',
              managerTaskId: 'mgr_tool_task',
              managerGeneration: 1,
              boundResultDigest: 'not_a_sha256',
            } as never,
          },
          { sessionID: root, agent: 'orchestrator' } as never,
        ),
      ).rejects.toThrow();

      // 3. Strict validation: negative generation
      await expect(
        tool.execute(
          {
            action: 'reconcile_uncertain',
            checkpointId,
            resolution: {
              kind: 'retire_misbound_result',
              reason: 'Negative gen',
              dispatchCallId: 'call_tool_dispatch',
              managerTaskId: 'mgr_tool_task',
              managerGeneration: -1,
              boundResultDigest: boundDigest,
            } as never,
          },
          { sessionID: root, agent: 'orchestrator' } as never,
        ),
      ).rejects.toThrow();

      // 4. Strict validation: empty reason
      await expect(
        tool.execute(
          {
            action: 'reconcile_uncertain',
            checkpointId,
            resolution: {
              kind: 'retire_misbound_result',
              reason: '   ',
              dispatchCallId: 'call_tool_dispatch',
              managerTaskId: 'mgr_tool_task',
              managerGeneration: 1,
              boundResultDigest: boundDigest,
            } as never,
          },
          { sessionID: root, agent: 'orchestrator' } as never,
        ),
      ).rejects.toThrow();

      // 5. Strict validation: oversized reason (> 512 characters)
      await expect(
        tool.execute(
          {
            action: 'reconcile_uncertain',
            checkpointId,
            resolution: {
              kind: 'retire_misbound_result',
              reason: 'a'.repeat(513),
              dispatchCallId: 'call_tool_dispatch',
              managerTaskId: 'mgr_tool_task',
              managerGeneration: 1,
              boundResultDigest: boundDigest,
            } as never,
          },
          { sessionID: root, agent: 'orchestrator' } as never,
        ),
      ).rejects.toThrow();

      // 6. Successful retirement via outcome_control tool
      const output = await tool.execute(
        {
          action: 'reconcile_uncertain',
          checkpointId,
          resolution: {
            kind: 'retire_misbound_result',
            reason: 'Tool retirement of misbound reasoning digest',
            dispatchCallId: 'call_tool_dispatch',
            managerTaskId: 'mgr_tool_task',
            managerGeneration: 1,
            boundResultDigest: boundDigest,
          },
        },
        { sessionID: root, agent: 'orchestrator' } as never,
      );
      const parsed = JSON.parse(String(output));
      expect(parsed.checkpoint?.state).toBe('retired');
      expect(parsed.checkpoint?.recoveryNote).toContain(boundDigest);
    });

    test('preserves existing retire and result_available resolution variants', async () => {
      const root = 'ses_root';
      const oldEpoch = 'epoch_tool_variants_old';
      const newEpoch = 'epoch_tool_variants_new';

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_v',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'running',
        }),
      });
      const beginRes = oldCtrl.begin(root, sampleContract());
      expect(beginRes.success).toBe(true);
      const checkpointId = beginRes.data.checkpoint.checkpointId;
      const nudge = oldCtrl.getPendingNudge(root);
      if (nudge?.kind !== 'dispatch') throw new Error('nudge missing');
      oldCtrl.validateAndMarkDispatching(root, 'call_v', nudge.instruction);
      oldCtrl.bindManagerTask(root, 'call_v', 'mgr_v', 1);

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });
      newCtrl.readRecord(root); // review_uncertain

      const tool = createOutcomeControlTool({
        controller: newCtrl,
        shouldManageSession: (id) => id === root,
      }).outcome_control;

      // Existing variant 1: plain retire on review_uncertain
      const retireOutput = await tool.execute(
        {
          action: 'reconcile_uncertain',
          checkpointId,
          resolution: {
            kind: 'retire',
            reason: 'Plain retire of uncertain dispatch',
          },
        },
        { sessionID: root, agent: 'orchestrator' } as never,
      );
      const retireParsed = JSON.parse(String(retireOutput));
      expect(retireParsed.checkpoint?.state).toBe('retired');
      expect(retireParsed.checkpoint?.recoveryNote).toBe(
        'Plain retire of uncertain dispatch',
      );
    });
  });

  describe('supersede_external_handoff tool action', () => {
    test('strictly validates inputs and awaits controller.supersedeExternalHandoff', async () => {
      const root = 'ses_root';
      const oldEpoch = 'epoch_tool_sup_old';
      const newEpoch = 'epoch_tool_sup_new';

      const kReview = validKickoffReview(sampleContract(), 'CONTINUE');
      const kText = `<outcome_review>\n${JSON.stringify(kReview, null, 2)}\n</outcome_review>`;

      const oldCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
        getManagerTaskRecord: (id) => ({
          taskID: id,
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: kText,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });
      const beginRes = oldCtrl.begin(root, sampleContract());
      expect(beginRes.success).toBe(true);
      const kCpId = beginRes.data.checkpoint.checkpointId;

      // Authenticate kickoff
      const kNudge = oldCtrl.getPendingNudge(root);
      if (kNudge?.kind !== 'dispatch') throw new Error('nudge missing');
      expect(
        oldCtrl.validateAndMarkDispatching(root, 'call_k', kNudge.instruction)
          .success,
      ).toBe(true);
      expect(oldCtrl.bindManagerTask(root, 'call_k', 'mgr_k', 1).success).toBe(
        true,
      );

      const kRec = await oldCtrl.reconcileReview(root, {
        checkpointId: kCpId,
        managerTaskId: 'mgr_k',
        managerGeneration: 1,
      });
      expect(kRec.success).toBe(true);

      // Open final checkpoint
      const finalCp = oldCtrl.checkpoint(root, {
        kind: 'final',
        reason: 'Final review',
        candidateFingerprint: hash('candidate_f'),
      });
      expect(finalCp.success).toBe(true);
      const finalCpId = finalCp.data.checkpointId;
      const fNudge = oldCtrl.getPendingNudge(root);
      if (fNudge?.kind !== 'dispatch') throw new Error('nudge missing');
      expect(
        oldCtrl.validateAndMarkDispatching(root, 'call_f', fNudge.instruction)
          .success,
      ).toBe(true);
      expect(oldCtrl.bindManagerTask(root, 'call_f', 'mgr_f', 1).success).toBe(
        true,
      );

      // Set external handoff wait
      const postRestartCheck = `Confirm ${finalCpId} completed`;
      expect(
        oldCtrl.externalHandoff(root, {
          kind: 'restart_current_opencode',
          reason: 'Restarting CLI',
          expectedPostRestartCheck: postRestartCheck,
        }).success,
      ).toBe(true);

      // Restart to newEpoch
      const visibleText = `<outcome_review>\n${JSON.stringify(validKickoffReview(sampleContract(), 'CONTINUE'), null, 2)}\n</outcome_review>`;
      const childReaderOutput = `<thinking>\ntrace\n</thinking>\n\n${visibleText}`;
      const boundDigest = canonicalDigest(
        'omos/manager-result/v1',
        visibleText,
      );

      const newCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: childReaderOutput,
          empty: false,
          terminal: true,
        }),
      });
      const recRestart = newCtrl.readRecord(root);
      expect(recRestart.success).toBe(true);
      const wait = recRestart.data.waitCondition;
      if (
        !wait?.originatingServerEpoch ||
        wait.restartObservedRevision === undefined
      ) {
        throw new Error('wait incomplete');
      }

      // Reconcile and retire misbound final checkpoint
      await newCtrl.reconcileUncertain(root, {
        checkpointId: finalCpId,
        resolution: {
          kind: 'result_available',
          dispatchCallId: 'call_f',
          managerTaskId: 'mgr_f',
          managerGeneration: 1,
          resultDigest: boundDigest,
        },
      });
      await newCtrl.reconcileUncertain(root, {
        checkpointId: finalCpId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Retiring misbound',
          dispatchCallId: 'call_f',
          managerTaskId: 'mgr_f',
          managerGeneration: 1,
          boundResultDigest: boundDigest,
        },
      });

      // User turn
      const userRes = newCtrl.observeExternalUserTurn(
        root,
        'msg_u_post',
        'Continue work',
      );
      expect(userRes.success).toBe(true);

      // Evidence
      const repCandidate = hash('replacement_candidate');
      const evRes = newCtrl.submitEvidence(root, {
        description: postRestartCheck,
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: repCandidate,
      });
      expect(evRes.success).toBe(true);

      const tool = createOutcomeControlTool({
        controller: newCtrl,
        shouldManageSession: (id) => id === root,
      }).outcome_control;

      const baseParams = {
        action: 'supersede_external_handoff' as const,
        reason: 'Superseding via tool',
        waitReferenceId: wait.referenceId,
        waitCreatedRevision: wait.createdRevision,
        waitOriginatingServerEpoch: wait.originatingServerEpoch,
        waitRestartObservedRevision: wait.restartObservedRevision,
        instructions: wait.instructions,
        expectedPostRestartCheck: postRestartCheck,
        retiredCheckpointId: finalCpId,
        retiredClaimGeneration: finalCp.data.claimGeneration,
        sourceUserMessageReceiptId: userRes.data.receiptId,
        evidenceAttestationId: evRes.data.attestationId,
        replacementCandidateFingerprint: repCandidate,
      };

      // Missing reason throws
      await expect(
        tool.execute({ ...baseParams, reason: undefined as never }, {
          sessionID: root,
          agent: 'orchestrator',
        } as never),
      ).rejects.toThrow();

      // Missing waitReferenceId throws
      await expect(
        tool.execute({ ...baseParams, waitReferenceId: undefined as never }, {
          sessionID: root,
          agent: 'orchestrator',
        } as never),
      ).rejects.toThrow();

      // Successful tool execution
      const toolOutput = await tool.execute(baseParams, {
        sessionID: root,
        agent: 'orchestrator',
      } as never);
      const parsed = JSON.parse(String(toolOutput));
      expect(parsed.phase).toBe('active');
    });
  });
});
