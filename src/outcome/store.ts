import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { ZodError } from 'zod';
import {
  canonicalDigest,
  computeOutcomeCheckpointFingerprint,
  computeOutcomeContractDigest,
  MAX_OUTCOME_RECORD_BYTES,
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
  type OutcomeManagerReviewSummary,
  type OutcomePendingOperation,
  type OutcomeRecord,
  OutcomeRecordSchema,
  OutcomeSessionIdSchema,
  type OutcomeUserMessageReceipt,
  parseOutcomeRecord,
  serializeOutcomeRecord,
} from './controller-schema';
import { getProcessEpoch } from './process-epoch';
import { type OutcomeReview, OutcomeReviewSchema } from './schema';

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
}

export type OutcomeRecordMutation =
  | { type: 'revise_contract'; contract: OutcomeContract }
  | { type: 'append_evidence'; entry: OutcomeEvidenceEntry }
  | { type: 'append_user_message'; receipt: OutcomeUserMessageReceipt }
  | { type: 'append_decision'; receipt: OutcomeDecisionReceipt }
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
      type: 'record_recovered_review';
      checkpointId: string;
      claimGeneration: number;
      resultDigest: string;
      review: OutcomeReview;
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
  | { type: 'append_action'; action: OutcomeActionRequired }
  | { type: 'resolve_action'; actionId: string }
  | { type: 'finalize'; summary: string };

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
  }

  get serverEpoch(): string {
    return this.#serverEpoch;
  }

  get storageRoot(): string {
    return this.#storeDirectory;
  }

  recordPath(rootSessionId: string): string {
    const session = validateSession(rootSessionId);
    return path.join(this.#storeDirectory, `${sessionHash(session)}.json`);
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
      const existing = this.read(session);
      if (existing.success) {
        return failure(
          new OutcomeStoreError(
            'already_exists',
            'Outcome record already exists',
            { rootSessionId: session },
          ),
        );
      }
      if (existing.code !== 'missing') return existing;
      const now = this.#clock();
      const contract = contractResult.data;
      const record: OutcomeRecord = {
        schema: OUTCOME_RECORD_SCHEMA,
        schemaVersion: OUTCOME_RECORD_VERSION,
        outcomeId:
          input.outcomeId ??
          `out_${sessionHash(session).slice(0, 16)}_${this.#randomId().slice(0, 8)}`,
        rootSessionId: session,
        serverEpoch: this.#serverEpoch,
        revision: 1,
        nextClaimGeneration: 1,
        contractDigest: computeOutcomeContractDigest(contract),
        createdAt: now,
        updatedAt: now,
        phase: 'active',
        contract,
        receipts: {
          evidence: [],
          userMessages: [],
          decisions: [],
          authorizations: [],
        },
        reviewSummaries: [],
        operations: [],
        actionsRequired: [],
      };
      return this.#persist(session, record, 'created');
    });
  }

  read(rootSessionId: string): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    try {
      this.#assertSafePath();
      const file = this.recordPath(session);
      const raw = readRegularFile(file, MAX_OUTCOME_RECORD_BYTES);
      const parsed = parseOutcomeRecord(JSON.parse(raw));
      if (parsed.rootSessionId !== session)
        throw new Error('Session identity mismatch');
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

  mutate(
    rootSessionId: string,
    expectedRevision: number,
    mutation: OutcomeRecordMutation,
  ): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    return this.#withLock(session, () => {
      const currentResult = this.read(session);
      if (!currentResult.success) return currentResult;
      const current = currentResult.data;
      if (current.serverEpoch !== this.#serverEpoch) {
        return failure(
          new OutcomeStoreError(
            'invalid_transition',
            'Recover prior-epoch outcome before mutation',
            { rootSessionId: session },
          ),
        );
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
        return this.#persist(session, next, 'written');
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

  recover(rootSessionId: string): OutcomeStoreResult<OutcomeRecord> {
    const session = safeSession(rootSessionId);
    if (session instanceof OutcomeStoreError) return failure(session);
    return this.#withLock(session, () => {
      const result = this.read(session);
      if (!result.success) return result;
      const current = result.data;
      if (current.serverEpoch === this.#serverEpoch) {
        return {
          success: true,
          data: current,
          revision: current.revision,
          status: 'noop',
        };
      }
      if (current.phase === 'accepted') {
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
              error:
                operation.error ?? 'Operation interrupted by process restart',
            }
          : operation,
      );
      let checkpoint = current.checkpoint
        ? { ...current.checkpoint }
        : undefined;
      const actionsRequired = [...current.actionsRequired];
      if (checkpoint && checkpoint.serverEpoch !== this.#serverEpoch) {
        if (checkpoint.state === 'claimed') {
          actionsRequired.push(
            action(
              `reclaim_${checkpoint.checkpointId}`,
              'stale_claim',
              checkpoint.checkpointId,
              'Prior-epoch undispatched checkpoint was cleared',
              now,
            ),
          );
          checkpoint = undefined;
        } else if (['dispatching', 'running'].includes(checkpoint.state)) {
          checkpoint = {
            ...checkpoint,
            state: 'review_uncertain',
            recoveryNote:
              'Manager dispatch crossed a process epoch and requires reconciliation',
          };
          actionsRequired.push(
            action(
              `uncertain_${checkpoint.checkpointId}`,
              'review_uncertain',
              checkpoint.checkpointId,
              'Prior-epoch Manager dispatch requires reconciliation',
              now,
            ),
          );
        }
      }
      for (const id of newlyInterrupted) {
        actionsRequired.push(
          action(
            `interrupted_${id}_${current.revision + 1}`,
            'interrupted_operation',
            id,
            `Operation ${id} was interrupted by process restart`,
            now,
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
      const recovered: OutcomeRecord = {
        ...current,
        serverEpoch: this.#serverEpoch,
        revision: current.revision + 1,
        updatedAt: now,
        phase: actionsRequired.some((item) => item.resolvedAt === undefined)
          ? 'action_required'
          : current.phase,
        checkpoint,
        operations,
        actionsRequired,
      };
      return this.#persist(session, recovered, 'recovered');
    });
  }

  #persist(
    session: string,
    record: OutcomeRecord,
    status: 'created' | 'written' | 'recovered',
  ): OutcomeStoreResult<OutcomeRecord> {
    try {
      const parsed = parseOutcomeRecord(OutcomeRecordSchema.parse(record));
      const serialized = serializeOutcomeRecord(parsed);
      this.#atomicReplace(this.recordPath(session), serialized);
      return { success: true, data: parsed, revision: parsed.revision, status };
    } catch (error) {
      return failure(this.#writeError(error, session));
    }
  }

  #withLock<T>(
    session: string,
    operation: () => OutcomeStoreResult<T>,
  ): OutcomeStoreResult<T> {
    let lock: LockCapability;
    try {
      lock = this.#acquireLock(session);
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
      return failure(
        new OutcomeStoreError(
          'io_error',
          error instanceof Error ? error.message : String(error),
          { rootSessionId: session, cause: error },
        ),
      );
    } finally {
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
      if (current.checkpoint && !isReviewed(current.checkpoint.state))
        throw new Error('Contract cannot change while a checkpoint exists');
      const contract = OutcomeContractSchema.parse(mutation.contract);
      next = {
        ...next,
        contract,
        contractDigest: computeOutcomeContractDigest(contract),
        phase: 'active',
      };
      delete next.checkpoint;
      break;
    }
    case 'append_evidence':
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
    case 'append_user_message':
      next.receipts.userMessages.push(mutation.receipt);
      break;
    case 'append_decision':
      next.receipts.decisions.push(mutation.receipt);
      break;
    case 'append_authorization':
      next.receipts.authorizations.push(mutation.receipt);
      break;
    case 'open_checkpoint': {
      if (current.checkpoint && !isReviewed(current.checkpoint.state))
        throw new Error('A checkpoint is already active');
      const claimGeneration = current.nextClaimGeneration;
      const checkpointId = `chk_${mutation.kind}_${randomId().slice(0, 16)}`;
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
    case 'record_review': {
      const claim = requireClaim(next, mutation);
      if (claim.state !== 'result_available')
        throw new Error('Review requires an available bound result');
      requireClaimToken(claim, mutation.claimToken);
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
        randomId,
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
      break;
    }
    case 'set_wait':
      if (!mutation.wait) throw new Error('Wait condition is required');
      next.waitCondition = mutation.wait;
      next.phase =
        mutation.wait.kind === 'user_decision'
          ? 'waiting_user'
          : 'waiting_external';
      break;
    case 'clear_wait':
      if (next.waitCondition?.referenceId !== mutation.referenceId)
        throw new Error('Wait reference mismatch');
      delete next.waitCondition;
      next.phase = 'active';
      break;
    case 'start_operation':
      if (
        mutation.operation.serverEpoch !== epoch ||
        mutation.operation.status !== 'running'
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
      next.operations[index] = {
        ...next.operations[index],
        status: 'acknowledged',
        updatedAt: now,
      };
      for (const action of next.actionsRequired) {
        if (
          action.code === 'interrupted_operation' &&
          action.referenceId === mutation.operationId &&
          action.resolvedAt === undefined
        ) {
          action.resolvedAt = now;
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
    case 'append_action':
      next.actionsRequired.push(mutation.action);
      next.phase = 'action_required';
      break;
    case 'resolve_action': {
      const index = next.actionsRequired.findIndex(
        (entry) =>
          entry.id === mutation.actionId && entry.resolvedAt === undefined,
      );
      if (index < 0) throw new Error('Action is not unresolved');
      next.actionsRequired[index] = {
        ...next.actionsRequired[index],
        resolvedAt: now,
      };
      if (!next.actionsRequired.some((entry) => entry.resolvedAt === undefined))
        next.phase = 'active';
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
  randomId: () => string,
): void {
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
    reviewDigest,
  };
  if (review.verdict === 'USER_DECISION_REQUIRED') {
    record.waitCondition = {
      kind: 'user_decision',
      referenceId: summary.reviewId,
      reason: review.userDecision?.decisionNeeded ?? review.summary,
      createdAt: evaluatedAt,
    };
  } else if (
    review.verdict === 'CORRECT_DRIFT' ||
    review.verdict === 'REVISE_CONTRACT'
  ) {
    record.actionsRequired.push(
      action(
        `action_${summary.reviewId}`,
        'manual_intervention',
        summary.reviewId,
        review.summary,
        evaluatedAt,
      ),
    );
  }
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
      ? { ...entry, resolvedAt }
      : entry,
  );
}

function derivePhase(record: OutcomeRecord): OutcomeRecord['phase'] {
  if (record.phase === 'accepted') return 'accepted';
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
    !record.reviewSummaries.some(
      (entry) =>
        entry.checkpointKind === 'kickoff' &&
        entry.contractDigest === record.contractDigest &&
        !['REVISE_CONTRACT', 'USER_DECISION_REQUIRED'].includes(entry.verdict),
    )
  ) {
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

function isReviewed(state: OutcomeCheckpointClaim['state']): boolean {
  return [
    'review_accepted',
    'review_rejected',
    'review_invalid',
    'retired',
  ].includes(state);
}

function action(
  id: string,
  code: OutcomeActionRequired['code'],
  referenceId: string,
  reason: string,
  createdAt: number,
): OutcomeActionRequired {
  return { id, code, referenceId, reason, createdAt };
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
