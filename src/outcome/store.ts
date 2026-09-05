import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { ZodError } from 'zod';
import {
  canonicalDigest,
  computeActionArchiveChainDigest,
  computeOutcomeAuthorizationDigest,
  computeOutcomeCheckpointFingerprint,
  computeOutcomeContractDigest,
  computeOutcomeFinalCertificateDigest,
  computeOutcomeHandoffSupersessionDigest,
  computeOutcomeSuccessorLineageDigest,
  initialActionArchiveChainDigest,
  MAX_OUTCOME_INTAKE_BYTES,
  MAX_OUTCOME_MANIFEST_BYTES,
  MAX_OUTCOME_RECORD_BYTES,
  OUTCOME_INTAKE_SCHEMA,
  OUTCOME_INTAKE_VERSION,
  OUTCOME_MANIFEST_SCHEMA,
  OUTCOME_MANIFEST_VERSION,
  OUTCOME_RECORD_SCHEMA,
  OUTCOME_RECORD_VERSION,
  type OutcomeActionRequired,
  type OutcomeAuthorizationReceipt,
  type OutcomeCheckpointClaim,
  type OutcomeContract,
  OutcomeContractSchema,
  type OutcomeDecisionReceipt,
  type OutcomeEvidenceEntry,
  type OutcomeFinalCertificate,
  type OutcomeHandoffSupersessionReceipt,
  type OutcomeKickoffGate,
  type OutcomeManagerReviewSummary,
  type OutcomePendingIntake,
  type OutcomePendingOperation,
  type OutcomeRecord,
  OutcomeRecordSchema,
  OutcomeSessionIdSchema,
  type OutcomeSessionManifest,
  type OutcomeSuccessorLineage,
  type OutcomeToolObservation,
  type OutcomeUserMessageReceipt,
  parseOutcomeIntake,
  parseOutcomeManifest,
  parseOutcomeRecord,
  serializeOutcomeIntake,
  serializeOutcomeManifest,
  serializeOutcomeRecord,
  validateVerdictForCheckpointKind,
} from './controller-schema';
import { getProcessEpoch } from './process-epoch';
import {
  type OutcomeReview,
  OutcomeReviewSchema,
  type OutcomeVerdict,
} from './schema';

export type OutcomeStoreErrorCode =
  | 'missing'
  | 'already_exists'
  | 'conflict'
  | 'contention'
  | 'corrupt'
  | 'oversized'
  | 'invalid_session_id'
  | 'symlink_detected'
  | 'invalid_transition'
  | 'action_capacity_exhausted'
  | 'kickoff_retry_exhausted'
  | 'retrospective_kickoff_forbidden'
  | 'io_error'
  | 'durability_uncertain';

export class OutcomeStoreError extends Error {
  constructor(
    readonly code: OutcomeStoreErrorCode,
    message: string,
    readonly details: {
      rootSessionId?: string;
      expectedRevision?: number;
      actualRevision?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'OutcomeStoreError';
  }
}

export type OutcomeStoreResult<T> =
  | {
      success: true;
      data: T;
      revision: number;
      status: 'created' | 'read' | 'written' | 'recovered' | 'noop';
    }
  | { success: false; error: OutcomeStoreError; code: OutcomeStoreErrorCode };

export interface OutcomePendingIntakeAppendResult {
  intake?: OutcomePendingIntake;
  receipt: OutcomeUserMessageReceipt;
  stagedInPendingIntake: boolean;
}

export interface OutcomeUserMessageLookupResult {
  receipt?: OutcomeUserMessageReceipt;
  stagedInPendingIntake: boolean;
}

interface OutcomeStoreOptions {
  projectDirectory?: string;
  storeDirectory?: string;
  serverEpoch?: string;
  clock?: () => number;
  randomId?: () => string;
  lockTimeoutMs?: number;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
  /** Test seam; intentionally not re-exported from the package root. */
  filesystem?: Partial<
    Pick<typeof fs, 'fsyncSync' | 'renameSync' | 'writeSync'>
  >;
  /** Test seam for post-consumption persistence failures. */
  beforePersistReconciledReview?: () => void;
}

export type OutcomeRecordMutation =
  | {
      type: 'revise_contract';
      contract: OutcomeContract;
      sourceUserMessageReceiptId?: string;
    }
  | { type: 'append_evidence'; entry: OutcomeEvidenceEntry }
  | {
      type: 'start_tool_call';
      operation: OutcomePendingOperation;
      observation: OutcomeToolObservation;
    }
  | {
      type: 'complete_observation';
      observationId: string;
      outputDigest: string;
      completedEpoch: string;
      completedAt: number;
    }
  | {
      type: 'complete_tool_call';
      operationId: string;
      observationId: string;
      outputDigest: string;
      completedEpoch: string;
      completedAt: number;
    }
  | { type: 'append_user_message'; receipt: OutcomeUserMessageReceipt }
  | { type: 'append_decision'; receipt: OutcomeDecisionReceipt }
  | {
      type: 'resolve_decision';
      decisionId: string;
      chosenOption: string;
      sourceUserMessageReceiptId: string;
      decidedAt: number;
    }
  | { type: 'append_authorization'; receipt: OutcomeAuthorizationReceipt }
  | {
      type: 'open_checkpoint';
      kind: OutcomeCheckpointClaim['kind'];
      reason: string;
      claimToken: string;
      expiresAt: number;
      candidateFingerprint?: string;
      decisionIds?: string[];
      exceptionRuleIds?: string[];
      evidenceAttestationIds?: string[];
    }
  | {
      type: 'mark_dispatching';
      checkpointId: string;
      claimGeneration: number;
      claimToken: string;
      dispatchCallId: string;
    }
  | {
      type: 'bind_manager';
      checkpointId: string;
      claimGeneration: number;
      claimToken: string;
      managerTaskId: string;
      managerGeneration: number;
    }
  | {
      type: 'mark_result_available';
      checkpointId: string;
      claimGeneration: number;
      claimToken: string;
      resultDigest: string;
    }
  | {
      type: 'record_review';
      checkpointId: string;
      claimGeneration: number;
      claimToken: string;
      resultDigest: string;
      review: OutcomeReview;
    }
  | {
      type: 'record_consumed_review';
      checkpointId: string;
      claimGeneration: number;
      claimToken: string;
      resultDigest: string;
      review: OutcomeReview;
    }
  | {
      type: 'record_recovered_review';
      checkpointId: string;
      claimGeneration: number;
      resultDigest: string;
      review: OutcomeReview;
    }
  | {
      type: 'record_invalid_review';
      checkpointId: string;
      claimGeneration: number;
      claimToken?: string;
      resultDigest?: string;
      reason: string;
    }
  | {
      type: 'record_consumed_invalid_review';
      checkpointId: string;
      claimGeneration: number;
      claimToken?: string;
      resultDigest: string;
      reason: string;
    }
  | {
      type: 'record_invalid_dispatch';
      checkpointId: string;
      claimGeneration: number;
      reason: string;
    }
  | {
      type: 'expire_checkpoint';
      checkpointId: string;
      claimGeneration: number;
      claimToken: string;
      reason: string;
    }
  | { type: 'set_wait'; wait: OutcomeRecord['waitCondition'] }
  | { type: 'clear_wait'; referenceId: string }
  | { type: 'start_operation'; operation: OutcomePendingOperation }
  | {
      type: 'finish_operation';
      operationId: string;
      status: 'completed' | 'failed';
      error?: string;
    }
  | { type: 'acknowledge_operation'; operationId: string }
  | {
      type: 'reconcile_uncertain_checkpoint';
      checkpointId: string;
      claimGeneration: number;
      resolution:
        | { kind: 'retire'; reason: string }
        | {
            kind: 'result_available';
            dispatchCallId: string;
            managerTaskId: string;
            managerGeneration: number;
            resultDigest: string;
          };
    }
  | {
      type: 'retire_misbound_recovered_result';
      checkpointId: string;
      claimGeneration: number;
      dispatchCallId: string;
      managerTaskId: string;
      managerGeneration: number;
      boundResultDigest: string;
      observedResultDigest: string;
      reason: string;
    }
  | {
      type: 'complete_external_handoff';
      waitReferenceId: string;
      waitCreatedRevision: number;
      waitOriginatingServerEpoch: string;
      waitRestartObservedRevision: number;
      expectedPostRestartCheck?: string;
      sourceUserMessageReceiptId: string;
      evidenceAttestationId: string;
    }
  | {
      type: 'supersede_external_handoff';
      reason: string;
      waitReferenceId: string;
      waitCreatedRevision: number;
      waitOriginatingServerEpoch: string;
      waitRestartObservedRevision: number;
      waitInstructions: string;
      expectedPostRestartCheck: string;
      retiredCheckpointId: string;
      retiredClaimGeneration: number;
      retiredDispatchCallId: string;
      retiredManagerTaskId: string;
      retiredManagerGeneration: number;
      retiredBoundResultDigest: string;
      observedChildResultDigest: string;
      retiredReasonDigest: string;
      sourceUserMessageReceiptId: string;
      evidenceAttestationId: string;
      replacementCandidateFingerprint: string;
    }
  | { type: 'append_action'; action: OutcomeActionRequired }
  | {
      type: 'resolve_action';
      actionId: string;
      reason: string;
      sourceUserMessageReceiptId?: string;
      evidenceAttestationIds?: string[];
    }
  | {
      type: 'update_goal_status';
      goalId: string;
      newStatus: 'satisfied';
    }
  | { type: 'reconcile_idle_operations' }
  | { type: 'finalize'; summary: string };

export interface OutcomeReviewPersistence {
  outcome: 'valid' | 'invalid';
  checkpointId: string;
  claimGeneration: number;
  claimToken?: string;
  resultDigest: string;
  review?: OutcomeReview;
  reason?: string;
  recovered?: boolean;
}

export function formatMisboundRetirementNote(
  boundDigest: string,
  observedDigest: string,
  reason: string,
): string {
  const normalizedReason = reason.trim();
  const reasonDigest = canonicalDigest(
    'omos/misbound-retirement-reason/v1',
    normalizedReason,
  );
  const prefix = `Misbound result retired [bound=${boundDigest} observed=${observedDigest} reason=${reasonDigest}]: `;
  const remaining = Math.max(0, 512 - prefix.length);
  const trailingReason =
    normalizedReason.length > remaining
      ? normalizedReason.slice(0, remaining)
      : normalizedReason;
  return `${prefix}${trailingReason}`;
}

export function parseMisboundRetirementNote(note: string): {
  boundDigest: string;
  observedDigest: string;
  reasonDigest: string;
} | null {
  const match = note.match(
    /^Misbound result retired \[bound=(sha256:[a-f0-9]{64}) observed=(sha256:[a-f0-9]{64}) reason=(sha256:[a-f0-9]{64})\]:/,
  );
  if (!match) return null;
  return {
    boundDigest: match[1],
    observedDigest: match[2],
    reasonDigest: match[3],
  };
}

interface LockOwner {
  pid: number;
  epoch: string;
  token: string;
  createdAt: number;
}

interface LockCapability {
  path: string;
  owner: LockOwner;
}

export class OutcomeStore {
  readonly #projectDirectory?: string;
  readonly #storeDirectory: string;
  readonly #serverEpoch: string;
  readonly #clock: () => number;
  readonly #randomId: () => string;
  readonly #lockTimeoutMs: number;
  readonly #isPidAlive: (pid: number) => boolean;
  readonly #sleep: (ms: number) => void;
  readonly #fsync: typeof fs.fsyncSync;
  readonly #rename: typeof fs.renameSync;
  readonly #write: typeof fs.writeSync;
  readonly #beforePersistReconciledReview?: () => void;
  readonly #lockedSessions = new Set<string>();

  constructor(options: OutcomeStoreOptions = {}) {
    this.#projectDirectory = options.projectDirectory
      ? path.resolve(options.projectDirectory)
      : undefined;
    const base = this.#projectDirectory ?? process.cwd();
    this.#storeDirectory = path.resolve(
      options.storeDirectory ??
        process.env.OMOS_OUTCOME_STORE_DIR ??
        path.join(base, '.opencode', 'outcomes'),
    );
    this.#serverEpoch = options.serverEpoch ?? getProcessEpoch();
    this.#clock = options.clock ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 300;
    this.#isPidAlive = options.isPidAlive ?? isPidAlive;
    this.#sleep = options.sleep ?? sleepSync;
    this.#fsync = options.filesystem?.fsyncSync ?? fs.fsyncSync;
    this.#rename = options.filesystem?.renameSync ?? fs.renameSync;
    this.#write = options.filesystem?.writeSync ?? fs.writeSync;
    this.#beforePersistReconciledReview = options.beforePersistReconciledReview;
  }

  get serverEpoch(): string {
    return this.#serverEpoch;
  }

  get storageRoot(): string {
    return this.#storeDirectory;
  }

  recordPath(rootSessionId: string, generation = 1): string {
    const session = validateSession(rootSessionId);
    if (generation === 1) {
      return path.join(this.#storeDirectory, `${sessionHash(session)}.json`);
    }
    return path.join(
      this.#storeDirectory,
      `${sessionHash(session)}.g${String(generation).padStart(8, '0')}.json`,
    );
  }

  manifestPath(rootSessionId: string): string {
    const session = validateSession(rootSessionId);
    return path.join(
      this.#storeDirectory,
      `${sessionHash(session)}.manifest.json`,
    );
  }

  intakePath(rootSessionId: string, generation: number): string {
    const session = validateSession(rootSessionId);
    return path.join(
      this.#storeDirectory,
      `${sessionHash(session)}.g${String(generation).padStart(8, '0')}.intake.json`,
    );
  }

  #validateLineageAgreement(
    lineage: OutcomeSuccessorLineage,
    predRecord: OutcomeRecord,
  ): boolean {
    if (predRecord.phase !== 'accepted' || !predRecord.finalCertificate) {
      return false;
    }
    const certDigest = computeOutcomeFinalCertificateDigest(
      predRecord.finalCertificate,
    );
    return (
      lineage.predecessorOutcomeId === predRecord.outcomeId &&
      lineage.predecessorGeneration === (predRecord.generation ?? 1) &&
      lineage.predecessorAcceptedRevision === predRecord.revision &&
      lineage.predecessorCertificateDigest === certDigest &&
      lineage.lineageDigest === computeOutcomeSuccessorLineageDigest(lineage)
    );
  }

