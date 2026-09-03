import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalDigest,
  computeOutcomeAuthorizationDigest,
  computeOutcomeCheckpointFingerprint,
  computeOutcomeContractDigest,
  initialActionArchiveChainDigest,
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
    expiresAt?: number;
  } = {},
) {
  const result = store.mutate(root, revision, {
    type: 'open_checkpoint',
    kind,
    reason: `${kind} review`,
    claimToken: token,
    expiresAt: options.expiresAt ?? 10_000,
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

    // A record that was validly certified under V1 did not require a kickoff
    // CONTINUE. Preserve that certificate without pretending it satisfies the
    // V2 kickoff policy.
    const legacyRoot = 'root_accept_reload';
    const legacyFile = store.recordPath(legacyRoot);
    const legacyRecord = structuredClone(accepted.data) as Record<
      string,
      unknown
    >;
    legacyRecord.schemaVersion = 1;
    delete legacyRecord.kickoffGate;
    delete legacyRecord.resolvedActionArchive;
    const legacyReceipts = legacyRecord.receipts as {
      userMessages: Array<Record<string, unknown>>;
    };
    for (const receipt of legacyReceipts.userMessages) {
      delete receipt.provenance;
    }
    legacyRecord.reviewSummaries = (
      legacyRecord.reviewSummaries as Array<{ checkpointKind: string }>
    ).filter((summary) => summary.checkpointKind !== 'kickoff');
    const certificateBefore = structuredClone(legacyRecord.finalCertificate);
    fs.writeFileSync(legacyFile, `${JSON.stringify(legacyRecord, null, 2)}\n`);

    const legacyReload = store.read(legacyRoot);
    expectSuccess(legacyReload);
    expect(legacyReload.data.kickoffGate).toMatchObject({
      state: 'legacy_certified',
      attempts: 0,
    });
    expect(legacyReload.data.finalCertificate).toEqual(certificateBefore);
    expect(legacyReload.data.phase).toBe('accepted');
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
    openCheckpoint(store, 'root_review', 1, 'kickoff-token', 'kickoff');
    current = completeReview(
      store,
      'root_review',
      2,
      'kickoff-token',
      'CONTINUE',
    );
    current = store.mutate('root_review', 6, {
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
        createdRevision: 7,
        createdAt: 100,
      },
    });
    expectSuccess(current);
    const opened = openCheckpoint(store, 'root_review', 7, 'token', 'final', {
      candidateFingerprint: candidate,
      evidenceAttestationIds: ['att_one'],
    });
    current = store.mutate('root_review', 8, {
      type: 'mark_dispatching',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 2,
      claimToken: 'token',
      dispatchCallId: 'call_one',
    });
    expectSuccess(current);
    current = store.mutate('root_review', 9, {
      type: 'bind_manager',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 2,
      claimToken: 'token',
      managerTaskId: 'manager_one',
      managerGeneration: 1,
    });
    expectSuccess(current);
    current = store.mutate('root_review', 10, {
      type: 'mark_result_available',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 2,
      claimToken: 'token',
      resultDigest: hash('result'),
    });
    expectSuccess(current);
    const review = reviewFor(current.data, 'CONTINUE');
    const file = store.recordPath('root_review');
    const beforeIdentityAttacks = fs.readFileSync(file, 'utf8');
    for (const identity of [
      { checkpointId: 'wrong_checkpoint', claimGeneration: 2 },
      {
        checkpointId: opened.claim.checkpointId,
        claimGeneration: 99,
      },
    ]) {
      const wrongIdentity = store.mutate('root_review', 11, {
        type: 'record_review',
        ...identity,
        claimToken: 'token',
        resultDigest: hash('result'),
        review,
      });
      expect(wrongIdentity.success).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(beforeIdentityAttacks);
    }
    const wrongResult = store.mutate('root_review', 11, {
      type: 'record_review',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 2,
      claimToken: 'token',
      resultDigest: hash('other-result'),
      review,
    });
    expect(wrongResult.success).toBe(false);
    const forged = structuredClone(review);
    forged.evidence[0].status = 'failed';
    const wrongEvidence = store.mutate('root_review', 11, {
      type: 'record_review',
      checkpointId: opened.claim.checkpointId,
      claimGeneration: 2,
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
      let defectRandomCounter = 0;
      const store = new OutcomeStore({
        storeDirectory: directory,
        serverEpoch: 'epoch_one',
        randomId: () => `${++defectRandomCounter}_${root}`,
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
      openCheckpoint(store, root, 1, 'kickoff-token', 'kickoff');
      current = completeReview(store, root, 2, 'kickoff-token', 'CONTINUE');
      current = store.mutate(root, 6, {
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
          createdRevision: 7,
          createdAt: 100,
        },
      });
      expectSuccess(current);
      openCheckpoint(store, root, 7, 'token', 'final', {
        candidateFingerprint: candidate,
        evidenceAttestationIds: ['att_one'],
      });
      const reviewed = completeReview(store, root, 8, 'token', 'CONTINUE');
      expect(reviewed.data.checkpoint?.state).toBe('review_rejected');
      expect(
        store.mutate(root, 12, {
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

  test('V1 migration normalizes kickoffGate states, user provenance, and preserves certificates', () => {
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_v1',
      clock: () => 1_000,
    });
    const c = contract();
    const cDigest = computeOutcomeContractDigest(c);

    // 1. V1 with qualifying kickoff summary -> authenticated gate
    const v1WithKickoff = {
      schema: 'omos_outcome_record',
      schemaVersion: 1,
      outcomeId: 'out_v1_kickoff',
      rootSessionId: 'root_v1_kickoff',
      serverEpoch: 'epoch_v1',
      revision: 6,
      nextClaimGeneration: 2,
      contractDigest: cDigest,
      createdAt: 1_000,
      updatedAt: 1_000,
      phase: 'active',
      contract: c,
      receipts: {
        evidence: [],
        userMessages: [
          {
            id: 'usr_1',
            messageId: 'msg_1',
            contentDigest: hash('content_1'),
            observedEpoch: 'epoch_v1',
            observedAt: 1_000,
            createdRevision: 1,
          },
        ],
        decisions: [],
        authorizations: [],
      },
      reviewSummaries: [
        {
          reviewId: 'rev_kickoff_1',
          checkpointId: 'chk_kickoff_1',
          claimGeneration: 1,
          checkpointKind: 'kickoff',
          contractDigest: cDigest,
          outcomeRevision: 2,
          verdict: 'CONTINUE',
          managerTaskId: 'mgr_task_1',
          managerGeneration: 1,
          resultDigest: hash('res_1'),
          reviewDigest: hash('rev_1'),
          summary: 'Kickoff approved',
          evaluatedAt: 1_000,
        },
      ],
      operations: [],
      actionsRequired: [],
    };
    const file1 = store.recordPath('root_v1_kickoff');
    fs.writeFileSync(file1, `${JSON.stringify(v1WithKickoff, null, 2)}\n`);

    const read1 = store.read('root_v1_kickoff');
    expectSuccess(read1);
    expect(read1.data.schemaVersion).toBe(2);
    expect(read1.data.kickoffGate.state).toBe('authenticated');
    expect(read1.data.kickoffGate.authenticatedReviewId).toBe('rev_kickoff_1');
    expect(read1.data.kickoffGate.attempts).toBe(1);
    expect(read1.data.receipts.userMessages[0].provenance).toBe(
      'legacy_unverified',
    );
    expect(read1.data.resolvedActionArchive).toEqual({
      count: 0,
      chainDigest: initialActionArchiveChainDigest(),
    });

    // 2. V1 with no kickoff and no later checkpoint/review -> required gate
    const v1Clean = {
      ...v1WithKickoff,
      outcomeId: 'out_v1_clean',
      rootSessionId: 'root_v1_clean',
      revision: 1,
      nextClaimGeneration: 1,
      reviewSummaries: [],
    };
    const file2 = store.recordPath('root_v1_clean');
    fs.writeFileSync(file2, `${JSON.stringify(v1Clean, null, 2)}\n`);

    const read2 = store.read('root_v1_clean');
    expectSuccess(read2);
    expect(read2.data.schemaVersion).toBe(2);
    expect(read2.data.kickoffGate.state).toBe('required');
    expect(read2.data.kickoffGate.attempts).toBe(0);
    expect(read2.data.kickoffGate.authenticatedReviewId).toBeUndefined();

    // 3. V1 with later review/checkpoint but no kickoff -> legacy_late_missing
    const v1MissingKickoff = {
      ...v1WithKickoff,
      outcomeId: 'out_v1_missing',
      rootSessionId: 'root_v1_missing',
      revision: 6,
      reviewSummaries: [
        {
          reviewId: 'rev_final_1',
          checkpointId: 'chk_final_1',
          claimGeneration: 1,
          checkpointKind: 'final',
          contractDigest: cDigest,
          outcomeRevision: 2,
          verdict: 'CONTINUE',
          managerTaskId: 'mgr_task_1',
          managerGeneration: 1,
          resultDigest: hash('res_f1'),
          reviewDigest: hash('rev_f1'),
          candidateFingerprint: hash('cand_f1'),
          summary: 'Final review without kickoff',
          evaluatedAt: 1_000,
        },
      ],
    };
    const file3 = store.recordPath('root_v1_missing');
    fs.writeFileSync(file3, `${JSON.stringify(v1MissingKickoff, null, 2)}\n`);

    const read3 = store.read('root_v1_missing');
    expectSuccess(read3);
    expect(read3.data.schemaVersion).toBe(2);
    expect(read3.data.kickoffGate.state).toBe('legacy_late_missing');
    expect(read3.data.kickoffGate.authenticatedReviewId).toBeUndefined();

    const changedWithoutAuthority = store.mutate(
      'root_v1_missing',
      read3.data.revision,
      {
        type: 'revise_contract',
        contract: contract({
          deliverables: ['Changed without user authority'],
        }),
      },
    );
    expectSuccess(changedWithoutAuthority);
    expect(changedWithoutAuthority.data.kickoffGate).toMatchObject({
      state: 'legacy_late_missing',
      attempts: read3.data.kickoffGate.attempts,
    });
    expect(changedWithoutAuthority.data.phase).toBe('failed');
    const blockedCheckpoint = store.mutate(
      'root_v1_missing',
      changedWithoutAuthority.data.revision,
      {
        type: 'open_checkpoint',
        kind: 'final',
        reason: 'Still blocked after unauthorized digest change',
        claimToken: 'blocked-token',
        expiresAt: 5_000,
        candidateFingerprint: hash('blocked-candidate'),
      },
    );
    expect(blockedCheckpoint.success).toBe(false);
    expect(blockedCheckpoint.code).toBe('retrospective_kickoff_forbidden');
  });

  test('kickoff gate enforces attempt limits, failure exhaustion, and blocks non-kickoff checkpoints', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_gate',
      clock: () => now,
    });
    const root = 'root_gate_enforce';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);
    expect(current.data.kickoffGate.state).toBe('required');
    expect(current.data.kickoffGate.attempts).toBe(0);

    // Non-kickoff checkpoint before kickoff authentication is rejected
    const badDecision = store.mutate(root, current.revision, {
      type: 'open_checkpoint',
      kind: 'decision',
      reason: 'Should be rejected',
      claimToken: 'token_bad',
      expiresAt: now + 10_000,
    });
    expect(badDecision.success).toBe(false);
    expect(badDecision.code).toBe('invalid_transition');

    // First kickoff opens (attempt 1)
    const { claim: kickoff1 } = openCheckpoint(
      store,
      root,
      current.revision,
      'token_k1',
      'kickoff',
    );
    current = store.read(root);
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(1);
    expect(current.data.kickoffGate.state).toBe('required');

    // First kickoff fails with invalid review
    current = store.mutate(root, current.revision, {
      type: 'mark_dispatching',
      checkpointId: kickoff1.checkpointId,
      claimGeneration: kickoff1.claimGeneration,
      claimToken: 'token_k1',
      dispatchCallId: 'call_k1',
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'record_invalid_dispatch',
      checkpointId: kickoff1.checkpointId,
      claimGeneration: kickoff1.claimGeneration,
      reason: 'Dispatch failed on attempt 1',
    });
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(1);
    expect(current.data.kickoffGate.state).toBe('required');
    expect(current.data.kickoffGate.failureReason).toBe(
      'Dispatch failed on attempt 1',
    );

    // Resolve the action created by dispatch failure using external_user provenance
    const userMsgRes = store.mutate(root, current.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_fix_1',
        messageId: 'msg_fix_1',
        contentDigest: hash('user_retry_approval'),
        observedEpoch: 'epoch_gate',
        observedAt: now,
        createdRevision: current.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(userMsgRes);
    current = userMsgRes;

    const actionToResolve = current.data.actionsRequired.find(
      (a) => a.resolvedAt === undefined,
    );
    expect(actionToResolve).toBeDefined();
    if (!actionToResolve) return;

    const resolveRes = store.mutate(root, current.revision, {
      type: 'resolve_action',
      actionId: actionToResolve.id,
      reason: 'User approved retry after dispatch failure',
      sourceUserMessageReceiptId: 'usr_fix_1',
    });
    expectSuccess(resolveRes);
    current = resolveRes;

    // Second kickoff opens (attempt 2 - maxAttempts reached)
    const { claim: kickoff2 } = openCheckpoint(
      store,
      root,
      current.revision,
      'token_k2',
      'kickoff',
    );
    current = store.read(root);
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(2);

    // Second kickoff fails -> gate becomes exhausted and phase becomes failed
    current = store.mutate(root, current.revision, {
      type: 'mark_dispatching',
      checkpointId: kickoff2.checkpointId,
      claimGeneration: kickoff2.claimGeneration,
      claimToken: 'token_k2',
      dispatchCallId: 'call_k2',
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'record_invalid_dispatch',
      checkpointId: kickoff2.checkpointId,
      claimGeneration: kickoff2.claimGeneration,
      reason: 'Dispatch failed on attempt 2',
    });
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(2);
    expect(current.data.kickoffGate.state).toBe('exhausted');
    expect(current.data.phase).toBe('failed');

    // Third kickoff attempt is blocked with kickoff_retry_exhausted (no state change)
    const revBefore = current.data.revision;
    const thirdKickoff = store.mutate(root, current.revision, {
      type: 'open_checkpoint',
      kind: 'kickoff',
      reason: 'Third attempt should be rejected',
      claimToken: 'token_k3',
      expiresAt: now + 10_000,
    });
    expect(thirdKickoff.success).toBe(false);
    expect(thirdKickoff.code).toBe('kickoff_retry_exhausted');

    const unchanged = store.read(root);
    expectSuccess(unchanged);
    expect(unchanged.data.revision).toBe(revBefore);
    expect(unchanged.data.kickoffGate.state).toBe('exhausted');
  });

  test('action archive compacts resolved actions, maintains rolling digest, and rejects on capacity exhaustion', () => {
    let now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_act',
      clock: () => now,
    });
    const root = 'root_action_archive';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    expect(current.data.resolvedActionArchive).toEqual({
      count: 0,
      chainDigest: initialActionArchiveChainDigest(),
    });

    // Add and resolve 10 actions sequentially
    for (let i = 1; i <= 10; i++) {
      now += 10;
      current = store.mutate(root, current.revision, {
        type: 'append_action',
        action: {
          id: `act_${i}`,
          code: 'manual_intervention',
          referenceId: `ref_${i}`,
          reason: `Action reason ${i}`,
          createdAt: now,
          createdRevision: current.revision + 1,
        },
      });
      expectSuccess(current);

      // Add user message for provenance
      now += 10;
      current = store.mutate(root, current.revision, {
        type: 'append_user_message',
        receipt: {
          id: `usr_act_${i}`,
          messageId: `msg_act_${i}`,
          contentDigest: hash(`content_act_${i}`),
          observedEpoch: 'epoch_act',
          observedAt: now,
          createdRevision: current.revision + 1,
          provenance: 'external_user',
        },
      });
      expectSuccess(current);

      now += 10;
      current = store.mutate(root, current.revision, {
        type: 'resolve_action',
        actionId: `act_${i}`,
        reason: `Resolved action ${i}`,
        sourceUserMessageReceiptId: `usr_act_${i}`,
      });
      expectSuccess(current);
    }

    // Now add an 11th action: should archive oldest resolved actions, keeping at most 4 resolved actions
    now += 10;
    current = store.mutate(root, current.revision, {
      type: 'append_action',
      action: {
        id: 'act_11',
        code: 'manual_intervention',
        referenceId: 'ref_11',
        reason: 'Action 11',
        createdAt: now,
        createdRevision: current.revision + 1,
      },
    });
    expectSuccess(current);

    // 10 resolved actions previously existed. Retaining 4 resolved actions means 6 were archived!
    expect(current.data.resolvedActionArchive.count).toBe(6);
    expect(current.data.resolvedActionArchive.chainDigest).not.toBe(
      initialActionArchiveChainDigest(),
    );
    expect(current.data.actionsRequired.length).toBe(5); // 4 resolved + 1 unresolved

    // Fill up to 16 unresolved actions
    for (let j = 12; j <= 22; j++) {
      now += 10;
      current = store.mutate(root, current.revision, {
        type: 'append_action',
        action: {
          id: `act_${j}`,
          code: 'manual_intervention',
          referenceId: `ref_${j}`,
          reason: `Unresolved action ${j}`,
          createdAt: now,
          createdRevision: current.revision + 1,
        },
      });
      expectSuccess(current);
    }

    // Now unresolved actions count is 12 + 4 resolved = 16.
    // Let's add 4 more unresolved actions to get 16 unresolved (archiving the 4 resolved):
    for (let k = 23; k <= 26; k++) {
      now += 10;
      current = store.mutate(root, current.revision, {
        type: 'append_action',
        action: {
          id: `act_${k}`,
          code: 'manual_intervention',
          referenceId: `ref_${k}`,
          reason: `Unresolved action ${k}`,
          createdAt: now,
          createdRevision: current.revision + 1,
        },
      });
      expectSuccess(current);
    }

    expect(current.data.actionsRequired.length).toBe(16);
    expect(
      current.data.actionsRequired.every((a) => a.resolvedAt === undefined),
    ).toBe(true);

    const capacityFile = store.recordPath(root);
    const bytesBeforeCapacityFailure = fs.readFileSync(capacityFile, 'utf8');
    const recordBeforeCapacityFailure = structuredClone(current.data);

    // Now unresolved actions count is 16. Adding another action must fail with action_capacity_exhausted!
    now += 10;
    const overflowAction = store.mutate(root, current.revision, {
      type: 'append_action',
      action: {
        id: 'act_overflow',
        code: 'manual_intervention',
        referenceId: 'ref_overflow',
        reason: 'Capacity overflow',
        createdAt: now,
        createdRevision: current.revision + 1,
      },
    });
    expect(overflowAction.success).toBe(false);
    expect(overflowAction.code).toBe('action_capacity_exhausted');
    expect(fs.readFileSync(capacityFile, 'utf8')).toBe(
      bytesBeforeCapacityFailure,
    );
    const afterCapacityFailure = store.read(root);
    expectSuccess(afterCapacityFailure);
    expect(afterCapacityFailure.data).toEqual(recordBeforeCapacityFailure);
  });

  test('idle operations reconciliation is idempotent and marks running ops interrupted', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_idle',
      clock: () => now,
    });
    const root = 'root_idle_reconcile';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Start two running operations in current epoch
    current = store.mutate(root, current.revision, {
      type: 'start_operation',
      operation: {
        id: 'op_idle_1',
        callId: 'call_idle_1',
        toolName: 'bash',
        argumentDigest: hash('idle_1'),
        serverEpoch: 'epoch_idle',
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'start_operation',
      operation: {
        id: 'op_idle_2',
        callId: 'call_idle_2',
        toolName: 'bash',
        argumentDigest: hash('idle_2'),
        serverEpoch: 'epoch_idle',
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
    });
    expectSuccess(current);

    // Reconcile idle operations
    const idle1 = store.reconcileIdleOperations(root);
    expectSuccess(idle1);
    expect(idle1.status).toBe('written');
    expect(idle1.data.operations[0].status).toBe('interrupted');
    expect(idle1.data.operations[0].error).toBe(
      'Session became idle without a durable tool after-hook',
    );
    expect(idle1.data.operations[1].status).toBe('interrupted');
    expect(idle1.data.actionsRequired).toHaveLength(0); // No actions created for idle interruption

    // Second idle call is an idempotent no-op
    const idle2 = store.reconcileIdleOperations(root);
    expectSuccess(idle2);
    expect(idle2.status).toBe('noop');
    expect(idle2.revision).toBe(idle1.revision);
  });

  test('provenance invariants enforce external_user for authority transitions and reject legacy_unverified', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_prov',
      clock: () => now,
    });
    const root = 'root_prov_test';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Append legacy_unverified user receipt
    current = store.mutate(root, current.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_legacy',
        messageId: 'msg_legacy',
        contentDigest: hash('legacy_text'),
        observedEpoch: 'epoch_prov',
        observedAt: now,
        createdRevision: current.revision + 1,
        provenance: 'legacy_unverified',
      },
    });
    expectSuccess(current);

    // 1. Resolve action with legacy_unverified -> rejected
    current = store.mutate(root, current.revision, {
      type: 'append_action',
      action: {
        id: 'act_prov_1',
        code: 'manual_intervention',
        referenceId: 'ref_prov_1',
        reason: 'Needs resolution',
        createdAt: now,
        createdRevision: current.revision + 1,
      },
    });
    expectSuccess(current);

    const badActionResolve = store.mutate(root, current.revision, {
      type: 'resolve_action',
      actionId: 'act_prov_1',
      reason: 'Attempt resolution with legacy receipt',
      sourceUserMessageReceiptId: 'usr_legacy',
    });
    expect(badActionResolve.success).toBe(false);

    // 2. Resolve decision with legacy_unverified -> rejected
    current = store.mutate(root, current.revision, {
      type: 'append_decision',
      receipt: {
        id: 'dec_prov_1',
        decisionNeeded: 'Select option',
        options: ['Opt A', 'Opt B'],
        blocking: true,
        createdAt: now,
        createdRevision: current.revision + 1,
      },
    });
    expectSuccess(current);

    const badDecisionResolve = store.mutate(root, current.revision, {
      type: 'resolve_decision',
      decisionId: 'dec_prov_1',
      chosenOption: 'Opt A',
      sourceUserMessageReceiptId: 'usr_legacy',
      decidedAt: now + 10,
    });
    expect(badDecisionResolve.success).toBe(false);

    // 3. Contract authority revision with legacy_unverified -> rejected
    const newContract = contract({
      objective: 'Materially revised objective',
      sourceMessageIds: ['msg_root', 'msg_legacy'],
    });
    const badRevise = store.mutate(root, current.revision, {
      type: 'revise_contract',
      contract: newContract,
      sourceUserMessageReceiptId: 'usr_legacy',
    });
    expect(badRevise.success).toBe(false);

    // Append external_user message
    current = store.mutate(root, current.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_external',
        messageId: 'msg_external',
        contentDigest: hash('external_text'),
        observedEpoch: 'epoch_prov',
        observedAt: now + 50,
        createdRevision: current.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(current);

    // Now resolve action, decision, and contract revision with external_user -> succeeds!
    const goodActionResolve = store.mutate(root, current.revision, {
      type: 'resolve_action',
      actionId: 'act_prov_1',
      reason: 'Valid resolution with external user receipt',
      sourceUserMessageReceiptId: 'usr_external',
    });
    expectSuccess(goodActionResolve);
    current = goodActionResolve;

    const goodDecisionResolve = store.mutate(root, current.revision, {
      type: 'resolve_decision',
      decisionId: 'dec_prov_1',
      chosenOption: 'Opt A',
      sourceUserMessageReceiptId: 'usr_external',
      decidedAt: now + 60,
    });
    expectSuccess(goodDecisionResolve);
    current = goodDecisionResolve;

    const validContract = contract({
      objective: 'Materially revised objective',
      sourceMessageIds: ['msg_root', 'msg_external'],
    });
    const goodRevise = store.mutate(root, current.revision, {
      type: 'revise_contract',
      contract: validContract,
      sourceUserMessageReceiptId: 'usr_external',
    });
    expectSuccess(goodRevise);
  });

  test('sanitized issue #397 V1 fixture normalizes to legacy_late_missing, compacts actions, reconciles idle ops, and blocks finalization', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_397',
      clock: () => now,
    });
    const c = contract();
    const cDigest = computeOutcomeContractDigest(c);
    const candidate = hash('cand_397');

    // Build sanitized V1 fixture matching Terrarium issue #397 anatomy:
    // 1 ACCEPT final review summary, NO kickoff review summary, 16 resolved actions, 3 running operations
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
      rootSessionId: 'root_terrarium_397',
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
        rootSessionId: 'root_terrarium_397',
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
          rootSessionId: 'root_terrarium_397',
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

    const file = store.recordPath('root_terrarium_397');
    fs.writeFileSync(file, `${JSON.stringify(v1Fixture, null, 2)}\n`);

    // 1. Read & Normalize
    const readRes = store.read('root_terrarium_397');
    expectSuccess(readRes);
    expect(readRes.data.schemaVersion).toBe(2);
    expect(readRes.data.kickoffGate.state).toBe('legacy_late_missing');
    expect(readRes.data.kickoffGate.authenticatedReviewId).toBeUndefined();
    // Retrospective kickoff is deterministically retired
    expect(readRes.data.checkpoint?.state).toBe('retired');
    expect(readRes.data.phase).toBe('failed');

    // 2. Reconciling the retrospective kickoff cannot authenticate or add kickoff summary
    const reconcileAttempt = store.persistReconciledReview(
      'root_terrarium_397',
      {
        outcome: 'valid',
        checkpointId: 'chk_kickoff_retrospective_18',
        claimGeneration: 18,
        claimToken: 'token_18',
        resultDigest: hash('res_retro'),
        review: reviewFor(readRes.data, 'CONTINUE'),
      },
    );
    expect(reconcileAttempt.success).toBe(false);

    // 3. Retrospective kickoff is blocked
    const retroKickoff = store.mutate(
      'root_terrarium_397',
      readRes.data.revision,
      {
        type: 'open_checkpoint',
        kind: 'kickoff',
        reason: 'Retrospective kickoff attempt',
        claimToken: 'token_retro',
        expiresAt: 10_000,
      },
    );
    expect(retroKickoff.success).toBe(false);
    expect(retroKickoff.code).toBe('retrospective_kickoff_forbidden');

    // 4. Finalization fails because kickoff was never authenticated
    const finalizeRes = store.mutate(
      'root_terrarium_397',
      readRes.data.revision,
      {
        type: 'finalize',
        summary: 'Cannot finalize legacy missing kickoff record',
      },
    );
    expect(finalizeRes.success).toBe(false);

    // 5. Action archiving compacts the 16 resolved actions leaving headroom
    const addActionRes = store.mutate(
      'root_terrarium_397',
      readRes.data.revision,
      {
        type: 'append_action',
        action: {
          id: 'act_new_397',
          code: 'manual_intervention',
          referenceId: 'ref_new_397',
          reason: 'New action after migration',
          createdAt: 3_000,
          createdRevision: readRes.data.revision + 1,
        },
      },
    );
    expectSuccess(addActionRes);
    expect(addActionRes.data.resolvedActionArchive.count).toBe(12);
    expect(addActionRes.data.actionsRequired.length).toBe(5); // 4 retained resolved + 1 new

    // 6. Idle operations reconciliation marks the 3 running ops as interrupted
    const idleRes = store.reconcileIdleOperations('root_terrarium_397');
    expectSuccess(idleRes);
    expect(
      idleRes.data.operations.every((op) => op.status === 'interrupted'),
    ).toBe(true);

    // 7. Repeated idle call is a no-op
    const idleRepeat = store.reconcileIdleOperations('root_terrarium_397');
    expectSuccess(idleRepeat);
    expect(idleRepeat.status).toBe('noop');
  });

  test('centralized checkpoint kind and verdict validation rejects non-final ACCEPT preflight and in mutation', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_verdict',
      clock: () => now,
    });
    const root = 'root_verdict_test';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    const { claim: kickoffClaim } = openCheckpoint(
      store,
      root,
      current.revision,
      'token_v1',
      'kickoff',
    );
    current = store.read(root);
    expectSuccess(current);

    // Prepare an ACCEPT review for kickoff checkpoint
    const acceptReview = reviewFor(current.data, 'ACCEPT');

    // 1. validateReview preflight rejects ACCEPT on kickoff
    const preflight = store.validateReview(root, {
      checkpointId: kickoffClaim.checkpointId,
      claimGeneration: kickoffClaim.claimGeneration,
      claimToken: 'token_v1',
      resultDigest: hash('result_v1'),
      review: acceptReview,
    });
    expect(preflight.success).toBe(false);
    expect(preflight.error.message).toContain(
      'ACCEPT verdict is valid only for final checkpoint',
    );

    // 2. persistReconciledReview rejects ACCEPT on kickoff before consumption
    const persistRes = store.persistReconciledReview(root, {
      outcome: 'valid',
      checkpointId: kickoffClaim.checkpointId,
      claimGeneration: kickoffClaim.claimGeneration,
      claimToken: 'token_v1',
      resultDigest: hash('result_v1'),
      review: acceptReview,
    });
    expect(persistRes.success).toBe(false);

    // 3. Direct mutation rejects ACCEPT on kickoff
    current = store.mutate(root, current.revision, {
      type: 'mark_dispatching',
      checkpointId: kickoffClaim.checkpointId,
      claimGeneration: kickoffClaim.claimGeneration,
      claimToken: 'token_v1',
      dispatchCallId: 'call_v1',
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'bind_manager',
      checkpointId: kickoffClaim.checkpointId,
      claimGeneration: kickoffClaim.claimGeneration,
      claimToken: 'token_v1',
      managerTaskId: 'mgr_v1',
      managerGeneration: 1,
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'mark_result_available',
      checkpointId: kickoffClaim.checkpointId,
      claimGeneration: kickoffClaim.claimGeneration,
      claimToken: 'token_v1',
      resultDigest: hash('result_v1'),
    });
    expectSuccess(current);

    const directMutation = store.mutate(root, current.revision, {
      type: 'record_review',
      checkpointId: kickoffClaim.checkpointId,
      claimGeneration: kickoffClaim.claimGeneration,
      claimToken: 'token_v1',
      resultDigest: hash('result_v1'),
      review: acceptReview,
    });
    expect(directMutation.success).toBe(false);
    expect(directMutation.error.message).toContain(
      'ACCEPT verdict is valid only for final checkpoint',
    );
  });

  test('contract digest change resets kickoff attempts only with external_user authority', () => {
    let now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_auth_reset',
      clock: () => now,
    });
    const root = 'root_auth_reset';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Exhaust kickoff attempts (attempt 1 and attempt 2 fail)
    const { claim: k1 } = openCheckpoint(
      store,
      root,
      current.revision,
      'token_1',
      'kickoff',
      {
        expiresAt: now + 5_000,
      },
    );
    current = store.read(root);
    expectSuccess(current);
    now += 20_000;
    current = store.mutate(root, current.revision, {
      type: 'expire_checkpoint',
      checkpointId: k1.checkpointId,
      claimGeneration: k1.claimGeneration,
      claimToken: 'token_1',
      reason: 'Expired attempt 1',
    });
    expectSuccess(current);

    const { claim: k2 } = openCheckpoint(
      store,
      root,
      current.revision,
      'token_2',
      'kickoff',
      {
        expiresAt: now + 5_000,
      },
    );
    current = store.read(root);
    expectSuccess(current);
    now += 20_000;
    current = store.mutate(root, current.revision, {
      type: 'expire_checkpoint',
      checkpointId: k2.checkpointId,
      claimGeneration: k2.claimGeneration,
      claimToken: 'token_2',
      reason: 'Expired attempt 2',
    });
    expectSuccess(current);
    expect(current.data.kickoffGate.state).toBe('exhausted');
    expect(current.data.kickoffGate.attempts).toBe(2);

    // Revise contract without external_user authority (e.g. deliverable change only)
    const tweakedContract = contract({
      deliverables: ['Modified deliverable A', 'Modified deliverable B'],
    });
    const unauthRevision = store.mutate(root, current.revision, {
      type: 'revise_contract',
      contract: tweakedContract,
    });
    expectSuccess(unauthRevision);
    // Gate state and attempts MUST remain preserved as exhausted!
    expect(unauthRevision.data.kickoffGate.state).toBe('exhausted');
    expect(unauthRevision.data.kickoffGate.attempts).toBe(2);

    // Add external_user message
    const extUserRes = store.mutate(root, unauthRevision.data.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_ext_auth',
        messageId: 'msg_ext_auth',
        contentDigest: hash('authorized_revision_text'),
        observedEpoch: 'epoch_auth_reset',
        observedAt: now + 50,
        createdRevision: unauthRevision.data.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(extUserRes);

    // Revise contract with external_user authority -> resets kickoff gate to required with 0 attempts!
    const authContract = contract({
      objective: 'Externally authorized new objective',
      sourceMessageIds: ['msg_root', 'msg_ext_auth'],
    });
    const authRevision = store.mutate(root, extUserRes.data.revision, {
      type: 'revise_contract',
      contract: authContract,
      sourceUserMessageReceiptId: 'usr_ext_auth',
    });
    expectSuccess(authRevision);
    expect(authRevision.data.kickoffGate.state).toBe('required');
    expect(authRevision.data.kickoffGate.attempts).toBe(0);

    // No-op revision preserves state without reset
    const noopRevision = store.mutate(root, authRevision.data.revision, {
      type: 'revise_contract',
      contract: authContract,
    });
    expectSuccess(noopRevision);
    expect(noopRevision.data.kickoffGate.state).toBe('required');
    expect(noopRevision.data.kickoffGate.attempts).toBe(0);
  });

  test('matching-digest completion is a true no-op returning status noop and identical bytes/revision', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_noop_comp',
      clock: () => now,
    });
    const root = 'root_noop_comp';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    const callId = 'call_noop_1';
    current = store.mutate(root, current.revision, {
      type: 'start_tool_call',
      operation: {
        id: `op_${callId}`,
        callId,
        toolName: 'bash',
        argumentDigest: hash('arg_1'),
        serverEpoch: 'epoch_noop_comp',
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
      observation: {
        id: `obs_${callId}`,
        kind: 'controller_observed',
        callId,
        toolName: 'bash',
        argumentDigest: hash('arg_1'),
        startedEpoch: 'epoch_noop_comp',
        startedAt: now,
        completionObserved: false,
      },
    });
    expectSuccess(current);

    const outputDigest = hash('out_1');
    const complete1 = store.mutate(root, current.revision, {
      type: 'complete_tool_call',
      operationId: `op_${callId}`,
      observationId: `obs_${callId}`,
      outputDigest,
      completedEpoch: 'epoch_noop_comp',
      completedAt: now + 5,
    });
    expectSuccess(complete1);
    expect(complete1.status).toBe('written');
    const revAfterComplete = complete1.data.revision;

    const file = store.recordPath(root);
    const bytesBeforeNoop = fs.readFileSync(file, 'utf8');

    // Second matching complete_tool_call is a true no-op: no write, same revision, status 'noop'
    const completeNoop = store.mutate(root, revAfterComplete, {
      type: 'complete_tool_call',
      operationId: `op_${callId}`,
      observationId: `obs_${callId}`,
      outputDigest,
      completedEpoch: 'epoch_noop_comp',
      completedAt: now + 5,
    });
    expectSuccess(completeNoop);
    expect(completeNoop.status).toBe('noop');
    expect(completeNoop.revision).toBe(revAfterComplete);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytesBeforeNoop);

    // Conflicting output digest fails
    const conflicting = store.mutate(root, revAfterComplete, {
      type: 'complete_tool_call',
      operationId: `op_${callId}`,
      observationId: `obs_${callId}`,
      outputDigest: hash('conflicting_output'),
      completedEpoch: 'epoch_noop_comp',
      completedAt: now + 5,
    });
    expect(conflicting.success).toBe(false);
    expect(conflicting.code).toBe('invalid_transition');
  });

  test('third kickoff and capacity failures assert identical serialized bytes and state', () => {
    let now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_byte_assert',
      clock: () => now,
    });
    const root = 'root_byte_assert';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Consume attempt 1 and attempt 2
    const { claim: k1 } = openCheckpoint(
      store,
      root,
      current.revision,
      't1',
      'kickoff',
      {
        expiresAt: now + 5_000,
      },
    );
    current = store.read(root);
    expectSuccess(current);
    now += 20_000;
    current = store.mutate(root, current.revision, {
      type: 'expire_checkpoint',
      checkpointId: k1.checkpointId,
      claimGeneration: k1.claimGeneration,
      claimToken: 't1',
      reason: 'Expired 1',
    });
    expectSuccess(current);

    const { claim: k2 } = openCheckpoint(
      store,
      root,
      current.revision,
      't2',
      'kickoff',
      {
        expiresAt: now + 5_000,
      },
    );
    current = store.read(root);
    expectSuccess(current);
    now += 20_000;
    current = store.mutate(root, current.revision, {
      type: 'expire_checkpoint',
      checkpointId: k2.checkpointId,
      claimGeneration: k2.claimGeneration,
      claimToken: 't2',
      reason: 'Expired 2',
    });
    expectSuccess(current);
    expect(current.data.kickoffGate.state).toBe('exhausted');

    const file = store.recordPath(root);
    const bytesBeforeThirdKickoff = fs.readFileSync(file, 'utf8');
    const recordBeforeThirdKickoff = structuredClone(current.data);

    // 3rd kickoff fails with kickoff_retry_exhausted
    const thirdKickoff = store.mutate(root, current.revision, {
      type: 'open_checkpoint',
      kind: 'kickoff',
      reason: 'Third kickoff attempt',
      claimToken: 't3',
      expiresAt: now + 10_000,
    });
    expect(thirdKickoff.success).toBe(false);
    expect(thirdKickoff.code).toBe('kickoff_retry_exhausted');

    // Assert exact byte-for-byte identity and record field identity
    expect(fs.readFileSync(file, 'utf8')).toBe(bytesBeforeThirdKickoff);
    const reloaded = store.read(root);
    expectSuccess(reloaded);
    expect(reloaded.data.revision).toBe(recordBeforeThirdKickoff.revision);
    expect(reloaded.data.nextClaimGeneration).toBe(
      recordBeforeThirdKickoff.nextClaimGeneration,
    );
    expect(reloaded.data.checkpoint).toEqual(
      recordBeforeThirdKickoff.checkpoint,
    );
    expect(reloaded.data.resolvedActionArchive).toEqual(
      recordBeforeThirdKickoff.resolvedActionArchive,
    );
    expect(reloaded.data.actionsRequired).toEqual(
      recordBeforeThirdKickoff.actionsRequired,
    );
  });

  test('new user_decision authorization requires decision backed by external_user provenance', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_auth_prov',
      clock: () => now,
    });
    const root = 'root_auth_prov';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    // Append decision
    current = store.mutate(root, current.revision, {
      type: 'append_decision',
      receipt: {
        id: 'dec_legacy_test',
        decisionNeeded: 'Select option',
        options: ['Opt A', 'Opt B'],
        blocking: true,
        createdAt: now,
        createdRevision: current.revision + 1,
      },
    });
    expectSuccess(current);

    // Append legacy_unverified user receipt
    current = store.mutate(root, current.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_legacy_auth',
        messageId: 'msg_legacy_auth',
        contentDigest: hash('legacy_decision_reply'),
        observedEpoch: 'epoch_auth_prov',
        observedAt: now + 5,
        createdRevision: current.revision + 1,
        provenance: 'legacy_unverified',
      },
    });
    expectSuccess(current);

    // Resolve decision with legacy_unverified fails
    const badDecisionResolve = store.mutate(root, current.revision, {
      type: 'resolve_decision',
      decisionId: 'dec_legacy_test',
      chosenOption: 'Opt A',
      sourceUserMessageReceiptId: 'usr_legacy_auth',
      decidedAt: now + 10,
    });
    expect(badDecisionResolve.success).toBe(false);

    // Append external_user message
    current = store.mutate(root, current.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_ext_auth_2',
        messageId: 'msg_ext_auth_2',
        contentDigest: hash('ext_decision_reply'),
        observedEpoch: 'epoch_auth_prov',
        observedAt: now + 15,
        createdRevision: current.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(current);

    // Resolve decision with external_user succeeds
    current = store.mutate(root, current.revision, {
      type: 'resolve_decision',
      decisionId: 'dec_legacy_test',
      chosenOption: 'Opt A',
      sourceUserMessageReceiptId: 'usr_ext_auth_2',
      decidedAt: now + 20,
    });
    expectSuccess(current);

    // Append user_decision authorization for external-user backed decision succeeds
    const authReceipt = {
      id: 'auth_dec_1',
      kind: 'user_decision' as const,
      reference: 'dec_legacy_test',
      payloadDigest: '',
      decisionId: 'dec_legacy_test',
      observedAt: now + 25,
    };
    authReceipt.payloadDigest = computeOutcomeAuthorizationDigest(authReceipt);
    const appendAuthRes = store.mutate(root, current.revision, {
      type: 'append_authorization',
      receipt: authReceipt,
    });
    expectSuccess(appendAuthRes);
  });

  test('successful replay: invalid kickoff, resolved action, retry CONTINUE authenticates, final ACCEPT and finalize succeeds', () => {
    let now = 1_000;
    const candidate = hash('candidate_replay');
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_replay',
      clock: () => now,
    });
    const root = 'root_replay_success';
    let current = store.init(root, {
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
    expect(current.data.kickoffGate.state).toBe('required');

    // 1. Kickoff attempt 1 opens
    const { claim: k1Claim } = openCheckpoint(
      store,
      root,
      current.revision,
      'token_k1',
      'kickoff',
    );
    current = store.read(root);
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(1);

    // 2. Kickoff 1 fails with invalid review (records action)
    current = store.mutate(root, current.revision, {
      type: 'mark_dispatching',
      checkpointId: k1Claim.checkpointId,
      claimGeneration: k1Claim.claimGeneration,
      claimToken: 'token_k1',
      dispatchCallId: 'call_k1',
    });
    expectSuccess(current);
    current = store.mutate(root, current.revision, {
      type: 'record_invalid_dispatch',
      checkpointId: k1Claim.checkpointId,
      claimGeneration: k1Claim.claimGeneration,
      reason: 'Manager returned malformed kickoff payload',
    });
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(1);
    expect(current.data.kickoffGate.state).toBe('required');

    // 3. User provides external_user receipt to resolve action
    now += 100;
    current = store.mutate(root, current.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_replay_1',
        messageId: 'msg_replay_1',
        contentDigest: hash('user_authorizes_kickoff_retry'),
        observedEpoch: 'epoch_replay',
        observedAt: now,
        createdRevision: current.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(current);

    const actionToResolve = current.data.actionsRequired.find(
      (a) => a.resolvedAt === undefined,
    );
    expect(actionToResolve).toBeDefined();
    if (!actionToResolve) return;

    current = store.mutate(root, current.revision, {
      type: 'resolve_action',
      actionId: actionToResolve.id,
      reason: 'User approved kickoff retry with corrected prompt',
      sourceUserMessageReceiptId: 'usr_replay_1',
    });
    expectSuccess(current);

    // 4. Kickoff attempt 2 opens
    now += 100;
    openCheckpoint(store, root, current.revision, 'token_k2', 'kickoff');
    current = store.read(root);
    expectSuccess(current);
    expect(current.data.kickoffGate.attempts).toBe(2);

    // 5. Kickoff 2 completes with CONTINUE -> authenticates kickoffGate!
    current = completeReview(
      store,
      root,
      current.revision,
      'token_k2',
      'CONTINUE',
    );
    expect(current.data.kickoffGate.state).toBe('authenticated');
    expect(current.data.kickoffGate.authenticatedReviewId).toBeDefined();

    // 6. Submit final evidence attestation
    const entry = {
      id: 'att_replay_final',
      kind: 'orchestrator_attestation' as const,
      description: 'bun test replay passes',
      assertedStatus: 'passed' as const,
      assertedFreshness: 'fresh' as const,
      candidateFingerprint: candidate,
      payloadDigest: '',
      createdRevision: current.revision + 1,
      createdAt: now + 500,
    };
    entry.payloadDigest = attestationDigest(entry);
    current = store.mutate(root, current.revision, {
      type: 'append_evidence',
      entry,
    });
    expectSuccess(current);

    // 7. Open final checkpoint and complete with ACCEPT
    openCheckpoint(store, root, current.revision, 'token_final', 'final', {
      candidateFingerprint: candidate,
      evidenceAttestationIds: ['att_replay_final'],
    });
    current = store.read(root);
    expectSuccess(current);
    current = completeReview(
      store,
      root,
      current.revision,
      'token_final',
      'ACCEPT',
    );

    // 8. Finalize outcome -> certificate successfully minted!
    const finalizeRes = store.mutate(root, current.revision, {
      type: 'finalize',
      summary: 'Outcome completed and verified after bounded kickoff recovery',
    });
    expectSuccess(finalizeRes);
    expect(finalizeRes.data.phase).toBe('accepted');
    expect(finalizeRes.data.finalCertificate).toBeDefined();
    expect(finalizeRes.data.finalCertificate?.outcomeId).toBe(
      finalizeRes.data.outcomeId,
    );
  });

  test('atomic user message identity preserves bytes/revision on duplicate, fails closed on conflicting reuse and stale CAS, and never upgrades legacy provenance', () => {
    const now = 1_000;
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_msg_atomic',
      clock: () => now,
    });
    const root = 'root_msg_atomic';
    const current = store.init(root, { contract: contract() });
    expectSuccess(current);
    const initialRev = current.revision;

    const msgId = 'msg_host_durable_1';
    const contentDigest = hash('user said do something');

    // First append -> writes new revision
    const firstAppend = store.mutate(root, initialRev, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_1',
        messageId: msgId,
        contentDigest,
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now,
        createdRevision: initialRev + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(firstAppend);
    expect(firstAppend.status).toBe('written');
    expect(firstAppend.revision).toBe(initialRev + 1);

    const recordFile = store.recordPath(root);
    const bytesAfterFirst = fs.readFileSync(recordFile, 'utf8');

    // Exact duplicate with current revision -> true no-op, bytes and revision unchanged
    const duplicateAppend = store.mutate(root, firstAppend.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_2',
        messageId: msgId,
        contentDigest,
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 10,
        createdRevision: firstAppend.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(duplicateAppend);
    expect(duplicateAppend.status).toBe('noop');
    expect(duplicateAppend.revision).toBe(firstAppend.revision);
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterFirst);

    const paddedDuplicate = store.mutate(root, firstAppend.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_padded',
        messageId: `  ${msgId}  `,
        contentDigest,
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 15,
        createdRevision: firstAppend.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(paddedDuplicate);
    expect(paddedDuplicate.status).toBe('noop');
    expect(paddedDuplicate.revision).toBe(firstAppend.revision);
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterFirst);

    const paddedConflict = store.mutate(root, firstAppend.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_padded_conflict',
        messageId: `\t${msgId}\n`,
        contentDigest: hash('padded conflicting content'),
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 16,
        createdRevision: firstAppend.revision + 1,
        provenance: 'external_user',
      },
    });
    expect(paddedConflict.success).toBe(false);
    expect(paddedConflict.code).toBe('invalid_transition');
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterFirst);

    // Exact duplicate with stale revision (concurrent CAS case) -> succeeds as no-op before CAS check
    const staleRevisionDuplicate = store.mutate(root, initialRev, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_3',
        messageId: msgId,
        contentDigest,
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 20,
        createdRevision: initialRev + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(staleRevisionDuplicate);
    expect(staleRevisionDuplicate.status).toBe('noop');
    expect(staleRevisionDuplicate.revision).toBe(firstAppend.revision);
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterFirst);

    // Conflicting content digest on existing messageId with current revision -> fails closed, unchanged bytes/revision
    const conflictingDigest = store.mutate(root, firstAppend.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_4',
        messageId: msgId,
        contentDigest: hash('user said something conflicting'),
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 30,
        createdRevision: firstAppend.revision + 1,
        provenance: 'external_user',
      },
    });
    expect(conflictingDigest.success).toBe(false);
    expect(conflictingDigest.code).toBe('invalid_transition');
    expect(conflictingDigest.error.message).toContain(
      'already recorded with different content',
    );
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterFirst);

    // Conflicting content digest with stale revision -> also fails closed without CAS conflict
    const staleConflicting = store.mutate(root, initialRev, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_receipt_5',
        messageId: msgId,
        contentDigest: hash('user said something conflicting'),
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 40,
        createdRevision: initialRev + 1,
        provenance: 'external_user',
      },
    });
    expect(staleConflicting.success).toBe(false);
    expect(staleConflicting.code).toBe('invalid_transition');
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterFirst);

    // Legacy compatibility: duplicate append over legacy_unverified receipt does not upgrade provenance
    const legacyRoot = 'root_msg_legacy_compat';
    const legacyDigest = hash('legacy user message');
    const legacyV1 = {
      schema: 'omos_outcome_record',
      schemaVersion: 1,
      outcomeId: 'out_legacy_msg',
      rootSessionId: legacyRoot,
      serverEpoch: 'epoch_msg_atomic',
      revision: 5,
      nextClaimGeneration: 1,
      contractDigest: computeOutcomeContractDigest(contract()),
      createdAt: 1000,
      updatedAt: 1000,
      phase: 'active',
      contract: contract(),
      receipts: {
        evidence: [],
        userMessages: [
          {
            id: 'usr_legacy_1',
            messageId: 'msg_legacy_host_1',
            contentDigest: legacyDigest,
            observedEpoch: 'epoch_msg_atomic',
            observedAt: 1000,
            createdRevision: 3,
          },
          {
            id: 'usr_legacy_duplicate',
            messageId: '  msg_legacy_host_1  ',
            contentDigest: legacyDigest,
            observedEpoch: 'epoch_msg_atomic',
            observedAt: 1001,
            createdRevision: 4,
          },
        ],
        decisions: [
          {
            id: 'dec_legacy_duplicate_ref',
            decisionNeeded: 'Retain duplicate reference identity',
            options: ['yes'],
            blocking: true,
            createdAt: 999,
            createdRevision: 1,
            chosenOption: 'yes',
            sourceUserMessageReceiptId: 'usr_legacy_duplicate',
            decidedAt: 1002,
          },
        ],
        authorizations: [],
      },
      reviewSummaries: [],
      operations: [],
      actionsRequired: [
        {
          id: 'action_legacy_duplicate_ref',
          code: 'manual_intervention',
          referenceId: 'legacy-ref',
          reason: 'Retain duplicate action reference identity',
          createdAt: 998,
          createdRevision: 1,
          resolvedAt: 1002,
          resolutionKind: 'orchestrator_provenance',
          resolutionReason: 'Legacy user resolved the action',
          resolutionUserMessageReceiptId: 'usr_legacy_duplicate',
        },
      ],
    };
    fs.writeFileSync(
      store.recordPath(legacyRoot),
      JSON.stringify(legacyV1, null, 2),
    );

    const readLegacy = store.read(legacyRoot);
    expectSuccess(readLegacy);
    expect(readLegacy.data.receipts.userMessages[0].provenance).toBe(
      'legacy_unverified',
    );
    expect(readLegacy.data.receipts.userMessages).toHaveLength(1);
    expect(
      readLegacy.data.receipts.decisions[0].sourceUserMessageReceiptId,
    ).toBe('usr_legacy_1');
    expect(
      readLegacy.data.actionsRequired[0].resolutionUserMessageReceiptId,
    ).toBe('usr_legacy_1');
    const legacyBytesBefore = fs.readFileSync(
      store.recordPath(legacyRoot),
      'utf8',
    );

    // Attempt to append duplicate message with external_user provenance
    const appendOverLegacy = store.mutate(legacyRoot, readLegacy.revision, {
      type: 'append_user_message',
      receipt: {
        id: 'usr_legacy_attempt_upgrade',
        messageId: 'msg_legacy_host_1',
        contentDigest: legacyDigest,
        observedEpoch: 'epoch_msg_atomic',
        observedAt: now + 50,
        createdRevision: readLegacy.revision + 1,
        provenance: 'external_user',
      },
    });
    expectSuccess(appendOverLegacy);
    expect(appendOverLegacy.status).toBe('noop');
    expect(fs.readFileSync(store.recordPath(legacyRoot), 'utf8')).toBe(
      legacyBytesBefore,
    );

    const reReadLegacy = store.read(legacyRoot);
    expectSuccess(reReadLegacy);
    expect(reReadLegacy.data.receipts.userMessages[0].provenance).toBe(
      'legacy_unverified',
    );
  });

  test('late authoritative after-hook repairs idle-interrupted operations and rejects restart/failed/acknowledged/epoch mismatches', () => {
    const now = 1_000;
    const epoch = 'epoch_late_repair';
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: epoch,
      clock: () => now,
    });
    const root = 'root_late_repair';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    const callId = 'call_repair_target';
    const opId = `op_${callId}`;
    const obsId = `obs_${callId}`;
    const argDigest = hash('repair_arg');
    const outDigest = hash('repair_output');

    // 1. Start running tool call
    current = store.mutate(root, current.revision, {
      type: 'start_tool_call',
      operation: {
        id: opId,
        callId,
        toolName: 'bash',
        argumentDigest: argDigest,
        serverEpoch: epoch,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
      observation: {
        id: obsId,
        kind: 'controller_observed',
        callId,
        toolName: 'bash',
        argumentDigest: argDigest,
        startedEpoch: epoch,
        startedAt: now,
        completionObserved: false,
      },
    });
    expectSuccess(current);

    // 2. Session becomes idle -> operation is marked interrupted
    const idleRes = store.reconcileIdleOperations(root);
    expectSuccess(idleRes);
    const interruptedOp = idleRes.data.operations.find((o) => o.id === opId);
    expect(interruptedOp?.status).toBe('interrupted');
    expect(interruptedOp?.error).toBe(
      'Session became idle without a durable tool after-hook',
    );

    // 3. Late authoritative complete_tool_call repairs the operation to completed and clears error
    const repairRes = store.mutate(root, idleRes.revision, {
      type: 'complete_tool_call',
      operationId: opId,
      observationId: obsId,
      outputDigest: outDigest,
      completedEpoch: epoch,
      completedAt: now + 50,
    });
    expectSuccess(repairRes);
    expect(repairRes.status).toBe('written');
    const repairedOp = repairRes.data.operations.find((o) => o.id === opId);
    expect(repairedOp?.status).toBe('completed');
    expect(repairedOp?.error).toBeUndefined();
    const repairedObs = repairRes.data.receipts.evidence.find(
      (e) => e.id === obsId,
    );
    expect(repairedObs?.kind).toBe('controller_observed');
    if (repairedObs?.kind === 'controller_observed') {
      expect(repairedObs.completionObserved).toBe(true);
      expect(repairedObs.outputDigest).toBe(outDigest);
      expect(repairedObs.completedEpoch).toBe(epoch);
    }

    const recordFile = store.recordPath(root);
    const bytesAfterRepair = fs.readFileSync(recordFile, 'utf8');

    // 4. Repeated identical late after-hook is a true no-op
    const repeatRepair = store.mutate(root, repairRes.revision, {
      type: 'complete_tool_call',
      operationId: opId,
      observationId: obsId,
      outputDigest: outDigest,
      completedEpoch: epoch,
      completedAt: now + 50,
    });
    expectSuccess(repeatRepair);
    expect(repeatRepair.status).toBe('noop');
    expect(repeatRepair.revision).toBe(repairRes.revision);
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterRepair);

    // 5. Conflicting output digest fails closed
    const conflictingLate = store.mutate(root, repairRes.revision, {
      type: 'complete_tool_call',
      operationId: opId,
      observationId: obsId,
      outputDigest: hash('different_output'),
      completedEpoch: epoch,
      completedAt: now + 50,
    });
    expect(conflictingLate.success).toBe(false);
    expect(conflictingLate.code).toBe('invalid_transition');
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(bytesAfterRepair);

    // 6. Fail-closed rejection tests for invalid repair transitions:
    // a) Restart-interrupted operation cannot be completed by late after-hook
    const restartRoot = 'root_late_restart_rej';
    const oldStore = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_old_1',
      clock: () => now,
    });
    let restartRec = oldStore.init(restartRoot, { contract: contract() });
    expectSuccess(restartRec);
    restartRec = oldStore.mutate(restartRoot, restartRec.revision, {
      type: 'start_tool_call',
      operation: {
        id: 'op_restart_call',
        callId: 'call_restart_call',
        toolName: 'bash',
        argumentDigest: hash('restart_arg'),
        serverEpoch: 'epoch_old_1',
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
      observation: {
        id: 'obs_restart_call',
        kind: 'controller_observed',
        callId: 'call_restart_call',
        toolName: 'bash',
        argumentDigest: hash('restart_arg'),
        startedEpoch: 'epoch_old_1',
        startedAt: now,
        completionObserved: false,
      },
    });
    expectSuccess(restartRec);

    // Recover in new store -> operation marked interrupted by restart
    const newStore = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: 'epoch_new_2',
      clock: () => now,
    });
    const recovered = newStore.recover(restartRoot);
    expectSuccess(recovered);
    expect(recovered.data.operations[0].status).toBe('interrupted');
    expect(recovered.data.operations[0].error).toBe(
      'Operation interrupted by process restart',
    );

    const restartLateAttempt = newStore.mutate(
      restartRoot,
      recovered.revision,
      {
        type: 'complete_tool_call',
        operationId: 'op_restart_call',
        observationId: 'obs_restart_call',
        outputDigest: hash('out_restart'),
        completedEpoch: 'epoch_new_2',
        completedAt: now + 10,
      },
    );
    expect(restartLateAttempt.success).toBe(false);
    expect(restartLateAttempt.code).toBe('invalid_transition');

    // b) Failed operation cannot be completed by late after-hook
    const failedRoot = 'root_late_failed_rej';
    let failedRec = store.init(failedRoot, { contract: contract() });
    expectSuccess(failedRec);
    failedRec = store.mutate(failedRoot, failedRec.revision, {
      type: 'start_tool_call',
      operation: {
        id: 'op_fail_call',
        callId: 'call_fail_call',
        toolName: 'bash',
        argumentDigest: hash('fail_arg'),
        serverEpoch: epoch,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
      observation: {
        id: 'obs_fail_call',
        kind: 'controller_observed',
        callId: 'call_fail_call',
        toolName: 'bash',
        argumentDigest: hash('fail_arg'),
        startedEpoch: epoch,
        startedAt: now,
        completionObserved: false,
      },
    });
    expectSuccess(failedRec);
    failedRec = store.mutate(failedRoot, failedRec.revision, {
      type: 'finish_operation',
      operationId: 'op_fail_call',
      status: 'failed',
      error: 'Tool process crashed',
    });
    expectSuccess(failedRec);

    const failedLateAttempt = store.mutate(failedRoot, failedRec.revision, {
      type: 'complete_tool_call',
      operationId: 'op_fail_call',
      observationId: 'obs_fail_call',
      outputDigest: hash('out_fail'),
      completedEpoch: epoch,
      completedAt: now + 10,
    });
    expect(failedLateAttempt.success).toBe(false);
    expect(failedLateAttempt.code).toBe('invalid_transition');

    // c) Acknowledged operation cannot be completed by late after-hook
    const ackRoot = 'root_late_ack_rej';
    let ackRec = store.init(ackRoot, { contract: contract() });
    expectSuccess(ackRec);
    ackRec = store.mutate(ackRoot, ackRec.revision, {
      type: 'start_tool_call',
      operation: {
        id: 'op_ack_call',
        callId: 'call_ack_call',
        toolName: 'bash',
        argumentDigest: hash('ack_arg'),
        serverEpoch: epoch,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      },
      observation: {
        id: 'obs_ack_call',
        kind: 'controller_observed',
        callId: 'call_ack_call',
        toolName: 'bash',
        argumentDigest: hash('ack_arg'),
        startedEpoch: epoch,
        startedAt: now,
        completionObserved: false,
      },
    });
    expectSuccess(ackRec);
    ackRec = store.reconcileIdleOperations(ackRoot);
    expectSuccess(ackRec);
    ackRec = store.mutate(ackRoot, ackRec.revision, {
      type: 'acknowledge_operation',
      operationId: 'op_ack_call',
    });
    expectSuccess(ackRec);
    expect(ackRec.data.operations[0].status).toBe('acknowledged');

    const ackLateAttempt = store.mutate(ackRoot, ackRec.revision, {
      type: 'complete_tool_call',
      operationId: 'op_ack_call',
      observationId: 'obs_ack_call',
      outputDigest: hash('out_ack'),
      completedEpoch: epoch,
      completedAt: now + 10,
    });
    expect(ackLateAttempt.success).toBe(false);
    expect(ackLateAttempt.code).toBe('invalid_transition');
  });

  test('completion and reload reject cross-paired operation observations without writes', () => {
    const epoch = 'epoch_exact_pair';
    const store = new OutcomeStore({
      storeDirectory: directory,
      serverEpoch: epoch,
      clock: () => 1_000,
    });
    const root = 'root_exact_pair';
    let current = store.init(root, { contract: contract() });
    expectSuccess(current);

    for (const [suffix, toolName] of [
      ['a', 'bash'],
      ['b', 'read'],
    ] as const) {
      current = store.mutate(root, current.revision, {
        type: 'start_tool_call',
        operation: {
          id: `op_pair_${suffix}`,
          callId: `call_pair_${suffix}`,
          toolName,
          argumentDigest: hash(`args_pair_${suffix}`),
          serverEpoch: epoch,
          status: 'running',
          startedAt: 1_000,
          updatedAt: 1_000,
        },
        observation: {
          id: `obs_pair_${suffix}`,
          kind: 'controller_observed',
          callId: `call_pair_${suffix}`,
          toolName,
          argumentDigest: hash(`args_pair_${suffix}`),
          startedEpoch: epoch,
          startedAt: 1_000,
          completionObserved: false,
        },
      });
      expectSuccess(current);
    }

    const file = store.recordPath(root);
    const bytesBefore = fs.readFileSync(file, 'utf8');
    const revisionBefore = current.revision;
    const crossPair = store.mutate(root, current.revision, {
      type: 'complete_tool_call',
      operationId: 'op_pair_a',
      observationId: 'obs_pair_b',
      outputDigest: hash('cross_pair_output'),
      completedEpoch: epoch,
      completedAt: 1_010,
    });
    expect(crossPair.success).toBe(false);
    expect(crossPair.code).toBe('invalid_transition');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytesBefore);
    const afterCrossPair = store.read(root);
    expectSuccess(afterCrossPair);
    expect(afterCrossPair.revision).toBe(revisionBefore);

    const malformed = JSON.parse(bytesBefore) as {
      operations: Array<{ toolName: string }>;
    };
    malformed.operations[0].toolName = 'write';
    fs.writeFileSync(file, `${JSON.stringify(malformed, null, 2)}\n`);
    const malformedRead = store.read(root);
    expect(malformedRead.success).toBe(false);
    expect(malformedRead.code).toBe('corrupt');
  });
});
