import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);

export const OutcomeVerdictSchema = z.enum([
  'CONTINUE',
  'CORRECT_DRIFT',
  'REVISE_CONTRACT',
  'USER_DECISION_REQUIRED',
  'ACCEPT',
]);
export type OutcomeVerdict = z.infer<typeof OutcomeVerdictSchema>;

export const GoalStatusSchema = z.enum([
  'satisfied',
  'in_progress',
  'blocked',
  'drifted',
  'unmet',
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalReceiptSchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    status: GoalStatusSchema,
    notes: NonEmptyStringSchema.optional(),
  })
  .strict();
export type GoalReceipt = z.infer<typeof GoalReceiptSchema>;

export const ScopeDefinitionSchema = z
  .object({
    inScope: z.array(NonEmptyStringSchema),
    outOfScope: z.array(NonEmptyStringSchema),
  })
  .strict();
export type ScopeDefinition = z.infer<typeof ScopeDefinitionSchema>;

export const RuleTypeSchema = z.enum(['machine_enforced', 'semantic']);
export type RuleType = z.infer<typeof RuleTypeSchema>;

export const RuleEnforcementStatusSchema = z.enum([
  'satisfied',
  'violated',
  'waived',
  'not_applicable',
  'pending',
]);
export type RuleEnforcementStatus = z.infer<typeof RuleEnforcementStatusSchema>;

export const RuleReceiptSchema = z
  .object({
    id: NonEmptyStringSchema,
    sourcePath: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    ruleType: RuleTypeSchema,
    enforcementStatus: RuleEnforcementStatusSchema,
    evidenceIds: z.array(NonEmptyStringSchema),
    notes: NonEmptyStringSchema.optional(),
  })
  .strict();
export type RuleReceipt = z.infer<typeof RuleReceiptSchema>;