  #persistManifest(session: string, manifest: OutcomeSessionManifest): void {
    const serialized = serializeOutcomeManifest(manifest);
    this.#atomicReplace(this.manifestPath(session), serialized);
  }

  #readRecordDirect(session: string, generation: number): OutcomeRecord {
    try {
      const file = this.recordPath(session, generation);
      const raw = readRegularFile(file, MAX_OUTCOME_RECORD_BYTES);
      const record = parseOutcomeRecord(JSON.parse(raw));
      if (record.rootSessionId !== session) {
        throw new OutcomeStoreError(
          'corrupt',
          `Generation ${generation} record session identity mismatch`,
          { rootSessionId: session },
        );
      }
      if (record.generation !== generation) {
        throw new OutcomeStoreError(
          'corrupt',
          `Generation ${generation} record contains generation ${record.generation}`,
          { rootSessionId: session },
        );
      }
      return record;
    } catch (error) {
      throw this.#readError(error, session);
    }
  }

  #pendingSummary(
    intake: OutcomePendingIntake,
    predecessor: OutcomeRecord,
  ): NonNullable<OutcomeSessionManifest['pendingSuccessor']> {
    const certificateDigest = predecessor.finalCertificate
      ? computeOutcomeFinalCertificateDigest(predecessor.finalCertificate)
      : undefined;
    if (
      predecessor.phase !== 'accepted' ||
      certificateDigest === undefined ||
      intake.rootSessionId !== predecessor.rootSessionId ||
      intake.generation !== predecessor.generation + 1 ||
      intake.predecessorOutcomeId !== predecessor.outcomeId ||
      intake.predecessorGeneration !== predecessor.generation ||
      intake.predecessorAcceptedRevision !== predecessor.revision ||
      intake.predecessorCertificateDigest !== certificateDigest
    ) {
      throw new OutcomeStoreError(
        'corrupt',
        'Pending successor intake lineage mismatch',
        { rootSessionId: predecessor.rootSessionId },
      );
    }
    return {
      generation: intake.generation,
      predecessorOutcomeId: intake.predecessorOutcomeId,
      predecessorGeneration: intake.predecessorGeneration,
      predecessorAcceptedRevision: intake.predecessorAcceptedRevision,
      predecessorCertificateDigest: intake.predecessorCertificateDigest,
      boundaryMessageId: intake.boundaryMessageId,
      createdAt: intake.createdAt,
      updatedAt: intake.updatedAt,
      userMessageCount: intake.userMessages.length,
    };
  }

  #intakeReceiptsMatchPromotedRecord(
    intake: OutcomePendingIntake,
    record: OutcomeRecord,
  ): boolean {
    if (record.receipts.userMessages.length !== intake.userMessages.length) {
      return false;
    }
    const promoted = new Map(
      record.receipts.userMessages.map((receipt) => [
        receipt.messageId,
        receipt,
      ]),
    );
    return intake.userMessages.every((receipt) => {
      const candidate = promoted.get(receipt.messageId);
      return (
        candidate !== undefined &&
        candidate.id === receipt.id &&
        candidate.contentDigest === receipt.contentDigest &&
        candidate.observedEpoch === receipt.observedEpoch &&
        candidate.observedAt === receipt.observedAt &&
        candidate.provenance === receipt.provenance &&
        candidate.createdRevision === 1
      );
    });
  }

  #pendingSummariesMatch(
    left: OutcomeSessionManifest['pendingSuccessor'],
    right: NonNullable<OutcomeSessionManifest['pendingSuccessor']>,
  ): boolean {
    return (
      left !== undefined &&
      left.generation === right.generation &&
      left.predecessorOutcomeId === right.predecessorOutcomeId &&
      left.predecessorGeneration === right.predecessorGeneration &&
      left.predecessorAcceptedRevision === right.predecessorAcceptedRevision &&
      left.predecessorCertificateDigest ===
        right.predecessorCertificateDigest &&
      left.boundaryMessageId === right.boundaryMessageId &&
      left.createdAt === right.createdAt &&
      left.updatedAt === right.updatedAt &&
      left.userMessageCount === right.userMessageCount
    );
  }

  #readSessionManifestOnly(session: string): {
    initialized: boolean;
    manifest: OutcomeSessionManifest;
  } {
    this.#assertSafePath();
    if (!fs.existsSync(this.#storeDirectory)) {
      return {
        initialized: false,
        manifest: undefined as never,
      };
    }
    const manifestFile = this.manifestPath(session);
    const hash = sessionHash(session);

    if (fs.existsSync(manifestFile)) {
      rejectSymlink(manifestFile);
      const manifestRaw = readRegularFile(
        manifestFile,
        MAX_OUTCOME_MANIFEST_BYTES,
      );
      let manifest: OutcomeSessionManifest;
      try {
        manifest = parseOutcomeManifest(JSON.parse(manifestRaw));
      } catch (err) {
        throw new OutcomeStoreError(
          'corrupt',
          'Outcome session manifest is corrupt',
          { rootSessionId: session, cause: err },
        );
      }
      if (manifest.rootSessionId !== session) {
        throw new OutcomeStoreError(
          'corrupt',
          'Session manifest identity mismatch',
          { rootSessionId: session },
        );
      }
      return { initialized: true, manifest };
    }

    const gen1File = this.recordPath(session, 1);
    if (!fs.existsSync(gen1File)) {
      return {
        initialized: false,
        manifest: undefined as never,
      };
    }

    rejectSymlink(gen1File);
    let gen1: OutcomeRecord;
    try {
      const raw = readRegularFile(gen1File, MAX_OUTCOME_RECORD_BYTES);
      gen1 = parseOutcomeRecord(JSON.parse(raw));
    } catch (err) {
      throw new OutcomeStoreError('corrupt', 'Outcome record is corrupt', {
        rootSessionId: session,
        cause: err,
      });
    }

    if (gen1.rootSessionId !== session) {
      throw new OutcomeStoreError(
        'corrupt',
        'Outcome record session mismatch',
        { rootSessionId: session },
      );
    }

    const entries = fs.readdirSync(this.#storeDirectory);
    const prefix = `${hash}.g`;
    const hasOtherGenFiles = entries.some((e) => e.startsWith(prefix));
    if (hasOtherGenFiles) {
      throw new OutcomeStoreError(
        'conflict',
        'Ambiguous generation files found without a manifest',
        { rootSessionId: session },
      );
    }

    const manifest: OutcomeSessionManifest = {
      schema: OUTCOME_MANIFEST_SCHEMA,
      schemaVersion: OUTCOME_MANIFEST_VERSION,
      rootSessionId: session,
      currentGeneration: 1,
      updatedAt: gen1.updatedAt,
    };
    return { initialized: true, manifest };
  }

  #authoritativeSessionStateUnderLock(session: string): {
    initialized: boolean;
    manifest: OutcomeSessionManifest;
  } {
    this.#ensureStoreDirectory();
    const manifestFile = this.manifestPath(session);
    const hash = sessionHash(session);

    if (fs.existsSync(manifestFile)) {
      rejectSymlink(manifestFile);
      const manifestRaw = readRegularFile(
        manifestFile,
        MAX_OUTCOME_MANIFEST_BYTES,
      );
      let manifest: OutcomeSessionManifest;
      try {
        manifest = parseOutcomeManifest(JSON.parse(manifestRaw));
      } catch (err) {
        throw new OutcomeStoreError(
          'corrupt',
          'Outcome session manifest is corrupt',
          { rootSessionId: session, cause: err },
        );
      }
      if (manifest.rootSessionId !== session) {
        throw new OutcomeStoreError(
          'corrupt',
          'Session manifest identity mismatch',
          { rootSessionId: session },
        );
      }

      this.#reconcileUnderLock(session, manifest);

      return { initialized: true, manifest };
    }

    const gen1File = this.recordPath(session, 1);
    if (!fs.existsSync(gen1File)) {
      return {
        initialized: false,
        manifest: undefined as never,
      };
    }

    rejectSymlink(gen1File);
    let gen1: OutcomeRecord;
    try {
      const raw = readRegularFile(gen1File, MAX_OUTCOME_RECORD_BYTES);
      gen1 = parseOutcomeRecord(JSON.parse(raw));
    } catch (err) {
      throw new OutcomeStoreError('corrupt', 'Outcome record is corrupt', {
        rootSessionId: session,
        cause: err,
      });
    }

    if (gen1.rootSessionId !== session) {
      throw new OutcomeStoreError(
        'corrupt',
        'Outcome record session mismatch',
        { rootSessionId: session },
      );
    }

    const entries = fs.readdirSync(this.#storeDirectory);
    const prefix = `${hash}.g`;
    const hasOtherGenFiles = entries.some((e) => e.startsWith(prefix));
    if (hasOtherGenFiles) {
      throw new OutcomeStoreError(
        'conflict',
        'Ambiguous generation files found without a manifest',
        { rootSessionId: session },
      );
    }

    const manifest: OutcomeSessionManifest = {
      schema: OUTCOME_MANIFEST_SCHEMA,
      schemaVersion: OUTCOME_MANIFEST_VERSION,
      rootSessionId: session,
      currentGeneration: 1,
      updatedAt: this.#clock(),
    };
    this.#persistManifest(session, manifest);

    return { initialized: true, manifest };
  }

  #reconcileUnderLock(session: string, manifest: OutcomeSessionManifest): void {
    const hash = sessionHash(session);
    const N = manifest.currentGeneration;
    const entries = fs.readdirSync(this.#storeDirectory);

    const recordRegex = new RegExp(`^${hash}\\.g(\\d{8})\\.json$`);
    const intakeRegex = new RegExp(`^${hash}\\.g(\\d{8})\\.intake\\.json$`);

    const successorRecords: number[] = [];
    const intakeGens: number[] = [];

    for (const entry of entries) {
      const recMatch = entry.match(recordRegex);
      if (recMatch) {
        successorRecords.push(Number.parseInt(recMatch[1], 10));
        continue;
      }
      const intakeMatch = entry.match(intakeRegex);
      if (intakeMatch) {
        intakeGens.push(Number.parseInt(intakeMatch[1], 10));
      }
    }

    for (let k = 1; k <= N; k++) {
      const file = this.recordPath(session, k);
      if (!fs.existsSync(file)) {
        throw new OutcomeStoreError(
          'corrupt',
          `Generation ${k} record is missing from store`,
          { rootSessionId: session },
        );
      }
    }

    const orphanRecordGens = successorRecords
      .filter((g) => g > N)
      .sort((a, b) => a - b);
    if (orphanRecordGens.length > 1) {
      throw new OutcomeStoreError(
        'conflict',
        'Multiple orphan successor records detected',
        { rootSessionId: session },
      );
    }

    if (orphanRecordGens.length === 1) {
      const orphanGen = orphanRecordGens[0];
      if (orphanGen !== N + 1) {
        throw new OutcomeStoreError(
          'conflict',
          `Orphan successor record generation ${orphanGen} does not match expected generation ${N + 1}`,
          { rootSessionId: session },
        );
      }
      const pred = this.#readRecordDirect(session, N);
      if (pred.phase !== 'accepted' || !pred.finalCertificate) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor record found but predecessor is not accepted',
          { rootSessionId: session },
        );
      }

      let orphan: OutcomeRecord;
      try {
        orphan = this.#readRecordDirect(session, orphanGen);
      } catch (err) {
        throw new OutcomeStoreError(
          'corrupt',
          'Orphan successor record is corrupt',
          { rootSessionId: session, cause: err },
        );
      }

      if (orphan.rootSessionId !== session) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor record root session mismatch',
          { rootSessionId: session },
        );
      }
      if (orphan.generation !== orphanGen) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor record generation field mismatch',
          { rootSessionId: session },
        );
      }

      for (let k = 1; k <= N; k++) {
        const ancestor = this.#readRecordDirect(session, k);
        if (orphan.outcomeId === ancestor.outcomeId) {
          throw new OutcomeStoreError(
            'conflict',
            `Orphan successor outcomeId '${orphan.outcomeId}' collides with ancestor generation ${k}`,
            { rootSessionId: session },
          );
        }
      }

      if (
        !orphan.lineage ||
        !this.#validateLineageAgreement(orphan.lineage, pred)
      ) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor record lineage mismatch',
          { rootSessionId: session },
        );
      }

      if (
        manifest.pendingSuccessor &&
        manifest.pendingSuccessor.boundaryMessageId !==
          orphan.lineage.boundaryMessageId
      ) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor boundary message ID mismatch with manifest pending successor',
          { rootSessionId: session },
        );
      }

      const orphanIntakeFile = this.intakePath(session, orphanGen);
      if (!manifest.pendingSuccessor || !fs.existsSync(orphanIntakeFile)) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor record lacks its authoritative pending intake',
          { rootSessionId: session },
        );
      }
      let orphanIntake: OutcomePendingIntake;
      try {
        const intakeRaw = readRegularFile(
          orphanIntakeFile,
          MAX_OUTCOME_INTAKE_BYTES,
        );
        orphanIntake = parseOutcomeIntake(JSON.parse(intakeRaw));
      } catch (err) {
        if (err instanceof OutcomeStoreError) throw err;
        throw new OutcomeStoreError(
          'corrupt',
          'Intake file for orphan successor is corrupt',
          { rootSessionId: session, cause: err },
        );
      }
      const expectedPending = this.#pendingSummary(orphanIntake, pred);
      if (
        !this.#pendingSummariesMatch(
          manifest.pendingSuccessor,
          expectedPending,
        ) ||
        orphanIntake.boundaryMessageId !== orphan.lineage.boundaryMessageId ||
        !this.#intakeReceiptsMatchPromotedRecord(orphanIntake, orphan)
      ) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor does not exactly match its pending intake',
          { rootSessionId: session },
        );
      }

      const boundaryReceipt = orphan.receipts.userMessages.find(
        (m) => m.messageId === orphan.lineage?.boundaryMessageId,
      );
      if (boundaryReceipt?.provenance !== 'external_user') {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor boundary message receipt is missing or not external_user',
          { rootSessionId: session },
        );
      }

      if (
        !orphan.contract.sourceMessageIds.includes(
          orphan.lineage.boundaryMessageId,
        )
      ) {
        throw new OutcomeStoreError(
          'conflict',
          'Orphan successor contract does not include boundary message ID',
          { rootSessionId: session },
        );
      }
      for (const srcId of orphan.contract.sourceMessageIds) {
        const srcReceipt = orphan.receipts.userMessages.find(
          (m) => m.messageId === srcId,
        );
        if (srcReceipt?.provenance !== 'external_user') {
          throw new OutcomeStoreError(
            'conflict',
            `Orphan successor contract sourceMessageId '${srcId}' is not retained external_user`,
            { rootSessionId: session },
          );
        }
      }

      manifest.currentGeneration = orphanGen;
      manifest.pendingSuccessor = undefined;
      manifest.updatedAt = this.#clock();
      this.#persistManifest(session, manifest);

      try {
        if (fs.existsSync(orphanIntakeFile)) {
          fs.unlinkSync(orphanIntakeFile);
        }
      } catch {}
      return;
    }

    const extraIntakeGens = intakeGens
      .filter((g) => g > N)
      .sort((a, b) => a - b);
    if (extraIntakeGens.length > 1) {
      throw new OutcomeStoreError(
        'conflict',
        'Multiple orphan intake files detected',
        { rootSessionId: session },
      );
    }

    if (extraIntakeGens.length === 1) {
      const intakeGen = extraIntakeGens[0];
      if (intakeGen !== N + 1) {
        throw new OutcomeStoreError(
          'conflict',
          `Intake generation ${intakeGen} does not match expected ${N + 1}`,
          { rootSessionId: session },
        );
      }
      const intakeFile = this.intakePath(session, intakeGen);
      const intakeRaw = readRegularFile(intakeFile, MAX_OUTCOME_INTAKE_BYTES);
      let intake: OutcomePendingIntake;
      try {
        intake = parseOutcomeIntake(JSON.parse(intakeRaw));
      } catch (err) {
        throw new OutcomeStoreError(
          'corrupt',
          'Pending successor intake is corrupt',
          { rootSessionId: session, cause: err },
        );
      }
      const pred = this.#readRecordDirect(session, N);
      if (pred.phase !== 'accepted' || !pred.finalCertificate) {
        throw new OutcomeStoreError(
          'conflict',
          'Pending successor intake exists but predecessor is not accepted',
          { rootSessionId: session },
        );
      }
      const expectedPending = this.#pendingSummary(intake, pred);

      const manifestPending = manifest.pendingSuccessor;
      const needsUpdate = !this.#pendingSummariesMatch(
        manifestPending,
        expectedPending,
      );

      if (needsUpdate) {
        manifest.pendingSuccessor = expectedPending;
        manifest.updatedAt = this.#clock();
        this.#persistManifest(session, manifest);
      }
    } else if (manifest.pendingSuccessor) {
      throw new OutcomeStoreError(
        'corrupt',
        'Pending successor intake file missing',
        { rootSessionId: session },
      );
    }
  }

  init(
    rootSessionId: string,
    input: { outcomeId?: string; contract: OutcomeContract },
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    const contractResult = OutcomeContractSchema.safeParse(input?.contract);
    if (!contractResult.success) {
      return failure(
        new OutcomeStoreError(
          'corrupt',
          'A complete valid outcome contract is required',
          {
            rootSessionId: session,
            cause: contractResult.error,
          },
        ),
      );
    }
    return this.#withLock(session, () => {
      const state = this.#authoritativeSessionStateUnderLock(session);
      if (state.initialized) {
        return failure(
          new OutcomeStoreError(
            'already_exists',
            'Outcome record already exists',
            { rootSessionId: session },
          ),
        );
      }
      const now = this.#clock();
      const contract = contractResult.data;
      const contractDigest = computeOutcomeContractDigest(contract);
      const record: OutcomeRecord = {
        schema: OUTCOME_RECORD_SCHEMA,
        schemaVersion: OUTCOME_RECORD_VERSION,
        generation: 1,
        outcomeId:
          input.outcomeId ??
          `out_${sessionHash(session).slice(0, 16)}_${this.#randomId().slice(0, 8)}`,
        rootSessionId: session,
        serverEpoch: this.#serverEpoch,
        revision: 1,
        nextClaimGeneration: 1,
        contractDigest,
        createdAt: now,
        updatedAt: now,
        phase: 'active',
        contract,
        kickoffGate: {
          policyVersion: 1,
          state: 'required',
          contractDigest,
          attempts: 0,
          maxAttempts: 2,
        },
        resolvedActionArchive: {
          count: 0,
          chainDigest: initialActionArchiveChainDigest(),
        },
        receipts: {
          evidence: [],
          userMessages: [],
          decisions: [],
          authorizations: [],
          handoffSupersessions: [],
        },
        reviewSummaries: [],
        operations: [],
        actionsRequired: [],
      };

      const persistRes = this.#persist(session, record, 'created', 1);
      if (!persistRes.success) return persistRes;

      const manifest: OutcomeSessionManifest = {
        schema: OUTCOME_MANIFEST_SCHEMA,
        schemaVersion: OUTCOME_MANIFEST_VERSION,
        rootSessionId: session,
        currentGeneration: 1,
        updatedAt: now,
      };
      this.#persistManifest(session, manifest);

      return persistRes;
    });
  }

  read(rootSessionId: string): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    try {
      this.#assertSafePath();
      const state = this.#readSessionManifestOnly(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const parsed = this.#readRecordDirect(
        session,
        state.manifest.currentGeneration,
      );
      return {
        success: true,
        data: parsed,
        revision: parsed.revision,
        status: 'read',
      };
    } catch (error) {
      return failure(this.#readError(error, session));
    }
  }

  readGeneration(
    rootSessionId: string,
    generation: number,
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    try {
      this.#assertSafePath();
      const state = this.#readSessionManifestOnly(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      if (
        !Number.isInteger(generation) ||
        generation < 1 ||
        generation > state.manifest.currentGeneration
      ) {
        return failure(
          new OutcomeStoreError(
            'missing',
            `Generation ${generation} not found (current: ${state.manifest.currentGeneration})`,
            { rootSessionId: session },
          ),
        );
      }
      const parsed = this.#readRecordDirect(session, generation);
      return {
        success: true,
        data: parsed,
        revision: parsed.revision,
        status: 'read',
      };
    } catch (error) {
      return failure(this.#readError(error, session));
    }
  }

  readManifest(
    rootSessionId: string,
  ): OutcomeStoreResult<OutcomeSessionManifest> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    try {
      this.#assertSafePath();
      const state = this.#readSessionManifestOnly(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError(
            'missing',
            'Outcome session manifest not found',
            { rootSessionId: session },
          ),
        );
      }
      return {
        success: true,
        data: state.manifest,
        revision: state.manifest.currentGeneration,
        status: 'read',
      };
    } catch (error) {
      return failure(this.#readError(error, session));
    }
  }

  readPendingIntake(
    rootSessionId: string,
  ): OutcomeStoreResult<OutcomePendingIntake> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    try {
      this.#assertSafePath();
      const state = this.#readSessionManifestOnly(session);
      if (!state.initialized || !state.manifest.pendingSuccessor) {
        return failure(
          new OutcomeStoreError(
            'missing',
            'Pending successor intake not found',
            { rootSessionId: session },
          ),
        );
      }
      const file = this.intakePath(
        session,
        state.manifest.pendingSuccessor.generation,
      );
      const raw = readRegularFile(file, MAX_OUTCOME_INTAKE_BYTES);
      const parsed = parseOutcomeIntake(JSON.parse(raw));
      if (parsed.rootSessionId !== session)
        throw new Error('Session identity mismatch');
      return {
        success: true,
        data: parsed,
        revision: parsed.userMessages.length,
        status: 'read',
      };
    } catch (error) {
      return failure(this.#readError(error, session));
    }
  }

  findUserMessageReceipt(
    rootSessionId: string,
    messageId: string,
    contentDigest: string,
  ): OutcomeStoreResult<OutcomeUserMessageLookupResult> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    try {
      const state = this.#readSessionManifestOnly(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const canonicalMessageId = messageId.trim();
      for (
        let generation = 1;
        generation <= state.manifest.currentGeneration;
        generation++
      ) {
        const record = this.#readRecordDirect(session, generation);
        const existing = record.receipts.userMessages.find(
          (entry) => entry.messageId === canonicalMessageId,
        );
        if (existing) {
          if (existing.contentDigest !== contentDigest) {
            return failure(
              new OutcomeStoreError(
                'invalid_transition',
                `User message '${canonicalMessageId}' was already recorded with different content (generation ${generation})`,
                { rootSessionId: session },
              ),
            );
          }
          return {
            success: true,
            data: { receipt: existing, stagedInPendingIntake: false },
            revision: record.revision,
            status: 'noop',
          };
        }
      }
      if (state.manifest.pendingSuccessor) {
        const intakeFile = this.intakePath(
          session,
          state.manifest.pendingSuccessor.generation,
        );
        const intake = parseOutcomeIntake(
          JSON.parse(readRegularFile(intakeFile, MAX_OUTCOME_INTAKE_BYTES)),
        );
        const existing = intake.userMessages.find(
          (entry) => entry.messageId === canonicalMessageId,
        );
        if (existing) {
          if (existing.contentDigest !== contentDigest) {
            return failure(
              new OutcomeStoreError(
                'invalid_transition',
                `User message '${canonicalMessageId}' was already recorded in pending intake with different content`,
                { rootSessionId: session },
              ),
            );
          }
          return {
            success: true,
            data: { receipt: existing, stagedInPendingIntake: true },
            revision: intake.userMessages.length,
            status: 'noop',
          };
        }
      }
      return {
        success: true,
        data: { stagedInPendingIntake: false },
        revision: 0,
        status: 'read',
      };
    } catch (error) {
      return failure(this.#readError(error, session));
    }
  }

  appendPendingIntakeUserMessage(
    rootSessionId: string,
    receipt: OutcomeUserMessageReceipt,
  ): OutcomeStoreResult<OutcomePendingIntakeAppendResult> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    return this.#withLock(session, () => {
      const state = this.#authoritativeSessionStateUnderLock(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const currentGen = state.manifest.currentGeneration;
      const current = this.#readRecordDirect(session, currentGen);

      if (current.phase !== 'accepted' || !current.finalCertificate) {
        return failure(
          new OutcomeStoreError(
            'conflict',
            'Active outcome changed while staging successor intake',
            { rootSessionId: session },
          ),
        );
      }

      if (receipt.provenance !== 'external_user') {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            'Only external_user messages can enter pending intake',
            { rootSessionId: session },
          ),
        );
      }

      const canonicalMessageId = receipt.messageId.trim();

      // Point 1: Check ALL historical generations 1..currentGen
      for (let k = 1; k <= currentGen; k++) {
        const hist = this.#readRecordDirect(session, k);
        const existingHist = hist.receipts.userMessages.find(
          (m) => m.messageId === canonicalMessageId,
        );
        if (existingHist) {
          if (existingHist.contentDigest === receipt.contentDigest) {
            // True no-op! Cannot become successor boundary.
            if (state.manifest.pendingSuccessor) {
              const intakeRes = this.readPendingIntake(session);
              if (intakeRes.success) {
                return {
                  success: true,
                  data: {
                    intake: intakeRes.data,
                    receipt: existingHist,
                    stagedInPendingIntake: false,
                  },
                  revision: intakeRes.data.userMessages.length,
                  status: 'noop',
                };
              }
            }
            return {
              success: true,
              data: {
                receipt: existingHist,
                stagedInPendingIntake: false,
              },
              revision: 0,
              status: 'noop',
            };
          }
          return failure(
            new OutcomeStoreError(
              'invalid_transition',
              `User message '${canonicalMessageId}' was already recorded with different content (generation ${k})`,
              { rootSessionId: session },
            ),
          );
        }
      }

      const certDigest = computeOutcomeFinalCertificateDigest(
        current.finalCertificate,
      );
      const now = this.#clock();
      const nextGen = currentGen + 1;

      let intake: OutcomePendingIntake;
      let status: 'created' | 'written' | 'noop';

      if (!state.manifest.pendingSuccessor) {
        intake = {
          schema: OUTCOME_INTAKE_SCHEMA,
          schemaVersion: OUTCOME_INTAKE_VERSION,
          rootSessionId: session,
          generation: nextGen,
          predecessorOutcomeId: current.outcomeId,
          predecessorGeneration: currentGen,
          predecessorAcceptedRevision: current.revision,
          predecessorCertificateDigest: certDigest,
          boundaryMessageId: receipt.messageId,
          createdAt: now,
          updatedAt: now,
          userMessages: [receipt],
        };
        status = 'created';
      } else {
        const intakeFile = this.intakePath(session, nextGen);
        const intakeRaw = readRegularFile(intakeFile, MAX_OUTCOME_INTAKE_BYTES);
        intake = parseOutcomeIntake(JSON.parse(intakeRaw));

        if (
          intake.generation !== nextGen ||
          intake.predecessorOutcomeId !== current.outcomeId ||
          intake.predecessorGeneration !== currentGen ||
          intake.predecessorAcceptedRevision !== current.revision ||
          intake.predecessorCertificateDigest !== certDigest
        ) {
          return failure(
            new OutcomeStoreError(
              'corrupt',
              'Pending intake lineage mismatch with predecessor',
              { rootSessionId: session },
            ),
          );
        }

        const existingMessage = intake.userMessages.find(
          (m) => m.messageId === canonicalMessageId,
        );
        if (existingMessage) {
          if (existingMessage.contentDigest === receipt.contentDigest) {
            return {
              success: true,
              data: {
                intake,
                receipt: existingMessage,
                stagedInPendingIntake: true,
              },
              revision: intake.userMessages.length,
              status: 'noop',
            };
          }
          return failure(
            new OutcomeStoreError(
              'invalid_transition',
              `User message '${canonicalMessageId}' was already recorded in intake with different content`,
              { rootSessionId: session },
            ),
          );
        }

        if (intake.userMessages.length >= 32) {
          return failure(
            new OutcomeStoreError(
              'action_capacity_exhausted',
              'Intake user message capacity exhausted',
              { rootSessionId: session },
            ),
          );
        }

        intake.userMessages.push(receipt);
        intake.updatedAt = now;
        status = 'written';
      }

      const intakeSerialized = serializeOutcomeIntake(intake);
      this.#atomicReplace(this.intakePath(session, nextGen), intakeSerialized);

      const manifest = state.manifest;
      manifest.pendingSuccessor = {
        generation: nextGen,
        predecessorOutcomeId: current.outcomeId,
        predecessorGeneration: currentGen,
        predecessorAcceptedRevision: current.revision,
        predecessorCertificateDigest: certDigest,
        boundaryMessageId: intake.boundaryMessageId,
        createdAt: intake.createdAt,
        updatedAt: intake.updatedAt,
        userMessageCount: intake.userMessages.length,
      };
      manifest.updatedAt = now;
      this.#persistManifest(session, manifest);

      return {
        success: true,
        data: {
          intake,
          receipt,
          stagedInPendingIntake: true,
        },
        revision: intake.userMessages.length,
        status,
      };
    });
  }

  promotePendingIntake(
    rootSessionId: string,
    input: { outcomeId?: string; contract: OutcomeContract },
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    const contractResult = OutcomeContractSchema.safeParse(input?.contract);
    if (!contractResult.success) {
      return failure(
        new OutcomeStoreError(
          'corrupt',
          'A complete valid outcome contract is required',
          { rootSessionId: session, cause: contractResult.error },
        ),
      );
    }
    const contract = contractResult.data;
    return this.#withLock(session, () => {
      const state = this.#authoritativeSessionStateUnderLock(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const currentGen = state.manifest.currentGeneration;
      const current = this.#readRecordDirect(session, currentGen);

      if (current.phase !== 'accepted' || !current.finalCertificate) {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            'Cannot promote successor from non-accepted outcome',
            { rootSessionId: session },
          ),
        );
      }

      if (!state.manifest.pendingSuccessor) {
        return failure(
          new OutcomeStoreError(
            'missing',
            'No pending successor intake exists to promote',
            { rootSessionId: session },
          ),
        );
      }

      // Point 8: Reject caller-supplied successor outcomeId colliding with predecessor or ANY historical outcome
      if (input.outcomeId) {
        for (let k = 1; k <= currentGen; k++) {
          const hist = this.#readRecordDirect(session, k);
          if (hist.outcomeId === input.outcomeId) {
            return failure(
              new OutcomeStoreError(
                'invalid_transition',
                `Successor outcome ID '${input.outcomeId}' collides with historical generation ${k}`,
                { rootSessionId: session },
              ),
            );
          }
        }
      }

      const intakeFile = this.intakePath(
        session,
        state.manifest.pendingSuccessor.generation,
      );
      const intakeRaw = readRegularFile(intakeFile, MAX_OUTCOME_INTAKE_BYTES);
      const intake = parseOutcomeIntake(JSON.parse(intakeRaw));

      const certDigest = computeOutcomeFinalCertificateDigest(
        current.finalCertificate,
      );

      if (
        intake.generation !== currentGen + 1 ||
        intake.predecessorOutcomeId !== current.outcomeId ||
        intake.predecessorGeneration !== currentGen ||
        intake.predecessorAcceptedRevision !== current.revision ||
        intake.predecessorCertificateDigest !== certDigest
      ) {
        return failure(
          new OutcomeStoreError(
            'corrupt',
            'Pending intake lineage does not match accepted predecessor',
            { rootSessionId: session },
          ),
        );
      }

      const intakeReceiptsByMsgId = new Map(
        intake.userMessages.map((msg) => [msg.messageId, msg]),
      );

      const boundaryReceipt = intakeReceiptsByMsgId.get(
        intake.boundaryMessageId,
      );
      if (boundaryReceipt?.provenance !== 'external_user') {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            'Intake boundary message ID does not resolve to an external_user receipt',
            { rootSessionId: session },
          ),
        );
      }

      for (const srcId of contract.sourceMessageIds) {
        const receipt = intakeReceiptsByMsgId.get(srcId);
        if (receipt?.provenance !== 'external_user') {
          return failure(
            new OutcomeStoreError(
              'invalid_transition',
              `Contract sourceMessageId '${srcId}' does not resolve to a retained external_user receipt in pending intake`,
              { rootSessionId: session },
            ),
          );
        }
      }

      if (!contract.sourceMessageIds.includes(intake.boundaryMessageId)) {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            `Contract sourceMessageIds must include the boundary external message ID '${intake.boundaryMessageId}'`,
            { rootSessionId: session },
          ),
        );
      }

      const now = this.#clock();
      const nextGen = currentGen + 1;
      const contractDigest = computeOutcomeContractDigest(contract);
      const lineageDigest = computeOutcomeSuccessorLineageDigest({
        predecessorOutcomeId: current.outcomeId,
        predecessorGeneration: currentGen,
        predecessorAcceptedRevision: current.revision,
        predecessorCertificateDigest: certDigest,
        boundaryMessageId: intake.boundaryMessageId,
      });

      const successorRecord: OutcomeRecord = {
        schema: OUTCOME_RECORD_SCHEMA,
        schemaVersion: OUTCOME_RECORD_VERSION,
        generation: nextGen,
        lineage: {
          predecessorOutcomeId: current.outcomeId,
          predecessorGeneration: currentGen,
          predecessorAcceptedRevision: current.revision,
          predecessorCertificateDigest: certDigest,
          boundaryMessageId: intake.boundaryMessageId,
          lineageDigest,
        },
        outcomeId:
          input.outcomeId ??
          `out_${sessionHash(session).slice(0, 16)}_${this.#randomId().slice(0, 8)}`,
        rootSessionId: session,
        serverEpoch: this.#serverEpoch,
        revision: 1,
        nextClaimGeneration: 1,
        contractDigest,
        createdAt: now,
        updatedAt: now,
        phase: 'active',
        contract,
        kickoffGate: {
          policyVersion: 1,
          state: 'required',
          contractDigest,
          attempts: 0,
          maxAttempts: 2,
        },
        resolvedActionArchive: {
          count: 0,
          chainDigest: initialActionArchiveChainDigest(),
        },
        receipts: {
          evidence: [],
          userMessages: intake.userMessages.map((msg) => ({
            ...msg,
            createdRevision: 1,
          })),
          decisions: [],
          authorizations: [],
          handoffSupersessions: [],
        },
        reviewSummaries: [],
        operations: [],
        actionsRequired: [],
      };

      const recordPersistRes = this.#persist(
        session,
        successorRecord,
        'created',
        nextGen,
      );
      if (!recordPersistRes.success) return recordPersistRes;

      const manifest: OutcomeSessionManifest = {
        schema: OUTCOME_MANIFEST_SCHEMA,
        schemaVersion: OUTCOME_MANIFEST_VERSION,
        rootSessionId: session,
        currentGeneration: nextGen,
        pendingSuccessor: undefined,
        updatedAt: now,
      };
      this.#persistManifest(session, manifest);

      try {
        if (fs.existsSync(intakeFile)) {
          fs.unlinkSync(intakeFile);
        }
      } catch {}

      return recordPersistRes;
    });
  }

  mutate(
    rootSessionId: string,
    expectedRevision: number,
    mutation: OutcomeRecordMutation,
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    return this.#withLock(session, () => {
      const state = this.#authoritativeSessionStateUnderLock(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const currentGen = state.manifest.currentGeneration;
      const current = this.#readRecordDirect(session, currentGen);
      if (current.serverEpoch !== this.#serverEpoch) {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            'Recover prior-epoch outcome before mutation',
            { rootSessionId: session },
          ),
        );
      }

      if (mutation.type === 'complete_tool_call') {
        const op = current.operations.find(
          (entry) => entry.id === mutation.operationId,
        );
        const obs = current.receipts.evidence.find(
          (entry) => entry.id === mutation.observationId,
        );
        if (op && obs && obs.kind === 'controller_observed') {
          if (op.status === 'completed') {
            if (
              obs.completionObserved &&
              obs.outputDigest === mutation.outputDigest &&
              obs.completedEpoch === mutation.completedEpoch
            ) {
              return {
                success: true,
                data: current,
                revision: current.revision,
                status: 'noop',
              };
            }
            return failure(
              new OutcomeStoreError(
                'invalid_transition',
                'Tool operation already completed with differing output digest or epoch',
                { rootSessionId: session },
              ),
            );
          }
        }
      } else if (mutation.type === 'complete_observation') {
        const obs = current.receipts.evidence.find(
          (entry) => entry.id === mutation.observationId,
        );
        if (obs && obs.kind === 'controller_observed') {
          if (obs.completionObserved) {
            if (
              obs.outputDigest === mutation.outputDigest &&
              obs.completedEpoch === mutation.completedEpoch
            ) {
              return {
                success: true,
                data: current,
                revision: current.revision,
                status: 'noop',
              };
            }
            return failure(
              new OutcomeStoreError(
                'invalid_transition',
                'Tool observation already completed with differing output digest or epoch',
                { rootSessionId: session },
              ),
            );
          }
        }
      } else if (mutation.type === 'append_user_message') {
        const canonicalMessageId = mutation.receipt.messageId.trim();
        for (let generation = 1; generation < currentGen; generation++) {
          const historical = this.#readRecordDirect(session, generation);
          const historicalReceipt = historical.receipts.userMessages.find(
            (entry) => entry.messageId === canonicalMessageId,
          );
          if (!historicalReceipt) continue;
          if (
            historicalReceipt.contentDigest === mutation.receipt.contentDigest
          ) {
            return {
              success: true,
              data: current,
              revision: current.revision,
              status: 'noop',
            };
          }
          return failure(
            new OutcomeStoreError(
              'invalid_transition',
              `User message '${canonicalMessageId}' was already recorded with different content (generation ${generation})`,
              { rootSessionId: session },
            ),
          );
        }
        const existing = current.receipts.userMessages.find(
          (entry) => entry.messageId === canonicalMessageId,
        );
        if (existing) {
          if (existing.contentDigest === mutation.receipt.contentDigest) {
            return {
              success: true,
              data: current,
              revision: current.revision,
              status: 'noop',
            };
          }
          return failure(
            new OutcomeStoreError(
              'invalid_transition',
              `User message '${canonicalMessageId}' was already recorded with different content`,
              { rootSessionId: session },
            ),
          );
        }
      } else if (mutation.type === 'retire_misbound_recovered_result') {
        const claim = current.checkpoint;
        if (
          claim &&
          claim.checkpointId === mutation.checkpointId &&
          claim.claimGeneration === mutation.claimGeneration &&
          claim.state === 'retired'
        ) {
          const expectedNote = formatMisboundRetirementNote(
            mutation.boundResultDigest,
            mutation.observedResultDigest,
            mutation.reason,
          );
          if (
            claim.dispatchCallId === mutation.dispatchCallId &&
            claim.managerTaskId === mutation.managerTaskId &&
            claim.managerGeneration === mutation.managerGeneration &&
            claim.resultDigest === mutation.boundResultDigest &&
            mutation.observedResultDigest !== mutation.boundResultDigest &&
            claim.recoveryNote === expectedNote
          ) {
            return {
              success: true,
              data: current,
              revision: current.revision,
              status: 'noop',
            };
          }
          return failure(
            new OutcomeStoreError(
              'invalid_transition',
              'Checkpoint is already retired and does not match the exact misbound retirement transition',
              { rootSessionId: session },
            ),
          );
        }
      } else if (mutation.type === 'set_wait') {
        if (current.waitCondition && mutation.wait) {
          const currentWaitDigest = canonicalDigest(
            'omos/outcome-wait/v1',
            current.waitCondition,
          );
          const nextWaitDigest = canonicalDigest(
            'omos/outcome-wait/v1',
            mutation.wait,
          );
          if (currentWaitDigest === nextWaitDigest) {
            return {
              success: true,
              data: current,
              revision: current.revision,
              status: 'noop',
            };
          }
        }
      } else if (mutation.type === 'supersede_external_handoff') {
        if (current.waitCondition === undefined) {
          const existing = current.receipts.handoffSupersessions?.find(
            (entry) =>
              entry.waitReferenceId === mutation.waitReferenceId &&
              entry.waitCreatedRevision === mutation.waitCreatedRevision &&
              entry.retiredCheckpointId === mutation.retiredCheckpointId &&
              entry.retiredClaimGeneration === mutation.retiredClaimGeneration,
          );
          if (existing) {
            const expectedDigest = computeOutcomeHandoffSupersessionDigest({
              ...mutation,
              id: existing.id,
              kind: existing.kind,
              supersededAt: existing.supersededAt,
              supersededRevision: existing.supersededRevision,
              serverEpoch: existing.serverEpoch,
            });
            if (
              existing.waitOriginatingServerEpoch ===
                mutation.waitOriginatingServerEpoch &&
              existing.waitRestartObservedRevision ===
                mutation.waitRestartObservedRevision &&
              existing.waitInstructions === mutation.waitInstructions &&
              existing.expectedPostRestartCheck ===
                mutation.expectedPostRestartCheck &&
              existing.retiredDispatchCallId ===
                mutation.retiredDispatchCallId &&
              existing.retiredManagerTaskId === mutation.retiredManagerTaskId &&
              existing.retiredManagerGeneration ===
                mutation.retiredManagerGeneration &&
              existing.retiredBoundResultDigest ===
                mutation.retiredBoundResultDigest &&
              existing.observedChildResultDigest ===
                mutation.observedChildResultDigest &&
              existing.retiredReasonDigest === mutation.retiredReasonDigest &&
              existing.sourceUserMessageReceiptId ===
                mutation.sourceUserMessageReceiptId &&
              existing.evidenceAttestationId ===
                mutation.evidenceAttestationId &&
              existing.replacementCandidateFingerprint ===
                mutation.replacementCandidateFingerprint &&
              existing.reason.trim() === mutation.reason.trim() &&
              existing.payloadDigest === expectedDigest
            ) {
              return {
                success: true,
                data: current,
                revision: current.revision,
                status: 'noop',
              };
            }
            return failure(
              new OutcomeStoreError(
                'invalid_transition',
                'External handoff was already superseded with different parameters',
                { rootSessionId: session },
              ),
            );
          }
        }
      }

      if (current.revision !== expectedRevision) {
        return failure(
          new OutcomeStoreError('conflict', 'Outcome revision conflict', {
            rootSessionId: session,
            expectedRevision,
            actualRevision: current.revision,
          }),
        );
      }
      try {
        const nextRevision = current.revision + 1;
        const next = applyMutation(
          structuredClone(current),
          mutation,
          nextRevision,
          this.#clock(),
          this.#serverEpoch,
          this.#randomId,
        );
        return this.#persist(session, next, 'written', currentGen);
      } catch (error) {
        return failure(
          error instanceof OutcomeStoreError
            ? error
            : new OutcomeStoreError(
                'invalid_transition',
                error instanceof Error ? error.message : String(error),
                {
                  rootSessionId: session,
                  cause: error,
                },
              ),
        );
      }
    });
  }

  validateReview(
    rootSessionId: string,
    input: {
      checkpointId: string;
      claimGeneration: number;
      claimToken?: string;
      resultDigest: string;
      review: OutcomeReview;
      recovered?: boolean;
    },
  ): OutcomeStoreResult<OutcomeRecord> {
    const currentResult = this.read(rootSessionId);
    if (!currentResult.success) return currentResult;
    try {
      const current = currentResult.data;
      const claim = requireClaim(current, input);
      if (input.review && typeof input.review === 'object') {
        validateVerdictForCheckpointKind(
          claim.kind,
          (input.review as { verdict?: OutcomeVerdict }).verdict,
        );
      }
      const review = OutcomeReviewSchema.parse(input.review);
      if (input.recovered) {
        if (
          claim.state !== 'result_available' ||
          claim.serverEpoch === this.#serverEpoch
        ) {
          throw new Error(
            'Recovered review requires a prior-epoch available result',
          );
        }
      } else {
        if (!['running', 'result_available'].includes(claim.state)) {
          throw new Error(
            'Review requires a running or available bound result',
          );
        }
        requireClaimToken(claim, input.claimToken ?? '');
      }
      if (
        claim.resultDigest !== undefined &&
        claim.resultDigest !== input.resultDigest
      ) {
        throw new Error('Manager result digest mismatch');
      }
      if (
        claim.kind === 'final' &&
        review.candidateFingerprint !== claim.candidateFingerprint
      ) {
        throw new Error('Manager review candidate mismatch');
      }
      if (claim.kind === 'kickoff') {
        if (
          current.kickoffGate.state !== 'required' ||
          current.kickoffGate.lastCheckpointId !== claim.checkpointId ||
          current.kickoffGate.attempts === 0
        ) {
          throw new Error(
            'Kickoff review is not reconcilable for current kickoff gate state',
          );
        }
      }
      authenticateReview(current, claim, review);
      return {
        success: true,
        data: current,
        revision: current.revision,
        status: 'noop',
      };
    } catch (error) {
      return failure(
        new OutcomeStoreError(
          'invalid_transition',
          error instanceof Error ? error.message : String(error),
          { rootSessionId, cause: error },
        ),
      );
    }
  }

  validateReviewClaim(
    rootSessionId: string,
    input: {
      checkpointId: string;
      claimGeneration: number;
      claimToken?: string;
      resultDigest: string;
      recovered?: boolean;
    },
  ): OutcomeStoreResult<OutcomeRecord> {
    const currentResult = this.read(rootSessionId);
    if (!currentResult.success) return currentResult;
    try {
      const current = currentResult.data;
      const claim = requireClaim(current, input);
      if (input.recovered) {
        if (
          claim.state !== 'result_available' ||
          claim.serverEpoch === this.#serverEpoch
        ) {
          throw new Error(
            'Recovered review requires a prior-epoch available result',
          );
        }
      } else {
        if (!['running', 'result_available'].includes(claim.state)) {
          throw new Error(
            'Review requires a running or available bound result',
          );
        }
        requireClaimToken(claim, input.claimToken ?? '');
      }
      if (
        claim.resultDigest !== undefined &&
        claim.resultDigest !== input.resultDigest
      ) {
        throw new Error('Manager result digest mismatch');
      }
      return {
        success: true,
        data: current,
        revision: current.revision,
        status: 'noop',
      };
    } catch (error) {
      return failure(
        new OutcomeStoreError(
          'invalid_transition',
          error instanceof Error ? error.message : String(error),
          { rootSessionId, cause: error },
        ),
      );
    }
  }

  persistReconciledReview(
    rootSessionId: string,
    input: OutcomeReviewPersistence,
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    return this.#withLock(session, () => {
      const state = this.#authoritativeSessionStateUnderLock(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const currentGen = state.manifest.currentGeneration;
      const current = this.#readRecordDirect(session, currentGen);
      if (current.serverEpoch !== this.#serverEpoch) {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            'Recover prior-epoch outcome before review persistence',
            { rootSessionId: session },
          ),
        );
      }
      try {
        const claim = requireClaim(current, input);
        const existing = current.reviewSummaries.find(
          (entry) =>
            entry.checkpointId === input.checkpointId &&
            entry.claimGeneration === input.claimGeneration,
        );
        if (
          existing &&
          ['review_accepted', 'review_rejected'].includes(claim.state)
        ) {
          if (
            input.outcome === 'valid' &&
            existing.resultDigest === input.resultDigest &&
            input.review &&
            existing.reviewDigest ===
              canonicalDigest('omos/outcome-manager-review/v1', {
                resultDigest: input.resultDigest,
                review: input.review,
              })
          ) {
            return {
              success: true,
              data: current,
              revision: current.revision,
              status: 'noop',
            };
          }
          throw new Error(
            'A different review is already persisted for this claim',
          );
        }
        if (input.outcome === 'valid') {
          if (input.review && typeof input.review === 'object') {
            validateVerdictForCheckpointKind(
              claim.kind,
              (input.review as { verdict?: OutcomeVerdict }).verdict,
            );
          }
          const review = OutcomeReviewSchema.parse(input.review);
          if (
            claim.kind === 'final' &&
            review.candidateFingerprint !== claim.candidateFingerprint
          ) {
            throw new Error('Manager review candidate mismatch');
          }
          if (claim.kind === 'kickoff') {
            if (
              current.kickoffGate.state !== 'required' ||
              current.kickoffGate.lastCheckpointId !== claim.checkpointId ||
              current.kickoffGate.attempts === 0
            ) {
              throw new Error(
                'Kickoff review is not reconcilable for current kickoff gate state',
              );
            }
          }
          authenticateReview(current, claim, review);
        }
        const mutation: OutcomeRecordMutation =
          input.outcome === 'invalid'
            ? {
                type: 'record_consumed_invalid_review',
                checkpointId: input.checkpointId,
                claimGeneration: input.claimGeneration,
                claimToken: input.recovered ? undefined : input.claimToken,
                resultDigest: input.resultDigest,
                reason: input.reason ?? 'Invalid Manager review',
              }
            : input.recovered
              ? {
                  type: 'record_recovered_review',
                  checkpointId: input.checkpointId,
                  claimGeneration: input.claimGeneration,
                  resultDigest: input.resultDigest,
                  review: input.review as OutcomeReview,
                }
              : {
                  type: 'record_consumed_review',
                  checkpointId: input.checkpointId,
                  claimGeneration: input.claimGeneration,
                  claimToken: input.claimToken ?? '',
                  resultDigest: input.resultDigest,
                  review: input.review as OutcomeReview,
                };
        const revision = current.revision + 1;
        this.#beforePersistReconciledReview?.();
        const next = applyMutation(
          structuredClone(current),
          mutation,
          revision,
          this.#clock(),
          this.#serverEpoch,
          this.#randomId,
        );
        return this.#persist(session, next, 'written', currentGen);
      } catch (error) {
        return failure(
          error instanceof OutcomeStoreError
            ? error
            : new OutcomeStoreError(
                'invalid_transition',
                error instanceof Error ? error.message : String(error),
                { rootSessionId: session, cause: error },
              ),
        );
      }
    });
  }

  recover(rootSessionId: string): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    return this.#withLock(session, () => {
      const state = this.#authoritativeSessionStateUnderLock(session);
      if (!state.initialized) {
        return failure(
          new OutcomeStoreError('missing', 'Outcome record not found', {
            rootSessionId: session,
          }),
        );
      }
      const currentGen = state.manifest.currentGeneration;
      const current = this.#readRecordDirect(session, currentGen);
      if (current.phase === 'accepted') {
        return {
          success: true,
          data: current,
          revision: current.revision,
          status: 'noop',
        };
      }
      if (current.serverEpoch === this.#serverEpoch) {
        return {
          success: true,
          data: current,
          revision: current.revision,
          status: 'noop',
        };
      }
      const now = this.#clock();
      const newlyInterrupted = current.operations
        .filter(
          (operation) =>
            operation.serverEpoch !== this.#serverEpoch &&
            operation.status === 'running',
        )
        .map((operation) => operation.id);
      const operations = current.operations.map((operation) =>
        newlyInterrupted.includes(operation.id)
          ? {
              ...operation,
              status: 'interrupted' as const,
              updatedAt: now,
              interruptionOrigin: 'restart' as const,
              error:
                operation.error ?? 'Operation interrupted by process restart',
            }
          : operation,
      );
      const checkpoint = current.checkpoint
        ? { ...current.checkpoint }
        : undefined;
      const recovered: OutcomeRecord = {
        ...current,
        serverEpoch: this.#serverEpoch,
        revision: current.revision + 1,
        updatedAt: now,
        checkpoint,
        waitCondition:
          current.waitCondition?.kind === 'external_handoff' &&
          current.waitCondition.originatingServerEpoch !== this.#serverEpoch
            ? {
                ...current.waitCondition,
                restartObservedRevision: current.revision + 1,
              }
            : current.waitCondition,
        operations,
        actionsRequired: [...current.actionsRequired],
        resolvedActionArchive: current.resolvedActionArchive
          ? { ...current.resolvedActionArchive }
          : { count: 0, chainDigest: initialActionArchiveChainDigest() },
        kickoffGate: current.kickoffGate
          ? { ...current.kickoffGate }
          : {
              policyVersion: 1,
              state: 'required',
              contractDigest: current.contractDigest,
              attempts: 0,
              maxAttempts: 2,
            },
      };
      if (checkpoint && checkpoint.serverEpoch !== this.#serverEpoch) {
        if (checkpoint.state === 'claimed') {
          insertActionRequired(
            recovered,
            action(
              `reclaim_${checkpoint.checkpointId}`,
              'stale_claim',
              checkpoint.checkpointId,
              'Prior-epoch undispatched checkpoint was cleared',
              now,
              current.revision + 1,
            ),
          );
          recovered.checkpoint = undefined;
        } else if (['dispatching', 'running'].includes(checkpoint.state)) {
          recovered.checkpoint = {
            ...checkpoint,
            state: 'review_uncertain',
            recoveryNote:
              'Manager dispatch crossed a process epoch and requires reconciliation',
          };
          insertActionRequired(
            recovered,
            action(
              `uncertain_${checkpoint.checkpointId}`,
              'review_uncertain',
              checkpoint.checkpointId,
              'Prior-epoch Manager dispatch requires reconciliation',
              now,
              current.revision + 1,
            ),
          );
        }
      }
      for (const id of newlyInterrupted) {
        insertActionRequired(
          recovered,
          action(
            `interrupted_${id}_${current.revision + 1}`,
            'interrupted_operation',
            id,
            `Operation ${id} was interrupted by process restart`,
            now,
            current.revision + 1,
          ),
        );
      }
      const changed =
        current.serverEpoch !== this.#serverEpoch ||
        newlyInterrupted.length > 0 ||
        checkpoint !== current.checkpoint;
      if (!changed)
        return {
          success: true,
          data: current,
          revision: current.revision,
          status: 'noop',
        };
      recovered.phase = recovered.actionsRequired.some(
        (item) => item.resolvedAt === undefined,
      )
        ? 'action_required'
        : current.phase;
      return this.#persist(session, recovered, 'recovered', currentGen);
    });
  }

  reconcileIdleOperations(
    rootSessionId: string,
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    const currentResult = this.read(session);
    if (!currentResult.success) return currentResult;
    const current = currentResult.data;
    const hasRunningSameEpoch = current.operations.some(
      (op) => op.serverEpoch === this.#serverEpoch && op.status === 'running',
    );
    if (!hasRunningSameEpoch) {
      return {
        success: true,
        data: current,
        revision: current.revision,
        status: 'noop',
      };
    }
    return this.mutate(session, current.revision, {
      type: 'reconcile_idle_operations',
    });
  }

  #persist(
    session: string,
    record: OutcomeRecord,
    status: 'created' | 'written' | 'recovered',
    generation?: number,
  ): OutcomeStoreResult<OutcomeRecord> {
    try {
      const parsed = parseOutcomeRecord(OutcomeRecordSchema.parse(record));
      const serialized = serializeOutcomeRecord(parsed);
      const targetGen = generation ?? parsed.generation ?? 1;
      this.#atomicReplace(this.recordPath(session, targetGen), serialized);
      return { success: true, data: parsed, revision: parsed.revision, status };
    } catch (error) {
      return failure(this.#writeError(error, session));
    }
  }

  #withLock<T>(
    session: string,
    operation: () => OutcomeStoreResult<T>,
  ): OutcomeStoreResult<T> {
    if (this.#lockedSessions.has(session)) {
      return operation();
    }
    let lock: LockCapability;
    try {
      lock = this.#acquireLock(session);
      this.#lockedSessions.add(session);
    } catch (error) {
      return failure(
        error instanceof OutcomeStoreError
          ? error
          : new OutcomeStoreError('io_error', String(error)),
      );
    }
    try {
      return operation();
    } catch (error) {
      if (error instanceof OutcomeStoreError) {
        return failure(error);
      }
      return failure(
        new OutcomeStoreError(
          'io_error',
          error instanceof Error ? error.message : String(error),
          { rootSessionId: session, cause: error },
        ),
      );
    } finally {
      this.#lockedSessions.delete(session);
      this.#releaseLock(lock);
    }
  }

  #acquireLock(session: string): LockCapability {
    this.#ensureStoreDirectory();
    const canonical = path.join(
      this.#storeDirectory,
      `${sessionHash(session)}.lock`,
    );
    const deadline = this.#clock() + this.#lockTimeoutMs;
    for (;;) {
      const owner: LockOwner = {
        pid: process.pid,
        epoch: this.#serverEpoch,
        token: this.#randomId(),
        createdAt: this.#clock(),
      };
      const candidate = `${canonical}.candidate.${process.pid}.${owner.token}`;
      let published = false;
      try {
        fs.mkdirSync(candidate);
        writeExclusiveDurable(
          path.join(candidate, 'owner.json'),
          `${JSON.stringify(owner)}\n`,
          this.#fsync,
          this.#write,
        );
        syncDirectory(candidate, this.#fsync);
        this.#rename(candidate, canonical);
        published = true;
        syncDirectory(this.#storeDirectory, this.#fsync);
        return { path: canonical, owner };
      } catch (error) {
        if (published) {
          this.#quarantineMatchingLock(canonical, owner);
          throw new OutcomeStoreError(
            'durability_uncertain',
            'Lock was published but its directory fsync failed',
            { rootSessionId: session, cause: error },
          );
        }
        removeUnpublishedCandidate(candidate);
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      }
      const existing = readLockOwner(canonical);
      if (
        existing &&
        !this.#isPidAlive(existing.pid) &&
        this.#quarantineMatchingLock(canonical, existing)
      ) {
        continue;
      }
      if (this.#clock() >= deadline) {
        throw new OutcomeStoreError(
          'contention',
          'Outcome store lock is held',
          { rootSessionId: session },
        );
      }
      this.#sleep(5);
    }
  }

  #quarantineMatchingLock(canonical: string, expected: LockOwner): boolean {
    const quarantine = `${canonical}.quarantine.${process.pid}.${this.#randomId()}`;
    try {
      this.#rename(canonical, quarantine);
    } catch {
      return false;
    }
    const moved = readLockOwner(quarantine);
    if (sameOwner(moved, expected)) {
      fs.rmSync(quarantine, { recursive: true, force: true });
      return true;
    }
    try {
      this.#rename(quarantine, canonical);
    } catch {
      // Preserve the unmatched lock for diagnosis rather than deleting it.
    }
    return false;
  }

  #releaseLock(lock: LockCapability): void {
    const release = `${lock.path}.release.${process.pid}.${lock.owner.token}`;
    try {
      this.#rename(lock.path, release);
    } catch {
      return;
    }
    const moved = readLockOwner(release);
    if (sameOwner(moved, lock.owner)) {
      fs.rmSync(release, { recursive: true, force: true });
      return;
    }
    try {
      this.#rename(release, lock.path);
    } catch {
      // Preserve unknown ownership for diagnosis.
    }
  }

  #ensureStoreDirectory(): void {
    this.#assertSafePath();
    fs.mkdirSync(this.#storeDirectory, { recursive: true });
    this.#assertSafePath();
  }

  #assertSafePath(): void {
    if (this.#projectDirectory)
      assertNoSymlinkComponents(this.#projectDirectory);
    assertNoSymlinkComponents(this.#storeDirectory);
  }

  #atomicReplace(target: string, data: string): void {
    this.#ensureStoreDirectory();
    rejectSymlink(target);
    const temporary = `${target}.${process.pid}.${this.#randomId()}.tmp`;
    let descriptor: number | undefined;
    let ownInode: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeAll(descriptor, data, this.#write);
      this.#fsync(descriptor);
      ownInode = fs.fstatSync(descriptor).ino;
      const named = fs.lstatSync(temporary);
      if (!named.isFile() || named.ino !== ownInode)
        throw new OutcomeStoreError(
          'symlink_detected',
          'Temporary file ownership changed',
        );
      rejectSymlink(target);
      this.#rename(temporary, target);
      const published = fs.lstatSync(target);
      if (!published.isFile() || published.ino !== ownInode)
        throw new OutcomeStoreError(
          'durability_uncertain',
          'Published record identity is uncertain',
        );
      try {
        syncDirectory(this.#storeDirectory, this.#fsync);
      } catch (error) {
        throw new OutcomeStoreError(
          'durability_uncertain',
          'Record replaced but directory fsync failed',
          { cause: error },
        );
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      removeOwnedFile(temporary, ownInode);
    }
  }

  #readError(error: unknown, session: string): OutcomeStoreError {
    if (error instanceof OutcomeStoreError) return error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return new OutcomeStoreError('missing', 'Outcome record does not exist', {
        rootSessionId: session,
      });
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return new OutcomeStoreError(
        'corrupt',
        'Outcome record is malformed or invalid',
        { rootSessionId: session, cause: error },
      );
    }
    if (error instanceof Error && error.message.includes('digest mismatch')) {
      return new OutcomeStoreError('corrupt', error.message, {
        rootSessionId: session,
        cause: error,
      });
    }
    return new OutcomeStoreError(
      'io_error',
      error instanceof Error ? error.message : String(error),
      { rootSessionId: session, cause: error },
    );
  }

  #writeError(error: unknown, session: string): OutcomeStoreError {
    if (error instanceof OutcomeStoreError) return error;
    if (error instanceof Error && error.message.includes('exceeds')) {
      return new OutcomeStoreError('oversized', error.message, {
        rootSessionId: session,
        cause: error,
      });
    }
    if (
      error instanceof Error &&
      (error.name === 'ZodError' || error.message.includes('digest mismatch'))
    ) {
      return new OutcomeStoreError('corrupt', error.message, {
        rootSessionId: session,
        cause: error,
      });
    }
    return new OutcomeStoreError(
      'io_error',
      error instanceof Error ? error.message : String(error),
      { rootSessionId: session, cause: error },
    );
  }
}

