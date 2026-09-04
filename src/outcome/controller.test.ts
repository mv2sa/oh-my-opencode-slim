import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildOutcomeReviewExactPayload,
  buildOutcomeReviewPacket,
  formatOutcomeDispatchMarker,
  type ManagerTaskVerification,
  OutcomeController,
} from './controller';
import {
  canonicalDigest,
  computeOutcomeCheckpointFingerprint,
  computeOutcomeContractDigest,
  computeOutcomeHandoffSupersessionDigest,
  type OutcomeContract,
  OutcomeContractSchema,
} from './controller-schema';
import type { OutcomeReview } from './schema';
import { OutcomeStore, OutcomeStoreError } from './store';

const hash = (value: string) => canonicalDigest('test/v1', value);

function testContract(
  overrides: Partial<OutcomeContract> = {},
): OutcomeContract {
  return OutcomeContractSchema.parse({
    classification: 'non_trivial',
    objective: 'Implement the Outcome Controller vertical slice',
    deliverables: ['Outcome Controller', 'outcome_control tool'],
    goals: [
      {
        id: 'goal_slice',
        description: 'Complete all requirements of the vertical slice',
        status: 'in_progress',
      },
    ],
    inScope: ['src/outcome', 'src/tools', 'src/hooks'],
    outOfScope: ['Full autonomous agent rewrite'],
    constraints: ['No unreviewed volatile inputs in stable prompt prefix'],
    safetyBoundaries: ['Never claim attestations are machine-verified'],
    handoffRequirements: ['Verification passes all test suites'],
    sourceMessageIds: ['msg_initial_req'],
    rules: [],
    exceptions: [],
    ...overrides,
  });
}

function validReviewFor(
  controller: OutcomeController,
  rootSessionId: string,
  verdict: OutcomeReview['verdict'],
  options: {
    candidateFingerprint?: string;
    overrideSummary?: string;
  } = {},
): OutcomeReview {
  const recRes = controller.readRecord(rootSessionId);
  if (!recRes.success) throw new Error('record missing');
  const record = recRes.data;
  const checkpoint = record.checkpoint;
  if (!checkpoint) throw new Error('checkpoint missing');

  const evidence = checkpoint.includedEvidenceAttestationIds.map((id) => {
    const entry = record.receipts.evidence.find((item) => item.id === id);
    if (entry?.kind !== 'orchestrator_attestation') {
      throw new Error(`attestation ${id} missing`);
    }
    return {
      id: entry.id,
      command: entry.description,
      status: entry.assertedStatus,
      fingerprint: entry.candidateFingerprint,
      freshness: entry.assertedFreshness,
      isFinalCandidate: checkpoint.kind === 'final',
    };
  });

  const accepted = verdict === 'ACCEPT';
  return {
    summary:
      options.overrideSummary ??
      (accepted ? 'Outcome is verified and accepted' : 'Review in progress'),
    verdict,
    ...(checkpoint.candidateFingerprint || options.candidateFingerprint
      ? {
          candidateFingerprint:
            options.candidateFingerprint ?? checkpoint.candidateFingerprint,
        }
      : {}),
    goals: record.contract.goals.map(({ id, description, status: s }) => ({
      id,
      description,
      status: accepted ? 'satisfied' : s,
    })),
    scope: {
      inScope: record.contract.inScope,
      outOfScope: record.contract.outOfScope,
    },
    rules: record.contract.rules.map((rule) => ({
      id: rule.id,
      sourcePath: rule.sourcePath,
      category: rule.category,
      summary: rule.summary,
      ruleType: rule.ruleType,
      enforcementStatus: rule.enforcementStatus,
      evidenceIds: rule.evidenceAttestationIds,
    })),
    evidence,
    constraintCoherence: {
      ordering: ['rules before deliverables'],
      coherent: true,
    },
    exceptions: record.contract.exceptions.map((exception) => {
      const authorization = record.receipts.authorizations.find(
        (item) => item.id === exception.authorizationId,
      );
      if (!authorization) throw new Error('authorization missing');
      return {
        ruleId: exception.ruleId,
        justification: exception.justification,
        justified: true,
        scope: exception.scope,
        authorizationKind: authorization.kind,
        authorizationReference: authorization.reference,
      };
    }),
    handoff: {
      ready: accepted,
      summary: accepted ? 'Handoff verification steps ready' : 'Not yet ready',
      verificationSteps: accepted
        ? ['bun test src/outcome', 'bun run typecheck']
        : [],
    },
    lifecycle: {
      stage: accepted ? 'completed' : 'execution',
      receiptAgreement: true,
    },
    ...(verdict === 'USER_DECISION_REQUIRED'
      ? {
          userDecision: {
            decisionNeeded: 'User decision needed on architecture choice',
            options: ['Option A', 'Option B'],
            blocking: true,
          },
        }
      : {}),
  };
}

function dispatchInstruction(
  controller: OutcomeController,
  rootSessionId: string,
): string {
  const nudge = controller.getPendingNudge(rootSessionId);
  if (nudge?.kind !== 'dispatch') throw new Error('dispatch nudge missing');
  return nudge.instruction;
}

