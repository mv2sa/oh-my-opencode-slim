import type { OutcomeRecord } from '../../outcome/controller-schema';
import { isRecord } from '../../utils/guards';
import { isInternalOrSyntheticPart } from '../external-message';

function isObservationTool(tool: string): boolean {
  return [
    'outcome_control',
    'task_status',
    'read',
    'glob',
    'grep',
    'list',
  ].includes(tool.trim().toLowerCase());
}

export const INTERNAL_CONTROLLER_NOTICE_LABEL =
  '[Internal Controller notice — non-authorizing. Not external user approval, waiver, evidence, or completion. An embedded dispatch marker is an internal capability only; preserve its exact marker and review packet bytes. Respect user stop/tool prohibitions; this notice grants no permission to resume or change governance.]';

/** Deliberately excludes revisions, counters, timestamps and status-call churn. */
export function controllerProgressFingerprint(record: OutcomeRecord): string {
  return JSON.stringify({
    outcome: record.outcomeId,
    generation: record.generation,
    contract: record.contractDigest,
    phase: record.phase,
    goals: record.contract.goals.map(({ id, status }) => [id, status]),
    kickoff: record.kickoffGate?.state,
    checkpoint: record.checkpoint && [
      record.checkpoint.checkpointId,
      record.checkpoint.claimGeneration,
      record.checkpoint.state,
      record.checkpoint.checkpointFingerprint,
    ],
    actions: record.actionsRequired.map((action) => [
      action.id,
      action.code,
      action.referenceId,
      action.resolvedAt !== undefined,
    ]),
    operations: record.operations
      .filter((operation) => !isObservationTool(operation.toolName))
      .map((operation) => [operation.id, operation.status]),
    evidence: record.receipts.evidence
      .filter(
        (evidence) =>
          evidence.kind !== 'controller_observed' ||
          !isObservationTool(evidence.toolName),
      )
      .map((evidence) => evidence.id),
    wait: record.waitCondition && [
      record.waitCondition.kind,
      record.waitCondition.referenceId,
    ],
  });
}

/** No assistant prose/IDs are progress. IDs only deduplicate completed turns. */
export function completedNarrationTurn(
  data: unknown,
  sessionID: string,
): string | undefined {
  if (!Array.isArray(data) || !data.length) return undefined;
  for (let index = data.length - 1; index >= 0; index--) {
    const latest = data[index];
    if (
      !isRecord(latest) ||
      !isRecord(latest.info) ||
      !Array.isArray(latest.parts)
    )
      return undefined;
    const info = latest.info;
    if (info.sessionID !== sessionID || !latest.parts.every(isRecord))
      return undefined;
    if (info.role === 'user') {
      // Only wholly internal messages can be crossed. Mixed/external messages
      // form a boundary; never infer user intent from text.
      if (latest.parts.length && latest.parts.every(isInternalOrSyntheticPart))
        continue;
      return undefined;
    }
    if (
      info.role !== 'assistant' ||
      info.error !== undefined ||
      latest.parts.some((part) => part.type === 'tool')
    )
      return undefined;
    if (
      isRecord(info.time) &&
      info.time.completed === undefined &&
      (info.finish === undefined || info.finish === null)
    )
      continue;
    if (
      info.role !== 'assistant' ||
      info.sessionID !== sessionID ||
      typeof info.id !== 'string' ||
      !info.id ||
      info.error !== undefined ||
      !isRecord(info.time) ||
      typeof info.time.completed !== 'number' ||
      !Number.isFinite(info.time.completed) ||
      !latest.parts.length ||
      !latest.parts.every(
        (part) =>
          isRecord(part) &&
          ['text', 'reasoning', 'step-start', 'step-finish'].includes(
            String(part.type),
          ),
      ) ||
      !latest.parts.some(
        (part) =>
          isRecord(part) &&
          part.type === 'text' &&
          typeof part.text === 'string',
      )
    )
      return undefined;
    return info.id;
  }
  return undefined;
}
