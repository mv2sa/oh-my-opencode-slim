import type { z } from 'zod';
import { type OutcomeReview, OutcomeReviewSchema } from './schema';

export const OUTCOME_REVIEW_OPEN_TAG = '<outcome_review>';
export const OUTCOME_REVIEW_CLOSE_TAG = '</outcome_review>';

export class OutcomeParseError extends Error {
  constructor(
    message: string,
    public readonly issues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'OutcomeParseError';
  }
}

export type ParseOutcomeResult =
  | { success: true; data: OutcomeReview }
  | { success: false; error: string; issues?: z.ZodIssue[] };

/**
 * Parses and validates an outcome review payload from text.
 * Strictly extracts exactly one `<outcome_review>` envelope and validates it
 * against the OutcomeReviewSchema with all structural and semantic invariants.
 *
 * @throws {OutcomeParseError} when parsing or validation fails.
 */
export function parseOutcomeReview(text: string): OutcomeReview {
  if (typeof text !== 'string') {
    throw new OutcomeParseError('Input must be a string');
  }

  const openMatches = [...text.matchAll(/<outcome_review>/gi)];
  const closeMatches = [...text.matchAll(/<\/outcome_review>/gi)];

  if (openMatches.length === 0 && closeMatches.length === 0) {
    throw new OutcomeParseError('Missing <outcome_review> envelope');
  }

  if (openMatches.length !== 1 || closeMatches.length !== 1) {
    if (openMatches.length > 1 || closeMatches.length > 1) {
      throw new OutcomeParseError(
        'Multiple <outcome_review> envelopes found; exactly one is required',
      );
    }
    throw new OutcomeParseError(
      'Mismatched <outcome_review> envelope tags in text',
    );
  }

  const openIndex = openMatches[0].index;
  const closeIndex = closeMatches[0].index;

  if (openIndex === undefined || closeIndex === undefined) {
    throw new OutcomeParseError('Invalid envelope index');
  }

  if (closeIndex <= openIndex) {
    throw new OutcomeParseError(
      'Malformed <outcome_review> envelope: closing tag appears before opening tag',
    );
  }

  const innerContent = text
    .slice(openIndex + OUTCOME_REVIEW_OPEN_TAG.length, closeIndex)
    .trim();

  if (innerContent.length === 0) {
    throw new OutcomeParseError('Empty <outcome_review> envelope');
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(innerContent);
  } catch (error) {
    throw new OutcomeParseError(
      `Malformed JSON inside <outcome_review> envelope: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const result = OutcomeReviewSchema.safeParse(rawJson);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new OutcomeParseError(
      `Outcome review validation failed: ${errorDetails}`,
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * Safe version of parseOutcomeReview returning a result object instead of throwing.
 */
export function safeParseOutcomeReview(text: string): ParseOutcomeResult {
  try {
    const data = parseOutcomeReview(text);
    return { success: true, data };
  } catch (error) {
    if (error instanceof OutcomeParseError) {
      return {
        success: false,
        error: error.message,
        issues: error.issues,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
