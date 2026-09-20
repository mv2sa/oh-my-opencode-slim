# src/hooks/orchestrator-wake/

## Responsibility

Periodic orchestrator wake scheduler. After continuous parent-idle time,
capability-gated host session APIs may receive a static internal wake prompt
when incomplete todos remain (or when a background job stopped without a
terminal result). Active children do not suppress wakes; host responses are
authoritative and the local job board is never consulted. Progress/reservation
state is process-global so independently created hook instances share
one-flight and the two-wake no-progress cap.

On v2 hosts (hostFlavor 'v2' from the client shim) the scheduler runs in a
children-driven degraded mode: no todo/children/status surfaces exist there,
so children are enumerated via `session.list({parentID})` (event-tracked
fallback), the wake condition is children without a terminal `outcome`
(staleness-bounded at 3× the interval), and the wake prompt is delivered with
`delivery: 'queue'`. Config: `orchestratorWake.mode` ('auto' | 'todo' |
'children', default auto). The v1 code path is unchanged.

## Design

- **Scheduler** (`index.ts`): `createOrchestratorWakeScheduler(ctx, options)`
  returns `{ event, observeChatMessage, triggerStoppedJobRecovery, suppress }`.
  - Tracks per-session local state (`generation` symbol, timer, continuous
    idle flag, and archive suppression) only; progress lives in the process
    gate.
  - Capability record (`probeSessionApis`): v1 keeps exactly the historical
    probe set (get/todo/children/status/promptAsync); v2 requires only
    list+promptAsync (get optional). `resolveWakeMode` maps the configured
    mode to todo/children per flavor and logs one degradation note when v2
    lacks the todo API.
  - Gates (`canSchedule`): config enabled, capability gate ready, managed
    session, no input wait (`hasInputWait`), no fallback in progress, gate
    not stopped.
  - Reads a host snapshot (todo mode: todos + children + status map +
    session model/archive state; children mode: children list + event-tracked
    parent status + optional model/archive state) and computes a fingerprint; unchanged
    fingerprints across wake attempts hit `ORCHESTRATOR_WAKE_UNCHANGED_CAP`
    (2) and stop.
  - Checkpoint classification (`classifyTodoSnapshot` /
    `classifyChildrenSnapshot` → `applySnapshotVerdict`): identical v1
    check order (parent-active → active-child suppression → todo
    condition); children mode uses the event-tracked parent race guard
    (fail-open) and outcome-based child activity as the wake condition.
  - Event bookkeeping: `lastStatusBySession` (busy-set + race guard),
    `childSessions`/`childEvidence` from `session.created` parentID links
    (both v1-shape and flat v2 events), all bounded at 512 entries FIFO and
    cleared on `session.deleted`/dispose. `session.updated` archive state
    suppresses or restores the local session timer/generation.
  - Wakes via `promptAsync` with a static `<system-reminder>` text
    (`ORCHESTRATOR_WAKE_TEXT`, `ORCHESTRATOR_CHILDREN_WAKE_TEXT`, or
    `ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT`), reserving the wake before prompt
    so a failed call cannot storm retries. v2 children mode passes
    `delivery: 'queue'` (v1 call shape unchanged).
  - `triggerStoppedJobRecovery`: immediate recovery wake for jobs that stopped
    without a native terminal result (separate from the periodic TODO wake;
    bypasses the wake condition, as on v1). Queued facts are revalidated by
    task ID + generation before delivery; the bounded detail queue emits an
    overflow signal instead of silently losing excess recovery state.
  - `observeChatMessage`: real external user activity rearms the no-progress
    cap and records the observed model for continuation prompts.
