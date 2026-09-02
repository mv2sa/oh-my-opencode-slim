import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalDigest,
  computeOutcomeContractDigest,
  MAX_OUTCOME_RECORD_BYTES,
  type OutcomeContract,
  type OutcomeRecord,
  OutcomeRecordSchema,
  serializeOutcomeRecord,
} from './controller-schema';
import type { OutcomeReview } from './schema';
import { OutcomeStore, type OutcomeStoreResult } from './store';

const hash = (value: string) => canonicalDigest('test/v1', value);

function contract(overrides: Partial<OutcomeContract> = {}): OutcomeContract {
  return {
    classification: 'non_trivial',
    objective: 'Ship an explicit durable outcome-control protocol',
    deliverables: ['Durable outcome record', 'Authenticated acceptance'],
    goals: [
      {
        id: 'goal_protocol',
        description: 'Implement the outcome protocol',
        status: 'in_progress',
      },
    ],
    inScope: ['src/outcome'],
    outOfScope: ['Automatic process restart'],
    constraints: ['Do not infer semantic checkpoints'],
    safetyBoundaries: ['Do not claim attestations are machine verified'],
    handoffRequirements: ['Provide verification steps'],
    sourceMessageIds: ['msg_root'],
    rules: [],
    exceptions: [],
    ...overrides,
  };
}

function expectSuccess<T>(
  result: OutcomeStoreResult<T>,
): asserts result is Extract<OutcomeStoreResult<T>, { success: true }> {
  if (!result.success) throw result.error;
}

function attestationDigest(
  entry: Pick<
    import('./controller-schema').OutcomeEvidenceAttestation,
    | 'id'
    | 'description'
    | 'assertedStatus'
    | 'assertedFreshness'
    | 'candidateFingerprint'
    | 'linkedObservationId'
    | 'createdAt'
  >,
): string {
  return canonicalDigest('omos/evidence-attestation/v1', {
    id: entry.id,
    description: entry.description,
    assertedStatus: entry.assertedStatus,
    assertedFreshness: entry.assertedFreshness,
    candidateFingerprint: entry.candidateFingerprint,
    linkedObservationId: entry.linkedObservationId,
    createdAt: entry.createdAt,
  });
}

