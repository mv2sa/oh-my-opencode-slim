import { randomBytes, randomUUID } from 'node:crypto';
import {
  canonicalDigest,
  computeOutcomeAuthorizationDigest,
  computeOutcomeContractDigest,
  computeOutcomeEvidenceAttestationDigest,
  computeOutcomeHandoffSupersessionDigest,
  type OutcomeActionRequired,
  type OutcomeAuthorizationReceipt,
  type OutcomeCheckpointClaim,
  type OutcomeCheckpointKind,
  type OutcomeContract,
  OutcomeContractSchema,
  type OutcomeEvidenceAttestation,
  type OutcomeFinalCertificate,
  type OutcomeKickoffGateState,
  type OutcomeManagerReviewSummary,
  type OutcomePendingIntake,
  type OutcomePendingOperation,
  type OutcomePhase,
  type OutcomeRecord,
  type OutcomeSessionManifest,
  type OutcomeToolObservation,
  type OutcomeUserMessageReceipt,
} from './controller-schema';
import { safeParseOutcomeReview } from './parser';
import { getProcessEpoch } from './process-epoch';
import type {
  AuthorizationKind,
  EvidenceFreshness,
  EvidenceStatus,
  GoalStatus,
  OutcomeReview,
  RuleEnforcementStatus,
  RuleType,
} from './schema';
import {
  formatMisboundRetirementNote,
  OutcomeStore,
  type OutcomeStoreResult,
  parseMisboundRetirementNote,
} from './store';

const CLAIM_SECRETS_SYMBOL = Symbol.for('omos.outcome.claim_secrets');

interface ClaimSecretRegistry {
  get(key: string): string | undefined;
  set(key: string, token: string): void;
  delete(key: string): void;
}

function getGlobalClaimSecrets(): ClaimSecretRegistry {
  const globalStore = globalThis as unknown as Record<
    symbol,
    Map<string, string> | undefined
  >;
  let secrets = globalStore[CLAIM_SECRETS_SYMBOL];
  if (!secrets) {
    secrets = new Map<string, string>();
    globalStore[CLAIM_SECRETS_SYMBOL] = secrets;
  }
  return {
    get: (key: string) => secrets.get(key),
    set: (key: string, token: string) => {
      secrets.set(key, token);
    },
    delete: (key: string) => {
      secrets.delete(key);
    },
  };
}

export interface OutcomeDispatchMarker {
  rootSession: string;
  outcomeId: string;
  checkpointId: string;
  claimGeneration: number;
  checkpointFingerprint: string;
  claimToken: string;
}

export function formatOutcomeDispatchMarker(
  marker: OutcomeDispatchMarker,
): string {
  return `<!-- OMOS_DISPATCH_MARKER rootSession="${marker.rootSession}" outcomeId="${marker.outcomeId}" checkpointId="${marker.checkpointId}" claimGeneration=${marker.claimGeneration} checkpointFingerprint="${marker.checkpointFingerprint}" claimToken="${marker.claimToken}" -->`;
}

export function extractOutcomeDispatchMarkers(
  text: string,
): OutcomeDispatchMarker[] {
  if (typeof text !== 'string') return [];
  const results: OutcomeDispatchMarker[] = [];
  const regex = /<!--\s*OMOS_DISPATCH_MARKER\s+([\s\S]*?)\s*-->/g;
  const matches = [...text.matchAll(regex)];
  for (const match of matches) {
    const attrText = match[1];
    const rootSession = attrText.match(/rootSession="([^"]+)"/)?.[1];
    const outcomeId = attrText.match(/outcomeId="([^"]+)"/)?.[1];
    const checkpointId = attrText.match(/checkpointId="([^"]+)"/)?.[1];
    const claimGenStr = attrText.match(/claimGeneration=(\d+)/)?.[1];
    const checkpointFingerprint = attrText.match(
      /checkpointFingerprint="([^"]+)"/,
    )?.[1];
    const claimToken = attrText.match(/claimToken="([^"]+)"/)?.[1];

    if (
      rootSession &&
      outcomeId &&
      checkpointId &&
      claimGenStr &&
      checkpointFingerprint &&
      claimToken
    ) {
      results.push({
        rootSession,
        outcomeId,
        checkpointId,
        claimGeneration: Number.parseInt(claimGenStr, 10),
        checkpointFingerprint,
        claimToken,
      });
    }
  }
  return results;
}

export function parseOutcomeDispatchMarker(
  text: string,
): OutcomeDispatchMarker | null {
  const markers = extractOutcomeDispatchMarkers(text);
  return markers.length === 1 ? markers[0] : null;
}

export interface OutcomeReviewExactPayload {
  candidateFingerprint?: string;
  goals: Array<{
    id: string;
    description: string;
    status: GoalStatus;
  }>;
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  rules: Array<{
    id: string;
    sourcePath: string;
    category: string;
    summary: string;
    ruleType: RuleType;
    enforcementStatus: RuleEnforcementStatus;
    evidenceIds: string[];
  }>;
  evidence: Array<{
    id: string;
    command: string;
    status: EvidenceStatus;
    fingerprint: string;
    freshness: EvidenceFreshness;
    isFinalCandidate: boolean;
  }>;
  exceptions: Array<{
    ruleId: string;
    justification: string;
    justified: boolean;
    scope: string;
    authorizationKind: AuthorizationKind;
    authorizationReference: string;
  }>;
}

