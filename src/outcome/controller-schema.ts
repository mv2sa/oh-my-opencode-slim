import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EvidenceFreshnessSchema,
  EvidenceStatusSchema,
  GoalStatusSchema,
  type OutcomeVerdict,
  OutcomeVerdictSchema,
  RuleEnforcementStatusSchema,
  RuleTypeSchema,
} from './schema';

export const OUTCOME_RECORD_SCHEMA = 'omos_outcome_record' as const;
export const OUTCOME_RECORD_VERSION = 2 as const;
export const MAX_OUTCOME_RECORD_BYTES = 100 * 1024;
export const MAX_OUTCOME_OPERATIONS = 32 as const;
export const MAX_OUTCOME_EVIDENCE = 64 as const;
export const MAX_OUTCOME_ACTIONS = 16 as const;

const Id = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:@-]+$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ShortText = z.string().trim().min(1).max(256);
const Text = z.string().trim().min(1).max(512);
const Summary = z.string().trim().min(1).max(1024);
const Timestamp = z.number().int().nonnegative();
const Revision = z.number().int().positive();

export const OutcomeSessionIdSchema = Id.refine(
  (value) => value !== '.' && !value.includes('..'),
  'Session ID contains a path traversal pattern',
);

export const OutcomePhaseSchema = z.enum([
  'active',
  'checkpointing',
  'reviewing',
  'waiting_user',
  'waiting_external',
  'action_required',
  'accepted',
  'failed',
  'corrupted',
]);
export type OutcomePhase = z.infer<typeof OutcomePhaseSchema>;

export const OutcomeCheckpointKindSchema = z.enum([
  'kickoff',
  'decision',
  'exception',
  'final',
]);
export type OutcomeCheckpointKind = z.infer<typeof OutcomeCheckpointKindSchema>;

export const OutcomeClaimStateSchema = z.enum([
  'claimed',
  'dispatching',
  'running',
  'result_available',
  'review_accepted',
  'review_rejected',
  'review_invalid',
  'review_uncertain',
  'retired',
]);
export type OutcomeClaimState = z.infer<typeof OutcomeClaimStateSchema>;

export const OutcomeGoalSchema = z
  .object({
    id: Id,
    description: Text,
    status: GoalStatusSchema,
    notes: Text.optional(),
  })
  .strict();
export type OutcomeGoal = z.infer<typeof OutcomeGoalSchema>;

export const OutcomeRuleSchema = z
  .object({
    id: Id,
    sourcePath: Text,
    category: Id,
    summary: Text,
    ruleType: RuleTypeSchema,
    enforcementStatus: RuleEnforcementStatusSchema,
    evidenceAttestationIds: z.array(Id).max(16),
    notes: Text.optional(),
  })
  .strict();
export type OutcomeRule = z.infer<typeof OutcomeRuleSchema>;

export const OutcomeExceptionSchema = z
  .object({
    ruleId: Id,
    justification: Text,
    scope: ShortText,
    authorizationId: Id,
  })
  .strict();
export type OutcomeException = z.infer<typeof OutcomeExceptionSchema>;

export const OutcomeContractSchema = z
  .object({
    classification: z.literal('non_trivial'),
    objective: Text,
    deliverables: z.array(Text).min(1).max(16),
    goals: z.array(OutcomeGoalSchema).min(1).max(32),
    inScope: z.array(ShortText).min(1).max(32),
    outOfScope: z.array(ShortText).max(32),
    constraints: z.array(Text).max(32),
    safetyBoundaries: z.array(Text).max(16),
    handoffRequirements: z.array(Text).min(1).max(16),
    sourceMessageIds: z.array(Id).min(1).max(32),
    rules: z.array(OutcomeRuleSchema).max(64),
    exceptions: z.array(OutcomeExceptionSchema).max(32),
  })
  .strict()
  .superRefine((contract, ctx) => {
    addDuplicateIssues(contract.goals, 'id', ['goals'], ctx);
    addDuplicateIssues(contract.rules, 'id', ['rules'], ctx);
    addDuplicateIssues(contract.exceptions, 'ruleId', ['exceptions'], ctx);
    addDuplicateStringIssues(
      contract.sourceMessageIds,
      ['sourceMessageIds'],
      ctx,
    );

    const rules = new Map(contract.rules.map((rule) => [rule.id, rule]));
    const exceptions = new Set(contract.exceptions.map((item) => item.ruleId));
    for (const [index, exception] of contract.exceptions.entries()) {
      const rule = rules.get(exception.ruleId);
      if (rule?.enforcementStatus !== 'waived') {
        issue(
          ctx,
          ['exceptions', index, 'ruleId'],
          'Exception must target a waived rule',
        );
      }
    }
    for (const [index, rule] of contract.rules.entries()) {
      if (rule.enforcementStatus === 'waived' && !exceptions.has(rule.id)) {
        issue(
          ctx,
          ['rules', index],
          'Waived rule requires exactly one exception',
        );
      }
    }
  });
export type OutcomeContract = z.infer<typeof OutcomeContractSchema>;

