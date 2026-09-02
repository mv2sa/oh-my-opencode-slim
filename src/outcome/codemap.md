# src/outcome/

## Responsibility

Defines the compact runtime-validated review contract, schemas, types, and strict parser for the Outcome Manager subagent (`outcome-manager`). It validates outcome evaluations, scope boundaries, governance rule receipts, deterministic evidence receipts, constraint coherence, external waiver authorizations, user handoff readiness, and lifecycle stage agreement.

## Design

### Strict Review Contract

The contract defines a single `<outcome_review>` JSON envelope with strict Zod validation (`OutcomeReviewSchema`):

- **Verdicts**: `CONTINUE`, `CORRECT_DRIFT`, `REVISE_CONTRACT`, `USER_DECISION_REQUIRED`, `ACCEPT`.
- **Candidate Fingerprint**: Required on `ACCEPT` to bind final-candidate evidence receipts to the evaluated deliverable.
- **Rule Receipts**: Distinguishes `machine_enforced` vs `semantic` rules, recording source path, category, summary, enforcement status, and referenced evidence IDs.
- **Evidence Receipts**: Records deterministic validation command, candidate fingerprint, freshness (`fresh`, `stale`, `unknown`), `isFinalCandidate` flag, and execution status (`passed`, `failed`, `stale`, `pending`).
- **External Waiver Authorization**: Enforces strict external authority (`repository_waiver` or `user_decision`) with an explicit reference ID for every waived rule.
- **Constraint Coherence & Exceptions**: Validates non-conflicting constraint ordering and ensures 1:1 mapping between waived rules and justified external exceptions.
- **User Handoff & Lifecycle**: Verifies deliverable readiness, required verification steps, and lifecycle receipt agreement.

### Key Invariants

1. **Envelope extraction**: Exactly one `<outcome_review>` envelope in text; rejects missing, duplicate, or malformed tags.
2. **ACCEPT invariants**:
   - All goals must have status `satisfied`.
   - No rules may be `violated` or `pending`.
   - Satisfied `machine_enforced` rules must reference at least one fresh passed final-candidate evidence receipt matching `candidateFingerprint`.
   - All `isFinalCandidate` evidence receipts must be `passed`, `fresh`, and match `candidateFingerprint`.
   - No evidence receipt may have status `failed` or `pending`.
   - All exceptions must have `justified: true` and valid external authorization.
   - `constraintCoherence.coherent` must be `true` with no conflicts.
   - `handoff.ready` must be `true` with at least one verification step.
   - `lifecycle.stage` must be `completed` with `receiptAgreement: true`.
   - `userDecision` must be absent.
3. **USER_DECISION_REQUIRED invariants**:
   - `userDecision` must be present with `blocking: true`.
   - `handoff.ready` must be `false`.

## File Structure

- `schema.ts` - Strict Zod schemas, validation refinements, and derived TypeScript types for outcome review payloads.
- `parser.ts` - Envelope extraction (`parseOutcomeReview`, `safeParseOutcomeReview`) and error classes (`OutcomeParseError`).
- `index.ts` - Re-exports schemas, types, and parser functions.
- `parser.test.ts` - Comprehensive unit test suite for envelope parsing, all 5 verdicts, and semantic rejection invariants.
