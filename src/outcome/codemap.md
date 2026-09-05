# src/outcome/

## Responsibility

Defines the compact runtime-validated review contract for the Outcome Manager and the durable, controlled state store used by the Outcome Controller.

## Design

### Strict Review Contract

The review contract defines a single `<outcome_review>` JSON envelope with strict Zod validation (`OutcomeReviewSchema`):

- **Verdicts**: `CONTINUE`, `CORRECT_DRIFT`, `REVISE_CONTRACT`, `USER_DECISION_REQUIRED`, `ACCEPT`.
- **Checkpoint Compatibility**: Shared schema/store validation permits `ACCEPT` only for a `final` checkpoint, including preflight, persistence, and durable relation validation.
- **Candidate Fingerprint**: Required on `ACCEPT` to bind final-candidate evidence receipts to the evaluated deliverable.
- **Rule Receipts**: Distinguishes `machine_enforced` vs `semantic` rules, recording source path, category, summary, enforcement status, and referenced evidence IDs.
- **Evidence Receipts**: Records deterministic validation command, candidate fingerprint, freshness (`fresh`, `stale`, `unknown`), `isFinalCandidate` flag, and execution status (`passed`, `failed`, `stale`, `pending`).
- **External Waiver Authorization**: Enforces strict external authority (`repository_waiver` or `user_decision`) with an explicit reference ID for every waived rule.
- **Constraint Coherence & Exceptions**: Validates non-conflicting constraint ordering and ensures 1:1 mapping between waived rules and justified external exceptions.
- **User Handoff & Lifecycle**: Verifies deliverable readiness, required verification steps, and lifecycle receipt agreement.

### Durable Outcome Controller Store

The storage foundation provides bounded persistence for cooperative OMOS processes. It fails closed on malformed records and statically detected symlinks, but does not claim protection from an adversary concurrently mutating trusted directories.

- **Bounded Versioned Schema (`OutcomeRecord` v2 & V1 Migration)**:
  - Canonical, domain-separated SHA-256 digests bind normalized contract authority (excluding mutable goal progress), checkpoint packets, claim tokens, observations, attestations, authorizations, and certificates. Strict reload validation recomputes every Orchestrator attestation and authorization digest from its exact minting fields.
  - Durable `kickoffGate` tracks policy version, gate state (`required`, `authenticated`, `exhausted`, `legacy_late_missing`, `legacy_certified`), contract digest, attempt counts (max 2), and authenticated review ID. `legacy_certified` preserves an already-valid V1 certificate without claiming V2 kickoff authentication and cannot authorize new lifecycle work.
  - Centralized action insertion archives oldest resolved actions into `resolvedActionArchive` with rolling `chainDigest`, retaining up to 4 recent resolved actions and all unresolved actions, failing closed on unresolved `action_capacity_exhausted`.
  - User message receipts record explicit provenance (`external_user` vs `legacy_unverified`). V2 receipts must provide it explicitly; only the V1 normalizer assigns `legacy_unverified`. Only `external_user` receipts may authorize new authority-bearing transitions, including a new `user_decision` authorization through its source decision receipt.
  - Store-atomic user message identity keys by canonical trimmed host `messageId`. Exact matching `contentDigest` duplicate returns a true byte/revision-preserving `noop` before revision allocation or CAS checks; conflicting `contentDigest` fails closed with stable `invalid_transition` without revision growth. V1 canonical duplicates are deterministically collapsed with dependent receipt references remapped, and duplicate appends never upgrade `legacy_unverified` receipts to external authority.
  - Controller `observeExternalUserTurn` / `observeUserTurn` returns `OutcomeControllerResult<OutcomeUserTurnResult>` with receipt and `noop` metadata, bounded CAS retry, and failure propagation.
  - V1 records strictly parse and deterministically normalize to V2 on read, recover, or persist, preserving existing accepted certificates. A migrated `legacy_late_missing` record retires any retrospective active kickoff and moves to the failed phase.
  - Tool observations authenticate only observed arguments/output and lifecycle bytes. Separate Orchestrator attestations carry explicitly asserted status and freshness. When an attestation links an observation, Controller preflight, direct store mutation, durable V1/V2 validation, and finalization all require exactly one completed operation/observation pair with matching call, tool, argument, and epoch identity.
  - Accepted records require an exact final `review_accepted` claim, a strict parsed Manager `ACCEPT` bound to the fetched result digest, matching certificate fields and receipt digests, satisfied goals and rules, an authenticated `kickoffGate` bound to its review ID, no wait or unresolved action, and only completed or explicitly acknowledged operations.
  - Serialized limit: Total serialized record strictly bounded <= 100 KiB.
