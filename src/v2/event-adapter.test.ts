/**
 * Tests for the v2 → v1 event mapper.
 *
 * The synthesized v1 shapes here are pinned to what the v1 consumers
 * actually read:
 * - `session.created` early registration (task-session-manager
 *   event-router): `properties.info.{id,parentID,agent?}` — plugin
 *   relevance is gated on `info.parentID` (child sessions only).
 * - `message.updated` telemetry (cache-monitor parseCompletedAssistantMessage):
 *   `properties.info.{role:'assistant', sessionID, id, time.completed,
 *   tokens.input, tokens.cache.read, tokens.cache.write}`.
 */
import { describe, expect, test } from 'bun:test';
import { createCacheMonitorHook } from '../hooks/cache-monitor';
import { mapV2EventToV1 } from './event-adapter';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function v2Usage(overrides: {
  input: number;
  read: number;
  write?: number;
  timestamp?: number;
}): Record<string, unknown> {
  return {
    type: 'session.usage.updated',
    properties: deepFreeze({
      sessionID: 'ses_map',
      ...(overrides.timestamp !== undefined
        ? { timestamp: overrides.timestamp }
        : {}),
      tokens: {
        input: overrides.input,
        output: 5,
        reasoning: 0,
        cache: { read: overrides.read, write: overrides.write ?? 0 },
      },
    }),
  };
}

describe('mapV2EventToV1', () => {
  test('passes unknown events through unchanged (raw reference first)', () => {
    const ev = { type: 'permission.asked', properties: { sessionID: 's' } };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ev);
  });

  test('never mutates the input event', () => {
    const ev = deepFreeze(
      v2Usage({ input: 10, read: 100, write: 20, timestamp: 1_700_000_000 }),
    );
    expect(() => mapV2EventToV1(ev)).not.toThrow();
  });

  test('synthesizes session.idle from idle session.status', () => {
    const ev = {
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'idle' } },
    };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    expect(out[1]).toEqual({
      type: 'session.idle',
      properties: { sessionID: 's' },
    });
  });

  test('busy status does not synthesize idle', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status',
        properties: { sessionID: 's', status: { type: 'busy' } },
      }),
    ).toHaveLength(1);
  });

  test('idle status without a sessionID does not synthesize idle', () => {
    expect(
      mapV2EventToV1({
        type: 'session.status',
        properties: { status: { type: 'idle' } },
      }),
    ).toHaveLength(1);
  });

  test('maps session.created with parentID into v1 early-registration shape', () => {
    const ev = {
      type: 'session.created',
      properties: { sessionID: 'child_1', parentID: 'parent_1', title: 't' },
    };
    const out = mapV2EventToV1(ev);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(ev);
    // Exact shape event-router reads: info.id + info.parentID gate the
    // early board registration; info.agent disambiguates parallel task
    // calls (absent here → omitted).
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: { info: { id: 'child_1', parentID: 'parent_1', title: 't' } },
    });
  });

  test('passes agent through on session.created when the host provides it', () => {
    const out = mapV2EventToV1({
      type: 'session.created',
      properties: {
        sessionID: 'child_1',
        parentID: 'parent_1',
        agent: 'fixer',
      },
    });
    expect(out[1]).toEqual({
      type: 'session.created',
      properties: {
        info: { id: 'child_1', parentID: 'parent_1', agent: 'fixer' },
      },
    });
  });

  test('session.created without parentID stays passthrough-only', () => {
    // Root sessions are not plugin-relevant for early registration —
    // event-router gates on info.parentID, so no v1 shape is synthesized.
    expect(
      mapV2EventToV1({
        type: 'session.created',
        properties: { sessionID: 'root_1', title: 't' },
      }),
    ).toHaveLength(1);
  });

  test('maps usage telemetry into v1 message.updated shape for cache-monitor', () => {
    const out = mapV2EventToV1(v2Usage({ input: 10, read: 100, write: 20 }));
    expect(out).toHaveLength(2);
    // Exact field paths parseCompletedAssistantMessage reads. The id is a
    // deterministic fingerprint (v2 usage events carry no message id) so
    // replays and the step.ended/usage.updated pair for one request dedup.
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_map:10:5:100:20',
          role: 'assistant',
          sessionID: 'ses_map',
          time: { completed: 0 },
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: { read: 100, write: 20 },
          },
        },
      },
    });
  });

  test('maps session.step.ended telemetry with timestamp passthrough', () => {
    const out = mapV2EventToV1({
      type: 'session.step.ended',
      properties: {
        sessionID: 'ses_map',
        timestamp: 1_700_000_000,
        tokens: { input: 7, output: 3, cache: { read: 40, write: 5 } },
      },
    });
    expect(out[1]).toEqual({
      type: 'message.updated',
      properties: {
        info: {
          id: 'v2-usage:ses_map:7:3:40:5',
          role: 'assistant',
          sessionID: 'ses_map',
          time: { completed: 1_700_000_000 },
          tokens: {
            input: 7,
            output: 3,
            reasoning: 0,
            cache: { read: 40, write: 5 },
          },
        },
      },
    });
  });

  test('usage telemetry with incomplete tokens synthesizes nothing', () => {
    // Fail-open like the consumers: partial token blocks are dropped
    // rather than mapped into a shape cache-monitor would half-read.
    expect(
      mapV2EventToV1({
        type: 'session.usage.updated',
        properties: { sessionID: 's', tokens: { input: 10 } },
      }),
    ).toHaveLength(1);
    expect(
      mapV2EventToV1({
        type: 'session.usage.updated',
        properties: { sessionID: 's' },
      }),
    ).toHaveLength(1);
  });

  test('mapped message.updated feeds the real cache-monitor (bust warning fires)', async () => {
    const warnings: string[] = [];
    const monitor = createCacheMonitorHook({
      logger: (message) => warnings.push(message),
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 8000, read: 0, write: 7000 }))[1],
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 500, read: 9000 }))[1],
    });
    await monitor.event({
      event: mapV2EventToV1(v2Usage({ input: 12000, read: 0 }))[1],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('prompt-cache bust');
  });
});