export const OutcomeToolObservationSchema = z
  .object({
    id: Id,
    kind: z.literal('controller_observed'),
    callId: Id,
    toolName: Id,
    argumentDigest: Digest,
    startedEpoch: Id,
    startedAt: Timestamp,
    completionObserved: z.boolean(),
    outputDigest: Digest.optional(),
    completedEpoch: Id.optional(),
    completedAt: Timestamp.optional(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const completionFields = [
      observation.outputDigest,
      observation.completedEpoch,
      observation.completedAt,
    ];
    if (observation.completionObserved) {
      if (completionFields.some((value) => value === undefined)) {
        issue(
          ctx,
          ['completionObserved'],
          'Completed observation requires output digest, epoch, and time',
        );
      }
      if (
        observation.completedAt !== undefined &&
        observation.completedAt < observation.startedAt
      ) {
        issue(ctx, ['completedAt'], 'Completion cannot precede start');
      }
      if (observation.completedEpoch !== observation.startedEpoch) {
        issue(
          ctx,
          ['completedEpoch'],
          'A generic completion must belong to its start epoch',
        );
      }
    } else if (completionFields.some((value) => value !== undefined)) {
      issue(
        ctx,
        ['completionObserved'],
        'Incomplete observation cannot carry completion fields',
      );
    }
  });
export type OutcomeToolObservation = z.infer<
  typeof OutcomeToolObservationSchema
>;

export const OutcomeEvidenceAttestationSchema = z
  .object({
    id: Id,
    kind: z.literal('orchestrator_attestation'),
    description: Text,
    assertedStatus: EvidenceStatusSchema,
    assertedFreshness: EvidenceFreshnessSchema,
    candidateFingerprint: Digest,
    linkedObservationId: Id.optional(),
    payloadDigest: Digest,
    createdRevision: Revision,
    createdAt: Timestamp,
  })
  .strict();
export type OutcomeEvidenceAttestation = z.infer<
  typeof OutcomeEvidenceAttestationSchema
>;

export const OutcomeEvidenceEntrySchema = z.discriminatedUnion('kind', [
  OutcomeToolObservationSchema,
  OutcomeEvidenceAttestationSchema,
]);
export type OutcomeEvidenceEntry = z.infer<typeof OutcomeEvidenceEntrySchema>;

export const OutcomeUserProvenanceSchema = z.enum([
  'external_user',
  'legacy_unverified',
]);
export type OutcomeUserProvenance = z.infer<typeof OutcomeUserProvenanceSchema>;

export const OutcomeUserMessageReceiptSchema = z
  .object({
    id: Id,
    messageId: Id,
    contentDigest: Digest,
    observedEpoch: Id,
    observedAt: Timestamp,
    createdRevision: Revision,
    provenance: OutcomeUserProvenanceSchema,
  })
  .strict();
export type OutcomeUserMessageReceipt = {
  id: string;
  messageId: string;
  contentDigest: string;
  observedEpoch: string;
  observedAt: number;
  createdRevision: number;
  provenance: OutcomeUserProvenance;
};

export const OutcomeDecisionReceiptSchema = z
  .object({
    id: Id,
    decisionNeeded: Text,
    options: z.array(ShortText).min(1).max(16),
    blocking: z.boolean(),
    impact: Text.optional(),
    createdAt: Timestamp,
    createdRevision: Revision,
    chosenOption: ShortText.optional(),
    sourceUserMessageReceiptId: Id.optional(),
    decidedAt: Timestamp.optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const resolved = decision.chosenOption !== undefined;
    if (
      resolved !== (decision.sourceUserMessageReceiptId !== undefined) ||
      resolved !== (decision.decidedAt !== undefined)
    ) {
      issue(
        ctx,
        ['chosenOption'],
        'Resolved decision requires source receipt and decidedAt',
      );
    }
    if (
      decision.chosenOption !== undefined &&
      !decision.options.includes(decision.chosenOption)
    ) {
      issue(
        ctx,
        ['chosenOption'],
        'Chosen option must be one of the offered options',
      );
    }
  });
export type OutcomeDecisionReceipt = z.infer<
  typeof OutcomeDecisionReceiptSchema
>;

export const OutcomeAuthorizationReceiptSchema = z
  .object({
    id: Id,
    kind: z.enum(['repository_waiver', 'user_decision']),
    reference: ShortText,
    payloadDigest: Digest,
    decisionId: Id.optional(),
    observedAt: Timestamp,
  })
  .strict()
  .superRefine((authorization, ctx) => {
    if (
      (authorization.kind === 'user_decision') !==
      (authorization.decisionId !== undefined)
    ) {
      issue(
        ctx,
        ['decisionId'],
        'User authorization requires a decision ID; repository waiver forbids it',
      );
    }
  });
export type OutcomeAuthorizationReceipt = z.infer<
  typeof OutcomeAuthorizationReceiptSchema
>;

export const OutcomeHandoffSupersessionReceiptSchema = z
  .object({
    id: Id,
    kind: z.literal('external_handoff_supersession'),
    waitReferenceId: Id,
    waitCreatedRevision: Revision,
    waitOriginatingServerEpoch: Id,
    waitRestartObservedRevision: Revision,
    waitInstructions: Text.optional(),
    expectedPostRestartCheck: Text,
    retiredCheckpointId: Id,
    retiredClaimGeneration: z.number().int().positive(),
    retiredDispatchCallId: Id,
    retiredManagerTaskId: Id,
    retiredManagerGeneration: z.number().int().positive(),
    retiredBoundResultDigest: Digest,
    observedChildResultDigest: Digest,
    retiredReasonDigest: Digest,
    sourceUserMessageReceiptId: Id,
    evidenceAttestationId: Id,
    replacementCandidateFingerprint: Digest,
    reason: Text,
    payloadDigest: Digest,
    supersededAt: Timestamp,
    supersededRevision: Revision,
    serverEpoch: Id,
  })
  .strict();
export type OutcomeHandoffSupersessionReceipt = z.infer<
  typeof OutcomeHandoffSupersessionReceiptSchema
>;

export const OutcomeReceiptsSchema = z
  .object({
    evidence: z.array(OutcomeEvidenceEntrySchema).max(64),
    userMessages: z.array(OutcomeUserMessageReceiptSchema).max(32),
    decisions: z.array(OutcomeDecisionReceiptSchema).max(32),
    authorizations: z.array(OutcomeAuthorizationReceiptSchema).max(32),
    handoffSupersessions: z
      .array(OutcomeHandoffSupersessionReceiptSchema)
      .max(16)
      .default([]),
  })
  .strict();
export type OutcomeReceipts = z.infer<typeof OutcomeReceiptsSchema>;

export const OutcomeManagerReviewSummarySchema = z
  .object({
    reviewId: Id,
    checkpointId: Id,
    claimGeneration: z.number().int().positive(),
    checkpointKind: OutcomeCheckpointKindSchema,
    contractDigest: Digest,
    outcomeRevision: Revision,
    verdict: OutcomeVerdictSchema,
    managerTaskId: Id,
    managerGeneration: z.number().int().positive(),
    resultDigest: Digest,
    reviewDigest: Digest,
    candidateFingerprint: Digest.optional(),
    summary: Summary,
    evaluatedAt: Timestamp,
  })
  .strict();
export type OutcomeManagerReviewSummary = z.infer<
  typeof OutcomeManagerReviewSummarySchema
>;

export const OutcomeCheckpointClaimSchema = z
  .object({
    outcomeId: Id,
    rootSessionId: OutcomeSessionIdSchema,
    checkpointId: Id,
    kind: OutcomeCheckpointKindSchema,
    reason: Text,
    claimGeneration: z.number().int().positive(),
    claimTokenDigest: Digest,
    checkpointFingerprint: Digest,
    contractDigest: Digest,
    outcomeRevision: Revision,
    serverEpoch: Id,
    claimedAt: Timestamp,
    expiresAt: Timestamp,
    candidateFingerprint: Digest.optional(),
    includedDecisionIds: z.array(Id).max(32),
    includedExceptionRuleIds: z.array(Id).max(32),
    includedEvidenceAttestationIds: z.array(Id).max(64),
    state: OutcomeClaimStateSchema,
    dispatchCallId: Id.optional(),
    managerTaskId: Id.optional(),
    managerGeneration: z.number().int().positive().optional(),
    resultDigest: Digest.optional(),
    reviewDigest: Digest.optional(),
    recoveryNote: Text.optional(),
  })
  .strict()
  .superRefine((claim, ctx) => {
    addDuplicateStringIssues(
      claim.includedDecisionIds,
      ['includedDecisionIds'],
      ctx,
    );
    addDuplicateStringIssues(
      claim.includedExceptionRuleIds,
      ['includedExceptionRuleIds'],
      ctx,
    );
    addDuplicateStringIssues(
      claim.includedEvidenceAttestationIds,
      ['includedEvidenceAttestationIds'],
      ctx,
    );
    if (claim.expiresAt < claim.claimedAt)
      issue(ctx, ['expiresAt'], 'Expiry cannot precede claim');
    if (claim.kind === 'final' && !claim.candidateFingerprint) {
      issue(
        ctx,
        ['candidateFingerprint'],
        'Final checkpoint requires candidate fingerprint',
      );
    }

    const hasManager = claim.managerTaskId !== undefined;
    if (hasManager !== (claim.managerGeneration !== undefined)) {
      issue(
        ctx,
        ['managerTaskId'],
        'Manager task ID and generation must appear together',
      );
    }
    if (claim.state === 'claimed') {
      if (
        claim.dispatchCallId ||
        hasManager ||
        claim.resultDigest ||
        claim.reviewDigest
      ) {
        issue(
          ctx,
          ['state'],
          'Claimed checkpoint cannot contain dispatch or result fields',
        );
      }
    } else if (claim.state === 'dispatching') {
      if (
        !claim.dispatchCallId ||
        hasManager ||
        claim.resultDigest ||
        claim.reviewDigest
      ) {
        issue(
          ctx,
          ['state'],
          'Dispatching checkpoint requires only dispatchCallId',
        );
      }
    } else if (claim.state === 'review_uncertain') {
      if (!claim.dispatchCallId || !claim.recoveryNote) {
        issue(
          ctx,
          ['state'],
          'Uncertain checkpoint requires dispatch identity and recovery note',
        );
      }
    } else if (claim.state === 'retired') {
      if (!claim.recoveryNote) {
        issue(
          ctx,
          ['recoveryNote'],
          'Retired checkpoint requires a recovery note',
        );
      }
    } else {
      if (!claim.dispatchCallId || !hasManager) {
        issue(
          ctx,
          ['state'],
          'Post-dispatch checkpoint requires dispatch and Manager identity',
        );
      }
      if (claim.state === 'result_available' && !claim.resultDigest) {
        issue(ctx, ['resultDigest'], 'Available result requires result digest');
      }
      if (
        ['review_accepted', 'review_rejected', 'review_invalid'].includes(
          claim.state,
        ) &&
        !claim.reviewDigest
      ) {
        issue(
          ctx,
          ['reviewDigest'],
          'Reviewed checkpoint requires review digest',
        );
      }
    }
  });
export type OutcomeCheckpointClaim = z.infer<
  typeof OutcomeCheckpointClaimSchema
>;

export const OutcomePendingOperationSchema = z
  .object({
    id: Id,
    callId: Id,
    toolName: Id,
    argumentDigest: Digest,
    serverEpoch: Id,
    status: z.enum([
      'running',
      'completed',
      'failed',
      'interrupted',
      'acknowledged',
    ]),
    startedAt: Timestamp,
    updatedAt: Timestamp,
    error: Text.optional(),
  })
  .strict()
  .refine((operation) => operation.updatedAt >= operation.startedAt, {
    message: 'Operation update cannot precede start',
    path: ['updatedAt'],
  });
export type OutcomePendingOperation = z.infer<
  typeof OutcomePendingOperationSchema
>;

export const OutcomeWaitConditionSchema = z
  .object({
    kind: z.enum([
      'user_decision',
      'external_handoff',
      'subagent_run',
      'evidence_collection',
    ]),
    referenceId: Id,
    reason: Text,
    createdAt: Timestamp,
    createdRevision: Revision,
    originatingServerEpoch: Id.optional(),
    restartObservedRevision: Revision.optional(),
    instructions: Text.optional(),
    expectedPostRestartCheck: Text.optional(),
  })
  .strict()
  .superRefine((wait, ctx) => {
    if (
      (wait.kind === 'external_handoff') !==
      (wait.originatingServerEpoch !== undefined)
    ) {
      issue(
        ctx,
        ['originatingServerEpoch'],
        'External handoff requires its originating server epoch; other waits forbid it',
      );
    }
    if (
      wait.kind !== 'external_handoff' &&
      wait.restartObservedRevision !== undefined
    ) {
      issue(
        ctx,
        ['restartObservedRevision'],
        'Only an external handoff can record a restart observation',
      );
    }
    if (
      wait.restartObservedRevision !== undefined &&
      wait.restartObservedRevision <= wait.createdRevision
    ) {
      issue(
        ctx,
        ['restartObservedRevision'],
        'Restart observation must follow handoff creation',
      );
    }
  });
export type OutcomeWaitCondition = z.infer<typeof OutcomeWaitConditionSchema>;

export const OutcomeActionRequiredSchema = z
  .object({
    id: Id,
    code: z.enum([
      'stale_claim',
      'interrupted_operation',
      'review_uncertain',
      'corrupt_state',
      'manual_intervention',
    ]),
    referenceId: Id,
    reason: Text,
    createdAt: Timestamp,
    createdRevision: Revision,
    resolvedAt: Timestamp.optional(),
    resolutionKind: z
      .enum(['controller_reconciliation', 'orchestrator_provenance'])
      .optional(),
    resolutionReason: Text.optional(),
    resolutionUserMessageReceiptId: Id.optional(),
    resolutionEvidenceAttestationIds: z.array(Id).max(16).optional(),
    resolutionEvidenceAssurance: z
      .literal('orchestrator_attestation')
      .optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const resolutionFields = [
      action.resolutionKind,
      action.resolutionReason,
      action.resolutionUserMessageReceiptId,
      action.resolutionEvidenceAttestationIds,
      action.resolutionEvidenceAssurance,
    ];
    if (action.resolvedAt === undefined) {
      if (resolutionFields.some((value) => value !== undefined)) {
        issue(
          ctx,
          ['resolvedAt'],
          'Unresolved action cannot carry resolution provenance',
        );
      }
      return;
    }
    if (action.resolvedAt < action.createdAt) {
      issue(ctx, ['resolvedAt'], 'Action resolution cannot precede creation');
    }
    if (!action.resolutionReason) {
      issue(ctx, ['resolutionReason'], 'Resolved action requires a reason');
    }
    if (
      action.resolutionKind === 'orchestrator_provenance' &&
      !action.resolutionUserMessageReceiptId &&
      (action.resolutionEvidenceAttestationIds?.length ?? 0) === 0
    ) {
      issue(
        ctx,
        ['resolvedAt'],
        'Resolved action requires user or evidence provenance',
      );
    }
    const evidenceCount = action.resolutionEvidenceAttestationIds?.length ?? 0;
    if (
      evidenceCount > 0 !==
      (action.resolutionEvidenceAssurance === 'orchestrator_attestation')
    ) {
      issue(
        ctx,
        ['resolutionEvidenceAssurance'],
        'Evidence-backed action resolution requires explicit orchestrator-attestation assurance',
      );
    }
    if (action.resolutionEvidenceAttestationIds) {
      addDuplicateStringIssues(
        action.resolutionEvidenceAttestationIds,
        ['resolutionEvidenceAttestationIds'],
        ctx,
      );
    }
    if (!action.resolutionKind) {
      issue(
        ctx,
        ['resolutionKind'],
        'Resolved action requires a provenance kind',
      );
    }
  });
export type OutcomeActionRequired = z.infer<typeof OutcomeActionRequiredSchema>;

export const OutcomeEvidenceAssuranceSchema = z.enum([
  'orchestrator_attestation',
  'mixed',
  'controller_verified',
]);

export const OutcomeFinalCertificateSchema = z
  .object({
    outcomeId: Id,
    acceptedRevision: Revision,
    contractDigest: Digest,
    candidateFingerprint: Digest,
    acceptedCheckpointId: Id,
    acceptedClaimGeneration: z.number().int().positive(),
    finalCheckpointFingerprint: Digest,
    managerTaskId: Id,
    managerGeneration: z.number().int().positive(),
    managerReviewId: Id,
    managerReviewDigest: Digest,
    receiptDigests: z.array(Digest).max(64),
    evidenceAssurance: OutcomeEvidenceAssuranceSchema,
    acceptedAt: Timestamp,
    serverEpoch: Id,
    summary: Summary,
  })
  .strict();
export type OutcomeFinalCertificate = z.infer<
  typeof OutcomeFinalCertificateSchema
>;

export const OutcomeKickoffGateStateSchema = z.enum([
  'required',
  'authenticated',
  'exhausted',
  'legacy_late_missing',
  'legacy_certified',
]);
export type OutcomeKickoffGateState = z.infer<
  typeof OutcomeKickoffGateStateSchema
>;

export const OutcomeKickoffGateSchema = z
  .object({
    policyVersion: z.literal(1),
    state: OutcomeKickoffGateStateSchema,
    contractDigest: Digest,
    attempts: z.number().int().nonnegative().max(2),
    maxAttempts: z.literal(2),
    authenticatedReviewId: Id.optional(),
    lastCheckpointId: Id.optional(),
    failureReason: Text.optional(),
  })
  .strict();
export type OutcomeKickoffGate = z.infer<typeof OutcomeKickoffGateSchema>;

export const OutcomeResolvedActionArchiveSchema = z
  .object({
    count: z.number().int().nonnegative(),
    chainDigest: Digest,
  })
  .strict();
export type OutcomeResolvedActionArchive = z.infer<
  typeof OutcomeResolvedActionArchiveSchema
>;

export function initialActionArchiveChainDigest(): string {
  return canonicalDigest('omos/action-archive/v1', {
    count: 0,
    genesis: true,
  });
}

export function computeActionArchiveChainDigest(
  previousChainDigest: string,
  count: number,
  action: OutcomeActionRequired,
): string {
  return canonicalDigest('omos/action-archive/v1', {
    previousChainDigest,
    count,
    action: {
      id: action.id,
      code: action.code,
      referenceId: action.referenceId,
      reason: action.reason,
      createdAt: action.createdAt,
      createdRevision: action.createdRevision,
      resolvedAt: action.resolvedAt,
      resolutionKind: action.resolutionKind,
      resolutionReason: action.resolutionReason,
      resolutionUserMessageReceiptId: action.resolutionUserMessageReceiptId,
      resolutionEvidenceAttestationIds: action.resolutionEvidenceAttestationIds,
      resolutionEvidenceAssurance: action.resolutionEvidenceAssurance,
    },
  });
}

const OutcomeUserMessageReceiptV1Schema = z
  .object({
    id: Id,
    messageId: Id,
    contentDigest: Digest,
    observedEpoch: Id,
    observedAt: Timestamp,
    createdRevision: Revision,
  })
  .strict();

const OutcomeReceiptsV1Schema = z
  .object({
    evidence: z.array(OutcomeEvidenceEntrySchema).max(64),
    userMessages: z.array(OutcomeUserMessageReceiptV1Schema).max(32),
    decisions: z.array(OutcomeDecisionReceiptSchema).max(32),
    authorizations: z.array(OutcomeAuthorizationReceiptSchema).max(32),
  })
  .strict();

const OutcomeRecordV1BaseSchema = z
  .object({
    schema: z.literal(OUTCOME_RECORD_SCHEMA),
    schemaVersion: z.literal(1),
    outcomeId: Id,
    rootSessionId: OutcomeSessionIdSchema,
    serverEpoch: Id,
    revision: Revision,
    nextClaimGeneration: Revision,
    contractDigest: Digest,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    phase: OutcomePhaseSchema,
    contract: OutcomeContractSchema,
    receipts: OutcomeReceiptsV1Schema,
    reviewSummaries: z.array(OutcomeManagerReviewSummarySchema).max(32),
    checkpoint: OutcomeCheckpointClaimSchema.optional(),
    waitCondition: OutcomeWaitConditionSchema.optional(),
    operations: z.array(OutcomePendingOperationSchema).max(32),
    actionsRequired: z.array(OutcomeActionRequiredSchema).max(16),
    finalCertificate: OutcomeFinalCertificateSchema.optional(),
  })
  .strict();

export const OutcomeRecordV1Schema = OutcomeRecordV1BaseSchema.superRefine(
  (record, ctx) => validateRecordRelationsV1(record, ctx),
);
export type OutcomeRecordV1 = z.infer<typeof OutcomeRecordV1Schema>;

const OutcomeRecordBaseSchema = z
  .object({
    schema: z.literal(OUTCOME_RECORD_SCHEMA),
    schemaVersion: z.literal(OUTCOME_RECORD_VERSION),
    outcomeId: Id,
    rootSessionId: OutcomeSessionIdSchema,
    serverEpoch: Id,
    revision: Revision,
    nextClaimGeneration: Revision,
    contractDigest: Digest,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    phase: OutcomePhaseSchema,
    contract: OutcomeContractSchema,
    kickoffGate: OutcomeKickoffGateSchema,
    resolvedActionArchive: OutcomeResolvedActionArchiveSchema,
    receipts: OutcomeReceiptsSchema,
    reviewSummaries: z.array(OutcomeManagerReviewSummarySchema).max(32),
    checkpoint: OutcomeCheckpointClaimSchema.optional(),
    waitCondition: OutcomeWaitConditionSchema.optional(),
    operations: z.array(OutcomePendingOperationSchema).max(32),
    actionsRequired: z.array(OutcomeActionRequiredSchema).max(16),
    finalCertificate: OutcomeFinalCertificateSchema.optional(),
  })
  .strict();

type OutcomeRecordBase = z.infer<typeof OutcomeRecordBaseSchema>;

export const OutcomeRecordSchema = OutcomeRecordBaseSchema.superRefine(
  (record, ctx) => validateRecordRelations(record, ctx),
);
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

export function canonicalDigest(domain: string, value: unknown): string {
  const jsonCompatible = JSON.parse(JSON.stringify(value)) as unknown;
  return `sha256:${createHash('sha256')
    .update(`${domain}\0${stableJson(jsonCompatible)}`, 'utf8')
    .digest('hex')}`;
}

export function computeOutcomeContractDigest(
  contract: OutcomeContract,
): string {
  const parsed = OutcomeContractSchema.parse(contract);
  return canonicalDigest('omos/outcome-contract/v1', {
    ...parsed,
    goals: parsed.goals.map(({ status: _status, ...goal }) => goal),
  });
}

export function computeOutcomeEvidenceAttestationDigest(
  attestation: Pick<
    OutcomeEvidenceAttestation,
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
    id: attestation.id,
    description: attestation.description,
    assertedStatus: attestation.assertedStatus,
    assertedFreshness: attestation.assertedFreshness,
    candidateFingerprint: attestation.candidateFingerprint,
    linkedObservationId: attestation.linkedObservationId,
    createdAt: attestation.createdAt,
  });
}