function applyMutation(
  current: OutcomeRecord,
  mutation: OutcomeRecordMutation,
  revision: number,
  now: number,
  epoch: string,
  randomId: () => string,
): OutcomeRecord {
  if (current.phase === 'accepted')
    throw new Error('Accepted outcome is immutable');
  let next = structuredClone(current);
  switch (mutation.type) {
    case 'revise_contract': {
      if (current.waitCondition)
        throw new Error('Contract cannot change while a wait condition exists');
      if (current.checkpoint && !isReviewed(current.checkpoint.state))
        throw new Error('Contract cannot change while a checkpoint exists');
      const contract = OutcomeContractSchema.parse(mutation.contract);
      const nextContractDigest = computeOutcomeContractDigest(contract);
      const authorityChanged =
        current.contract.objective !== contract.objective ||
        canonicalDigest('omos/outcome-scope/v1', {
          inScope: current.contract.inScope,
          outOfScope: current.contract.outOfScope,
        }) !==
          canonicalDigest('omos/outcome-scope/v1', {
            inScope: contract.inScope,
            outOfScope: contract.outOfScope,
          });

      const receipt = mutation.sourceUserMessageReceiptId
        ? current.receipts.userMessages.find(
            (entry) => entry.id === mutation.sourceUserMessageReceiptId,
          )
        : undefined;
      const hasExternalUserAuth =
        receipt?.provenance === 'external_user' &&
        contract.sourceMessageIds.includes(receipt.messageId);

      if (authorityChanged && !hasExternalUserAuth) {
        throw new Error(
          'Objective or scope revision requires an external_user receipt included in sourceMessageIds',
        );
      }
      for (const exception of contract.exceptions) {
        const authorization = current.receipts.authorizations.find(
          (entry) => entry.id === exception.authorizationId,
        );
        if (!authorization) {
          throw new Error(
            `Exception for rule '${exception.ruleId}' references an unknown authorization`,
          );
        }
      }

      let kickoffGate: OutcomeKickoffGate;
      if (nextContractDigest !== current.contractDigest) {
        if (hasExternalUserAuth) {
          kickoffGate = {
            policyVersion: 1,
            state: 'required',
            contractDigest: nextContractDigest,
            attempts: 0,
            maxAttempts: 2,
          };
        } else {
          kickoffGate = {
            ...current.kickoffGate,
            contractDigest: nextContractDigest,
          };
        }
      } else {
        kickoffGate = current.kickoffGate;
      }

      next = {
        ...next,
        contract,
        contractDigest: nextContractDigest,
        kickoffGate,
        phase: 'active',
      };
      delete next.checkpoint;
      break;
    }
    case 'append_evidence': {
      if (
        mutation.entry.kind === 'orchestrator_attestation' &&
        mutation.entry.linkedObservationId
      ) {
        const linkedObsId = mutation.entry.linkedObservationId;
        const target = next.receipts.evidence.find((e) => e.id === linkedObsId);
        if (!target) {
          throw new Error(
            `Linked observation '${linkedObsId}' not found in durable record`,
          );
        }
        if (target.kind !== 'controller_observed') {
          throw new Error(
            `Linked observation '${linkedObsId}' is not controller_observed`,
          );
        }
        if (!target.completionObserved) {
          throw new Error(`Linked observation '${linkedObsId}' is incomplete`);
        }
        const op = next.operations.find((o) => o.callId === target.callId);
        if (!op) {
          throw new Error(
            `Linked operation '${target.callId}' not found for observation '${target.id}'`,
          );
        }
        if (op.status !== 'completed') {
          throw new Error(
            `Linked operation '${op.callId}' must be completed (found status '${op.status}')`,
          );
        }
        if (
          op.toolName !== target.toolName ||
          op.argumentDigest !== target.argumentDigest ||
          op.serverEpoch !== target.startedEpoch
        ) {
          throw new Error(
            `Linked observation '${target.id}' is identity-incoherent with its operation`,
          );
        }
      }
      compactUnreferencedToolHistory(
        next,
        mutation.entry.kind === 'orchestrator_attestation' &&
          mutation.entry.linkedObservationId
          ? new Set([mutation.entry.linkedObservationId])
          : undefined,
      );
      if (
        mutation.entry.kind === 'orchestrator_attestation' &&
        mutation.entry.createdRevision !== revision
      ) {
        throw new Error(
          'Attestation createdRevision must equal its persisted revision',
        );
      }
      next.receipts.evidence.push(mutation.entry);
      break;
    }
    case 'start_tool_call':
      compactUnreferencedToolHistory(next);
      if (
        mutation.operation.serverEpoch !== epoch ||
        mutation.operation.status !== 'running' ||
        mutation.operation.interruptionOrigin !== undefined ||
        mutation.observation.startedEpoch !== epoch ||
        mutation.observation.completionObserved
      ) {
        throw new Error('Tool call must start incomplete in the current epoch');
      }
      if (
        mutation.operation.callId !== mutation.observation.callId ||
        mutation.operation.toolName !== mutation.observation.toolName ||
        mutation.operation.argumentDigest !==
          mutation.observation.argumentDigest
      ) {
        throw new Error('Tool operation and observation identity mismatch');
      }
      next.operations.push(mutation.operation);
      next.receipts.evidence.push(mutation.observation);
      break;
    case 'complete_observation': {
      const index = next.receipts.evidence.findIndex(
        (entry) => entry.id === mutation.observationId,
      );
      if (index < 0) throw new Error('Observation does not exist');
      const existing = next.receipts.evidence[index];
      if (existing.kind !== 'controller_observed') {
        throw new Error('Target is not a tool observation');
      }
      if (existing.completionObserved) {
        if (
          existing.outputDigest === mutation.outputDigest &&
          existing.completedEpoch === mutation.completedEpoch
        ) {
          break;
        }
        throw new Error(
          'Observation is already completed with different output or epoch',
        );
      }
      if (existing.startedEpoch !== mutation.completedEpoch) {
        throw new Error('A generic completion must belong to its start epoch');
      }
      next.receipts.evidence[index] = {
        ...existing,
        completionObserved: true,
        outputDigest: mutation.outputDigest,
        completedEpoch: mutation.completedEpoch,
        completedAt: mutation.completedAt,
      };
      break;
    }
    case 'complete_tool_call': {
      const operationIndex = next.operations.findIndex(
        (entry) => entry.id === mutation.operationId,
      );
      const observationIndex = next.receipts.evidence.findIndex(
        (entry) => entry.id === mutation.observationId,
      );
      if (operationIndex < 0 || observationIndex < 0) {
        throw new Error('Tool operation or observation does not exist');
      }
      const op = next.operations[operationIndex];
      const observation = next.receipts.evidence[observationIndex];
      if (observation?.kind !== 'controller_observed') {
        throw new Error(
          'Tool observation is missing or not controller_observed',
        );
      }
      if (op.status === 'completed') {
        if (
          observation.completionObserved &&
          observation.outputDigest === mutation.outputDigest &&
          observation.completedEpoch === mutation.completedEpoch
        ) {
          break;
        }
        throw new Error(
          'Tool operation already completed with different output or epoch',
        );
      }
      const isIdleInterrupted =
        op.status === 'interrupted' &&
        op.serverEpoch === epoch &&
        op.error === 'Session became idle without a durable tool after-hook';

      const isRunning = op.status === 'running' && op.serverEpoch === epoch;

      if (!isRunning && !isIdleInterrupted) {
        throw new Error(
          'Tool operation is not running or repairable idle-interrupted',
        );
      }
      if (observation.completionObserved) {
        throw new Error('Tool observation is already complete');
      }
      if (
        observation.callId !== op.callId ||
        observation.toolName !== op.toolName ||
        observation.argumentDigest !== op.argumentDigest ||
        observation.startedEpoch !== mutation.completedEpoch ||
        mutation.completedEpoch !== epoch
      ) {
        throw new Error('Tool completion identity or epoch mismatch');
      }
      next.receipts.evidence[observationIndex] = {
        ...observation,
        completionObserved: true,
        outputDigest: mutation.outputDigest,
        completedEpoch: mutation.completedEpoch,
        completedAt: mutation.completedAt,
      };
      const completedOp: OutcomePendingOperation = {
        id: op.id,
        callId: op.callId,
        toolName: op.toolName,
        argumentDigest: op.argumentDigest,
        serverEpoch: op.serverEpoch,
        status: 'completed',
        startedAt: op.startedAt,
        updatedAt: mutation.completedAt,
      };
      next.operations[operationIndex] = completedOp;
      break;
    }
    case 'append_user_message': {
      const canonicalMessageId = mutation.receipt.messageId.trim();
      const existing = next.receipts.userMessages.find(
        (entry) => entry.messageId === canonicalMessageId,
      );
      if (existing) {
        if (existing.contentDigest === mutation.receipt.contentDigest) {
          break;
        }
        throw new OutcomeStoreError(
          'invalid_transition',
          `User message '${canonicalMessageId}' was already recorded with different content`,
        );
      }
      if (mutation.receipt.createdRevision !== revision) {
        throw new Error(
          'User message createdRevision must equal its persisted revision',
        );
      }
      if (!mutation.receipt.provenance) {
        throw new Error('User message receipt requires explicit provenance');
      }
      next.receipts.userMessages.push({
        ...mutation.receipt,
        messageId: canonicalMessageId,
        provenance: mutation.receipt.provenance,
      });
      break;
    }
    case 'append_decision':
      next.receipts.decisions.push(mutation.receipt);
      break;
    case 'resolve_decision': {
      const index = next.receipts.decisions.findIndex(
        (entry) => entry.id === mutation.decisionId,
      );
      if (index < 0) throw new Error('Decision does not exist');
      const existing = next.receipts.decisions[index];
      if (existing.chosenOption !== undefined) {
        throw new Error('Decision is already resolved');
      }
      if (!existing.options.includes(mutation.chosenOption)) {
        throw new Error('Chosen option is not in available options');
      }
      const userMsg = next.receipts.userMessages.find(
        (entry) => entry.id === mutation.sourceUserMessageReceiptId,
      );
      if (userMsg?.provenance !== 'external_user') {
        throw new Error(
          'Decision resolution requires an external_user receipt',
        );
      }
      if (userMsg.createdRevision <= existing.createdRevision) {
        throw new Error('Source user message must follow the decision request');
      }
      next.receipts.decisions[index] = {
        ...existing,
        chosenOption: mutation.chosenOption,
        sourceUserMessageReceiptId: mutation.sourceUserMessageReceiptId,
        decidedAt: mutation.decidedAt,
      };
      if (
        next.waitCondition?.kind === 'user_decision' &&
        next.waitCondition.referenceId === mutation.decisionId
      ) {
        delete next.waitCondition;
      }
      break;
    }
    case 'append_authorization':
      if (
        mutation.receipt.payloadDigest !==
        computeOutcomeAuthorizationDigest(mutation.receipt)
      ) {
        throw new Error(
          'Authorization payloadDigest must be Controller-minted from its bound fields',
        );
      }
      if (mutation.receipt.kind === 'user_decision') {
        if (!mutation.receipt.decisionId) {
          throw new Error('User authorization requires a decision ID');
        }
        const decision = next.receipts.decisions.find(
          (d) => d.id === mutation.receipt.decisionId,
        );
        if (!decision?.sourceUserMessageReceiptId) {
          throw new Error('User authorization requires a resolved decision');
        }
        const userMsg = next.receipts.userMessages.find(
          (m) => m.id === decision.sourceUserMessageReceiptId,
        );
        if (userMsg?.provenance !== 'external_user') {
          throw new Error(
            'New user_decision authorization requires referenced decision to be backed by an external_user receipt',
          );
        }
      }
      next.receipts.authorizations.push(mutation.receipt);
      break;
    case 'open_checkpoint': {
      if (current.checkpoint && !isReviewed(current.checkpoint.state))
        throw new Error('A checkpoint is already active');
      if (mutation.kind === 'kickoff') {
        if (current.kickoffGate.state === 'authenticated') {
          throw new OutcomeStoreError(
            'invalid_transition',
            'Kickoff review is already authenticated for this contract',
          );
        }
        if (current.kickoffGate.state === 'legacy_late_missing') {
          throw new OutcomeStoreError(
            'retrospective_kickoff_forbidden',
            'Retrospective kickoff is forbidden for legacy record with missing kickoff',
          );
        }
        if (
          current.kickoffGate.state === 'exhausted' ||
          current.kickoffGate.attempts >= current.kickoffGate.maxAttempts
        ) {
          throw new OutcomeStoreError(
            'kickoff_retry_exhausted',
            'Kickoff retry attempts exhausted',
          );
        }
        next.kickoffGate = {
          ...current.kickoffGate,
          attempts: current.kickoffGate.attempts + 1,
        };
      } else {
        if (current.kickoffGate.state !== 'authenticated') {
          if (current.kickoffGate.state === 'legacy_late_missing') {
            throw new OutcomeStoreError(
              'retrospective_kickoff_forbidden',
              'Historical kickoff is missing (legacy_late_missing); non-kickoff checkpoint forbidden',
            );
          }
          throw new OutcomeStoreError(
            'invalid_transition',
            'Kickoff review must be authenticated before opening non-kickoff checkpoint',
          );
        }
      }
      const claimGeneration = current.nextClaimGeneration;
      const checkpointId = `chk_${mutation.kind}_${randomId().slice(0, 16)}`;
      if (mutation.kind === 'kickoff') {
        next.kickoffGate.lastCheckpointId = checkpointId;
      }
      const base = {
        outcomeId: current.outcomeId,
        rootSessionId: current.rootSessionId,
        checkpointId,
        kind: mutation.kind,
        reason: mutation.reason,
        claimGeneration,
        claimTokenDigest: canonicalDigest(
          'omos/outcome-claim-token/v1',
          mutation.claimToken,
        ),
        contractDigest: current.contractDigest,
        outcomeRevision: current.revision,
        serverEpoch: epoch,
        claimedAt: now,
        expiresAt: mutation.expiresAt,
        ...(mutation.candidateFingerprint
          ? { candidateFingerprint: mutation.candidateFingerprint }
          : {}),
        includedDecisionIds: mutation.decisionIds ?? [],
        includedExceptionRuleIds: mutation.exceptionRuleIds ?? [],
        includedEvidenceAttestationIds: mutation.evidenceAttestationIds ?? [],
      };
      next.checkpoint = {
        ...base,
        checkpointFingerprint: computeOutcomeCheckpointFingerprint(base),
        state: 'claimed',
      };
      next.nextClaimGeneration = claimGeneration + 1;
      break;
    }
    case 'mark_dispatching': {
      const claim = requireClaim(next, mutation);
      requireLiveClaimToken(claim, mutation.claimToken, now);
      if (claim.state !== 'claimed')
        throw new Error('Only a claimed checkpoint can dispatch');
      next.checkpoint = {
        ...claim,
        state: 'dispatching',
        dispatchCallId: mutation.dispatchCallId,
      };
      next.phase = 'reviewing';
      break;
    }
    case 'bind_manager': {
      const claim = requireClaim(next, mutation);
      requireLiveClaimToken(claim, mutation.claimToken, now);
      if (claim.state !== 'dispatching')
        throw new Error('Manager binding requires dispatching state');
      next.checkpoint = {
        ...claim,
        state: 'running',
        managerTaskId: mutation.managerTaskId,
        managerGeneration: mutation.managerGeneration,
      };
      break;
    }
    case 'mark_result_available': {
      const claim = requireClaim(next, mutation);
      requireLiveClaimToken(claim, mutation.claimToken, now);
      if (claim.state !== 'running')
        throw new Error('Result requires a running Manager');
      next.checkpoint = {
        ...claim,
        state: 'result_available',
        resultDigest: mutation.resultDigest,
      };
      break;
    }
    case 'record_review':
    case 'record_consumed_review': {
      const claim = requireClaim(next, mutation);
      if (
        mutation.type === 'record_review'
          ? claim.state !== 'result_available'
          : !['running', 'result_available'].includes(claim.state)
      ) {
        throw new Error(
          mutation.type === 'record_review'
            ? 'Review requires an available bound result'
            : 'Consumed review requires a running or available bound result',
        );
      }
      if (mutation.review && typeof mutation.review === 'object') {
        validateVerdictForCheckpointKind(
          claim.kind,
          (mutation.review as { verdict?: OutcomeVerdict }).verdict,
        );
      }
      requireClaimToken(claim, mutation.claimToken);
      if (
        claim.resultDigest !== undefined &&
        mutation.resultDigest !== claim.resultDigest
      )
        throw new Error('Manager result digest mismatch');
      const review = OutcomeReviewSchema.parse(mutation.review);
      if (
        claim.kind === 'final' &&
        review.candidateFingerprint !== claim.candidateFingerprint
      ) {
        throw new Error('Manager review candidate mismatch');
      }
      authenticateReview(next, claim, review);
      recordParsedReview(
        next,
        claim,
        review,
        mutation.resultDigest,
        now,
        revision,
        randomId,
      );
      break;
    }
    case 'record_recovered_review': {
      const claim = requireClaim(next, mutation);
      if (claim.state !== 'result_available' || claim.serverEpoch === epoch) {
        throw new Error(
          'Recovered review requires a prior-epoch available result',
        );
      }
      if (mutation.review && typeof mutation.review === 'object') {
        validateVerdictForCheckpointKind(
          claim.kind,
          (mutation.review as { verdict?: OutcomeVerdict }).verdict,
        );
      }
      if (mutation.resultDigest !== claim.resultDigest)
        throw new Error('Manager result digest mismatch');
      const review = OutcomeReviewSchema.parse(mutation.review);
      if (
        claim.kind === 'final' &&
        review.candidateFingerprint !== claim.candidateFingerprint
      ) {
        throw new Error('Manager review candidate mismatch');
      }
      authenticateReview(next, claim, review);
      recordParsedReview(
        next,
        claim,
        review,
        mutation.resultDigest,
        now,
        revision,
        randomId,
      );
      break;
    }
    case 'record_invalid_review':
    case 'record_consumed_invalid_review': {
      const claim = requireClaim(next, mutation);
      if (
        mutation.type === 'record_invalid_review'
          ? claim.state !== 'result_available'
          : !['running', 'result_available'].includes(claim.state)
      ) {
        throw new Error(
          mutation.type === 'record_invalid_review'
            ? 'Invalid review requires an available bound result'
            : 'Consumed invalid review requires a running or available bound result',
        );
      }
      if (mutation.claimToken) {
        requireClaimToken(claim, mutation.claimToken);
      } else if (claim.serverEpoch === epoch) {
        throw new Error(
          'Current-epoch invalid review requires its claim token',
        );
      }
      if (
        claim.resultDigest !== undefined &&
        mutation.resultDigest !== undefined &&
        mutation.resultDigest !== claim.resultDigest
      ) {
        throw new Error('Manager result digest mismatch');
      }
      const reviewDigest = canonicalDigest('omos/outcome-invalid-review/v1', {
        checkpointId: claim.checkpointId,
        claimGeneration: claim.claimGeneration,
        reason: mutation.reason,
      });
      next.checkpoint = {
        ...claim,
        state: 'review_invalid',
        resultDigest:
          mutation.resultDigest ?? claim.resultDigest ?? reviewDigest,
        reviewDigest,
        recoveryNote: mutation.reason,
      };
      if (claim.kind === 'kickoff') {
        next.kickoffGate = {
          ...next.kickoffGate,
          failureReason: mutation.reason,
          state:
            next.kickoffGate.attempts >= next.kickoffGate.maxAttempts
              ? 'exhausted'
              : next.kickoffGate.state,
        };
        if (next.kickoffGate.state === 'exhausted') {
          next.phase = 'failed';
        }
      }
      insertActionRequired(
        next,
        action(
          `invalid_review_${claim.checkpointId}_${claim.claimGeneration}`,
          'manual_intervention',
          claim.checkpointId,
          mutation.reason,
          now,
          revision,
        ),
      );
      break;
    }
    case 'record_invalid_dispatch': {
      const claim = requireClaim(next, mutation);
      if (claim.state !== 'dispatching') {
        throw new Error('Invalid dispatch requires dispatching state');
      }
      next.checkpoint = {
        ...claim,
        state: 'retired',
        recoveryNote: mutation.reason,
      };
      if (claim.kind === 'kickoff') {
        next.kickoffGate = {
          ...next.kickoffGate,
          failureReason: mutation.reason,
          state:
            next.kickoffGate.attempts >= next.kickoffGate.maxAttempts
              ? 'exhausted'
              : next.kickoffGate.state,
        };
        if (next.kickoffGate.state === 'exhausted') {
          next.phase = 'failed';
        }
      }
      insertActionRequired(
        next,
        action(
          `invalid_dispatch_${claim.checkpointId}_${claim.claimGeneration}`,
          'manual_intervention',
          claim.checkpointId,
          mutation.reason,
          now,
          revision,
        ),
      );
      break;
    }
    case 'expire_checkpoint': {
      const claim = requireClaim(next, mutation);
      requireClaimToken(claim, mutation.claimToken);
      if (!['claimed', 'dispatching', 'running'].includes(claim.state))
        throw new Error('Checkpoint is not expirable');
      if (now <= claim.expiresAt) throw new Error('Checkpoint has not expired');
      next.checkpoint = {
        ...claim,
        state: 'retired',
        recoveryNote: mutation.reason,
      };
      if (claim.kind === 'kickoff') {
        next.kickoffGate = {
          ...next.kickoffGate,
          failureReason: mutation.reason,
          state:
            next.kickoffGate.attempts >= next.kickoffGate.maxAttempts
              ? 'exhausted'
              : next.kickoffGate.state,
        };
        if (next.kickoffGate.state === 'exhausted') {
          next.phase = 'failed';
        }
      }
      break;
    }
    case 'reconcile_idle_operations': {
      for (const op of next.operations) {
        if (op.serverEpoch === epoch && op.status === 'running') {
          op.status = 'interrupted';
          op.updatedAt = now;
          op.interruptionOrigin = 'idle';
          op.error = 'Session became idle without a durable tool after-hook';
        }
      }
      break;
    }
    case 'set_wait':
      if (!mutation.wait) throw new Error('Wait condition is required');
      if (current.waitCondition)
        throw new Error('Cannot replace unresolved wait condition');
      if (mutation.wait.createdRevision !== revision)
        throw new Error(
          'Wait createdRevision must equal its persisted revision',
        );
      next.waitCondition = mutation.wait;
      next.phase =
        mutation.wait.kind === 'user_decision'
          ? 'waiting_user'
          : 'waiting_external';
      break;
    case 'clear_wait':
      if (next.waitCondition?.kind === 'external_handoff')
        throw new Error('Generic clear_wait cannot clear external_handoff');
      if (next.waitCondition?.referenceId !== mutation.referenceId)
        throw new Error('Wait reference mismatch');
      delete next.waitCondition;
      next.phase = 'active';
      break;
    case 'complete_external_handoff': {
      if (!next.waitCondition) {
        throw new Error('No wait condition to complete');
      }
      if (next.waitCondition.kind !== 'external_handoff') {
        throw new Error('Wait condition is not an external handoff');
      }
      const wait = next.waitCondition;
      if (wait.referenceId !== mutation.waitReferenceId) {
        throw new Error('Wait reference ID mismatch');
      }
      if (wait.createdRevision !== mutation.waitCreatedRevision) {
        throw new Error('Wait created revision mismatch');
      }
      if (wait.originatingServerEpoch !== mutation.waitOriginatingServerEpoch) {
        throw new Error('Wait originating server epoch mismatch');
      }
      if (
        wait.restartObservedRevision !== mutation.waitRestartObservedRevision
      ) {
        throw new Error('Wait restart observed revision mismatch');
      }
      if (wait.expectedPostRestartCheck !== mutation.expectedPostRestartCheck) {
        throw new Error('Wait expected post restart check mismatch');
      }
      if (wait.originatingServerEpoch === epoch) {
        throw new Error(
          'External handoff completion requires a different Controller server epoch',
        );
      }
      if (
        wait.restartObservedRevision === undefined ||
        wait.restartObservedRevision <= wait.createdRevision
      ) {
        throw new Error('Wait restart observation must follow creation');
      }

      const userReceipt = next.receipts.userMessages.find(
        (entry) => entry.id === mutation.sourceUserMessageReceiptId,
      );
      if (
        userReceipt?.provenance !== 'external_user' ||
        userReceipt.createdRevision <= wait.restartObservedRevision ||
        userReceipt.createdRevision > revision ||
        userReceipt.observedEpoch !== epoch
      ) {
        throw new Error(
          'External handoff completion requires a subsequent external_user receipt in current epoch',
        );
      }

      const evidence = next.receipts.evidence.find(
        (entry) => entry.id === mutation.evidenceAttestationId,
      );
      if (
        evidence?.kind !== 'orchestrator_attestation' ||
        evidence.createdRevision <= wait.restartObservedRevision ||
        evidence.createdRevision <= userReceipt.createdRevision ||
        evidence.createdRevision > revision ||
        evidence.assertedStatus !== 'passed' ||
        evidence.assertedFreshness !== 'fresh' ||
        (wait.expectedPostRestartCheck &&
          evidence.description !== wait.expectedPostRestartCheck)
      ) {
        throw new Error(
          'External handoff completion requires matching fresh passed post-restart evidence',
        );
      }

      delete next.waitCondition;
      next.phase = 'active';
      break;
    }
    case 'supersede_external_handoff': {
      if (!next.waitCondition) {
        throw new Error('No wait condition to supersede');
      }
      if (next.waitCondition.kind !== 'external_handoff') {
        throw new Error('Wait condition is not an external handoff');
      }
      const wait = next.waitCondition;
      if (wait.referenceId !== mutation.waitReferenceId) {
        throw new Error('Wait reference ID mismatch');
      }
      if (wait.createdRevision !== mutation.waitCreatedRevision) {
        throw new Error('Wait created revision mismatch');
      }
      if (wait.originatingServerEpoch !== mutation.waitOriginatingServerEpoch) {
        throw new Error('Wait originating server epoch mismatch');
      }
      if (
        wait.restartObservedRevision !== mutation.waitRestartObservedRevision
      ) {
        throw new Error('Wait restart observed revision mismatch');
      }
      if (wait.instructions !== mutation.waitInstructions) {
        throw new Error('Wait instructions mismatch');
      }
      if (wait.expectedPostRestartCheck !== mutation.expectedPostRestartCheck) {
        throw new Error('Wait expected post restart check mismatch');
      }
      if (wait.originatingServerEpoch === epoch) {
        throw new Error(
          'Superseding external handoff requires a different current server epoch',
        );
      }
      if (
        wait.restartObservedRevision === undefined ||
        wait.restartObservedRevision <= wait.createdRevision
      ) {
        throw new Error('Wait restart observation must follow creation');
      }
      if (
        !mutation.expectedPostRestartCheck.includes(
          mutation.retiredCheckpointId,
        ) &&
        !mutation.waitInstructions.includes(mutation.retiredCheckpointId)
      ) {
        throw new Error(
          'Exact handoff instructions or expected check must contain retired checkpoint ID',
        );
      }

      if (!next.checkpoint) {
        throw new Error('Missing retired checkpoint');
      }
      const claim = next.checkpoint;
      if (claim.checkpointId !== mutation.retiredCheckpointId) {
        throw new Error('Retired checkpoint ID mismatch');
      }
      if (claim.claimGeneration !== mutation.retiredClaimGeneration) {
        throw new Error('Retired claim generation mismatch');
      }
      if (claim.kind !== 'final') {
        throw new Error(
          'Superseded handoff requires a retired final checkpoint',
        );
      }
      if (claim.state !== 'retired') {
        throw new Error(
          'Checkpoint must be retired to supersede external handoff',
        );
      }
      if (
        !claim.dispatchCallId ||
        !claim.managerTaskId ||
        claim.managerGeneration === undefined ||
        !claim.resultDigest
      ) {
        throw new Error(
          'Retired checkpoint lacks complete Manager identity or result digest',
        );
      }
      if (claim.dispatchCallId !== mutation.retiredDispatchCallId) {
        throw new Error('Retired dispatch call ID mismatch');
      }
      if (claim.managerTaskId !== mutation.retiredManagerTaskId) {
        throw new Error('Retired manager task ID mismatch');
      }
      if (claim.managerGeneration !== mutation.retiredManagerGeneration) {
        throw new Error('Retired manager generation mismatch');
      }
      if (claim.resultDigest !== mutation.retiredBoundResultDigest) {
        throw new Error('Retired bound result digest mismatch');
      }
      if (!claim.recoveryNote) {
        throw new Error('Retired checkpoint lacks recovery note');
      }
      const parsedNote = parseMisboundRetirementNote(claim.recoveryNote);
      if (!parsedNote) {
        throw new Error(
          'Retired checkpoint lacks a valid misbound retirement audit note',
        );
      }
      if (parsedNote.boundDigest !== claim.resultDigest) {
        throw new Error(
          'Audit bound digest does not match claim result digest',
        );
      }
      if (parsedNote.observedDigest === parsedNote.boundDigest) {
        throw new Error('Audit observed digest must differ from bound digest');
      }
      if (parsedNote.reasonDigest !== mutation.retiredReasonDigest) {
        throw new Error('Audit reason digest mismatch');
      }
      if (mutation.observedChildResultDigest !== parsedNote.observedDigest) {
        throw new Error(
          'Authoritative child result digest does not match audit observed digest',
        );
      }

      const userReceipt = next.receipts.userMessages.find(
        (entry) => entry.id === mutation.sourceUserMessageReceiptId,
      );
      if (
        userReceipt?.provenance !== 'external_user' ||
        userReceipt.createdRevision <= wait.restartObservedRevision ||
        userReceipt.createdRevision > revision ||
        userReceipt.observedEpoch !== epoch
      ) {
        throw new Error(
          'Superseding external handoff requires a fresh external_user receipt minted after restart observation in current epoch',
        );
      }

      const evidence = next.receipts.evidence.find(
        (entry) => entry.id === mutation.evidenceAttestationId,
      );
      if (
        evidence?.kind !== 'orchestrator_attestation' ||
        evidence.createdRevision <= userReceipt.createdRevision ||
        evidence.createdRevision > revision ||
        evidence.assertedStatus !== 'passed' ||
        evidence.assertedFreshness !== 'fresh' ||
        evidence.candidateFingerprint !==
          mutation.replacementCandidateFingerprint
      ) {
        throw new Error(
          'Superseding external handoff requires fresh passed evidence minted after user receipt matching replacement candidate',
        );
      }

      if (
        !mutation.reason ||
        typeof mutation.reason !== 'string' ||
        mutation.reason.trim() === ''
      ) {
        throw new Error('Supersession reason must be a non-empty string');
      }
      const trimmedReason = mutation.reason.trim();
      if (trimmedReason.length > 512) {
        throw new Error(
          'Supersession reason exceeds maximum length of 512 characters',
        );
      }

      delete next.waitCondition;
      const receipt: OutcomeHandoffSupersessionReceipt = {
        id: `sup_${randomId().replace(/-/g, '').slice(0, 16)}`,
        kind: 'external_handoff_supersession',
        waitReferenceId: mutation.waitReferenceId,
        waitCreatedRevision: mutation.waitCreatedRevision,
        waitOriginatingServerEpoch: mutation.waitOriginatingServerEpoch,
        waitRestartObservedRevision: mutation.waitRestartObservedRevision,
        waitInstructions: mutation.waitInstructions,
        expectedPostRestartCheck: mutation.expectedPostRestartCheck,
        retiredCheckpointId: mutation.retiredCheckpointId,
        retiredClaimGeneration: mutation.retiredClaimGeneration,
        retiredDispatchCallId: mutation.retiredDispatchCallId,
        retiredManagerTaskId: mutation.retiredManagerTaskId,
        retiredManagerGeneration: mutation.retiredManagerGeneration,
        retiredBoundResultDigest: mutation.retiredBoundResultDigest,
        observedChildResultDigest: mutation.observedChildResultDigest,
        retiredReasonDigest: mutation.retiredReasonDigest,
        sourceUserMessageReceiptId: mutation.sourceUserMessageReceiptId,
        evidenceAttestationId: mutation.evidenceAttestationId,
        replacementCandidateFingerprint:
          mutation.replacementCandidateFingerprint,
        reason: trimmedReason,
        payloadDigest: '',
        supersededAt: now,
        supersededRevision: revision,
        serverEpoch: epoch,
      };
      receipt.payloadDigest = computeOutcomeHandoffSupersessionDigest(receipt);
      next.receipts.handoffSupersessions = [
        ...(next.receipts.handoffSupersessions ?? []),
        receipt,
      ];
      break;
    }
    case 'start_operation':
      compactUnreferencedToolHistory(next);
      if (
        mutation.operation.serverEpoch !== epoch ||
        mutation.operation.status !== 'running' ||
        mutation.operation.interruptionOrigin !== undefined
      )
        throw new Error('Operation must start running in current epoch');
      next.operations.push(mutation.operation);
      break;
    case 'finish_operation': {
      const index = next.operations.findIndex(
        (entry) => entry.id === mutation.operationId,
      );
      if (index < 0 || next.operations[index].status !== 'running')
        throw new Error('Operation is not running');
      next.operations[index] = {
        ...next.operations[index],
        status: mutation.status,
        updatedAt: now,
        interruptionOrigin: undefined,
        ...(mutation.error ? { error: mutation.error } : {}),
      };
      break;
    }
    case 'acknowledge_operation': {
      const index = next.operations.findIndex(
        (entry) => entry.id === mutation.operationId,
      );
      if (
        index < 0 ||
        !['failed', 'interrupted'].includes(next.operations[index].status)
      ) {
        throw new Error(
          'Only failed or interrupted operations can be acknowledged',
        );
      }
      const acknowledged = next.operations[index];
      const inferredInterruptionOrigin =
        acknowledged.status === 'interrupted'
          ? (acknowledged.interruptionOrigin ??
            interruptionOriginFromError(acknowledged.error))
          : undefined;
      next.operations[index] = {
        ...acknowledged,
        status: 'acknowledged',
        updatedAt: now,
        ...(inferredInterruptionOrigin
          ? { interruptionOrigin: inferredInterruptionOrigin }
          : { interruptionOrigin: undefined }),
      };
      for (const action of next.actionsRequired) {
        if (
          action.code === 'interrupted_operation' &&
          action.referenceId === mutation.operationId &&
          action.resolvedAt === undefined
        ) {
          action.resolvedAt = now;
          action.resolutionKind = 'controller_reconciliation';
          action.resolutionReason =
            'Resolved by explicit acknowledgement of the matching interrupted operation';
        }
      }
      break;
    }
    case 'reconcile_uncertain_checkpoint': {
      const claim = requireClaim(next, mutation);
      if (claim.state !== 'review_uncertain')
        throw new Error('Checkpoint is not uncertain');
      if (mutation.resolution.kind === 'retire') {
        next.checkpoint = {
          ...claim,
          state: 'retired',
          recoveryNote: mutation.resolution.reason,
        };
      } else {
        if (claim.serverEpoch === epoch)
          throw new Error('Recovery transition requires a prior-epoch claim');
        if (
          claim.managerTaskId &&
          (claim.managerTaskId !== mutation.resolution.managerTaskId ||
            claim.managerGeneration !== mutation.resolution.managerGeneration ||
            claim.dispatchCallId !== mutation.resolution.dispatchCallId)
        ) {
          throw new Error('Recovered Manager identity cannot be replaced');
        }
        next.checkpoint = {
          ...claim,
          state: 'result_available',
          dispatchCallId: mutation.resolution.dispatchCallId,
          managerTaskId: mutation.resolution.managerTaskId,
          managerGeneration: mutation.resolution.managerGeneration,
          resultDigest: mutation.resolution.resultDigest,
        };
      }
      resolveMatchingRecoveryActions(next, claim.checkpointId, now);
      break;
    }
    case 'retire_misbound_recovered_result': {
      const claim = requireClaim(next, mutation);
      if (claim.state !== 'result_available') {
        throw new Error(
          'Retiring misbound result requires a result_available checkpoint',
        );
      }
      if (claim.serverEpoch === epoch) {
        throw new Error('Recovery transition requires a prior-epoch claim');
      }
      if (claim.dispatchCallId !== mutation.dispatchCallId) {
        throw new Error('Dispatch call ID mismatch');
      }
      if (claim.managerTaskId !== mutation.managerTaskId) {
        throw new Error('Manager task ID mismatch');
      }
      if (claim.managerGeneration !== mutation.managerGeneration) {
        throw new Error('Manager generation mismatch');
      }
      if (claim.resultDigest !== mutation.boundResultDigest) {
        throw new Error('Bound result digest mismatch');
      }
      if (mutation.observedResultDigest === mutation.boundResultDigest) {
        throw new Error(
          'Observed result digest must differ from bound result digest to retire misbound result',
        );
      }
      if (
        !mutation.reason ||
        typeof mutation.reason !== 'string' ||
        mutation.reason.trim() === ''
      ) {
        throw new Error('Retirement reason must be a non-empty string');
      }
      const trimmedReason = mutation.reason.trim();
      if (trimmedReason.length > 512) {
        throw new Error(
          'Retirement reason exceeds maximum length of 512 characters',
        );
      }
      const recoveryNote = formatMisboundRetirementNote(
        mutation.boundResultDigest,
        mutation.observedResultDigest,
        trimmedReason,
      );
      next.checkpoint = {
        ...claim,
        state: 'retired',
        recoveryNote,
      };
      if (claim.kind === 'kickoff') {
        next.kickoffGate = {
          ...next.kickoffGate,
          failureReason: recoveryNote,
          state:
            next.kickoffGate.attempts >= next.kickoffGate.maxAttempts
              ? 'exhausted'
              : next.kickoffGate.state,
        };
        if (next.kickoffGate.state === 'exhausted') {
          next.phase = 'failed';
        }
      }
      resolveMatchingRecoveryActions(next, claim.checkpointId, now);
      break;
    }
    case 'append_action':
      if (mutation.action.code === 'interrupted_operation') {
        throw new Error(
          'Interrupted-operation actions are reserved for store-owned lifecycle transitions',
        );
      }
      if (mutation.action.createdRevision !== revision) {
        throw new Error(
          'Action createdRevision must equal its persisted revision',
        );
      }
      insertActionRequired(next, mutation.action);
      next.phase = 'action_required';
      break;
    case 'resolve_action': {
      const index = next.actionsRequired.findIndex(
        (entry) =>
          entry.id === mutation.actionId && entry.resolvedAt === undefined,
      );
      if (index < 0) throw new Error('Action is not unresolved');
      const unresolvedAction = next.actionsRequired[index];
      const userReceipt = mutation.sourceUserMessageReceiptId
        ? next.receipts.userMessages.find(
            (entry) => entry.id === mutation.sourceUserMessageReceiptId,
          )
        : undefined;
      const attestations = next.receipts.evidence.filter(
        (entry) => entry.kind === 'orchestrator_attestation',
      );
      const evidence = (mutation.evidenceAttestationIds ?? []).map((id) =>
        attestations.find((entry) => entry.id === id),
      );
      if (
        (!userReceipt && evidence.length === 0) ||
        (mutation.sourceUserMessageReceiptId !== undefined &&
          userReceipt?.provenance !== 'external_user') ||
        evidence.some(
          (entry) =>
            !entry ||
            entry.createdRevision <= unresolvedAction.createdRevision ||
            entry.assertedStatus !== 'passed' ||
            entry.assertedFreshness !== 'fresh',
        ) ||
        (userReceipt !== undefined &&
          userReceipt.createdRevision <= unresolvedAction.createdRevision)
      ) {
        throw new Error(
          'Action resolution requires subsequent external_user provenance or fresh passed subsequent orchestrator-attestation evidence',
        );
      }
      next.actionsRequired[index] = {
        ...next.actionsRequired[index],
        resolvedAt: now,
        resolutionKind: 'orchestrator_provenance',
        resolutionReason: mutation.reason,
        ...(userReceipt
          ? { resolutionUserMessageReceiptId: userReceipt.id }
          : {}),
        ...(evidence.length > 0
          ? {
              resolutionEvidenceAttestationIds: evidence.map(
                (entry) => entry?.id as string,
              ),
              resolutionEvidenceAssurance: 'orchestrator_attestation' as const,
            }
          : {}),
      };
      if (!next.actionsRequired.some((entry) => entry.resolvedAt === undefined))
        next.phase = 'active';
      break;
    }
    case 'update_goal_status': {
      if (current.checkpoint && !isReviewed(current.checkpoint.state)) {
        throw new Error('Goal status cannot change while a checkpoint exists');
      }
      const index = next.contract.goals.findIndex(
        (goal) => goal.id === mutation.goalId,
      );
      if (index < 0) throw new Error('Goal does not exist');
      next.contract.goals[index] = {
        ...next.contract.goals[index],
        status: mutation.newStatus,
      };
      next.contractDigest = computeOutcomeContractDigest(next.contract);
      break;
    }
    case 'finalize':
      assertFinalizable(next);
      {
        const claim = next.checkpoint as OutcomeCheckpointClaim;
        const review = next.reviewSummaries.find(
          (entry) =>
            entry.checkpointId === claim.checkpointId &&
            entry.claimGeneration === claim.claimGeneration,
        ) as OutcomeManagerReviewSummary;
        const receiptDigests = claim.includedEvidenceAttestationIds.map(
          (id) => {
            const entry = next.receipts.evidence.find(
              (candidate) => candidate.id === id,
            );
            if (entry?.kind !== 'orchestrator_attestation')
              throw new Error('Final attestation is missing');
            return entry.payloadDigest;
          },
        );
        const certificate: OutcomeFinalCertificate = {
          outcomeId: next.outcomeId,
          acceptedRevision: revision,
          contractDigest: next.contractDigest,
          candidateFingerprint: claim.candidateFingerprint as string,
          acceptedCheckpointId: claim.checkpointId,
          acceptedClaimGeneration: claim.claimGeneration,
          finalCheckpointFingerprint: claim.checkpointFingerprint,
          managerTaskId: claim.managerTaskId as string,
          managerGeneration: claim.managerGeneration as number,
          managerReviewId: review.reviewId,
          managerReviewDigest: review.reviewDigest,
          receiptDigests,
          evidenceAssurance: 'orchestrator_attestation',
          acceptedAt: now,
          serverEpoch: epoch,
          summary: mutation.summary,
        };
        next = {
          ...next,
          phase: 'accepted',
          finalCertificate: certificate,
        };
      }
      break;
    default: {
      const unreachable: never = mutation;
      throw new Error(
        `Unknown outcome mutation: ${String(
          (unreachable as { type?: unknown }).type,
        )}`,
      );
    }
  }
  const updated = { ...next, revision, updatedAt: now, serverEpoch: epoch };
  return updated.phase === 'accepted'
    ? updated
    : { ...updated, phase: derivePhase(updated) };
}

