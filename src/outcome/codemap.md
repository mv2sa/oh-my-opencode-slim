# src/outcome/

## Responsibility

Defines the compact runtime-validated review contract for the Outcome Manager and the durable, controlled state store used by the Outcome Controller.

## Design

### Strict Review Contract

The review contract defines a single `<outcome_review>` JSON envelope with strict Zod validation (`OutcomeReviewSchema`):

- **Verdicts**: `CONTINUE`, `CORRECT_DRIFT`, `REVISE_CONTRACT`, `USER_DECISION_REQUIRED`, `ACCEPT`.
- **Candidate Fingerprint**: Required on `ACCEPT` to bind final-candidate evidence receipts to the evaluated deliverable.
- **Rule Receipts**: Distinguishes `machine_enforced` vs `semantic` rules, recording source path, category, summary, enforcement status, and referenced evidence IDs.
- **Evidence Receipts**: Records deterministic validation command, candidate fingerprint, freshness (`fresh`, `stale`, `unknown`), `isFinalCandidate` flag, and execution status (`passed`, `failed`, `stale`, `pending`).
- **External Waiver Authorization**: Enforces strict external authority (`repository_waiver` or `user_decision`) with an explicit reference ID for every waived rule.
- **Constraint Coherence & Exceptions**: Validates non-conflicting constraint ordering and ensures 1:1 mapping between waived rules and justified external exceptions.
- **User Handoff & Lifecycle**: Verifies deliverable readiness, required verification steps, and lifecycle receipt agreement.

### Durable Outcome Controller Store

The storage foundation provides bounded persistence for cooperative OMOS processes. It fails closed on malformed records and statically detected symlinks, but does not claim protection from an adversary concurrently mutating trusted directories.

- **Bounded Versioned Schema (`OutcomeRecord`)**:
  - Canonical, domain-separated SHA-256 digests bind normalized contracts, checkpoint packets, claim tokens, observations, attestations, and certificates.
  - Tool observations authenticate only observed arguments/output and lifecycle bytes. Separate Orchestrator attestations carry explicitly asserted status and freshness.
  - The store creates checkpoint IDs and monotonic generations, hashes the caller-held claim token, and snapshots the outcome/root identity, contract revision, included receipt IDs, candidate fingerprint, epoch, and expiry. Token-protected transitions add dispatch, Manager-task, result, and review identities without changing the packet fingerprint.
  - Accepted records require an exact final `review_accepted` claim, a strict parsed Manager `ACCEPT` bound to the fetched result digest, matching certificate fields and receipt digests, satisfied goals and rules, no wait or unresolved action, and only completed or explicitly acknowledged operations.
  - Serialized limit: Total serialized record strictly bounded <= 100 KiB.
- **Process Epoch (`getProcessEpoch`)**: Process-global epoch string generated once per OS process, stored on `globalThis` under `Symbol.for('omos.outcome.process_epoch')`, combining process PID, timestamp, and a cryptographic random nonce.
- **Collision-Safe Local Paths**: Records default to `<projectDirectory>/.opencode/outcomes` and use SHA-256 filenames derived from validated session IDs. Existing symlink components, record targets, lock owners, and temporary files are rejected through no-follow/descriptor checks.
- **Cooperative Locking & Mutation**: A fully written, fsynced unique candidate lock is atomically published. PID/epoch/token capability checks protect cooperative writers; only positive dead-PID evidence permits stale-lock quarantine. Raw lock release is private.
- **Controlled Mutation**: Callers use typed append/state-transition commands rather than arbitrary record replacement. Identity, revision, epoch, timestamps, digests, receipt history, and certificate bindings remain store-owned.
- **Atomic Replacement**: Record bytes are written to an exclusive no-follow temporary descriptor, fsynced, identity-checked, renamed, and followed by containing-directory fsync. A post-publication fsync failure is reported as durability-uncertain rather than success.
- **Deterministic Restart Recovery**: When loading a record from a prior server epoch:
  - Pending operations from old epochs transition to `interrupted` and trigger `action_required`.
   - Prior-epoch undispatched claims are cleared with an explicit action receipt.
  - Prior-epoch dispatching or running claims transition to `review_uncertain`, preserving durable dispatch and Manager identity; host-authenticated reconciliation can supply only missing identity and a result without the lost live token.
  - Prior-epoch `result_available` claims remain reviewable without the lost token through an exact-identity recovery command.
  - Same-epoch abandoned claims may be explicitly retired after their expiry; stale callbacks remain invalid.
  - Settled/terminal claims preserve truthful history, and interrupted operations require explicit acknowledgement.
  - Same-epoch recovery is idempotent and does not increment revision.

## Key Invariants

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
4. **Storage Invariants**:
   - Monotonic revision increment exactly once per successful typed mutation.
   - CAS revision mismatch reports `conflict` error and rejects update.
   - Corrupt, oversized, invalid-schema, or symlinked files fail closed and are never overwritten.
   - Lock owner capabilities serialize cooperative OMOS processes; malformed ownership fails closed, short writes are completed with a write-all loop, and failed post-publication lock fsync does not strand the matching canonical lock.
   - Final certificates are structurally bound to the accepted final claim, Manager review, current contract, candidate, epoch, and included attestation digests.

## File Structure

- `schema.ts` - Strict Zod schemas, validation refinements, and derived TypeScript types for outcome review payloads.
- `parser.ts` - Envelope extraction (`parseOutcomeReview`, `safeParseOutcomeReview`) and error classes (`OutcomeParseError`).
- `controller-schema.ts` - Strict Zod schemas, canonical digest helpers, relation validation, and durable Controller types.
- `process-epoch.ts` - Process-stable epoch generation; test reset is not re-exported by the outcome barrel.
- `store.ts` - Controlled `OutcomeStore` initialization/read/mutation/recovery API with cooperative locking and atomic replacement.
- `index.ts` - Re-exports all schemas, parsers, epoch utilities, and store classes.
- `parser.test.ts` - Unit tests for outcome review parsing and verdict invariants.
- `store.test.ts` - Unit test suite for `OutcomeStore`, covering locking, CAS, corrupt fail-closed preservation, restart recovery, symlink protection, descriptor reads, and concurrency.
