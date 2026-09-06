/**
 * v2 → v1 event mapper for the v2 event pump.
 *
 * v2 renamed/re-shaped several server events the v1 hooks depend on:
 * - `session.idle` is gone (`session.status` with `status.type: 'idle'`);
 * - `session.created` carries flat `{sessionID, parentID?}` instead of
 *   v1's `properties.info` object;
 * - token/cache telemetry moved to `session.usage.updated` /
 *   `session.step.ended` (v2 has no `message.updated`).
 *
 * `mapV2EventToV1` is additive synthesis only: the first element of the
 * returned array is ALWAYS the raw input event, unmodified (byte-identical
 * reference), so v2-native handlers (interview bridge) and any v1 handler
 * already tolerant of the v2 shape keep seeing it. Synthesized v1-shape
 * events are appended after it.
 *
 * The synthesized shapes are pinned to what the v1 consumers actually read:
 * - `session.created` early registration (task-session-manager
 *   event-router): `properties.info.{id,parentID,agent?}` — plugin
 *   relevance is gated on `info.parentID` (child sessions only).
 * - `message.updated` telemetry (cache-monitor
 *   parseCompletedAssistantMessage): `properties.info.{role:'assistant',
 *   sessionID, id, time.completed, tokens.input, tokens.cache.read,
 *   tokens.cache.write}`.
 */

import { isRecord } from '../utils/guards';

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * v2 usage telemetry (`session.usage.updated` / `session.step.ended`)
 * → v1 completed-assistant `message.updated`.
 *
 * The documented v2 event carries no message identity, so `info.id` is a
 * deterministic fingerprint of the telemetry content: the
 * step.ended/usage.updated pair for one request dedups to a single
 * observation (cache-monitor dedups by message id), replays are stable,
 * and genuinely distinct token snapshots stay distinct. No wall-clock or
 * randomness — only fields already on the event.
 */
function usageToMessageUpdated(
  props: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sessionID = props.sessionID;
  if (typeof sessionID !== 'string') return undefined;
  const tokens = isRecord(props.tokens) ? props.tokens : undefined;
  if (!tokens) return undefined;
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  const input = finiteNumber(tokens.input);
  const cacheRead = finiteNumber(cache?.read);
  const cacheWrite = finiteNumber(cache?.write);
  // Fail-open like the consumer: incomplete token blocks are dropped,
  // never mapped into a half-readable shape.
  if (
    input === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const output = finiteNumber(tokens.output) ?? 0;
  const reasoning = finiteNumber(tokens.reasoning) ?? 0;
  const id = `v2-usage:${sessionID}:${input}:${output}:${cacheRead}:${cacheWrite}`;
  // cache-monitor only requires a non-null completed marker; prefer a
  // real timestamp from the event when the host provides one.
  const completedAt =
    finiteNumber(props.timestamp) ?? finiteNumber(props.activityAt) ?? 0;
  return {
    type: 'message.updated',
    properties: {
      info: {
        id,
        role: 'assistant',
        sessionID,
        time: { completed: completedAt },
        tokens: {
          input,
          output,
          reasoning,
          cache: { read: cacheRead, write: cacheWrite },
        },
      },
    },
  };
}

/**
 * Map one v2 server event into zero or more v1-shape events.
 *
 * Returns `[rawEvent, ...synthesizedV1Shapes]` — the raw event is always
 * first and never mutated. Synthesis:
 * - idle `session.status` → v1 `session.idle` `{sessionID}`;
 * - child `session.created` (parentID present) → v1 early-registration
 *   shape `{info: {id, parentID, title?, agent?}}`;
 * - usage telemetry → v1 completed-assistant `message.updated`.
 *
 * `interviewBridge.handleEvent` keeps receiving the RAW v2 event (the
 * setup pump dispatches it before iterating this array).
 */
export function mapV2EventToV1(
  event: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [event];
  const type = typeof event.type === 'string' ? event.type : '';
  const props = isRecord(event.properties) ? event.properties : {};

  if (type === 'session.status') {
    const statusType = isRecord(props.status)
      ? typeof props.status.type === 'string'
        ? props.status.type
        : undefined
      : undefined;
    if (statusType === 'idle' && typeof props.sessionID === 'string') {
      // Double-idle invariant: on v2 an idle-tolerant consumer that watches
      // BOTH the native `session.status` event and the synthesized
      // `session.idle` receives idle twice per session. Safe today because
      // every idle consumer is idempotent per session — idle-reconciliation
      // guards repeats via its per-session timer maps
      // (`idleReconcileTimers.has` / `childIdleReconcileTimers.has`,
      // idle-reconciliation.ts:42,64). Any NEW idle consumer must tolerate
      // duplicate idle delivery.
      out.push({
        type: 'session.idle',
        properties: { sessionID: props.sessionID },
      });
    }
  } else if (type === 'session.created') {
    // Only child sessions are plugin-relevant: event-router gates early
    // board registration on `info.parentID` + shouldManageSession(parent).
    // Root sessions pass through untouched — no invented fields.
    if (
      typeof props.sessionID === 'string' &&
      typeof props.parentID === 'string'
    ) {
      const info: Record<string, unknown> = {
        id: props.sessionID,
        parentID: props.parentID,
      };
      if (typeof props.title === 'string') info.title = props.title;
      // event-router matches parallel task calls by child agent; pass the
      // host-provided value through when present, never fabricate one.
      if (typeof props.agent === 'string') info.agent = props.agent;
      out.push({ type: 'session.created', properties: { info } });
    }
  } else if (
    type === 'session.usage.updated' ||
    type === 'session.step.ended'
  ) {
    const mapped = usageToMessageUpdated(props);
    if (mapped) out.push(mapped);
  }

  return out;
}
