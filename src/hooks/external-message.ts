import { isRecord } from '../utils/guards';
import {
  INTERNAL_INITIATOR_METADATA_KEY,
  isInternalInitiatorPart,
} from '../utils/internal-initiator';

function hasInternalMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  return [
    INTERNAL_INITIATOR_METADATA_KEY,
    'compaction_continue',
    'oh-my-opencode-slim.backgroundJobBoard',
  ].some((key) => metadata[key] === true);
}

export function isInternalOrSyntheticPart(part: unknown): boolean {
  return (
    isRecord(part) &&
    (part.synthetic === true ||
      isInternalInitiatorPart(part) ||
      hasInternalMetadata(part.metadata) ||
      hasInternalMetadata(part.providerMetadata))
  );
}

/** The entire authoritative message must have external provenance. */
export function externalMessage(input: unknown, output: unknown) {
  if (!isRecord(input)) return undefined;
  const out = isRecord(output) ? output : undefined;
  const message = isRecord(out?.message) ? out.message : undefined;
  const parts = Array.isArray(out?.parts) ? out.parts : input.parts;
  const id = typeof message?.id === 'string' ? message.id : input.messageID;
  const sessionID =
    typeof message?.sessionID === 'string'
      ? message.sessionID
      : input.sessionID;
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    typeof sessionID !== 'string' ||
    (message?.role !== undefined && message.role !== 'user') ||
    isInternalOrSyntheticPart(input) ||
    isInternalOrSyntheticPart(message) ||
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some(isInternalOrSyntheticPart) ||
    !parts.every(isRecord)
  ) {
    return undefined;
  }
  return { sessionID, messageID: id.trim(), parts };
}
