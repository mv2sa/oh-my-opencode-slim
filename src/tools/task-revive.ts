import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import type { BackgroundJobLease } from '../utils/background-job-board';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { log } from '../utils/logger';
import { getClient } from '../utils/opencode-client';
import { OperationTimeoutError, withTimeout } from '../utils/session';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { ExperimentalV2 } from '../v2/client-shim';
import {
  assertOrchestrator,
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';

const z = tool.schema;
const DEFAULT_BASELINE_TIMEOUT_MS = 5_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 5_000;

class ReviveAdmissionDeadlineError extends Error {}

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
  baselineTimeoutMs?: number;
  admissionTimeoutMs?: number;
  waitForIdleTimeoutMs?: number;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt.',
    args: {
      task_id: z
        .string()
        .describe('Tracked background task ID or Background Job Board alias'),
      prompt: z.string().min(1).describe('Prompt for the revived task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(
        options,
        toolContext,
        'task_revive',
      );
      const requested = args.task_id.trim();
      const prompt = args.prompt.trim();
      if (!requested) throw new Error('task_revive requires task_id');
      if (!prompt) throw new Error('task_revive requires prompt');

      const resolved = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      if (!resolved) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }

      let current = getCurrentReviveJob(
        options,
        parentSessionID,
        requested,
        resolved.taskID,
        resolved.generation,
      );
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
      };

      // Establish a real verification mechanism before any destructive abort.
      // A historical session.get outcome is not a live-idle capability.
      const session = getClient(options.input).session;
      const hasStatusMap = typeof session.status === 'function';
      const channel = (options.input as { experimental_v2?: ExperimentalV2 })
        .experimental_v2?.waitForSessionIdle;
      const waitForIdle =
        !hasStatusMap && typeof channel === 'function' ? channel : undefined;
      if (!hasStatusMap && !waitForIdle) {
        throw new Error(
          'task_revive idle-verification capability unavailable: the host must expose session.status or waitForSessionIdle; no abort or prompt was sent',
        );
      }

      let cancelledForRevive = false;
      if (current.state === 'running') {
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
          captured.taskID,
          captured.generation,
        );
      }

      if (!cancelledForRevive && !isReviveableRetainedJob(current)) {
        throw new Error(
          `Task ${requested} cannot be revived: state ${current.state} is not a verified retained terminal session`,
        );
      }

      const relaunchLease = options.backgroundJobBoard.acquireRelaunchLease(
        current.taskID,
        current.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be revived: relaunch lease unavailable`,
        );
      }

      let admissionOwner: { settled: boolean } | undefined;
      let launched:
        | ReturnType<
            TaskControlToolOptions['backgroundJobBoard']['registerLaunch']
          >
        | undefined;
      try {
        const observedLiveBusyAt = current.lastLiveBusyAt;
        const baselineMessageID = await withTimeout(
          revivedRunTracker.captureBaseline(current.taskID),
          Math.max(1, options.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS),
          'Baseline capture deadline exceeded; the revive prompt was NOT sent',
        );
        if (waitForIdle) {
          const timeoutMs = Math.max(
            1,
            options.waitForIdleTimeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
          );
          const deadline = Date.now() + timeoutMs;
          const waiting = waitForIdle(current.taskID);
          if (!waiting || typeof waiting.then !== 'function') {
            throw new Error(
              'Invalid session idle wait operation; the revive prompt was NOT sent',
            );
          }
          const completion = await withTimeout(
            waiting,
            timeoutMs,
            'Session idle wait timed out; the revive prompt was NOT sent',
          );
          // The 2.0.5 adapter does not forward AbortSignal. Late settlement is
          // observed by withTimeout but cannot resume this terminated flow.
          if (Date.now() >= deadline) {
            throw new OperationTimeoutError(
              'Session idle wait timed out; the revive prompt was NOT sent',
            );
          }
          if (completion !== undefined) {
            throw new Error(
              'Invalid session idle wait result; the revive prompt was NOT sent',
            );
          }
        } else {
          const liveSnapshot = await getRuntimeSessionStatusSnapshot(
            options.input,
          );
          const liveStatus = liveSnapshot.statuses.get(current.taskID);
          if (liveStatus === 'busy' || liveStatus === 'retry') {
            throw new Error(
              `Task ${requested} is executing at the host (live status: ${liveStatus}); the revive prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
            );
          }
          if (
            liveSnapshot.error !== undefined ||
            liveSnapshot.malformedSessionIDs.has(current.taskID)
          ) {
            throw new Error(
              `Task ${requested} could not be verified against the live session map (${liveSnapshot.error ?? 'malformed entry'}); the revive prompt was NOT sent. Retry task_revive.`,
            );
          }
        }
        if (typeof session.promptAsync !== 'function') {
          throw new Error('The host session does not support promptAsync');
        }
        // Both reads above await network I/O. Revalidate immediately before
        // sending: live busy can restore running even under a relaunch lease.
        // A changed busy timestamp also fences activity that stopped again.
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
          captured.taskID,
          captured.generation,
        );
        if (
          !options.backgroundJobBoard.validateLease(relaunchLease) ||
          !isReviveableRetainedJob(current) ||
          (current.lastLiveBusyAt !== undefined &&
            current.lastLiveBusyAt !== observedLiveBusyAt)
        ) {
          throw new Error(
            `Task ${requested} became active again (${current.state}) before the revive prompt was sent; the prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
          );
        }
        // A remote resume can race this send. `queue` avoids steering an
        // in-flight run, but may enqueue a continuation after an independent
        // resume; it does not deduplicate. The v1 SDK ignores this client-side
        // hint (not part of the HTTP request); the v2 shim forwards it.
        const admissionStartedAt = Date.now();
        const request = (
          session.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: current.taskID },
          query: { directory: options.input.directory },
          body: {
            agent: current.agent,
            parts: [{ type: 'text', text: prompt }],
          },
          delivery: 'queue',
        });
        // This captured owner, not the caller's deadline, owns settlement.
        // Keep exclusion while admission is unknown; never retry the write.
        const owner = { settled: false, transferred: false };
        admissionOwner = owner;
        const admission = Promise.resolve(request)
          .then((response) => {
            if (owner.settled) return;
            owner.settled = true;
            const responseError = getApiError(response);
            if (responseError !== undefined) {
              throw new Error(errorText(responseError));
            }
            // Deletion wins, but it leaves this write's lease alive. Only
            // that precise case may compensate; all stale owners/generations
            // still go through registerLaunch's existing rejection fence.
            if (
              !options.backgroundJobBoard.get(captured.taskID) &&
              options.backgroundJobBoard.validateLease(relaunchLease)
            ) {
              owner.transferred = true;
              // Starts synchronously under the lease, independently of the
              // admission race. Its abort is never awaited by this caller.
              void ownInvalidatedAdmission(options, relaunchLease);
              throw new Error(
                'admission accepted but invalidated by loss of the record; compensation initiated',
              );
            }
            launched = options.backgroundJobBoard.registerLaunch({
              taskID: current.taskID,
              parentSessionID,
              agent: current.agent,
              description: current.description,
              objective: current.objective,
              background: true,
              relaunchLease,
              now: admissionStartedAt,
            });
            revivedRunTracker.register({
              taskID: launched.taskID,
              generation: launched.generation,
              parentSessionID,
              baselineMessageID,
              attemptStartedAt: admissionStartedAt,
              description: launched.description,
            });
            options.backgroundJobSupervisor?.onLaunch(launched);
          })
          .finally(() => {
            owner.settled = true;
            if (!owner.transferred)
              options.backgroundJobBoard.releaseLease(relaunchLease);
          });
        const observation = admission
          .then(async () => {
            if (!launched) return;
            try {
              await revivedRunTracker.probe(
                launched.taskID,
                launched.generation,
              );
            } catch (error) {
              log('[task-revive] observation failed', {
                taskID: current.taskID,
                error: errorText(error),
              });
            }
          })
          .catch((error: unknown) => {
            if (launched) {
              options.backgroundJobBoard.markStatusUncertain(
                current.taskID,
                `task_revive failed: ${errorText(error)}`,
                launched.generation,
              );
            }
            log('[task-revive] admission failed', {
              taskID: current.taskID,
              error: errorText(error),
            });
          });
        let admissionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            admission,
            new Promise<never>((_, reject) => {
              admissionTimer = setTimeout(
                () =>
                  reject(
                    new ReviveAdmissionDeadlineError(
                      'Revive admission deadline exceeded',
                    ),
                  ),
                Math.max(
                  1,
                  options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
                ),
              );
            }),
          ]);
        } catch (error) {
          // Preserve the local race outcome, regardless of later settlement.
          // A timeout error from the transport is still an admission failure.
          if (error instanceof ReviveAdmissionDeadlineError) {
            return renderReviveOutput(current, true);
          }
          throw error;
        } finally {
          clearTimeout(admissionTimer);
        }
        // Observe fast completion without holding exclusion over the probe.
        await observation;
      } catch (error) {
        throw new Error(`Task ${requested} revive failed: ${errorText(error)}`);
      } finally {
        // Before a write exists there is no late admission to protect.
        if (!admissionOwner)
          options.backgroundJobBoard.releaseLease(relaunchLease);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobBoard.get(current.taskID);
      if (!latest || latest.generation !== launched.generation) {
        throw new Error(
          `Task ${requested} revive became stale before launch completed`,
        );
      }
      return renderReviveOutput(latest);
    },
  });

  return { task_revive };
}

/**
 * Owns a single compensating abort after deletion invalidates an accepted
 * admission. The board retains the token even without a job: no TTL, retry,
 * terminal publication, or recovery is allowed on this path.
 */
async function ownInvalidatedAdmission(
  options: TaskReviveToolOptions,
  lease: BackgroundJobLease,
): Promise<void> {
  const board = options.backgroundJobBoard;
  const { taskID, generation } = lease;
  const stillOwns = () => {
    const valid = board.validateLease(lease) && !board.get(taskID);
    if (!valid)
      log('[task-revive] compensation ownership lost', { taskID, generation });
    return valid;
  };
  try {
    const session = getClient(options.input).session;
    // No await between this fence and issuing the only compensating write.
    if (!stillOwns()) return;
    const response = await session.abort({ path: { id: taskID } });
    // No local abort timeout: an idle read cannot retire a token while the
    // remote write could still execute. Only actual settlement reaches here.
    if (!stillOwns()) return;
    const responseError = getApiError(response);
    if (responseError !== undefined)
      throw new Error(`abort failed: ${errorText(responseError)}`);

    // Historical session.get outcomes cannot prove the accepted run stopped.
    // Take fresh live evidence after abort settlement, with a bounded budget.
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.verifyAbortMs ?? 1_500,
    });
    if (!stillOwns()) return;
    const status = snapshot.statuses.get(taskID);
    if (
      snapshot.error !== undefined ||
      snapshot.malformedSessionIDs.has(taskID) ||
      status === 'busy' ||
      status === 'retry'
    ) {
      throw new Error(
        `live quiescence not verified: ${snapshot.error ?? status ?? 'malformed entry'}`,
      );
    }

    // Valid idle/absence proves current quiescence, not purging queued work.
    // Revalidate above and release synchronously: never retire a successor.
    board.releaseLease(lease);
    log('[task-revive] compensation quiescence verified', {
      taskID,
      generation,
    });
  } catch (error) {
    // Explicit quarantine: retain exclusion without fabricating a cancelled
    // record or notifying a deleted parent. No automatic recovery/retry.
    log('[task-revive] compensation unconfirmed', {
      taskID,
      generation,
      error: errorText(error),
      leaseRetained: board.validateLease(lease),
    });
  }
}

function renderReviveOutput(
  record: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
  admissionUnknown = false,
): string {
  const state =
    record.state === 'reconciled'
      ? (record.terminalState ?? record.state)
      : record.state;
  const lines = [
    `task_id: ${record.taskID}`,
    `generation: ${record.generation}`,
    `state: ${state}`,
    `status: ${admissionUnknown ? 'admission_unknown' : state === 'running' ? 'started' : state}`,
  ];
  if (record.statusUncertain) {
    lines.push(
      'status_uncertain: true',
      `observation: ${record.lastStatusError ?? 'Task termination is unconfirmed.'}`,
    );
  }
  if (admissionUnknown) {
    lines.push(
      'The host may have accepted the prompt. Admission is still pending; do not retry task_revive. Use task_status to inspect the session.',
    );
  } else if (record.resultSummary !== undefined) {
    const tag = state === 'completed' ? 'task_result' : 'task_error';
    lines.push('', `<${tag}>`, record.resultSummary, `</${tag}>`);
  }
  return lines.join('\n');
}

function getCurrentReviveJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>> {
  const current = options.backgroundJobBoard.get(taskID);
  const resolved = options.backgroundJobBoard.resolve(
    parentSessionID,
    requested,
  );
  if (!current || !resolved || resolved.taskID !== taskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation || resolved.generation !== generation) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function isReviveableRetainedJob(
  job: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): boolean {
  if (job.statusUncertain) return false;
  if (job.state === 'stopped') return true;
  if (
    job.state === 'completed' ||
    job.state === 'error' ||
    job.state === 'cancelled'
  ) {
    return true;
  }
  return job.state === 'reconciled' && job.terminalState !== undefined;
}

function getApiError(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  return record.error === undefined || record.error === null
    ? undefined
    : record.error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
