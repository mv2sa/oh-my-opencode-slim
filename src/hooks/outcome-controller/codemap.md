# Outcome Controller Hook

## Purpose
The outcome controller hook bridges the `OutcomeController` service and OpenCode lifecycle hooks. It manages cache-safe volatile checkpoint dispatch nudges, enforces Manager correlation on native `task` calls, tracks tool observations, and captures external user turn receipts.

## Key Components
- `createOutcomeControllerHook`: Factory creating the hook object.
- `OUTCOME_CONTROLLER_METADATA_KEY`: Metadata key (`oh-my-opencode-slim:outcome-controller`) for volatile trailing dispatch nudges.
- `experimental.chat.messages.transform`: Strips previously injected outcome nudges and appends at most one trailing volatile dispatch message when an active claimed checkpoint exists.
- `tool.execute.before`: Enforces exact single OMOS dispatch marker correlation when `task` is called with `subagent_type='outcome-manager'`, marking the checkpoint as `dispatching`. Observes ordinary tool executions.
- `reserveManagerDispatch` / `failReservedManagerDispatch`: Brackets the combined plugin preflight so any later hook rejection retires a reserved Manager claim before native launch.
- `tool.execute.after`: Binds the Manager task ID and generation upon task tool return, and captures tool output digests.
- `chat.message`: Observes external user turns with whole-message external provenance (rejecting the entire message if any authoritative part is synthetic, internal initiator, compaction continuation, or carries internal metadata; prefers output.parts over cleaner input.parts; requires host message ID and treats duplicate host events idempotently) and records `external_user` receipts in the durable outcome store.
- `event`: Evaluates managed idle liveness after child-running suppression, atomically reconciles running same-epoch tool operations to interrupted via `controller.store.reconcileIdleOperations`, suppresses valid waits and active children, coordinates with `orchestrator-wake`'s wake gate to prevent double-prompting with bootstrap restart recovery, and emits at most one internal action-required wake per idle spell while surfacing durable read failures.
- Managed-root Bash guard: Rejects literal current-PID termination and explicit OpenCode process/service restart forms before tool observation, directing the orchestrator to `external_handoff`; aliases, scripts, pipelines, and obfuscated forms are intentionally outside scope.
