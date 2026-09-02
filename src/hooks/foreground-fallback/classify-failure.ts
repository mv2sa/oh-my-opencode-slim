export type FailureClass =
  | 'quota'
  | 'rate-limit'
  | 'transient'
  | 'request-fatal'
  | 'unknown';

export interface FailureVerdict {
  class: FailureClass;
  cooldownMs: number;
  reason: string;
}

const HOUR_MS = 60 * 60 * 1000;
const OUTAGE_STATUS_CODES = new Set([500, 502, 503, 504]);
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);

const RECOGNIZED_FAILOVER_TEXT =
  /\b429\b|rate.?limit|too many requests|quota|quota.?threshold|usage limit|usage.?exceeded|ExceededBudget|over.?budget|overloaded|resource.?exhausted|high concurrency|reduce concurrency|service unavailable|internal server error|bad gateway|gateway timeout|upstream outage|provider outage|provider unavailable|no available channel|auth(?:entication)? unavailable|no auth available|auth_unavailable|cannot connect to (?:the )?api|provider request timeout|request timeout|model.*not available|unsupported model|unknown model|model not found|end of life|no longer available|blocked by gateway|forbidden|gone/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function retryDelayMs(value: unknown, now: number): number | undefined {
  if (typeof value === 'number') return value * 1000;
  if (typeof value !== 'string') return undefined;
  if (/^\d+(?:\.\d+)?s$/.test(value)) return Number.parseFloat(value) * 1000;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number.parseFloat(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Parse compact provider durations such as `1h 50m`, `33m`, or `2d 4h`. */
function compactDurationMs(value: string): number | undefined {
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])\b/gi)];
  if (matches.length === 0) return undefined;
  let total = 0;
  for (const match of matches) {
    const amount = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier =
      unit === 'd'
        ? 24 * HOUR_MS
        : unit === 'h'
          ? HOUR_MS
          : unit === 'm'
            ? 60 * 1000
            : 1000;
    total += amount * multiplier;
  }
  return total > 0 ? total : undefined;
}

/**
 * Hard ceiling on any cooldown.
 *
 * A cooldown is a PROBE DEFERRAL, not a ban. The failure modes are asymmetric:
 * an over-long cooldown silently strands a healthy model for days (quota granted
 * early, balance topped up, a shorter window misparsed as a longer one), while
 * an over-short one costs a single fast-failing call that immediately re-cools.
 *
 * 5h is Zen Go's own shortest reset window, giving the rule a natural form:
 * never sideline a model for longer than the provider's shortest window.
 */
const MAX_COOLDOWN_MS = 5 * HOUR_MS;

/**
 * Monthly-window exhaustion is the one case allowed past {@link MAX_COOLDOWN_MS}.
 *
 * A monthly cap is a sustained condition, not a transient one: re-probing it
 * every 5h for a fortnight buys nothing but a few hundred failed calls. 7 days
 * is the deliberate middle ground — long enough to stop pointless probing, short
 * enough that the model is never stranded for the provider's full stated window
 * (observed: 13 days) if balance is enabled or quota is granted early.
 */
const MONTHLY_COOLDOWN_MS = 7 * 24 * HOUR_MS;

/** Marker used to exempt monthly verdicts from the 5h ceiling. */
const MONTHLY_REASON = 'monthly usage limit';

export function classifyFailure(
  error: unknown,
  now = Date.now(),
): FailureVerdict {
  const verdict = classifyUncapped(error, now);
  const ceiling = verdict.reason.includes(MONTHLY_REASON)
    ? MONTHLY_COOLDOWN_MS
    : MAX_COOLDOWN_MS;
  if (verdict.cooldownMs <= ceiling) return verdict;
  const label = ceiling === MONTHLY_COOLDOWN_MS ? '7d' : '5h';
  return {
    ...verdict,
    cooldownMs: ceiling,
    reason: `${verdict.reason} (stated window longer; capped to ${label} for re-probe)`,
  };
}