function requireClaim(
  record: OutcomeRecord,
  input: { checkpointId: string; claimGeneration: number },
): OutcomeCheckpointClaim {
  const claim = record.checkpoint;
  if (
    !claim ||
    claim.checkpointId !== input.checkpointId ||
    claim.claimGeneration !== input.claimGeneration
  ) {
    throw new Error('Checkpoint identity mismatch');
  }
  return claim;
}

function requireClaimToken(claim: OutcomeCheckpointClaim, token: string): void {
  if (
    claim.claimTokenDigest !==
    canonicalDigest('omos/outcome-claim-token/v1', token)
  ) {
    throw new Error('Checkpoint claim token mismatch');
  }
}

function requireLiveClaimToken(
  claim: OutcomeCheckpointClaim,
  token: string,
  now: number,
): void {
  requireClaimToken(claim, token);
  if (now > claim.expiresAt) throw new Error('Checkpoint claim has expired');
}

function recordParsedReview(
  record: OutcomeRecord,
  claim: OutcomeCheckpointClaim,
  review: OutcomeReview,
  resultDigest: string,
  evaluatedAt: number,
  persistedRevision: number,
  randomId: () => string,
): void {
  const boundedReviewReason = boundedText(review.summary);
  if (claim.kind === 'kickoff') {
    assertKickoffReviewReconcilable(record, claim);
  }
  const reviewDigest = canonicalDigest('omos/outcome-manager-review/v1', {
    resultDigest,
    review,
  });
  const summary: OutcomeManagerReviewSummary = {
    reviewId: `review_${randomId().slice(0, 16)}`,
    checkpointId: claim.checkpointId,
    claimGeneration: claim.claimGeneration,
    checkpointKind: claim.kind,
    contractDigest: claim.contractDigest,
    outcomeRevision: claim.outcomeRevision,
    verdict: review.verdict,
    managerTaskId: claim.managerTaskId as string,
    managerGeneration: claim.managerGeneration as number,
    resultDigest,
    reviewDigest,
    ...(review.candidateFingerprint
      ? { candidateFingerprint: review.candidateFingerprint }
      : {}),
    summary: review.summary,
    evaluatedAt,
  };
  record.reviewSummaries.push(summary);
  record.checkpoint = {
    ...claim,
    state: review.verdict === 'ACCEPT' ? 'review_accepted' : 'review_rejected',
    resultDigest,
    reviewDigest,
  };
  if (claim.kind === 'kickoff') {
    if (review.verdict === 'CONTINUE') {
      record.kickoffGate = {
        ...record.kickoffGate,
        state: 'authenticated',
        authenticatedReviewId: summary.reviewId,
        failureReason: undefined,
      };
    } else {
      record.kickoffGate = {
        ...record.kickoffGate,
        failureReason: boundedReviewReason,
        state:
          record.kickoffGate.attempts >= record.kickoffGate.maxAttempts
            ? 'exhausted'
            : record.kickoffGate.state,
      };
      if (record.kickoffGate.state === 'exhausted') {
        record.phase = 'failed';
      }
    }
  }
  if (review.verdict === 'USER_DECISION_REQUIRED') {
    const decisionId = `dec_${summary.reviewId}`;
    if (review.userDecision) {
      const decisionReceipt: OutcomeDecisionReceipt = {
        id: decisionId,
        decisionNeeded: review.userDecision.decisionNeeded,
        options: review.userDecision.options,
        blocking: review.userDecision.blocking,
        createdAt: evaluatedAt,
        createdRevision: persistedRevision,
        ...(review.userDecision.impact
          ? { impact: review.userDecision.impact }
          : {}),
      };
      record.receipts.decisions.push(decisionReceipt);
    }
    record.waitCondition = {
      kind: 'user_decision',
      referenceId: decisionId,
      reason: review.userDecision?.decisionNeeded ?? review.summary,
      createdAt: evaluatedAt,
      createdRevision: persistedRevision,
    };
  } else if (
    review.verdict === 'CORRECT_DRIFT' ||
    review.verdict === 'REVISE_CONTRACT'
  ) {
    insertActionRequired(
      record,
      action(
        `action_${summary.reviewId}`,
        'manual_intervention',
        summary.reviewId,
        boundedReviewReason,
        evaluatedAt,
        persistedRevision,
      ),
    );
  }
}

