import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatOutcomeDispatchMarker,
  type ManagerTaskVerification,
  OutcomeController,
} from './controller';
import {
  canonicalDigest,
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

  test('prior-epoch stale claim requires explicit provenance before a new checkpoint', () => {
    const root = 'ses_stale_action_resolution';
    const old = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_old',
    });
    old.begin(root, testContract());
    const current = new OutcomeController({
      storeDirectory: tempDir,
      serverEpoch: 'epoch_new',
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
    expect(
      current.resolveAction(root, {
        actionId: action.id,
        reason: 'User confirmed the abandoned prior-epoch claim',
        sourceUserMessageReceiptId: receipt.id,
      }).success,
    ).toBe(true);
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
});