describe('OutcomeController service over frozen store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-controller-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('begin creates durable record and opens kickoff checkpoint with live token nudge', () => {
    const controller = new OutcomeController({ storeDirectory: tempDir });
    const root = 'ses_begin_test';
    const contract = testContract();

    const beginRes = controller.begin(root, contract);
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    expect(beginRes.data.revision).toBe(2);
    expect(beginRes.data.checkpoint.kind).toBe('kickoff');
    expect(beginRes.data.dispatchNudgePending).toBe(true);
    expect(JSON.stringify(beginRes.data)).not.toContain('OMOS_DISPATCH_MARKER');

    const nudge = controller.getPendingNudge(root);
    expect(nudge).toBeDefined();
    expect(nudge?.kind).toBe('dispatch');
    if (nudge?.kind === 'dispatch') {
      expect(nudge.marker.claimToken.length).toBeGreaterThan(16);
      expect(nudge.instruction).toContain(nudge.marker.claimToken);
    }
  });

  test('repeated begin uses normalized contract authority and is idempotent after goal progress', () => {
    let now = 100;
    const controller = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => now,
    });
    const root = 'ses_begin_repeat';
    const initial = testContract();
    const begun = controller.begin(root, initial);
    expect(begun.success).toBe(true);
    if (!begun.success) return;
    const exactRepeat = controller.begin(root, initial);
    expect(exactRepeat.success).toBe(true);
    if (!exactRepeat.success) return;
    expect(exactRepeat.data.checkpoint.claimGeneration).toBe(1);

    now = 700_001;
    expect(
      controller.expireCheckpoint(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        reason: 'settle kickoff',
      }).success,
    ).toBe(true);
    expect(
      controller.updateGoalStatus(root, {
        goalId: 'goal_slice',
        status: 'satisfied',
      }).success,
    ).toBe(true);
    const progressedRepeat = controller.begin(root, {
      ...initial,
      goals: initial.goals.map((goal) => ({ ...goal, status: 'satisfied' })),
    });
    expect(progressedRepeat.success).toBe(true);
    if (!progressedRepeat.success) return;
    expect(progressedRepeat.data.idempotent).toBe(true);
    expect(progressedRepeat.data.dispatchNudgePending).toBe(false);
    expect(progressedRepeat.data.checkpoint.claimGeneration).toBe(1);
    expect(
      controller.begin(root, {
        ...initial,
        objective: 'A different authority',
      }),
    ).toMatchObject({ success: false, code: 'contract_mismatch' });
  });

  test('corrupt managed state is blocked while a genuinely missing record stays unmanaged', () => {
    const controller = new OutcomeController({ storeDirectory: tempDir });
    const corruptRoot = 'ses_corrupt_probe';
    controller.begin(corruptRoot, testContract());
    fs.writeFileSync(controller.store.recordPath(corruptRoot), '{broken');

    expect(controller.getStatus(corruptRoot)).toMatchObject({
      isManaged: true,
      phase: 'corrupted',
      blocked: { code: 'corrupt' },
    });
    expect(() => controller.isManaged(corruptRoot)).toThrow(
      'Managed outcome state is unavailable',
    );
    expect(controller.validateManagedWait(corruptRoot)).toMatchObject({
      isManaged: true,
      allowed: false,
      phase: 'corrupted',
    });
    expect(
      controller.observeToolBefore(corruptRoot, 'call_corrupt', 'bash', {
        command: 'true',
      }).success,
    ).toBe(false);
    expect(controller.begin(corruptRoot, testContract()).success).toBe(false);
    expect(
      controller.checkpoint(corruptRoot, {
        kind: 'decision',
        reason: 'Must not overwrite corrupt state',
      }).success,
    ).toBe(false);
    expect(
      controller.finalize(corruptRoot, { summary: 'Must not finalize' })
        .success,
    ).toBe(false);

    const missingRoot = 'ses_genuinely_missing';
    expect(controller.getStatus(missingRoot)).toMatchObject({
      isManaged: false,
    });
    expect(controller.isManaged(missingRoot)).toBe(false);
    expect(controller.validateManagedWait(missingRoot)).toEqual({
      isManaged: false,
      allowed: true,
    });
  });

  test('one-flight checkpointing rejects duplicate checkpoints while active claim exists', () => {
    const controller = new OutcomeController({ storeDirectory: tempDir });
    const root = 'ses_one_flight_test';
    controller.begin(root, testContract());

    const dupRes = controller.checkpoint(root, {
      kind: 'decision',
      reason: 'Second checkpoint attempt',
    });
    expect(dupRes.success).toBe(false);
    if (!dupRes.success) {
      expect(dupRes.code).toBe('checkpoint_in_flight');
    }
  });

  test('marker validation in validateAndMarkDispatching enforces exact single marker and correlation', () => {
    const controller = new OutcomeController({ storeDirectory: tempDir });
    const root = 'ses_dispatch_test';
    const beginRes = controller.begin(root, testContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;
    const liveInstruction = dispatchInstruction(controller, root);

    // Missing callID fails closed
    const noCallId = controller.validateAndMarkDispatching(
      root,
      '',
      liveInstruction,
    );
    expect(noCallId.success).toBe(false);

    // Missing marker
    const noMarker = controller.validateAndMarkDispatching(
      root,
      'call_1',
      'Please review my outcome',
    );
    expect(noMarker.success).toBe(false);

    // Wrong root session
    const wrongRootMarker = formatOutcomeDispatchMarker({
      rootSession: 'ses_other',
      outcomeId: beginRes.data.outcomeId,
      checkpointId: beginRes.data.checkpoint.checkpointId,
      claimGeneration: beginRes.data.checkpoint.claimGeneration,
      checkpointFingerprint: beginRes.data.checkpoint.fingerprint,
      claimToken: 'some_token',
    });
    const wrongRootRes = controller.validateAndMarkDispatching(
      root,
      'call_1',
      wrongRootMarker,
    );
    expect(wrongRootRes.success).toBe(false);

    // Valid marker
    const validRes = controller.validateAndMarkDispatching(
      root,
      'call_1',
      liveInstruction,
    );
    expect(validRes.success).toBe(true);

    const statusAfter = controller.getStatus(root);
    expect(statusAfter.phase).toBe('reviewing');
    expect(statusAfter.checkpoint?.state).toBe('dispatching');

    // Replay attempt fails
    const replayRes = controller.validateAndMarkDispatching(
      root,
      'call_2',
      liveInstruction,
    );
    expect(replayRes.success).toBe(false);
  });

  test('bindManagerTask binds manager task with board generation', () => {
    const root = 'ses_bind_test';
    const controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: (taskID) =>
        taskID === 'mgr_task_100'
          ? {
              taskID,
              parentSessionID: root,
              agent: 'outcome-manager',
              generation: 2,
              state: 'running',
            }
          : undefined,
    });
    const beginRes = controller.begin(root, testContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    controller.validateAndMarkDispatching(
      root,
      'call_bind_1',
      dispatchInstruction(controller, root),
    );

    const bindRes = controller.bindManagerTask(
      root,
      'call_bind_1',
      'mgr_task_100',
    );
    expect(bindRes.success).toBe(true);

    const status = controller.getStatus(root);
    expect(status.checkpoint?.state).toBe('running');
  });

  test('reconcileReview validates authoritative board record and child session result', async () => {
    const boardRecord: ManagerTaskVerification = {
      taskID: 'mgr_task_200',
      parentSessionID: 'ses_reconcile_test',
      agent: 'outcome-manager',
      generation: 1,
      state: 'completed',
    };

    let childResult = {
      text: '',
      empty: false,
      terminal: true,
    };

    const controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: (id) =>
        id === 'mgr_task_200' ? boardRecord : undefined,
      readChildSessionResult: async (id) =>
        id === 'mgr_task_200' ? childResult : undefined,
      consumeManagerTask: () => true,
    });
    const root = 'ses_reconcile_test';
    const beginRes = controller.begin(root, testContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    controller.validateAndMarkDispatching(
      root,
      'call_rec_1',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(root, 'call_rec_1', 'mgr_task_200', 1);

    // Reconcile rejection tests:
    // 1. Manager task mismatch
    const mismatchRes = await controller.reconcileReview(root, {
      checkpointId: beginRes.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_task_other',
    });
    expect(mismatchRes.success).toBe(false);
    expect(mismatchRes.code).toBe('manager_task_mismatch');

    // 2. Non-terminal child output
    childResult = { text: 'Some text', empty: false, terminal: false };
    const nonTerminalRes = await controller.reconcileReview(root, {
      checkpointId: beginRes.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_task_200',
    });
    expect(nonTerminalRes.success).toBe(false);
    expect(nonTerminalRes.code).toBe('result_not_terminal');

    // 3. Positive exact bound review
    const reviewObj = validReviewFor(controller, root, 'CONTINUE');
    childResult = {
      text: `<outcome_review>\n${JSON.stringify(reviewObj, null, 2)}\n</outcome_review>`,
      empty: false,
      terminal: true,
    };

    const reconcileRes = await controller.reconcileReview(root, {
      checkpointId: beginRes.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_task_200',
    });
    expect(reconcileRes.success).toBe(true);
    if (!reconcileRes.success) return;

    expect(reconcileRes.data.verdict).toBe('CONTINUE');
    expect(reconcileRes.data.phase).toBe('active');
  });

  test('does not record a review when Manager completion cannot be consumed', async () => {
    const root = 'ses_consume_test';
    const boardRecord: ManagerTaskVerification = {
      taskID: 'mgr_consume',
      parentSessionID: root,
      agent: 'outcome-manager',
      generation: 1,
      state: 'completed',
    };
    let controller: OutcomeController;
    controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: () => boardRecord,
      readChildSessionResult: async () => ({
        text: `<outcome_review>${JSON.stringify(
          validReviewFor(controller, root, 'CONTINUE'),
        )}</outcome_review>`,
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => false,
    });
    const begin = controller.begin(root, testContract());
    expect(begin.success).toBe(true);
    if (!begin.success) return;
    controller.validateAndMarkDispatching(
      root,
      'call_consume',
      dispatchInstruction(controller, root),
    );
    expect(
      controller.bindManagerTask(root, 'call_consume', 'mgr_consume').success,
    ).toBe(true);

    const reconciled = await controller.reconcileReview(root, {
      checkpointId: begin.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_consume',
    });
    expect(reconciled).toMatchObject({
      success: false,
      code: 'manager_consumption_failed',
    });
    const record = controller.readRecord(root);
    expect(record.success && record.data.reviewSummaries).toHaveLength(0);
    expect(record.success && record.data.checkpoint?.state).toBe('running');
  });

  test('malformed review records review_invalid and enters action_required', async () => {
    const boardRecord: ManagerTaskVerification = {
      taskID: 'mgr_task_invalid',
      parentSessionID: 'ses_invalid_test',
      agent: 'outcome-manager',
      generation: 1,
      state: 'completed',
    };

    const controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: () => boardRecord,
      readChildSessionResult: async () => ({
        text: 'Missing envelope',
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => true,
    });
    const root = 'ses_invalid_test';
    const beginRes = controller.begin(root, testContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    controller.validateAndMarkDispatching(
      root,
      'call_inv_1',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(root, 'call_inv_1', 'mgr_task_invalid', 1);

    const reconcileRes = await controller.reconcileReview(root, {
      checkpointId: beginRes.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_task_invalid',
    });
    expect(reconcileRes.success).toBe(false);
    if (!reconcileRes.success) {
      expect(reconcileRes.code).toBe('review_invalid');
    }

    const status = controller.getStatus(root);
    expect(status.phase).toBe('action_required');
    expect(status.checkpoint?.state).toBe('review_invalid');
    expect(status.actionsRequired.length).toBeGreaterThan(0);
  });

  test('malformed review is consumed before invalid state is persisted', async () => {
    const root = 'ses_invalid_consumption_order';
    let consumed = false;
    const controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: () => ({
        taskID: 'mgr_invalid_order',
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 1,
        state: 'completed',
      }),
      readChildSessionResult: async () => ({
        text: 'not an outcome envelope',
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => consumed,
    });
    const begun = controller.begin(root, testContract());
    expect(begun.success).toBe(true);
    if (!begun.success) return;
    controller.validateAndMarkDispatching(
      root,
      'call_invalid_order',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(root, 'call_invalid_order', 'mgr_invalid_order');
    const first = await controller.reconcileReview(root, {
      checkpointId: begun.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_invalid_order',
    });
    expect(first).toMatchObject({
      success: false,
      code: 'manager_consumption_failed',
    });
    expect(controller.getStatus(root).checkpoint?.state).toBe('running');

    consumed = true;
    const second = await controller.reconcileReview(root, {
      checkpointId: begun.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_invalid_order',
    });
    expect(second).toMatchObject({ success: false, code: 'review_invalid' });
    const record = controller.readRecord(root);
    expect(record.success).toBe(true);
    if (!record.success) return;
    expect(record.data.checkpoint?.state).toBe('review_invalid');
    expect(record.data.reviewSummaries).toHaveLength(0);
  });

  test('exact reconciliation retry returns the existing summary without duplication', async () => {
    const root = 'ses_review_idempotent';
    let controller: OutcomeController;
    controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: () => ({
        taskID: 'mgr_idempotent',
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 1,
        state: 'reconciled',
        terminalState: 'completed',
      }),
      readChildSessionResult: async () => ({
        text: `<outcome_review>${JSON.stringify(
          validReviewFor(controller, root, 'CONTINUE'),
        )}</outcome_review>`,
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => true,
    });
    const begun = controller.begin(root, testContract());
    expect(begun.success).toBe(true);
    if (!begun.success) return;
    controller.validateAndMarkDispatching(
      root,
      'call_idempotent',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(root, 'call_idempotent', 'mgr_idempotent');
    const params = {
      checkpointId: begun.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_idempotent',
    };
    const first = await controller.reconcileReview(root, params);
    const second = await controller.reconcileReview(root, params);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.data.summary).toEqual(first.data.summary);
    const record = controller.readRecord(root);
    expect(record.success && record.data.reviewSummaries).toHaveLength(1);
  });

  for (const persistenceError of ['conflict', 'io_error'] as const) {
    test(`post-consumption ${persistenceError} is retryable with the exact result and does not duplicate summaries`, async () => {
      const root = `ses_review_persist_retry_${persistenceError}`;
      let failOnce = true;
      let consumeCalls = 0;
      let changedResult = false;
      const store = new OutcomeStore({
        storeDirectory: tempDir,
        beforePersistReconciledReview: () => {
          if (failOnce) {
            failOnce = false;
            throw new OutcomeStoreError(
              persistenceError,
              `injected ${persistenceError}`,
            );
          }
        },
      });
      let controller: OutcomeController;
      controller = new OutcomeController({
        store,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_persist_retry',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'reconciled',
          terminalState: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify({
            ...validReviewFor(controller, root, 'CONTINUE'),
            ...(changedResult ? { summary: 'Changed after consumption' } : {}),
          })}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => {
          consumeCalls += 1;
          return true;
        },
      });
      const begun = controller.begin(root, testContract());
      expect(begun.success).toBe(true);
      if (!begun.success) return;
      controller.validateAndMarkDispatching(
        root,
        'call_persist_retry',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_persist_retry',
        'mgr_persist_retry',
      );
      const params = {
        checkpointId: begun.data.checkpoint.checkpointId,
        managerTaskId: 'mgr_persist_retry',
      };
      const first = await controller.reconcileReview(root, params);
      expect(first).toMatchObject({
        success: false,
        code: persistenceError,
      });
      let record = controller.readRecord(root);
      expect(record.success && record.data.reviewSummaries).toHaveLength(0);
      expect(record.success && record.data.checkpoint?.state).toBe('running');

      changedResult = true;
      const changed = await controller.reconcileReview(root, params);
      expect(changed).toMatchObject({
        success: false,
        code: 'consumed_result_mismatch',
      });
      changedResult = false;

      const retried = await controller.reconcileReview(root, params);
      expect(retried.success).toBe(true);
      record = controller.readRecord(root);
      expect(record.success && record.data.reviewSummaries).toHaveLength(1);
      expect(consumeCalls).toBe(2);

      const replay = await controller.reconcileReview(root, params);
      expect(replay.success).toBe(true);
      record = controller.readRecord(root);
      expect(record.success && record.data.reviewSummaries).toHaveLength(1);
    });
  }

  test('submitEvidence links completed durable tool observation', () => {
    const controller = new OutcomeController({ storeDirectory: tempDir });
    const root = 'ses_evidence_test';
    controller.begin(root, testContract());

    // Durable tool observation start and finish
    controller.observeToolBefore(root, 'call_tool_1', 'bash', {
      command: 'bun test',
    });
    controller.observeToolAfter(root, 'call_tool_1', 'bash', {
      exitCode: 0,
      output: 'pass',
    });

    const candidateFingerprint = hash('candidate_commit_sha');
    const submitRes = controller.submitEvidence(root, {
      description: 'bun test',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint,
      linkedObservationId: 'obs_call_tool_1',
    });

    expect(submitRes.success).toBe(true);
    if (!submitRes.success) return;

    expect(submitRes.data.assurance).toBe('orchestrator_attestation');
    expect(submitRes.data.attestationId).toBeDefined();

    const recordRes = controller.readRecord(root);
    expect(recordRes.success).toBe(true);
    if (!recordRes.success) return;

    const evidence = recordRes.data.receipts.evidence;
    const obs = evidence.find((e) => e.id === 'obs_call_tool_1');
    expect(obs).toBeDefined();
    if (obs?.kind === 'controller_observed') {
      expect(obs.completionObserved).toBe(true);
      expect(obs.outputDigest).toBeDefined();
    }
  });

  test('process restart turns durable running operation into interrupted', () => {
    const controller1 = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_1',
    });
    const root = 'ses_restart_op_test';
    controller1.begin(root, testContract());

    // Tool starts in epoch 1 but never completes
    controller1.observeToolBefore(root, 'call_hung_1', 'bash', {
      command: 'long running',
    });

    // Process restarts in epoch 2
    const controller2 = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_2',
    });

    const recovered = controller2.readRecord(root);
    expect(recovered.success).toBe(true);
    if (!recovered.success) return;

    expect(recovered.data.serverEpoch).toBe('epoch_2');
    expect(recovered.data.phase).toBe('action_required');

    const op = recovered.data.operations.find((o) => o.id === 'op_call_hung_1');
    expect(op?.status).toBe('interrupted');
    expect(
      recovered.data.actionsRequired.some(
        (a) => a.code === 'interrupted_operation',
      ),
    ).toBe(true);
    expect(controller2.getStatus(root).activeOperations).toEqual([
      expect.objectContaining({
        id: 'op_call_hung_1',
        status: 'interrupted',
      }),
    ]);
    expect(controller2.getPendingNudge(root)).toMatchObject({
      kind: 'recovery',
      message: expect.stringContaining('acknowledge_operation'),
    });
  });

  test('user decisions: USER_DECISION_REQUIRED review creates durable decision and resolve_user_decision resolves it', async () => {
    const boardRecord: ManagerTaskVerification = {
      taskID: 'mgr_task_decision',
      parentSessionID: 'ses_user_decision_test',
      agent: 'outcome-manager',
      generation: 1,
      state: 'completed',
    };

    const controller = new OutcomeController({
      storeDirectory: tempDir,
      getManagerTaskRecord: () => boardRecord,
      readChildSessionResult: async () => ({
        text: `<outcome_review>\n${JSON.stringify(
          validReviewFor(controller, root, 'USER_DECISION_REQUIRED'),
          null,
          2,
        )}\n</outcome_review>`,
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => true,
    });
    const root = 'ses_user_decision_test';
    const beginRes = controller.begin(root, testContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    controller.validateAndMarkDispatching(
      root,
      'call_dec_dispatch',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(
      root,
      'call_dec_dispatch',
      'mgr_task_decision',
      1,
    );

    // Reconcile USER_DECISION_REQUIRED review
    const recRes = await controller.reconcileReview(root, {
      checkpointId: beginRes.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_task_decision',
    });
    expect(recRes.success).toBe(true);

    const recordAfterReview = controller.readRecord(root);
    expect(recordAfterReview.success).toBe(true);
    if (!recordAfterReview.success) return;

    expect(recordAfterReview.data.phase).toBe('waiting_user');
    expect(recordAfterReview.data.receipts.decisions.length).toBe(1);
    const durableDecision = recordAfterReview.data.receipts.decisions[0];
    expect(durableDecision.options).toEqual(['Option A', 'Option B']);

    // Observe an external user turn
    controller.observeUserTurn(root, 'msg_user_choice_1', 'I select Option A');
    const userReceipt =
      controller.readRecord(root).data?.receipts.userMessages[0];
    expect(userReceipt).toBeDefined();
    if (!userReceipt) return;

    // Resolve decision with invalid option -> rejected
    const invalidOptRes = controller.resolveUserDecision(root, {
      decisionId: durableDecision.id,
      chosenOption: 'Option Invalid',
      sourceUserMessageReceiptId: userReceipt.id,
    });
    expect(invalidOptRes.success).toBe(false);
    expect(
      controller.resolveUserDecision(root, {
        decisionId: durableDecision.id,
        chosenOption: 'Option A',
        sourceUserMessageReceiptId: userReceipt.id,
        authorizationKind: 'repository_waiver' as never,
      }),
    ).toMatchObject({ success: false, code: 'invalid_authorization_kind' });

    // Resolve decision with valid option
    const validResolve = controller.resolveUserDecision(root, {
      decisionId: durableDecision.id,
      chosenOption: 'Option A',
      sourceUserMessageReceiptId: userReceipt.id,
      authorizationKind: 'user_decision',
    });
    expect(validResolve.success).toBe(true);

    const updated = controller.readRecord(root);
    expect(updated.success).toBe(true);
    if (!updated.success) return;
    expect(updated.data.receipts.decisions[0].chosenOption).toBe('Option A');
    expect(updated.data.receipts.authorizations.length).toBe(1);
  });

  test('external_handoff persists instructions and expected post-restart check', () => {
    const controller = new OutcomeController({ storeDirectory: tempDir });
    const root = 'ses_handoff_test';
    controller.begin(root, testContract());

    const handoffRes = controller.externalHandoff(root, {
      kind: 'restart_current_opencode',
      reason: 'Need plugin update reload',
      instructions: 'Restart opencode CLI now',
      expectedPostRestartCheck: 'Verify version is 2.2.18',
    });

    expect(handoffRes.success).toBe(true);
    if (!handoffRes.success) return;
    expect(handoffRes.data.phase).toBe('waiting_external');
    expect(handoffRes.data.instructions).toContain('Restart opencode CLI now');

    const status = controller.getStatus(root);
    expect(status.phase).toBe('waiting_external');
    expect(status.waitCondition?.instructions).toBe('Restart opencode CLI now');
    expect(status.waitCondition?.expectedPostRestartCheck).toBe(
      'Verify version is 2.2.18',
    );
  });

  test('external handoff completion requires a new epoch, later user, and matching fresh evidence', () => {
    const root = 'ses_handoff_completion';
    const epoch = 'epoch_handoff';
    const first = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: epoch,
    });
    first.begin(root, testContract());
    first.observeUserTurn(root, 'msg_before_handoff', 'Prepare to restart');
    const beforeHandoff = first.readRecord(root);
    expect(beforeHandoff.success).toBe(true);
    if (!beforeHandoff.success) return;
    const preHandoffReceipt = beforeHandoff.data.receipts.userMessages.at(-1);
    expect(preHandoffReceipt).toBeDefined();
    if (!preHandoffReceipt) return;
    const handoff = first.externalHandoff(root, {
      kind: 'restart_current_opencode',
      expectedPostRestartCheck: 'Verify reloaded plugin health',
    });
    expect(handoff.success).toBe(true);
    const beforeHandoffReceipt = first.readRecord(root);
    expect(beforeHandoffReceipt.success).toBe(true);
    if (!beforeHandoffReceipt.success) return;
    const handoffWaitRevision =
      beforeHandoffReceipt.data.waitCondition?.createdRevision;
    expect(handoffWaitRevision).toBeDefined();

    const sameEpoch = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: epoch,
    });
    expect(sameEpoch.getStatus(root).phase).toBe('waiting_external');
    sameEpoch.observeUserTurn(root, 'msg_same_epoch', 'Not a real restart');
    const sameEpochRecord = sameEpoch.readRecord(root);
    expect(sameEpochRecord.success).toBe(true);
    if (!sameEpochRecord.success) return;
    const sameEpochReceipt = sameEpochRecord.data.receipts.userMessages.at(-1);
    const sameEpochEvidence = sameEpoch.submitEvidence(root, {
      description: 'Verify reloaded plugin health',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: hash('handoff-candidate'),
    });
    expect(sameEpochEvidence.success).toBe(true);
    if (!sameEpochReceipt || !sameEpochEvidence.success) return;
    expect(
      sameEpoch.completeExternalHandoff(root, {
        sourceUserMessageReceiptId: sameEpochReceipt.id,
        evidenceAttestationId: sameEpochEvidence.data.attestationId,
      }),
    ).toMatchObject({ success: false, code: 'restart_not_observed' });

    const recreated = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_after_handoff',
    });
    const recoveredAfterRestart = recreated.readRecord(root);
    expect(recoveredAfterRestart.success).toBe(true);
    if (!recoveredAfterRestart.success) return;
    const staleClaimAction = recoveredAfterRestart.data.actionsRequired.find(
      (entry) => entry.code === 'stale_claim',
    );
    expect(staleClaimAction).toBeDefined();
    if (!staleClaimAction) return;
    recreated.observeUserTurn(
      root,
      'msg_resolve_restart_claim',
      'The prior kickoff claim may be retired',
    );
    const claimResolutionRecord = recreated.readRecord(root);
    expect(claimResolutionRecord.success).toBe(true);
    if (!claimResolutionRecord.success) return;
    const claimResolutionReceipt =
      claimResolutionRecord.data.receipts.userMessages.at(-1);
    expect(claimResolutionReceipt).toBeDefined();
    if (!claimResolutionReceipt) return;
    expect(
      recreated.resolveAction(root, {
        actionId: staleClaimAction.id,
        reason: 'Restart retired the old kickoff claim',
        sourceUserMessageReceiptId: claimResolutionReceipt.id,
      }).success,
    ).toBe(true);
    expect(recreated.getStatus(root).phase).toBe('waiting_external');
    expect(
      recreated.completeExternalHandoff(root, {
        sourceUserMessageReceiptId: sameEpochReceipt.id,
        evidenceAttestationId: sameEpochEvidence.data.attestationId,
      }).success,
    ).toBe(false);
    expect(
      recreated.completeExternalHandoff(root, {
        sourceUserMessageReceiptId: preHandoffReceipt.id,
        evidenceAttestationId: sameEpochEvidence.data.attestationId,
      }).success,
    ).toBe(false);
    recreated.observeUserTurn(root, 'msg_after_restart', 'Restart completed');
    const afterUser = recreated.readRecord(root);
    expect(afterUser.success).toBe(true);
    if (!afterUser.success) return;
    const userReceipt = afterUser.data.receipts.userMessages.at(-1);
    expect(userReceipt).toBeDefined();
    if (!userReceipt) return;

    const wrongEvidence = recreated.submitEvidence(root, {
      description: 'Wrong post-restart check',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: hash('handoff-candidate'),
    });
    expect(wrongEvidence.success).toBe(true);
    if (!wrongEvidence.success) return;
    expect(
      recreated.completeExternalHandoff(root, {
        sourceUserMessageReceiptId: userReceipt.id,
        evidenceAttestationId: wrongEvidence.data.attestationId,
      }).success,
    ).toBe(false);

    const evidence = recreated.submitEvidence(root, {
      description: 'Verify reloaded plugin health',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: hash('handoff-candidate'),
    });
    expect(evidence.success).toBe(true);
    if (!evidence.success) return;
    const completed = recreated.completeExternalHandoff(root, {
      sourceUserMessageReceiptId: userReceipt.id,
      evidenceAttestationId: evidence.data.attestationId,
    });
    expect(completed.success).toBe(true);
    expect(recreated.getStatus(root).waitCondition).toBeUndefined();
  });

  test('goal progress and contract authority use bounded provenance-aware transitions', () => {
    let now = 1_000;
    const controller = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => now,
    });
    const root = 'ses_progress_revision';
    const initial = testContract();
    const begun = controller.begin(root, initial);
    expect(begun.success).toBe(true);
    if (!begun.success) return;
    now += 700_000;
    expect(
      controller.expireCheckpoint(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        reason: 'Retire kickoff for transition test',
      }).success,
    ).toBe(true);

    const progressed = controller.updateGoalStatus(root, {
      goalId: 'goal_slice',
      status: 'satisfied',
    });
    expect(progressed.success).toBe(true);
    const afterProgress = controller.readRecord(root);
    expect(afterProgress.success).toBe(true);
    if (!afterProgress.success) return;
    expect(afterProgress.data.contract.goals[0].status).toBe('satisfied');

    const changedAuthority = testContract({
      objective: 'A materially changed objective',
      sourceMessageIds: ['msg_initial_req', 'msg_authority_change'],
    });
    expect(
      controller.reviseContract(root, { contract: changedAuthority }).success,
    ).toBe(false);

    controller.observeUserTurn(
      root,
      'msg_authority_change',
      'Change the objective as specified',
    );
    const withReceipt = controller.readRecord(root);
    expect(withReceipt.success).toBe(true);
    if (!withReceipt.success) return;
    const receipt = withReceipt.data.receipts.userMessages.at(-1);
    expect(receipt).toBeDefined();
    if (!receipt) return;
    expect(
      controller.reviseContract(root, {
        contract: changedAuthority,
        sourceUserMessageReceiptId: receipt.id,
      }).success,
    ).toBe(true);
  });

  test('registers Controller-owned repository waivers for revised contracts only by exact ID', () => {
    let now = 1_000;
    const controller = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => now,
    });
    const root = 'ses_repository_waiver';
    const begun = controller.begin(root, testContract());
    expect(begun.success).toBe(true);
    if (!begun.success) return;
    now += 700_000;
    expect(
      controller.expireCheckpoint(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        reason: 'settle kickoff',
      }).success,
    ).toBe(true);
    const registered = controller.registerRepositoryWaiver(root, {
      repositoryReference: 'governance/waivers/rule-one.json',
    });
    expect(registered.success).toBe(true);
    if (!registered.success) return;
    expect(registered.data.kind).toBe('repository_waiver');

    const waivedContract = testContract({
      rules: [
        {
          id: 'rule_one',
          sourcePath: 'AGENTS.md',
          category: 'governance',
          summary: 'Repository-governed exception',
          ruleType: 'semantic',
          enforcementStatus: 'waived',
          evidenceAttestationIds: [],
        },
      ],
      exceptions: [
        {
          ruleId: 'rule_one',
          justification: 'Approved repository waiver applies',
          scope: 'this outcome',
          authorizationId: registered.data.authorizationId,
        },
      ],
    });
    expect(
      controller.reviseContract(root, { contract: waivedContract }).success,
    ).toBe(true);

    const altered = structuredClone(waivedContract);
    altered.exceptions[0].authorizationId = `${registered.data.authorizationId}_x`;
    expect(controller.reviseContract(root, { contract: altered }).success).toBe(
      false,
    );
  });

  test('prior-epoch stale claim requires explicit provenance before a new checkpoint', async () => {
    const root = 'ses_stale_action_resolution';
    const old = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_old',
    });
    old.begin(root, testContract());
    let current: OutcomeController;
    current = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_new',
      getManagerTaskRecord: () => ({
        taskID: 'mgr_stale_retry',
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 1,
        state: 'completed',
      }),
      readChildSessionResult: async () => ({
        text: `<outcome_review>${JSON.stringify(
          validReviewFor(current, root, 'CONTINUE'),
        )}</outcome_review>`,
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => true,
    });
    const recovered = current.readRecord(root);
    expect(recovered.success).toBe(true);
    if (!recovered.success) return;
    const action = recovered.data.actionsRequired.find(
      (entry) => entry.code === 'stale_claim',
    );
    expect(action).toBeDefined();
    if (!action) return;
    expect(
      current.checkpoint(root, {
        kind: 'decision',
        reason: 'Blocked before recovery',
      }).success,
    ).toBe(false);
    expect(
      current.resolveAction(root, {
        actionId: action.id,
        reason: 'No provenance supplied',
      }).success,
    ).toBe(false);

    current.observeUserTurn(root, 'msg_recover_stale', 'Recover stale claim');
    const afterUser = current.readRecord(root);
    expect(afterUser.success).toBe(true);
    if (!afterUser.success) return;
    const receipt = afterUser.data.receipts.userMessages.at(-1);
    expect(receipt).toBeDefined();
    if (!receipt) return;
    expect(receipt.provenance).toBe('external_user');
    expect(
      current.resolveAction(root, {
        actionId: action.id,
        reason: 'User confirmed the abandoned prior-epoch claim',
        sourceUserMessageReceiptId: receipt.id,
      }).success,
    ).toBe(true);

    // Opening decision checkpoint still fails before kickoff is authenticated
    expect(
      current.checkpoint(root, {
        kind: 'decision',
        reason: 'Blocked before kickoff authentication',
      }).success,
    ).toBe(false);

    // Open kickoff retry checkpoint (attempt 2)
    const retryKickoff = current.checkpoint(root, {
      kind: 'kickoff',
      reason: 'Retry kickoff after recovering stale claim',
    });
    expect(retryKickoff.success).toBe(true);
    if (!retryKickoff.success) return;

    // Authenticate kickoff
    current.validateAndMarkDispatching(
      root,
      'call_stale_dispatch',
      dispatchInstruction(current, root),
    );
    current.bindManagerTask(root, 'call_stale_dispatch', 'mgr_stale_retry', 1);
    const reconcileRes = await current.reconcileReview(root, {
      checkpointId: retryKickoff.data.checkpointId,
      managerTaskId: 'mgr_stale_retry',
      managerGeneration: 1,
    });
    expect(reconcileRes.success).toBe(true);

    // Now decision checkpoint succeeds!
    expect(
      current.checkpoint(root, {
        kind: 'decision',
        reason: 'Recovery completed',
      }).success,
    ).toBe(true);
  });

  test('action resolution provenance must be minted later and evidence must be fresh passed attestation', () => {
    let now = 100;
    const root = 'ses_action_provenance';
    const old = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_action_old',
      clock: () => now,
    });
    old.begin(root, testContract());
    old.observeUserTurn(root, 'msg_before_action', 'Old receipt');
    const oldEvidence = old.submitEvidence(root, {
      description: 'pre-action evidence',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: hash('pre-action-evidence'),
    });
    expect(oldEvidence.success).toBe(true);
    if (!oldEvidence.success) return;
    const oldRecord = old.readRecord(root);
    expect(oldRecord.success).toBe(true);
    if (!oldRecord.success) return;
    const oldReceipt = oldRecord.data.receipts.userMessages.at(-1);
    expect(oldReceipt).toBeDefined();
    if (!oldReceipt) return;

    now = 200;
    const current = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_action_new',
      clock: () => now,
    });
    const recovered = current.readRecord(root);
    expect(recovered.success).toBe(true);
    if (!recovered.success) return;
    const action = recovered.data.actionsRequired.find(
      (entry) => entry.code === 'stale_claim',
    );
    expect(action).toBeDefined();
    if (!action) return;
    expect(action.createdRevision).toBe(recovered.data.revision);
    expect(
      current.resolveAction(root, {
        actionId: action.id,
        reason: 'old receipt',
        sourceUserMessageReceiptId: oldReceipt.id,
      }).success,
    ).toBe(false);
    expect(
      current.resolveAction(root, {
        actionId: action.id,
        reason: 'pre-action evidence',
        evidenceAttestationIds: [oldEvidence.data.attestationId],
      }).success,
    ).toBe(false);

    const tamperedFile = current.store.recordPath(root);
    const tamperedRecord = JSON.parse(fs.readFileSync(tamperedFile, 'utf8'));
    tamperedRecord.actionsRequired[0].resolvedAt = now;
    tamperedRecord.actionsRequired[0].resolutionKind =
      'orchestrator_provenance';
    tamperedRecord.actionsRequired[0].resolutionReason = 'forged old receipt';
    tamperedRecord.actionsRequired[0].resolutionUserMessageReceiptId =
      oldReceipt.id;
    const originalBytes = fs.readFileSync(tamperedFile, 'utf8');
    fs.writeFileSync(
      tamperedFile,
      `${JSON.stringify(tamperedRecord, null, 2)}\n`,
    );
    expect(current.store.read(root).code).toBe('corrupt');
    fs.writeFileSync(tamperedFile, originalBytes);

    for (const [status, freshness] of [
      ['failed', 'fresh'],
      ['pending', 'fresh'],
      ['passed', 'stale'],
      ['passed', 'unknown'],
    ] as const) {
      const submitted = current.submitEvidence(root, {
        description: `${status}-${freshness}`,
        assertedStatus: status,
        assertedFreshness: freshness,
        candidateFingerprint: hash(`${status}-${freshness}`),
      });
      expect(submitted.success).toBe(true);
      if (!submitted.success) continue;
      expect(
        current.resolveAction(root, {
          actionId: action.id,
          reason: 'invalid evidence',
          evidenceAttestationIds: [submitted.data.attestationId],
        }).success,
      ).toBe(false);
    }

    const passed = current.submitEvidence(root, {
      description: 'fresh passed recovery',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: hash('fresh-passed'),
    });
    expect(passed.success).toBe(true);
    if (!passed.success) return;
    expect(
      current.resolveAction(root, {
        actionId: action.id,
        reason: 'fresh evidence resolves action',
        evidenceAttestationIds: [passed.data.attestationId],
      }).success,
    ).toBe(true);
    const reloaded = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_action_new',
      clock: () => now,
    }).readRecord(root);
    expect(reloaded.success).toBe(true);
    if (!reloaded.success) return;
    expect(reloaded.data.actionsRequired[0]).toMatchObject({
      resolutionEvidenceAssurance: 'orchestrator_attestation',
      resolutionEvidenceAttestationIds: [passed.data.attestationId],
    });
  });

  test('finalize gates: parent-scoped running and terminal unreconciled checks', () => {
    const runningMap = new Set<string>();
    const unreconciledMap = new Set<string>();

    const controller = new OutcomeController({
      storeDirectory: tempDir,
      hasRunningChildren: (parent) => runningMap.has(parent),
      hasTerminalUnreconciledChildren: (parent) => unreconciledMap.has(parent),
    });
    const root = 'ses_finalize_gates_test';
    controller.begin(root, testContract());

    // Unrelated parent running does not block root
    runningMap.add('ses_other_parent');
    const finRes1 = controller.finalize(root, { summary: 'Done' });
    // Fails on kickoff review check, not running_tasks_present
    expect(finRes1.code).not.toBe('running_tasks_present');

    // Root parent running blocks
    runningMap.add(root);
    const finRes2 = controller.finalize(root, { summary: 'Done' });
    expect(finRes2.success).toBe(false);
    expect(finRes2.code).toBe('running_tasks_present');

    // Root parent unreconciled blocks
    runningMap.delete(root);
    unreconciledMap.add(root);
    const finRes3 = controller.finalize(root, { summary: 'Done' });
    expect(finRes3.success).toBe(false);
    expect(finRes3.code).toBe('unreconciled_tasks_present');
  });

  test('service-level compaction enables 100+ tool calls, respects schema caps, and preserves linked observations through final certification', async () => {
    let now = 1_000;
    const candidate = hash('candidate_service_compaction');
    let controller: OutcomeController;
    let reviewVerdict: 'CONTINUE' | 'ACCEPT' = 'CONTINUE';
    controller = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => now,
      getManagerTaskRecord: () => ({
        taskID: 'mgr_task_compact',
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 1,
        state: 'completed',
      }),
      readChildSessionResult: async () => ({
        text: `<outcome_review>${JSON.stringify(
          validReviewFor(controller, root, reviewVerdict, {
            candidateFingerprint: candidate,
          }),
        )}</outcome_review>`,
        empty: false,
        terminal: true,
      }),
      consumeManagerTask: () => true,
    });
    const root = 'ses_service_compaction_100';
    const beginRes = controller.begin(root, testContract());
    expect(beginRes.success).toBe(true);
    if (!beginRes.success) return;

    // Complete kickoff review with CONTINUE
    controller.validateAndMarkDispatching(
      root,
      'call_kickoff_dispatch',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(
      root,
      'call_kickoff_dispatch',
      'mgr_task_compact',
      1,
    );
    const kickoffReconcile = await controller.reconcileReview(root, {
      checkpointId: beginRes.data.checkpoint.checkpointId,
      managerTaskId: 'mgr_task_compact',
      managerGeneration: 1,
    });
    expect(kickoffReconcile.success).toBe(true);

    // Run 120 managed tool calls through observeToolBefore / observeToolAfter
    for (let i = 1; i <= 120; i++) {
      now += 10;
      const callId = `call_srv_${i}`;
      const beforeRes = controller.observeToolBefore(root, callId, 'bash', {
        cmd: `echo ${i}`,
      });
      expect(beforeRes.success).toBe(true);

      now += 5;
      const afterRes = controller.observeToolAfter(root, callId, 'bash', {
        stdout: `result ${i}`,
      });
      expect(afterRes.success).toBe(true);

      // At call 3, submit evidence linking obs_call_srv_3
      if (i === 3) {
        now += 2;
        const evRes = controller.submitEvidence(root, {
          description: 'Linked test observation from service call 3',
          assertedStatus: 'passed',
          assertedFreshness: 'fresh',
          candidateFingerprint: candidate,
          linkedObservationId: 'obs_call_srv_3',
        });
        expect(evRes.success).toBe(true);
      }
    }

    const status = controller.getStatus(root);
    expect(status.isManaged).toBe(true);

    const recRes = controller.readRecord(root);
    expect(recRes.success).toBe(true);
    if (!recRes.success) return;

    // Verify bounded sizes
    expect(recRes.data.operations.length).toBeLessThanOrEqual(16);
    expect(recRes.data.receipts.evidence.length).toBeLessThanOrEqual(32);

    // Linked observation from call 3 must survive
    const linkedObs = recRes.data.receipts.evidence.find(
      (e) => e.id === 'obs_call_srv_3',
    );
    expect(linkedObs).toBeDefined();

    // Update goal
    expect(
      controller.updateGoalStatus(root, {
        goalId: 'goal_slice',
        status: 'satisfied',
      }).success,
    ).toBe(true);

    // Submit final evidence
    const finalEvRes = controller.submitEvidence(root, {
      description: 'Final verification passed',
      assertedStatus: 'passed',
      assertedFreshness: 'fresh',
      candidateFingerprint: candidate,
    });
    expect(finalEvRes.success).toBe(true);
    if (!finalEvRes.success) return;

    // Open final checkpoint
    const chkRes = controller.checkpoint(root, {
      kind: 'final',
      reason: 'Final review',
      candidateFingerprint: candidate,
      evidenceAttestationIds: [finalEvRes.data.attestationId],
    });
    expect(chkRes.success).toBe(true);
    if (!chkRes.success) return;

    reviewVerdict = 'ACCEPT';
    controller.validateAndMarkDispatching(
      root,
      'call_final_dispatch',
      dispatchInstruction(controller, root),
    );
    controller.bindManagerTask(
      root,
      'call_final_dispatch',
      'mgr_task_compact',
      1,
    );

    const recReview = await controller.reconcileReview(root, {
      checkpointId: chkRes.data.checkpointId,
      managerTaskId: 'mgr_task_compact',
      managerGeneration: 1,
    });
    expect(recReview.success).toBe(true);

    const finalizeRes = controller.finalize(root, {
      summary: 'Verified and accepted completion after 100+ tool calls',
    });
    expect(finalizeRes.success).toBe(true);

    // Accepted record reload is valid
    const finalReload = new OutcomeController({
      storeDirectory: tempDir,
    }).readRecord(root);
    expect(finalReload.success).toBe(true);
    if (!finalReload.success) return;
    expect(finalReload.data.phase).toBe('accepted');
    expect(finalReload.data.finalCertificate).toBeDefined();
  });

  describe('Golden exact-packet contract review tests', () => {
    test('emits exact JSON packet for empty rules/evidence/exceptions and authenticates generated review', async () => {
      const root = 'ses_golden_empty';
      let controller: OutcomeController;
      controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_golden_empty',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => {
          const recRes = controller.readRecord(root);
          if (!recRes.success || !recRes.data.checkpoint) {
            throw new Error('Record missing');
          }
          const packet = buildOutcomeReviewPacket(
            recRes.data,
            recRes.data.checkpoint,
          );
          expect(packet).toContain(
            '## Exact Controller-Authenticated Review Values',
          );
          const exactPayload = buildOutcomeReviewExactPayload(
            recRes.data,
            recRes.data.checkpoint,
          );
          expect(exactPayload.goals).toEqual([
            {
              id: 'goal_slice',
              description: 'Complete all requirements of the vertical slice',
              status: 'in_progress',
            },
          ]);
          expect(exactPayload.rules).toEqual([]);
          expect(exactPayload.evidence).toEqual([]);
          expect(exactPayload.exceptions).toEqual([]);

          const review: OutcomeReview = {
            summary: 'Initial kickoff contract verified exactly',
            verdict: 'CONTINUE',
            goals: exactPayload.goals,
            scope: exactPayload.scope,
            rules: exactPayload.rules,
            evidence: exactPayload.evidence,
            constraintCoherence: {
              ordering: ['goals verified'],
              coherent: true,
            },
            exceptions: exactPayload.exceptions,
            handoff: {
              ready: false,
              summary: 'In progress',
              verificationSteps: [],
            },
            lifecycle: {
              stage: 'execution',
              receiptAgreement: true,
            },
          };
          return {
            text: `<outcome_review>${JSON.stringify(review)}</outcome_review>`,
            empty: false,
            terminal: true,
          };
        },
        consumeManagerTask: () => true,
      });

      const begun = controller.begin(root, testContract());
      expect(begun.success).toBe(true);
      if (!begun.success) return;

      controller.validateAndMarkDispatching(
        root,
        'call_golden_empty',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_golden_empty',
        'mgr_golden_empty',
        1,
      );

      const reconcileRes = await controller.reconcileReview(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        managerTaskId: 'mgr_golden_empty',
        managerGeneration: 1,
      });
      expect(reconcileRes.success).toBe(true);
      expect(reconcileRes.data.verdict).toBe('CONTINUE');
      expect(controller.getStatus(root).kickoffGate?.state).toBe(
        'authenticated',
      );
    });

    test('emits exact JSON packet for populated rules/evidence/exceptions and authenticates generated review', async () => {
      const root = 'ses_golden_populated';
      const candidate = hash('candidate_golden_populated');

      // Initialize with a contract that has rules, waiver, and exception
      const initialStore = new OutcomeStore({ storeDirectory: tempDir });
      initialStore.init(root, {
        contract: testContract(),
      });
      // Register repository waiver
      const c1 = new OutcomeController({ storeDirectory: tempDir });
      const regWaiver = c1.registerRepositoryWaiver(root, {
        repositoryReference: 'waiver_golden_ref',
      });
      expect(regWaiver.success).toBe(true);
      if (!regWaiver.success) return;

      // Submit evidence for machine-enforced rule
      const ev1 = c1.submitEvidence(root, {
        description: 'Biome linter check passes cleanly',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: candidate,
      });
      expect(ev1.success).toBe(true);
      if (!ev1.success) return;

      // Revise contract to add machine-enforced rule (with evidence) and waived rule with exception
      const populatedContract = testContract({
        rules: [
          {
            id: 'rule_lint',
            sourcePath: 'biome.json',
            category: 'style',
            summary: 'Biome linter must pass',
            ruleType: 'machine_enforced',
            enforcementStatus: 'satisfied',
            evidenceAttestationIds: [ev1.data.attestationId],
          },
          {
            id: 'rule_waived',
            sourcePath: 'docs/arch.md',
            category: 'documentation',
            summary: 'Detailed architecture documentation required',
            ruleType: 'semantic',
            enforcementStatus: 'waived',
            evidenceAttestationIds: [],
          },
        ],
        exceptions: [
          {
            ruleId: 'rule_waived',
            justification: 'Waiver granted for initial vertical slice',
            scope: 'vertical-slice-only',
            authorizationId: regWaiver.data.authorizationId,
          },
        ],
      });

      const reviseRes = c1.reviseContract(root, {
        contract: populatedContract,
      });
      expect(reviseRes.success).toBe(true);

      let reviewPayloadToReturn: OutcomeReview | undefined;
      const controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_golden_pop',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify(reviewPayloadToReturn)}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      // 1. Open kickoff checkpoint with included evidence
      const kickoffChk = controller.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Kickoff with initial evidence and waiver',
        evidenceAttestationIds: [ev1.data.attestationId],
      });
      expect(kickoffChk.success).toBe(true);
      if (!kickoffChk.success) return;

      const recordKickoff = controller.readRecord(root);
      expect(recordKickoff.success).toBe(true);
      if (!recordKickoff.success || !recordKickoff.data.checkpoint) return;

      const kickoffExact = buildOutcomeReviewExactPayload(
        recordKickoff.data,
        recordKickoff.data.checkpoint,
      );
      expect(kickoffExact.rules).toHaveLength(2);
      expect(kickoffExact.rules[0].evidenceIds).toEqual([
        ev1.data.attestationId,
      ]);
      expect(kickoffExact.evidence).toHaveLength(1);
      expect(kickoffExact.evidence[0]).toEqual({
        id: ev1.data.attestationId,
        command: 'Biome linter check passes cleanly',
        status: 'passed',
        fingerprint: candidate,
        freshness: 'fresh',
        isFinalCandidate: false,
      });
      expect(kickoffExact.exceptions).toHaveLength(1);
      expect(kickoffExact.exceptions[0]).toEqual({
        ruleId: 'rule_waived',
        justification: 'Waiver granted for initial vertical slice',
        justified: true,
        scope: 'vertical-slice-only',
        authorizationKind: 'repository_waiver',
        authorizationReference: 'waiver_golden_ref',
      });

      reviewPayloadToReturn = {
        summary: 'Kickoff verified',
        verdict: 'CONTINUE',
        goals: kickoffExact.goals,
        scope: kickoffExact.scope,
        rules: kickoffExact.rules,
        evidence: kickoffExact.evidence,
        constraintCoherence: {
          ordering: ['rules check'],
          coherent: true,
        },
        exceptions: kickoffExact.exceptions,
        handoff: {
          ready: false,
          summary: 'Kickoff done',
          verificationSteps: [],
        },
        lifecycle: {
          stage: 'execution',
          receiptAgreement: true,
        },
      };

      controller.validateAndMarkDispatching(
        root,
        'call_k_pop',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(root, 'call_k_pop', 'mgr_golden_pop', 1);
      const kRec = await controller.reconcileReview(root, {
        checkpointId: kickoffChk.data.checkpointId,
        managerTaskId: 'mgr_golden_pop',
        managerGeneration: 1,
      });
      expect(kRec.success).toBe(true);

      // 2. Satisfy goal status
      expect(
        controller.updateGoalStatus(root, {
          goalId: 'goal_slice',
          status: 'satisfied',
        }).success,
      ).toBe(true);

      // 3. Open final checkpoint with evidence
      const finalChk = controller.checkpoint(root, {
        kind: 'final',
        reason: 'Final review with evidence and waiver',
        candidateFingerprint: candidate,
        evidenceAttestationIds: [ev1.data.attestationId],
      });
      expect(finalChk.success).toBe(true);
      if (!finalChk.success) return;

      const recordFinal = controller.readRecord(root);
      expect(recordFinal.success).toBe(true);
      if (!recordFinal.success || !recordFinal.data.checkpoint) return;
      const finalRecord = recordFinal.data;
      const finalClaim = finalRecord.checkpoint;
      const packet = buildOutcomeReviewPacket(finalRecord, finalClaim);
      expect(packet).toContain(
        '## Exact Controller-Authenticated Review Values',
      );

      const finalExact = buildOutcomeReviewExactPayload(
        finalRecord,
        finalClaim,
      );
      expect(finalExact.candidateFingerprint).toBe(candidate);
      expect(finalExact.goals[0].status).toBe('satisfied');
      expect(finalExact.evidence).toHaveLength(1);
      expect(finalExact.evidence[0]).toEqual({
        id: ev1.data.attestationId,
        command: 'Biome linter check passes cleanly',
        status: 'passed',
        fingerprint: candidate,
        freshness: 'fresh',
        isFinalCandidate: true,
      });
      expect(finalExact.rules[0].evidenceIds).toEqual([ev1.data.attestationId]);

      // Return exact ACCEPT review generated solely from exact payload
      reviewPayloadToReturn = {
        summary: 'Final review verified and accepted',
        verdict: 'ACCEPT',
        ...(finalExact.candidateFingerprint
          ? { candidateFingerprint: finalExact.candidateFingerprint }
          : {}),
        goals: finalExact.goals,
        scope: finalExact.scope,
        rules: finalExact.rules,
        evidence: finalExact.evidence,
        constraintCoherence: {
          ordering: ['verified'],
          coherent: true,
        },
        exceptions: finalExact.exceptions,
        handoff: {
          ready: true,
          summary: 'All checks verified',
          verificationSteps: ['bun test', 'bun run typecheck'],
        },
        lifecycle: {
          stage: 'completed',
          receiptAgreement: true,
        },
      };

      controller.validateAndMarkDispatching(
        root,
        'call_f_pop',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(root, 'call_f_pop', 'mgr_golden_pop', 1);
      const finalRec = await controller.reconcileReview(root, {
        checkpointId: finalChk.data.checkpointId,
        managerTaskId: 'mgr_golden_pop',
        managerGeneration: 1,
      });
      expect(finalRec.success).toBe(true);
      expect(finalRec.data.verdict).toBe('ACCEPT');

      const fin = controller.finalize(root, { summary: 'Completed' });
      expect(fin.success).toBe(true);
    });

    test('one-character mismatch in exact review fields fails authentication', async () => {
      const root = 'ses_golden_mismatch';
      let reviewPayloadToReturn: OutcomeReview;
      const controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_mismatch',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify(reviewPayloadToReturn)}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      controller.begin(root, testContract());
      const recordMis = controller.readRecord(root);
      expect(recordMis.success).toBe(true);
      if (!recordMis.success || !recordMis.data.checkpoint) return;
      const record = recordMis.data;
      const checkpoint = record.checkpoint;
      const exact = buildOutcomeReviewExactPayload(record, checkpoint);

      // Helper to build base review
      const makeReview = (
        overrides: Partial<OutcomeReview>,
      ): OutcomeReview => ({
        summary: 'Review',
        verdict: 'CONTINUE',
        goals: exact.goals,
        scope: exact.scope,
        rules: exact.rules,
        evidence: exact.evidence,
        constraintCoherence: { ordering: ['1'], coherent: true },
        exceptions: exact.exceptions,
        handoff: { ready: false, summary: 'no', verificationSteps: [] },
        lifecycle: { stage: 'execution', receiptAgreement: true },
        ...overrides,
      });

      // Goal description 1-character mismatch
      reviewPayloadToReturn = makeReview({
        goals: [
          {
            ...exact.goals[0],
            description: `${exact.goals[0].description}x`,
          },
        ],
      });
      controller.validateAndMarkDispatching(
        root,
        'call_mis_1',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(root, 'call_mis_1', 'mgr_mismatch', 1);
      const res1 = await controller.reconcileReview(root, {
        checkpointId: checkpoint.checkpointId,
        managerTaskId: 'mgr_mismatch',
      });
      expect(res1.success).toBe(false);
      expect(res1.code).toBe('review_auth_failed');
    });

    test('added discovered rule not in contract fails authentication', async () => {
      const root = 'ses_golden_extra_rule';
      let reviewPayloadToReturn: OutcomeReview;
      const controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_extra_rule',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify(reviewPayloadToReturn)}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      controller.begin(root, testContract());
      const recordExtra = controller.readRecord(root);
      expect(recordExtra.success).toBe(true);
      if (!recordExtra.success || !recordExtra.data.checkpoint) return;
      const record = recordExtra.data;
      const checkpoint = record.checkpoint;
      const exact = buildOutcomeReviewExactPayload(record, checkpoint);

      // Review includes an uncontracted / discovered rule
      reviewPayloadToReturn = {
        summary: 'Review with extra discovered rule',
        verdict: 'CONTINUE',
        goals: exact.goals,
        scope: exact.scope,
        rules: [
          {
            id: 'discovered_rule_1',
            sourcePath: 'unknown.ts',
            category: 'uncontracted',
            summary: 'Discovered undeclared rule',
            ruleType: 'semantic',
            enforcementStatus: 'satisfied',
            evidenceIds: [],
          },
        ],
        evidence: exact.evidence,
        constraintCoherence: { ordering: ['1'], coherent: true },
        exceptions: exact.exceptions,
        handoff: { ready: false, summary: 'no', verificationSteps: [] },
        lifecycle: { stage: 'execution', receiptAgreement: true },
      };

      controller.validateAndMarkDispatching(
        root,
        'call_extra_rule',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(root, 'call_extra_rule', 'mgr_extra_rule', 1);
      const res = await controller.reconcileReview(root, {
        checkpointId: checkpoint.checkpointId,
        managerTaskId: 'mgr_extra_rule',
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe('review_auth_failed');
      expect(res.error).toContain('Manager review rule set does not match');
    });

    test('buildOutcomeReviewExactPayload throws if exception lacks referenced authorization and packet construction fails', () => {
      const root = 'ses_golden_missing_auth';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());
      const rec = controller.readRecord(root);
      expect(rec.success).toBe(true);
      if (!rec.success || !rec.data.checkpoint) return;

      // Tamper contract exception to reference missing authorization ID
      const tamperedRecord = structuredClone(rec.data);
      tamperedRecord.contract.rules.push({
        id: 'rule_waived_test',
        sourcePath: 'waived.ts',
        category: 'test',
        summary: 'Waived test rule',
        ruleType: 'semantic',
        enforcementStatus: 'waived',
        evidenceAttestationIds: [],
      });
      tamperedRecord.contract.exceptions.push({
        ruleId: 'rule_waived_test',
        justification: 'Waiver justification',
        scope: 'scope_test',
        authorizationId: 'auth_missing_123',
      });

      const checkpoint = rec.data.checkpoint;

      expect(() =>
        buildOutcomeReviewExactPayload(tamperedRecord, checkpoint),
      ).toThrow(
        "Exception for rule 'rule_waived_test' references missing authorization 'auth_missing_123'",
      );
      expect(() =>
        buildOutcomeReviewPacket(tamperedRecord, checkpoint),
      ).toThrow(
        "Exception for rule 'rule_waived_test' references missing authorization 'auth_missing_123'",
      );
    });

    test('buildOutcomeReviewExactPayload throws defensively if claim omits rule-referenced evidence or contains missing attestation', () => {
      const root = 'ses_golden_defensive_checks';
      const candidate = hash('cand_defensive');
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());
      const ev = controller.submitEvidence(root, {
        description: 'Defensive check attestation',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: candidate,
      });
      expect(ev.success).toBe(true);
      if (!ev.success) return;

      const rec = controller.readRecord(root);
      expect(rec.success).toBe(true);
      if (!rec.success || !rec.data.checkpoint) return;

      // 1. Claim omits evidence required by a rule
      const tamperedRecord1 = structuredClone(rec.data);
      tamperedRecord1.contract.rules.push({
        id: 'rule_with_ev',
        sourcePath: 'ev.ts',
        category: 'test',
        summary: 'Rule with evidence',
        ruleType: 'machine_enforced',
        enforcementStatus: 'satisfied',
        evidenceAttestationIds: [ev.data.attestationId],
      });
      const claimWithoutEv = structuredClone(rec.data.checkpoint);
      claimWithoutEv.includedEvidenceAttestationIds = [];

      expect(() =>
        buildOutcomeReviewExactPayload(tamperedRecord1, claimWithoutEv),
      ).toThrow(
        `Rule 'rule_with_ev' references evidence attestation '${ev.data.attestationId}' not included in checkpoint claim`,
      );

      // 2. Claim includes an attestation ID not present in receipts
      const claimWithMissingEv = structuredClone(rec.data.checkpoint);
      claimWithMissingEv.includedEvidenceAttestationIds = [
        'att_nonexistent_999',
      ];

      expect(() =>
        buildOutcomeReviewExactPayload(rec.data, claimWithMissingEv),
      ).toThrow(
        "Included evidence attestation 'att_nonexistent_999' not found in durable receipts",
      );
    });

    test('checkpoint fails closed with no write when rule-referenced evidence is omitted from included evidenceAttestationIds', () => {
      const root = 'ses_checkpoint_no_write_missing_ev';
      const candidate = hash('cand_no_write');
      const initialStore = new OutcomeStore({ storeDirectory: tempDir });
      initialStore.init(root, { contract: testContract() });
      const controller = new OutcomeController({ storeDirectory: tempDir });

      const ev = controller.submitEvidence(root, {
        description: 'Required rule evidence',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: candidate,
      });
      expect(ev.success).toBe(true);
      if (!ev.success) return;

      const contractWithRule = testContract({
        rules: [
          {
            id: 'rule_needs_ev',
            sourcePath: 'check.ts',
            category: 'test',
            summary: 'Rule requiring evidence',
            ruleType: 'machine_enforced',
            enforcementStatus: 'satisfied',
            evidenceAttestationIds: [ev.data.attestationId],
          },
        ],
      });

      // Revise contract to declare the rule with evidence
      const reviseRes = controller.reviseContract(root, {
        contract: contractWithRule,
      });
      expect(reviseRes.success).toBe(true);

      const file = controller.store.recordPath(root);
      const bytesBefore = fs.readFileSync(file, 'utf8');
      const recBefore = controller.readRecord(root).data;

      // Attempt to open checkpoint with evidenceAttestationIds missing the rule's evidence
      const chkRes = controller.checkpoint(root, {
        kind: 'final',
        reason: 'Final checkpoint with omitted evidence',
        candidateFingerprint: candidate,
        evidenceAttestationIds: [],
      });
      expect(chkRes.success).toBe(false);
      expect(chkRes.code).toBe('invalid_checkpoint_params');
      expect(chkRes.error).toContain(
        `Checkpoint must include evidence attestation '${ev.data.attestationId}' referenced by rule 'rule_needs_ev'`,
      );

      // Assert no-write: file byte-identical, revision unchanged, actionsRequired unchanged, generation unchanged
      const bytesAfter = fs.readFileSync(file, 'utf8');
      const recAfter = controller.readRecord(root).data;
      expect(bytesAfter).toBe(bytesBefore);
      expect(recAfter.revision).toBe(recBefore.revision);
      expect(recAfter.actionsRequired.length).toBe(
        recBefore.actionsRequired.length,
      );
      expect(recAfter.nextClaimGeneration).toBe(recBefore.nextClaimGeneration);
    });

    test('idempotent begin returns truthful status and omits checkpoint metadata when no persisted checkpoint exists', () => {
      const root = 'ses_idempotent_begin_no_claim';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());

      // Tamper state: mark kickoffGate authenticated and delete active checkpoint
      const file = controller.store.recordPath(root);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.kickoffGate = {
        policyVersion: 1,
        state: 'authenticated',
        contractDigest: record.contractDigest,
        attempts: 1,
        maxAttempts: 2,
        authenticatedReviewId: 'rev_kickoff_auth',
        lastCheckpointId: record.checkpoint?.checkpointId,
      };
      record.reviewSummaries.push({
        reviewId: 'rev_kickoff_auth',
        checkpointId: record.checkpoint?.checkpointId ?? 'chk_k',
        claimGeneration: 1,
        checkpointKind: 'kickoff',
        contractDigest: record.contractDigest,
        outcomeRevision: record.revision,
        verdict: 'CONTINUE',
        managerTaskId: 'mgr_k',
        managerGeneration: 1,
        resultDigest: hash('res_k'),
        reviewDigest: hash('rev_k'),
        summary: 'Kickoff verified',
        evaluatedAt: 1000,
      });
      delete record.checkpoint; // No active checkpoint exists!
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

      const beginRes = controller.begin(root, testContract());
      expect(beginRes.success).toBe(true);
      if (!beginRes.success) return;
      expect(beginRes.data.idempotent).toBe(true);
      expect(beginRes.data.checkpoint).toBeUndefined(); // Truthful: no fake checkpoint metadata!
      expect(beginRes.data.kickoffGate?.state).toBe('authenticated');
      expect(beginRes.data.dispatchNudgePending).toBe(false);
    });
  });

  describe('Terrarium issue #397 controller-level replays', () => {
    test('successful #397 replay: initial invalid kickoff -> provenance-backed action resolution -> retry CONTINUE -> final ACCEPT -> single certificate', async () => {
      const root = 'ses_replay_successful_397';
      const candidate = hash('cand_replay_397');
      let now = 1_000;
      let reviewResultText = '';
      let currentTaskId = 'mgr_task_1';
      let currentGeneration = 1;

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        clock: () => now,
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

      // 1. Initial kickoff opened (attempt 1, generation 1)
      const beginRes = controller.begin(root, testContract());
      expect(beginRes.success).toBe(true);
      if (!beginRes.success) return;
      expect(beginRes.data.checkpoint.claimGeneration).toBe(1);
      expect(controller.getStatus(root).kickoffGate?.attempts).toBe(1);
      expect(controller.getStatus(root).kickoffGate?.state).toBe('required');

      // 2. Manager produces invalid review
      reviewResultText = 'Not valid XML review';
      controller.validateAndMarkDispatching(
        root,
        'call_k1',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_k1',
        currentTaskId,
        currentGeneration,
      );
      const r1 = await controller.reconcileReview(root, {
        checkpointId: beginRes.data.checkpoint.checkpointId,
        managerTaskId: currentTaskId,
        managerGeneration: currentGeneration,
      });
      expect(r1.success).toBe(false);
      expect(r1.code).toBe('review_invalid');

      // Check state: phase is action_required, kickoffGate state is required, attempts is 1
      const statusAfterInvalid = controller.getStatus(root);
      expect(statusAfterInvalid.phase).toBe('action_required');
      expect(statusAfterInvalid.kickoffGate?.attempts).toBe(1);
      expect(statusAfterInvalid.kickoffGate?.state).toBe('required');
      expect(statusAfterInvalid.actionsRequired).toHaveLength(1);
      const actionToResolve = statusAfterInvalid.actionsRequired[0];

      // 3. User provenance is recorded
      now += 10;
      controller.observeUserTurn(
        root,
        'msg_user_retry_instruction',
        'Please retry kickoff review following exact contract instructions',
      );
      const userReceipt = controller
        .readRecord(root)
        .data.receipts.userMessages.at(-1);
      expect(userReceipt?.provenance).toBe('external_user');

      // 4. Resolve action with external user provenance
      now += 5;
      const resolveRes = controller.resolveAction(root, {
        actionId: actionToResolve.id,
        reason: 'User provided retry direction',
        sourceUserMessageReceiptId: userReceipt?.id,
      });
      expect(resolveRes.success).toBe(true);

      // 5. Open exactly one retry kickoff checkpoint (attempt 2, generation 2)
      const retryKickoff = controller.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Retry kickoff review with exact packet',
      });
      expect(retryKickoff.success).toBe(true);
      if (!retryKickoff.success) return;
      expect(retryKickoff.data.claimGeneration).toBe(2);

      // 6. Manager produces exact valid review with CONTINUE
      currentTaskId = 'mgr_task_2';
      currentGeneration = 2;
      reviewResultText = `<outcome_review>${JSON.stringify(
        validReviewFor(controller, root, 'CONTINUE'),
      )}</outcome_review>`;

      controller.validateAndMarkDispatching(
        root,
        'call_k2',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_k2',
        currentTaskId,
        currentGeneration,
      );
      const r2 = await controller.reconcileReview(root, {
        checkpointId: retryKickoff.data.checkpointId,
        managerTaskId: currentTaskId,
        managerGeneration: currentGeneration,
      });
      expect(r2.success).toBe(true);
      expect(r2.data.verdict).toBe('CONTINUE');

      const statusAfterKickoff = controller.getStatus(root);
      expect(statusAfterKickoff.kickoffGate?.state).toBe('authenticated');
      expect(statusAfterKickoff.kickoffGate?.attempts).toBe(2);

      // 7. Update goal status & submit final evidence
      expect(
        controller.updateGoalStatus(root, {
          goalId: 'goal_slice',
          status: 'satisfied',
        }).success,
      ).toBe(true);

      const evSubmit = controller.submitEvidence(root, {
        description: 'All tests passed cleanly',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: candidate,
      });
      expect(evSubmit.success).toBe(true);
      if (!evSubmit.success) return;

      // 8. Open final checkpoint
      const finalChk = controller.checkpoint(root, {
        kind: 'final',
        reason: 'Final review',
        candidateFingerprint: candidate,
        evidenceAttestationIds: [evSubmit.data.attestationId],
      });
      expect(finalChk.success).toBe(true);
      if (!finalChk.success) return;
      expect(finalChk.data.claimGeneration).toBe(3);

      // 9. Manager ACCEPT review
      currentTaskId = 'mgr_task_3';
      currentGeneration = 3;
      reviewResultText = `<outcome_review>${JSON.stringify(
        validReviewFor(controller, root, 'ACCEPT', {
          candidateFingerprint: candidate,
        }),
      )}</outcome_review>`;

      controller.validateAndMarkDispatching(
        root,
        'call_f',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_f',
        currentTaskId,
        currentGeneration,
      );
      const r3 = await controller.reconcileReview(root, {
        checkpointId: finalChk.data.checkpointId,
        managerTaskId: currentTaskId,
        managerGeneration: currentGeneration,
      });
      expect(r3.success).toBe(true);
      expect(r3.data.verdict).toBe('ACCEPT');

      // 10. Finalize -> exactly one certificate
      const finRes = controller.finalize(root, {
        summary: 'Outcome completed successfully after kickoff retry',
      });
      expect(finRes.success).toBe(true);
      if (!finRes.success) return;
      expect(finRes.data.certificate).toBeDefined();

      const finalRecord = controller.readRecord(root).data;
      expect(finalRecord.phase).toBe('accepted');
      expect(finalRecord.finalCertificate).toBeDefined();
      expect(finalRecord.reviewSummaries).toHaveLength(2); // 1 kickoff + 1 final
      expect(finalRecord.nextClaimGeneration).toBe(4); // Bounded generations (1, 2, 3)
    });

    test('legacy blocked #397 replay: sanitized migrated record cannot open retrospective kickoff/finalize, and repeated calls do not grow revision/actions', () => {
      const root = 'root_terrarium_397_replay';
      const c = testContract();
      const cDigest = computeOutcomeContractDigest(c);
      const candidate = hash('cand_397');

      // Build sanitized V1 fixture matching Terrarium issue #397 anatomy:
      const actionsRequired = Array.from({ length: 16 }, (_, i) => ({
        id: `act_397_${i + 1}`,
        code: 'manual_intervention' as const,
        referenceId: `ref_397_${i + 1}`,
        reason: `Historical invalid review action ${i + 1}`,
        createdAt: 100 + i,
        createdRevision: (i + 1) * 2,
        resolvedAt: 100 + i + 1,
        resolutionKind: 'orchestrator_provenance' as const,
        resolutionReason: `Resolved ${i + 1}`,
        resolutionUserMessageReceiptId: `usr_397_${i + 1}`,
      }));

      const userMessages = Array.from({ length: 16 }, (_, i) => ({
        id: `usr_397_${i + 1}`,
        messageId: `msg_397_${i + 1}`,
        contentDigest: hash(`content_${i + 1}`),
        observedEpoch: 'epoch_397_old',
        observedAt: 100 + i,
        createdRevision: (i + 1) * 2 + 1,
      }));

      const operations = Array.from({ length: 3 }, (_, i) => ({
        id: `op_running_${i + 1}`,
        callId: `call_run_${i + 1}`,
        toolName: 'bash',
        argumentDigest: hash(`run_args_${i + 1}`),
        serverEpoch: 'epoch_397',
        status: 'running' as const,
        startedAt: 500 + i,
        updatedAt: 500 + i,
      }));

      const v1Fixture = {
        schema: 'omos_outcome_record',
        schemaVersion: 1,
        outcomeId: 'out_terrarium_397',
        rootSessionId: root,
        serverEpoch: 'epoch_397',
        revision: 100,
        nextClaimGeneration: 19,
        contractDigest: cDigest,
        createdAt: 1_000,
        updatedAt: 2_000,
        phase: 'reviewing',
        contract: c,
        receipts: {
          evidence: [],
          userMessages,
          decisions: [],
          authorizations: [],
        },
        reviewSummaries: [
          {
            reviewId: 'rev_final_397',
            checkpointId: 'chk_final_397',
            claimGeneration: 17,
            checkpointKind: 'final',
            contractDigest: cDigest,
            outcomeRevision: 90,
            verdict: 'ACCEPT',
            managerTaskId: 'mgr_task_final',
            managerGeneration: 1,
            resultDigest: hash('res_final_397'),
            reviewDigest: hash('rev_final_397'),
            candidateFingerprint: candidate,
            summary: 'Final deliverable accepted without prior kickoff',
            evaluatedAt: 2_000,
          },
        ],
        checkpoint: {
          outcomeId: 'out_terrarium_397',
          rootSessionId: root,
          checkpointId: 'chk_kickoff_retrospective_18',
          kind: 'kickoff' as const,
          reason: 'Retrospective kickoff generation 18',
          claimGeneration: 18,
          claimTokenDigest: hash('token_18'),
          contractDigest: cDigest,
          outcomeRevision: 95,
          serverEpoch: 'epoch_397',
          claimedAt: 1_900,
          expiresAt: 2_500,
          includedDecisionIds: [],
          includedExceptionRuleIds: [],
          includedEvidenceAttestationIds: [],
          state: 'running' as const,
          dispatchCallId: 'call_retro_18',
          managerTaskId: 'mgr_task_retro_18',
          managerGeneration: 1,
          checkpointFingerprint: computeOutcomeCheckpointFingerprint({
            outcomeId: 'out_terrarium_397',
            rootSessionId: root,
            checkpointId: 'chk_kickoff_retrospective_18',
            kind: 'kickoff',
            reason: 'Retrospective kickoff generation 18',
            claimGeneration: 18,
            claimTokenDigest: hash('token_18'),
            contractDigest: cDigest,
            outcomeRevision: 95,
            serverEpoch: 'epoch_397',
            claimedAt: 1_900,
            expiresAt: 2_500,
            includedDecisionIds: [],
            includedExceptionRuleIds: [],
            includedEvidenceAttestationIds: [],
          }),
        },
        operations,
        actionsRequired,
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_397',
      });
      const file = controller.store.recordPath(root);
      fs.writeFileSync(file, `${JSON.stringify(v1Fixture, null, 2)}\n`);

      // 1. Status projection reflects legacy_late_missing
      const status = controller.getStatus(root);
      expect(status.isManaged).toBe(true);
      expect(status.phase).toBe('failed');
      expect(status.kickoffGate).toEqual({
        state: 'legacy_late_missing',
        attempts: 0,
        maxAttempts: 2,
        failureReason:
          'Historical record has review activity without an authenticated kickoff review',
      });

      // 2. Pending nudge gives recovery message for legacy record
      const nudge = controller.getPendingNudge(root);
      expect(nudge?.kind).toBe('recovery');
      expect(nudge?.message).toContain('Retrospective kickoff forbidden');

      // 3. Begin, checkpoint, and finalize are rejected
      const beginRes = controller.begin(root, c);
      expect(beginRes.success).toBe(false);
      expect(beginRes.code).toBe('retrospective_kickoff_forbidden');

      const chkRes = controller.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Try retrospective kickoff 19',
      });
      expect(chkRes.success).toBe(false);
      expect(chkRes.code).toBe('retrospective_kickoff_forbidden');

      const finalChkRes = controller.checkpoint(root, {
        kind: 'final',
        reason: 'Try final checkpoint',
        candidateFingerprint: candidate,
      });
      expect(finalChkRes.success).toBe(false);
      expect(finalChkRes.code).toBe('retrospective_kickoff_forbidden');

      const finRes = controller.finalize(root, { summary: 'Try finalize' });
      expect(finRes.success).toBe(false);

      // 4. Repeated calls do not mutate file or grow revision / actions
      const bytesBefore = fs.readFileSync(file, 'utf8');
      const recBefore = controller.readRecord(root).data;

      for (let i = 0; i < 5; i++) {
        controller.getStatus(root);
        controller.getPendingNudge(root);
        controller.begin(root, c);
        controller.checkpoint(root, {
          kind: 'kickoff',
          reason: 'Retry kickoff',
        });
        controller.finalize(root, { summary: 'Retry finalize' });
      }

      const bytesAfter = fs.readFileSync(file, 'utf8');
      const recAfter = controller.readRecord(root).data;

      expect(bytesAfter).toBe(bytesBefore);
      expect(recAfter.revision).toBe(recBefore.revision);
      expect(recAfter.actionsRequired.length).toBe(
        recBefore.actionsRequired.length,
      );
    });

    test('two kickoff failures -> third request stable no-write error', async () => {
      const root = 'ses_replay_two_failures';
      let now = 1_000;
      const reviewResultText = 'invalid';
      let currentTaskId = 'mgr_task_1';
      let currentGeneration = 1;

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        clock: () => now,
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

      // Attempt 1: begin outcome
      const beginRes = controller.begin(root, testContract());
      expect(beginRes.success).toBe(true);
      if (!beginRes.success) return;

      // Fail attempt 1
      controller.validateAndMarkDispatching(
        root,
        'call_k1',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_k1',
        currentTaskId,
        currentGeneration,
      );
      const r1 = await controller.reconcileReview(root, {
        checkpointId: beginRes.data.checkpoint.checkpointId,
        managerTaskId: currentTaskId,
        managerGeneration: currentGeneration,
      });
      expect(r1.success).toBe(false);

      const status1 = controller.getStatus(root);
      expect(status1.kickoffGate?.attempts).toBe(1);
      expect(status1.kickoffGate?.state).toBe('required');
      const action1 = status1.actionsRequired[0];

      // Resolve action with user provenance
      now += 10;
      controller.observeUserTurn(root, 'msg_u1', 'Retry please');
      const recUser = controller.readRecord(root);
      expect(recUser.success).toBe(true);
      if (!recUser.success) return;
      const u1 = recUser.data.receipts.userMessages.at(-1);
      expect(u1).toBeDefined();
      if (!u1) return;
      expect(
        controller.resolveAction(root, {
          actionId: action1.id,
          reason: 'User instruction',
          sourceUserMessageReceiptId: u1.id,
        }).success,
      ).toBe(true);

      // Attempt 2: open kickoff checkpoint
      const k2 = controller.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Kickoff attempt 2',
      });
      expect(k2.success).toBe(true);
      if (!k2.success) return;
      expect(k2.data.claimGeneration).toBe(2);

      // Fail attempt 2
      currentTaskId = 'mgr_task_2';
      currentGeneration = 2;
      controller.validateAndMarkDispatching(
        root,
        'call_k2',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_k2',
        currentTaskId,
        currentGeneration,
      );
      const r2 = await controller.reconcileReview(root, {
        checkpointId: k2.data.checkpointId,
        managerTaskId: currentTaskId,
        managerGeneration: currentGeneration,
      });
      expect(r2.success).toBe(false);

      // Gate should now be exhausted and phase failed
      const status2 = controller.getStatus(root);
      expect(status2.kickoffGate?.state).toBe('exhausted');
      expect(status2.kickoffGate?.attempts).toBe(2);
      expect(status2.phase).toBe('failed');

      // Nudge returns recovery message
      const nudge = controller.getPendingNudge(root);
      expect(nudge?.kind).toBe('recovery');
      expect(nudge?.message).toContain('Kickoff attempts exhausted (2/2)');

      // Record file snapshot before third request
      const file = controller.store.recordPath(root);
      const bytesBefore = fs.readFileSync(file, 'utf8');
      const recBefore = controller.readRecord(root).data;

      // Third request via checkpoint -> stable no-write error
      const thirdChk = controller.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Kickoff attempt 3',
      });
      expect(thirdChk.success).toBe(false);
      expect(thirdChk.code).toBe('kickoff_retry_exhausted');

      // Third request via begin -> stable no-write error
      const thirdBegin = controller.begin(root, testContract());
      expect(thirdBegin.success).toBe(false);
      expect(thirdBegin.code).toBe('kickoff_retry_exhausted');

      // Verify no-write
      const bytesAfter = fs.readFileSync(file, 'utf8');
      const recAfter = controller.readRecord(root).data;
      expect(bytesAfter).toBe(bytesBefore);
      expect(recAfter.revision).toBe(recBefore.revision);
    });
  });

  describe('observeToolAfter CAS retry and idempotent completion', () => {
    test('retries on CAS conflict and completes tool call', () => {
      const root = 'ses_tool_cas_retry';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());

      const startRes = controller.observeToolBefore(
        root,
        'call_cas_1',
        'bash',
        {
          cmd: 'ls',
        },
      );
      expect(startRes.success).toBe(true);

      // Advance revision concurrently by observing a user turn
      let conflictInjected = true;
      const originalRead = controller.readRecord.bind(controller);
      controller.readRecord = (rootSessionId: string) => {
        const res = originalRead(rootSessionId);
        if (res.success && conflictInjected) {
          conflictInjected = false;
          controller.observeUserTurn(root, 'msg_concurrent', 'Concurrent turn');
        }
        return res;
      };

      const afterRes = controller.observeToolAfter(root, 'call_cas_1', 'bash', {
        stdout: 'file1.txt',
      });
      expect(afterRes.success).toBe(true);

      const rec = originalRead(root).data;
      const op = rec.operations.find((o) => o.id === 'op_call_cas_1');
      expect(op?.status).toBe('completed');
    });

    test('matching-digest completion is treated as success without creating new revision', () => {
      const root = 'ses_tool_noop_completion';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());

      controller.observeToolBefore(root, 'call_noop_1', 'bash', {
        cmd: 'pwd',
      });
      const first = controller.observeToolAfter(root, 'call_noop_1', 'bash', {
        stdout: '/app',
      });
      expect(first.success).toBe(true);

      const rec1 = controller.readRecord(root).data;
      const rev1 = rec1.revision;

      // Second identical complete call
      const second = controller.observeToolAfter(root, 'call_noop_1', 'bash', {
        stdout: '/app',
      });
      expect(second.success).toBe(true);

      const rec2 = controller.readRecord(root).data;
      expect(rec2.revision).toBe(rev1); // No revision bump
    });

    test('differing digest completion fails', () => {
      const root = 'ses_tool_diff_digest';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());

      controller.observeToolBefore(root, 'call_diff_1', 'bash', {
        cmd: 'pwd',
      });
      const first = controller.observeToolAfter(root, 'call_diff_1', 'bash', {
        stdout: '/app',
      });
      expect(first.success).toBe(true);

      // Differing output
      const second = controller.observeToolAfter(root, 'call_diff_1', 'bash', {
        stdout: '/other/path',
      });
      expect(second.success).toBe(false);
      expect(second.code).toBe('invalid_transition');
    });
  });

  describe('Review preflight validation and idempotent retry', () => {
    test('non-final ACCEPT is classified as invalid during preflight and persisted as invalid review', async () => {
      const root = 'ses_preflight_non_final_accept';
      const cand = hash('candidate_preflight');
      const prematureAcceptReview: OutcomeReview = {
        summary: 'Premature accept review',
        verdict: 'ACCEPT',
        candidateFingerprint: cand,
        goals: [
          {
            id: 'goal_slice',
            description: 'Complete all requirements of the vertical slice',
            status: 'satisfied',
          },
        ],
        scope: {
          inScope: ['src/outcome', 'src/tools', 'src/hooks'],
          outOfScope: ['Full autonomous agent rewrite'],
        },
        rules: [],
        evidence: [
          {
            id: 'att_preflight',
            command: 'bun test',
            status: 'passed',
            fingerprint: cand,
            freshness: 'fresh',
            isFinalCandidate: true,
          },
        ],
        constraintCoherence: {
          ordering: ['1'],
          coherent: true,
        },
        exceptions: [],
        handoff: {
          ready: true,
          summary: 'Ready',
          verificationSteps: ['bun test'],
        },
        lifecycle: {
          stage: 'completed',
          receiptAgreement: true,
        },
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_non_final_accept',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify(prematureAcceptReview)}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      const begun = controller.begin(root, testContract());
      expect(begun.success).toBe(true);
      if (!begun.success) return;

      controller.validateAndMarkDispatching(
        root,
        'call_accept_kickoff',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_accept_kickoff',
        'mgr_non_final_accept',
        1,
      );

      const res = await controller.reconcileReview(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        managerTaskId: 'mgr_non_final_accept',
        managerGeneration: 1,
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe('review_auth_failed');
      expect(res.error).toContain(
        'ACCEPT verdict is valid only for final checkpoint',
      );

      const record = controller.readRecord(root).data;
      expect(record.checkpoint?.state).toBe('review_invalid');
      expect(record.reviewSummaries).toHaveLength(0);

      // Retry is idempotent and returns review_invalid
      const retryRes = await controller.reconcileReview(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        managerTaskId: 'mgr_non_final_accept',
        managerGeneration: 1,
      });
      expect(retryRes.success).toBe(false);
      expect(retryRes.code).toBe('review_invalid');
    });

    test('unreconcilable kickoff checkpoint is classified as invalid during preflight', async () => {
      const root = 'ses_unreconcilable_kickoff';
      let controller: OutcomeController;
      controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_unreconcilable',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify(
            validReviewFor(controller, root, 'CONTINUE'),
          )}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      const begun = controller.begin(root, testContract());
      expect(begun.success).toBe(true);
      if (!begun.success) return;

      controller.validateAndMarkDispatching(
        root,
        'call_unrec',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(root, 'call_unrec', 'mgr_unreconcilable', 1);

      // Modify kickoff gate attempts to 0 while keeping checkpoint valid
      const file = controller.store.recordPath(root);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.kickoffGate.attempts = 0;
      delete record.kickoffGate.lastCheckpointId;
      delete record.checkpoint; // delete active checkpoint to simulate gate reset
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

      const res = await controller.reconcileReview(root, {
        checkpointId: begun.data.checkpoint.checkpointId,
        managerTaskId: 'mgr_unreconcilable',
        managerGeneration: 1,
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe('missing_checkpoint');
    });
  });

  describe('Gate 3 remediation: atomic external user turns and late authoritative tool repair', () => {
    test('observeExternalUserTurn / observeUserTurn returns OutcomeControllerResult, is idempotent on duplicate, fails on conflict, and retries bounded CAS', () => {
      const root = 'ses_user_turn_lifecycle';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());

      // 1. First observation succeeds with written status
      const res1 = controller.observeExternalUserTurn(
        root,
        'msg_u_1',
        'Hello world',
      );
      expect(res1.success).toBe(true);
      if (!res1.success) return;
      expect(res1.data.status).toBe('written');
      expect(res1.data.noop).toBe(false);
      expect(res1.data.receipt.messageId).toBe('msg_u_1');
      expect(res1.data.receipt.provenance).toBe('external_user');

      const rec1 = controller.readRecord(root).data;
      const file = controller.store.recordPath(root);
      const bytes1 = fs.readFileSync(file, 'utf8');

      // 2. Exact duplicate returns noop with identical revision and bytes
      const res2 = controller.observeExternalUserTurn(
        root,
        'msg_u_1',
        'Hello world',
      );
      expect(res2.success).toBe(true);
      if (!res2.success) return;
      expect(res2.data.status).toBe('noop');
      expect(res2.data.noop).toBe(true);
      expect(res2.data.receipt.id).toBe(res1.data.receipt.id);

      const rec2 = controller.readRecord(root).data;
      expect(rec2.revision).toBe(rec1.revision);
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes1);

      // 3. observeUserTurn compatibility alias works identically
      const res3 = controller.observeUserTurn(root, 'msg_u_1', 'Hello world');
      expect(res3.success).toBe(true);
      if (!res3.success) return;
      expect(res3.data.status).toBe('noop');
      expect(res3.data.noop).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes1);

      // 4. Conflicting content on same messageId fails closed with stable error and unchanged bytes
      const conflictRes = controller.observeExternalUserTurn(
        root,
        'msg_u_1',
        'Different text',
      );
      expect(conflictRes.success).toBe(false);
      expect(conflictRes.code).toBe('invalid_transition');
      expect(conflictRes.error).toContain(
        'already recorded with different content',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes1);

      const paddedDuplicate = controller.observeExternalUserTurn(
        root,
        '  msg_u_1  ',
        'Hello world',
      );
      expect(paddedDuplicate.success).toBe(true);
      if (paddedDuplicate.success) {
        expect(paddedDuplicate.data.noop).toBe(true);
        expect(paddedDuplicate.data.receipt.messageId).toBe('msg_u_1');
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes1);

      const paddedConflict = controller.observeExternalUserTurn(
        root,
        '\tmsg_u_1\n',
        'Different padded text',
      );
      expect(paddedConflict.success).toBe(false);
      expect(paddedConflict.code).toBe('invalid_transition');
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes1);

      // 5. Empty or whitespace messageId fails with invalid_parameter
      const emptyRes = controller.observeExternalUserTurn(
        root,
        '   ',
        'Some text',
      );
      expect(emptyRes.success).toBe(false);
      expect(emptyRes.code).toBe('invalid_parameter');

      // 6. Unmanaged session returns missing failure
      const unmanagedRes = controller.observeExternalUserTurn(
        'ses_unmanaged',
        'msg_x',
        'Text',
      );
      expect(unmanagedRes.success).toBe(false);
      expect(unmanagedRes.code).toBe('missing');

      // 7. CAS conflict retry in observeExternalUserTurn
      let conflictCount = 2;
      const originalRead = controller.readRecord.bind(controller);
      controller.readRecord = (rootSessionId: string) => {
        const res = originalRead(rootSessionId);
        if (res.success && conflictCount > 0) {
          conflictCount--;
          controller.updateGoalStatus(root, {
            goalId: 'goal_slice',
            status: 'in_progress',
          });
        }
        return res;
      };

      const casRes = controller.observeExternalUserTurn(
        root,
        'msg_cas_user',
        'Retry with CAS',
      );
      expect(casRes.success).toBe(true);
      if (casRes.success) {
        expect(casRes.data.status).toBe('written');
        expect(casRes.data.receipt.messageId).toBe('msg_cas_user');
      }
    });

    test('before -> reconcileIdleOperations -> authoritative after -> completed with cleared recovery nudge', async () => {
      const root = 'ses_idle_repair_controller';
      let controller: OutcomeController;
      controller = new OutcomeController({
        storeDirectory: tempDir,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_task_idle_repair',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: `<outcome_review>${JSON.stringify(
            validReviewFor(controller, root, 'CONTINUE'),
          )}</outcome_review>`,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      const beginRes = controller.begin(root, testContract());
      expect(beginRes.success).toBe(true);
      if (!beginRes.success) return;

      // Complete kickoff review with CONTINUE to authenticate kickoff gate
      controller.validateAndMarkDispatching(
        root,
        'call_kickoff_dispatch',
        dispatchInstruction(controller, root),
      );
      controller.bindManagerTask(
        root,
        'call_kickoff_dispatch',
        'mgr_task_idle_repair',
        1,
      );
      const kickoffReconcile = await controller.reconcileReview(root, {
        checkpointId: beginRes.data.checkpoint.checkpointId,
        managerTaskId: 'mgr_task_idle_repair',
        managerGeneration: 1,
      });
      expect(kickoffReconcile.success).toBe(true);
      expect(controller.getPendingNudge(root)).toBeUndefined();

      // 1. Tool before
      const startRes = controller.observeToolBefore(
        root,
        'call_idle_target',
        'bash',
        {
          cmd: 'npm test',
        },
      );
      expect(startRes.success).toBe(true);

      // Verify operation running
      let rec = controller.readRecord(root).data;
      let op = rec.operations.find((o) => o.id === 'op_call_idle_target');
      expect(op?.status).toBe('running');

      // 2. Idle reconciliation marks running op as interrupted
      const idleRes = controller.store.reconcileIdleOperations(root);
      expect(idleRes.success).toBe(true);

      rec = controller.readRecord(root).data;
      op = rec.operations.find((o) => o.id === 'op_call_idle_target');
      expect(op?.status).toBe('interrupted');
      expect(op?.error).toBe(
        'Session became idle without a durable tool after-hook',
      );

      // Nudge returns recovery guidance for interrupted operation
      const nudgeBefore = controller.getPendingNudge(root);
      expect(nudgeBefore?.kind).toBe('recovery');
      expect(nudgeBefore?.message).toContain('op_call_idle_target');

      // 3. Late authoritative after-hook completes the operation
      const afterRes = controller.observeToolAfter(
        root,
        'call_idle_target',
        'bash',
        {
          stdout: 'Tests passed: 10/10',
        },
      );
      expect(afterRes.success).toBe(true);

      rec = controller.readRecord(root).data;
      op = rec.operations.find((o) => o.id === 'op_call_idle_target');
      expect(op?.status).toBe('completed');
      expect(op?.error).toBeUndefined();

      // Nudge is cleared (no longer nudging for the repaired operation)
      const nudgeAfter = controller.getPendingNudge(root);
      expect(nudgeAfter).toBeUndefined();

      const file = controller.store.recordPath(root);
      const bytesAfterRepair = fs.readFileSync(file, 'utf8');

      // 4. Repeated late after is a true no-op
      const repeatAfter = controller.observeToolAfter(
        root,
        'call_idle_target',
        'bash',
        {
          stdout: 'Tests passed: 10/10',
        },
      );
      expect(repeatAfter.success).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(bytesAfterRepair);

      // 5. Conflicting output on late after fails closed
      const conflictAfter = controller.observeToolAfter(
        root,
        'call_idle_target',
        'bash',
        {
          stdout: 'Different output',
        },
      );
      expect(conflictAfter.success).toBe(false);
      expect(conflictAfter.code).toBe('invalid_transition');
    });

    test('rejection of restart-interrupted, failed, and acknowledged operations in Controller observeToolAfter', () => {
      const root = 'ses_tool_rejections';
      const controller = new OutcomeController({ storeDirectory: tempDir });
      controller.begin(root, testContract());

      // 1. Restart-interrupted rejection
      const restartRoot = 'ses_tool_restart_rej';
      const c1 = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_ctrl_1',
      });
      c1.begin(restartRoot, testContract());
      c1.observeToolBefore(restartRoot, 'call_restart_hung', 'bash', {
        cmd: 'sleep 100',
      });

      const c2 = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: 'epoch_ctrl_2',
      });
      // readRecord triggers recovery
      const recoveredRec = c2.readRecord(restartRoot);
      expect(recoveredRec.success).toBe(true);
      if (recoveredRec.success) {
        const op = recoveredRec.data.operations.find(
          (o) => o.id === 'op_call_restart_hung',
        );
        expect(op?.status).toBe('interrupted');
        expect(op?.error).toBe('Operation interrupted by process restart');
      }

      const restartAfterRes = c2.observeToolAfter(
        restartRoot,
        'call_restart_hung',
        'bash',
        {
          stdout: 'finished after restart',
        },
      );
      expect(restartAfterRes.success).toBe(false);
      expect(restartAfterRes.code).toBe('invalid_transition');

      // 2. Failed operation rejection
      controller.observeToolBefore(root, 'call_will_fail', 'bash', {
        cmd: 'bad_cmd',
      });
      const rec = controller.readRecord(root).data;
      controller.store.mutate(root, rec.revision, {
        type: 'finish_operation',
        operationId: 'op_call_will_fail',
        status: 'failed',
        error: 'Exit code 1',
      });

      const failedAfterRes = controller.observeToolAfter(
        root,
        'call_will_fail',
        'bash',
        {
          stdout: 'trying after finish',
        },
      );
      expect(failedAfterRes.success).toBe(false);
      expect(failedAfterRes.code).toBe('invalid_transition');

      // 3. Acknowledged operation rejection
      controller.observeToolBefore(root, 'call_will_ack', 'bash', {
        cmd: 'ack_cmd',
      });
      controller.store.reconcileIdleOperations(root);
      const rec2 = controller.readRecord(root).data;
      controller.store.mutate(root, rec2.revision, {
        type: 'acknowledge_operation',
        operationId: 'op_call_will_ack',
      });

      const ackAfterRes = controller.observeToolAfter(
        root,
        'call_will_ack',
        'bash',
        {
          stdout: 'trying after ack',
        },
      );
      expect(ackAfterRes.success).toBe(false);
      expect(ackAfterRes.code).toBe('invalid_transition');
    });
  });

  describe('prior-epoch boardless recovery for restart resilience', () => {
    async function setupPriorEpochResultAvailable(
      root: string,
      options: {
        oldEpoch?: string;
        newEpoch?: string;
        taskId?: string;
        generation?: number;
        callId?: string;
        rawResultText?: string;
      } = {},
    ) {
      const oldEpoch = options.oldEpoch ?? 'epoch_old_1';
      const newEpoch = options.newEpoch ?? 'epoch_new_2';
      const taskId = options.taskId ?? 'mgr_prior_task';
      const generation = options.generation ?? 1;
      const callId = options.callId ?? 'call_prior_dispatch';

      const oldController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
        getManagerTaskRecord: () => ({
          taskID: taskId,
          parentSessionID: root,
          agent: 'outcome-manager',
          generation,
          state: 'running',
        }),
      });
      const beginRes = oldController.begin(root, testContract());
      if (!beginRes.success) throw new Error('begin failed');
      const checkpointId = beginRes.data.checkpoint?.checkpointId;
      if (!checkpointId) throw new Error('checkpointId missing');

      oldController.validateAndMarkDispatching(
        root,
        callId,
        dispatchInstruction(oldController, root),
      );
      const bindRes = oldController.bindManagerTask(
        root,
        callId,
        taskId,
        generation,
      );
      if (!bindRes.success) throw new Error(`bind failed: ${bindRes.error}`);

      const newController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });
      newController.readRecord(root); // recovers running checkpoint to review_uncertain

      const review = validReviewFor(newController, root, 'CONTINUE');
      const text =
        options.rawResultText ??
        `<outcome_review>\n${JSON.stringify(review, null, 2)}\n</outcome_review>`;
      const digest = canonicalDigest('omos/manager-result/v1', text);

      const reconcileUncertainRes = await newController.reconcileUncertain(
        root,
        {
          checkpointId,
          resolution: {
            kind: 'result_available',
            dispatchCallId: callId,
            managerTaskId: taskId,
            managerGeneration: generation,
            resultDigest: digest,
          },
        },
      );
      if (!reconcileUncertainRes.success) {
        throw new Error(
          `reconcileUncertain failed: ${reconcileUncertainRes.error}`,
        );
      }

      return {
        checkpointId,
        taskId,
        generation,
        callId,
        digest,
        text,
        review,
        oldEpoch,
        newEpoch,
      };
    }

    test('successful prior-epoch boardless recovery reconciles review and skips consumeManagerTask', async () => {
      const root = 'ses_boardless_success';
      const setup = await setupPriorEpochResultAvailable(root);

      let consumeCalls = 0;
      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined, // no board record
        readChildSessionResult: async (id) =>
          id === setup.taskId
            ? { text: setup.text, empty: false, terminal: true }
            : undefined,
        consumeManagerTask: () => {
          consumeCalls++;
          return true;
        },
      });

      const res = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });

      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.data.verdict).toBe('CONTINUE');
      expect(res.data.phase).toBe('active');
      expect(consumeCalls).toBe(0); // skipped consumeManagerTask!

      const record = controller.readRecord(root);
      expect(record.success).toBe(true);
      if (!record.success) return;
      expect(record.data.checkpoint?.state).toBe('review_rejected');
      expect(record.data.kickoffGate.state).toBe('authenticated');
      expect(record.data.phase).toBe('active');
      expect(record.data.reviewSummaries).toHaveLength(1);
      expect(record.data.reviewSummaries[0].resultDigest).toBe(setup.digest);
    });

    test('boardless recovery rejects omitted or mismatched caller managerGeneration', async () => {
      const root = 'ses_boardless_gen';
      const setup = await setupPriorEpochResultAvailable(root, {
        generation: 2,
      });

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: setup.text,
          empty: false,
          terminal: true,
        }),
      });

      // 1. Omitted managerGeneration
      const omittedRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
      });
      expect(omittedRes.success).toBe(false);
      expect(omittedRes.code).toBe('generation_mismatch');
      expect(omittedRes.error).toContain('Manager generation mismatch');

      // 2. Wrong managerGeneration
      const wrongRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: 99,
      });
      expect(wrongRes.success).toBe(false);
      expect(wrongRes.code).toBe('generation_mismatch');
      expect(wrongRes.error).toContain('Manager generation mismatch');
    });

    test('boardless recovery rejects bound manager task mismatch', async () => {
      const root = 'ses_boardless_task_mismatch';
      const setup = await setupPriorEpochResultAvailable(root);

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: setup.text,
          empty: false,
          terminal: true,
        }),
      });

      const mismatchRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: 'mgr_completely_different',
        managerGeneration: setup.generation,
      });
      expect(mismatchRes.success).toBe(false);
      expect(mismatchRes.code).toBe('manager_task_mismatch');
    });

    test('boardless recovery rejects changed child result digest', async () => {
      const root = 'ses_boardless_digest_mismatch';
      const setup = await setupPriorEpochResultAvailable(root);

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: `<outcome_review>\n${JSON.stringify({ ...setup.review, summary: 'Changed summary digest' }, null, 2)}\n</outcome_review>`,
          empty: false,
          terminal: true,
        }),
      });

      const res = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe('result_digest_mismatch');
    });

    test('boardless recovery enforces terminal, nonempty, and present child result', async () => {
      const root = 'ses_boardless_result_states';
      const setup = await setupPriorEpochResultAvailable(root);

      let childResult:
        | { text: string; empty: boolean; terminal: boolean }
        | undefined;

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => childResult,
      });

      // 1. Non-terminal result
      childResult = { text: setup.text, empty: false, terminal: false };
      const nonTerminalRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(nonTerminalRes.success).toBe(false);
      expect(nonTerminalRes.code).toBe('result_not_terminal');

      // 2. Empty result
      childResult = { text: '', empty: true, terminal: true };
      const emptyRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(emptyRes.success).toBe(false);
      expect(emptyRes.code).toBe('result_not_terminal');

      // 3. Missing result (reader returns undefined)
      childResult = undefined;
      const missingRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(missingRes.success).toBe(false);
      expect(missingRes.code).toBe('result_not_terminal');
    });

    test('current-epoch board loss remains untracked_manager_task', async () => {
      const root = 'ses_current_epoch_loss';
      const epoch = 'epoch_current_loss';

      let boardRecord: ManagerTaskVerification | undefined = {
        taskID: 'mgr_curr_1',
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 1,
        state: 'running',
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: epoch,
        getManagerTaskRecord: (id) =>
          id === 'mgr_curr_1' ? boardRecord : undefined,
        readChildSessionResult: async () => ({
          text: 'irrelevant',
          empty: false,
          terminal: true,
        }),
      });

      const beginRes = controller.begin(root, testContract());
      expect(beginRes.success).toBe(true);
      if (!beginRes.success) return;
      const checkpointId = beginRes.data.checkpoint?.checkpointId;
      if (!checkpointId) throw new Error('checkpointId missing');

      const nudge = controller.getPendingNudge(root);
      if (nudge?.kind !== 'dispatch') throw new Error('dispatch nudge missing');
      const rawToken = nudge.marker.claimToken;

      const dispatchRes = controller.validateAndMarkDispatching(
        root,
        'call_curr_1',
        nudge.instruction,
      );
      expect(dispatchRes.success).toBe(true);

      const bindRes = controller.bindManagerTask(
        root,
        'call_curr_1',
        'mgr_curr_1',
        1,
      );
      expect(bindRes.success).toBe(true);

      const review = validReviewFor(controller, root, 'CONTINUE');
      const text = `<outcome_review>\n${JSON.stringify(review, null, 2)}\n</outcome_review>`;
      const digest = canonicalDigest('omos/manager-result/v1', text);

      // Mutate to result_available within current epoch
      const rec = controller.readRecord(root);
      expect(rec.success).toBe(true);
      if (!rec.success) return;

      const markAvailRes = controller.store.mutate(root, rec.data.revision, {
        type: 'mark_result_available',
        checkpointId,
        claimGeneration: 1,
        claimToken: rawToken,
        resultDigest: digest,
      });
      expect(markAvailRes.success).toBe(true);

      const recordAfterAvail = controller.readRecord(root);
      expect(recordAfterAvail.success).toBe(true);
      if (!recordAfterAvail.success) return;
      expect(recordAfterAvail.data.checkpoint?.state).toBe('result_available');
      expect(recordAfterAvail.data.checkpoint?.serverEpoch).toBe(epoch);
      expect(recordAfterAvail.data.checkpoint?.dispatchCallId).toBe(
        'call_curr_1',
      );
      expect(recordAfterAvail.data.checkpoint?.managerTaskId).toBe(
        'mgr_curr_1',
      );
      expect(recordAfterAvail.data.checkpoint?.managerGeneration).toBe(1);
      expect(recordAfterAvail.data.checkpoint?.resultDigest).toBe(digest);

      // Board loss occurs in current epoch immediately before reconcileReview
      boardRecord = undefined;

      const reconcileRes = await controller.reconcileReview(root, {
        checkpointId,
        managerTaskId: 'mgr_curr_1',
        managerGeneration: 1,
      });
      expect(reconcileRes.success).toBe(false);
      expect(reconcileRes.code).toBe('untracked_manager_task');
      expect(reconcileRes.error).toContain(
        'untracked on the background job board',
      );
    });

    test('old claim with existing invalid board record follows normal checks', async () => {
      const root = 'ses_prior_with_invalid_board';
      const setup = await setupPriorEpochResultAvailable(root);

      let boardRecord: ManagerTaskVerification = {
        taskID: setup.taskId,
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: setup.generation,
        state: 'running', // invalid: not completed
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: (id) =>
          id === setup.taskId ? boardRecord : undefined,
        readChildSessionResult: async () => ({
          text: setup.text,
          empty: false,
          terminal: true,
        }),
      });

      // 1. Not completed state
      const notCompletedRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(notCompletedRes.success).toBe(false);
      expect(notCompletedRes.code).toBe('task_not_completed');

      // 2. Wrong parent session
      boardRecord = {
        taskID: setup.taskId,
        parentSessionID: 'other_session',
        agent: 'outcome-manager',
        generation: setup.generation,
        state: 'completed',
      };
      const wrongParentRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(wrongParentRes.success).toBe(false);
      expect(wrongParentRes.code).toBe('wrong_parent_session');

      // 3. Wrong agent identity
      boardRecord = {
        taskID: setup.taskId,
        parentSessionID: root,
        agent: 'coder',
        generation: setup.generation,
        state: 'completed',
      };
      const wrongAgentRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(wrongAgentRes.success).toBe(false);
      expect(wrongAgentRes.code).toBe('wrong_agent_identity');

      // 4. Board generation mismatch
      boardRecord = {
        taskID: setup.taskId,
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 99,
        state: 'completed',
      };
      const genMismatchRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(genMismatchRes.success).toBe(false);
      expect(genMismatchRes.code).toBe('generation_mismatch');
    });

    test('boardless recovery retry after persistence failure succeeds with exact result and rejects changed result', async () => {
      const root = 'ses_boardless_persist_retry';
      const setup = await setupPriorEpochResultAvailable(root);

      let failOnce = true;
      let childText = setup.text;

      const store = new OutcomeStore({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        beforePersistReconciledReview: () => {
          if (failOnce) {
            failOnce = false;
            throw new OutcomeStoreError(
              'io_error',
              'injected io_error on boardless recovery',
            );
          }
        },
      });

      let consumeCalls = 0;
      const controller = new OutcomeController({
        store,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: childText,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => {
          consumeCalls++;
          return true;
        },
      });

      const params = {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      };

      // Attempt 1: persistence failure
      const first = await controller.reconcileReview(root, params);
      expect(first).toMatchObject({ success: false, code: 'io_error' });
      expect(consumeCalls).toBe(0);

      // Attempt 2: changed result text during retry
      childText = `<outcome_review>\n${JSON.stringify({ ...setup.review, summary: 'Tampered summary' }, null, 2)}\n</outcome_review>`;
      const changed = await controller.reconcileReview(root, params);
      expect(changed).toMatchObject({
        success: false,
        code: 'result_digest_mismatch',
      });

      // Attempt 3: exact result retry succeeds
      childText = setup.text;
      const retried = await controller.reconcileReview(root, params);
      expect(retried.success).toBe(true);
      expect(consumeCalls).toBe(0);

      const record = controller.readRecord(root);
      expect(record.success && record.data.checkpoint?.state).toBe(
        'review_rejected',
      );
      expect(record.success && record.data.kickoffGate.state).toBe(
        'authenticated',
      );
      expect(record.success && record.data.phase).toBe('active');
      expect(record.success && record.data.reviewSummaries).toHaveLength(1);

      // Attempt 4: subsequent call without a board record is rejected because claim is no longer result_available
      const replay = await controller.reconcileReview(root, params);
      expect(replay.success).toBe(false);
      expect(replay.code).toBe('untracked_manager_task');
    });

    test('boardless recovery still requires verifier to be configured', async () => {
      const root = 'ses_boardless_verifier_required';
      const setup = await setupPriorEpochResultAvailable(root);

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        // getManagerTaskRecord omitted!
        readChildSessionResult: async () => ({
          text: setup.text,
          empty: false,
          terminal: true,
        }),
      });

      const res = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe('verifier_unconfigured');
    });
  });

  describe('retire_misbound_result fail-closed retirement path', () => {
    async function setupMisboundResultAvailable(
      root: string,
      options: {
        oldEpoch?: string;
        newEpoch?: string;
        taskId?: string;
        generation?: number;
        callId?: string;
        visibleText?: string;
        reasoningText?: string;
      } = {},
    ) {
      const oldEpoch = options.oldEpoch ?? 'epoch_misbound_old';
      const newEpoch = options.newEpoch ?? 'epoch_misbound_new';
      const taskId = options.taskId ?? 'mgr_misbound_task';
      const generation = options.generation ?? 1;
      const callId = options.callId ?? 'call_misbound_dispatch';

      const oldController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
        getManagerTaskRecord: () => ({
          taskID: taskId,
          parentSessionID: root,
          agent: 'outcome-manager',
          generation,
          state: 'running',
        }),
      });

      const beginRes = oldController.begin(root, testContract());
      if (!beginRes.success) throw new Error('begin failed');
      const checkpointId = beginRes.data.checkpoint?.checkpointId;
      if (!checkpointId) throw new Error('checkpointId missing');

      oldController.validateAndMarkDispatching(
        root,
        callId,
        dispatchInstruction(oldController, root),
      );
      const bindRes = oldController.bindManagerTask(
        root,
        callId,
        taskId,
        generation,
      );
      if (!bindRes.success) throw new Error(`bind failed: ${bindRes.error}`);

      const newController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
      });
      newController.readRecord(root); // recovers running to review_uncertain

      const review = validReviewFor(newController, root, 'CONTINUE');
      const visibleReviewText =
        options.visibleText ??
        `<outcome_review>\n${JSON.stringify(review, null, 2)}\n</outcome_review>`;
      const reasoningText =
        options.reasoningText ??
        '<thinking>\nInternal draft reasoning trace\n</thinking>';

      // In production: durable bound digest was computed from visible review text only
      const boundDigest = canonicalDigest(
        'omos/manager-result/v1',
        visibleReviewText,
      );

      // In production: authoritative child session reader returns reasoning plus visible review joined with \n\n
      const childReaderOutput = `${reasoningText}\n\n${visibleReviewText}`;
      const authoritativeChildDigest = canonicalDigest(
        'omos/manager-result/v1',
        childReaderOutput,
      );

      const reconcileUncertainRes = await newController.reconcileUncertain(
        root,
        {
          checkpointId,
          resolution: {
            kind: 'result_available',
            dispatchCallId: callId,
            managerTaskId: taskId,
            managerGeneration: generation,
            resultDigest: boundDigest,
          },
        },
      );
      expect(reconcileUncertainRes.success).toBe(true);
      if (!reconcileUncertainRes.success) {
        throw new Error(
          `reconcileUncertain failed: ${reconcileUncertainRes.error}`,
        );
      }

      return {
        checkpointId,
        taskId,
        generation,
        callId,
        boundDigest,
        authoritativeChildDigest,
        visibleReviewText,
        reasoningText,
        childReaderOutput,
        review,
        oldEpoch,
        newEpoch,
      };
    }

    test('live visible-text-vs-reasoning+text mismatch retirement succeeds, retains identity/digest, records no summary, and permits fresh checkpoint/contract revision', async () => {
      const root = 'ses_live_mismatch_retirement';
      const setup = await setupMisboundResultAvailable(root);

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined, // boardless
        readChildSessionResult: async (id) =>
          id === setup.taskId
            ? { text: setup.childReaderOutput, empty: false, terminal: true }
            : undefined,
      });

      // 1. reconcileReview rejects with result_digest_mismatch and never auto-retires
      const recRes = await controller.reconcileReview(root, {
        checkpointId: setup.checkpointId,
        managerTaskId: setup.taskId,
        managerGeneration: setup.generation,
      });
      expect(recRes.success).toBe(false);
      expect(recRes.code).toBe('result_digest_mismatch');
      let rec = controller.readRecord(root);
      expect(rec.success && rec.data.checkpoint?.state).toBe(
        'result_available',
      );

      // 2. Explicit retire_misbound_result succeeds
      const retireRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason:
            'Manager child session result digest mismatch with reasoning output',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(retireRes.success).toBe(true);
      if (!retireRes.success) return;

      rec = controller.readRecord(root);
      expect(rec.success).toBe(true);
      if (!rec.success) return;

      // Assert identity and digest retention
      expect(rec.data.checkpoint?.state).toBe('retired');
      expect(rec.data.checkpoint?.dispatchCallId).toBe(setup.callId);
      expect(rec.data.checkpoint?.managerTaskId).toBe(setup.taskId);
      expect(rec.data.checkpoint?.managerGeneration).toBe(setup.generation);
      expect(rec.data.checkpoint?.resultDigest).toBe(setup.boundDigest);
      expect(rec.data.checkpoint?.recoveryNote).toContain(setup.boundDigest);
      expect(rec.data.checkpoint?.recoveryNote).toContain(
        setup.authoritativeChildDigest,
      );
      expect(rec.data.checkpoint?.recoveryNote).toContain(
        'Manager child session result digest mismatch',
      );

      // Assert no review summary written
      expect(rec.data.reviewSummaries).toHaveLength(0);

      // Kickoff attempts count preserved without refund (1/2), gate remains required, phase active
      expect(rec.data.kickoffGate.attempts).toBe(1);
      expect(rec.data.kickoffGate.state).toBe('required');
      expect(rec.data.phase).toBe('active');

      // 3. Permits fresh checkpoint
      const retryKickoff = controller.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Retry kickoff after misbound retirement',
      });
      expect(retryKickoff.success).toBe(true);
      const afterRetryRec = controller.readRecord(root);
      expect(
        afterRetryRec.success && afterRetryRec.data.kickoffGate.attempts,
      ).toBe(2);

      // 4. Also permits contract revision when a checkpoint is retired
      const rootRevise = 'ses_retire_contract_revision';
      const setupRevise = await setupMisboundResultAvailable(rootRevise);
      const ctrlRevise = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setupRevise.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: `<outcome_review>\n${JSON.stringify({ ...setup.review, summary: 'Changed summary digest' }, null, 2)}\n</outcome_review>`,
          empty: false,
          terminal: true,
        }),
      });
      await ctrlRevise.reconcileUncertain(rootRevise, {
        checkpointId: setupRevise.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Retire to allow revision',
          dispatchCallId: setupRevise.callId,
          managerTaskId: setupRevise.taskId,
          managerGeneration: setupRevise.generation,
          boundResultDigest: setupRevise.boundDigest,
        },
      });
      const reviseRes = ctrlRevise.reviseContract(rootRevise, {
        contract: testContract({ constraints: ['Revised after retirement'] }),
      });
      expect(reviseRes.success).toBe(true);
    });

    test('retire_misbound_result rejects wrong/current/nonterminal/equal-digest cases', async () => {
      const root = 'ses_retire_misbound_rejections';
      const setup = await setupMisboundResultAvailable(root);

      let childResult:
        | { text: string; empty: boolean; terminal: boolean }
        | undefined = {
        text: setup.childReaderOutput,
        empty: false,
        terminal: true,
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => childResult,
      });

      // 1. Wrong dispatchCallId
      const wrongCallRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Wrong call',
          dispatchCallId: 'call_wrong_id',
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(wrongCallRes.success).toBe(false);
      expect(wrongCallRes.code).toBe('dispatch_call_mismatch');

      // 2. Wrong managerTaskId
      const wrongTaskRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Wrong task',
          dispatchCallId: setup.callId,
          managerTaskId: 'mgr_wrong_id',
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(wrongTaskRes.success).toBe(false);
      expect(wrongTaskRes.code).toBe('manager_task_mismatch');

      // 3. Wrong managerGeneration
      const wrongGenRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Wrong gen',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: 99,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(wrongGenRes.success).toBe(false);
      expect(wrongGenRes.code).toBe('generation_mismatch');

      // 4. Wrong boundResultDigest
      const wrongBoundRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Wrong bound',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: hash(
            'other_digest_value_for_testing_purposes_only',
          ),
        },
      });
      expect(wrongBoundRes.success).toBe(false);
      expect(wrongBoundRes.code).toBe('bound_digest_mismatch');

      // 5. Current-epoch claim rejection
      const rootCurr = 'ses_retire_curr_epoch';
      const currEpoch = 'epoch_curr_only';
      const currController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: currEpoch,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_curr',
          parentSessionID: rootCurr,
          agent: 'outcome-manager',
          generation: 1,
          state: 'running',
        }),
        readChildSessionResult: async () => ({
          text: setup.visibleText,
          empty: false,
          terminal: true,
        }),
      });
      const beg = currController.begin(rootCurr, testContract());
      expect(beg.success).toBe(true);
      const nudge = currController.getPendingNudge(rootCurr);
      if (nudge?.kind !== 'dispatch') throw new Error('dispatch nudge missing');
      const markDisp = currController.validateAndMarkDispatching(
        rootCurr,
        'call_c',
        nudge.instruction,
      );
      expect(markDisp.success).toBe(true);
      const bindRes = currController.bindManagerTask(
        rootCurr,
        'call_c',
        'mgr_curr',
        1,
      );
      expect(bindRes.success).toBe(true);
      const curRec = currController.readRecord(rootCurr);
      expect(curRec.success).toBe(true);
      if (!curRec.success) return;
      const mutateRes = currController.store.mutate(
        rootCurr,
        curRec.data.revision,
        {
          type: 'mark_result_available',
          checkpointId: beg.data.checkpoint.checkpointId,
          claimGeneration: 1,
          claimToken: nudge.marker.claimToken,
          resultDigest: setup.boundDigest,
        },
      );
      expect(mutateRes.success).toBe(true);
      const currRej = await currController.reconcileUncertain(rootCurr, {
        checkpointId: beg.data.checkpoint.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Current epoch retire attempt',
          dispatchCallId: 'call_c',
          managerTaskId: 'mgr_curr',
          managerGeneration: 1,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(currRej.success).toBe(false);
      expect(currRej.code).toBe('current_epoch_retirement_forbidden');

      // 6. Non-terminal child output
      childResult = { text: setup.visibleText, empty: false, terminal: false };
      const nonTermRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Non-terminal test',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(nonTermRes.success).toBe(false);
      expect(nonTermRes.code).toBe('result_not_terminal');

      // 7. Empty child output
      childResult = { text: '', empty: true, terminal: true };
      const emptyRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Empty test',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(emptyRes.success).toBe(false);
      expect(emptyRes.code).toBe('result_not_terminal');

      // 8. Equal digest (authoritative matches bound)
      childResult = {
        text: setup.visibleReviewText,
        empty: false,
        terminal: true,
      };
      const equalRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Equal digest test',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(equalRes.success).toBe(false);
      expect(equalRes.code).toBe('result_digest_matches');

      // 9. Oversized reason (> 512 characters) rejection with unchanged claim / no retirement
      const oversizedRes = await controller.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'a'.repeat(513),
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(oversizedRes.success).toBe(false);
      expect(oversizedRes.code).toBe('invalid_parameter');
      const recUnchanged = controller.readRecord(root);
      expect(recUnchanged.success && recUnchanged.data.checkpoint?.state).toBe(
        'result_available',
      );
      expect(
        recUnchanged.success && recUnchanged.data.checkpoint?.recoveryNote,
      ).not.toContain('Misbound result retired');
    });

    test('boardless verifier+reader requirements and no consumption in retire_misbound_result', async () => {
      const root = 'ses_retire_boardless_reqs';
      const setup = await setupMisboundResultAvailable(root);

      // 1. Verifier missing
      const noVerifier = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        readChildSessionResult: async () => ({
          text: setup.visibleText,
          empty: false,
          terminal: true,
        }),
      });
      const noVerRes = await noVerifier.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'No verifier',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(noVerRes.success).toBe(false);
      expect(noVerRes.code).toBe('verifier_unconfigured');

      // 2. Reader missing
      const noReader = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
      });
      const noReadRes = await noReader.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'No reader',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(noReadRes.success).toBe(false);
      expect(noReadRes.code).toBe('reader_unconfigured');

      // 3. Boardless with verifier and reader configured: consumeManagerTask is skipped
      let consumeCalls = 0;
      const boardlessCtrl = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: setup.childReaderOutput,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => {
          consumeCalls++;
          return true;
        },
      });
      const successRes = await boardlessCtrl.reconcileUncertain(root, {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Boardless retire',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });
      expect(successRes.success).toBe(true);
      expect(consumeCalls).toBe(0);
    });

    test('existing invalid board checks in retire_misbound_result', async () => {
      const root = 'ses_retire_invalid_board';
      const setup = await setupMisboundResultAvailable(root);

      let boardRecord: ManagerTaskVerification = {
        taskID: setup.taskId,
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: setup.generation,
        state: 'running', // invalid: not completed
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => boardRecord,
        readChildSessionResult: async () => ({
          text: setup.visibleText,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => true,
      });

      const makeParams = () => ({
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result' as const,
          reason: 'Board check test',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      });

      // 1. Task not completed
      const notCompleted = await controller.reconcileUncertain(
        root,
        makeParams(),
      );
      expect(notCompleted.success).toBe(false);
      expect(notCompleted.code).toBe('task_not_completed');

      // 2. Wrong parent session
      boardRecord = {
        taskID: setup.taskId,
        parentSessionID: 'other_parent',
        agent: 'outcome-manager',
        generation: setup.generation,
        state: 'completed',
      };
      const wrongParent = await controller.reconcileUncertain(
        root,
        makeParams(),
      );
      expect(wrongParent.success).toBe(false);
      expect(wrongParent.code).toBe('wrong_parent_session');

      // 3. Wrong agent identity
      boardRecord = {
        taskID: setup.taskId,
        parentSessionID: root,
        agent: 'other-agent',
        generation: setup.generation,
        state: 'completed',
      };
      const wrongAgent = await controller.reconcileUncertain(
        root,
        makeParams(),
      );
      expect(wrongAgent.success).toBe(false);
      expect(wrongAgent.code).toBe('wrong_agent_identity');

      // 4. Generation mismatch on board
      boardRecord = {
        taskID: setup.taskId,
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: 99,
        state: 'completed',
      };
      const genMismatch = await controller.reconcileUncertain(
        root,
        makeParams(),
      );
      expect(genMismatch.success).toBe(false);
      expect(genMismatch.code).toBe('generation_mismatch');

      // 5. Board taskID mismatch
      boardRecord = {
        taskID: 'mgr_different_task_id',
        parentSessionID: root,
        agent: 'outcome-manager',
        generation: setup.generation,
        state: 'completed',
      };
      const wrongTaskId = await controller.reconcileUncertain(
        root,
        makeParams(),
      );
      expect(wrongTaskId.success).toBe(false);
      expect(wrongTaskId.code).toBe('manager_task_mismatch');
      expect(wrongTaskId.error).toContain('does not match requested task ID');
    });

    test('valid-board consumption and persistence retry in retire_misbound_result', async () => {
      const root = 'ses_retire_valid_board_retry';
      const setup = await setupMisboundResultAvailable(root);

      let failOnce = true;
      let consumeCalls = 0;
      let childText = setup.childReaderOutput;

      const store = new OutcomeStore({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
      });
      const originalMutate = store.mutate.bind(store);
      store.mutate = ((session, rev, mutation) => {
        if (mutation.type === 'retire_misbound_recovered_result' && failOnce) {
          failOnce = false;
          return {
            success: false,
            code: 'io_error',
            error: new OutcomeStoreError(
              'io_error',
              'injected io_error during retirement',
            ),
          };
        }
        return originalMutate(session, rev, mutation);
      }) as typeof store.mutate;

      const controller = new OutcomeController({
        store,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => ({
          taskID: setup.taskId,
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: setup.generation,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: childText,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => {
          consumeCalls++;
          return true;
        },
      });

      const params = {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result' as const,
          reason: 'Testing valid-board consumption and persistence retry',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      };

      // Attempt 1: fails on persistence
      const first = await controller.reconcileUncertain(root, params);
      expect(first.success).toBe(false);
      expect(first.code).toBe('io_error');
      expect(consumeCalls).toBe(1);

      // Attempt 2: changed child text during retry
      childText = `different_reasoning\n\n${setup.visibleReviewText}`;
      const changed = await controller.reconcileUncertain(root, params);
      expect(changed).toMatchObject({
        success: false,
        code: 'consumed_result_mismatch',
      });

      // Attempt 3: exact child text retry succeeds
      childText = setup.childReaderOutput;
      const retried = await controller.reconcileUncertain(root, params);
      expect(retried.success).toBe(true);
      expect(consumeCalls).toBe(2);

      const record = controller.readRecord(root);
      expect(record.success && record.data.checkpoint?.state).toBe('retired');
    });

    test('kickoff attempts and exhaustion bookkeeping are preserved without refund across multiple retirements', async () => {
      const root = 'ses_retire_kickoff_exhaustion';

      // 1. Kickoff attempt 1 misbound retirement
      const setup1 = await setupMisboundResultAvailable(root);
      const controller1 = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup1.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: setup1.childReaderOutput,
          empty: false,
          terminal: true,
        }),
      });
      const res1 = await controller1.reconcileUncertain(root, {
        checkpointId: setup1.checkpointId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Attempt 1 misbound',
          dispatchCallId: setup1.callId,
          managerTaskId: setup1.taskId,
          managerGeneration: setup1.generation,
          boundResultDigest: setup1.boundDigest,
        },
      });
      expect(res1.success).toBe(true);
      const rec1 = controller1.readRecord(root);
      expect(rec1.success).toBe(true);
      if (!rec1.success) return;
      expect(rec1.data.kickoffGate.attempts).toBe(1);
      expect(rec1.data.kickoffGate.state).toBe('required');
      expect(rec1.data.phase).toBe('active');

      // 2. Open kickoff attempt 2
      const retryKickoff = controller1.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Kickoff attempt 2',
      });
      expect(retryKickoff.success).toBe(true);
      if (!retryKickoff.success) return;
      const cp2Id = retryKickoff.data.checkpointId;

      const nudge = controller1.getPendingNudge(root);
      if (nudge?.kind !== 'dispatch') throw new Error('dispatch nudge missing');
      const markDisp2 = controller1.validateAndMarkDispatching(
        root,
        'call_k2',
        nudge.instruction,
      );
      expect(markDisp2.success).toBe(true);

      // Advance attempt 2 to result_available in epoch_retry_run
      const epochRetryRun = 'epoch_retry_run';
      const ctrlRetryRun = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: epochRetryRun,
        getManagerTaskRecord: () => ({
          taskID: 'mgr_k2',
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'running',
        }),
      });
      const recRun = ctrlRetryRun.readRecord(root);
      expect(recRun.success).toBe(true);
      if (!recRun.success) return;

      const recUncertainRes = await ctrlRetryRun.reconcileUncertain(root, {
        checkpointId: cp2Id,
        resolution: {
          kind: 'result_available',
          dispatchCallId: 'call_k2',
          managerTaskId: 'mgr_k2',
          managerGeneration: 1,
          resultDigest: setup1.boundDigest,
        },
      });
      expect(recUncertainRes.success).toBe(true);

      const recAvail = ctrlRetryRun.readRecord(root);
      expect(recAvail.success).toBe(true);
      if (!recAvail.success) return;
      expect(recAvail.data.checkpoint?.state).toBe('result_available');

      // Restart to epochK2New (so claim is prior-epoch)
      const epochK2New = 'epoch_k2_new';
      const ctrlK2New = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: epochK2New,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: setup1.childReaderOutput,
          empty: false,
          terminal: true,
        }),
      });
      const recNew = ctrlK2New.readRecord(root);
      expect(recNew.success).toBe(true);
      if (!recNew.success) return;
      expect(recNew.data.checkpoint?.state).toBe('result_available');
      expect(recNew.data.checkpoint?.serverEpoch).toBe(setup1.newEpoch);

      // Now retire attempt 2: should exhaust kickoff gate (2/2)
      const res2 = await ctrlK2New.reconcileUncertain(root, {
        checkpointId: cp2Id,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Attempt 2 misbound',
          dispatchCallId: 'call_k2',
          managerTaskId: 'mgr_k2',
          managerGeneration: 1,
          boundResultDigest: setup1.boundDigest,
        },
      });
      expect(res2.success).toBe(true);

      const recFinal = ctrlK2New.readRecord(root);
      expect(recFinal.success).toBe(true);
      if (!recFinal.success) return;
      expect(recFinal.data.kickoffGate.attempts).toBe(2);
      expect(recFinal.data.kickoffGate.state).toBe('exhausted');
      expect(recFinal.data.phase).toBe('failed');

      // Attempt 3 kickoff is rejected with kickoff_retry_exhausted
      const attempt3 = ctrlK2New.checkpoint(root, {
        kind: 'kickoff',
        reason: 'Attempt 3 should be rejected',
      });
      expect(attempt3.success).toBe(false);
      expect(attempt3.code).toBe('kickoff_retry_exhausted');
    });

    test('post-rename directory-fsync failure returns durability_uncertain, leaves durable state retired, and allows exact idempotent retry', async () => {
      const root = 'ses_durability_uncertain_retry';
      const setup = await setupMisboundResultAvailable(root);

      let failNextDirectoryFsync = false;
      let consumeCalls = 0;
      let childText = setup.childReaderOutput;

      const store = new OutcomeStore({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        filesystem: {
          renameSync: (oldPath, newPath) => {
            fs.renameSync(oldPath, newPath);
            if (typeof newPath === 'string' && newPath.endsWith('.json')) {
              failNextDirectoryFsync = true;
            }
          },
          fsyncSync: (descriptor) => {
            if (
              failNextDirectoryFsync &&
              fs.fstatSync(descriptor).isDirectory()
            ) {
              failNextDirectoryFsync = false;
              throw new Error(
                'injected directory fsync failure after record rename',
              );
            }
            fs.fsyncSync(descriptor);
          },
        },
      });

      const controller = new OutcomeController({
        store,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => ({
          taskID: setup.taskId,
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: setup.generation,
          state: 'completed',
        }),
        readChildSessionResult: async () => ({
          text: childText,
          empty: false,
          terminal: true,
        }),
        consumeManagerTask: () => {
          consumeCalls++;
          return true;
        },
      });

      const exactParams = {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result' as const,
          reason: 'Testing durability uncertainty retry semantics',
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      };

      // Attempt 1: fails after rename during directory fsync with durability_uncertain
      const firstRes = await controller.reconcileUncertain(root, exactParams);
      expect(firstRes.success).toBe(false);
      expect(firstRes.code).toBe('durability_uncertain');
      expect(consumeCalls).toBe(1);

      // Durable state is already retired on disk
      const recAfterFirst = controller.readRecord(root);
      expect(recAfterFirst.success).toBe(true);
      if (!recAfterFirst.success) return;
      expect(recAfterFirst.data.checkpoint?.state).toBe('retired');

      // Attempt 2: changed reason fails
      const changedReasonRes = await controller.reconcileUncertain(root, {
        ...exactParams,
        resolution: {
          ...exactParams.resolution,
          reason: 'Changed reason should be rejected',
        },
      });
      expect(changedReasonRes.success).toBe(false);

      // Attempt 3: changed child result fails
      childText = `different_reasoning\n\n${setup.visibleReviewText}`;
      const changedResultRes = await controller.reconcileUncertain(
        root,
        exactParams,
      );
      expect(changedResultRes.success).toBe(false);

      // Attempt 4: changed identity fails
      childText = setup.childReaderOutput;
      const changedIdRes = await controller.reconcileUncertain(root, {
        ...exactParams,
        resolution: {
          ...exactParams.resolution,
          dispatchCallId: 'call_different_id',
        },
      });
      expect(changedIdRes.success).toBe(false);

      // Attempt 5: exact retry succeeds idempotently
      const retryRes = await controller.reconcileUncertain(root, exactParams);
      expect(retryRes.success).toBe(true);
      if (!retryRes.success) return;
      expect(retryRes.data.checkpoint?.state).toBe('retired');

      // Assert no duplicate summary or attempt refund occurred
      const finalRec = controller.readRecord(root);
      expect(finalRec.success).toBe(true);
      if (!finalRec.success) return;
      expect(finalRec.data.reviewSummaries).toHaveLength(0);
      expect(finalRec.data.kickoffGate.attempts).toBe(1);
    });

    test('successful 512-character reason retains both full digests in durable state and exact retry recognition remains possible', async () => {
      const root = 'ses_retire_512_char_reason';
      const setup = await setupMisboundResultAvailable(root);

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: setup.childReaderOutput,
          empty: false,
          terminal: true,
        }),
      });

      const maxReason = 'R'.repeat(512);
      const expectedReasonDigest = canonicalDigest(
        'omos/misbound-retirement-reason/v1',
        maxReason,
      );
      const params512 = {
        checkpointId: setup.checkpointId,
        resolution: {
          kind: 'retire_misbound_result' as const,
          reason: maxReason,
          dispatchCallId: setup.callId,
          managerTaskId: setup.taskId,
          managerGeneration: setup.generation,
          boundResultDigest: setup.boundDigest,
        },
      };

      // Retirement succeeds with 512-character reason
      const retireRes = await controller.reconcileUncertain(root, params512);
      expect(retireRes.success).toBe(true);

      // Durable state contains retired claim and both full digests plus expected full normalized reason digest
      const rec = controller.readRecord(root);
      expect(rec.success).toBe(true);
      if (!rec.success) return;
      expect(rec.data.checkpoint?.state).toBe('retired');
      expect(rec.data.checkpoint?.recoveryNote).toContain(setup.boundDigest);
      expect(rec.data.checkpoint?.recoveryNote).toContain(
        setup.authoritativeChildDigest,
      );
      expect(rec.data.checkpoint?.recoveryNote).toContain(expectedReasonDigest);
      expect(rec.data.checkpoint?.recoveryNote?.length).toBeLessThanOrEqual(
        512,
      );

      // Exact retry recognition remains possible
      const exactRetryRes = await controller.reconcileUncertain(
        root,
        params512,
      );
      expect(exactRetryRes.success).toBe(true);

      // Whitespace-normalized exact retry succeeds
      const whitespaceRetryRes = await controller.reconcileUncertain(root, {
        ...params512,
        resolution: {
          ...params512.resolution,
          reason: `   ${maxReason}   `,
        },
      });
      expect(whitespaceRetryRes.success).toBe(true);

      // A 512-character reason differing ONLY in the final character fails exact retry
      const lastCharDiffReason = `${'R'.repeat(511)}S`;
      const changedRetryRes = await controller.reconcileUncertain(root, {
        ...params512,
        resolution: {
          ...params512.resolution,
          reason: lastCharDiffReason,
        },
      });
      expect(changedRetryRes.success).toBe(false);
    });
  });

  describe('supersede_external_handoff dedicated stale handoff supersession', () => {
    async function setupSupersessionFixture(
      root: string,
      options: {
        oldEpoch?: string;
        newEpoch?: string;
        finalTaskId?: string;
        callId?: string;
      } = {},
    ) {
      const oldEpoch = options.oldEpoch ?? 'epoch_super_old';
      const newEpoch = options.newEpoch ?? 'epoch_super_new';
      const finalTaskId = options.finalTaskId ?? 'mgr_final_task';
      const callId = options.callId ?? 'call_final_disp';

      const oldController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: oldEpoch,
        getManagerTaskRecord: (id) => ({
          taskID: id,
          parentSessionID: root,
          agent: 'outcome-manager',
          generation: 1,
          state: 'running',
        }),
      });

      // 1. Kickoff
      const beg = oldController.begin(root, testContract());
      expect(beg.success).toBe(true);
      if (!beg.success) throw new Error('begin failed');
      const kCpId = beg.data.checkpoint?.checkpointId;
      if (!kCpId) throw new Error('kCpId missing');
      const kNudge = oldController.getPendingNudge(root);
      if (kNudge?.kind !== 'dispatch')
        throw new Error('dispatch nudge missing');
      expect(
        oldController.validateAndMarkDispatching(
          root,
          'call_k',
          kNudge.instruction,
        ).success,
      ).toBe(true);
      expect(
        oldController.bindManagerTask(root, 'call_k', 'mgr_k', 1).success,
      ).toBe(true);
      const kReview = validReviewFor(oldController, root, 'CONTINUE');
      const kText = `<outcome_review>\n${JSON.stringify(kReview, null, 2)}\n</outcome_review>`;
      const kDigest = canonicalDigest('omos/manager-result/v1', kText);
      const rec1 = oldController.readRecord(root);
      expect(rec1.success).toBe(true);
      if (!rec1.success) throw new Error('rec1 missing');
      expect(
        oldController.store.mutate(root, rec1.data.revision, {
          type: 'mark_result_available',
          checkpointId: kCpId,
          claimGeneration: 1,
          claimToken: kNudge.marker.claimToken,
          resultDigest: kDigest,
        }).success,
      ).toBe(true);
      const kOldController = new OutcomeController({
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
      const kRec = await kOldController.reconcileReview(root, {
        checkpointId: kCpId,
        managerTaskId: 'mgr_k',
        managerGeneration: 1,
      });
      expect(kRec.success).toBe(true);

      // 2. Open final checkpoint
      const finalFingerprint = hash('final_candidate_orig');
      const finalCp = kOldController.checkpoint(root, {
        kind: 'final',
        reason: 'Final review',
        candidateFingerprint: finalFingerprint,
      });
      expect(finalCp.success).toBe(true);
      if (!finalCp.success) throw new Error('finalCp failed');
      const finalCpId = finalCp.data.checkpointId;
      const finalClaimGeneration = finalCp.data.claimGeneration;
      const finalNudge = kOldController.getPendingNudge(root);
      if (finalNudge?.kind !== 'dispatch')
        throw new Error('finalNudge missing');
      expect(
        kOldController.validateAndMarkDispatching(
          root,
          callId,
          finalNudge.instruction,
        ).success,
      ).toBe(true);
      expect(
        kOldController.bindManagerTask(root, callId, finalTaskId, 1).success,
      ).toBe(true);

      // 3. Set external handoff wait
      const postRestartCheck = `Confirm ${finalCpId} completed after restart`;
      const handoffRes = kOldController.externalHandoff(root, {
        kind: 'restart_current_opencode',
        reason: 'Restarting CLI',
        expectedPostRestartCheck: postRestartCheck,
      });
      expect(handoffRes.success).toBe(true);

      // 5. Reconcile final checkpoint to result_available with misbound digest
      const reviewObj = validReviewFor(oldController, root, 'CONTINUE');
      const visibleReviewText = `<outcome_review>\n${JSON.stringify(reviewObj, null, 2)}\n</outcome_review>`;
      const reasoningText =
        '<thinking>\nInternal draft reasoning trace\n</thinking>';
      const boundDigest = canonicalDigest(
        'omos/manager-result/v1',
        visibleReviewText,
      );
      const childReaderOutput = `${reasoningText}\n\n${visibleReviewText}`;
      const authoritativeChildDigest = canonicalDigest(
        'omos/manager-result/v1',
        childReaderOutput,
      );

      // 4. Process restart to newEpoch
      const newController = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: childReaderOutput,
          empty: false,
          terminal: true,
        }),
      });
      const recAfterRestart = newController.readRecord(root);
      expect(recAfterRestart.success).toBe(true);
      if (!recAfterRestart.success) throw new Error('recAfterRestart missing');
      const wait = recAfterRestart.data.waitCondition;
      if (!wait) throw new Error('wait missing');
      expect(wait.restartObservedRevision).toBeDefined();

      const rAvailRes = await newController.reconcileUncertain(root, {
        checkpointId: finalCpId,
        resolution: {
          kind: 'result_available',
          dispatchCallId: callId,
          managerTaskId: finalTaskId,
          managerGeneration: 1,
          resultDigest: boundDigest,
        },
      });
      expect(rAvailRes.success).toBe(true);

      // 6. Retire misbound result
      const retireRes = await newController.reconcileUncertain(root, {
        checkpointId: finalCpId,
        resolution: {
          kind: 'retire_misbound_result',
          reason: 'Retiring misbound final checkpoint',
          dispatchCallId: callId,
          managerTaskId: finalTaskId,
          managerGeneration: 1,
          boundResultDigest: boundDigest,
        },
      });
      expect(retireRes.success).toBe(true);

      // 7. Observe user turn with provenance external_user
      const userRes = newController.observeExternalUserTurn(
        root,
        'msg_post_restart_user',
        'Resume work with replacement plan',
      );
      expect(userRes.success).toBe(true);
      if (!userRes.success) throw new Error('user turn failed');
      const sourceUserMessageReceiptId = userRes.data.receiptId;

      // 8. Submit fresh passed replacement evidence
      const replacementCandidate = hash('replacement_candidate_fingerprint');
      const evRes = newController.submitEvidence(root, {
        description: postRestartCheck,
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: replacementCandidate,
      });
      expect(evRes.success).toBe(true);
      if (!evRes.success) throw new Error('evidence submission failed');
      const evidenceAttestationId = evRes.data.attestationId;

      if (
        !wait.originatingServerEpoch ||
        wait.restartObservedRevision === undefined
      ) {
        throw new Error('wait origin or restart observation missing');
      }
      const waitOriginatingServerEpoch = wait.originatingServerEpoch;
      const waitRestartObservedRevision = wait.restartObservedRevision;

      return {
        oldController,
        newController,
        checkpointId: finalCpId,
        retiredClaimGeneration: finalClaimGeneration,
        finalTaskId,
        callId,
        boundDigest,
        authoritativeChildDigest,
        childReaderOutput,
        visibleReviewText,
        wait,
        waitOriginatingServerEpoch,
        waitRestartObservedRevision,
        postRestartCheck,
        sourceUserMessageReceiptId,
        evidenceAttestationId,
        replacementCandidate,
        oldEpoch,
        newEpoch,
      };
    }

    test('full positive live regression through handoff, restart, retirement, evidence, supersession, and unblocking', async () => {
      const root = 'ses_super_positive_live';
      const setup = await setupSupersessionFixture(root);

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async (id) =>
          id === setup.finalTaskId
            ? { text: setup.childReaderOutput, empty: false, terminal: true }
            : undefined,
      });

      const params = {
        reason: 'Superseding stale external handoff after retirement',
        waitReferenceId: setup.wait.referenceId,
        waitCreatedRevision: setup.wait.createdRevision,
        waitOriginatingServerEpoch: setup.waitOriginatingServerEpoch,
        waitRestartObservedRevision: setup.waitRestartObservedRevision,
        expectedPostRestartCheck: setup.postRestartCheck,
        retiredCheckpointId: setup.checkpointId,
        retiredClaimGeneration: setup.retiredClaimGeneration,
        sourceUserMessageReceiptId: setup.sourceUserMessageReceiptId,
        evidenceAttestationId: setup.evidenceAttestationId,
        replacementCandidateFingerprint: setup.replacementCandidate,
      };

      const res = await controller.supersedeExternalHandoff(root, params);
      expect(res.success).toBe(true);
      if (!res.success) return;

      const record = controller.readRecord(root);
      expect(record.success).toBe(true);
      if (!record.success) return;

      // Assert wait is cleared
      expect(record.data.waitCondition).toBeUndefined();

      // Assert retired checkpoint is preserved unchanged
      expect(record.data.checkpoint?.state).toBe('retired');
      expect(record.data.checkpoint?.resultDigest).toBe(setup.boundDigest);

      // Assert audit receipt is exact
      expect(record.data.receipts.handoffSupersessions).toHaveLength(1);
      const receipt = record.data.receipts.handoffSupersessions[0];
      expect(receipt.waitReferenceId).toBe(setup.wait.referenceId);
      expect(receipt.payloadDigest).toBe(
        computeOutcomeHandoffSupersessionDigest(receipt),
      );

      // Assert phase is active
      expect(record.data.phase).toBe('active');

      // Assert fresh checkpoint and contract revision are now possible
      const freshCpRes = controller.checkpoint(root, {
        kind: 'decision',
        reason: 'Fresh decision checkpoint after handoff supersession',
      });
      expect(freshCpRes.success).toBe(true);
    });

    test('fail-closed rejections for tuple mismatches, epoch, candidate, and child output', async () => {
      const root = 'ses_super_fail_closed';
      const setup = await setupSupersessionFixture(root);

      let childResult:
        | { text: string; empty: boolean; terminal: boolean }
        | undefined = {
        text: setup.childReaderOutput,
        empty: false,
        terminal: true,
      };

      const controller = new OutcomeController({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => childResult,
      });

      const baseParams = () => ({
        reason: 'Superseding stale handoff',
        waitReferenceId: setup.wait.referenceId,
        waitCreatedRevision: setup.wait.createdRevision,
        waitOriginatingServerEpoch: setup.waitOriginatingServerEpoch,
        waitRestartObservedRevision: setup.waitRestartObservedRevision,
        expectedPostRestartCheck: setup.postRestartCheck,
        retiredCheckpointId: setup.checkpointId,
        retiredClaimGeneration: setup.retiredClaimGeneration,
        sourceUserMessageReceiptId: setup.sourceUserMessageReceiptId,
        evidenceAttestationId: setup.evidenceAttestationId,
        replacementCandidateFingerprint: setup.replacementCandidate,
      });

      // 1. Wait reference mismatch
      const r1 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        waitReferenceId: 'wrong_ref',
      });
      expect(r1.success).toBe(false);
      expect(r1.code).toBe('wait_reference_mismatch');

      // 2. Wait created revision mismatch
      const r2 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        waitCreatedRevision: setup.wait.createdRevision - 1,
      });
      expect(r2.success).toBe(false);
      expect(r2.code).toBe('wait_revision_mismatch');

      // 3. Wait originating epoch mismatch
      const r3 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        waitOriginatingServerEpoch: 'wrong_epoch',
      });
      expect(r3.success).toBe(false);
      expect(r3.code).toBe('wait_epoch_mismatch');

      // 4. Expected check missing checkpoint ID
      const r4 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        expectedPostRestartCheck: 'Confirm something else completed',
      });
      expect(r4.success).toBe(false);
      expect(r4.code).toBe('expected_check_mismatch');

      // 5. Retired checkpoint ID mismatch
      const r5 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        retiredCheckpointId: 'wrong_chk_id',
      });
      expect(r5.success).toBe(false);
      expect(r5.code).toBe('checkpoint_not_in_expected_check');

      // 6. Replacement candidate fingerprint mismatch
      const r6 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        replacementCandidateFingerprint: hash(
          'different_candidate_fingerprint',
        ),
      });
      expect(r6.success).toBe(false);
      expect(r6.code).toBe('invalid_evidence_provenance');

      // 7. Child result digest mismatch with audit observed digest
      childResult = {
        text: 'different text entirely',
        empty: false,
        terminal: true,
      };
      const r7 = await controller.supersedeExternalHandoff(root, baseParams());
      expect(r7.success).toBe(false);
      expect(r7.code).toBe('authoritative_digest_mismatch');

      // 8. Child result nonterminal
      childResult = {
        text: setup.childReaderOutput,
        empty: false,
        terminal: false,
      };
      const r8 = await controller.supersedeExternalHandoff(root, baseParams());
      expect(r8.success).toBe(false);
      expect(r8.code).toBe('result_not_terminal');

      // 9. Oversized reason (> 512 characters)
      childResult = {
        text: setup.childReaderOutput,
        empty: false,
        terminal: true,
      };
      const r9 = await controller.supersedeExternalHandoff(root, {
        ...baseParams(),
        reason: 'O'.repeat(513),
      });
      expect(r9.success).toBe(false);
      expect(r9.code).toBe('invalid_parameter');
    });

    test('post-rename directory-fsync durability_uncertain allows exact retry and rejects changed fields', async () => {
      const root = 'ses_super_durability_uncertain';
      const setup = await setupSupersessionFixture(root);

      let failNextDirectoryFsync = false;
      const childText = setup.childReaderOutput;

      const store = new OutcomeStore({
        storeDirectory: tempDir,
        serverEpoch: setup.newEpoch,
        filesystem: {
          renameSync: (oldPath, newPath) => {
            fs.renameSync(oldPath, newPath);
            if (typeof newPath === 'string' && newPath.endsWith('.json')) {
              failNextDirectoryFsync = true;
            }
          },
          fsyncSync: (descriptor) => {
            if (
              failNextDirectoryFsync &&
              fs.fstatSync(descriptor).isDirectory()
            ) {
              failNextDirectoryFsync = false;
              throw new Error(
                'injected directory fsync failure after supersession rename',
              );
            }
            fs.fsyncSync(descriptor);
          },
        },
      });

      const controller = new OutcomeController({
        store,
        serverEpoch: setup.newEpoch,
        getManagerTaskRecord: () => undefined,
        readChildSessionResult: async () => ({
          text: childText,
          empty: false,
          terminal: true,
        }),
      });

      const params = {
        reason: 'Superseding stale external handoff with durability test',
        waitReferenceId: setup.wait.referenceId,
        waitCreatedRevision: setup.wait.createdRevision,
        waitOriginatingServerEpoch: setup.waitOriginatingServerEpoch,
        waitRestartObservedRevision: setup.waitRestartObservedRevision,
        expectedPostRestartCheck: setup.postRestartCheck,
        retiredCheckpointId: setup.checkpointId,
        retiredClaimGeneration: setup.retiredClaimGeneration,
        sourceUserMessageReceiptId: setup.sourceUserMessageReceiptId,
        evidenceAttestationId: setup.evidenceAttestationId,
        replacementCandidateFingerprint: setup.replacementCandidate,
      };

      // 1. First attempt fails with durability_uncertain after rename
      const first = await controller.supersedeExternalHandoff(root, params);
      expect(first.success).toBe(false);
      expect(first.code).toBe('durability_uncertain');

      // Durable state on disk has already cleared waitCondition and written receipt
      const recOnDisk = controller.readRecord(root);
      expect(recOnDisk.success).toBe(true);
      if (!recOnDisk.success) return;
      expect(recOnDisk.data.waitCondition).toBeUndefined();
      expect(recOnDisk.data.receipts.handoffSupersessions).toHaveLength(1);

      // 2. Exact retry succeeds idempotently
      const retry = await controller.supersedeExternalHandoff(root, params);
      expect(retry.success).toBe(true);

      // No duplicate audit receipt written
      const recAfterRetry = controller.readRecord(root);
      expect(recAfterRetry.success).toBe(true);
      if (!recAfterRetry.success) return;
      expect(recAfterRetry.data.receipts.handoffSupersessions).toHaveLength(1);

      // 3. Changed reason on retry fails
      const changedReason = await controller.supersedeExternalHandoff(root, {
        ...params,
        reason: 'Changed reason on retry',
      });
      expect(changedReason.success).toBe(false);

      // 4. Changed replacement candidate on retry fails
      const changedCandidate = await controller.supersedeExternalHandoff(root, {
        ...params,
        replacementCandidateFingerprint: hash('other_candidate_retry'),
      });
      expect(changedCandidate.success).toBe(false);
    });
  });
});