export function computeOutcomeAuthorizationDigest(
  authorization: Pick<
    OutcomeAuthorizationReceipt,
    'id' | 'kind' | 'reference' | 'decisionId' | 'observedAt'
  >,
): string {
  return canonicalDigest('omos/outcome-authorization/v1', {
    id: authorization.id,
    kind: authorization.kind,
    reference: authorization.reference,
    decisionId: authorization.decisionId,
    observedAt: authorization.observedAt,
  });
}

export function computeOutcomeHandoffSupersessionDigest(input: {
  id: string;
  kind: 'external_handoff_supersession';
  waitReferenceId: string;
  waitCreatedRevision: number;
  waitOriginatingServerEpoch: string;
  waitRestartObservedRevision: number;
  waitInstructions?: string;
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
  reason: string;
  supersededAt: number;
  supersededRevision: number;
  serverEpoch: string;
}): string {
  return canonicalDigest('omos/external-handoff-supersession/v1', {
    id: input.id,
    kind: input.kind,
    waitReferenceId: input.waitReferenceId,
    waitCreatedRevision: input.waitCreatedRevision,
    waitOriginatingServerEpoch: input.waitOriginatingServerEpoch,
    waitRestartObservedRevision: input.waitRestartObservedRevision,
    waitInstructions: input.waitInstructions,
    expectedPostRestartCheck: input.expectedPostRestartCheck,
    retiredCheckpointId: input.retiredCheckpointId,
    retiredClaimGeneration: input.retiredClaimGeneration,
    retiredDispatchCallId: input.retiredDispatchCallId,
    retiredManagerTaskId: input.retiredManagerTaskId,
    retiredManagerGeneration: input.retiredManagerGeneration,
    retiredBoundResultDigest: input.retiredBoundResultDigest,
    observedChildResultDigest: input.observedChildResultDigest,
    retiredReasonDigest: input.retiredReasonDigest,
    sourceUserMessageReceiptId: input.sourceUserMessageReceiptId,
    evidenceAttestationId: input.evidenceAttestationId,
    replacementCandidateFingerprint: input.replacementCandidateFingerprint,
    reason: input.reason.trim(),
    supersededAt: input.supersededAt,
    supersededRevision: input.supersededRevision,
    serverEpoch: input.serverEpoch,
  });
}