function reviewFor(
  record: OutcomeRecord,
  verdict: OutcomeReview['verdict'],
): OutcomeReview {
  const claim = record.checkpoint;
  if (!claim) throw new Error('checkpoint missing');
  const evidence = claim.includedEvidenceAttestationIds.map((id) => {
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
      isFinalCandidate: claim.kind === 'final',
    };
  });
  const accepted = verdict === 'ACCEPT';
  return {
    summary: accepted
      ? 'Outcome is ready for acceptance'
      : 'Continue execution',
    verdict,
    ...(claim.candidateFingerprint
      ? { candidateFingerprint: claim.candidateFingerprint }
      : {}),
    goals: record.contract.goals.map(({ id, description, status }) => ({
      id,
      description,
      status,
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
      ordering: ['contract before evidence'],
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
      summary: accepted ? 'Ready for handoff' : 'Execution continues',
      verificationSteps: accepted
        ? ['Run the integrated verification gate']
        : [],
    },
    lifecycle: {
      stage: accepted ? 'completed' : 'execution',
      receiptAgreement: true,
    },
  };
}

function openCheckpoint(
  store: OutcomeStore,
  root: string,
  revision: number,
  token: string,
  kind: 'kickoff' | 'decision' | 'exception' | 'final',
  options: {
    candidateFingerprint?: string;
    evidenceAttestationIds?: string[];
  } = {},
) {
  const result = store.mutate(root, revision, {
    type: 'open_checkpoint',
    kind,
    reason: `${kind} review`,
    claimToken: token,
    expiresAt: 10_000,
    candidateFingerprint: options.candidateFingerprint,
    evidenceAttestationIds: options.evidenceAttestationIds,
  });
  expectSuccess(result);
  const claim = result.data.checkpoint;
  if (!claim) throw new Error('checkpoint not created');
  return { result, claim };
}

function completeReview(
  store: OutcomeStore,
  root: string,
  startRevision: number,
  token: string,
  verdict: OutcomeReview['verdict'],
) {
  let current = store.read(root);
  expectSuccess(current);
  const claim = current.data.checkpoint;
  if (!claim) throw new Error('checkpoint missing');
  current = store.mutate(root, startRevision, {
    type: 'mark_dispatching',
    checkpointId: claim.checkpointId,
    claimGeneration: claim.claimGeneration,
    claimToken: token,
    dispatchCallId: `call_${claim.claimGeneration}`,
  });
  expectSuccess(current);
  current = store.mutate(root, startRevision + 1, {
    type: 'bind_manager',
    checkpointId: claim.checkpointId,
    claimGeneration: claim.claimGeneration,
    claimToken: token,
    managerTaskId: `manager_${claim.claimGeneration}`,
    managerGeneration: 1,
  });
  expectSuccess(current);
  const resultDigest = hash(`result_${claim.claimGeneration}`);
  current = store.mutate(root, startRevision + 2, {
    type: 'mark_result_available',
    checkpointId: claim.checkpointId,
    claimGeneration: claim.claimGeneration,
    claimToken: token,
    resultDigest,
  });
  expectSuccess(current);
  const parsedReview = reviewFor(current.data, verdict);
  current = store.mutate(root, startRevision + 3, {
    type: 'record_review',
    checkpointId: claim.checkpointId,
    claimGeneration: claim.claimGeneration,
    claimToken: token,
    resultDigest,
    review: parsedReview,
  });
  expectSuccess(current);
  return current;
}

describe('OutcomeStore protocol and integrity', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-outcome-store-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('persists canonical JSON-compatible contracts and enforces CAS', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      randomId: () => 'random_identifier',
      clock: () => 100,
    });
    const created = store.init('root_one', {
      contract: contract({
        goals: [
          {
            id: 'goal_protocol',
            description: 'Implement the outcome protocol',
            status: 'in_progress',
            notes: undefined,
          },
        ],
      }),
    });
    expectSuccess(created);
    expect(created.data.contractDigest).toBe(
      computeOutcomeContractDigest(created.data.contract),
    );
    const reloaded = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
    }).read('root_one');
    expectSuccess(reloaded);
    expect(reloaded.data.contractDigest).toBe(created.data.contractDigest);
    const stale = store.mutate('root_one', 0, {
      type: 'append_action',
      action: {
        id: 'action_stale',
        code: 'manual_intervention',
        referenceId: 'ref_stale',
        reason: 'stale write',
        createdAt: 100,
        createdRevision: 2,
      },
    });
    expect(stale.success).toBe(false);
    expect(stale.code).toBe('conflict');
  });

  test('rejects forged contract digests without overwriting bytes', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
    });
    const created = store.init('root_digest', { contract: contract() });
    expectSuccess(created);
    const file = store.recordPath('root_digest');
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    record.contractDigest = hash('forged');
    const forged = `${JSON.stringify(record, null, 2)}\n`;
    fs.writeFileSync(file, forged);
    expect(store.read('root_digest').code).toBe('corrupt');
    expect(store.recover('root_digest').code).toBe('corrupt');
    expect(fs.readFileSync(file, 'utf8')).toBe(forged);
  });

  test('reload rejects independent attestation bound-field tampering and accepts untouched bytes', () => {
    const candidate = hash('tamper-candidate');
    const fields = [
      'id',
      'description',
      'assertedStatus',
      'assertedFreshness',
      'candidateFingerprint',
      'linkedObservationId',
      'createdAt',
      'payloadDigest',
    ] as const;
    for (const field of fields) {
      const root = `root_att_tamper_${field}`;
      const store = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_one',
      });
      let current = store.init(root, { contract: contract() });
      expectSuccess(current);
      const entry = {
        id: 'att_bound',
        kind: 'orchestrator_attestation' as const,
        description: 'bun test',
        assertedStatus: 'passed' as const,
        assertedFreshness: 'fresh' as const,
        candidateFingerprint: candidate,
        linkedObservationId: undefined,
        payloadDigest: '',
        createdRevision: 2,
        createdAt: 100,
      };
      entry.payloadDigest = attestationDigest(entry);
      current = store.mutate(root, 1, { type: 'append_evidence', entry });
      expectSuccess(current);
      expect(store.read(root).success).toBe(true);
      const file = store.recordPath(root);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const persisted = raw.receipts.evidence[0];
      switch (field) {
        case 'id':
          persisted.id = 'att_changed';
          break;
        case 'description':
          persisted.description = 'bun test changed';
          break;
        case 'assertedStatus':
          persisted.assertedStatus = 'failed';
          break;
        case 'assertedFreshness':
          persisted.assertedFreshness = 'stale';
          break;
        case 'candidateFingerprint':
          persisted.candidateFingerprint = hash('changed-candidate');
          break;
        case 'linkedObservationId':
          persisted.linkedObservationId = 'obs_missing';
          break;
        case 'createdAt':
          persisted.createdAt = 101;
          break;
        case 'payloadDigest':
          persisted.payloadDigest = hash('forged-attestation');
          break;
      }
      fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      expect(store.read(root).code).toBe('corrupt');
    }
  });

  test('reload rejects independent authorization bound-field tampering', () => {
    const fields = [
      'id',
      'kind',
      'reference',
      'observedAt',
      'payloadDigest',
    ] as const;
    for (const field of fields) {
      const root = `root_auth_tamper_${field}`;
      const store = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_one',
      });
      let current = store.init(root, { contract: contract() });
      expectSuccess(current);
      const receipt = {
        id: 'auth_bound',
        kind: 'repository_waiver' as const,
        reference: 'governance/waivers/one.json',
        payloadDigest: '',
        observedAt: 100,
      };
      receipt.payloadDigest = canonicalDigest('omos/outcome-authorization/v1', {
        id: receipt.id,
        kind: receipt.kind,
        reference: receipt.reference,
        decisionId: undefined,
        observedAt: receipt.observedAt,
      });
      current = store.mutate(root, 1, {
        type: 'append_authorization',
        receipt,
      });
      expectSuccess(current);
      const file = store.recordPath(root);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const persisted = raw.receipts.authorizations[0];
      switch (field) {
        case 'id':
          persisted.id = 'auth_changed';
          break;
        case 'kind':
          persisted.kind = 'user_decision';
          persisted.decisionId = 'dec_missing';
          break;
        case 'reference':
          persisted.reference = 'governance/waivers/changed.json';
          break;
        case 'observedAt':
          persisted.observedAt = 101;
          break;
        case 'payloadDigest':
          persisted.payloadDigest = hash('forged-authorization');
          break;
      }
      fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      expect(store.read(root).code).toBe('corrupt');
    }
  });

  test('untouched accepted certificate with bound attestation digest reloads', () => {
    const candidate = hash('accepted-reload-candidate');
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_accept_reload',
      randomId: (() => {
        let index = 0;
        return () => `accept_reload_${++index}`;
      })(),
      clock: () => 100,
    });
    let current = store.init('root_accept_reload', {
      contract: contract({
        goals: [
          {
            id: 'goal_protocol',
            description: 'Implement the outcome protocol',
            status: 'satisfied',
          },
        ],
      }),
    });
    expectSuccess(current);
    openCheckpoint(store, 'root_accept_reload', 1, 'kickoff-token', 'kickoff');
    current = completeReview(
      store,
      'root_accept_reload',
      2,
      'kickoff-token',
      'CONTINUE',
    );
    const entry = {
      id: 'att_accept_reload',
      kind: 'orchestrator_attestation' as const,
      description: 'bun test accepted reload',
      assertedStatus: 'passed' as const,
      assertedFreshness: 'fresh' as const,
      candidateFingerprint: candidate,
      payloadDigest: '',
      createdRevision: 7,
      createdAt: 100,
    };
    entry.payloadDigest = attestationDigest(entry);
    current = store.mutate('root_accept_reload', 6, {
      type: 'append_evidence',
      entry,
    });
    expectSuccess(current);
    openCheckpoint(store, 'root_accept_reload', 7, 'final-token', 'final', {
      candidateFingerprint: candidate,
      evidenceAttestationIds: [entry.id],
    });
    current = completeReview(
      store,
      'root_accept_reload',
      8,
      'final-token',
      'ACCEPT',
    );
    const accepted = store.mutate('root_accept_reload', 12, {
      type: 'finalize',
      summary: 'Untouched accepted record',
    });
    expectSuccess(accepted);
    const reloaded = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_later',
    }).read('root_accept_reload');
    expectSuccess(reloaded);
    expect(reloaded.data.finalCertificate).toEqual(
      accepted.data.finalCertificate,
    );
  });

  test('creates store-owned claims and requires the raw token for every transition', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      randomId: () => 'checkpoint_random',
      clock: () => 100,
    });
    const created = store.init('root_claim', { contract: contract() });
    expectSuccess(created);
    const opened = openCheckpoint(
      store,
      'root_claim',
      1,
      'right-token',
      'kickoff',
    );
    expect(opened.claim.outcomeId).toBe(created.data.outcomeId);
    expect(opened.claim.rootSessionId).toBe('root_claim');
    expect(opened.claim.serverEpoch).toBe('epoch_one');
    expect(opened.claim.claimGeneration).toBe(1);
    expect(opened.claim.claimTokenDigest).not.toContain('right-token');

    const wrong = store.mutate('root_claim', 2, {
      type: 'mark_dispatching',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'wrong-token',
      dispatchCallId: 'call_one',
    });
    expect(wrong.success).toBe(false);
    const reviewed = completeReview(
      store,
      'root_claim',
      2,
      'right-token',
      'CONTINUE',
    );
    expect(reviewed.data.checkpoint?.state).toBe('review_rejected');

    const second = openCheckpoint(
      store,
      'root_claim',
      6,
      'second-token',
      'decision',
    );
    expect(second.claim.claimGeneration).toBe(2);
    expect(second.claim.checkpointId).not.toBe(opened.claim.checkpointId);
  });

  test('authenticates Manager result, contract, scope, and attestation fields', () => {
    const candidate = hash('candidate');
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      randomId: () => 'review_random',
      clock: () => 100,
    });
    let current = store.init('root_review', { contract: contract() });
    expectSuccess(current);
    current = store.mutate('root_review', 1, {
      type: 'append_evidence',
      entry: {
        id: 'att_one',
        kind: 'orchestrator_attestation',
        description: 'bun test',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: candidate,
        payloadDigest: attestationDigest({
          id: 'att_one',
          description: 'bun test',
          assertedStatus: 'passed',
          assertedFreshness: 'fresh',
          candidateFingerprint: candidate,
          createdAt: 100,
        }),
        createdRevision: 2,
        createdAt: 100,
      },
    });
    expectSuccess(current);
    const opened = openCheckpoint(store, 'root_review', 2, 'token', 'final', {
      candidateFingerprint: candidate,
      evidenceAttestationIds: ['att_one'],
    });
    current = store.mutate('root_review', 3, {
      type: 'mark_dispatching',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'token',
      dispatchCallId: 'call_one',
    });
    expectSuccess(current);
    current = store.mutate('root_review', 4, {
      type: 'bind_manager',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'token',
      managerTaskId: 'manager_one',
      managerGeneration: 1,
    });
    expectSuccess(current);
    current = store.mutate('root_review', 5, {
      type: 'mark_result_available',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'token',
      resultDigest: hash('result'),
    });
    expectSuccess(current);
    const review = reviewFor(current.data, 'CONTINUE');
    const file = store.recordPath('root_review');
    const beforeIdentityAttacks = fs.readFileSync(file, 'utf8');
    for (const identity of [
      { checkpointId: 'wrong_checkpoint', claimGeneration: 1 },
      {
        checkpointId: opened.claim.checkpointId,
        claimGeneration: 99,
      },
    ]) {
      const wrongIdentity = store.mutate('root_review', 6, {
        type: 'record_review',
        ...identity,
        claimToken: 'token',
        resultDigest: hash('result'),
        review,
      });
      expect(wrongIdentity.success).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(beforeIdentityAttacks);
    }
    const wrongResult = store.mutate('root_review', 6, {
      type: 'record_review',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'token',
      resultDigest: hash('other-result'),
      review,
    });
    expect(wrongResult.success).toBe(false);
    const forged = structuredClone(review);
    forged.evidence[0].status = 'failed';
    const wrongEvidence = store.mutate('root_review', 6, {
      type: 'record_review',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'token',
      resultDigest: hash('result'),
      review: forged,
    });
    expect(wrongEvidence.success).toBe(false);
  });

  test('derives review terminal state solely from the strict verdict', () => {
    for (const [verdict, expected] of [
      ['CONTINUE', 'review_rejected'],
      ['CORRECT_DRIFT', 'review_rejected'],
      ['REVISE_CONTRACT', 'review_rejected'],
    ] as const) {
      const root = `root_${verdict.toLowerCase()}`;
      const store = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_one',
        randomId: () => root,
        clock: () => 100,
      });
      const created = store.init(root, { contract: contract() });
      expectSuccess(created);
      openCheckpoint(store, root, 1, 'token', 'kickoff');
      const reviewed = completeReview(store, root, 2, 'token', verdict);
      expect(reviewed.data.checkpoint?.state).toBe(expected);
    }
  });

  test('finalizes only satisfied contract with completed kickoff and matching final attestations', () => {
    const candidate = hash('candidate');
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      randomId: (() => {
        let index = 0;
        return () => `random_${++index}`;
      })(),
      clock: () => 1_000,
    });
    let current = store.init('root_final', {
      contract: contract({
        goals: [
          {
            id: 'goal_protocol',
            description: 'Implement the outcome protocol',
            status: 'satisfied',
          },
        ],
      }),
    });
    expectSuccess(current);
    openCheckpoint(store, 'root_final', 1, 'kickoff-token', 'kickoff');
    current = completeReview(
      store,
      'root_final',
      2,
      'kickoff-token',
      'CONTINUE',
    );

    current = store.mutate('root_final', 6, {
      type: 'append_evidence',
      entry: {
        id: 'att_final',
        kind: 'orchestrator_attestation',
        description: 'bun test',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint: candidate,
        payloadDigest: attestationDigest({
          id: 'att_final',
          description: 'bun test',
          assertedStatus: 'passed',
          assertedFreshness: 'fresh',
          candidateFingerprint: candidate,
          createdAt: 1_000,
        }),
        createdRevision: 7,
        createdAt: 1_000,
      },
    });
    expectSuccess(current);
    openCheckpoint(store, 'root_final', 7, 'final-token', 'final', {
      candidateFingerprint: candidate,
      evidenceAttestationIds: ['att_final'],
    });
    current = completeReview(store, 'root_final', 8, 'final-token', 'ACCEPT');
    const accepted = store.mutate('root_final', 12, {
      type: 'finalize',
      summary: 'Accepted exact final outcome',
    });
    expectSuccess(accepted);
    expect(accepted.data.phase).toBe('accepted');
    expect(accepted.data.finalCertificate).toMatchObject({
      outcomeId: accepted.data.outcomeId,
      acceptedRevision: 13,
      candidateFingerprint: candidate,
      evidenceAssurance: 'orchestrator_attestation',
    });
    const reloaded = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_new',
    }).recover('root_final');
    expectSuccess(reloaded);
    expect(reloaded.status).toBe('noop');
    expect(reloaded.data.finalCertificate).toEqual(
      accepted.data.finalCertificate,
    );
  });

  test('rejects semantic, rule, evidence, and result-binding acceptance defects', () => {
    const candidate = hash('candidate');
    for (const defect of [
      'goal',
      'rule',
      'status',
      'freshness',
      'candidate',
    ] as const) {
      const root = `root_defect_${defect}`;
      const rules =
        defect === 'rule'
          ? [
              {
                id: 'rule_one',
                sourcePath: 'AGENTS.md',
                category: 'test',
                summary: 'Tests must pass',
                ruleType: 'semantic' as const,
                enforcementStatus: 'pending' as const,
                evidenceAttestationIds: [],
              },
            ]
          : [];
      const store = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_one',
        randomId: () => root,
        clock: () => 100,
      });
      let current = store.init(root, {
        contract: contract({
          goals: [
            {
              id: 'goal_protocol',
              description: 'Implement the outcome protocol',
              status: defect === 'goal' ? 'in_progress' : 'satisfied',
            },
          ],
          rules,
        }),
      });
      expectSuccess(current);
      current = store.mutate(root, 1, {
        type: 'append_evidence',
        entry: {
          id: 'att_one',
          kind: 'orchestrator_attestation',
          description: 'bun test',
          assertedStatus: defect === 'status' ? 'failed' : 'passed',
          assertedFreshness: defect === 'freshness' ? 'stale' : 'fresh',
          candidateFingerprint:
            defect === 'candidate' ? hash('other') : candidate,
          payloadDigest: attestationDigest({
            id: 'att_one',
            description: 'bun test',
            assertedStatus: defect === 'status' ? 'failed' : 'passed',
            assertedFreshness: defect === 'freshness' ? 'stale' : 'fresh',
            candidateFingerprint:
              defect === 'candidate' ? hash('other') : candidate,
            createdAt: 100,
          }),
          createdRevision: 2,
          createdAt: 100,
        },
      });
      expectSuccess(current);
      openCheckpoint(store, root, 2, 'token', 'final', {
        candidateFingerprint: candidate,
        evidenceAttestationIds: ['att_one'],
      });
      const reviewed = completeReview(store, root, 3, 'token', 'CONTINUE');
      expect(reviewed.data.checkpoint?.state).toBe('review_rejected');
      expect(
        store.mutate(root, 7, {
          type: 'finalize',
          summary: 'must fail',
        }).success,
      ).toBe(false);
    }
  });

  test('recovers uncertain checkpoint and interrupted operation through explicit commands', () => {
    const old = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_old',
      randomId: () => 'recovery_random',
      clock: () => 100,
    });
    let current = old.init('root_recovery', { contract: contract() });
    expectSuccess(current);
    const opened = openCheckpoint(old, 'root_recovery', 1, 'token', 'kickoff');
    current = old.mutate('root_recovery', 2, {
      type: 'mark_dispatching',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      claimToken: 'token',
      dispatchCallId: 'call_manager',
    });
    expectSuccess(current);
    current = old.mutate('root_recovery', 3, {
      type: 'start_operation',
      operation: {
        id: 'op_one',
        callId: 'call_bash',
        toolName: 'bash',
        argumentDigest: hash('args'),
        serverEpoch: 'epoch_old',
        status: 'running',
        startedAt: 100,
        updatedAt: 100,
      },
    });
    expectSuccess(current);

    const next = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_new',
      clock: () => 200,
    });
    current = next.recover('root_recovery');
    expectSuccess(current);
    expect(current.data.phase).toBe('action_required');
    expect(current.data.checkpoint?.state).toBe('review_uncertain');
    expect(current.data.operations[0].status).toBe('interrupted');

    current = next.mutate('root_recovery', 5, {
      type: 'reconcile_uncertain_checkpoint',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 1,
      resolution: { kind: 'retire', reason: 'Old Manager run was abandoned' },
    });
    expectSuccess(current);
    current = next.mutate('root_recovery', 6, {
      type: 'acknowledge_operation',
      operationId: 'op_one',
    });
    expectSuccess(current);
    expect(current.data.phase).toBe('active');
    const reopened = openCheckpoint(
      next,
      'root_recovery',
      7,
      'new-token',
      'kickoff',
    );
    expect(reopened.claim.claimGeneration).toBe(2);
  });

  test('reconciles prior-epoch dispatching, running, and result-available claims without the old raw token', () => {
    for (const state of [
      'dispatching',
      'running',
      'result_available',
    ] as const) {
      const root = `root_recover_${state}`;
      let ids = 0;
      const old = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_old',
        randomId: () => `old_${state}_${++ids}`,
        clock: () => 100,
      });
      let current = old.init(root, { contract: contract() });
      expectSuccess(current);
      const opened = openCheckpoint(old, root, 1, 'lost-token', 'kickoff');
      current = old.mutate(root, 2, {
        type: 'mark_dispatching',
        checkpointId: opened.claim.checkpointId,
        claimGeneration: 1,
        claimToken: 'lost-token',
        dispatchCallId: 'call_original',
      });
      expectSuccess(current);
      if (state !== 'dispatching') {
        current = old.mutate(root, 3, {
          type: 'bind_manager',
          checkpointId: opened.claim.checkpointId,
          claimGeneration: 1,
          claimToken: 'lost-token',
          managerTaskId: 'manager_original',
          managerGeneration: 7,
        });
        expectSuccess(current);
      }
      if (state === 'result_available') {
        current = old.mutate(root, 4, {
          type: 'mark_result_available',
          checkpointId: opened.claim.checkpointId,
          claimGeneration: 1,
          claimToken: 'lost-token',
          resultDigest: hash('recovered-result'),
        });
        expectSuccess(current);
      }

      const next = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_new',
        randomId: () => `new_${state}_${++ids}`,
        clock: () => 200,
      });
      current = next.recover(root);
      expectSuccess(current);
      const recoveredClaim = current.data.checkpoint;
      if (!recoveredClaim) throw new Error('recovered checkpoint missing');

      if (state !== 'result_available') {
        expect(recoveredClaim.state).toBe('review_uncertain');
        const revision = current.revision;
        if (state === 'running') {
          const replacement = next.mutate(root, revision, {
            type: 'reconcile_uncertain_checkpoint',
            checkpointId: recoveredClaim.checkpointId,
            claimGeneration: recoveredClaim.claimGeneration,
            resolution: {
              kind: 'result_available',
              dispatchCallId: 'call_replacement',
              managerTaskId: 'manager_replacement',
              managerGeneration: 8,
              resultDigest: hash('recovered-result'),
            },
          });
          expect(replacement.success).toBe(false);
        }
        current = next.mutate(root, revision, {
          type: 'reconcile_uncertain_checkpoint',
          checkpointId: recoveredClaim.checkpointId,
          claimGeneration: recoveredClaim.claimGeneration,
          resolution: {
            kind: 'result_available',
            dispatchCallId: 'call_original',
            managerTaskId: 'manager_original',
            managerGeneration: 7,
            resultDigest: hash('recovered-result'),
          },
        });
        if (state === 'dispatching') {
          // Dispatching had no durable Manager identity; host reconciliation
          // supplies it while preserving the original dispatch call.
          expectSuccess(current);
        } else {
          expectSuccess(current);
        }
      }

      const ready = next.read(root);
      expectSuccess(ready);
      const claim = ready.data.checkpoint;
      if (!claim) throw new Error('result checkpoint missing');
      const review = reviewFor(ready.data, 'CONTINUE');
      const reviewed = next.mutate(root, ready.revision, {
        type: 'record_recovered_review',
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        resultDigest: hash('recovered-result'),
        review,
      });
      expectSuccess(reviewed);
      expect(reviewed.data.checkpoint?.state).toBe('review_rejected');
      const replay = next.mutate(root, reviewed.revision, {
        type: 'record_recovered_review',
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        resultDigest: hash('recovered-result'),
        review,
      });
      expect(replay.success).toBe(false);
    }
  });

  test('expires each same-epoch live claim state, rejects stale callbacks, and permits the next generation', () => {
    for (const state of ['claimed', 'dispatching', 'running'] as const) {
      let now = 100;
      let ids = 0;
      const root = `root_expire_${state}`;
      const store = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_one',
        randomId: () => `expiry_${state}_${++ids}`,
        clock: () => now,
      });
      const created = store.init(root, { contract: contract() });
      expectSuccess(created);
      const openedResult = store.mutate(root, 1, {
        type: 'open_checkpoint',
        kind: 'kickoff',
        reason: 'expiring checkpoint',
        claimToken: 'token',
        expiresAt: 110,
      });
      expectSuccess(openedResult);
      const claim = openedResult.data.checkpoint;
      if (!claim) throw new Error('expiry checkpoint missing');
      let revision = 2;
      if (state !== 'claimed') {
        const dispatching = store.mutate(root, revision++, {
          type: 'mark_dispatching',
          checkpointId: claim.checkpointId,
          claimGeneration: claim.claimGeneration,
          claimToken: 'token',
          dispatchCallId: 'call_expiry',
        });
        expectSuccess(dispatching);
      }
      if (state === 'running') {
        const running = store.mutate(root, revision++, {
          type: 'bind_manager',
          checkpointId: claim.checkpointId,
          claimGeneration: claim.claimGeneration,
          claimToken: 'token',
          managerTaskId: 'manager_expiry',
          managerGeneration: 1,
        });
        expectSuccess(running);
      }
      now = 111;
      const expired = store.mutate(root, revision++, {
        type: 'expire_checkpoint',
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        claimToken: 'token',
        reason: 'Explicitly retired after expiry',
      });
      expectSuccess(expired);
      expect(expired.data.checkpoint?.state).toBe('retired');
      const staleCallback = store.mutate(root, revision, {
        type: 'mark_result_available',
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        claimToken: 'token',
        resultDigest: hash('late-result'),
      });
      expect(staleCallback.success).toBe(false);
      const next = store.mutate(root, revision, {
        type: 'open_checkpoint',
        kind: 'kickoff',
        reason: 'replacement checkpoint',
        claimToken: 'next-token',
        expiresAt: 200,
      });
      expectSuccess(next);
      expect(next.data.checkpoint?.claimGeneration).toBe(2);
    }
  });

  test('reports lock publication and record publication durability uncertainty without permanent lock', () => {
    let calls = 0;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      filesystem: {
        fsyncSync: (descriptor) => {
          calls += 1;
          if (calls === 3) throw new Error('lock publication fsync failed');
          fs.fsyncSync(descriptor);
        },
      },
    });
    const failed = store.init('root_lock_failure', { contract: contract() });
    expect(failed.success).toBe(false);
    expect(failed.code).toBe('durability_uncertain');
    const retry = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
    }).init('root_lock_failure', { contract: contract() });
    expectSuccess(retry);
  });

  test('writes all partial chunks and cleans unpublished locks after zero progress', () => {
    const partial = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_partial',
      filesystem: {
        writeSync: ((
          descriptor: number,
          buffer: Uint8Array,
          offset: number,
          length: number,
        ) =>
          fs.writeSync(
            descriptor,
            buffer,
            offset,
            Math.min(length, 7),
          )) as typeof fs.writeSync,
      },
    });
    const written = partial.init('root_partial', { contract: contract() });
    expectSuccess(written);
    expect(partial.read('root_partial').success).toBe(true);

    const zero = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_zero',
      filesystem: {
        writeSync: (() => 0) as typeof fs.writeSync,
      },
    });
    const failed = zero.init('root_zero', { contract: contract() });
    expect(failed.success).toBe(false);
    expect(
      fs.readdirSync(directory).some((name) => name.includes('candidate')),
    ).toBe(false);
  });

  test('fails closed for malformed, oversized, and symlinked records', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
    });
    const created = store.init('root_files', { contract: contract() });
    expectSuccess(created);
    const file = store.recordPath('root_files');
    fs.writeFileSync(file, '{broken');
    expect(store.read('root_files').code).toBe('corrupt');
    fs.writeFileSync(file, 'x'.repeat(MAX_OUTCOME_RECORD_BYTES + 1));
    expect(store.read('root_files').code).toBe('oversized');
    fs.unlinkSync(file);
    const victim = path.join(directory, 'victim');
    fs.writeFileSync(victim, 'safe');
    fs.symlinkSync(victim, file);
    expect(store.read('root_files').code).toBe('symlink_detected');
    expect(fs.readFileSync(victim, 'utf8')).toBe('safe');
  });

  test('keeps records strict and bounded', () => {
    const large = contract({
      constraints: Array.from(
        { length: 32 },
        (_, index) => `${index}:${'x'.repeat(500)}`,
      ),
      rules: Array.from({ length: 64 }, (_, index) => ({
        id: `rule_${index}`,
        sourcePath: `rules/${index}.md`,
        category: 'test',
        summary: `${index}:${'s'.repeat(500)}`,
        ruleType: 'semantic' as const,
        enforcementStatus: 'satisfied' as const,
        evidenceAttestationIds: [],
        notes: `${index}:${'n'.repeat(500)}`,
      })),
    });
    const record: OutcomeRecord = {
      schema: 'omos_outcome_record',
      schemaVersion: 1,
      outcomeId: 'out_large',
      rootSessionId: 'root_large',
      serverEpoch: 'epoch_one',
      revision: 1,
      nextClaimGeneration: 1,
      contractDigest: computeOutcomeContractDigest(large),
      createdAt: 1,
      updatedAt: 1,
      phase: 'active',
      contract: large,
      receipts: {
        evidence: Array.from({ length: 64 }, (_, index) => ({
          id: `att_${index}`,
          kind: 'orchestrator_attestation' as const,
          description: `${index}:${'e'.repeat(500)}`,
          assertedStatus: 'passed' as const,
          assertedFreshness: 'fresh' as const,
          candidateFingerprint: hash(`candidate_${index}`),
          payloadDigest: attestationDigest({
            id: `att_${index}`,
            description: `${index}:${'e'.repeat(500)}`,
            assertedStatus: 'passed',
            assertedFreshness: 'fresh',
            candidateFingerprint: hash(`candidate_${index}`),
            createdAt: 1,
          }),
          createdRevision: 1,
          createdAt: 1,
        })),
        userMessages: [],
        decisions: [],
        authorizations: [],
      },
      reviewSummaries: [],
      operations: [],
      actionsRequired: [],
    };
    expect(() => serializeOutcomeRecord(record)).toThrow(/exceeds/);
    expect(
      OutcomeRecordSchema.safeParse({ ...record, unknown: true }).success,
    ).toBe(false);
  });

  test('records invalid review mutation and enters action_required phase', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      clock: () => 100,
    });
    const root = 'ses_invalid_review_test';
    const init = store.init(root, { contract: contract() });
    expectSuccess(init);
    const token = 'token_invalid_review_12345678901234';
    const { claim } = openCheckpoint(store, root, 1, token, 'kickoff');

    const dispatch = store.mutate(root, 2, {
      type: 'mark_dispatching',
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken: token,
      dispatchCallId: 'call_1',
    });
    expectSuccess(dispatch);

    const bind = store.mutate(root, 3, {
      type: 'bind_manager',
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken: token,
      managerTaskId: 'mgr_task_1',
      managerGeneration: 1,
    });
    expectSuccess(bind);

    const available = store.mutate(root, 4, {
      type: 'mark_result_available',
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken: token,
      resultDigest: hash('malformed-result'),
    });
    expectSuccess(available);

    const invalidRes = store.mutate(root, 5, {
      type: 'record_invalid_review',
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken: token,
      resultDigest: hash('malformed-result'),
      reason: 'Malformed JSON payload from Manager',
    });
    expectSuccess(invalidRes);
    expect(invalidRes.data.checkpoint?.state).toBe('review_invalid');
    expect(invalidRes.data.phase).toBe('action_required');
    expect(invalidRes.data.actionsRequired.length).toBeGreaterThan(0);
    expect(invalidRes.data.checkpoint?.recoveryNote).toBe(
      'Malformed JSON payload from Manager',
    );
  });

  test('bounded compaction allows 100+ tool calls, respects schema caps, keeps recent history and referenced observations', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      clock: () => 1_000,
    });
    const root = 'root_compact_100_calls';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Execute 120 ordinary completed tool calls
    for (let i = 1; i <= 120; i++) {
      const callId = `call_${i}`;
      const operation = {
        id: `op_${callId}`,
        callId,
        toolName: 'bash',
        argumentDigest: hash(`args_${i}`),
        serverEpoch: 'epoch_one',
        status: 'running' as const,
        startedAt: 1_000 + i,
        updatedAt: 1_000 + i,
      };
      const observation = {
        id: `obs_${callId}`,
        kind: 'controller_observed' as const,
        callId,
        toolName: 'bash',
        argumentDigest: hash(`args_${i}`),
        startedEpoch: 'epoch_one',
        startedAt: 1_000 + i,
        completionObserved: false,
      };

      current = store.mutate(root, current.revision, {
        type: 'start_tool_call',
        operation,
        observation,
      });
      expectSuccess(current);

      current = store.mutate(root, current.revision, {
        type: 'complete_tool_call',
        operationId: `op_${callId}`,
        observationId: `obs_${callId}`,
        outputDigest: hash(`output_${i}`),
        completedEpoch: 'epoch_one',
        completedAt: 1_000 + i + 1,
      });
      expectSuccess(current);

      // At call 5, submit an orchestrator attestation linking obs_call_5
      if (i === 5) {
        const entry = {
          id: 'att_linked_call_5',
          kind: 'orchestrator_attestation' as const,
          description: 'Linked test observation from call 5',
          assertedStatus: 'passed' as const,
          assertedFreshness: 'fresh' as const,
          candidateFingerprint: hash('candidate_5'),
          linkedObservationId: 'obs_call_5',
          payloadDigest: '',
          createdRevision: current.revision + 1,
          createdAt: 1_000 + i + 2,
        };
        entry.payloadDigest = attestationDigest(entry);
        current = store.mutate(root, current.revision, {
          type: 'append_evidence',
          entry,
        });
        expectSuccess(current);
      }
    }

    const reloaded = store.read(root);
    expectSuccess(reloaded);

    // Hard schema caps are 32 operations and 64 evidence items
    expect(reloaded.data.operations.length).toBeLessThanOrEqual(16);
    expect(reloaded.data.receipts.evidence.length).toBeLessThanOrEqual(32);

    // Referenced observation from call 5 must survive
    const linkedObs = reloaded.data.receipts.evidence.find(
      (entry) => entry.id === 'obs_call_5',
    );
    expect(linkedObs).toBeDefined();
    expect(linkedObs?.kind).toBe('controller_observed');

    const linkedAttestation = reloaded.data.receipts.evidence.find(
      (entry) => entry.id === 'att_linked_call_5',
    );
    expect(linkedAttestation).toBeDefined();

    // Most recent completed operations (e.g. call_120) must be present
    const latestOp = reloaded.data.operations.find(
      (entry) => entry.id === 'op_call_120',
    );
    expect(latestOp).toBeDefined();
    expect(latestOp?.status).toBe('completed');

    const latestObs = reloaded.data.receipts.evidence.find(
      (entry) => entry.id === 'obs_call_120',
    );
    expect(latestObs).toBeDefined();

    // Oldest unreferenced operations (e.g. call_1) must have been pruned
    const oldestOp = reloaded.data.operations.find(
      (entry) => entry.id === 'op_call_1',
    );
    expect(oldestOp).toBeUndefined();

    const oldestObs = reloaded.data.receipts.evidence.find(
      (entry) => entry.id === 'obs_call_1',
    );
    expect(oldestObs).toBeUndefined();
  });

  test('append_evidence preserves the incoming linked observation across same-mutation compaction', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      clock: () => 1_000,
    });
    const root = 'root_compact_incoming_link';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    for (let i = 1; i <= 9; i++) {
      const callId = `call_incoming_${i}`;
      current = store.mutate(root, current.revision, {
        type: 'start_tool_call',
        operation: {
          id: `op_${callId}`,
          callId,
          toolName: 'bash',
          argumentDigest: hash(`incoming_args_${i}`),
          serverEpoch: 'epoch_one',
          status: 'running',
          startedAt: 1_000 + i,
          updatedAt: 1_000 + i,
        },
        observation: {
          id: `obs_${callId}`,
          kind: 'controller_observed',
          callId,
          toolName: 'bash',
          argumentDigest: hash(`incoming_args_${i}`),
          startedEpoch: 'epoch_one',
          startedAt: 1_000 + i,
          completionObserved: false,
        },
      });
      expectSuccess(current);
      current = store.mutate(root, current.revision, {
        type: 'complete_tool_call',
        operationId: `op_${callId}`,
        observationId: `obs_${callId}`,
        outputDigest: hash(`incoming_output_${i}`),
        completedEpoch: 'epoch_one',
        completedAt: 1_100 + i,
      });
      expectSuccess(current);
    }

    const entry = {
      id: 'att_incoming_oldest',
      kind: 'orchestrator_attestation' as const,
      description: 'Link the oldest retained observation atomically',
      assertedStatus: 'passed' as const,
      assertedFreshness: 'fresh' as const,
      candidateFingerprint: hash('incoming_candidate'),
      linkedObservationId: 'obs_call_incoming_1',
      payloadDigest: '',
      createdRevision: current.revision + 1,
      createdAt: 2_000,
    };
    entry.payloadDigest = attestationDigest(entry);
    current = store.mutate(root, current.revision, {
      type: 'append_evidence',
      entry,
    });
    expectSuccess(current);
    expect(
      current.data.receipts.evidence.some(
        (item) => item.id === 'obs_call_incoming_1',
      ),
    ).toBe(true);
    expect(
      current.data.receipts.evidence.some(
        (item) => item.id === 'att_incoming_oldest',
      ),
    ).toBe(true);
  });

  test('compaction retains active, interrupted, and failed operations alongside unreferenced history', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_one',
      clock: () => 1_000,
    });
    const root = 'root_compact_special_ops';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Add a failed operation
    current = store.mutate(root, current.revision, {
      type: 'start_operation',
      operation: {
        id: 'op_failed_1',
        callId: 'call_failed_1',
        toolName: 'bash',
        argumentDigest: hash('failed_args'),
        serverEpoch: 'epoch_one',
        status: 'running',
        startedAt: 100,
        updatedAt: 100,
      },
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'finish_operation',
      operationId: 'op_failed_1',
      status: 'failed',
      error: 'Command failed',
    });
    expectSuccess(current);

    // Run 100 ordinary completed tool calls
    for (let i = 1; i <= 100; i++) {
      const callId = `call_loop_${i}`;
      current = store.mutate(root, current.revision, {
        type: 'start_tool_call',
        operation: {
          id: `op_${callId}`,
          callId,
          toolName: 'bash',
          argumentDigest: hash(`loop_args_${i}`),
          serverEpoch: 'epoch_one',
          status: 'running',
          startedAt: 200 + i,
          updatedAt: 200 + i,
        },
        observation: {
          id: `obs_${callId}`,
          kind: 'controller_observed',
          callId,
          toolName: 'bash',
          argumentDigest: hash(`loop_args_${i}`),
          startedEpoch: 'epoch_one',
          startedAt: 200 + i,
          completionObserved: false,
        },
      });
      expectSuccess(current);
      current = store.mutate(root, current.revision, {
        type: 'complete_tool_call',
        operationId: `op_${callId}`,
        observationId: `obs_${callId}`,
        outputDigest: hash(`loop_out_${i}`),
        completedEpoch: 'epoch_one',
        completedAt: 200 + i + 1,
      });
      expectSuccess(current);
    }

    const reloaded = store.read(root);
    expectSuccess(reloaded);

    // Failed operation must still be preserved
    const failedOp = reloaded.data.operations.find(
      (entry) => entry.id === 'op_failed_1',
    );
    expect(failedOp).toBeDefined();
    expect(failedOp?.status).toBe('failed');

    // Total operations and evidence must respect bounds
    expect(reloaded.data.operations.length).toBeLessThanOrEqual(16);
    expect(reloaded.data.receipts.evidence.length).toBeLessThanOrEqual(32);
  });
});