function boundedText(value: string, maxLength = 512): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function authenticateReview(
  record: OutcomeRecord,
  claim: OutcomeCheckpointClaim,
  review: OutcomeReview,
): void {
  const goals = record.contract.goals.map(({ id, description, status }) => ({
    id,
    description,
    status,
  }));
  const reviewGoals = review.goals.map(({ id, description, status }) => ({
    id,
    description,
    status,
  }));
  if (
    canonicalDigest('omos/outcome-goals/v1', goals) !==
    canonicalDigest('omos/outcome-goals/v1', reviewGoals)
  ) {
    throw new Error(
      'Manager review goals do not match the Controller contract',
    );
  }
  if (
    canonicalDigest('omos/outcome-scope/v1', {
      inScope: record.contract.inScope,
      outOfScope: record.contract.outOfScope,
    }) !== canonicalDigest('omos/outcome-scope/v1', review.scope)
  ) {
    throw new Error(
      'Manager review scope does not match the Controller contract',
    );
  }

  const includedAttestations = new Map(
    claim.includedEvidenceAttestationIds.map((id) => [
      id,
      record.receipts.evidence.find((entry) => entry.id === id),
    ]),
  );
  if (review.evidence.length !== includedAttestations.size) {
    throw new Error(
      'Manager review evidence set does not match the checkpoint',
    );
  }
  for (const evidence of review.evidence) {
    const attestation = includedAttestations.get(evidence.id);
    if (
      attestation?.kind !== 'orchestrator_attestation' ||
      evidence.command !== attestation.description ||
      evidence.status !== attestation.assertedStatus ||
      evidence.freshness !== attestation.assertedFreshness ||
      evidence.fingerprint !== attestation.candidateFingerprint ||
      evidence.isFinalCandidate !== (claim.kind === 'final')
    ) {
      throw new Error(
        `Manager evidence '${evidence.id}' does not match its attestation`,
      );
    }
  }

  if (review.rules.length !== record.contract.rules.length) {
    throw new Error(
      'Manager review rule set does not match the Controller contract',
    );
  }
  const reviewRules = new Map(review.rules.map((rule) => [rule.id, rule]));
  for (const rule of record.contract.rules) {
    const reviewed = reviewRules.get(rule.id);
    if (
      !reviewed ||
      reviewed.sourcePath !== rule.sourcePath ||
      reviewed.category !== rule.category ||
      reviewed.summary !== rule.summary ||
      reviewed.ruleType !== rule.ruleType ||
      reviewed.enforcementStatus !== rule.enforcementStatus ||
      canonicalDigest('omos/outcome-rule-evidence/v1', reviewed.evidenceIds) !==
        canonicalDigest(
          'omos/outcome-rule-evidence/v1',
          rule.evidenceAttestationIds,
        )
    ) {
      throw new Error(
        `Manager rule '${rule.id}' does not match the Controller contract`,
      );
    }
  }

  if (review.exceptions.length !== record.contract.exceptions.length) {
    throw new Error(
      'Manager review exception set does not match the Controller contract',
    );
  }
  const reviewExceptions = new Map(
    review.exceptions.map((exception) => [exception.ruleId, exception]),
  );
  for (const exception of record.contract.exceptions) {
    const reviewed = reviewExceptions.get(exception.ruleId);
    const authorization = record.receipts.authorizations.find(
      (entry) => entry.id === exception.authorizationId,
    );
    if (
      !reviewed ||
      !authorization ||
      !reviewed.justified ||
      reviewed.justification !== exception.justification ||
      reviewed.scope !== exception.scope ||
      reviewed.authorizationKind !== authorization.kind ||
      reviewed.authorizationReference !== authorization.reference
    ) {
      throw new Error(
        `Manager exception '${exception.ruleId}' lacks matching external authorization`,
      );
    }
  }
}

