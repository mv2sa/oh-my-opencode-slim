import { describe, expect, test } from 'bun:test';
import { classifyFailure, classifyUncapped } from './classify-failure';

const HOUR = 60 * 60 * 1000;

describe('classifyFailure', () => {
  test('request-fatal failures never cool down', () => {
    expect(classifyFailure({ statusCode: 413 }).cooldownMs).toBe(0);
    expect(classifyFailure('maximum context length exceeded')).toEqual(
      expect.objectContaining({ class: 'request-fatal', cooldownMs: 0 }),
    );
  });

  for (const [limitName, cooldownMs] of [
    ['5 hour', 5 * HOUR],
    ['weekly', 7 * 24 * HOUR],
    ['monthly', 7 * 24 * HOUR],
  ] as const) {
    test(`classifies GoUsageLimitError ${limitName}`, () => {
      expect(
        classifyUncapped({
          data: {
            responseBody: JSON.stringify({
              error: { type: 'GoUsageLimitError', metadata: { limitName } },
            }),
          },
        }),
      ).toEqual(expect.objectContaining({ class: 'quota', cooldownMs }));
    });
  }

  for (const [delay, cooldownMs] of [
    ['16s', 16_000],
    ['1.5s', 1500],
  ] as const) {
    test(`uses RESOURCE_EXHAUSTED retry delay ${delay}`, () => {
      expect(
        classifyFailure({
          message: 'RESOURCE_EXHAUSTED',
          data: {
            responseBody: JSON.stringify({
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                  retryDelay: delay,
                },
              ],
            }),
          },
        }).cooldownMs,
      ).toBe(cooldownMs);
    });
  }

  test('classifies Copilot quota', () => {
    expect(
      classifyUncapped({ statusCode: 403, message: 'premium request quota' }),
    ).toEqual(
      expect.objectContaining({ class: 'quota', cooldownMs: 6 * HOUR }),
    );
    // ...and the production path caps it to the 5h re-probe ceiling.
    expect(
      classifyFailure({ statusCode: 403, message: 'premium request quota' })
        .cooldownMs,
    ).toBe(5 * HOUR);
  });

  test('clamps retry-after to five seconds', () => {
    expect(
      classifyFailure({ statusCode: 429, headers: { 'retry-after': '1' } }),
    ).toEqual(
      expect.objectContaining({ class: 'rate-limit', cooldownMs: 5000 }),
    );
  });

  test('uses now for an HTTP-date retry-after', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(
      classifyFailure(
        {
          statusCode: 429,
          headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:16 GMT' },
        },
        now,
      ).cooldownMs,
    ).toBe(16_000);
  });

  test('classifies transient status, code, and bare string', () => {
    expect(classifyFailure({ statusCode: 503 }).class).toBe('transient');
    expect(classifyFailure({ code: 'EPIPE' }).cooldownMs).toBe(30_000);
    expect(classifyFailure('fetch failed').class).toBe('transient');
  });

  test('unknown failures do not cool down', () => {
    expect(classifyFailure('unrelated application error')).toEqual(
      expect.objectContaining({ class: 'unknown', cooldownMs: 0 }),
    );
  });

  test('recognized bare rate-limit text receives a durable cooldown', () => {
    expect(classifyFailure('rate limit exceeded')).toEqual(
      expect.objectContaining({ class: 'transient', cooldownMs: 300_000 }),
    );
  });

  test('persists a default cooldown for a bare HTTP 429', () => {
    expect(classifyFailure({ statusCode: 429 })).toEqual({
      class: 'rate-limit',
      cooldownMs: 60_000,
      reason: 'HTTP 429 rate limit',
    });
  });

  test('recognizes rate-limit payloads wrapped in HTTP 400', () => {
    expect(
      classifyFailure({
        statusCode: 400,
        data: { responseBody: 'provider rate limit exceeded' },
      }),
    ).toEqual(
      expect.objectContaining({ class: 'transient', cooldownMs: 300_000 }),
    );
  });

  test('classifies structured quota payloads before generic HTTP 400 handling', () => {
    expect(
      classifyFailure({
        statusCode: 400,
        data: {
          responseBody: JSON.stringify({
            error: {
              type: 'GoUsageLimitError',
              metadata: { limitName: 'monthly' },
            },
          }),
        },
      }),
    ).toEqual(
      expect.objectContaining({
        class: 'quota',
        cooldownMs: 7 * 24 * HOUR,
      }),
    );
  });

  test('caps long Retry-After values instead of dropping the cooldown', () => {
    expect(
      classifyFailure({
        statusCode: 429,
        headers: { 'retry-after': '300' },
      }),
    ).toEqual(
      expect.objectContaining({ class: 'rate-limit', cooldownMs: 300_000 }),
    );
  });

  test('persists cooldowns for other recognized failover shapes', () => {
    for (const shape of [
      { code: 'EAI_AGAIN' },
      { statusCode: 401 },
      { statusCode: 410 },
      'no available channel',
      'authentication unavailable',
      'model not found',
      'high concurrency; reduce concurrency',
      'provider unavailable',
      'unsupported model',
      'unknown model',
      'model reached its end of life',
      'provider request timeout',
      'connect ECONNREFUSED 127.0.0.1',
      'getaddrinfo ENOTFOUND provider.example',
      'upstream returned 401',
      'upstream returned 410',
    ]) {
      expect(classifyFailure(shape).cooldownMs).toBeGreaterThan(0);
    }
  });

  // Regression: Zen / Zen Go report usage limits as a plain message, not a JSON
  // body. This exact string was observed live from opencode-go and previously
  // classified as `unknown` with cooldownMs 0 — i.e. no cooldown at all.
  // Asserted against classifyUncapped: the 5h ceiling would otherwise collapse
  // every window to the same value and leave this parsing untested.
  test('parses the stated reset window from plain-text Zen usage limits', () => {
    const real =
      'AI_APICallError: Monthly usage limit reached. Resets in 13 days. To continue ' +
      'using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01K/go';
    const DAY = 24 * HOUR;

    for (const shape of [
      real,
      { message: real },
      { data: { message: real } },
      { statusCode: 429, message: real },
    ]) {
      // monthly takes precedence over the stated "Resets in 13 days"
      expect(classifyUncapped(shape)).toEqual(
        expect.objectContaining({ class: 'quota', cooldownMs: 7 * DAY }),
      );
    }

    // Falls back to the named window when no explicit reset is given.
    expect(classifyUncapped('Weekly usage limit reached.').cooldownMs).toBe(
      7 * DAY,
    );
    expect(classifyUncapped('Monthly usage limit reached.').cooldownMs).toBe(
      7 * DAY,
    );
    // Non-monthly windows still honour the stated reset, incl. the day multiplier.
    expect(
      classifyUncapped('Usage limit reached. Resets in 2 days.').cooldownMs,
    ).toBe(2 * DAY);
    expect(
      classifyUncapped('Usage limit reached. Resets in 3 hours.').cooldownMs,
    ).toBe(3 * HOUR);
  });

  // Regression: observed live from Zen-proper. Arrives as a bare message with no
  // statusCode, and previously classified as `unknown` with cooldownMs 0 in every
  // shape except the one that happened to carry statusCode 402.
  test('classifies insufficient balance regardless of status code', () => {
    const real =
      'AI_APICallError: Insufficient balance. Manage your billing here: ' +
      'https://opencode.ai/workspace/wrk_01K/billing';

    for (const shape of [
      real,
      { message: real },
      { data: { message: real } },
      { statusCode: 402, message: real },
    ]) {
      expect(classifyUncapped(shape)).toEqual(
        expect.objectContaining({ class: 'quota', cooldownMs: 24 * HOUR }),
      );
    }
  });

  test('classifies exact Antigravity quota messages and compact resets', () => {
    const cases = [
      [
        'All 1 account(s) rate-limited for claude. Quota resets in 1h 50m. Add more accounts.',
        110 * 60 * 1000,
      ],
      [
        'Quota protection: All 1 account(s) are over 90% usage for claude. Quota resets in 3h 41m.',
        221 * 60 * 1000,
      ],
      ['Individual quota reached. Please upgrade your subscription.', HOUR],
      ['All 1 account(s) rate-limited. Quota resets in 33m.', 33 * 60 * 1000],
      ['All 1 account(s) rate-limited. Quota resets in 2d 4h.', 5 * HOUR],
    ] as const;

    for (const [message, cooldownMs] of cases) {
      for (const shape of [
        message,
        { message },
        { data: { message } },
        { statusCode: 429, message },
      ]) {
        expect(classifyFailure(shape)).toEqual(
          expect.objectContaining({ class: 'quota', cooldownMs }),
        );
      }
    }
  });

  // A cooldown is a probe deferral, not a ban. Long stated windows must be capped
  // so a model is never silently stranded for days when a re-probe would have
  // recovered it — quota granted early, balance topped up, or a short window
  // misparsed as a long one.
  test('caps long cooldowns at 5h while leaving shorter ones untouched', () => {
    const FIVE_H = 5 * HOUR;

    // Monthly is the one documented exemption: a sustained condition, so 7d
    // rather than a pointless 5h re-probe loop for a fortnight.
    const monthly = classifyFailure(
      'Monthly usage limit reached. Resets in 13 days.',
    );
    expect(monthly.class).toBe('quota');
    expect(monthly.cooldownMs).toBe(7 * 24 * HOUR);
    expect(monthly.reason).not.toContain('capped');

    expect(classifyFailure('Insufficient balance.').cooldownMs).toBe(FIVE_H);

    // Shorter than the cap -> passed through unchanged, reason not annotated.
    const short = classifyFailure('Usage limit reached. Resets in 3 hours.');
    expect(short.cooldownMs).toBe(3 * HOUR);
    expect(short.reason).not.toContain('capped');

    // Non-quota classes are unaffected by the ceiling.
    expect(classifyFailure({ statusCode: 503 }).cooldownMs).toBe(30_000);
    expect(classifyFailure({ statusCode: 400 }).cooldownMs).toBe(0);
  });
});
