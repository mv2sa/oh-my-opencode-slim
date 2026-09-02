import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { OutcomeController } from '../outcome/controller';

const z = tool.schema;

export interface OutcomeControlToolOptions {
  controller: OutcomeController;
  shouldManageSession: (sessionID: string) => boolean;
  resolveAgentName?: (agent: string) => string;
}

export function createOutcomeControlTool(
  options: OutcomeControlToolOptions,
): Record<'outcome_control', ToolDefinition> {
  const { controller } = options;

  const outcome_control = tool({
    description: `Authoritative outcome lifecycle and governance control tool for orchestrator.

Use this tool to establish durable outcome contracts (begin), open checkpoint reviews (checkpoint), submit evidence attestations (submit_evidence), register bounded repository waiver references (register_repository_waiver), reconcile Outcome Manager reviews (reconcile_review), update goal progress (update_goal_status), revise contracts with user provenance (revise_contract), resolve user decisions or Controller actions, complete external handoffs, finalize certified completion (finalize), or inspect status (status). Outcome Manager is not permitted to call this tool.`,
    args: {
      action: z
        .enum([
          'begin',
          'checkpoint',
          'submit_evidence',
          'reconcile_review',
          'resolve_user_decision',
          'register_repository_waiver',
          'external_handoff',
          'complete_external_handoff',
          'update_goal_status',
          'revise_contract',
          'resolve_action',
          'finalize',
          'status',
          'expire_checkpoint',
          'reconcile_uncertain',
          'acknowledge_operation',
        ])
        .describe('Outcome control action to execute'),
      contract: z
        .any()
        .optional()
        .describe('Complete OutcomeContract object for begin action'),
      outcomeId: z.string().optional().describe('Optional custom outcome ID'),
      kind: z
        .enum(['kickoff', 'decision', 'exception', 'final'])
        .optional()
        .describe('Checkpoint kind for action="checkpoint"'),
      reason: z.string().optional().describe('Reason for checkpoint or expiry'),
      candidateFingerprint: z
        .string()
        .optional()
        .describe('Candidate git sha or deliverable fingerprint'),
      decisionIds: z
        .array(z.string())
        .optional()
        .describe('Decision IDs included in checkpoint'),
      exceptionRuleIds: z
        .array(z.string())
        .optional()
        .describe('Exception rule IDs included in checkpoint'),
      evidenceAttestationIds: z
        .array(z.string())
        .optional()
        .describe('Evidence attestation IDs included in checkpoint'),
      expiresInMs: z
        .number()
        .optional()
        .describe('Optional checkpoint timeout in milliseconds'),
      description: z
        .string()
        .optional()
        .describe('Description or command for evidence attestation'),
      assertedStatus: z
        .enum(['passed', 'failed', 'stale', 'pending'])
        .optional()
        .describe('Asserted status for evidence attestation'),
      assertedFreshness: z
        .enum(['fresh', 'stale', 'unknown'])
        .optional()
        .describe('Asserted freshness for evidence attestation'),
      linkedObservationId: z
        .string()
        .optional()
        .describe('Optional linked tool observation ID'),
      checkpointId: z
        .string()
        .optional()
        .describe('Checkpoint ID for reconciliation or expiry'),
      managerTaskId: z
        .string()
        .optional()
        .describe('Bound Manager child task ID for reconciliation'),
      managerGeneration: z
        .number()
        .optional()
        .describe('Manager generation for reconciliation'),
      decisionId: z
        .string()
        .optional()
        .describe('Decision ID for resolve_user_decision'),
      chosenOption: z
        .string()
        .optional()
        .describe('Chosen option string for resolve_user_decision'),
      sourceUserMessageReceiptId: z
        .string()
        .optional()
        .describe('Observed user message receipt ID for decision resolution'),
      goalId: z.string().optional().describe('Goal ID for progress update'),
      goalStatus: z
        .enum(['satisfied'])
        .optional()
        .describe('Bounded goal status update'),
      actionId: z
        .string()
        .optional()
        .describe('Required Controller action ID to resolve'),
      evidenceAttestationId: z
        .string()
        .optional()
        .describe('Evidence attestation for external handoff completion'),
      authorizationKind: z
        .enum(['user_decision'])
        .optional()
        .describe('User-decision authorization for decision resolution'),
      repositoryReference: z
        .string()
        .optional()
        .describe('Repository waiver reference to register'),
      handoffKind: z
        .enum(['restart_current_opencode'])
        .optional()
        .describe('External handoff kind'),
      instructions: z
        .string()
        .optional()
        .describe('Instructions for external handoff'),
      expectedPostRestartCheck: z
        .string()
        .optional()
        .describe('Expected verification check after restart'),
      summary: z
        .string()
        .optional()
        .describe('Summary for finalization certificate'),
      operationId: z
        .string()
        .optional()
        .describe('Operation ID for acknowledge_operation'),
      resolutionEvidenceAttestationIds: z
        .array(z.string())
        .optional()
        .describe('Evidence provenance for action resolution'),
      resolution: z
        .any()
        .optional()
        .describe('Resolution object for reconcile_uncertain'),
    },
    async execute(args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) throw new Error('outcome_control requires sessionID');
      const rawAgent = toolContext?.agent;
      if (!rawAgent || typeof rawAgent !== 'string' || rawAgent.trim() === '') {
        throw new Error('outcome_control requires an explicit caller agent');
      }
      const agent = options.resolveAgentName?.(rawAgent) ?? rawAgent;

      if (agent !== 'orchestrator') {
        throw new Error(
          `outcome_control can only be used by orchestrator (called by '${rawAgent}')`,
        );
      }
      if (!options.shouldManageSession(sessionID)) {
        throw new Error(
          `outcome_control requires an active managed orchestrator session; '${sessionID}' is not managed`,
        );
      }

      switch (args.action) {
        case 'status': {
          const status = controller.getStatus(sessionID);
          return JSON.stringify(status, null, 2);
        }
        case 'begin': {
          if (!args.contract) {
            throw new Error('outcome_control action="begin" requires contract');
          }
          if (args.contract.classification !== 'non_trivial') {
            throw new Error(
              'outcome_control requires explicit classification="non_trivial"',
            );
          }
          const res = controller.begin(sessionID, args.contract, {
            outcomeId: args.outcomeId,
          });
          if (!res.success) {
            throw new Error(`begin failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'checkpoint': {
          if (!args.kind || !args.reason) {
            throw new Error(
              'outcome_control action="checkpoint" requires kind and reason',
            );
          }
          const res = controller.checkpoint(sessionID, {
            kind: args.kind,
            reason: args.reason,
            candidateFingerprint: args.candidateFingerprint,
            decisionIds: args.decisionIds,
            exceptionRuleIds: args.exceptionRuleIds,
            evidenceAttestationIds: args.evidenceAttestationIds,
            expiresInMs: args.expiresInMs,
          });
          if (!res.success) {
            throw new Error(`checkpoint failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'submit_evidence': {
          if (
            !args.description ||
            !args.assertedStatus ||
            !args.assertedFreshness ||
            !args.candidateFingerprint
          ) {
            throw new Error(
              'outcome_control action="submit_evidence" requires description, assertedStatus, assertedFreshness, and candidateFingerprint',
            );
          }
          const res = controller.submitEvidence(sessionID, {
            description: args.description,
            assertedStatus: args.assertedStatus,
            assertedFreshness: args.assertedFreshness,
            candidateFingerprint: args.candidateFingerprint,
            linkedObservationId: args.linkedObservationId,
          });
          if (!res.success) {
            throw new Error(`submit_evidence failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'reconcile_review': {
          if (!args.checkpointId || !args.managerTaskId) {
            throw new Error(
              'outcome_control action="reconcile_review" requires checkpointId and managerTaskId',
            );
          }
          const res = await controller.reconcileReview(sessionID, {
            checkpointId: args.checkpointId,
            managerTaskId: args.managerTaskId,
            managerGeneration: args.managerGeneration,
          });
          if (!res.success) {
            throw new Error(`reconcile_review failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'resolve_user_decision': {
          if (
            !args.decisionId ||
            !args.chosenOption ||
            !args.sourceUserMessageReceiptId
          ) {
            throw new Error(
              'outcome_control action="resolve_user_decision" requires decisionId, chosenOption, and sourceUserMessageReceiptId',
            );
          }
          const res = controller.resolveUserDecision(sessionID, {
            decisionId: args.decisionId,
            chosenOption: args.chosenOption,
            sourceUserMessageReceiptId: args.sourceUserMessageReceiptId,
            authorizationKind: args.authorizationKind,
          });
          if (!res.success) {
            throw new Error(`resolve_user_decision failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'register_repository_waiver': {
          if (!args.repositoryReference) {
            throw new Error(
              'outcome_control action="register_repository_waiver" requires repositoryReference',
            );
          }
          const res = controller.registerRepositoryWaiver(sessionID, {
            repositoryReference: args.repositoryReference,
          });
          if (!res.success) {
            throw new Error(`register_repository_waiver failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'external_handoff': {
          const handoffKind = args.handoffKind ?? 'restart_current_opencode';
          const res = controller.externalHandoff(sessionID, {
            kind: handoffKind,
            reason: args.reason,
            instructions: args.instructions,
            expectedPostRestartCheck: args.expectedPostRestartCheck,
          });
          if (!res.success) {
            throw new Error(`external_handoff failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'complete_external_handoff': {
          if (!args.sourceUserMessageReceiptId || !args.evidenceAttestationId) {
            throw new Error(
              'outcome_control action="complete_external_handoff" requires sourceUserMessageReceiptId and evidenceAttestationId',
            );
          }
          const res = controller.completeExternalHandoff(sessionID, {
            sourceUserMessageReceiptId: args.sourceUserMessageReceiptId,
            evidenceAttestationId: args.evidenceAttestationId,
          });
          if (!res.success) {
            throw new Error(`complete_external_handoff failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'update_goal_status': {
          if (!args.goalId || !args.goalStatus) {
            throw new Error(
              'outcome_control action="update_goal_status" requires goalId and goalStatus',
            );
          }
          const res = controller.updateGoalStatus(sessionID, {
            goalId: args.goalId,
            status: args.goalStatus,
          });
          if (!res.success) {
            throw new Error(`update_goal_status failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'revise_contract': {
          if (!args.contract) {
            throw new Error(
              'outcome_control action="revise_contract" requires contract',
            );
          }
          const res = controller.reviseContract(sessionID, {
            contract: args.contract,
            sourceUserMessageReceiptId: args.sourceUserMessageReceiptId,
          });
          if (!res.success) {
            throw new Error(`revise_contract failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'resolve_action': {
          if (!args.actionId || !args.reason) {
            throw new Error(
              'outcome_control action="resolve_action" requires actionId and reason',
            );
          }
          const res = controller.resolveAction(sessionID, {
            actionId: args.actionId,
            reason: args.reason,
            sourceUserMessageReceiptId: args.sourceUserMessageReceiptId,
            evidenceAttestationIds: args.resolutionEvidenceAttestationIds,
          });
          if (!res.success) {
            throw new Error(`resolve_action failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'finalize': {
          if (!args.summary) {
            throw new Error(
              'outcome_control action="finalize" requires summary',
            );
          }
          const res = controller.finalize(sessionID, {
            summary: args.summary,
          });
          if (!res.success) {
            throw new Error(`finalize failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'expire_checkpoint': {
          if (!args.checkpointId || !args.reason) {
            throw new Error(
              'outcome_control action="expire_checkpoint" requires checkpointId and reason',
            );
          }
          const res = controller.expireCheckpoint(sessionID, {
            checkpointId: args.checkpointId,
            reason: args.reason,
          });
          if (!res.success) {
            throw new Error(`expire_checkpoint failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'reconcile_uncertain': {
          if (!args.checkpointId || !args.resolution) {
            throw new Error(
              'outcome_control action="reconcile_uncertain" requires checkpointId and resolution',
            );
          }
          const res = controller.reconcileUncertain(sessionID, {
            checkpointId: args.checkpointId,
            resolution: args.resolution,
          });
          if (!res.success) {
            throw new Error(`reconcile_uncertain failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        case 'acknowledge_operation': {
          if (!args.operationId) {
            throw new Error(
              'outcome_control action="acknowledge_operation" requires operationId',
            );
          }
          const res = controller.acknowledgeOperation(sessionID, {
            operationId: args.operationId,
          });
          if (!res.success) {
            throw new Error(`acknowledge_operation failed: ${res.error}`);
          }
          return JSON.stringify(res.data, null, 2);
        }
        default: {
          throw new Error(
            `Unknown outcome_control action: ${String(args.action)}`,
          );
        }
      }
    },
  });

  return { outcome_control };
}