- **Store-Enforced Kickoff Gate**: Opening a kickoff checkpoint atomically consumes an attempt. Only an authenticated kickoff `CONTINUE` review transitions the gate to `authenticated`. Non-kickoff checkpoints require an authenticated gate. Two failed attempts exhaust the gate and fail the phase; subsequent kickoff requests fail with `kickoff_retry_exhausted` without mutating state. Missing historical kickoff after later activity becomes `legacy_late_missing` with retrospective kickoff forbidden. A changed contract digest resets the gate only when backed by `external_user` authority; an unchanged digest or unauthorized change preserves it. Finalization binds directly to `kickoffGate.authenticatedReviewId`.
- **Idle Operations Reconciliation, Late Authoritative Repair & Idempotent Completion**: Same-epoch running operations can be atomically marked `interrupted` upon authoritative session idle (`reconcileIdleOperations`) with reason `Session became idle without a durable tool after-hook`, without generating action noise; repeated idle calls are no-ops. Late authoritative `complete_tool_call` transitions an operation from `interrupted` to `completed` only when current epoch, exact idle reason, and the exact incomplete `controller_observed` tuple matches by call ID, tool name, argument digest, and epoch, clearing the error and removing recovery nudges. Durable relation validation rejects cross-paired identities. Restart-interrupted, failed, acknowledged, epoch-mismatched, or identity-mismatched operations remain fail closed. Tool and observation completion with the same output digest returns before revision allocation or persistence, preserving serialized bytes.
- **Process Epoch (`getProcessEpoch`)**: Process-global epoch string generated once per OS process, stored on `globalThis` under `Symbol.for('omos.outcome.process_epoch')`, combining process PID, timestamp, and a cryptographic random nonce. Restart handoffs retain their originating epoch and a recovery revision; completion requires a different epoch plus post-recovery user/evidence provenance.
- **Collision-Safe Local Paths**: Records default to `<projectDirectory>/.opencode/outcomes` and use SHA-256 filenames derived from validated session IDs. Existing symlink components, record targets, lock owners, and temporary files are rejected through no-follow/descriptor checks.
- **Successor Outcomes & Bounded Session Manifest**:
  - One root session supports ordered generations. Generation 1 remains at `<sessionHash>.json` for backwards compatibility; successor generations use `<sessionHash>.gNNNNNNNN.json`.
  - Authoritative routing metadata lives in `<sessionHash>.manifest.json` (`currentGeneration`, optional `pendingSuccessor` summary). Manifest never duplicates certificate history.
  - Cooperative session locking uses a single `<sessionHash>.lock` across all generations.
  - Lazy compatibility: existing valid record without manifest becomes generation 1 by creating only the manifest, preserving accepted predecessor bytes and certificates unchanged.
  - Durable pending-successor intake (`<sessionHash>.gNNNNNNNN.intake.json`) stages external user turns post-acceptance, linked backward by predecessor outcome ID, generation, accepted revision, and domain-separated final-certificate digest (`omos/final-certificate/v1`).
  - `begin` with pending intake promotes it in place to active generation N+1 with explicit lineage (`omos/successor-lineage/v1`), requiring the boundary external message ID and contract sourceMessageIds to resolve to retained `external_user` receipts.
  - Atomic publication order writes generation/intake file first, manifest second. Orphan recovery adopts exact matching N+1 orphans and fails closed on ambiguity or corruption.
  - Root controller APIs resolve the manifest-selected active/latest generation, while explicit read-only historical generation access is provided via `readGeneration` and `getHistoricalGenerationStatus`.
  - Normal `read`, `readGeneration`, `readManifest`, and `getStatus` APIs are strictly read-only; manifest creation, orphan adoption, and intake repair occur exclusively under lock during explicit recovery or mutating transitions.
  - Authoritative manifest reread under lock eliminates TOCTOU races between inspection and publication.
  - Session-wide external message identity checks all predecessor generation receipts to guarantee replayed historical messages remain true no-ops that cannot become successor boundaries.
  - Retained history & no-GC policy: all accepted historical generation files are retained permanently; missing history strictly fails closed for complete lineage auditing.
  - Claim secrets are strictly scoped by session, outcome ID, and checkpoint/generation.
  - Restart recovery operates only on the manifest-selected active outcome; accepted predecessors are untouched.