export const EvidenceStatusSchema = z.enum([
  'passed',
  'failed',
  'stale',
  'pending',
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceFreshnessSchema = z.enum(['fresh', 'stale', 'unknown']);
export type EvidenceFreshness = z.infer<typeof EvidenceFreshnessSchema>;

export const EvidenceReceiptSchema = z
  .object({
    id: NonEmptyStringSchema,
    command: NonEmptyStringSchema,
    status: EvidenceStatusSchema,
    fingerprint: NonEmptyStringSchema,
    freshness: EvidenceFreshnessSchema,
    isFinalCandidate: z.boolean(),
    outputSummary: NonEmptyStringSchema.optional(),
  })
  .strict();
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;

export const AuthorizationKindSchema = z.enum([
  'repository_waiver',
  'user_decision',
]);
export type AuthorizationKind = z.infer<typeof AuthorizationKindSchema>;

export const ExceptionReceiptSchema = z
  .object({
    ruleId: NonEmptyStringSchema,
    justification: NonEmptyStringSchema,
    justified: z.boolean(),
    scope: NonEmptyStringSchema,
    authorizationKind: AuthorizationKindSchema,
    authorizationReference: NonEmptyStringSchema,
  })
  .strict();
export type ExceptionReceipt = z.infer<typeof ExceptionReceiptSchema>;

export const ConstraintCoherenceSchema = z
  .object({
    ordering: z.array(NonEmptyStringSchema),
    coherent: z.boolean(),
    conflicts: z.array(NonEmptyStringSchema).optional(),
  })
  .strict();
export type ConstraintCoherence = z.infer<typeof ConstraintCoherenceSchema>;

export const HandoffReceiptSchema = z
  .object({
    ready: z.boolean(),
    summary: NonEmptyStringSchema,
    verificationSteps: z.array(NonEmptyStringSchema),
    notes: NonEmptyStringSchema.optional(),
  })
  .strict();
export type HandoffReceipt = z.infer<typeof HandoffReceiptSchema>;

export const LifecycleStageSchema = z.enum([
  'execution',
  'review',
  'completed',
  'abandoned',
]);
export type LifecycleStage = z.infer<typeof LifecycleStageSchema>;

export const LifecycleReceiptSchema = z
  .object({
    stage: LifecycleStageSchema,
    receiptAgreement: z.boolean(),
    notes: NonEmptyStringSchema.optional(),
  })
  .strict();
export type LifecycleReceipt = z.infer<typeof LifecycleReceiptSchema>;

export const UserDecisionReceiptSchema = z
  .object({
    decisionNeeded: NonEmptyStringSchema,
    options: z.array(NonEmptyStringSchema).min(1),
    blocking: z.boolean(),
    impact: NonEmptyStringSchema.optional(),
  })
  .strict();
export type UserDecisionReceipt = z.infer<typeof UserDecisionReceiptSchema>;

export const OutcomeReviewBaseSchema = z
  .object({
    summary: NonEmptyStringSchema,
    verdict: OutcomeVerdictSchema,
    candidateFingerprint: NonEmptyStringSchema.optional(),
    goals: z.array(GoalReceiptSchema).min(1),
    scope: ScopeDefinitionSchema,
    rules: z.array(RuleReceiptSchema),
    evidence: z.array(EvidenceReceiptSchema),
    constraintCoherence: ConstraintCoherenceSchema,
    exceptions: z.array(ExceptionReceiptSchema),
    handoff: HandoffReceiptSchema,
    lifecycle: LifecycleReceiptSchema,
    userDecision: UserDecisionReceiptSchema.optional(),
  })
  .strict();

export const OutcomeReviewSchema = OutcomeReviewBaseSchema.superRefine(
  (data, ctx) => {
    // 1. Duplicate Goal IDs
    const seenGoalIds = new Set<string>();
    for (let i = 0; i < data.goals.length; i++) {
      const goal = data.goals[i];
      if (seenGoalIds.has(goal.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate goal ID '${goal.id}' in goals`,
          path: ['goals', i, 'id'],
        });
      }
      seenGoalIds.add(goal.id);
    }

    // 2. Duplicate Rule IDs
    const seenRuleIds = new Set<string>();
    for (let i = 0; i < data.rules.length; i++) {
      const rule = data.rules[i];
      if (seenRuleIds.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate rule ID '${rule.id}' in rules`,
          path: ['rules', i, 'id'],
        });
      }
      seenRuleIds.add(rule.id);
    }

    // 3. Duplicate Evidence IDs
    const seenEvidenceIds = new Set<string>();
    const evidenceMap = new Map<string, EvidenceReceipt>();
    for (let i = 0; i < data.evidence.length; i++) {
      const ev = data.evidence[i];
      if (seenEvidenceIds.has(ev.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate evidence ID '${ev.id}' in evidence`,
          path: ['evidence', i, 'id'],
        });
      }
      seenEvidenceIds.add(ev.id);
      evidenceMap.set(ev.id, ev);
    }

    // 4. Rule references to undeclared evidence IDs
    for (let i = 0; i < data.rules.length; i++) {
      const rule = data.rules[i];
      for (let j = 0; j < rule.evidenceIds.length; j++) {
        const evId = rule.evidenceIds[j];
        if (!seenEvidenceIds.has(evId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Rule '${rule.id}' references undeclared evidence ID '${evId}'`,
            path: ['rules', i, 'evidenceIds', j],
          });
        }
      }
    }

    // 5. Exception & Waiver Invariants:
    // - Every exception must reference an existing rule
    // - Every exception must reference a waived rule
    // - Exactly one exception per waived rule
    // - No duplicate exceptions
    const seenExceptionRuleIds = new Set<string>();
    for (let i = 0; i < data.exceptions.length; i++) {
      const exc = data.exceptions[i];
      if (seenExceptionRuleIds.has(exc.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate exception for rule ID '${exc.ruleId}'`,
          path: ['exceptions', i, 'ruleId'],
        });
      }
      seenExceptionRuleIds.add(exc.ruleId);

      const targetRule = data.rules.find((r) => r.id === exc.ruleId);
      if (!targetRule) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Exception references undeclared rule ID '${exc.ruleId}'`,
          path: ['exceptions', i, 'ruleId'],
        });
      } else if (targetRule.enforcementStatus !== 'waived') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Rule '${targetRule.id}' has status '${targetRule.enforcementStatus}' and must not have an exception (exceptions are only valid for waived rules)`,
          path: ['exceptions', i, 'ruleId'],
        });
      }
    }

    // Every waived rule must have an exception
    for (let i = 0; i < data.rules.length; i++) {
      const rule = data.rules[i];
      if (rule.enforcementStatus === 'waived') {
        if (!seenExceptionRuleIds.has(rule.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Waived rule '${rule.id}' must have an exception`,
            path: ['rules', i, 'enforcementStatus'],
          });
        }
      }
    }

    // 6. User Decision Invariants
    if (data.verdict === 'USER_DECISION_REQUIRED') {
      if (!data.userDecision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Verdict USER_DECISION_REQUIRED requires userDecision object',
          path: ['userDecision'],
        });
      } else if (!data.userDecision.blocking) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Verdict USER_DECISION_REQUIRED requires userDecision.blocking to be true',
          path: ['userDecision', 'blocking'],
        });
      }
      if (data.handoff.ready) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Verdict USER_DECISION_REQUIRED requires handoff.ready to be false',
          path: ['handoff', 'ready'],
        });
      }
    } else {
      if (data.userDecision !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `userDecision must be absent for verdict '${data.verdict}'`,
          path: ['userDecision'],
        });
      }
    }

    // 7. ACCEPT Invariants
    if (data.verdict === 'ACCEPT') {
      // Candidate fingerprint required on ACCEPT
      if (!data.candidateFingerprint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Verdict ACCEPT requires candidateFingerprint',
          path: ['candidateFingerprint'],
        });
      }

      // All goals must be satisfied
      for (let i = 0; i < data.goals.length; i++) {
        const goal = data.goals[i];
        if (goal.status !== 'satisfied') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cannot ACCEPT when goal '${goal.id}' has status '${goal.status}' (must be 'satisfied')`,
            path: ['goals', i, 'status'],
          });
        }
      }

      // No violated or pending rules
      for (let i = 0; i < data.rules.length; i++) {
        const rule = data.rules[i];
        if (rule.enforcementStatus === 'violated') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cannot ACCEPT when rule '${rule.id}' is violated`,
            path: ['rules', i, 'enforcementStatus'],
          });
        } else if (rule.enforcementStatus === 'pending') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cannot ACCEPT when rule '${rule.id}' enforcement is pending`,
            path: ['rules', i, 'enforcementStatus'],
          });
        }

        // Satisfied machine-enforced rules must reference fresh passed final-candidate evidence matching candidateFingerprint
        if (
          rule.ruleType === 'machine_enforced' &&
          rule.enforcementStatus === 'satisfied'
        ) {
          const hasValidBackingEvidence = rule.evidenceIds.some((evId) => {
            const ev = evidenceMap.get(evId);
            return (
              ev?.isFinalCandidate &&
              ev.status === 'passed' &&
              ev.freshness === 'fresh' &&
              data.candidateFingerprint !== undefined &&
              ev.fingerprint === data.candidateFingerprint
            );
          });
          if (!hasValidBackingEvidence) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Satisfied machine-enforced rule '${rule.id}' must reference at least one fresh passed final-candidate evidence receipt matching candidateFingerprint '${data.candidateFingerprint}'`,
              path: ['rules', i, 'evidenceIds'],
            });
          }
        }
      }

      // Evidence requirements
      if (data.evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cannot ACCEPT without evidence receipts',
          path: ['evidence'],
        });
      }

      let finalCandidateCount = 0;
      for (let i = 0; i < data.evidence.length; i++) {
        const ev = data.evidence[i];
        if (ev.status === 'failed') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cannot ACCEPT with failed evidence '${ev.id}'`,
            path: ['evidence', i, 'status'],
          });
        } else if (ev.status === 'pending') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cannot ACCEPT with pending evidence '${ev.id}'`,
            path: ['evidence', i, 'status'],
          });
        }

        if (ev.isFinalCandidate) {
          finalCandidateCount++;
          if (
            data.candidateFingerprint !== undefined &&
            ev.fingerprint !== data.candidateFingerprint
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Final candidate evidence '${ev.id}' fingerprint '${ev.fingerprint}' does not match candidateFingerprint '${data.candidateFingerprint}'`,
              path: ['evidence', i, 'fingerprint'],
            });
          }
          if (ev.status !== 'passed') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Final candidate evidence '${ev.id}' status '${ev.status}' must be 'passed'`,
              path: ['evidence', i, 'status'],
            });
          }
          if (ev.freshness !== 'fresh') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Final candidate evidence '${ev.id}' freshness '${ev.freshness}' must be 'fresh'`,
              path: ['evidence', i, 'freshness'],
            });
          }
        }
      }

      if (finalCandidateCount === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Cannot ACCEPT without at least one fresh passed final-candidate evidence receipt',
          path: ['evidence'],
        });
      }

      // All exceptions must be justified
      for (let i = 0; i < data.exceptions.length; i++) {
        const exc = data.exceptions[i];
        if (!exc.justified) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cannot ACCEPT with unjustified exception for rule '${exc.ruleId}'`,
            path: ['exceptions', i, 'justified'],
          });
        }
      }

      // Constraint coherence
      if (!data.constraintCoherence.coherent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cannot ACCEPT when constraintCoherence.coherent is false',
          path: ['constraintCoherence', 'coherent'],
        });
      }
      if (
        data.constraintCoherence.conflicts &&
        data.constraintCoherence.conflicts.length > 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cannot ACCEPT when constraint conflicts are present',
          path: ['constraintCoherence', 'conflicts'],
        });
      }

      // Handoff readiness
      if (!data.handoff.ready) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cannot ACCEPT when handoff.ready is false',
          path: ['handoff', 'ready'],
        });
      }
      if (data.handoff.verificationSteps.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Cannot ACCEPT when handoff.verificationSteps has no verification steps',
          path: ['handoff', 'verificationSteps'],
        });
      }

      // Lifecycle stage & receipt agreement
      if (data.lifecycle.stage !== 'completed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Cannot ACCEPT when lifecycle.stage is '${data.lifecycle.stage}' (must be 'completed')`,
          path: ['lifecycle', 'stage'],
        });
      }
      if (!data.lifecycle.receiptAgreement) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cannot ACCEPT when lifecycle.receiptAgreement is false',
          path: ['lifecycle', 'receiptAgreement'],
        });
      }
    }
  },
);

export type OutcomeReview = z.infer<typeof OutcomeReviewSchema>;