export function computeOutcomeCheckpointFingerprint(
  claim: Pick<
    OutcomeCheckpointClaim,
    | 'outcomeId'
    | 'rootSessionId'
    | 'checkpointId'
    | 'kind'
    | 'reason'
    | 'claimGeneration'
    | 'claimTokenDigest'
    | 'contractDigest'
    | 'outcomeRevision'
    | 'serverEpoch'
    | 'claimedAt'
    | 'expiresAt'
    | 'candidateFingerprint'
    | 'includedDecisionIds'
    | 'includedExceptionRuleIds'
    | 'includedEvidenceAttestationIds'
  >,
): string {
  return canonicalDigest('omos/outcome-checkpoint/v1', {
    outcomeId: claim.outcomeId,
    rootSessionId: claim.rootSessionId,
    checkpointId: claim.checkpointId,
    kind: claim.kind,
    reason: claim.reason,
    claimGeneration: claim.claimGeneration,
    claimTokenDigest: claim.claimTokenDigest,
    contractDigest: claim.contractDigest,
    outcomeRevision: claim.outcomeRevision,
    serverEpoch: claim.serverEpoch,
    claimedAt: claim.claimedAt,
    expiresAt: claim.expiresAt,
    ...(claim.candidateFingerprint
      ? { candidateFingerprint: claim.candidateFingerprint }
      : {}),
    includedDecisionIds: claim.includedDecisionIds,
    includedExceptionRuleIds: claim.includedExceptionRuleIds,
    includedEvidenceAttestationIds: claim.includedEvidenceAttestationIds,
  });
}

export function parseOutcomeRecord(value: unknown): OutcomeRecord {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    const v1 = OutcomeRecordV1Schema.parse(value);
    return normalizeRecordV1ToV2(v1);
  }
  const record = OutcomeRecordSchema.parse(value);
  if (record.contractDigest !== computeOutcomeContractDigest(record.contract)) {
    throw new Error('Outcome record contract digest mismatch');
  }
  return record;
}

export function validateVerdictForCheckpointKind(
  kind: OutcomeCheckpointKind,
  verdict?: OutcomeVerdict,
): void {
  if (verdict === 'ACCEPT' && kind !== 'final') {
    throw new Error('ACCEPT verdict is valid only for final checkpoint');
  }
}

export function normalizeRecordV1ToV2(v1: OutcomeRecordV1): OutcomeRecord {
  const userMessagesByHostId = new Map<string, OutcomeUserMessageReceipt>();
  const canonicalUserReceiptIds = new Map<string, string>();
  for (const message of v1.receipts.userMessages) {
    const messageId = message.messageId.trim();
    const existing = userMessagesByHostId.get(messageId);
    if (existing) {
      if (existing.contentDigest !== message.contentDigest) {
        throw new Error(
          `Legacy user message '${messageId}' has conflicting content`,
        );
      }
      canonicalUserReceiptIds.set(message.id, existing.id);
      continue;
    }
    const normalized: OutcomeUserMessageReceipt = {
      ...message,
      messageId,
      provenance: 'legacy_unverified',
    };
    userMessagesByHostId.set(messageId, normalized);
    canonicalUserReceiptIds.set(message.id, normalized.id);
  }
  const userMessages = [...userMessagesByHostId.values()];
  const decisions = v1.receipts.decisions.map((decision) => ({
    ...decision,
    ...(decision.sourceUserMessageReceiptId
      ? {
          sourceUserMessageReceiptId:
            canonicalUserReceiptIds.get(decision.sourceUserMessageReceiptId) ??
            decision.sourceUserMessageReceiptId,
        }
      : {}),
  }));
  const actionsRequired = v1.actionsRequired.map((action) => ({
    ...action,
    ...(action.resolutionUserMessageReceiptId
      ? {
          resolutionUserMessageReceiptId:
            canonicalUserReceiptIds.get(
              action.resolutionUserMessageReceiptId,
            ) ?? action.resolutionUserMessageReceiptId,
        }
      : {}),
  }));

  let kickoffGate: OutcomeKickoffGate;
  const qualifyingKickoff = v1.reviewSummaries.find(
    (entry) =>
      entry.checkpointKind === 'kickoff' &&
      entry.contractDigest === v1.contractDigest &&
      entry.verdict === 'CONTINUE',
  );

  let checkpoint = v1.checkpoint;
  let phase = v1.phase;

  if (qualifyingKickoff) {
    kickoffGate = {
      policyVersion: 1,
      state: 'authenticated',
      contractDigest: v1.contractDigest,
      attempts: 1,
      maxAttempts: 2,
      authenticatedReviewId: qualifyingKickoff.reviewId,
      lastCheckpointId: qualifyingKickoff.checkpointId,
    };
  } else if (v1.phase === 'accepted' && v1.finalCertificate) {
    kickoffGate = {
      policyVersion: 1,
      state: 'legacy_certified',
      contractDigest: v1.contractDigest,
      attempts: 0,
      maxAttempts: 2,
      failureReason:
        'Previously certified under the V1 policy without a V2 kickoff CONTINUE',
    };
  } else {
    const hasLaterReviewOrCheckpoint =
      v1.reviewSummaries.length > 0 ||
      (v1.checkpoint !== undefined && v1.checkpoint.kind !== 'kickoff');

    if (hasLaterReviewOrCheckpoint) {
      kickoffGate = {
        policyVersion: 1,
        state: 'legacy_late_missing',
        contractDigest: v1.contractDigest,
        attempts: 0,
        maxAttempts: 2,
        failureReason:
          'Historical record has review activity without an authenticated kickoff review',
      };
      if (
        checkpoint &&
        checkpoint.kind === 'kickoff' &&
        checkpoint.state !== 'retired'
      ) {
        checkpoint = {
          ...checkpoint,
          state: 'retired',
          recoveryNote:
            'Retrospective kickoff retired on legacy_late_missing record',
        };
      }
      if (phase !== 'accepted') {
        phase = 'failed';
      }
    } else {
      kickoffGate = {
        policyVersion: 1,
        state: 'required',
        contractDigest: v1.contractDigest,
        attempts: v1.checkpoint?.kind === 'kickoff' ? 1 : 0,
        maxAttempts: 2,
        lastCheckpointId:
          v1.checkpoint?.kind === 'kickoff'
            ? v1.checkpoint.checkpointId
            : undefined,
      };
    }
  }

  const v2: OutcomeRecordBase = {
    schema: OUTCOME_RECORD_SCHEMA,
    schemaVersion: 2,
    outcomeId: v1.outcomeId,
    rootSessionId: v1.rootSessionId,
    serverEpoch: v1.serverEpoch,
    revision: v1.revision,
    nextClaimGeneration: v1.nextClaimGeneration,
    contractDigest: v1.contractDigest,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    phase,
    contract: v1.contract,
    kickoffGate,
    resolvedActionArchive: {
      count: 0,
      chainDigest: initialActionArchiveChainDigest(),
    },
    receipts: {
      ...v1.receipts,
      userMessages,
      decisions,
      handoffSupersessions: [],
    },
    reviewSummaries: v1.reviewSummaries,
    checkpoint,
    waitCondition: v1.waitCondition,
    operations: v1.operations,
    actionsRequired,
    finalCertificate: v1.finalCertificate,
  };

  return OutcomeRecordSchema.parse(v2);
}

export function serializeOutcomeRecord(record: OutcomeRecord): string {
  const parsed = parseOutcomeRecord(record);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTCOME_RECORD_BYTES) {
    throw new Error(`Outcome record exceeds ${MAX_OUTCOME_RECORD_BYTES} bytes`);
  }
  return serialized;
}