/**
 * Classification WITHOUT the {@link MAX_COOLDOWN_MS} ceiling applied.
 *
 * Exported for tests: the cap collapses every long window to 5h, which would
 * otherwise make the reset-window parsing (13 days vs 7 days vs 30 days)
 * indistinguishable and silently untested. Production code should call
 * {@link classifyFailure}.
 */
export function classifyUncapped(
  error: unknown,
  now = Date.now(),
): FailureVerdict {
  const root = object(error) ?? {};
  const data = object(root.data);
  const responseBody = data?.responseBody;
  let body = object(responseBody) ?? data ?? root;
  if (typeof responseBody === 'string') {
    try {
      body = object(JSON.parse(responseBody)) ?? body;
    } catch {
      // The plain response body is included in text below.
    }
  }
  const bodyError = object(body.error);
  const text = [
    typeof error === 'string' ? error : '',
    root.message,
    data?.message,
    typeof responseBody === 'string' ? responseBody : '',
    JSON.stringify(body),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const status = [root.statusCode, data?.statusCode].find(
    (value): value is number => typeof value === 'number',
  );
  const type = bodyError?.type ?? body.type;

  const recognizedFailover = RECOGNIZED_FAILOVER_TEXT.test(text);
  const requestFatalText =
    /context length|maximum context|too many tokens|content filter|content policy|invalid[_ ]request/i.test(
      text,
    );
  if (
    (status === 400 && !recognizedFailover && type === undefined) ||
    (status === 404 && !recognizedFailover) ||
    status === 413 ||
    status === 422 ||
    (requestFatalText && !recognizedFailover)
  ) {
    return { class: 'request-fatal', cooldownMs: 0, reason: 'request-fatal' };
  }

  if (
    type === 'FreeUsageLimitError' ||
    type === 'GoUsageLimitError' ||
    type === 'BlackUsageLimitError'
  ) {
    const metadata = object(bodyError?.metadata) ?? object(body.metadata);
    const limitName = metadata?.limitName;
    if (limitName === 'monthly') {
      return {
        class: 'quota',
        cooldownMs: MONTHLY_COOLDOWN_MS,
        reason: `${String(type)}: ${MONTHLY_REASON}`,
      };
    }
    const cooldownMs =
      limitName === '5 hour'
        ? 5 * HOUR_MS
        : limitName === 'weekly'
          ? 7 * 24 * HOUR_MS
          : HOUR_MS;
    return { class: 'quota', cooldownMs, reason: String(type) };
  }

  // Balance / billing exhaustion does NOT resolve on a timer — it needs human
  // action (top up, fix payment). Match on text regardless of status code: the
  // observed Zen error arrives as a bare message with no statusCode attached,
  // and cool down long so the lane stops being re-dialled for the whole session.
  if (
    /insufficient balance|insufficient funds|insufficient[_ ]quota|payment required/i.test(
      text,
    )
  ) {
    return {
      class: 'quota',
      cooldownMs: 24 * HOUR_MS,
      reason: 'insufficient balance / billing',
    };
  }

  // Antigravity's account-rotation layer emits plain-text quota errors rather
  // than HTTP/JSON rate-limit responses. Its reset uses compact durations
  // (`1h 50m`), so the generic long-form parser below cannot recognize it.
  if (
    /all \d+ account\(s\) rate-limited|quota protection:.*over \d+% usage|individual quota reached/i.test(
      text,
    )
  ) {
    const resetText = /quota resets? in\s+([^.;]+)/i.exec(text)?.[1] ?? '';
    return {
      class: 'quota',
      cooldownMs: compactDurationMs(resetText) ?? HOUR_MS,
      reason: 'Antigravity quota reached',
    };
  }

  // Zen / Zen Go report usage limits as a PLAIN MESSAGE, not a JSON body, e.g.
  //   "AI_APICallError: Monthly usage limit reached. Resets in 13 days."
  // The structured branch above never sees these, so match the text and prefer
  // the reset window the provider actually states over any assumed default.
  if (/usage limit (?:reached|exceeded)/i.test(text)) {
    // A monthly cap is a sustained condition, so it takes precedence over the
    // provider's stated reset (observed: "Resets in 13 days"). The fixed 7d
    // window avoids both stranding the model that long and re-probing it
    // pointlessly every few hours for a fortnight.
    if (/monthly/i.test(text)) {
      return {
        class: 'quota',
        cooldownMs: MONTHLY_COOLDOWN_MS,
        reason: MONTHLY_REASON,
      };
    }
    const reset =
      /resets?\s+in\s+(\d+(?:\.\d+)?)\s*(minute|hour|day|week|month)s?/i.exec(
        text,
      );
    let cooldownMs: number | undefined;
    if (reset) {
      const unit = reset[2].toLowerCase();
      const multiplier =
        unit === 'minute'
          ? 60 * 1000
          : unit === 'hour'
            ? HOUR_MS
            : unit === 'day'
              ? 24 * HOUR_MS
              : unit === 'week'
                ? 7 * 24 * HOUR_MS
                : 30 * 24 * HOUR_MS;
      cooldownMs = Number.parseFloat(reset[1]) * multiplier;
    } else if (/weekly/i.test(text)) {
      cooldownMs = 7 * 24 * HOUR_MS;
    } else if (/\b5\s*hour/i.test(text)) {
      cooldownMs = 5 * HOUR_MS;
    }
    return {
      class: 'quota',
      cooldownMs: cooldownMs ?? HOUR_MS,
      reason: 'usage limit reached',
    };
  }

  if (/RESOURCE_EXHAUSTED/.test(text)) {
    const details = Array.isArray(body.details)
      ? body.details
      : Array.isArray(bodyError?.details)
        ? bodyError.details
        : [];
    const retryInfo = details.find((detail) =>
      /RetryInfo$/.test(String(object(detail)?.['@type'] ?? '')),
    );
    return {
      class: 'quota',
      cooldownMs: retryDelayMs(object(retryInfo)?.retryDelay, now) ?? HOUR_MS,
      reason: 'RESOURCE_EXHAUSTED',
    };
  }

  if (
    (status === 402 || status === 403 || status === 429) &&
    /quota|premium request|insufficient_quota|billing/i.test(text)
  ) {
    return {
      class: 'quota',
      cooldownMs: 6 * HOUR_MS,
      reason: 'provider quota',
    };
  }

  const headers = object(data?.headers ?? root.headers);
  const retryMs = retryDelayMs(
    headers?.['retry-after'] ?? headers?.['Retry-After'] ?? body.retryDelay,
    now,
  );
  if (status === 429 && retryMs !== undefined && retryMs <= 120_000) {
    return {
      class: 'rate-limit',
      cooldownMs: Math.max(5000, retryMs),
      reason: 'retry-after',
    };
  }

  if (status === 429) {
    return {
      class: 'rate-limit',
      cooldownMs: Math.min(retryMs ?? 60_000, MAX_COOLDOWN_MS),
      reason: retryMs === undefined ? 'HTTP 429 rate limit' : 'retry-after',
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    status === 410 ||
    recognizedFailover
  ) {
    return {
      class: 'transient',
      cooldownMs: 300_000,
      reason: 'recognized provider failover',
    };
  }

  const code = [root.code, object(root.cause)?.code, data?.code].find(
    (value): value is string => typeof value === 'string',
  );
  if (
    (status !== undefined && OUTAGE_STATUS_CODES.has(status)) ||
    (code !== undefined && TRANSPORT_CODES.has(code)) ||
    /socket hang up|fetch failed|connect ECONNREFUSED|getaddrinfo ENOTFOUND|\b401\b|\b410\b/i.test(
      text,
    )
  ) {
    return {
      class: 'transient',
      cooldownMs: 30_000,
      reason: 'transient provider failure',
    };
  }

  return { class: 'unknown', cooldownMs: 0, reason: 'unknown failure' };
}