- **Gate** (`wake-gate.ts`): Process-local reservation/progress store shared
  via `globalThis` + `Symbol.for` (`oh-my-opencode-slim.orchestrator-wake-gate`):
  - `tryBeginWakeEvaluation` / `releaseWakeEvaluation` / `retryAfterWakeEvaluation`:
    single in-flight evaluation per session with waiter re-queueing.
  - `commitWakeReservation`: owner-safe, at most once per reservation; debits
    the shared two-attempt cap before SDK invocation, including failures.
  - `noteHostProgress` / `rearmWakeProgress`: fingerprint-unchanged counting
    and external-activity resets.
  - `getObservedWakeModel` / `setObservedWakeModel`: last-seen model for
    continuation prompts.
  - First 256 external message IDs retained per session; later unknown IDs fail
    closed for rearming. At 256 sessions, new admission fails closed. Budgets remain
    until deletion/process exit, never evicted under session pressure. Disposal only
    retires local work; committed transports retain ownership until settlement.
  - TODO/child fingerprints: initial/missing components cannot refill spent
    budget; meaningful changes or distinct external host IDs alone rearm.
    Revisions/counters/timestamps/prose/status-read churn do not.
  - Shared idle-cycle admission coalesces paired idle notifications across hooks
    and SDK acknowledgements. Busy-to-idle opens another cycle without refilling
    budget. Release waiters are bounded/deduplicated by scheduler/Controller source.

## Flow

```
session.idle / session.status(idle)
    ↓
beginContinuousIdle() → arm interval timer
    ↓
evaluate() (one-flight via gate)
    ├─ read host snapshot (todo mode: todo/children/status;
    │  children mode: list/event-tracked children + parent status)
    ├─ active status? → end idle spell
    ├─ todo mode: active child? → schedule later; no incomplete todos? → end
    ├─ children mode: no active (outcome-less, fresh) child? → end
    ├─ fingerprint unchanged ≥ cap? → stop
    ├─ recheck archive state immediately before promptAsync
    ├─ commitWakeReservation
    └─ promptAsync(internal wake reminder; v2 children mode: delivery 'queue')
    ↓
busy (wake-initiated) → endIdleSpell(rearm=false)   [cap survives]
busy / retry / errors / duplicate lifecycle → never rearm cap
distinct external user ID / meaningful component change → rearm cap
```

## Integration

- **Consumer**: `src/index.ts` creates the scheduler and routes `event`,
  `chat.message` (`observeChatMessage`), `wait_for_user` (`suppress`), and
  job-stopped recovery triggers to it; config comes from
  `runtime.backgroundJobs.orchestratorWake`
  (`{ enabled, intervalMs, mode }`).
- **Task-session-manager seams**: `hasInputWait` (input-wait-tracker) and
  `parseContinuationModelSelection` (continuation-model-selection) gate and
  parameterize wake prompts.
- **SessionLifecycle**: registers `session.deleted` cleanup via the
  coordinator.
- **v2 adapter**: the client shim's `session.list` (parentID filter, v1
  envelope with mapped `outcome`/`time.updated`/`directory`), the
  children-fallback enrichment via `session.get` (authoritative
  `outcome`/`time.updated` refreshed every evaluation; fail-soft), and
  the `promptAsync` `delivery` ('queue' from the wake path; 'steer' default
  for foreground-fallback) and `modelVariant` (wake model pin; the shim
  merges it into the `switchModel` ref so the reasoning-effort variant is
  preserved) parameters; `src/v2/setup.ts`'s cleanup invokes the v1
  `dispose` hook, which synthesizes `server.instance.disposed` into the
  scheduler.
- **Dependencies**: `createInternalAgentTextPart` /
  `isInternalInitiatorPart` (`src/utils/internal-initiator.ts`), `log`,
  `isRecord`, `SessionLifecycle`, and the task-session-manager status/selection
  helpers.
- **Foreground-fallback**: `isFallbackInProgress` suppresses scheduling during
  fallback cycles.

## Error Handling

- SDK failures during evaluation suppress the wake (reservation already
  committed), clear the expecting-busy marker, and log; the timer re-arms via
  the finally block unless stopped. Children-mode enumeration failures fall
  back to event tracking instead of suppressing.
- Archived sessions clear their timer and generation on `session.updated`; v2
  hosts without `session.get()` rely on that observed archive state.
- `server.instance.disposed` clears timers, releases owners, and drops pending
  recovery + event-tracking state.
- Model enrichment from `session.get` is fail-soft.

## Performance Considerations

- One unref'd timer per continuously-idle managed session; timers are cleared
  on any busy/error/wait/deletion.
- External-ID dedup is bounded; live budgets/owners are not evicted or reset by hook disposal. All process-global state is bounded and evicted LRU-style; event-tracking maps are bounded at 512 entries FIFO.
- Host snapshot reads are `Promise.all`-parallel and only happen inside the
  one-flight evaluation.