function validateRecordRelations(
  record: OutcomeRecordBase,
  ctx: z.RefinementCtx,
): void {
  if (record.contractDigest !== computeOutcomeContractDigest(record.contract)) {
    issue(
      ctx,
      ['contractDigest'],
      'Contract digest does not match canonical contract',
    );
  }
  if (record.updatedAt < record.createdAt)
    issue(ctx, ['updatedAt'], 'Update cannot precede creation');

  addDuplicateIssues(
    record.receipts.evidence,
    'id',
    ['receipts', 'evidence'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.userMessages,
    'id',
    ['receipts', 'userMessages'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.userMessages,
    'messageId',
    ['receipts', 'userMessages'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.decisions,
    'id',
    ['receipts', 'decisions'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.authorizations,
    'id',
    ['receipts', 'authorizations'],
    ctx,
  );
  addDuplicateIssues(
    record.reviewSummaries,
    'reviewId',
    ['reviewSummaries'],
    ctx,
  );
  const reviewedClaims = new Set<string>();
  for (const [index, summary] of record.reviewSummaries.entries()) {
    if (summary.verdict === 'ACCEPT' && summary.checkpointKind !== 'final') {
      issue(
        ctx,
        ['reviewSummaries', index, 'verdict'],
        'ACCEPT verdict is valid only for final checkpoint review summaries',
      );
    }
    const identity = `${summary.checkpointId}:${summary.claimGeneration}`;
    if (reviewedClaims.has(identity)) {
      issue(
        ctx,
        ['reviewSummaries', index],
        'Duplicate review summary for checkpoint claim',
      );
    }
    reviewedClaims.add(identity);
  }
  addDuplicateIssues(record.operations, 'id', ['operations'], ctx);
  addDuplicateIssues(record.operations, 'callId', ['operations'], ctx);
  addDuplicateIssues(record.actionsRequired, 'id', ['actionsRequired'], ctx);

  const observations = new Set(
    record.receipts.evidence
      .filter((entry) => entry.kind === 'controller_observed')
      .map((entry) => entry.id),
  );
  const operationsByCallId = new Map(
    record.operations.map((operation) => [operation.callId, operation]),
  );
  const observationsByCallId = new Map<string, OutcomeToolObservation>();
  for (const [index, entry] of record.receipts.evidence.entries()) {
    if (entry.kind !== 'controller_observed') continue;
    if (observationsByCallId.has(entry.callId)) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'callId'],
        'Duplicate controller observation callId',
      );
    }
    observationsByCallId.set(entry.callId, entry);
    const operation = operationsByCallId.get(entry.callId);
    if (
      operation &&
      (operation.toolName !== entry.toolName ||
        operation.argumentDigest !== entry.argumentDigest ||
        operation.serverEpoch !== entry.startedEpoch)
    ) {
      issue(
        ctx,
        ['receipts', 'evidence', index],
        'Controller observation does not match its operation identity',
      );
    }
  }
  const attestations = new Map(
    record.receipts.evidence
      .filter((entry) => entry.kind === 'orchestrator_attestation')
      .map((entry) => [entry.id, entry]),
  );
  for (const [index, entry] of record.receipts.evidence.entries()) {
    if (entry.kind !== 'orchestrator_attestation') continue;
    if (
      entry.payloadDigest !== computeOutcomeEvidenceAttestationDigest(entry)
    ) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'payloadDigest'],
        'Attestation digest does not match its minted fields',
      );
    }
    if (entry.createdRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'createdRevision'],
        'Attestation revision is in the future',
      );
    }
    if (
      entry.linkedObservationId &&
      !observations.has(entry.linkedObservationId)
    ) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'linkedObservationId'],
        'Attestation references missing observation',
      );
    }
  }

  const decisions = new Map(
    record.receipts.decisions.map((entry) => [entry.id, entry]),
  );
  const userMessages = new Map(
    record.receipts.userMessages.map((entry) => [entry.id, entry]),
  );
  for (const [index, receipt] of record.receipts.userMessages.entries()) {
    if (receipt.createdRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'userMessages', index, 'createdRevision'],
        'User receipt revision is in the future',
      );
    }
  }
  for (const [index, decision] of record.receipts.decisions.entries()) {
    if (decision.createdRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'decisions', index, 'createdRevision'],
        'Decision revision is in the future',
      );
    }
    if (
      decision.sourceUserMessageReceiptId &&
      !userMessages.has(decision.sourceUserMessageReceiptId)
    ) {
      issue(
        ctx,
        ['receipts', 'decisions', index, 'sourceUserMessageReceiptId'],
        'Decision references missing user message',
      );
    }
  }
  const authorizations = new Map(
    record.receipts.authorizations.map((entry) => [entry.id, entry]),
  );
  for (const [index, action] of record.actionsRequired.entries()) {
    if (action.createdRevision > record.revision) {
      issue(
        ctx,
        ['actionsRequired', index, 'createdRevision'],
        'Action revision is in the future',
      );
    }
    if (
      action.createdRevision === record.revision &&
      action.resolvedAt !== undefined
    ) {
      issue(
        ctx,
        ['actionsRequired', index, 'createdRevision'],
        'Resolved action provenance must be persisted in a later revision',
      );
    }
    if (
      action.resolutionUserMessageReceiptId &&
      !userMessages.has(action.resolutionUserMessageReceiptId)
    ) {
      issue(
        ctx,
        ['actionsRequired', index, 'resolutionUserMessageReceiptId'],
        'Action resolution references missing user receipt',
      );
    }
    const resolutionUserReceipt = action.resolutionUserMessageReceiptId
      ? userMessages.get(action.resolutionUserMessageReceiptId)
      : undefined;
    if (
      resolutionUserReceipt &&
      resolutionUserReceipt.createdRevision <= action.createdRevision
    ) {
      issue(
        ctx,
        ['actionsRequired', index, 'resolutionUserMessageReceiptId'],
        'Action resolution user receipt must be minted after the action',
      );
    }
    for (const evidenceId of action.resolutionEvidenceAttestationIds ?? []) {
      const attestation = attestations.get(evidenceId);
      if (!attestation) {
        issue(
          ctx,
          ['actionsRequired', index, 'resolutionEvidenceAttestationIds'],
          'Action resolution references missing evidence attestation',
        );
      } else if (
        attestation.createdRevision <= action.createdRevision ||
        attestation.assertedStatus !== 'passed' ||
        attestation.assertedFreshness !== 'fresh'
      ) {
        issue(
          ctx,
          ['actionsRequired', index, 'resolutionEvidenceAttestationIds'],
          'Action resolution evidence must be a fresh passed attestation minted after the action',
        );
      }
    }
  }
  for (const [
    index,
    authorization,
  ] of record.receipts.authorizations.entries()) {
    if (
      authorization.payloadDigest !==
      computeOutcomeAuthorizationDigest(authorization)
    ) {
      issue(
        ctx,
        ['receipts', 'authorizations', index, 'payloadDigest'],
        'Authorization digest does not match its minted fields',
      );
    }
    if (authorization.decisionId) {
      const decision = decisions.get(authorization.decisionId);
      if (!decision?.chosenOption || !decision.sourceUserMessageReceiptId) {
        issue(
          ctx,
          ['receipts', 'authorizations', index, 'decisionId'],
          'User authorization requires a resolved, user-backed decision',
        );
      }
      if (decision && authorization.reference !== decision.id) {
        issue(
          ctx,
          ['receipts', 'authorizations', index, 'reference'],
          'User authorization reference must equal its decision ID',
        );
      }
      if (
        decision?.decidedAt !== undefined &&
        authorization.observedAt < decision.decidedAt
      ) {
        issue(
          ctx,
          ['receipts', 'authorizations', index, 'observedAt'],
          'User authorization cannot precede its decision',
        );
      }
    }
  }
  const rules = new Map(
    record.contract.rules.map((entry) => [entry.id, entry]),
  );
  for (const [index, rule] of record.contract.rules.entries()) {
    addDuplicateStringIssues(
      rule.evidenceAttestationIds,
      ['contract', 'rules', index, 'evidenceAttestationIds'],
      ctx,
    );
    for (const id of rule.evidenceAttestationIds) {
      if (!attestations.has(id))
        issue(
          ctx,
          ['contract', 'rules', index],
          'Rule references missing attestation',
        );
    }
  }
  for (const [index, exception] of record.contract.exceptions.entries()) {
    const authorization = authorizations.get(exception.authorizationId);
    if (!authorization)
      issue(
        ctx,
        ['contract', 'exceptions', index, 'authorizationId'],
        'Exception references missing authorization',
      );
    if (authorization?.kind === 'user_decision' && !authorization.decisionId) {
      issue(
        ctx,
        ['contract', 'exceptions', index],
        'User exception authorization is unresolved',
      );
    }
    if (rules.get(exception.ruleId)?.enforcementStatus !== 'waived') {
      issue(
        ctx,
        ['contract', 'exceptions', index],
        'Exception target is not waived',
      );
    }
  }

  const checkpoint = record.checkpoint;
  if (record.waitCondition) {
    if (record.waitCondition.createdRevision > record.revision) {
      issue(
        ctx,
        ['waitCondition', 'createdRevision'],
        'Wait revision is in the future',
      );
    }
    if (
      record.waitCondition.restartObservedRevision !== undefined &&
      record.waitCondition.restartObservedRevision > record.revision
    ) {
      issue(
        ctx,
        ['waitCondition', 'restartObservedRevision'],
        'Restart observation revision is in the future',
      );
    }
  }
  if (checkpoint) {
    if (checkpoint.outcomeId !== record.outcomeId)
      issue(ctx, ['checkpoint', 'outcomeId'], 'Checkpoint outcome mismatch');
    if (checkpoint.rootSessionId !== record.rootSessionId)
      issue(ctx, ['checkpoint', 'rootSessionId'], 'Checkpoint root mismatch');
    if (checkpoint.contractDigest !== record.contractDigest)
      issue(
        ctx,
        ['checkpoint', 'contractDigest'],
        'Checkpoint contract mismatch',
      );
    if (checkpoint.outcomeRevision >= record.revision)
      issue(
        ctx,
        ['checkpoint', 'outcomeRevision'],
        'Checkpoint snapshot must precede envelope revision',
      );
    if (
      checkpoint.checkpointFingerprint !==
      computeOutcomeCheckpointFingerprint(checkpoint)
    ) {
      issue(
        ctx,
        ['checkpoint', 'checkpointFingerprint'],
        'Checkpoint fingerprint mismatch',
      );
    }
    validateReferences(
      checkpoint.includedDecisionIds,
      decisions,
      ['checkpoint', 'includedDecisionIds'],
      ctx,
    );
    for (const id of checkpoint.includedEvidenceAttestationIds) {
      const attestation = attestations.get(id);
      if (
        attestation?.kind === 'orchestrator_attestation' &&
        attestation.createdRevision > checkpoint.outcomeRevision
      ) {
        issue(
          ctx,
          ['checkpoint', 'includedEvidenceAttestationIds'],
          'Checkpoint cannot include evidence created after its snapshot',
        );
      }
    }
    validateReferences(
      checkpoint.includedEvidenceAttestationIds,
      attestations,
      ['checkpoint', 'includedEvidenceAttestationIds'],
      ctx,
    );
    const exceptions = new Set(
      record.contract.exceptions.map((entry) => entry.ruleId),
    );
    for (const [index, id] of checkpoint.includedExceptionRuleIds.entries()) {
      if (!exceptions.has(id))
        issue(
          ctx,
          ['checkpoint', 'includedExceptionRuleIds', index],
          'Checkpoint references missing exception',
        );
    }
  }

  if (record.kickoffGate.contractDigest !== record.contractDigest) {
    issue(
      ctx,
      ['kickoffGate', 'contractDigest'],
      'Kickoff gate contract digest must match record contract digest',
    );
  }
  if (record.kickoffGate.attempts > record.kickoffGate.maxAttempts) {
    issue(
      ctx,
      ['kickoffGate', 'attempts'],
      'Kickoff gate attempts cannot exceed maxAttempts',
    );
  }
  if (record.kickoffGate.attempts > 0 && !record.kickoffGate.lastCheckpointId) {
    issue(
      ctx,
      ['kickoffGate', 'lastCheckpointId'],
      'A consumed kickoff attempt requires lastCheckpointId',
    );
  }
  if (record.kickoffGate.state === 'authenticated') {
    if (record.kickoffGate.attempts < 1 || record.kickoffGate.attempts > 2) {
      issue(
        ctx,
        ['kickoffGate', 'attempts'],
        'Authenticated kickoff gate must have 1 or 2 attempts',
      );
    }
    if (!record.kickoffGate.authenticatedReviewId) {
      issue(
        ctx,
        ['kickoffGate', 'authenticatedReviewId'],
        'Authenticated kickoff gate requires authenticatedReviewId',
      );
    } else {
      const kickoffReview = record.reviewSummaries.find(
        (entry) => entry.reviewId === record.kickoffGate.authenticatedReviewId,
      );
      if (
        kickoffReview?.checkpointKind !== 'kickoff' ||
        kickoffReview.contractDigest !== record.contractDigest ||
        kickoffReview.verdict !== 'CONTINUE'
      ) {
        issue(
          ctx,
          ['kickoffGate', 'authenticatedReviewId'],
          'Authenticated review ID does not match a valid kickoff CONTINUE review summary',
        );
      }
      if (
        !record.kickoffGate.lastCheckpointId ||
        (kickoffReview &&
          kickoffReview.checkpointId !== record.kickoffGate.lastCheckpointId)
      ) {
        issue(
          ctx,
          ['kickoffGate', 'lastCheckpointId'],
          'Authenticated kickoff review checkpoint ID must match kickoff gate lastCheckpointId',
        );
      }
    }
  } else if (record.kickoffGate.authenticatedReviewId !== undefined) {
    issue(
      ctx,
      ['kickoffGate', 'authenticatedReviewId'],
      'Unauthenticated kickoff gate cannot carry authenticatedReviewId',
    );
  }

  if (record.kickoffGate.state === 'exhausted') {
    if (record.kickoffGate.attempts !== record.kickoffGate.maxAttempts) {
      issue(
        ctx,
        ['kickoffGate', 'attempts'],
        'Exhausted kickoff gate must have attempts equal to maxAttempts',
      );
    }
    if (record.phase !== 'failed' && record.phase !== 'corrupted') {
      issue(ctx, ['phase'], 'Exhausted kickoff gate requires failed phase');
    }
  }

  if (record.kickoffGate.state === 'legacy_late_missing') {
    if (record.phase !== 'failed' && record.phase !== 'corrupted') {
      issue(ctx, ['phase'], 'Legacy missing kickoff requires failed phase');
    }
    if (
      record.checkpoint &&
      record.checkpoint.kind === 'kickoff' &&
      record.checkpoint.state !== 'retired'
    ) {
      issue(
        ctx,
        ['checkpoint'],
        'Legacy record with missing kickoff cannot carry an active kickoff checkpoint',
      );
    }
  }

  if (record.kickoffGate.state === 'legacy_certified') {
    if (record.phase !== 'accepted' || !record.finalCertificate) {
      issue(
        ctx,
        ['kickoffGate'],
        'Legacy-certified kickoff state is reserved for accepted V1 certificates',
      );
    }
    if (
      record.kickoffGate.attempts !== 0 ||
      record.kickoffGate.authenticatedReviewId ||
      record.kickoffGate.lastCheckpointId
    ) {
      issue(
        ctx,
        ['kickoffGate'],
        'Legacy-certified kickoff state cannot claim V2 kickoff authentication',
      );
    }
  }

  if (
    record.checkpoint &&
    record.checkpoint.kind === 'kickoff' &&
    record.checkpoint.state !== 'retired'
  ) {
    if (
      !record.kickoffGate.lastCheckpointId ||
      record.checkpoint.checkpointId !== record.kickoffGate.lastCheckpointId
    ) {
      issue(
        ctx,
        ['checkpoint', 'checkpointId'],
        'Active kickoff checkpoint ID must match kickoff gate lastCheckpointId',
      );
    }
  }

  addDuplicateIssues(
    record.receipts.handoffSupersessions ?? [],
    'id',
    ['receipts', 'handoffSupersessions'],
    ctx,
  );
  const attestationsForSupersession = new Map(
    record.receipts.evidence
      .filter((entry) => entry.kind === 'orchestrator_attestation')
      .map((entry) => [entry.id, entry]),
  );
  const userMessagesForSupersession = new Map(
    record.receipts.userMessages.map((entry) => [entry.id, entry]),
  );
  for (const [index, supersession] of (
    record.receipts.handoffSupersessions ?? []
  ).entries()) {
    if (supersession.supersededRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'handoffSupersessions', index, 'supersededRevision'],
        'Supersession revision is in the future',
      );
    }
    const expectedDigest =
      computeOutcomeHandoffSupersessionDigest(supersession);
    if (supersession.payloadDigest !== expectedDigest) {
      issue(
        ctx,
        ['receipts', 'handoffSupersessions', index, 'payloadDigest'],
        'Supersession digest does not match its fields',
      );
    }
    if (
      !userMessagesForSupersession.has(supersession.sourceUserMessageReceiptId)
    ) {
      issue(
        ctx,
        [
          'receipts',
          'handoffSupersessions',
          index,
          'sourceUserMessageReceiptId',
        ],
        'Supersession references missing user message',
      );
    }
    const userReceipt = userMessagesForSupersession.get(
      supersession.sourceUserMessageReceiptId,
    );
    if (
      userReceipt &&
      (userReceipt.createdRevision <=
        supersession.waitRestartObservedRevision ||
        userReceipt.createdRevision > supersession.supersededRevision ||
        userReceipt.provenance !== 'external_user' ||
        userReceipt.observedEpoch !== supersession.serverEpoch)
    ) {
      issue(
        ctx,
        [
          'receipts',
          'handoffSupersessions',
          index,
          'sourceUserMessageReceiptId',
        ],
        'Supersession user receipt must be fresh external_user minted after restart observation in current epoch',
      );
    }
    if (!attestationsForSupersession.has(supersession.evidenceAttestationId)) {
      issue(
        ctx,
        ['receipts', 'handoffSupersessions', index, 'evidenceAttestationId'],
        'Supersession references missing evidence attestation',
      );
    }
    const evidence = attestationsForSupersession.get(
      supersession.evidenceAttestationId,
    );
    if (
      evidence &&
      (evidence.createdRevision <= (userReceipt?.createdRevision ?? 0) ||
        evidence.createdRevision > supersession.supersededRevision ||
        evidence.assertedStatus !== 'passed' ||
        evidence.assertedFreshness !== 'fresh' ||
        evidence.candidateFingerprint !==
          supersession.replacementCandidateFingerprint)
    ) {
      issue(
        ctx,
        ['receipts', 'handoffSupersessions', index, 'evidenceAttestationId'],
        'Supersession evidence must be fresh passed attestation minted after user receipt matching replacement candidate',
      );
    }
    if (
      !supersession.expectedPostRestartCheck.includes(
        supersession.retiredCheckpointId,
      ) &&
      !supersession.waitInstructions?.includes(supersession.retiredCheckpointId)
    ) {
      issue(
        ctx,
        ['receipts', 'handoffSupersessions', index, 'retiredCheckpointId'],
        'Exact handoff instructions or expected check must contain retired checkpoint ID',
      );
    }
    if (
      supersession.waitRestartObservedRevision <=
      supersession.waitCreatedRevision
    ) {
      issue(
        ctx,
        [
          'receipts',
          'handoffSupersessions',
          index,
          'waitRestartObservedRevision',
        ],
        'Restart observation must follow wait creation',
      );
    }
    if (
      supersession.observedChildResultDigest ===
      supersession.retiredBoundResultDigest
    ) {
      issue(
        ctx,
        [
          'receipts',
          'handoffSupersessions',
          index,
          'observedChildResultDigest',
        ],
        'Superseded misbound result observed digest must differ from bound digest',
      );
    }
    if (supersession.waitOriginatingServerEpoch === supersession.serverEpoch) {
      issue(
        ctx,
        [
          'receipts',
          'handoffSupersessions',
          index,
          'waitOriginatingServerEpoch',
        ],
        'Superseded handoff originating epoch must differ from current epoch',
      );
    }
  }

  const accepted = record.phase === 'accepted';
  if (accepted !== (record.finalCertificate !== undefined)) {
    issue(
      ctx,
      ['phase'],
      'Accepted phase and final certificate must appear together',
    );
  }
  if (accepted) validateAcceptedRecord(record, ctx);
}