function resolveMatchingRecoveryActions(
  record: OutcomeRecord,
  checkpointId: string,
  resolvedAt: number,
): void {
  const actionId = `uncertain_${checkpointId}`;
  record.actionsRequired = record.actionsRequired.map((entry) =>
    entry.id === actionId && entry.resolvedAt === undefined
      ? {
          ...entry,
          resolvedAt,
          resolutionKind: 'controller_reconciliation',
          resolutionReason:
            'Resolved by the matching uncertain-checkpoint reconciliation transition',
        }
      : entry,
  );
}

function derivePhase(record: OutcomeRecord): OutcomeRecord['phase'] {
  if (record.phase === 'accepted') return 'accepted';
  if (
    record.kickoffGate.state === 'exhausted' ||
    record.kickoffGate.state === 'legacy_late_missing'
  ) {
    return 'failed';
  }
  if (record.actionsRequired.some((entry) => entry.resolvedAt === undefined)) {
    return 'action_required';
  }
  if (record.checkpoint?.state === 'review_uncertain') {
    return 'action_required';
  }
  if (
    record.operations.some((entry) =>
      ['failed', 'interrupted'].includes(entry.status),
    )
  ) {
    return 'action_required';
  }
  if (record.waitCondition?.kind === 'user_decision') return 'waiting_user';
  if (record.waitCondition) return 'waiting_external';
  if (record.checkpoint?.state === 'claimed') return 'checkpointing';
  if (
    record.checkpoint &&
    ['dispatching', 'running', 'result_available'].includes(
      record.checkpoint.state,
    )
  ) {
    return 'reviewing';
  }
  return 'active';
}

