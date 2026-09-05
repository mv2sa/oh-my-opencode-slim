# src/hooks/orchestrator-wake/

## Responsibility

Periodic orchestrator wake scheduler. After continuous parent-idle time,
capability-gated host session APIs may receive a static internal wake prompt
when incomplete TODOs remain (or when a background job stopped without a
terminal result). Active children do not suppress wakes; host responses are
authoritative and the local job board is never consulted. Progress/reservation
state is process-global so independently created hook instances share
one-flight and the two-wake no-progress cap.

## Design

- **Scheduler** (`index.ts`): `createOrchestratorWakeScheduler(ctx, options)`
  returns `{ event, observeChatMessage, triggerStoppedJobRecovery, suppress }`.
  - Tracks per-session local state (`generation` symbol, timer, continuous
    idle flag) only; progress lives in the process gate.
  - Gates (`canSchedule`): config enabled, required session APIs present
    (`get`/`todo`/`children`/`status`/`promptAsync`), managed session,
    no input wait (`hasInputWait`), no fallback in progress, gate not stopped.
  - Reads a host snapshot (todos + children + status map + session model) and
    computes a fingerprint; unchanged fingerprints across wake attempts hit
    `ORCHESTRATOR_WAKE_UNCHANGED_CAP` (2) and stop.
  - Wakes via `promptAsync` with a static `<system-reminder>` text
    (`ORCHESTRATOR_WAKE_TEXT` or `ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT`),
    reserving the wake before prompt so a failed call cannot storm retries.
  - `triggerStoppedJobRecovery`: immediate recovery wake for jobs that stopped
    without a native terminal result (separate from the periodic TODO wake).
  - `observeChatMessage`: real external user activity rearms the no-progress
    cap and records the observed model for continuation prompts.
- **Gate** (`wake-gate.ts`): Process-local reservation/progress store shared
  via `globalThis` + `Symbol.for` (`oh-my-opencode-slim.orchestrator-wake-gate`):
  - `tryBeginWakeEvaluation` / `releaseWakeEvaluation` / `retryAfterWakeEvaluation`:
    single in-flight evaluation per session with waiter re-queueing.
  - `commitWakeReservation`: marks a committed wake and sets `expectingWakeBusy`
    so the next busy preserves (not rearms) the no-progress cap.
  - `noteHostProgress` / `rearmWakeProgress`: fingerprint-unchanged counting
    and external-activity resets.
  - `getObservedWakeModel` / `setObservedWakeModel`: last-seen model for
    continuation prompts.
  - Bounded at `MAX_TRACKED_SESSIONS` (256) with insertion-ordered eviction.

## Flow

```
session.idle / session.status(idle)
    ↓
beginContinuousIdle() → arm interval timer
    ↓
evaluate() (one-flight via gate)
    ├─ read host snapshot (todo/children/status)
    ├─ active status? → end idle spell
    ├─ no incomplete todos (and not recovery)? → end idle spell
    ├─ fingerprint unchanged ≥ cap? → stop
    ├─ recheck immediately before promptAsync
    ├─ commitWakeReservation
    └─ promptAsync(internal wake reminder)
    ↓
busy (wake-initiated) → endIdleSpell(rearm=false)   [cap survives]
busy (external) / errors / user activity → rearm cap
```

## Integration

- **Consumer**: `src/index.ts` creates the scheduler and routes `event`,
  `chat.message` (`observeChatMessage`), `wait_for_user` (`suppress`), and
  job-stopped recovery triggers to it; config comes from
  `runtime.backgroundJobs.orchestratorWake` (`{ enabled, intervalMs }`).
- **Task-session-manager seams**: `hasInputWait` (input-wait-tracker) and
  `parseContinuationModelSelection` (continuation-model-selection) gate and
  parameterize wake prompts.
- **SessionLifecycle**: registers `session.deleted` cleanup via the
  coordinator.
- **Interrupted Foreground-Turn Restart Recovery** (`index.ts` & `wake-gate.ts`):
  - One-shot startup bootstrap scanner and first idle/status event fallback for interrupted managed root orchestrator sessions across process restarts.
  - Startup scan scans bounded current-directory sessions via host `session.list` (roots only, newest first, max 256 roots, concurrency <= 4) after a short non-blocking settle delay.
  - Exact classification requirements:
    - Raw prior-epoch Outcome store read (`controller.store.read`) where `serverEpoch !== currentServerEpoch`, not accepted, no durable user/external wait, and exactly one running prior-epoch durable operation.
    - No process-local user/external wait and no fallback in progress.
    - Host snapshot 1: root session (`!parentID`), inactive status, valid incomplete TODOs, latest message is exactly one incomplete assistant turn with no error and exactly one running noninteractive tool part.
    - Exact durable operation binding by callID, tool name, and `canonicalDigest('omos/tool-args/v1', tool input)`.
    - Normal `controller.readRecord` recovery ensuring the exact operation is interrupted with the standard restart error and matching unresolved action.
    - Host snapshot 2: must be identical to snapshot 1 and inactive before prompt.
  - Wakes via single static internal prompt `ORCHESTRATOR_RESTART_RECOVERY_TEXT` directing authoritative inspection without blind re-execution, preserving model from the incomplete assistant turn.
  - Process-global one-flight and success state shared between startup scan and event fallback: at most 2 SDK-failure attempts per session/process, never a second prompt after success, bounded 256-session eviction, and disposal cancellation.
  - Shared wake reservation with OutcomeController idle wake so bootstrap and Outcome idle cannot double-prompt.
- **Dependencies**: `createInternalAgentTextPart` /
  `isInternalInitiatorPart` (`src/utils/internal-initiator.ts`), `log`,
  `isRecord`, `SessionLifecycle`, and the task-session-manager status/selection
  helpers.
- **Foreground-fallback**: `isFallbackInProgress` suppresses scheduling during
  fallback cycles.

## Error Handling

- SDK failures during evaluation suppress the wake (reservation already
  committed), clear the expecting-busy marker, and log; the timer re-arms via
  the finally block unless stopped.
- `server.instance.disposed` clears timers, releases owners, and drops pending
  recovery state.
- Model enrichment from `session.get` is fail-soft.

## Performance Considerations

- One unref'd timer per continuously-idle managed session; timers are cleared
  on any busy/error/wait/deletion.
- All process-global state is bounded and evicted LRU-style.
- Host snapshot reads are `Promise.all`-parallel and only happen inside the
  one-flight evaluation.