function validateRecordRelationsV1(
  record: z.infer<typeof OutcomeRecordV1BaseSchema>,
  ctx: z.RefinementCtx,
): void {
  if (record.contractDigest !== computeOutcomeContractDigest(record.contract)) {
    issue(
      ctx,
      ['contractDigest'],
      'Contract digest does not match canonical contract',
    );
  }
  if (record.updatedAt < record.createdAt)
    issue(ctx, ['updatedAt'], 'Update cannot precede creation');

  addDuplicateIssues(
    record.receipts.evidence,
    'id',
    ['receipts', 'evidence'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.userMessages,
    'id',
    ['receipts', 'userMessages'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.decisions,
    'id',
    ['receipts', 'decisions'],
    ctx,
  );
  addDuplicateIssues(
    record.receipts.authorizations,
    'id',
    ['receipts', 'authorizations'],
    ctx,
  );
  addDuplicateIssues(
    record.reviewSummaries,
    'reviewId',
    ['reviewSummaries'],
    ctx,
  );
  const reviewedClaims = new Set<string>();
  for (const [index, summary] of record.reviewSummaries.entries()) {
    const identity = `${summary.checkpointId}:${summary.claimGeneration}`;
    if (reviewedClaims.has(identity)) {
      issue(
        ctx,
        ['reviewSummaries', index],
        'Duplicate review summary for checkpoint claim',
      );
    }
    reviewedClaims.add(identity);
  }
  addDuplicateIssues(record.operations, 'id', ['operations'], ctx);
  addDuplicateIssues(record.actionsRequired, 'id', ['actionsRequired'], ctx);

  const observations = new Set(
    record.receipts.evidence
      .filter((entry) => entry.kind === 'controller_observed')
      .map((entry) => entry.id),
  );
  const attestations = new Map(
    record.receipts.evidence
      .filter((entry) => entry.kind === 'orchestrator_attestation')
      .map((entry) => [entry.id, entry]),
  );
  for (const [index, entry] of record.receipts.evidence.entries()) {
    if (entry.kind !== 'orchestrator_attestation') continue;
    if (
      entry.payloadDigest !== computeOutcomeEvidenceAttestationDigest(entry)
    ) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'payloadDigest'],
        'Attestation digest does not match its minted fields',
      );
    }
    if (entry.createdRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'createdRevision'],
        'Attestation revision is in the future',
      );
    }
    if (
      entry.linkedObservationId &&
      !observations.has(entry.linkedObservationId)
    ) {
      issue(
        ctx,
        ['receipts', 'evidence', index, 'linkedObservationId'],
        'Attestation references missing observation',
      );
    }
  }

  const decisions = new Map(
    record.receipts.decisions.map((entry) => [entry.id, entry]),
  );
  const userMessages = new Map(
    record.receipts.userMessages.map((entry) => [entry.id, entry]),
  );
  for (const [index, receipt] of record.receipts.userMessages.entries()) {
    if (receipt.createdRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'userMessages', index, 'createdRevision'],
        'User receipt revision is in the future',
      );
    }
  }
  for (const [index, decision] of record.receipts.decisions.entries()) {
    if (decision.createdRevision > record.revision) {
      issue(
        ctx,
        ['receipts', 'decisions', index, 'createdRevision'],
        'Decision revision is in the future',
      );
    }
    if (
      decision.sourceUserMessageReceiptId &&
      !userMessages.has(decision.sourceUserMessageReceiptId)
    ) {
      issue(
        ctx,
        ['receipts', 'decisions', index, 'sourceUserMessageReceiptId'],
        'Decision references missing user message',
      );
    }
  }
  const authorizations = new Map(
    record.receipts.authorizations.map((entry) => [entry.id, entry]),
  );
  for (const [index, action] of record.actionsRequired.entries()) {
    if (action.createdRevision > record.revision) {
      issue(
        ctx,
        ['actionsRequired', index, 'createdRevision'],
        'Action revision is in the future',
      );
    }
    if (
      action.createdRevision === record.revision &&
      action.resolvedAt !== undefined
    ) {
      issue(
        ctx,
        ['actionsRequired', index, 'createdRevision'],
        'Resolved action provenance must be persisted in a later revision',
      );
    }
    if (
      action.resolutionUserMessageReceiptId &&
      !userMessages.has(action.resolutionUserMessageReceiptId)
    ) {
      issue(
        ctx,
        ['actionsRequired', index, 'resolutionUserMessageReceiptId'],
        'Action resolution references missing user receipt',
      );
    }
    const resolutionUserReceipt = action.resolutionUserMessageReceiptId
      ? userMessages.get(action.resolutionUserMessageReceiptId)
      : undefined;
    if (
      resolutionUserReceipt &&
      resolutionUserReceipt.createdRevision <= action.createdRevision
    ) {
      issue(
        ctx,
        ['actionsRequired', index, 'resolutionUserMessageReceiptId'],
        'Action resolution user receipt must be minted after the action',
      );
    }
    for (const evidenceId of action.resolutionEvidenceAttestationIds ?? []) {
      const attestation = attestations.get(evidenceId);
      if (!attestation) {
        issue(
          ctx,
          ['actionsRequired', index, 'resolutionEvidenceAttestationIds'],
          'Action resolution references missing evidence attestation',
        );
      } else if (
        attestation.createdRevision <= action.createdRevision ||
        attestation.assertedStatus !== 'passed' ||
        attestation.assertedFreshness !== 'fresh'
      ) {
        issue(
          ctx,
          ['actionsRequired', index, 'resolutionEvidenceAttestationIds'],
          'Action resolution evidence must be a fresh passed attestation minted after the action',
        );
      }
    }
  }
  for (const [
    index,
    authorization,
  ] of record.receipts.authorizations.entries()) {
    if (
      authorization.payloadDigest !==
      computeOutcomeAuthorizationDigest(authorization)
    ) {
      issue(
        ctx,
        ['receipts', 'authorizations', index, 'payloadDigest'],
        'Authorization digest does not match its minted fields',
      );
    }
    if (authorization.decisionId) {
      const decision = decisions.get(authorization.decisionId);
      if (!decision?.chosenOption || !decision.sourceUserMessageReceiptId) {
        issue(
          ctx,
          ['receipts', 'authorizations', index, 'decisionId'],
          'User authorization requires a resolved, user-backed decision',
        );
      }
      if (decision && authorization.reference !== decision.id) {
        issue(
          ctx,
          ['receipts', 'authorizations', index, 'reference'],
          'User authorization reference must equal its decision ID',
        );
      }
      if (
        decision?.decidedAt !== undefined &&
        authorization.observedAt < decision.decidedAt
      ) {
        issue(
          ctx,
          ['receipts', 'authorizations', index, 'observedAt'],
          'User authorization cannot precede its decision',
        );
      }
    }
  }
  const rules = new Map(
    record.contract.rules.map((entry) => [entry.id, entry]),
  );
  for (const [index, rule] of record.contract.rules.entries()) {
    addDuplicateStringIssues(
      rule.evidenceAttestationIds,
      ['contract', 'rules', index, 'evidenceAttestationIds'],
      ctx,
    );
    for (const id of rule.evidenceAttestationIds) {
      if (!attestations.has(id))
        issue(
          ctx,
          ['contract', 'rules', index],
          'Rule references missing attestation',
        );
    }
  }
  for (const [index, exception] of record.contract.exceptions.entries()) {
    const authorization = authorizations.get(exception.authorizationId);
    if (!authorization)
      issue(
        ctx,
        ['contract', 'exceptions', index, 'authorizationId'],
        'Exception references missing authorization',
      );
    if (authorization?.kind === 'user_decision' && !authorization.decisionId) {
      issue(
        ctx,
        ['contract', 'exceptions', index],
        'User exception authorization is unresolved',
      );
    }
    if (rules.get(exception.ruleId)?.enforcementStatus !== 'waived') {
      issue(
        ctx,
        ['contract', 'exceptions', index],
        'Exception target is not waived',
      );
    }
  }

  const checkpoint = record.checkpoint;
  if (record.waitCondition) {
    if (record.waitCondition.createdRevision > record.revision) {
      issue(
        ctx,
        ['waitCondition', 'createdRevision'],
        'Wait revision is in the future',
      );
    }
    if (
      record.waitCondition.restartObservedRevision !== undefined &&
      record.waitCondition.restartObservedRevision > record.revision
    ) {
      issue(
        ctx,
        ['waitCondition', 'restartObservedRevision'],
        'Restart observation revision is in the future',
      );
    }
  }
  if (checkpoint) {
    if (checkpoint.outcomeId !== record.outcomeId)
      issue(ctx, ['checkpoint', 'outcomeId'], 'Checkpoint outcome mismatch');
    if (checkpoint.rootSessionId !== record.rootSessionId)
      issue(ctx, ['checkpoint', 'rootSessionId'], 'Checkpoint root mismatch');
    if (checkpoint.contractDigest !== record.contractDigest)
      issue(
        ctx,
        ['checkpoint', 'contractDigest'],
        'Checkpoint contract mismatch',
      );
    if (checkpoint.outcomeRevision >= record.revision)
      issue(
        ctx,
        ['checkpoint', 'outcomeRevision'],
        'Checkpoint snapshot must precede envelope revision',
      );
    if (
      checkpoint.checkpointFingerprint !==
      computeOutcomeCheckpointFingerprint(checkpoint)
    ) {
      issue(
        ctx,
        ['checkpoint', 'checkpointFingerprint'],
        'Checkpoint fingerprint mismatch',
      );
    }
    validateReferences(
      checkpoint.includedDecisionIds,
      decisions,
      ['checkpoint', 'includedDecisionIds'],
      ctx,
    );
    for (const id of checkpoint.includedEvidenceAttestationIds) {
      const attestation = attestations.get(id);
      if (
        attestation?.kind === 'orchestrator_attestation' &&
        attestation.createdRevision > checkpoint.outcomeRevision
      ) {
        issue(
          ctx,
          ['checkpoint', 'includedEvidenceAttestationIds'],
          'Checkpoint cannot include evidence created after its snapshot',
        );
      }
    }
    validateReferences(
      checkpoint.includedEvidenceAttestationIds,
      attestations,
      ['checkpoint', 'includedEvidenceAttestationIds'],
      ctx,
    );
    const exceptions = new Set(
      record.contract.exceptions.map((entry) => entry.ruleId),
    );
    for (const [index, id] of checkpoint.includedExceptionRuleIds.entries()) {
      if (!exceptions.has(id))
        issue(
          ctx,
          ['checkpoint', 'includedExceptionRuleIds', index],
          'Checkpoint references missing exception',
        );
    }
  }

  const accepted = record.phase === 'accepted';
  if (accepted !== (record.finalCertificate !== undefined)) {
    issue(
      ctx,
      ['phase'],
      'Accepted phase and final certificate must appear together',
    );
  }
  if (accepted) validateAcceptedRecordV1(record, ctx);
}