function assertFinalizable(record: OutcomeRecord): void {
  const claim = record.checkpoint;
  if (
    claim?.kind !== 'final' ||
    claim.state !== 'review_accepted' ||
    !claim.candidateFingerprint ||
    !claim.resultDigest
  ) {
    throw new Error('Finalization requires an accepted final checkpoint');
  }
  const review = record.reviewSummaries.find(
    (entry) =>
      entry.checkpointId === claim.checkpointId &&
      entry.claimGeneration === claim.claimGeneration,
  );
  if (
    review?.verdict !== 'ACCEPT' ||
    review.resultDigest !== claim.resultDigest ||
    review.candidateFingerprint !== claim.candidateFingerprint
  ) {
    throw new Error('Final Manager ACCEPT review is missing or mismatched');
  }
  if (
    record.kickoffGate.state !== 'authenticated' ||
    !record.kickoffGate.authenticatedReviewId
  ) {
    throw new Error('Kickoff review has not completed');
  }
  const kickoffReview = record.reviewSummaries.find(
    (entry) =>
      entry.reviewId === record.kickoffGate.authenticatedReviewId &&
      entry.checkpointKind === 'kickoff' &&
      entry.contractDigest === record.contractDigest &&
      entry.verdict === 'CONTINUE',
  );
  if (!kickoffReview) {
    throw new Error('Kickoff review has not completed');
  }
  if (record.contract.goals.some((goal) => goal.status !== 'satisfied')) {
    throw new Error('All outcome goals must be satisfied');
  }
  if (
    record.contract.rules.some((rule) =>
      ['violated', 'pending'].includes(rule.enforcementStatus),
    )
  ) {
    throw new Error('Outcome rules remain violated or pending');
  }
  const included = new Map(
    claim.includedEvidenceAttestationIds.map((id) => [
      id,
      record.receipts.evidence.find((entry) => entry.id === id),
    ]),
  );
  for (const entry of included.values()) {
    if (
      entry?.kind !== 'orchestrator_attestation' ||
      entry.assertedStatus !== 'passed' ||
      entry.assertedFreshness !== 'fresh' ||
      entry.candidateFingerprint !== claim.candidateFingerprint
    ) {
      throw new Error(
        'Final evidence attestations must be passed, fresh, and candidate-bound',
      );
    }
    if (entry.linkedObservationId) {
      const linkedObs = record.receipts.evidence.find(
        (candidate) => candidate.id === entry.linkedObservationId,
      );
      if (
        linkedObs?.kind !== 'controller_observed' ||
        !linkedObs.completionObserved
      ) {
        throw new Error(
          `Final evidence attestation '${entry.id}' linked observation is incomplete or invalid`,
        );
      }
      const operation = record.operations.find(
        (op) => op.callId === linkedObs.callId,
      );
      if (
        operation?.status !== 'completed' ||
        operation.toolName !== linkedObs.toolName ||
        operation.argumentDigest !== linkedObs.argumentDigest ||
        operation.serverEpoch !== linkedObs.startedEpoch
      ) {
        throw new Error(
          `Final evidence attestation '${entry.id}' linked observation is identity-incoherent with its operation`,
        );
      }
    }
  }
  for (const rule of record.contract.rules) {
    if (
      rule.ruleType === 'machine_enforced' &&
      rule.enforcementStatus === 'satisfied' &&
      !rule.evidenceAttestationIds.some((id) => included.has(id))
    ) {
      throw new Error(
        `Machine-enforced rule '${rule.id}' lacks included final evidence`,
      );
    }
  }
  if (record.waitCondition)
    throw new Error('Outcome still has a wait condition');
  if (record.actionsRequired.some((entry) => entry.resolvedAt === undefined)) {
    throw new Error('Outcome still has unresolved actions');
  }
  if (
    record.operations.some(
      (entry) => !['completed', 'acknowledged'].includes(entry.status),
    )
  ) {
    throw new Error('Outcome still has unresolved operations');
  }
}