export function buildOutcomeReviewExactPayload(
  record: OutcomeRecord,
  checkpoint: OutcomeCheckpointClaim,
): OutcomeReviewExactPayload {
  const goals = record.contract.goals.map(({ id, description, status }) => ({
    id,
    description,
    status,
  }));

  const scope = {
    inScope: [...record.contract.inScope],
    outOfScope: [...record.contract.outOfScope],
  };

  const includedEvidenceSet = new Set(
    checkpoint.includedEvidenceAttestationIds,
  );

  const rules = record.contract.rules.map((rule) => {
    for (const evId of rule.evidenceAttestationIds) {
      if (!includedEvidenceSet.has(evId)) {
        throw new Error(
          `Rule '${rule.id}' references evidence attestation '${evId}' not included in checkpoint claim`,
        );
      }
    }
    return {
      id: rule.id,
      sourcePath: rule.sourcePath,
      category: rule.category,
      summary: rule.summary,
      ruleType: rule.ruleType,
      enforcementStatus: rule.enforcementStatus,
      evidenceIds: [...rule.evidenceAttestationIds],
    };
  });

  const attestations = new Map(
    record.receipts.evidence
      .filter((e) => e.kind === 'orchestrator_attestation')
      .map((e) => [e.id, e as OutcomeEvidenceAttestation]),
  );

  const evidence = checkpoint.includedEvidenceAttestationIds.map((id) => {
    const entry = attestations.get(id);
    if (!entry) {
      throw new Error(
        `Included evidence attestation '${id}' not found in durable receipts`,
      );
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

  const authorizations = new Map(
    record.receipts.authorizations.map((a) => [a.id, a]),
  );

  const exceptions = record.contract.exceptions.map((exc) => {
    const auth = authorizations.get(exc.authorizationId);
    if (!auth) {
      throw new Error(
        `Exception for rule '${exc.ruleId}' references missing authorization '${exc.authorizationId}'`,
      );
    }
    return {
      ruleId: exc.ruleId,
      justification: exc.justification,
      justified: true,
      scope: exc.scope,
      authorizationKind: auth.kind,
      authorizationReference: auth.reference,
    };
  });

  return {
    ...(checkpoint.candidateFingerprint
      ? { candidateFingerprint: checkpoint.candidateFingerprint }
      : {}),
    goals,
    scope,
    rules,
    evidence,
    exceptions,
  };
}

export function buildOutcomeReviewPacket(
  record: OutcomeRecord,
  checkpoint: OutcomeCheckpointClaim,
): string {
  const exactPayload = buildOutcomeReviewExactPayload(record, checkpoint);
  const exactJson = JSON.stringify(exactPayload, null, 2);

  const lines: string[] = [
    '# Outcome Contract Review Packet',
    `Outcome ID: ${record.outcomeId}`,
    `Revision: ${record.revision}`,
    `Checkpoint ID: ${checkpoint.checkpointId}`,
    `Checkpoint Kind: ${checkpoint.kind}`,
    `Checkpoint Reason: ${checkpoint.reason}`,
    '',
    '## Objective',
    record.contract.objective,
    '',
    '## Deliverables',
    ...record.contract.deliverables.map((d) => `- ${d}`),
    '',
    '## Goals',
    ...record.contract.goals.map(
      (g) =>
        `- [${g.id}] (${g.status}) ${g.description}${g.notes ? ` - ${g.notes}` : ''}`,
    ),
    '',
    '## Scope',
    '### In Scope',
    ...record.contract.inScope.map((s) => `- ${s}`),
    '### Out of Scope',
    ...record.contract.outOfScope.map((s) => `- ${s}`),
    '',
    '## Rules',
    ...(record.contract.rules.length > 0
      ? record.contract.rules.map(
          (r) =>
            `- [${r.id}] ${r.summary} (type: ${r.ruleType}, status: ${r.enforcementStatus}, source: ${r.sourcePath})`,
        )
      : ['- None']),
    '',
    '## Exceptions & Authorizations',
    ...(record.contract.exceptions.length > 0
      ? record.contract.exceptions.map(
          (e) =>
            `- Rule ${e.ruleId}: ${e.justification} (scope: ${e.scope}, authId: ${e.authorizationId})`,
        )
      : ['- None']),
  ];

  if (checkpoint.includedEvidenceAttestationIds.length > 0) {
    lines.push('', '## Checkpoint Evidence Attestations');
    for (const evId of checkpoint.includedEvidenceAttestationIds) {
      const ev = record.receipts.evidence.find((e) => e.id === evId);
      if (ev?.kind === 'orchestrator_attestation') {
        lines.push(
          `- [${ev.id}] ${ev.description} (status: ${ev.assertedStatus}, freshness: ${ev.assertedFreshness}, fingerprint: ${ev.candidateFingerprint})`,
        );
      }
    }
  }

  lines.push(
    '',
    '## Exact Controller-Authenticated Review Values (Manager MUST copy exactly)',
    '```json',
    exactJson,
    '```',
  );

  return lines.join('\n');
}

export function buildOutcomeManagerInstruction(
  marker: OutcomeDispatchMarker,
  record: OutcomeRecord,
  checkpoint: OutcomeCheckpointClaim,
): string {
  const markerString = formatOutcomeDispatchMarker(marker);
  const packet = buildOutcomeReviewPacket(record, checkpoint);
  return [
    `Call task(subagent_type='outcome-manager', description='Outcome Manager review: ${checkpoint.kind} checkpoint (${checkpoint.reason})', prompt=\`${markerString}\n\n${packet}\`)`,
    "Reconcile the review result with outcome_control(action='reconcile_review') after completion.",
  ].join('\n\n');
}

export interface OutcomeStatusProjection {
  isManaged: boolean;
  generation?: number;
  pendingSuccessor?: {
    generation: number;
    boundaryMessageId: string;
    userMessageCount: number;
    createdAt: number;
    updatedAt: number;
  };
  blocked?: {
    code: string;
    reason: string;
  };
  outcomeId?: string;
  revision?: number;
  phase?: OutcomePhase;
  contractDigest?: string;
  kickoffGate?: {
    state: OutcomeKickoffGateState;
    attempts: number;
    maxAttempts: number;
    authenticatedReviewId?: string;
    lastCheckpointId?: string;
    failureReason?: string;
  };
  checkpoint?: {
    checkpointId: string;
    kind: OutcomeCheckpointKind;
    claimGeneration: number;
    state: OutcomeCheckpointClaim['state'];
    reason: string;
    expiresAt: number;
    candidateFingerprint?: string;
  };
  waitCondition?: OutcomeRecord['waitCondition'];
  actionsRequired: OutcomeActionRequired[];
  activeOperations: {
    id: string;
    toolName: string;
    status: string;
    error?: string;
  }[];
  finalCertificate?: OutcomeFinalCertificate;
}

export type OutcomeControllerResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

export interface OutcomeUserTurnResult {
  receipt: OutcomeUserMessageReceipt;
  receiptId: string;
  status: 'written' | 'noop' | 'created' | 'read' | 'recovered';
  noop: boolean;
  stagedInPendingIntake?: boolean;
}

export interface OutcomeBeginResult {
  outcomeId: string;
  revision: number;
  phase: OutcomePhase;
  generation?: number;
  kickoffGate?: {
    state: OutcomeKickoffGateState;
    attempts: number;
    maxAttempts: number;
    authenticatedReviewId?: string;
    lastCheckpointId?: string;
    failureReason?: string;
  };
  checkpoint?: {
    checkpointId: string;
    kind: OutcomeCheckpointKind;
    claimGeneration: number;
    fingerprint: string;
  };
  dispatchNudgePending: boolean;
  idempotent?: boolean;
  promotedFromPendingIntake?: boolean;
}

export interface OutcomeCheckpointParams {
  kind: OutcomeCheckpointKind;
  reason: string;
  candidateFingerprint?: string;
  decisionIds?: string[];
  exceptionRuleIds?: string[];
  evidenceAttestationIds?: string[];
  expiresInMs?: number;
}

export interface OutcomeCheckpointResult {
  checkpointId: string;
  kind: OutcomeCheckpointKind;
  claimGeneration: number;
  revision: number;
  phase: OutcomePhase;
  dispatchNudgePending: true;
}

export interface OutcomeSubmitEvidenceParams {
  description: string;
  assertedStatus: 'passed' | 'failed' | 'stale' | 'pending';
  assertedFreshness: 'fresh' | 'stale' | 'unknown';
  candidateFingerprint: string;
  linkedObservationId?: string;
}

export interface OutcomeSubmitEvidenceResult {
  attestationId: string;
  revision: number;
  payloadDigest: string;
  assurance: 'orchestrator_attestation';
}

export interface OutcomeReconcileReviewParams {
  checkpointId: string;
  managerTaskId: string;
  managerGeneration?: number;
}

export interface OutcomeReconcileReviewResult {
  verdict: OutcomeReview['verdict'];
  phase: OutcomePhase;
  summary: OutcomeManagerReviewSummary;
}

export type OutcomeReconcileUncertainResolution =
  | { kind: 'retire'; reason: string }
  | {
      kind: 'result_available';
      dispatchCallId: string;
      managerTaskId: string;
      managerGeneration: number;
      resultDigest: string;
    }
  | {
      kind: 'retire_misbound_result';
      reason: string;
      dispatchCallId: string;
      managerTaskId: string;
      managerGeneration: number;
      boundResultDigest: string;
    };

export interface OutcomeReconcileUncertainParams {
  checkpointId: string;
  resolution: OutcomeReconcileUncertainResolution;
}

export interface OutcomeResolveUserDecisionParams {
  decisionId: string;
  chosenOption: string;
  sourceUserMessageReceiptId: string;
  authorizationKind?: 'user_decision';
}

export interface OutcomeResolveUserDecisionResult {
  decisionId: string;
  revision: number;
  phase: OutcomePhase;
}

export interface OutcomeRegisterRepositoryWaiverParams {
  repositoryReference: string;
}

export interface OutcomeRegisterRepositoryWaiverResult {
  authorizationId: string;
  revision: number;
  kind: 'repository_waiver';
  reference: string;
  payloadDigest: string;
}

export interface OutcomeExternalHandoffParams {
  kind: 'restart_current_opencode';
  reason?: string;
  instructions?: string;
  expectedPostRestartCheck?: string;
}

export interface OutcomeExternalHandoffResult {
  phase: OutcomePhase;
  instructions: string;
  expectedPostRestartCheck?: string;
}

export interface OutcomeSupersedeExternalHandoffParams {
  reason: string;
  waitReferenceId: string;
  waitCreatedRevision: number;
  waitOriginatingServerEpoch: string;
  waitRestartObservedRevision: number;
  waitInstructions: string;
  expectedPostRestartCheck: string;
  retiredCheckpointId: string;
  retiredClaimGeneration: number;
  sourceUserMessageReceiptId: string;
  evidenceAttestationId: string;
  replacementCandidateFingerprint: string;
}

export interface OutcomeProtocolUpdateResult {
  revision: number;
  phase: OutcomePhase;
  contractDigest: string;
}

export interface OutcomeFinalizeResult {
  certificate: OutcomeFinalCertificate;
  assurance: 'orchestrator_attestation';
}

export interface ManagerTaskVerification {
  taskID: string;
  parentSessionID: string;
  agent: string;
  generation: number;
  state: string;
  terminalState?: string;
  terminalUnreconciled?: boolean;
}

export interface ChildSessionReaderResult {
  text: string;
  empty: boolean;
  terminal: boolean;
}

export type OutcomeNudge =
  | {
      kind: 'dispatch';
      instruction: string;
      marker: OutcomeDispatchMarker;
    }
  | {
      kind: 'recovery';
      message: string;
    };

export interface OutcomeControllerOptions {
  projectDirectory?: string;
  storeDirectory?: string;
  serverEpoch?: string;
  store?: OutcomeStore;
  getManagerTaskRecord?: (
    taskId: string,
  ) => ManagerTaskVerification | undefined;
  readChildSessionResult?: (
    childSessionId: string,
  ) => Promise<ChildSessionReaderResult | undefined>;
  consumeManagerTask?: (
    rootSessionId: string,
    taskId: string,
    generation: number,
  ) => boolean;
  hasRunningChildren?: (rootSessionId: string) => boolean;
  hasTerminalUnreconciledChildren?: (rootSessionId: string) => boolean;
  resolveAgentName?: (agent: string) => string;
  clock?: () => number;
  randomId?: () => string;
}

export class OutcomeController {
  readonly #store: OutcomeStore;
  readonly #serverEpoch: string;
  readonly #claimSecrets: ClaimSecretRegistry;
  readonly #getManagerTaskRecord?: (
    taskId: string,
  ) => ManagerTaskVerification | undefined;
  readonly #readChildSessionResult?: (
    childSessionId: string,
  ) => Promise<ChildSessionReaderResult | undefined>;
  readonly #consumeManagerTask?: (
    rootSessionId: string,
    taskId: string,
    generation: number,
  ) => boolean;
  readonly #hasRunningChildren?: (rootSessionId: string) => boolean;
  readonly #hasTerminalUnreconciledChildren?: (
    rootSessionId: string,
  ) => boolean;
  readonly #resolveAgentName: (agent: string) => string;
  readonly #clock: () => number;
  readonly #randomId: () => string;
  readonly #consumedReviewDigests = new Map<string, string>();

  constructor(options: OutcomeControllerOptions = {}) {
    this.#serverEpoch = options.serverEpoch ?? getProcessEpoch();
    this.#clock = options.clock ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#claimSecrets = getGlobalClaimSecrets();
    this.#getManagerTaskRecord = options.getManagerTaskRecord;
    this.#readChildSessionResult = options.readChildSessionResult;
    this.#consumeManagerTask = options.consumeManagerTask;
    this.#hasRunningChildren = options.hasRunningChildren;
    this.#hasTerminalUnreconciledChildren =
      options.hasTerminalUnreconciledChildren;
    this.#resolveAgentName =
      options.resolveAgentName ?? ((agent: string) => agent);

    this.#store =
      options.store ??
      new OutcomeStore({
        projectDirectory: options.projectDirectory,
        storeDirectory: options.storeDirectory,
        serverEpoch: this.#serverEpoch,
        clock: this.#clock,
        randomId: this.#randomId,
      });
  }

  get store(): OutcomeStore {
    return this.#store;
  }

  get serverEpoch(): string {
    return this.#serverEpoch;
  }

  isManaged(rootSessionId: string): boolean {
    const res = this.#store.read(rootSessionId);
    if (res.success) return true;
    if (res.code === 'missing') return false;
    throw new Error(
      `Managed outcome state is unavailable (${res.code}): ${res.error.message}`,
    );
  }

  readRecord(rootSessionId: string): OutcomeStoreResult<OutcomeRecord> {
    const readRes = this.#store.read(rootSessionId);
    if (!readRes.success) return readRes;
    if (readRes.data.serverEpoch !== this.#serverEpoch) {
      return this.#store.recover(rootSessionId);
    }
    return readRes;
  }

  readRecordGeneration(
    rootSessionId: string,
    generation: number,
  ): OutcomeStoreResult<OutcomeRecord> {
    return this.#store.readGeneration(rootSessionId, generation);
  }

  readManifest(
    rootSessionId: string,
  ): OutcomeStoreResult<OutcomeSessionManifest> {
    return this.#store.readManifest(rootSessionId);
  }

  readPendingIntake(
    rootSessionId: string,
  ): OutcomeStoreResult<OutcomePendingIntake> {
    return this.#store.readPendingIntake(rootSessionId);
  }

  getHistoricalGenerationStatus(
    rootSessionId: string,
    generation: number,
  ): OutcomeStatusProjection {
    const res = this.#store.readGeneration(rootSessionId, generation);
    if (!res.success) {
      return {
        isManaged: false,
        blocked: { code: res.code, reason: res.error.message },
        actionsRequired: [],
        activeOperations: [],
      };
    }
    return this.#projectRecordStatus(res.data, undefined, generation);
  }

  getStatus(rootSessionId: string): OutcomeStatusProjection {
    const res = this.readRecord(rootSessionId);
    if (!res.success) {
      if (res.code !== 'missing') {
        return {
          isManaged: true,
          blocked: { code: res.code, reason: res.error.message },
          phase: 'corrupted',
          actionsRequired: [],
          activeOperations: [],
        };
      }
      return {
        isManaged: false,
        actionsRequired: [],
        activeOperations: [],
      };
    }
    const manifestRes = this.#store.readManifest(rootSessionId);
    const manifest = manifestRes.success ? manifestRes.data : undefined;
    return this.#projectRecordStatus(res.data, manifest);
  }

  #projectRecordStatus(
    record: OutcomeRecord,
    manifest?: OutcomeSessionManifest,
    generationOverride?: number,
  ): OutcomeStatusProjection {
    const pendingSuccessor = manifest?.pendingSuccessor
      ? {
          generation: manifest.pendingSuccessor.generation,
          boundaryMessageId: manifest.pendingSuccessor.boundaryMessageId,
          userMessageCount: manifest.pendingSuccessor.userMessageCount,
          createdAt: manifest.pendingSuccessor.createdAt,
          updatedAt: manifest.pendingSuccessor.updatedAt,
        }
      : undefined;

    return {
      isManaged: true,
      generation:
        generationOverride ??
        record.generation ??
        (manifest ? manifest.currentGeneration : 1),
      pendingSuccessor,
      outcomeId: record.outcomeId,
      revision: record.revision,
      phase: record.phase,
      contractDigest: record.contractDigest,
      kickoffGate: record.kickoffGate
        ? {
            state: record.kickoffGate.state,
            attempts: record.kickoffGate.attempts,
            maxAttempts: record.kickoffGate.maxAttempts,
            authenticatedReviewId: record.kickoffGate.authenticatedReviewId,
            lastCheckpointId: record.kickoffGate.lastCheckpointId,
            failureReason: record.kickoffGate.failureReason,
          }
        : undefined,
      checkpoint: record.checkpoint
        ? {
            checkpointId: record.checkpoint.checkpointId,
            kind: record.checkpoint.kind,
            claimGeneration: record.checkpoint.claimGeneration,
            state: record.checkpoint.state,
            reason: record.checkpoint.reason,
            expiresAt: record.checkpoint.expiresAt,
            candidateFingerprint: record.checkpoint.candidateFingerprint,
          }
        : undefined,
      waitCondition: record.waitCondition,
      actionsRequired: record.actionsRequired.filter(
        (a) => a.resolvedAt === undefined,
      ),
      activeOperations: record.operations
        .filter((op) =>
          ['running', 'failed', 'interrupted'].includes(op.status),
        )
        .map((op) => ({
          id: op.id,
          toolName: op.toolName,
          status: op.status,
          error: op.error,
        })),
      finalCertificate: record.finalCertificate,
    };
  }

  getPendingNudge(rootSessionId: string): OutcomeNudge | undefined {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      if (recRes.code === 'missing') return undefined;
      throw new Error(
        `Managed outcome state is unavailable (${recRes.code}): ${recRes.error.message}`,
      );
    }
    const record = recRes.data;

    if (record.checkpoint && record.checkpoint.state === 'claimed') {
      const claim = record.checkpoint;
      const rawToken =
        this.#claimSecrets.get(
          `${rootSessionId}:${record.outcomeId}:${claim.checkpointId}`,
        ) ??
        this.#claimSecrets.get(
          `${rootSessionId}:${record.outcomeId}:${claim.claimGeneration}`,
        );

      if (
        rawToken &&
        canonicalDigest('omos/outcome-claim-token/v1', rawToken) ===
          claim.claimTokenDigest
      ) {
        const marker: OutcomeDispatchMarker = {
          rootSession: rootSessionId,
          outcomeId: record.outcomeId,
          checkpointId: claim.checkpointId,
          claimGeneration: claim.claimGeneration,
          checkpointFingerprint: claim.checkpointFingerprint,
          claimToken: rawToken,
        };
        const instruction = buildOutcomeManagerInstruction(
          marker,
          record,
          claim,
        );
        return { kind: 'dispatch', instruction, marker };
      }

      return {
        kind: 'recovery',
        message: `Active checkpoint claim '${claim.checkpointId}' lost its process claim token across restart. Call outcome_control(action='expire_checkpoint') after expiry or perform recovery.`,
      };
    }

    if (record.kickoffGate?.state === 'exhausted') {
      return {
        kind: 'recovery',
        message: `Kickoff attempts exhausted (${record.kickoffGate.attempts}/${record.kickoffGate.maxAttempts}): ${record.kickoffGate.failureReason ?? 'Maximum kickoff attempts reached; outcome failed.'}`,
      };
    }

    if (record.kickoffGate?.state === 'legacy_late_missing') {
      return {
        kind: 'recovery',
        message: `Retrospective kickoff forbidden for legacy record: ${record.kickoffGate.failureReason ?? 'Historical record has review activity without an authenticated kickoff review.'}`,
      };
    }

    if (record.phase === 'action_required') {
      if (record.checkpoint?.state === 'review_uncertain') {
        return {
          kind: 'recovery',
          message: `Manager review is uncertain for checkpoint '${record.checkpoint.checkpointId}'. Call outcome_control(action='reconcile_uncertain') to reconcile.`,
        };
      }
      const unresolvedActions = record.actionsRequired.filter(
        (a) => a.resolvedAt === undefined,
      );
      const unresolvedOperations = record.operations.filter((operation) =>
        ['failed', 'interrupted'].includes(operation.status),
      );
      if (unresolvedActions.length > 0 || unresolvedOperations.length > 0) {
        const messages: string[] = [];
        if (unresolvedActions.length > 0) {
          messages.push(
            `Action required: ${unresolvedActions.map((a) => a.reason).join('; ')}`,
          );
        }
        if (unresolvedOperations.length > 0) {
          messages.push(
            `Interrupted or failed operations require acknowledgement: ${unresolvedOperations.map((operation) => `${operation.id} (${operation.toolName})`).join('; ')}. Call outcome_control(action='acknowledge_operation', operationId=...) for each after reconciling its actual outcome.`,
          );
        }
        return {
          kind: 'recovery',
          message: messages.join('\n'),
        };
      }
    }

    return undefined;
  }

  validateManagedWait(rootSessionId: string): {
    isManaged: boolean;
    allowed: boolean;
    phase?: string;
    reason?: string;
  } {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      if (recRes.code === 'missing') {
        return { isManaged: false, allowed: true };
      }
      return {
        isManaged: true,
        allowed: false,
        phase: 'corrupted',
        reason: `Managed outcome state is unavailable (${recRes.code}): ${recRes.error.message}`,
      };
    }
    const record = recRes.data;

    if (record.phase === 'waiting_user') {
      const hasUnresolvedDecision =
        record.waitCondition?.kind === 'user_decision' &&
        record.receipts.decisions.some(
          (d) =>
            d.id === record.waitCondition?.referenceId &&
            d.chosenOption === undefined,
        );
      if (hasUnresolvedDecision) {
        return { isManaged: true, allowed: true, phase: 'waiting_user' };
      }
      return {
        isManaged: true,
        allowed: false,
        phase: record.phase,
        reason:
          'Outcome is in waiting_user phase but lacks an unresolved durable user decision',
      };
    }

    if (record.phase === 'waiting_external') {
      if (record.waitCondition?.kind === 'external_handoff') {
        return { isManaged: true, allowed: true, phase: 'waiting_external' };
      }
      return {
        isManaged: true,
        allowed: false,
        phase: record.phase,
        reason:
          'Outcome is in waiting_external phase but lacks a durable external handoff wait condition',
      };
    }

    return {
      isManaged: true,
      allowed: false,
      phase: record.phase,
      reason: `Outcome phase is '${record.phase}'. wait_for_user requires 'waiting_user' or 'waiting_external'`,
    };
  }

  begin(
    rootSessionId: string,
    contract: OutcomeContract,
    options?: { outcomeId?: string },
  ): OutcomeControllerResult<OutcomeBeginResult> {
    const parseRes = OutcomeContractSchema.safeParse(contract);
    if (!parseRes.success) {
      return {
        success: false,
        error: `Invalid outcome contract: ${parseRes.error.message}`,
        code: 'invalid_contract',
      };
    }
    const validContract = parseRes.data;

    let record: OutcomeRecord;
    let promotedFromPendingIntake = false;
    const existing = this.#store.read(rootSessionId);
    if (existing.success) {
      if (existing.data.phase === 'accepted') {
        if (
          existing.data.contractDigest ===
          computeOutcomeContractDigest(validContract)
        ) {
          return {
            success: true,
            data: {
              outcomeId: existing.data.outcomeId,
              revision: existing.data.revision,
              phase: existing.data.phase,
              generation: existing.data.generation ?? 1,
              kickoffGate: existing.data.kickoffGate
                ? { ...existing.data.kickoffGate }
                : undefined,
              dispatchNudgePending: false,
              idempotent: true,
            },
          };
        }

        const pendingRes = this.#store.readPendingIntake(rootSessionId);
        if (pendingRes.success) {
          const promoteRes = this.#store.promotePendingIntake(rootSessionId, {
            outcomeId: options?.outcomeId,
            contract: validContract,
          });
          if (!promoteRes.success) {
            return {
              success: false,
              error: `Failed to begin successor outcome: ${promoteRes.error.message}`,
              code: promoteRes.code,
            };
          }
          record = promoteRes.data;
          promotedFromPendingIntake = true;
        } else {
          return {
            success: false,
            error:
              'A successor outcome requires fresh external user provenance staged in pending intake',
            code: 'invalid_transition',
          };
        }
      } else {
        const recovered = this.#store.recover(rootSessionId);
        if (!recovered.success) {
          return {
            success: false,
            error: `Failed to recover existing outcome record: ${recovered.error.message}`,
            code: recovered.code,
          };
        }
        record = recovered.data;
        if (
          record.contractDigest !== computeOutcomeContractDigest(validContract)
        ) {
          return {
            success: false,
            error:
              'Existing managed outcome contract differs from the supplied contract',
            code: 'contract_mismatch',
          };
        }
      }
    } else if (existing.code === 'missing') {
      const initRes = this.#store.init(rootSessionId, {
        outcomeId: options?.outcomeId,
        contract: validContract,
      });
      if (!initRes.success) {
        return {
          success: false,
          error: `Failed to initialize outcome record: ${initRes.error.message}`,
          code: initRes.code,
        };
      }
      record = initRes.data;
    } else {
      return {
        success: false,
        error: `Cannot initialize outcome over corrupt or unreadable record: ${existing.error.message}`,
        code: existing.code,
      };
    }

    if (!record.checkpoint) {
      if (record.kickoffGate.state === 'legacy_late_missing') {
        return {
          success: false,
          error:
            record.kickoffGate.failureReason ??
            'Retrospective kickoff is forbidden for legacy record with missing kickoff',
          code: 'retrospective_kickoff_forbidden',
        };
      }
      if (
        record.kickoffGate.state === 'exhausted' ||
        record.kickoffGate.attempts >= record.kickoffGate.maxAttempts
      ) {
        return {
          success: false,
          error:
            record.kickoffGate.failureReason ??
            'Kickoff retry attempts exhausted (2/2)',
          code: 'kickoff_retry_exhausted',
        };
      }
      if (record.kickoffGate.state === 'authenticated') {
        return {
          success: true,
          data: {
            outcomeId: record.outcomeId,
            revision: record.revision,
            phase: record.phase,
            generation: record.generation ?? 1,
            kickoffGate: {
              state: record.kickoffGate.state,
              attempts: record.kickoffGate.attempts,
              maxAttempts: record.kickoffGate.maxAttempts,
              authenticatedReviewId: record.kickoffGate.authenticatedReviewId,
              lastCheckpointId: record.kickoffGate.lastCheckpointId,
              failureReason: record.kickoffGate.failureReason,
            },
            dispatchNudgePending: false,
            idempotent: true,
          },
        };
      }
      if (record.kickoffGate.state === 'legacy_certified') {
        return {
          success: true,
          data: {
            outcomeId: record.outcomeId,
            revision: record.revision,
            phase: record.phase,
            generation: record.generation ?? 1,
            kickoffGate: {
              state: record.kickoffGate.state,
              attempts: record.kickoffGate.attempts,
              maxAttempts: record.kickoffGate.maxAttempts,
              failureReason: record.kickoffGate.failureReason,
            },
            dispatchNudgePending: false,
            idempotent: true,
          },
        };
      }

      const claimToken = randomBytes(32).toString('hex');
      const now = this.#clock();
      const expiresAt = now + 600_000;
      const mutateRes = this.#store.mutate(rootSessionId, record.revision, {
        type: 'open_checkpoint',
        kind: 'kickoff',
        reason: 'Kickoff contract and scope verification',
        claimToken,
        expiresAt,
      });
      if (!mutateRes.success) {
        return {
          success: false,
          error: `Failed to open kickoff checkpoint: ${mutateRes.error.message}`,
          code: mutateRes.code,
        };
      }
      record = mutateRes.data;
      const checkpoint = record.checkpoint as OutcomeCheckpointClaim;
      this.#claimSecrets.set(
        `${rootSessionId}:${record.outcomeId}:${checkpoint.checkpointId}`,
        claimToken,
      );
      this.#claimSecrets.set(
        `${rootSessionId}:${record.outcomeId}:${checkpoint.claimGeneration}`,
        claimToken,
      );

      return {
        success: true,
        data: {
          outcomeId: record.outcomeId,
          revision: record.revision,
          phase: record.phase,
          generation: record.generation ?? 1,
          kickoffGate: {
            state: record.kickoffGate.state,
            attempts: record.kickoffGate.attempts,
            maxAttempts: record.kickoffGate.maxAttempts,
            authenticatedReviewId: record.kickoffGate.authenticatedReviewId,
            lastCheckpointId: record.kickoffGate.lastCheckpointId,
            failureReason: record.kickoffGate.failureReason,
          },
          checkpoint: {
            checkpointId: checkpoint.checkpointId,
            kind: checkpoint.kind,
            claimGeneration: checkpoint.claimGeneration,
            fingerprint: checkpoint.checkpointFingerprint,
          },
          dispatchNudgePending: true,
          promotedFromPendingIntake,
        },
      };
    }

    const checkpoint = record.checkpoint;
    if (isSettledCheckpoint(checkpoint.state)) {
      if (record.kickoffGate.state === 'legacy_late_missing') {
        return {
          success: false,
          error:
            record.kickoffGate.failureReason ??
            'Retrospective kickoff is forbidden for legacy record with missing kickoff',
          code: 'retrospective_kickoff_forbidden',
        };
      }
      if (record.kickoffGate.state === 'exhausted') {
        return {
          success: false,
          error:
            record.kickoffGate.failureReason ??
            'Kickoff retry attempts exhausted (2/2)',
          code: 'kickoff_retry_exhausted',
        };
      }
      return {
        success: true,
        data: {
          outcomeId: record.outcomeId,
          revision: record.revision,
          phase: record.phase,
          kickoffGate: {
            state: record.kickoffGate.state,
            attempts: record.kickoffGate.attempts,
            maxAttempts: record.kickoffGate.maxAttempts,
            authenticatedReviewId: record.kickoffGate.authenticatedReviewId,
            lastCheckpointId: record.kickoffGate.lastCheckpointId,
            failureReason: record.kickoffGate.failureReason,
          },
          checkpoint: {
            checkpointId: checkpoint.checkpointId,
            kind: checkpoint.kind,
            claimGeneration: checkpoint.claimGeneration,
            fingerprint: checkpoint.checkpointFingerprint,
          },
          dispatchNudgePending: false,
          idempotent: true,
        },
      };
    }
    const nudge = this.getPendingNudge(rootSessionId);
    if (nudge?.kind !== 'dispatch') {
      return {
        success: false,
        error:
          nudge?.message ??
          `Existing checkpoint '${checkpoint.checkpointId}' is not dispatchable`,
        code: 'checkpoint_not_dispatchable',
      };
    }
    return {
      success: true,
      data: {
        outcomeId: record.outcomeId,
        revision: record.revision,
        phase: record.phase,
        kickoffGate: {
          state: record.kickoffGate.state,
          attempts: record.kickoffGate.attempts,
          maxAttempts: record.kickoffGate.maxAttempts,
          authenticatedReviewId: record.kickoffGate.authenticatedReviewId,
          lastCheckpointId: record.kickoffGate.lastCheckpointId,
          failureReason: record.kickoffGate.failureReason,
        },
        checkpoint: {
          checkpointId: checkpoint.checkpointId,
          kind: checkpoint.kind,
          claimGeneration: checkpoint.claimGeneration,
          fingerprint: checkpoint.checkpointFingerprint,
        },
        dispatchNudgePending: true,
      },
    };
  }

  checkpoint(
    rootSessionId: string,
    params: OutcomeCheckpointParams,
  ): OutcomeControllerResult<OutcomeCheckpointResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome record found: ${recRes.error.message}`,
        code: recRes.code,
      };
    }
    const record = recRes.data;

    if (record.kickoffGate.state === 'legacy_late_missing') {
      return {
        success: false,
        error:
          record.kickoffGate.failureReason ??
          'Retrospective kickoff is forbidden for legacy record with missing kickoff',
        code: 'retrospective_kickoff_forbidden',
      };
    }
    if (
      record.kickoffGate.state === 'exhausted' ||
      (params.kind === 'kickoff' &&
        record.kickoffGate.attempts >= record.kickoffGate.maxAttempts)
    ) {
      return {
        success: false,
        error:
          record.kickoffGate.failureReason ??
          'Kickoff retry attempts exhausted (2/2)',
        code: 'kickoff_retry_exhausted',
      };
    }

    if (record.waitCondition) {
      return {
        success: false,
        error: `Cannot open checkpoint while wait '${record.waitCondition.referenceId}' is unresolved`,
        code: 'wait_unresolved',
      };
    }
    if (
      record.actionsRequired.some((action) => action.resolvedAt === undefined)
    ) {
      return {
        success: false,
        error:
          'Cannot open checkpoint while Controller actions remain unresolved',
        code: 'action_unresolved',
      };
    }

    const includedEvidenceIds = new Set(params.evidenceAttestationIds ?? []);
    for (const rule of record.contract.rules) {
      for (const evId of rule.evidenceAttestationIds) {
        if (!includedEvidenceIds.has(evId)) {
          return {
            success: false,
            error: `Checkpoint must include evidence attestation '${evId}' referenced by rule '${rule.id}'`,
            code: 'invalid_checkpoint_params',
          };
        }
      }
    }

    if (
      record.checkpoint &&
      ![
        'review_accepted',
        'review_rejected',
        'review_invalid',
        'retired',
      ].includes(record.checkpoint.state)
    ) {
      const existing = record.checkpoint;
      return {
        success: false,
        error: `An active checkpoint '${existing.checkpointId}' (generation ${existing.claimGeneration}, state '${existing.state}') is already in-flight.`,
        code: 'checkpoint_in_flight',
      };
    }

    if (params.kind === 'final' && !params.candidateFingerprint) {
      return {
        success: false,
        error: 'Final checkpoint requires candidateFingerprint',
        code: 'invalid_checkpoint_params',
      };
    }

    const claimToken = randomBytes(32).toString('hex');
    const now = this.#clock();
    const expiresAt = now + (params.expiresInMs ?? 600_000);

    const mutateRes = this.#store.mutate(rootSessionId, record.revision, {
      type: 'open_checkpoint',
      kind: params.kind,
      reason: params.reason,
      claimToken,
      expiresAt,
      candidateFingerprint: params.candidateFingerprint,
      decisionIds: params.decisionIds,
      exceptionRuleIds: params.exceptionRuleIds,
      evidenceAttestationIds: params.evidenceAttestationIds,
    });
    if (!mutateRes.success) {
      return {
        success: false,
        error: `Failed to open checkpoint: ${mutateRes.error.message}`,
        code: mutateRes.code,
      };
    }

    const updated = mutateRes.data;
    const checkpoint = updated.checkpoint as OutcomeCheckpointClaim;
    this.#claimSecrets.set(
      `${rootSessionId}:${updated.outcomeId}:${checkpoint.checkpointId}`,
      claimToken,
    );
    this.#claimSecrets.set(
      `${rootSessionId}:${updated.outcomeId}:${checkpoint.claimGeneration}`,
      claimToken,
    );

    return {
      success: true,
      data: {
        checkpointId: checkpoint.checkpointId,
        kind: checkpoint.kind,
        claimGeneration: checkpoint.claimGeneration,
        revision: updated.revision,
        phase: updated.phase,
        dispatchNudgePending: true,
      },
    };
  }

  submitEvidence(
    rootSessionId: string,
    params: OutcomeSubmitEvidenceParams,
  ): OutcomeControllerResult<OutcomeSubmitEvidenceResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome record found: ${recRes.error.message}`,
        code: recRes.code,
      };
    }
    const currentRecord = recRes.data;

    if (params.linkedObservationId !== undefined) {
      const linkedEntry = currentRecord.receipts.evidence.find(
        (e) => e.id === params.linkedObservationId,
      );
      if (!linkedEntry) {
        return {
          success: false,
          error: `Linked observation '${params.linkedObservationId}' not found in durable record`,
          code: 'missing_observation',
        };
      }
      if (linkedEntry.kind !== 'controller_observed') {
        return {
          success: false,
          error: `Linked observation '${params.linkedObservationId}' is not controller_observed`,
          code: 'not_controller_observed',
        };
      }
      if (!linkedEntry.completionObserved) {
        return {
          success: false,
          error: `Linked observation '${params.linkedObservationId}' is incomplete`,
          code: 'incomplete_observation',
        };
      }
      const operation = currentRecord.operations.find(
        (op) => op.callId === linkedEntry.callId,
      );
      if (!operation) {
        return {
          success: false,
          error: `Linked observation '${params.linkedObservationId}' lacks matching operation`,
          code: 'missing_operation',
        };
      }
      if (operation.status !== 'completed') {
        return {
          success: false,
          error: `Linked operation '${operation.callId}' must be completed (found '${operation.status}')`,
          code: 'operation_not_completed',
        };
      }
      if (
        operation.toolName !== linkedEntry.toolName ||
        operation.argumentDigest !== linkedEntry.argumentDigest ||
        operation.serverEpoch !== linkedEntry.startedEpoch
      ) {
        return {
          success: false,
          error: `Linked observation '${params.linkedObservationId}' does not match its operation identity`,
          code: 'operation_identity_mismatch',
        };
      }
    }

    const attestationId = `att_${this.#randomId().replace(/-/g, '').slice(0, 16)}`;
    const now = this.#clock();
    const nextRevision = currentRecord.revision + 1;
    const payloadDigest = computeOutcomeEvidenceAttestationDigest({
      id: attestationId,
      description: params.description,
      assertedStatus: params.assertedStatus,
      assertedFreshness: params.assertedFreshness,
      candidateFingerprint: params.candidateFingerprint,
      linkedObservationId: params.linkedObservationId,
      createdAt: now,
    });

    const attestation: OutcomeEvidenceAttestation = {
      id: attestationId,
      kind: 'orchestrator_attestation',
      description: params.description,
      assertedStatus: params.assertedStatus,
      assertedFreshness: params.assertedFreshness,
      candidateFingerprint: params.candidateFingerprint,
      linkedObservationId: params.linkedObservationId,
      payloadDigest,
      createdRevision: nextRevision,
      createdAt: now,
    };

    const mutateRes = this.#store.mutate(
      rootSessionId,
      currentRecord.revision,
      {
        type: 'append_evidence',
        entry: attestation,
      },
    );
    if (!mutateRes.success) {
      return {
        success: false,
        error: `Failed to submit evidence attestation: ${mutateRes.error.message}`,
        code: mutateRes.code,
      };
    }

    return {
      success: true,
      data: {
        attestationId,
        revision: mutateRes.data.revision,
        payloadDigest,
        assurance: 'orchestrator_attestation',
      },
    };
  }

  async reconcileReview(
    rootSessionId: string,
    params: OutcomeReconcileReviewParams,
  ): Promise<OutcomeControllerResult<OutcomeReconcileReviewResult>> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome record found: ${recRes.error.message}`,
        code: recRes.code,
      };
    }
    const record = recRes.data;

    const claim = record.checkpoint;
    if (!claim) {
      return {
        success: false,
        error: 'No active checkpoint found to reconcile',
        code: 'missing_checkpoint',
      };
    }
    if (claim.checkpointId !== params.checkpointId) {
      return {
        success: false,
        error: `Checkpoint mismatch: expected '${claim.checkpointId}', got '${params.checkpointId}'`,
        code: 'checkpoint_mismatch',
      };
    }
    if (claim.managerTaskId && claim.managerTaskId !== params.managerTaskId) {
      return {
        success: false,
        error: `Bound Manager task mismatch: expected '${claim.managerTaskId}', got '${params.managerTaskId}'`,
        code: 'manager_task_mismatch',
      };
    }
    if (
      params.managerGeneration !== undefined &&
      claim.managerGeneration !== undefined &&
      claim.managerGeneration !== params.managerGeneration
    ) {
      return {
        success: false,
        error: `Manager generation mismatch: expected ${claim.managerGeneration}, got ${params.managerGeneration}`,
        code: 'generation_mismatch',
      };
    }

    // Authoritatively check background job board record
    if (!this.#getManagerTaskRecord) {
      return {
        success: false,
        error: 'Manager task verifier is not configured',
        code: 'verifier_unconfigured',
      };
    }
    const taskRecord = this.#getManagerTaskRecord(params.managerTaskId);
    let isBoardlessRecovery = false;
    if (taskRecord) {
      if (taskRecord.taskID !== params.managerTaskId) {
        return {
          success: false,
          error: `Manager task board ID '${taskRecord.taskID}' does not match requested task ID '${params.managerTaskId}'`,
          code: 'manager_task_mismatch',
        };
      }
      if (taskRecord.parentSessionID !== rootSessionId) {
        return {
          success: false,
          error: `Manager task '${params.managerTaskId}' is parented by '${taskRecord.parentSessionID}', not root session '${rootSessionId}'`,
          code: 'wrong_parent_session',
        };
      }
      const resolvedAgent = this.#resolveAgentName(taskRecord.agent);
      if (resolvedAgent !== 'outcome-manager') {
        return {
          success: false,
          error: `Task '${params.managerTaskId}' agent is '${taskRecord.agent}' (${resolvedAgent}), expected 'outcome-manager'`,
          code: 'wrong_agent_identity',
        };
      }
      if (
        claim.managerGeneration !== undefined &&
        taskRecord.generation !== claim.managerGeneration
      ) {
        return {
          success: false,
          error: `Task board generation ${taskRecord.generation} does not match claim managerGeneration ${claim.managerGeneration}`,
          code: 'generation_mismatch',
        };
      }
      const isCompleted =
        taskRecord.state === 'completed' ||
        (taskRecord.state === 'reconciled' &&
          taskRecord.terminalState === 'completed');
      if (!isCompleted) {
        return {
          success: false,
          error: `Manager task '${params.managerTaskId}' state is '${taskRecord.state}' and is not confirmed terminal completed`,
          code: 'task_not_completed',
        };
      }
    } else {
      const isBoardlessRecoveryEligible =
        claim.state === 'result_available' &&
        claim.serverEpoch !== this.#serverEpoch &&
        claim.dispatchCallId !== undefined &&
        claim.managerTaskId !== undefined &&
        claim.managerGeneration !== undefined &&
        claim.resultDigest !== undefined;

      if (!isBoardlessRecoveryEligible) {
        return {
          success: false,
          error: `Manager task '${params.managerTaskId}' is untracked on the background job board`,
          code: 'untracked_manager_task',
        };
      }

      if (
        params.managerGeneration === undefined ||
        params.managerGeneration !== claim.managerGeneration
      ) {
        return {
          success: false,
          error: `Manager generation mismatch: expected ${claim.managerGeneration}, got ${params.managerGeneration}`,
          code: 'generation_mismatch',
        };
      }

      isBoardlessRecovery = true;
    }

    if (!this.#readChildSessionResult) {
      return {
        success: false,
        error:
          'readChildSessionResult reader not configured on OutcomeController',
        code: 'reader_unconfigured',
      };
    }
    if (!isBoardlessRecovery && !this.#consumeManagerTask) {
      return {
        success: false,
        error: 'Manager task consumer is not configured',
        code: 'consumer_unconfigured',
      };
    }

    const sessionResult = await this.#readChildSessionResult(
      params.managerTaskId,
    );
    if (sessionResult?.terminal !== true || sessionResult.empty === true) {
      return {
        success: false,
        error: `Manager child session '${params.managerTaskId}' has not produced a non-empty terminal completed output`,
        code: 'result_not_terminal',
      };
    }

    const rawResultText = sessionResult.text;
    const resultDigest = canonicalDigest(
      'omos/manager-result/v1',
      rawResultText,
    );
    const existingSummary = record.reviewSummaries.find(
      (entry) =>
        entry.checkpointId === claim.checkpointId &&
        entry.claimGeneration === claim.claimGeneration,
    );
    if (
      existingSummary &&
      ['review_accepted', 'review_rejected'].includes(claim.state)
    ) {
      if (existingSummary.resultDigest !== resultDigest) {
        return {
          success: false,
          error:
            'Fetched Manager result differs from the result already reconciled for this claim',
          code: 'result_digest_mismatch',
        };
      }
      if (
        !this.#consumeManagerTask?.(
          rootSessionId,
          params.managerTaskId,
          claim.managerGeneration as number,
        )
      ) {
        return {
          success: false,
          error:
            'Persisted Manager task completion could not be consumed idempotently',
          code: 'manager_consumption_failed',
        };
      }
      return {
        success: true,
        data: {
          verdict: existingSummary.verdict,
          phase: record.phase,
          summary: existingSummary,
        },
      };
    }
    if (claim.state === 'review_invalid') {
      if (claim.resultDigest !== resultDigest) {
        return {
          success: false,
          error:
            'Fetched Manager result differs from the invalid result already reconciled for this claim',
          code: 'result_digest_mismatch',
        };
      }
      if (
        !this.#consumeManagerTask?.(
          rootSessionId,
          params.managerTaskId,
          claim.managerGeneration as number,
        )
      ) {
        return {
          success: false,
          error:
            'Persisted invalid Manager task could not be consumed idempotently',
          code: 'manager_consumption_failed',
        };
      }
      return {
        success: false,
        error: claim.recoveryNote ?? 'Manager review is invalid',
        code: 'review_invalid',
      };
    }
    if (
      claim.state === 'result_available' &&
      claim.resultDigest !== resultDigest
    ) {
      return {
        success: false,
        error:
          'Fetched Manager result does not match the result digest already bound to this claim',
        code: 'result_digest_mismatch',
      };
    }
    const claimToken =
      this.#claimSecrets.get(
        `${rootSessionId}:${record.outcomeId}:${claim.checkpointId}`,
      ) ??
      this.#claimSecrets.get(
        `${rootSessionId}:${record.outcomeId}:${claim.claimGeneration}`,
      ) ??
      '';
    const isRecoveredReview =
      claim.state === 'result_available' &&
      claim.serverEpoch !== this.#serverEpoch;
    const reconciliationKey = `${rootSessionId}:${params.managerTaskId}:${claim.managerGeneration}`;
    const previouslyConsumedDigest =
      this.#consumedReviewDigests.get(reconciliationKey);
    if (
      previouslyConsumedDigest !== undefined &&
      previouslyConsumedDigest !== resultDigest
    ) {
      return {
        success: false,
        error:
          'Manager result changed after its task generation was consumed; exact-result retry is required',
        code: 'consumed_result_mismatch',
      };
    }
    const claimValidation = this.#store.validateReviewClaim(rootSessionId, {
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken: isRecoveredReview ? undefined : claimToken,
      resultDigest,
      recovered: isRecoveredReview,
    });
    if (!claimValidation.success) {
      return {
        success: false,
        error: `Review claim authentication failed: ${claimValidation.error.message}`,
        code: 'review_auth_failed',
      };
    }

    const parseResult = safeParseOutcomeReview(rawResultText);
    let review: OutcomeReview | undefined;
    let invalidReason: string | undefined;
    let invalidCode: 'review_invalid' | 'review_auth_failed' = 'review_invalid';
    if (parseResult.success) {
      review = parseResult.data;
      const validation = this.#store.validateReview(rootSessionId, {
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        claimToken: isRecoveredReview ? undefined : claimToken,
        resultDigest,
        review,
        recovered: isRecoveredReview,
      });
      if (!validation.success) {
        invalidReason =
          `Review authentication failed against Controller contract: ${validation.error.message}`.slice(
            0,
            500,
          );
        invalidCode = 'review_auth_failed';
      }
    } else {
      invalidReason =
        `Malformed outcome review payload: ${parseResult.error}`.slice(0, 500);
    }

    if (!isBoardlessRecovery) {
      if (
        !this.#consumeManagerTask?.(
          rootSessionId,
          params.managerTaskId,
          claim.managerGeneration as number,
        )
      ) {
        return {
          success: false,
          error: 'Manager task completion could not be consumed consistently',
          code: 'manager_consumption_failed',
        };
      }
      this.#consumedReviewDigests.set(reconciliationKey, resultDigest);
    }

    const reviewRes = this.#store.persistReconciledReview(
      rootSessionId,
      invalidReason
        ? {
            outcome: 'invalid',
            checkpointId: claim.checkpointId,
            claimGeneration: claim.claimGeneration,
            claimToken: isRecoveredReview ? undefined : claimToken,
            resultDigest,
            reason: invalidReason,
            recovered: isRecoveredReview,
          }
        : {
            outcome: 'valid',
            checkpointId: claim.checkpointId,
            claimGeneration: claim.claimGeneration,
            claimToken: isRecoveredReview ? undefined : claimToken,
            resultDigest,
            review: review as OutcomeReview,
            recovered: isRecoveredReview,
          },
    );

    if (!reviewRes.success) {
      return {
        success: false,
        error: `Failed to persist reconciled review state: ${reviewRes.error.message}`,
        code: reviewRes.code,
      };
    }

    if (invalidReason) {
      this.#consumedReviewDigests.delete(reconciliationKey);
      return { success: false, error: invalidReason, code: invalidCode };
    }

    const updatedRecord = reviewRes.data;
    const latestSummary = updatedRecord.reviewSummaries.find(
      (entry) =>
        entry.checkpointId === claim.checkpointId &&
        entry.claimGeneration === claim.claimGeneration,
    ) as OutcomeManagerReviewSummary;
    this.#consumedReviewDigests.delete(reconciliationKey);

    return {
      success: true,
      data: {
        verdict: (review as OutcomeReview).verdict,
        phase: updatedRecord.phase,
        summary: latestSummary,
      },
    };
  }

  resolveUserDecision(
    rootSessionId: string,
    params: OutcomeResolveUserDecisionParams,
  ): OutcomeControllerResult<OutcomeResolveUserDecisionResult> {
    if (
      params.authorizationKind !== undefined &&
      params.authorizationKind !== 'user_decision'
    ) {
      return {
        success: false,
        error:
          'Decision resolution can mint only user_decision authority; use registerRepositoryWaiver for repository authority',
        code: 'invalid_authorization_kind',
      };
    }
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome record found: ${recRes.error.message}`,
        code: recRes.code,
      };
    }
    let record = recRes.data;

    const existingDecision = record.receipts.decisions.find(
      (d) => d.id === params.decisionId,
    );
    if (!existingDecision) {
      return {
        success: false,
        error: `Decision '${params.decisionId}' does not exist in durable outcome record`,
        code: 'decision_not_found',
      };
    }
    if (existingDecision.chosenOption !== undefined) {
      return {
        success: false,
        error: `Decision '${params.decisionId}' is already resolved with option '${existingDecision.chosenOption}'`,
        code: 'decision_already_resolved',
      };
    }
    if (!existingDecision.options.includes(params.chosenOption)) {
      return {
        success: false,
        error: `Chosen option '${params.chosenOption}' is not in available options [${existingDecision.options.join(', ')}]`,
        code: 'invalid_decision_option',
      };
    }

    const userMessage = record.receipts.userMessages.find(
      (m) => m.id === params.sourceUserMessageReceiptId,
    );
    if (!userMessage) {
      return {
        success: false,
        error: `User message receipt '${params.sourceUserMessageReceiptId}' not found in durable record`,
        code: 'missing_user_message',
      };
    }

    const now = this.#clock();

    const resolveDecisionRes = this.#store.mutate(
      rootSessionId,
      record.revision,
      {
        type: 'resolve_decision',
        decisionId: params.decisionId,
        chosenOption: params.chosenOption,
        sourceUserMessageReceiptId: params.sourceUserMessageReceiptId,
        decidedAt: now,
      },
    );
    if (!resolveDecisionRes.success) {
      return {
        success: false,
        error: `Failed to resolve decision: ${resolveDecisionRes.error.message}`,
        code: resolveDecisionRes.code,
      };
    }
    record = resolveDecisionRes.data;

    if (params.authorizationKind === 'user_decision') {
      const authId = `auth_${this.#randomId().replace(/-/g, '').slice(0, 16)}`;
      const payloadDigest = computeOutcomeAuthorizationDigest({
        id: authId,
        kind: 'user_decision',
        reference: params.decisionId,
        decisionId: params.decisionId,
        observedAt: now,
      });
      const authReceipt: OutcomeAuthorizationReceipt = {
        id: authId,
        kind: 'user_decision',
        reference: params.decisionId,
        payloadDigest,
        decisionId: params.decisionId,
        observedAt: now,
      };
      const appendAuthRes = this.#store.mutate(rootSessionId, record.revision, {
        type: 'append_authorization',
        receipt: authReceipt,
      });
      if (!appendAuthRes.success) {
        return {
          success: false,
          error: `Failed to record authorization receipt: ${appendAuthRes.error.message}`,
          code: appendAuthRes.code,
        };
      }
      record = appendAuthRes.data;
    }

    return {
      success: true,
      data: {
        decisionId: params.decisionId,
        revision: record.revision,
        phase: record.phase,
      },
    };
  }

  registerRepositoryWaiver(
    rootSessionId: string,
    params: OutcomeRegisterRepositoryWaiverParams,
  ): OutcomeControllerResult<OutcomeRegisterRepositoryWaiverResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    if (recRes.data.phase === 'accepted') {
      return {
        success: false,
        error: 'Accepted outcome is immutable',
        code: 'invalid_transition',
      };
    }
    const reference = params.repositoryReference.trim();
    if (reference.length === 0 || reference.length > 256) {
      return {
        success: false,
        error: 'Repository waiver reference must contain 1-256 characters',
        code: 'invalid_repository_reference',
      };
    }
    const authorizationId = `auth_${this.#randomId().replace(/-/g, '').slice(0, 16)}`;
    const observedAt = this.#clock();
    const receipt: OutcomeAuthorizationReceipt = {
      id: authorizationId,
      kind: 'repository_waiver',
      reference,
      payloadDigest: '',
      observedAt,
    };
    receipt.payloadDigest = computeOutcomeAuthorizationDigest(receipt);
    const result = this.#store.mutate(rootSessionId, recRes.data.revision, {
      type: 'append_authorization',
      receipt,
    });
    if (!result.success) {
      return { success: false, error: result.error.message, code: result.code };
    }
    return {
      success: true,
      data: {
        authorizationId,
        revision: result.data.revision,
        kind: 'repository_waiver',
        reference,
        payloadDigest: receipt.payloadDigest,
      },
    };
  }

  externalHandoff(
    rootSessionId: string,
    params: OutcomeExternalHandoffParams,
  ): OutcomeControllerResult<OutcomeExternalHandoffResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome record found: ${recRes.error.message}`,
        code: recRes.code,
      };
    }
    const record = recRes.data;
    const now = this.#clock();

    const instructions =
      params.instructions ??
      'OpenCode process restart requested. Work is paused until restart completes and user returns.';

    const mutateRes = this.#store.mutate(rootSessionId, record.revision, {
      type: 'set_wait',
      wait: {
        kind: 'external_handoff',
        referenceId: 'ext_restart',
        reason:
          params.reason ??
          'Restarting OpenCode process to reload environment/configuration',
        createdAt: now,
        createdRevision: record.revision + 1,
        originatingServerEpoch: this.#serverEpoch,
        instructions,
        expectedPostRestartCheck: params.expectedPostRestartCheck,
      },
    });
    if (!mutateRes.success) {
      return {
        success: false,
        error: `Failed to set external handoff wait: ${mutateRes.error.message}`,
        code: mutateRes.code,
      };
    }

    return {
      success: true,
      data: {
        phase: mutateRes.data.phase,
        instructions,
        expectedPostRestartCheck: params.expectedPostRestartCheck,
      },
    };
  }

  updateGoalStatus(
    rootSessionId: string,
    params: { goalId: string; status: 'satisfied' },
  ): OutcomeControllerResult<OutcomeProtocolUpdateResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const result = this.#store.mutate(rootSessionId, recRes.data.revision, {
      type: 'update_goal_status',
      goalId: params.goalId,
      newStatus: params.status,
    });
    return result.success
      ? {
          success: true,
          data: {
            revision: result.data.revision,
            phase: result.data.phase,
            contractDigest: result.data.contractDigest,
          },
        }
      : { success: false, error: result.error.message, code: result.code };
  }

  reviseContract(
    rootSessionId: string,
    params: {
      contract: OutcomeContract;
      sourceUserMessageReceiptId?: string;
    },
  ): OutcomeControllerResult<OutcomeProtocolUpdateResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const result = this.#store.mutate(rootSessionId, recRes.data.revision, {
      type: 'revise_contract',
      contract: params.contract,
      sourceUserMessageReceiptId: params.sourceUserMessageReceiptId,
    });
    return result.success
      ? {
          success: true,
          data: {
            revision: result.data.revision,
            phase: result.data.phase,
            contractDigest: result.data.contractDigest,
          },
        }
      : { success: false, error: result.error.message, code: result.code };
  }

  completeExternalHandoff(
    rootSessionId: string,
    params: {
      sourceUserMessageReceiptId: string;
      evidenceAttestationId: string;
    },
  ): OutcomeControllerResult<OutcomeProtocolUpdateResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const record = recRes.data;
    const wait = record.waitCondition;
    if (wait?.kind !== 'external_handoff') {
      return { success: false, error: 'No external handoff is waiting' };
    }
    if (
      !wait.originatingServerEpoch ||
      wait.originatingServerEpoch === this.#serverEpoch ||
      wait.restartObservedRevision === undefined
    ) {
      return {
        success: false,
        error:
          'External handoff completion requires a different Controller server epoch',
        code: 'restart_not_observed',
      };
    }
    const userReceipt = record.receipts.userMessages.find(
      (entry) => entry.id === params.sourceUserMessageReceiptId,
    );
    const restartRevision = wait.restartObservedRevision;
    if (
      !userReceipt ||
      userReceipt.createdRevision <= restartRevision ||
      userReceipt.observedEpoch !== this.#serverEpoch
    ) {
      return {
        success: false,
        error: 'External handoff completion requires a subsequent user receipt',
      };
    }
    const evidence = record.receipts.evidence.find(
      (entry) => entry.id === params.evidenceAttestationId,
    );
    if (
      evidence?.kind !== 'orchestrator_attestation' ||
      evidence.createdRevision <= restartRevision ||
      evidence.assertedStatus !== 'passed' ||
      evidence.assertedFreshness !== 'fresh' ||
      (wait.expectedPostRestartCheck &&
        evidence.description !== wait.expectedPostRestartCheck)
    ) {
      return {
        success: false,
        error:
          'External handoff completion requires matching fresh passed post-restart evidence',
      };
    }
    const result = this.#store.mutate(rootSessionId, record.revision, {
      type: 'complete_external_handoff',
      waitReferenceId: wait.referenceId,
      waitCreatedRevision: wait.createdRevision,
      waitOriginatingServerEpoch: wait.originatingServerEpoch,
      waitRestartObservedRevision: wait.restartObservedRevision,
      expectedPostRestartCheck: wait.expectedPostRestartCheck,
      sourceUserMessageReceiptId: params.sourceUserMessageReceiptId,
      evidenceAttestationId: params.evidenceAttestationId,
    });
    return result.success
      ? {
          success: true,
          data: {
            revision: result.data.revision,
            phase: result.data.phase,
            contractDigest: result.data.contractDigest,
          },
        }
      : { success: false, error: result.error.message, code: result.code };
  }

  async supersedeExternalHandoff(
    rootSessionId: string,
    params: OutcomeSupersedeExternalHandoffParams,
  ): Promise<OutcomeControllerResult<OutcomeProtocolUpdateResult>> {
    if (
      !params.reason ||
      typeof params.reason !== 'string' ||
      params.reason.trim() === '' ||
      params.reason.trim().length > 512
    ) {
      return {
        success: false,
        error:
          'Supersession reason must be a non-empty string of at most 512 characters',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.waitReferenceId ||
      typeof params.waitReferenceId !== 'string' ||
      params.waitReferenceId.trim() === ''
    ) {
      return {
        success: false,
        error: 'waitReferenceId must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      typeof params.waitCreatedRevision !== 'number' ||
      !Number.isInteger(params.waitCreatedRevision) ||
      params.waitCreatedRevision <= 0
    ) {
      return {
        success: false,
        error: 'waitCreatedRevision must be a positive integer',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.waitOriginatingServerEpoch ||
      typeof params.waitOriginatingServerEpoch !== 'string' ||
      params.waitOriginatingServerEpoch.trim() === ''
    ) {
      return {
        success: false,
        error: 'waitOriginatingServerEpoch must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      typeof params.waitRestartObservedRevision !== 'number' ||
      !Number.isInteger(params.waitRestartObservedRevision) ||
      params.waitRestartObservedRevision <= params.waitCreatedRevision
    ) {
      return {
        success: false,
        error:
          'waitRestartObservedRevision must be an integer greater than waitCreatedRevision',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.waitInstructions ||
      typeof params.waitInstructions !== 'string' ||
      params.waitInstructions.trim() === ''
    ) {
      return {
        success: false,
        error: 'waitInstructions must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.expectedPostRestartCheck ||
      typeof params.expectedPostRestartCheck !== 'string' ||
      params.expectedPostRestartCheck.trim() === ''
    ) {
      return {
        success: false,
        error: 'expectedPostRestartCheck must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.retiredCheckpointId ||
      typeof params.retiredCheckpointId !== 'string' ||
      params.retiredCheckpointId.trim() === ''
    ) {
      return {
        success: false,
        error: 'retiredCheckpointId must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      typeof params.retiredClaimGeneration !== 'number' ||
      !Number.isInteger(params.retiredClaimGeneration) ||
      params.retiredClaimGeneration <= 0
    ) {
      return {
        success: false,
        error: 'retiredClaimGeneration must be a positive integer',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.sourceUserMessageReceiptId ||
      typeof params.sourceUserMessageReceiptId !== 'string' ||
      params.sourceUserMessageReceiptId.trim() === ''
    ) {
      return {
        success: false,
        error: 'sourceUserMessageReceiptId must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.evidenceAttestationId ||
      typeof params.evidenceAttestationId !== 'string' ||
      params.evidenceAttestationId.trim() === ''
    ) {
      return {
        success: false,
        error: 'evidenceAttestationId must be a non-empty string',
        code: 'invalid_parameter',
      };
    }
    if (
      !params.replacementCandidateFingerprint ||
      typeof params.replacementCandidateFingerprint !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(params.replacementCandidateFingerprint)
    ) {
      return {
        success: false,
        error:
          'replacementCandidateFingerprint must be a valid sha256:<64-hex> digest',
        code: 'invalid_parameter',
      };
    }

    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const record = recRes.data;

    // Check if already superseded (idempotent retry)
    if (!record.waitCondition) {
      const existing = record.receipts.handoffSupersessions?.find(
        (entry) =>
          entry.waitReferenceId === params.waitReferenceId &&
          entry.waitCreatedRevision === params.waitCreatedRevision &&
          entry.retiredCheckpointId === params.retiredCheckpointId &&
          entry.retiredClaimGeneration === params.retiredClaimGeneration,
      );
      if (existing) {
        if (!this.#readChildSessionResult) {
          return {
            success: false,
            error:
              'readChildSessionResult reader not configured on OutcomeController',
            code: 'reader_unconfigured',
          };
        }
        const sessionResult = await this.#readChildSessionResult(
          existing.retiredManagerTaskId,
        );
        if (sessionResult?.terminal !== true || sessionResult.empty === true) {
          return {
            success: false,
            error:
              'Manager child session has not produced a non-empty terminal completed output',
            code: 'result_not_terminal',
          };
        }
        const authoritativeDigest = canonicalDigest(
          'omos/manager-result/v1',
          sessionResult.text,
        );
        const expectedDigest = computeOutcomeHandoffSupersessionDigest({
          ...existing,
          reason: params.reason,
        });

        if (
          existing.waitOriginatingServerEpoch ===
            params.waitOriginatingServerEpoch &&
          existing.waitRestartObservedRevision ===
            params.waitRestartObservedRevision &&
          existing.waitInstructions === params.waitInstructions &&
          existing.expectedPostRestartCheck ===
            params.expectedPostRestartCheck &&
          existing.sourceUserMessageReceiptId ===
            params.sourceUserMessageReceiptId &&
          existing.evidenceAttestationId === params.evidenceAttestationId &&
          existing.replacementCandidateFingerprint ===
            params.replacementCandidateFingerprint &&
          existing.reason.trim() === params.reason.trim() &&
          existing.observedChildResultDigest === authoritativeDigest &&
          existing.payloadDigest === expectedDigest
        ) {
          return {
            success: true,
            data: {
              revision: record.revision,
              phase: record.phase,
              contractDigest: record.contractDigest,
            },
          };
        }
        return {
          success: false,
          error:
            'External handoff was already superseded with different parameters',
          code: 'invalid_transition',
        };
      }
      return {
        success: false,
        error: 'No external handoff is waiting',
        code: 'no_external_handoff',
      };
    }

    const wait = record.waitCondition;
    if (wait.kind !== 'external_handoff') {
      return {
        success: false,
        error: 'Active wait condition is not an external handoff',
        code: 'invalid_wait_kind',
      };
    }
    if (wait.referenceId !== params.waitReferenceId) {
      return {
        success: false,
        error: `Wait reference ID mismatch: expected '${wait.referenceId}', got '${params.waitReferenceId}'`,
        code: 'wait_reference_mismatch',
      };
    }
    if (wait.createdRevision !== params.waitCreatedRevision) {
      return {
        success: false,
        error: `Wait created revision mismatch: expected ${wait.createdRevision}, got ${params.waitCreatedRevision}`,
        code: 'wait_revision_mismatch',
      };
    }
    if (wait.originatingServerEpoch !== params.waitOriginatingServerEpoch) {
      return {
        success: false,
        error: `Wait originating server epoch mismatch: expected '${wait.originatingServerEpoch}', got '${params.waitOriginatingServerEpoch}'`,
        code: 'wait_epoch_mismatch',
      };
    }
    if (wait.restartObservedRevision !== params.waitRestartObservedRevision) {
      return {
        success: false,
        error: `Wait restart observed revision mismatch: expected ${wait.restartObservedRevision}, got ${params.waitRestartObservedRevision}`,
        code: 'restart_revision_mismatch',
      };
    }
    if (wait.instructions !== params.waitInstructions) {
      return {
        success: false,
        error: `Wait instructions mismatch: expected '${wait.instructions}', got '${params.waitInstructions}'`,
        code: 'wait_instructions_mismatch',
      };
    }
    if (wait.expectedPostRestartCheck !== params.expectedPostRestartCheck) {
      return {
        success: false,
        error: `Wait expected post restart check mismatch: expected '${wait.expectedPostRestartCheck}', got '${params.expectedPostRestartCheck}'`,
        code: 'expected_check_mismatch',
      };
    }
    if (wait.originatingServerEpoch === this.#serverEpoch) {
      return {
        success: false,
        error:
          'Superseding external handoff requires a different Controller server epoch',
        code: 'restart_not_observed',
      };
    }
    if (
      !params.expectedPostRestartCheck.includes(params.retiredCheckpointId) &&
      !params.waitInstructions.includes(params.retiredCheckpointId)
    ) {
      return {
        success: false,
        error:
          'Exact handoff instructions or expected check must contain retired checkpoint ID',
        code: 'checkpoint_not_in_expected_check',
      };
    }

    const claim = record.checkpoint;
    if (!claim) {
      return {
        success: false,
        error: 'Missing retired checkpoint',
        code: 'missing_checkpoint',
      };
    }
    if (claim.checkpointId !== params.retiredCheckpointId) {
      return {
        success: false,
        error: `Retired checkpoint ID mismatch: expected '${claim.checkpointId}', got '${params.retiredCheckpointId}'`,
        code: 'checkpoint_mismatch',
      };
    }
    if (claim.claimGeneration !== params.retiredClaimGeneration) {
      return {
        success: false,
        error: `Retired claim generation mismatch: expected ${claim.claimGeneration}, got ${params.retiredClaimGeneration}`,
        code: 'generation_mismatch',
      };
    }
    if (claim.kind !== 'final') {
      return {
        success: false,
        error: 'Superseded handoff requires a retired final checkpoint',
        code: 'checkpoint_not_final',
      };
    }
    if (claim.state !== 'retired') {
      return {
        success: false,
        error: `Checkpoint state is '${claim.state}', expected 'retired'`,
        code: 'checkpoint_not_retired',
      };
    }
    if (
      !claim.dispatchCallId ||
      !claim.managerTaskId ||
      claim.managerGeneration === undefined ||
      !claim.resultDigest
    ) {
      return {
        success: false,
        error:
          'Retired checkpoint lacks complete Manager identity or result digest',
        code: 'incomplete_claim_identity',
      };
    }
    if (!claim.recoveryNote) {
      return {
        success: false,
        error: 'Retired checkpoint lacks recovery note',
        code: 'missing_recovery_note',
      };
    }
    const parsedNote = parseMisboundRetirementNote(claim.recoveryNote);
    if (!parsedNote) {
      return {
        success: false,
        error:
          'Retired checkpoint lacks a valid misbound retirement audit note',
        code: 'invalid_retirement_audit',
      };
    }
    if (parsedNote.boundDigest !== claim.resultDigest) {
      return {
        success: false,
        error: 'Audit bound digest does not match claim result digest',
        code: 'audit_bound_digest_mismatch',
      };
    }
    if (parsedNote.observedDigest === parsedNote.boundDigest) {
      return {
        success: false,
        error: 'Audit observed digest must differ from bound digest',
        code: 'audit_observed_digest_equals_bound',
      };
    }

    if (!this.#readChildSessionResult) {
      return {
        success: false,
        error:
          'readChildSessionResult reader not configured on OutcomeController',
        code: 'reader_unconfigured',
      };
    }
    const sessionResult = await this.#readChildSessionResult(
      claim.managerTaskId,
    );
    if (sessionResult?.terminal !== true || sessionResult.empty === true) {
      return {
        success: false,
        error: `Manager child session '${claim.managerTaskId}' has not produced a non-empty terminal completed output`,
        code: 'result_not_terminal',
      };
    }
    const authoritativeDigest = canonicalDigest(
      'omos/manager-result/v1',
      sessionResult.text,
    );
    if (authoritativeDigest !== parsedNote.observedDigest) {
      return {
        success: false,
        error:
          'Controller-authoritative terminal child digest does not match audit observed digest',
        code: 'authoritative_digest_mismatch',
      };
    }

    const userReceipt = record.receipts.userMessages.find(
      (entry) => entry.id === params.sourceUserMessageReceiptId,
    );
    if (
      userReceipt?.provenance !== 'external_user' ||
      userReceipt.createdRevision <= wait.restartObservedRevision ||
      userReceipt.observedEpoch !== this.#serverEpoch
    ) {
      return {
        success: false,
        error:
          'Superseding external handoff requires a fresh external_user receipt minted after restart observation in current epoch',
        code: 'invalid_user_provenance',
      };
    }

    const evidence = record.receipts.evidence.find(
      (entry) => entry.id === params.evidenceAttestationId,
    );
    if (
      evidence?.kind !== 'orchestrator_attestation' ||
      evidence.createdRevision <= userReceipt.createdRevision ||
      evidence.assertedStatus !== 'passed' ||
      evidence.assertedFreshness !== 'fresh' ||
      evidence.candidateFingerprint !== params.replacementCandidateFingerprint
    ) {
      return {
        success: false,
        error:
          'Superseding external handoff requires fresh passed evidence minted after user receipt matching replacement candidate',
        code: 'invalid_evidence_provenance',
      };
    }

    const result = this.#store.mutate(rootSessionId, record.revision, {
      type: 'supersede_external_handoff',
      reason: params.reason,
      waitReferenceId: params.waitReferenceId,
      waitCreatedRevision: params.waitCreatedRevision,
      waitOriginatingServerEpoch: params.waitOriginatingServerEpoch,
      waitRestartObservedRevision: params.waitRestartObservedRevision,
      waitInstructions: params.waitInstructions,
      expectedPostRestartCheck: params.expectedPostRestartCheck,
      retiredCheckpointId: params.retiredCheckpointId,
      retiredClaimGeneration: params.retiredClaimGeneration,
      retiredDispatchCallId: claim.dispatchCallId,
      retiredManagerTaskId: claim.managerTaskId,
      retiredManagerGeneration: claim.managerGeneration,
      retiredBoundResultDigest: parsedNote.boundDigest,
      observedChildResultDigest: authoritativeDigest,
      retiredReasonDigest: parsedNote.reasonDigest,
      sourceUserMessageReceiptId: params.sourceUserMessageReceiptId,
      evidenceAttestationId: params.evidenceAttestationId,
      replacementCandidateFingerprint: params.replacementCandidateFingerprint,
    });
    if (!result.success) {
      return { success: false, error: result.error.message, code: result.code };
    }
    return {
      success: true,
      data: {
        revision: result.data.revision,
        phase: result.data.phase,
        contractDigest: result.data.contractDigest,
      },
    };
  }

  resolveAction(
    rootSessionId: string,
    params: {
      actionId: string;
      reason: string;
      sourceUserMessageReceiptId?: string;
      evidenceAttestationIds?: string[];
    },
  ): OutcomeControllerResult<OutcomeProtocolUpdateResult> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const result = this.#store.mutate(rootSessionId, recRes.data.revision, {
      type: 'resolve_action',
      ...params,
    });
    return result.success
      ? {
          success: true,
          data: {
            revision: result.data.revision,
            phase: result.data.phase,
            contractDigest: result.data.contractDigest,
          },
        }
      : { success: false, error: result.error.message, code: result.code };
  }

  finalize(
    rootSessionId: string,
    params: { summary: string },
  ): OutcomeControllerResult<OutcomeFinalizeResult> {
    if (this.#hasRunningChildren?.(rootSessionId)) {
      return {
        success: false,
        error:
          'Active running child tasks block finalization. Wait for all subagents to finish or cancel obsolete tasks.',
        code: 'running_tasks_present',
      };
    }
    if (this.#hasTerminalUnreconciledChildren?.(rootSessionId)) {
      return {
        success: false,
        error:
          'Terminal unreconciled background tasks block finalization. Retrieve or acknowledge terminal tasks before finalization.',
        code: 'unreconciled_tasks_present',
      };
    }

    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome record found: ${recRes.error.message}`,
        code: recRes.code,
      };
    }
    const record = recRes.data;

    const finalizeRes = this.#store.mutate(rootSessionId, record.revision, {
      type: 'finalize',
      summary: params.summary,
    });
    if (!finalizeRes.success) {
      return {
        success: false,
        error: `Finalization blocked: ${finalizeRes.error.message}`,
        code: finalizeRes.code,
      };
    }

    const updated = finalizeRes.data;
    const certificate = updated.finalCertificate as OutcomeFinalCertificate;

    return {
      success: true,
      data: {
        certificate,
        assurance: 'orchestrator_attestation',
      },
    };
  }

  expireCheckpoint(
    rootSessionId: string,
    params: { checkpointId: string; reason: string },
  ): OutcomeControllerResult<OutcomeRecord> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) return { success: false, error: recRes.error.message };
    const record = recRes.data;
    const claim = record.checkpoint;
    if (!claim || claim.checkpointId !== params.checkpointId) {
      return {
        success: false,
        error: `Checkpoint '${params.checkpointId}' not found on record`,
      };
    }
    const claimToken =
      this.#claimSecrets.get(
        `${rootSessionId}:${record.outcomeId}:${claim.checkpointId}`,
      ) ??
      this.#claimSecrets.get(
        `${rootSessionId}:${record.outcomeId}:${claim.claimGeneration}`,
      ) ??
      '';
    const res = this.#store.mutate(rootSessionId, record.revision, {
      type: 'expire_checkpoint',
      checkpointId: params.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken,
      reason: params.reason,
    });
    return res.success
      ? { success: true, data: res.data }
      : { success: false, error: res.error.message };
  }

  async reconcileUncertain(
    rootSessionId: string,
    params: OutcomeReconcileUncertainParams,
  ): Promise<OutcomeControllerResult<OutcomeRecord>> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const record = recRes.data;
    const claim = record.checkpoint;
    if (!claim || claim.checkpointId !== params.checkpointId) {
      return {
        success: false,
        error: `Checkpoint '${params.checkpointId}' not found on record`,
        code: 'checkpoint_not_found',
      };
    }

    if (
      params.resolution.kind === 'retire' ||
      params.resolution.kind === 'result_available'
    ) {
      const res = this.#store.mutate(rootSessionId, record.revision, {
        type: 'reconcile_uncertain_checkpoint',
        checkpointId: params.checkpointId,
        claimGeneration: claim.claimGeneration,
        resolution: params.resolution,
      });
      return res.success
        ? { success: true, data: res.data }
        : { success: false, error: res.error.message, code: res.code };
    }

    if (params.resolution.kind === 'retire_misbound_result') {
      const resolution = params.resolution;
      if (
        !resolution.reason ||
        typeof resolution.reason !== 'string' ||
        resolution.reason.trim() === '' ||
        resolution.reason.trim().length > 512
      ) {
        return {
          success: false,
          error:
            'Retirement reason must be a non-empty string of at most 512 characters',
          code: 'invalid_parameter',
        };
      }
      if (
        !resolution.dispatchCallId ||
        typeof resolution.dispatchCallId !== 'string' ||
        resolution.dispatchCallId.trim() === ''
      ) {
        return {
          success: false,
          error: 'dispatchCallId must be a non-empty string',
          code: 'invalid_parameter',
        };
      }
      if (
        !resolution.managerTaskId ||
        typeof resolution.managerTaskId !== 'string' ||
        resolution.managerTaskId.trim() === ''
      ) {
        return {
          success: false,
          error: 'managerTaskId must be a non-empty string',
          code: 'invalid_parameter',
        };
      }
      if (
        typeof resolution.managerGeneration !== 'number' ||
        !Number.isInteger(resolution.managerGeneration) ||
        resolution.managerGeneration <= 0
      ) {
        return {
          success: false,
          error: 'managerGeneration must be a positive integer',
          code: 'invalid_parameter',
        };
      }
      if (
        !resolution.boundResultDigest ||
        typeof resolution.boundResultDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(resolution.boundResultDigest)
      ) {
        return {
          success: false,
          error: 'boundResultDigest must be a valid sha256:<64-hex> digest',
          code: 'invalid_parameter',
        };
      }

      if (claim.state !== 'result_available' && claim.state !== 'retired') {
        return {
          success: false,
          error: `Checkpoint state is '${claim.state}', expected 'result_available' for misbound result retirement`,
          code: 'invalid_checkpoint_state',
        };
      }
      if (claim.serverEpoch === this.#serverEpoch) {
        return {
          success: false,
          error: 'Retiring misbound result requires a prior-epoch claim',
          code: 'current_epoch_retirement_forbidden',
        };
      }
      if (
        !claim.dispatchCallId ||
        !claim.managerTaskId ||
        claim.managerGeneration === undefined ||
        !claim.resultDigest
      ) {
        return {
          success: false,
          error:
            'Checkpoint claim lacks complete durable Manager identity or result digest',
          code: 'incomplete_claim_identity',
        };
      }
      if (claim.dispatchCallId !== resolution.dispatchCallId) {
        return {
          success: false,
          error: `Bound dispatch call ID mismatch: expected '${claim.dispatchCallId}', got '${resolution.dispatchCallId}'`,
          code: 'dispatch_call_mismatch',
        };
      }
      if (claim.managerTaskId !== resolution.managerTaskId) {
        return {
          success: false,
          error: `Bound Manager task mismatch: expected '${claim.managerTaskId}', got '${resolution.managerTaskId}'`,
          code: 'manager_task_mismatch',
        };
      }
      if (claim.managerGeneration !== resolution.managerGeneration) {
        return {
          success: false,
          error: `Manager generation mismatch: expected ${claim.managerGeneration}, got ${resolution.managerGeneration}`,
          code: 'generation_mismatch',
        };
      }
      if (claim.resultDigest !== resolution.boundResultDigest) {
        return {
          success: false,
          error: `Bound result digest mismatch: expected '${claim.resultDigest}', got '${resolution.boundResultDigest}'`,
          code: 'bound_digest_mismatch',
        };
      }

      if (!this.#getManagerTaskRecord) {
        return {
          success: false,
          error: 'Manager task verifier is not configured',
          code: 'verifier_unconfigured',
        };
      }

      const taskRecord = this.#getManagerTaskRecord(resolution.managerTaskId);
      let isBoardless = false;
      if (taskRecord) {
        if (taskRecord.taskID !== resolution.managerTaskId) {
          return {
            success: false,
            error: `Manager task board ID '${taskRecord.taskID}' does not match requested task ID '${resolution.managerTaskId}'`,
            code: 'manager_task_mismatch',
          };
        }
        if (taskRecord.parentSessionID !== rootSessionId) {
          return {
            success: false,
            error: `Manager task '${resolution.managerTaskId}' is parented by '${taskRecord.parentSessionID}', not root session '${rootSessionId}'`,
            code: 'wrong_parent_session',
          };
        }
        const resolvedAgent = this.#resolveAgentName(taskRecord.agent);
        if (resolvedAgent !== 'outcome-manager') {
          return {
            success: false,
            error: `Task '${resolution.managerTaskId}' agent is '${taskRecord.agent}' (${resolvedAgent}), expected 'outcome-manager'`,
            code: 'wrong_agent_identity',
          };
        }
        if (taskRecord.generation !== claim.managerGeneration) {
          return {
            success: false,
            error: `Task board generation ${taskRecord.generation} does not match claim managerGeneration ${claim.managerGeneration}`,
            code: 'generation_mismatch',
          };
        }
        const isCompleted =
          taskRecord.state === 'completed' ||
          (taskRecord.state === 'reconciled' &&
            taskRecord.terminalState === 'completed');
        if (!isCompleted) {
          return {
            success: false,
            error: `Manager task '${resolution.managerTaskId}' state is '${taskRecord.state}' and is not confirmed terminal completed`,
            code: 'task_not_completed',
          };
        }
      } else {
        isBoardless = true;
      }

      if (!this.#readChildSessionResult) {
        return {
          success: false,
          error:
            'readChildSessionResult reader not configured on OutcomeController',
          code: 'reader_unconfigured',
        };
      }
      if (!isBoardless && !this.#consumeManagerTask) {
        return {
          success: false,
          error: 'Manager task consumer is not configured',
          code: 'consumer_unconfigured',
        };
      }

      const sessionResult = await this.#readChildSessionResult(
        resolution.managerTaskId,
      );
      if (sessionResult?.terminal !== true || sessionResult.empty === true) {
        return {
          success: false,
          error: `Manager child session '${resolution.managerTaskId}' has not produced a non-empty terminal completed output`,
          code: 'result_not_terminal',
        };
      }
      const authoritativeDigest = canonicalDigest(
        'omos/manager-result/v1',
        sessionResult.text,
      );
      if (authoritativeDigest === claim.resultDigest) {
        return {
          success: false,
          error:
            'Authoritative Manager result matches bound digest; retirement for misbound result rejected',
          code: 'result_digest_matches',
        };
      }

      const expectedNote = formatMisboundRetirementNote(
        resolution.boundResultDigest,
        authoritativeDigest,
        resolution.reason,
      );
      if (claim.state === 'retired') {
        if (claim.recoveryNote !== expectedNote) {
          return {
            success: false,
            error:
              'Checkpoint is already retired and does not match the exact misbound retirement transition',
            code: 'invalid_checkpoint_state',
          };
        }
      }

      const reconciliationKey = `${rootSessionId}:${resolution.managerTaskId}:${claim.managerGeneration}`;
      const previouslyConsumedDigest =
        this.#consumedReviewDigests.get(reconciliationKey);
      if (
        previouslyConsumedDigest !== undefined &&
        previouslyConsumedDigest !== authoritativeDigest
      ) {
        return {
          success: false,
          error:
            'Manager result changed after its task generation was consumed; exact-result retry is required',
          code: 'consumed_result_mismatch',
        };
      }

      if (!isBoardless) {
        if (
          !this.#consumeManagerTask?.(
            rootSessionId,
            resolution.managerTaskId,
            claim.managerGeneration,
          )
        ) {
          return {
            success: false,
            error: 'Manager task completion could not be consumed consistently',
            code: 'manager_consumption_failed',
          };
        }
        this.#consumedReviewDigests.set(reconciliationKey, authoritativeDigest);
      }

      const res = this.#store.mutate(rootSessionId, record.revision, {
        type: 'retire_misbound_recovered_result',
        checkpointId: params.checkpointId,
        claimGeneration: claim.claimGeneration,
        dispatchCallId: resolution.dispatchCallId,
        managerTaskId: resolution.managerTaskId,
        managerGeneration: resolution.managerGeneration,
        boundResultDigest: resolution.boundResultDigest,
        observedResultDigest: authoritativeDigest,
        reason: resolution.reason,
      });
      if (!res.success) {
        return {
          success: false,
          error: res.error.message,
          code: res.code,
        };
      }
      this.#consumedReviewDigests.delete(reconciliationKey);
      return { success: true, data: res.data };
    }

    const unreachable: never = params.resolution;
    return {
      success: false,
      error: `Unknown reconcile_uncertain resolution kind: ${String((unreachable as { kind?: unknown }).kind)}`,
      code: 'invalid_parameter',
    };
  }

  acknowledgeOperation(
    rootSessionId: string,
    params: { operationId: string },
  ): OutcomeControllerResult<OutcomeRecord> {
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) return { success: false, error: recRes.error.message };
    const record = recRes.data;
    const res = this.#store.mutate(rootSessionId, record.revision, {
      type: 'acknowledge_operation',
      operationId: params.operationId,
    });
    return res.success
      ? { success: true, data: res.data }
      : { success: false, error: res.error.message };
  }

  observeToolBefore(
    rootSessionId: string,
    callId: string,
    toolName: string,
    args: unknown,
  ): OutcomeControllerResult<{ observationId: string; operationId: string }> {
    if (toolName === 'outcome_control') {
      return {
        success: true,
        data: { observationId: '', operationId: '' },
      };
    }
    const recRes = this.readRecord(rootSessionId);
    if (!recRes.success) {
      return {
        success: false,
        error: recRes.error.message,
        code: recRes.code,
      };
    }
    const record = recRes.data;
    if (record.phase === 'accepted') {
      return {
        success: true,
        data: { observationId: '', operationId: '' },
      };
    }

    const argumentDigest = canonicalDigest('omos/tool-args/v1', args);
    const now = this.#clock();
    const operationId = `op_${callId}`;
    const observationId = `obs_${callId}`;

    const operation: OutcomePendingOperation = {
      id: operationId,
      callId,
      toolName,
      argumentDigest,
      serverEpoch: this.#serverEpoch,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    };

    const observation: OutcomeToolObservation = {
      id: observationId,
      kind: 'controller_observed',
      callId,
      toolName,
      argumentDigest,
      startedEpoch: this.#serverEpoch,
      startedAt: now,
      completionObserved: false,
    };

    const startRes = this.#store.mutate(rootSessionId, record.revision, {
      type: 'start_tool_call',
      operation,
      observation,
    });
    if (!startRes.success) {
      return {
        success: false,
        error: startRes.error.message,
        code: startRes.code,
      };
    }
    return { success: true, data: { observationId, operationId } };
  }

  observeToolAfter(
    rootSessionId: string,
    callId: string,
    toolName: string,
    output: unknown,
  ): OutcomeControllerResult<{ observationId: string; operationId: string }> {
    if (toolName === 'outcome_control') {
      return {
        success: true,
        data: { observationId: '', operationId: '' },
      };
    }

    const observationId = `obs_${callId}`;
    const operationId = `op_${callId}`;
    const outputDigest = canonicalDigest('omos/tool-output/v1', output);
    const now = this.#clock();

    const maxCasRetries = 5;
    for (let attempt = 0; attempt < maxCasRetries; attempt++) {
      const recRes = this.readRecord(rootSessionId);
      if (!recRes.success) {
        return {
          success: false,
          error: recRes.error.message,
          code: recRes.code,
        };
      }
      const record = recRes.data;
      if (record.phase === 'accepted') {
        return {
          success: true,
          data: { observationId: '', operationId: '' },
        };
      }

      const completeRes = this.#store.mutate(rootSessionId, record.revision, {
        type: 'complete_tool_call',
        operationId,
        observationId,
        outputDigest,
        completedEpoch: this.#serverEpoch,
        completedAt: now,
      });

      if (completeRes.success) {
        return { success: true, data: { observationId, operationId } };
      }

      if (completeRes.code !== 'conflict') {
        return {
          success: false,
          error: completeRes.error.message,
          code: completeRes.code,
        };
      }
    }

    return {
      success: false,
      error: 'CAS conflict retry limit exceeded while completing tool call',
      code: 'conflict',
    };
  }

  observeExternalUserTurn(
    rootSessionId: string,
    messageId: string,
    text: string,
  ): OutcomeControllerResult<OutcomeUserTurnResult> {
    if (!messageId || typeof messageId !== 'string' || !messageId.trim()) {
      return {
        success: false,
        error: 'External user message requires a non-empty messageId',
        code: 'invalid_parameter',
      };
    }
    const canonicalMessageId = messageId.trim();

    const contentDigest = canonicalDigest('omos/user-message/v1', text);
    const maxCasRetries = 5;

    for (let attempt = 0; attempt < maxCasRetries; attempt++) {
      const recRes = this.readRecord(rootSessionId);
      if (!recRes.success) {
        return {
          success: false,
          error: recRes.error.message,
          code: recRes.code,
        };
      }
      const record = recRes.data;

      if (record.phase === 'accepted') {
        const receiptId = `usr_${this.#randomId().replace(/-/g, '').slice(0, 16)}`;
        const now = this.#clock();
        const receipt: OutcomeUserMessageReceipt = {
          id: receiptId,
          messageId: canonicalMessageId,
          contentDigest,
          observedEpoch: this.#serverEpoch,
          observedAt: now,
          createdRevision: 1,
          provenance: 'external_user',
        };

        const intakeRes = this.#store.appendPendingIntakeUserMessage(
          rootSessionId,
          receipt,
        );
        if (intakeRes.success) {
          return {
            success: true,
            data: {
              receipt: intakeRes.data.receipt,
              receiptId: intakeRes.data.receipt.id,
              status: intakeRes.status,
              noop: intakeRes.status === 'noop',
              stagedInPendingIntake: intakeRes.data.stagedInPendingIntake,
            },
          };
        }
        if (intakeRes.code === 'conflict') {
          continue;
        }
        return {
          success: false,
          error: intakeRes.error.message,
          code: intakeRes.code,
        };
      }

      const receiptId = `usr_${this.#randomId().replace(/-/g, '').slice(0, 16)}`;
      const now = this.#clock();
      const receipt: OutcomeUserMessageReceipt = {
        id: receiptId,
        messageId: canonicalMessageId,
        contentDigest,
        observedEpoch: this.#serverEpoch,
        observedAt: now,
        createdRevision: record.revision + 1,
        provenance: 'external_user',
      };

      const mutateRes = this.#store.mutate(rootSessionId, record.revision, {
        type: 'append_user_message',
        receipt,
      });

      if (mutateRes.success) {
        if (mutateRes.status === 'noop') {
          const durable = this.#store.findUserMessageReceipt(
            rootSessionId,
            canonicalMessageId,
            contentDigest,
          );
          if (!durable.success) {
            if (durable.code === 'missing') continue;
            return {
              success: false,
              error: durable.error.message,
              code: durable.code,
            };
          }
          if (!durable.data.receipt) continue;
          return {
            success: true,
            data: {
              receipt: durable.data.receipt,
              receiptId: durable.data.receipt.id,
              status: 'noop',
              noop: true,
              stagedInPendingIntake:
                durable.data.stagedInPendingIntake || undefined,
            },
          };
        }
        return {
          success: true,
          data: {
            receipt,
            receiptId: receipt.id,
            status: 'written',
            noop: false,
          },
        };
      }

      if (mutateRes.code !== 'conflict') {
        return {
          success: false,
          error: mutateRes.error.message,
          code: mutateRes.code,
        };
      }
    }

    return {
      success: false,
      error: 'CAS conflict retry limit exceeded while appending user message',
      code: 'conflict',
    };
  }

  observeUserTurn(
    rootSessionId: string,
    messageId: string,
    text: string,
  ): OutcomeControllerResult<OutcomeUserTurnResult> {
    return this.observeExternalUserTurn(rootSessionId, messageId, text);
  }

  validateAndMarkDispatching(
    sessionID: string,
    callID: string,
    promptText: string,
  ):
    | { success: true; marker: OutcomeDispatchMarker }
    | { success: false; error: string } {
    if (!callID || typeof callID !== 'string' || callID.trim() === '') {
      return {
        success: false,
        error: 'Outcome Manager task dispatch requires a non-empty callID',
      };
    }

    const markers = extractOutcomeDispatchMarkers(promptText);
    if (markers.length === 0) {
      return {
        success: false,
        error:
          'Task prompt for outcome-manager must contain exactly one valid OMOS dispatch marker',
      };
    }
    if (markers.length > 1) {
      return {
        success: false,
        error: `Task prompt for outcome-manager contains ${markers.length} dispatch markers; exactly one is required`,
      };
    }

    const marker = markers[0];
    if (marker.rootSession !== sessionID) {
      return {
        success: false,
        error: `Dispatch marker root session '${marker.rootSession}' does not match caller session '${sessionID}'`,
      };
    }

    const recRes = this.readRecord(sessionID);
    if (!recRes.success) {
      return {
        success: false,
        error: `No managed outcome found for session '${sessionID}': ${recRes.error.message}`,
      };
    }
    const record = recRes.data;
    if (marker.outcomeId !== record.outcomeId) {
      return {
        success: false,
        error: `Dispatch marker outcomeId '${marker.outcomeId}' does not match active outcome '${record.outcomeId}'`,
      };
    }
    const claim = record.checkpoint;
    if (!claim) {
      return {
        success: false,
        error: 'No active checkpoint found to dispatch',
      };
    }

    if (
      claim.checkpointId !== marker.checkpointId ||
      claim.claimGeneration !== marker.claimGeneration ||
      claim.checkpointFingerprint !== marker.checkpointFingerprint
    ) {
      return {
        success: false,
        error: 'Dispatch marker does not match current active checkpoint claim',
      };
    }

    if (claim.state !== 'claimed') {
      return {
        success: false,
        error: `Checkpoint is in '${claim.state}' state and cannot be dispatched again`,
      };
    }

    const mutateRes = this.#store.mutate(sessionID, record.revision, {
      type: 'mark_dispatching',
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      claimToken: marker.claimToken,
      dispatchCallId: callID,
    });

    if (!mutateRes.success) {
      return {
        success: false,
        error: `Failed to mark checkpoint dispatching: ${mutateRes.error.message}`,
      };
    }

    return { success: true, marker };
  }

  hasDispatchCall(sessionID: string, callID: string): boolean {
    const record = this.readRecord(sessionID);
    return (
      record.success &&
      record.data.checkpoint?.state === 'dispatching' &&
      record.data.checkpoint.dispatchCallId === callID
    );
  }

  bindManagerTask(
    sessionID: string,
    callID: string,
    managerTaskId: string,
  ): OutcomeControllerResult<OutcomeRecord> {
    const recRes = this.readRecord(sessionID);
    if (!recRes.success) return { success: false, error: recRes.error.message };
    let record = recRes.data;
    const claim = record.checkpoint;
    if (claim?.state !== 'dispatching' || claim.dispatchCallId !== callID) {
      return {
        success: false,
        error: 'No matching durable dispatch claim for Manager binding',
      };
    }
    if (!this.#getManagerTaskRecord) {
      return this.#invalidateDispatch(
        sessionID,
        record,
        claim,
        'Manager task verifier is not configured',
      );
    }
    const taskRecord = this.#getManagerTaskRecord(managerTaskId);
    if (
      !taskRecord ||
      taskRecord.taskID !== managerTaskId ||
      taskRecord.parentSessionID !== sessionID ||
      this.#resolveAgentName(taskRecord.agent) !== 'outcome-manager'
    ) {
      return this.#invalidateDispatch(
        sessionID,
        record,
        claim,
        `Manager task '${managerTaskId}' is missing or has invalid parent/agent identity`,
      );
    }
    const claimToken =
      this.#claimSecrets.get(
        `${sessionID}:${claim.outcomeId}:${claim.checkpointId}`,
      ) ??
      this.#claimSecrets.get(
        `${sessionID}:${claim.outcomeId}:${claim.claimGeneration}`,
      ) ??
      '';

    if (claim.state === 'dispatching') {
      const bindRes = this.#store.mutate(sessionID, record.revision, {
        type: 'bind_manager',
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        claimToken,
        managerTaskId,
        managerGeneration: taskRecord.generation,
      });
      if (!bindRes.success) {
        return {
          success: false,
          error: `Failed to bind manager task: ${bindRes.error.message}`,
        };
      }
      record = bindRes.data;
    }

    return { success: true, data: record };
  }

  failManagerDispatch(
    sessionID: string,
    callID: string,
    reason: string,
  ): OutcomeControllerResult<OutcomeRecord> {
    const recRes = this.readRecord(sessionID);
    if (!recRes.success) {
      return { success: false, error: recRes.error.message, code: recRes.code };
    }
    const record = recRes.data;
    const claim = record.checkpoint;
    if (claim?.state !== 'dispatching' || claim.dispatchCallId !== callID) {
      return {
        success: false,
        error: 'No matching durable dispatch claim to invalidate',
        code: 'dispatch_claim_mismatch',
      };
    }
    return this.#invalidateDispatch(sessionID, record, claim, reason);
  }

  #invalidateDispatch(
    sessionID: string,
    record: OutcomeRecord,
    claim: OutcomeCheckpointClaim,
    reason: string,
  ): OutcomeControllerResult<OutcomeRecord> {
    const invalid = this.#store.mutate(sessionID, record.revision, {
      type: 'record_invalid_dispatch',
      checkpointId: claim.checkpointId,
      claimGeneration: claim.claimGeneration,
      reason,
    });
    return invalid.success
      ? { success: false, error: reason, code: 'manager_binding_invalid' }
      : {
          success: false,
          error: `${reason}; failed to persist invalid dispatch: ${invalid.error.message}`,
          code: invalid.code,
        };
  }
}

function isSettledCheckpoint(state: OutcomeCheckpointClaim['state']): boolean {
  return [
    'review_accepted',
    'review_rejected',
    'review_invalid',
    'retired',
  ].includes(state);
}