function validateAcceptedRecord(
  record: OutcomeRecord,
  ctx: z.RefinementCtx,
): void {
  if (record.kickoffGate.state === 'legacy_certified') {
    validateAcceptedRecordV1(record, ctx);
    return;
  }
  if (
    record.kickoffGate.state !== 'authenticated' ||
    !record.kickoffGate.authenticatedReviewId
  ) {
    issue(
      ctx,
      ['kickoffGate'],
      'Acceptance requires an authenticated kickoff gate',
    );
    return;
  }
  const certificate = record.finalCertificate;
  const checkpoint = record.checkpoint;
  if (
    !certificate ||
    !checkpoint ||
    checkpoint.kind !== 'final' ||
    checkpoint.state !== 'review_accepted'
  ) {
    issue(
      ctx,
      ['checkpoint'],
      'Acceptance requires an accepted final checkpoint',
    );
    return;
  }
  const review = record.reviewSummaries.find(
    (entry) =>
      entry.checkpointId === checkpoint.checkpointId &&
      entry.claimGeneration === checkpoint.claimGeneration,
  );
  if (review?.verdict !== 'ACCEPT') {
    issue(
      ctx,
      ['reviewSummaries'],
      'Acceptance requires a matching Manager ACCEPT review',
    );
    return;
  }
  if (
    review.checkpointKind !== 'final' ||
    review.contractDigest !== checkpoint.contractDigest ||
    review.outcomeRevision !== checkpoint.outcomeRevision ||
    review.candidateFingerprint !== checkpoint.candidateFingerprint ||
    review.reviewDigest !== checkpoint.reviewDigest ||
    review.resultDigest !== checkpoint.resultDigest
  ) {
    issue(
      ctx,
      ['reviewSummaries'],
      'Manager ACCEPT review does not match the final checkpoint',
    );
  }
  for (const [index, goal] of record.contract.goals.entries()) {
    if (goal.status !== 'satisfied') {
      issue(
        ctx,
        ['contract', 'goals', index, 'status'],
        'Accepted outcome requires every current goal to be satisfied',
      );
    }
  }
  for (const [index, rule] of record.contract.rules.entries()) {
    if (['violated', 'pending'].includes(rule.enforcementStatus)) {
      issue(
        ctx,
        ['contract', 'rules', index, 'enforcementStatus'],
        'Accepted outcome cannot contain violated or pending rules',
      );
    }
  }
  const expected = {
    outcomeId: record.outcomeId,
    acceptedRevision: record.revision,
    contractDigest: record.contractDigest,
    candidateFingerprint: checkpoint.candidateFingerprint,
    acceptedCheckpointId: checkpoint.checkpointId,
    acceptedClaimGeneration: checkpoint.claimGeneration,
    finalCheckpointFingerprint: checkpoint.checkpointFingerprint,
    managerTaskId: checkpoint.managerTaskId,
    managerGeneration: checkpoint.managerGeneration,
    managerReviewId: review.reviewId,
    managerReviewDigest: review.reviewDigest,
    serverEpoch: record.serverEpoch,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (certificate[key as keyof typeof certificate] !== value) {
      issue(
        ctx,
        ['finalCertificate', key],
        `Certificate ${key} does not match accepted record`,
      );
    }
  }
  const attestationDigests = checkpoint.includedEvidenceAttestationIds
    .map((id) => record.receipts.evidence.find((entry) => entry.id === id))
    .filter(
      (entry): entry is OutcomeEvidenceAttestation =>
        entry?.kind === 'orchestrator_attestation',
    )
    .map((entry) => entry.payloadDigest)
    .sort();
  const includedAttestations = new Map(
    checkpoint.includedEvidenceAttestationIds.map((id) => [
      id,
      record.receipts.evidence.find((entry) => entry.id === id),
    ]),
  );
  for (const [id, entry] of includedAttestations) {
    if (
      entry?.kind !== 'orchestrator_attestation' ||
      entry.assertedStatus !== 'passed' ||
      entry.assertedFreshness !== 'fresh' ||
      entry.candidateFingerprint !== checkpoint.candidateFingerprint
    ) {
      issue(
        ctx,
        ['checkpoint', 'includedEvidenceAttestationIds'],
        `Final attestation '${id}' is not passed, fresh, and candidate-bound`,
      );
    }
  }
  for (const [index, rule] of record.contract.rules.entries()) {
    if (
      rule.ruleType === 'machine_enforced' &&
      rule.enforcementStatus === 'satisfied' &&
      !rule.evidenceAttestationIds.some((id) => includedAttestations.has(id))
    ) {
      issue(
        ctx,
        ['contract', 'rules', index, 'evidenceAttestationIds'],
        'Satisfied machine-enforced rule lacks included final evidence',
      );
    }
  }
  const certificateDigests = [...certificate.receiptDigests].sort();
  if (
    new Set(certificateDigests).size !== certificateDigests.length ||
    stableJson(certificateDigests) !== stableJson(attestationDigests)
  ) {
    issue(
      ctx,
      ['finalCertificate', 'receiptDigests'],
      'Certificate receipt digests do not match checkpoint attestations',
    );
  }
  if (certificate.evidenceAssurance !== 'orchestrator_attestation') {
    issue(
      ctx,
      ['finalCertificate', 'evidenceAssurance'],
      'Version 1 certificates support orchestrator-attestation assurance only',
    );
  }
  if (record.waitCondition)
    issue(ctx, ['waitCondition'], 'Accepted outcome cannot be waiting');
  if (record.actionsRequired.some((entry) => entry.resolvedAt === undefined))
    issue(ctx, ['actionsRequired'], 'Accepted outcome has unresolved action');
  if (
    record.operations.some(
      (entry) => !['completed', 'acknowledged'].includes(entry.status),
    )
  )
    issue(ctx, ['operations'], 'Accepted outcome has unresolved operation');
}

