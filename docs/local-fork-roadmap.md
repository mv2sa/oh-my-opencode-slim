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

## Outcome management

Outcome management remains inside OMOS and has two parts:

- **Outcome Controller:** deterministic lifecycle state, triggers, and durable
  outcome/evidence records.
- **Outcome Manager:** a read-only agent for semantic scope, repository-rule,
  exception, and final-acceptance review.

The existing Orchestrator remains the execution authority and delegates
specialists directly. The Manager does not edit, dispatch, cancel, deploy, or
restart services.

### Default checkpoints

The Controller requests Manager review at:

1. Non-trivial kickoff.
2. A consequential decision, exception, or detected scope drift.
3. Final acceptance.

It does not continuously poll with an LLM.

### Repository governance

The Manager must discover and apply the repository guidance governing the
changed paths, including:

- root and nested `AGENTS.md` files;
- documentation routers such as `docs/README.md`;
- architecture, design-system, testing, security, and release guidance;
- machine-enforced gate manifests, budgets, ratchets, and waiver mechanisms.

Machine-checkable rules remain deterministic. The Manager judges whether the
selected implementation and evidence satisfy both those rules and the requested
outcome.

### Constraint coherence

Engineering constraints govern implementation shape; they must not silently
reduce the required outcome.

When a file-size, complexity, documentation, coverage, or bundle budget blocks
an otherwise required implementation, use this order:

1. Split cohesive responsibilities along documented architecture boundaries.
2. Extract modules, services, pure helpers, or composition-root wiring.
3. Remove only behavior proven redundant or outside the agreed scope.
4. Use an existing documented exception or waiver with explicit rationale.
5. Request a user decision when no legitimate exception path exists.

Do not delete essential behavior, safety checks, design intent, or relevant
tests merely to make a gate pass. Do not expand ratchet baselines or add broad
coverage ignores as an automatic escape hatch.

### Manager verdicts

Manager reviews return one of:

- `CONTINUE`
- `CORRECT_DRIFT`
- `REVISE_CONTRACT`
- `USER_DECISION_REQUIRED`
- `ACCEPT`

Final `ACCEPT` requires the original outcome, applicable repository rules,
final-candidate evidence, justified exceptions, user handoff, and lifecycle
state to agree.

## Minimal implementation sequence

1. Reconstruct and verify the currently deployed local layers in Git history.
2. Add the read-only Outcome Manager and compact review contract.
3. Add a minimal durable Outcome Controller for kickoff, exception, and final
   triggers.
4. Add deterministic invalid-wait, terminal-unreconciled, and stale-server-epoch
   detection.
5. Validate the flow in this repository and one rule-rich application repository.

Self-restart supervision is deliberately excluded from the first controller.
OMOS should refuse to restart the OpenCode process carrying its own session and
produce a durable external handoff instead.