- **Cooperative Locking & Mutation**: A fully written, fsynced unique candidate lock is atomically published. PID/epoch/token capability checks protect cooperative writers; only positive dead-PID evidence permits stale-lock quarantine. Raw lock release is private.
- **Controlled Mutation & Bounded Compaction**: Callers use typed append/state-transition commands rather than arbitrary record replacement. Bounded exits cover goal completion, user-authorized objective/scope revision, repository-waiver registration, provenance-backed action resolution, and post-restart external-handoff completion. Actions carry a creation revision; user provenance and fresh passed Orchestrator attestations must be minted later. Identity, revision, epoch, timestamps, digests, receipt history, and certificate bindings remain store-owned. Before adding tool operations or observations, the store deterministically compacts exact unreferenced completed pairs and acknowledged restart/idle-interrupted pairs whose incomplete observation uncertainty has been explicitly resolved. Restart/idle provenance is store-owned and survives acknowledgement, so caller-supplied failure text cannot make a failed pair compactable. Both sides are pruned atomically while remaining comfortably below schema hard caps (`operations <= 32`, `evidence <= 64`). Active, failed, unresolved interrupted, linked/referenced, ambiguous, and identity-mismatched pairs remain fail closed and are never pruned.
- **Review Reconciliation Ordering**: Controller reconciliation fetches and digests terminal child output, parses/authenticates/classifies it, consumes the exact Manager task generation idempotently, and only then persists a valid review or invalid state. Exact retries reuse the persisted summary and cannot duplicate it.
- **Atomic Replacement**: Record bytes are written to an exclusive no-follow temporary descriptor, fsynced, identity-checked, renamed, and followed by containing-directory fsync. A post-publication fsync failure is reported as durability-uncertain rather than success.
- **Deterministic Restart Recovery**: When loading a record from a prior server epoch:
  - Pending operations from old epochs transition to `interrupted` and trigger `action_required`.
   - Prior-epoch undispatched claims are cleared with an explicit action receipt.
  - Prior-epoch dispatching or running claims transition to `review_uncertain`, preserving durable dispatch and Manager identity; host-authenticated reconciliation can supply only missing identity and a result without the lost live token.
  - Prior-epoch `result_available` claims remain reviewable without the lost token through an exact-identity recovery command.
  - Prior-epoch `result_available` claims with misbound or mismatched manager results can be safely retired using `reconcile_uncertain(resolution: { kind: 'retire_misbound_result', ... })` via the store's dedicated `retire_misbound_recovered_result` mutation. This fail-closed transition enforces exact durable identity and digest match, computes authoritative child result digest via reader, verifies authoritative digest != bound digest, enforces normal board checks when a board record exists (consuming the task generation) or skips consumption when boardless, sets state to `retired` with both full result digests and a domain-separated full normalized reason digest in audit recoveryNote without writing a review summary, retains original identity/digest/fingerprint, preserves kickoff attempt counts without refund, and fences exact idempotent retry by the full normalized reason digest even across display-suffix truncation.
  - Stale external handoff waits tied to retired misbound final checkpoints can be superseded via `outcome_control(action='supersede_external_handoff')` and dedicated `supersede_external_handoff` mutation. This fail-closed transition verifies the exact wait tuple including instructions, post-restart epoch difference, exact instructions or expected check containing the retired checkpoint ID (supporting legacy waits that linked it in instructions), retired final checkpoint identity/digest, reader-verified child result matching misbound audit observed digest, fresh post-restart external_user provenance, and subsequent passed fresh orchestrator attestation matching replacement candidate fingerprint. On success, the exact wait is cleared, the retired checkpoint is preserved unchanged, a durable `handoffSupersessions` receipt is recorded with domain-separated digest (`omos/external-handoff-supersession/v1`), and exact idempotent retry is supported. Unresolved wait overwrites, generic external clear, and implicit contract revision supersession are strictly rejected.
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
- `controller.ts` - `OutcomeController` service coordinating durable outcome contracts, checkpoint claims, process-local secret tokens, evidence minting, review reconciliation, bounded progress/action transitions, user decisions, external handoff completion, and final certificate creation.
- `process-epoch.ts` - Process-stable epoch generation; test reset is not re-exported by the outcome barrel.
- `store.ts` - Controlled `OutcomeStore` initialization/read/mutation/recovery API with cooperative locking and atomic replacement.
- `index.ts` - Re-exports all schemas, parsers, epoch utilities, controller, and store classes.
- `parser.test.ts` - Unit tests for outcome review parsing and verdict invariants.
- `store.test.ts` - Unit test suite for `OutcomeStore`, covering locking, CAS, corrupt fail-closed preservation, restart recovery, symlink protection, descriptor reads, and concurrency.
- `controller.test.ts` - Unit test suite for `OutcomeController` lifecycle, dispatch marker correlation, evidence attestation, review reconciliation, recovery, and final certification.