function validateAcceptedRecordV1(
  record:
    | z.infer<typeof OutcomeRecordV1BaseSchema>
    | z.infer<typeof OutcomeRecordBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  const certificate = record.finalCertificate;
  const checkpoint = record.checkpoint;
  if (
    !certificate ||
    !checkpoint ||
    checkpoint.kind !== 'final' ||
    checkpoint.state !== 'review_accepted'
  ) {
    issue(
      ctx,
      ['checkpoint'],
      'Acceptance requires an accepted final checkpoint',
    );
    return;
  }
  const review = record.reviewSummaries.find(
    (entry) =>
      entry.checkpointId === checkpoint.checkpointId &&
      entry.claimGeneration === checkpoint.claimGeneration,
  );
  if (review?.verdict !== 'ACCEPT') {
    issue(
      ctx,
      ['reviewSummaries'],
      'Acceptance requires a matching Manager ACCEPT review',
    );
    return;
  }
  if (
    review.checkpointKind !== 'final' ||
    review.contractDigest !== checkpoint.contractDigest ||
    review.outcomeRevision !== checkpoint.outcomeRevision ||
    review.candidateFingerprint !== checkpoint.candidateFingerprint ||
    review.reviewDigest !== checkpoint.reviewDigest ||
    review.resultDigest !== checkpoint.resultDigest
  ) {
    issue(
      ctx,
      ['reviewSummaries'],
      'Manager ACCEPT review does not match the final checkpoint',
    );
  }
  for (const [index, goal] of record.contract.goals.entries()) {
    if (goal.status !== 'satisfied') {
      issue(
        ctx,
        ['contract', 'goals', index, 'status'],
        'Accepted outcome requires every current goal to be satisfied',
      );
    }
  }
  for (const [index, rule] of record.contract.rules.entries()) {
    if (['violated', 'pending'].includes(rule.enforcementStatus)) {
      issue(
        ctx,
        ['contract', 'rules', index, 'enforcementStatus'],
        'Accepted outcome cannot contain violated or pending rules',
      );
    }
  }
  const expected = {
    outcomeId: record.outcomeId,
    acceptedRevision: record.revision,
    contractDigest: record.contractDigest,
    candidateFingerprint: checkpoint.candidateFingerprint,
    acceptedCheckpointId: checkpoint.checkpointId,
    acceptedClaimGeneration: checkpoint.claimGeneration,
    finalCheckpointFingerprint: checkpoint.checkpointFingerprint,
    managerTaskId: checkpoint.managerTaskId,
    managerGeneration: checkpoint.managerGeneration,
    managerReviewId: review.reviewId,
    managerReviewDigest: review.reviewDigest,
    serverEpoch: record.serverEpoch,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (certificate[key as keyof typeof certificate] !== value) {
      issue(
        ctx,
        ['finalCertificate', key],
        `Certificate ${key} does not match accepted record`,
      );
    }
  }
  const attestationDigests = checkpoint.includedEvidenceAttestationIds
    .map((id) => record.receipts.evidence.find((entry) => entry.id === id))
    .filter(
      (entry): entry is OutcomeEvidenceAttestation =>
        entry?.kind === 'orchestrator_attestation',
    )
    .map((entry) => entry.payloadDigest)
    .sort();
  const includedAttestations = new Map(
    checkpoint.includedEvidenceAttestationIds.map((id) => [
      id,
      record.receipts.evidence.find((entry) => entry.id === id),
    ]),
  );
  for (const [id, entry] of includedAttestations) {
    if (
      entry?.kind !== 'orchestrator_attestation' ||
      entry.assertedStatus !== 'passed' ||
      entry.assertedFreshness !== 'fresh' ||
      entry.candidateFingerprint !== checkpoint.candidateFingerprint
    ) {
      issue(
        ctx,
        ['checkpoint', 'includedEvidenceAttestationIds'],
        `Final attestation '${id}' is not passed, fresh, and candidate-bound`,
      );
    }
  }
  for (const [index, rule] of record.contract.rules.entries()) {
    if (
      rule.ruleType === 'machine_enforced' &&
      rule.enforcementStatus === 'satisfied' &&
      !rule.evidenceAttestationIds.some((id) => includedAttestations.has(id))
    ) {
      issue(
        ctx,
        ['contract', 'rules', index, 'evidenceAttestationIds'],
        'Satisfied machine-enforced rule lacks included final evidence',
      );
    }
  }
  const certificateDigests = [...certificate.receiptDigests].sort();
  if (
    new Set(certificateDigests).size !== certificateDigests.length ||
    stableJson(certificateDigests) !== stableJson(attestationDigests)
  ) {
    issue(
      ctx,
      ['finalCertificate', 'receiptDigests'],
      'Certificate receipt digests do not match checkpoint attestations',
    );
  }
  if (certificate.evidenceAssurance !== 'orchestrator_attestation') {
    issue(
      ctx,
      ['finalCertificate', 'evidenceAssurance'],
      'Version 1 certificates support orchestrator-attestation assurance only',
    );
  }
  if (record.waitCondition)
    issue(ctx, ['waitCondition'], 'Accepted outcome cannot be waiting');
  if (record.actionsRequired.some((entry) => entry.resolvedAt === undefined))
    issue(ctx, ['actionsRequired'], 'Accepted outcome has unresolved action');
  if (
    record.operations.some(
      (entry) => !['completed', 'acknowledged'].includes(entry.status),
    )
  )
    issue(ctx, ['operations'], 'Accepted outcome has unresolved operation');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function issue(
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function addDuplicateIssues<T extends Record<string, unknown>>(
  values: T[],
  key: keyof T,
  path: PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<unknown>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value[key]))
      issue(ctx, [...path, index, key as string], `Duplicate ${String(key)}`);
    seen.add(value[key]);
  }
}

function addDuplicateStringIssues(
  values: string[],
  path: PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) issue(ctx, [...path, index], 'Duplicate reference');
    seen.add(value);
  }
}

function validateReferences<T>(
  ids: string[],
  records: Map<string, T>,
  path: PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  for (const [index, id] of ids.entries()) {
    if (!records.has(id))
      issue(ctx, [...path, index], 'Reference does not exist');
  }
}