function assertKickoffReviewReconcilable(
  record: OutcomeRecord,
  claim: OutcomeCheckpointClaim,
): void {
  if (
    record.kickoffGate.state !== 'required' ||
    record.kickoffGate.lastCheckpointId !== claim.checkpointId ||
    record.kickoffGate.attempts < 1 ||
    record.kickoffGate.attempts > record.kickoffGate.maxAttempts
  ) {
    throw new Error(
      'Kickoff review is not reconcilable for current kickoff gate state',
    );
  }
}

function isReviewed(state: OutcomeCheckpointClaim['state']): boolean {
  return [
    'review_accepted',
    'review_rejected',
    'review_invalid',
    'retired',
  ].includes(state);
}

function compactUnreferencedToolHistory(
  record: OutcomeRecord,
  additionalReferencedObservationIds: ReadonlySet<string> = new Set(),
): void {
  const referencedObsIds = new Set<string>(additionalReferencedObservationIds);
  const referencedOpIds = new Set<string>();

  for (const entry of record.receipts.evidence) {
    if (
      entry.kind === 'orchestrator_attestation' &&
      entry.linkedObservationId
    ) {
      referencedObsIds.add(entry.linkedObservationId);
    }
  }

  for (const entry of record.receipts.evidence) {
    if (
      entry.kind === 'controller_observed' &&
      referencedObsIds.has(entry.id)
    ) {
      referencedObsIds.add(entry.callId);
      referencedOpIds.add(entry.callId);
    }
  }

  for (const op of record.operations) {
    if (referencedOpIds.has(op.callId)) {
      referencedOpIds.add(op.id);
    }
  }

  for (const rule of record.contract.rules) {
    for (const id of rule.evidenceAttestationIds) {
      referencedObsIds.add(id);
    }
  }

  if (record.checkpoint) {
    for (const id of record.checkpoint.includedEvidenceAttestationIds) {
      referencedObsIds.add(id);
    }
    for (const id of record.checkpoint.includedDecisionIds) {
      referencedObsIds.add(id);
    }
    for (const id of record.checkpoint.includedExceptionRuleIds) {
      referencedObsIds.add(id);
    }
  }

  for (const actionItem of record.actionsRequired) {
    const resolvedInterruptedOperation =
      actionItem.code === 'interrupted_operation' &&
      actionItem.resolvedAt !== undefined;
    if (!resolvedInterruptedOperation) {
      referencedOpIds.add(actionItem.referenceId);
      referencedObsIds.add(actionItem.referenceId);
    }
    if (actionItem.resolutionEvidenceAttestationIds) {
      for (const id of actionItem.resolutionEvidenceAttestationIds) {
        referencedObsIds.add(id);
      }
    }
  }

  if (record.waitCondition) {
    referencedOpIds.add(record.waitCondition.referenceId);
    referencedObsIds.add(record.waitCondition.referenceId);
  }

  for (const summary of record.reviewSummaries) {
    referencedObsIds.add(summary.checkpointId);
    referencedObsIds.add(summary.managerTaskId);
  }

  if (record.finalCertificate) {
    referencedObsIds.add(record.finalCertificate.acceptedCheckpointId);
    referencedObsIds.add(record.finalCertificate.managerTaskId);
    referencedObsIds.add(record.finalCertificate.managerReviewId);
  }

  const compactableObsByCallId = new Map<string, OutcomeToolObservation[]>();
  for (const entry of record.receipts.evidence) {
    if (
      entry.kind === 'controller_observed' &&
      !referencedObsIds.has(entry.id) &&
      !referencedObsIds.has(entry.callId)
    ) {
      const list = compactableObsByCallId.get(entry.callId) ?? [];
      list.push(entry);
      compactableObsByCallId.set(entry.callId, list);
    }
  }

  const compactableOpsByCallId = new Map<string, OutcomePendingOperation[]>();
  for (const op of record.operations) {
    if (
      ['completed', 'acknowledged'].includes(op.status) &&
      !referencedOpIds.has(op.id) &&
      !referencedOpIds.has(op.callId)
    ) {
      const list = compactableOpsByCallId.get(op.callId) ?? [];
      list.push(op);
      compactableOpsByCallId.set(op.callId, list);
    }
  }

  const candidatePairs: Array<{
    op: OutcomePendingOperation;
    obs: OutcomeToolObservation;
  }> = [];

  for (const op of record.operations) {
    if (
      !['completed', 'acknowledged'].includes(op.status) ||
      referencedOpIds.has(op.id) ||
      referencedOpIds.has(op.callId)
    ) {
      continue;
    }
    const matchingOps = compactableOpsByCallId.get(op.callId);
    const matchingObs = compactableObsByCallId.get(op.callId);
    if (matchingOps?.length === 1 && matchingObs?.length === 1) {
      const obs = matchingObs[0];
      const completedPair =
        op.status === 'completed' &&
        obs.completionObserved &&
        obs.outputDigest !== undefined &&
        obs.completedEpoch !== undefined &&
        obs.completedAt !== undefined;
      const acknowledgedInterruptedPair =
        op.status === 'acknowledged' &&
        !obs.completionObserved &&
        op.interruptionOrigin !== undefined &&
        !record.actionsRequired.some(
          (actionItem) =>
            actionItem.code === 'interrupted_operation' &&
            actionItem.referenceId === op.id &&
            actionItem.resolvedAt === undefined,
        );
      if (
        (completedPair || acknowledgedInterruptedPair) &&
        obs.toolName === op.toolName &&
        obs.argumentDigest === op.argumentDigest &&
        obs.startedEpoch === op.serverEpoch
      ) {
        candidatePairs.push({ op, obs });
      }
    }
  }

  const targetMaxOperations = 16;
  const targetMaxEvidence = 32;
  const maxRetainDefault = 8;

  const nonCandidateOps = record.operations.length - candidatePairs.length;
  const nonCandidateEvidence =
    record.receipts.evidence.length - candidatePairs.length;

  let maxToRetain = maxRetainDefault;
  if (nonCandidateOps + maxToRetain > targetMaxOperations) {
    maxToRetain = Math.max(0, targetMaxOperations - nonCandidateOps);
  }
  if (nonCandidateEvidence + maxToRetain > targetMaxEvidence) {
    maxToRetain = Math.max(0, targetMaxEvidence - nonCandidateEvidence);
  }

  if (candidatePairs.length > maxToRetain) {
    const pruneCount = candidatePairs.length - maxToRetain;
    const pairsToPrune = candidatePairs.slice(0, pruneCount);
    const opIdsToPrune = new Set(pairsToPrune.map((p) => p.op.id));
    const obsIdsToPrune = new Set(pairsToPrune.map((p) => p.obs.id));

    record.operations = record.operations.filter(
      (op) => !opIdsToPrune.has(op.id),
    );
    record.receipts.evidence = record.receipts.evidence.filter(
      (ev) => !obsIdsToPrune.has(ev.id),
    );
  }
}

function action(
  id: string,
  code: OutcomeActionRequired['code'],
  referenceId: string,
  reason: string,
  createdAt: number,
  createdRevision: number,
): OutcomeActionRequired {
  return { id, code, referenceId, reason, createdAt, createdRevision };
}

function insertActionRequired(
  record: OutcomeRecord,
  newAction: OutcomeActionRequired,
): void {
  const unresolved = record.actionsRequired.filter(
    (a) => a.resolvedAt === undefined,
  );
  if (unresolved.length >= 16) {
    throw new OutcomeStoreError(
      'action_capacity_exhausted',
      'Action capacity exhausted by unresolved actions',
    );
  }
  const resolved = record.actionsRequired.filter(
    (a) => a.resolvedAt !== undefined,
  );
  resolved.sort((a, b) =>
    a.createdRevision !== b.createdRevision
      ? a.createdRevision - b.createdRevision
      : a.id.localeCompare(b.id),
  );

  const maxResolvedToRetain = Math.max(0, Math.min(4, 15 - unresolved.length));
  if (resolved.length > maxResolvedToRetain) {
    const toArchiveCount = resolved.length - maxResolvedToRetain;
    const toArchive = resolved.slice(0, toArchiveCount);
    const toRetain = resolved.slice(toArchiveCount);

    for (const item of toArchive) {
      record.resolvedActionArchive.count += 1;
      record.resolvedActionArchive.chainDigest =
        computeActionArchiveChainDigest(
          record.resolvedActionArchive.chainDigest,
          record.resolvedActionArchive.count,
          item,
        );
    }
    record.actionsRequired = [...unresolved, ...toRetain];
  }

  record.actionsRequired.push(newAction);
}

function interruptionOriginFromError(
  error: string | undefined,
): OutcomePendingOperation['interruptionOrigin'] {
  if (error === 'Operation interrupted by process restart') return 'restart';
  if (error === 'Session became idle without a durable tool after-hook') {
    return 'idle';
  }
  return undefined;
}

function sessionHash(session: string): string {
  return createHash('sha256').update(session, 'utf8').digest('hex');
}

function validateSession(value: string): string {
  return OutcomeSessionIdSchema.parse(value);
}

function safeSession(value: unknown): string | OutcomeStoreError {
  const result = OutcomeSessionIdSchema.safeParse(value);
  return result.success
    ? result.data
    : new OutcomeStoreError('invalid_session_id', 'Invalid root session ID', {
        cause: result.error,
      });
}

function failure<T>(error: OutcomeStoreError): OutcomeStoreResult<T> {
  return { success: false, error, code: error.code };
}

function readRegularFile(file: string, maxBytes: number): string {
  rejectSymlink(file);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile())
      throw new OutcomeStoreError(
        'symlink_detected',
        'Outcome path is not a regular file',
      );
    if (stat.size > maxBytes)
      throw new OutcomeStoreError('oversized', 'Outcome record is oversized');
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLockOwner(directory: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(
      readRegularFile(path.join(directory, 'owner.json'), 4096),
    );
    if (
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.epoch === 'string' &&
      typeof parsed.token === 'string' &&
      Number.isInteger(parsed.createdAt)
    ) {
      return parsed as LockOwner;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sameOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return (
    !!left &&
    left.pid === right.pid &&
    left.epoch === right.epoch &&
    left.token === right.token
  );
}

function writeExclusiveDurable(
  file: string,
  data: string,
  fsync: typeof fs.fsyncSync,
  write: typeof fs.writeSync,
): void {
  const descriptor = fs.openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeAll(descriptor, data, write);
    fsync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAll(
  descriptor: number,
  data: string,
  write: typeof fs.writeSync,
): void {
  const bytes = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = write(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (written <= 0) throw new Error('Write made no progress');
    offset += written;
  }
}

function syncDirectory(directory: string, fsync: typeof fs.fsyncSync): void {
  const descriptor = fs.openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function rejectSymlink(target: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink())
      throw new OutcomeStoreError(
        'symlink_detected',
        `Symlink is not allowed: ${target}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertNoSymlinkComponents(target: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink())
        throw new OutcomeStoreError(
          'symlink_detected',
          `Symlink path component is not allowed: ${current}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function removeOwnedFile(file: string, inode: number | undefined): void {
  if (inode === undefined) return;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.ino === inode) fs.unlinkSync(file);
  } catch {
    // Best-effort cleanup of this operation's file only.
  }
}

function removeUnpublishedCandidate(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
