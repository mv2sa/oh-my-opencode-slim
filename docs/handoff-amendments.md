# External handoff amendments (source-only, UNCERTIFIED)

`outcome_control(action: "amend_external_handoff", amendment: {...})` appends
an audited replacement obligation to an existing post-restart external wait.
It does **not** complete the handoff, clear or rewrite the original wait, change
the contract, checkpoint, actions, reviews, or override the governance phase.
An unresolved kickoff gate remains unresolved. No deployment or runtime
certification is implied by this source implementation.

## API

The managed root's orchestrator calls `OutcomeController.amendExternalHandoff`
or the tool action with an `amendment` object containing all of:

```ts
{
  rootSessionId, outcomeId, generation,
  waitReferenceId, waitCreatedRevision, waitOriginatingServerEpoch,
  waitRestartObservedRevision,
  expectedPreviousAmendmentHead, // literal "genesis" for the first append
  oldEffectiveObligationDigest,
  instructions, expectedPostRestartCheck, candidateFingerprint,
  reason, sourceUserMessageReceiptId, evidenceAttestationId,
  completionAuthorized, // optional boolean; true only after checking this scope
}
```

The direct store command is `{ type: 'amend_external_handoff', request }`.
Use the tool's `status` output to construct requests without inspecting private
records or computing digests. Its bounded `handoff` projection provides:

- `rootSessionId`, `outcomeId`, `generation`, and `original` wait identity/instructions;
- `effective` instructions/check/candidate, `amendmentHead`, `obligationDigest`,
  `currentRestartObservedRevision` and `currentServerEpoch`;
- retained `userReceipts` (at most 32) with ID, host message ID, provenance,
  revision and epoch, and `evidenceReceipts` (at most 64) with attestation ID,
  description, status, freshness, candidate and revision;
- latest `amendmentAuthority` IDs and fences and its `completionAuthorized` scope.

Map `original.referenceId/createdRevision/originatingServerEpoch` to the request's
`wait*` fields; map `currentRestartObservedRevision`, `amendmentHead` and
`obligationDigest` to `waitRestartObservedRevision`,
`expectedPreviousAmendmentHead` and `oldEffectiveObligationDigest` respectively.
After another restart, use a new status projection and fresh receipts. Status is
read-only; existing recovery/observation operations establish the restart fence.
The projection exposes neither raw records nor claim secrets.
Digests are canonical, domain-separated SHA-256 values,
not raw Git hashes. Inputs must already be canonical (no surrounding whitespace).
The controller/tool returns `{ revision, phase, handoff, noop }` on success,
using the same bounded projection rather than the authoritative record.

The initial effective obligation is the original wait's instructions and check
(explicit `null` when absent), and a `null` candidate: legacy waits never stored
a candidate binding. The first amendment establishes one; subsequent amendments
may explicitly change it. No candidate is inferred from a checkpoint or receipt.

## Authority and ordering

All identity, current generation, epoch, restart fence, prior head and obligation
checks run under the store's cooperative session lock. The source must be a
retained **external_user** receipt minted in the current epoch, strictly after
both the restart observation and the preceding amendment. A passed, fresh
orchestrator attestation must be minted strictly **after that user receipt**
and match the new check description and candidate exactly. Attestations have no
epoch field: their store-enforced revision ordering establishes freshness.

The observation hook, not this action, establishes external-source provenance.
This action never manufactures a user receipt. Missing, legacy-unverified or
synthetic-notice references do not confer authority. The orchestrator must
explicitly inspect the user's message and check semantic consent to the exact
instructions, check, candidate and reason. Set `completionAuthorized: true` only
when the same user authorization also covers subsequent explicit completion
using this exact verification pair; omission/false never confers that scope.
External provenance alone is **not**
proof of consent; a passed attestation is an orchestrator assertion, **not**
machine execution proof. The trusted store API and filesystem are not an
adversarial cryptographic boundary: an authorized writer can fabricate source
data or recompute unkeyed digests. Hook provenance hardening is owned separately.

## History, replay and limits

`receipts.handoffAmendments` retains a linear chain. Each entry binds the request,
original wait (excluding the changing restart observation), old/new obligation,
complete source and evidence digests, prior head, and store-owned revision,
timestamp and epoch. Stable wait identity is `(referenceId, createdRevision,
originatingServerEpoch)` within the exact root/outcome/generation; another
restart advances the live fence without discarding the effective obligation.

Exact source-receipt + stable-wait replays return a byte/revision-preserving
`noop`, before CAS allocation, including after an explicit subsequent recovery.
A changed replay, stale head or competing append fails closed. A fresh append
requires a new source receipt after the previous amendment. Records from another
epoch still require the existing explicit recovery path before store mutation.

Limits: 16 amendment entries and 16 amended-completion entries per outcome;
existing bounds remain 32 user receipts, 64 evidence entries, and 100 KiB total
serialized record. Instructions, check and reason each have a 512-character
limit. No amendment history is compacted. Capacity or relation-validation errors
leave record bytes unchanged. V1/V2 records without these optional arrays retain
their old semantics. Reload validates chains, identity, provenance, evidence,
effective wait preservation and completion relations. Digests detect inconsistent
tampering, not malicious rewriting of an entire trusted record and all hashes.

Unsettled final checkpoints (`claimed`, `dispatching`, `running`,
`review_uncertain`, `result_available`) are ineligible for amendment. Reconcile
the final first. If its result is misbound, retire it and use the existing
`supersede_external_handoff`; already-retired misbound finals also remain
ineligible. This ordering prevents amendments from trapping later misbound
recovery: no unsettled final can enter amendment history, and new checkpoints
cannot open while the amended wait remains. Supersession is not ordinary
completion and its implementation is unchanged.

## Completion and final review are separate

`complete_external_handoff` resolves the latest effective obligation under lock.
For amended waits it normally requires a new genuine current-epoch user receipt
after both the latest amendment and current restart fence, then a passed fresh
attestation matching the effective check **and candidate**. When the latest
amendment explicitly records `completionAuthorized: true`, a separate explicit
completion may reuse that amendment's **exact source/evidence pair**, provided
the epoch and restart fence are unchanged. This never clears the wait during
amendment itself. A different pair still requires fresh post-amendment authority;
another restart always invalidates the reuse permission. Completion appends a
digest-bound `handoffCompletions` receipt and only then clears the wait. Another
restart cannot restore the old obligation or make pre-restart evidence fresh.
The original unamended completion path remains compatible.

Finalization additionally requires a **new final checkpoint snapshot after the
latest amendment and no earlier than completion**, with the effective candidate
and the matching completion attestation included in its evidence set. The normal
authenticated Manager `ACCEPT`, kickoff, action, operation and contract gates
still apply. An old `ACCEPT` cannot certify amended instructions/checks, even if
the candidate stayed unchanged. These fences are enforced both by direct-store
finalization and accepted-record reload validation.

New amended final checkpoints persist `amendedHandoff`, binding the amendment
head, completion digest and effective instructions/check/candidate. The checkpoint
fingerprint includes that binding, and the final certificate repeats it with
exact relation validation. Removing both optional history arrays while leaving
the checkpoint/certificate intact is rejected on reload. The Manager packet
shows the exact bound obligation in a separate section for evaluation (not extra
fields to copy into the strict review envelope). Genuine legacy checkpoints and
certificates omit the binding and retain their original digest calculation.
