# Local Fork Roadmap

This public fork carries a small set of production-tested orchestration changes
that are not yet available in upstream `oh-my-opencode-slim`.

## Maintenance model

- `master` is a fast-forward-only mirror of official upstream.
- `stable` is the supported custom distribution branch.
- `local/v<upstream>-r<n>` records an immutable local release from an exact
  upstream tag.
- `sync/upstream-<year>-W<week>` is a disposable weekly intake branch. Upstream
  is merged there, tested, and reviewed before it reaches `stable`.
- Published branches and release tags are never rebased or force-pushed.
- Upstream intake is weekly; deployment happens only for relevant, verified
  changes.

The first reconstruction is based on upstream `v2.2.17` and applies three
logical layers:

1. Persistent provider/model cooldowns.
2. Background completion-delivery and task-lifecycle corrections.
3. Antigravity synthetic-quota fallback.

The first release branch adds this roadmap to the deployed source. Excluding
that documentation-only file, its runtime source and built artifact must match
the currently deployed immutable release before `stable` becomes authoritative.

## Outcome management (removed)

This fork previously carried an Outcome Controller and a read-only Outcome
Manager: durable contracts, checkpointed reviews, evidence binding, and a
deterministic lifecycle state machine.

It was deactivated, evaluated in real use, and then removed. Across extended
use the reviewer produced no technical finding that the deterministic gates and
the review/audit lanes did not already catch, while the layer cost roughly
31k LOC (production plus tests) to carry through every weekly upstream merge.
Records written while it was active remain on disk but are now inert.

Reintroducing it would mean reverting the removal commit.
