import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';
import {
  extractFinalSessionResult,
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../../utils';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  DEFAULT_STOP_CONFIRMATION_MS,
  observeNonBusyRuntime,
} from './stop-confirmation';

export const RUNTIME_STATUS_RECONCILE_DELAY_MS = 5_000;
export const RUNTIME_RESULT_PROBE_TIMEOUT_MS = 5_000;

type FinalSessionProof = Awaited<
  ReturnType<typeof extractFinalSessionResult>
> & {
  completedAt?: number;
};

function finalAssistantCompletedAt(data: unknown): number | undefined {
  if (!Array.isArray(data)) return undefined;
  const last = data.at(-1);
  if (!isRecord(last) || !isRecord(last.info)) return undefined;
  if (last.info.role !== 'assistant' || !isRecord(last.info.time)) {
    return undefined;
  }
  const completedAt = last.info.time.completed;
  return typeof completedAt === 'number' && Number.isFinite(completedAt)
    ? completedAt
    : undefined;
}

/** Fetch once, then replay that response through the shared final-result parser. */
async function extractFinalSessionProof(
  input: PluginInput,
  taskID: string,
): Promise<FinalSessionProof> {
  const messagesResult = await input.client.session.messages({
    path: { id: taskID },
    ...(input.directory ? { query: { directory: input.directory } } : {}),
  });
  const replayClient = {
    session: { messages: async () => messagesResult },
  } as unknown as Parameters<typeof extractFinalSessionResult>[0];
  const result = await extractFinalSessionResult(replayClient, taskID, {
    includeReasoning: false,
  });
  return {
    ...result,
    completedAt: finalAssistantCompletedAt(messagesResult.data),
  };
}

async function withResultProbeTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Session result probe timed out');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Session result probe timed out'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ParentActivityObservation = {
  active: boolean;
  revision: number;
};

export function createRuntimeStatusReconciler(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  delayMs?: number;
  statusTimeoutMs?: number;
  resultProbeTimeoutMs?: number;
  stopConfirmationGraceMs?: number;
  getParentActivity?: (
    parentSessionID: string,
  ) => ParentActivityObservation | undefined;
  clearParentActivityIfUnchanged?: (
    parentSessionID: string,
    expectedRevision: number,
  ) => void;
  isParentFallbackInProgress?: (parentSessionID: string) => boolean;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    contextFilesForPrompt(taskId: string): ContextFile[];
    prune(board: { taskIDs(): Set<string> }): void;
  };
}) {
  const delayMs = options.delayMs ?? RUNTIME_STATUS_RECONCILE_DELAY_MS;
  const resultProbeTimeoutMs =
    options.resultProbeTimeoutMs ?? RUNTIME_RESULT_PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let activeReconcile: Promise<void> | undefined;
  let rerunRequested = false;

  async function probeMissingRunningJob(
    job: BackgroundJobRecord,
  ): Promise<void> {
    const livenessBoundaryAtProbeStart = job.lastLiveBusyAt;
    let result: FinalSessionProof | undefined;
    try {
      result = await withResultProbeTimeout(
        () => extractFinalSessionProof(options.input, job.taskID),
        resultProbeTimeoutMs,
      );
    } catch (error) {
      log(
        '[task-session-manager] missing runtime session result probe was inconclusive',
        {
          taskID: job.taskID,
          generation: job.generation,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (disposed) return;
    const currentAfterProbe = options.backgroundJobBoard.get(job.taskID);
    if (
      currentAfterProbe?.taskID !== job.taskID ||
      currentAfterProbe.state !== 'running' ||
      currentAfterProbe.generation !== job.generation
    ) {
      return;
    }
    if (currentAfterProbe.lastLiveBusyAt !== livenessBoundaryAtProbeStart) {
      return;
    }

    const visibleText = result?.text.trim() ?? '';
    const currentRunAndLivenessBoundary = Math.max(
      currentAfterProbe.runStartedAt,
      currentAfterProbe.lastLaunchedAt,
      currentAfterProbe.lastLiveBusyAt ?? Number.NEGATIVE_INFINITY,
    );
    if (
      result?.terminal !== true ||
      result.completedAt === undefined ||
      result.completedAt < currentRunAndLivenessBoundary ||
      visibleText.length === 0
    ) {
      return;
    }

    const completed = options.backgroundJobBoard.updateStatus({
      taskID: job.taskID,
      state: 'completed',
      resultSummary: visibleText,
      expectedGeneration: job.generation,
    });
    if (
      completed?.taskID !== job.taskID ||
      completed.generation !== job.generation ||
      completed.state !== 'completed' ||
      !options.backgroundJobBoard.isTerminalUnreconciled(job.taskID)
    ) {
      return;
    }
    options.taskContextTracker.pendingManagedTaskIds.delete(job.taskID);
    options.backgroundJobBoard.addContext(
      job.taskID,
      options.taskContextTracker.contextFilesForPrompt(job.taskID),
    );
    options.taskContextTracker.prune(options.backgroundJobBoard);
    log(
      '[task-session-manager] completed missing runtime session from terminal result probe',
      {
        taskID: completed.taskID,
        alias: completed.alias,
        parentSessionID: completed.parentSessionID,
        generation: completed.generation,
      },
    );
  }

  function schedule(): void {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      return;
    }
    if (timer) return;
    if (
      !options.backgroundJobBoard.list().some((job) => job.state === 'running')
    ) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile();
    }, delayMs);
    timer.unref?.();
  }

  async function reconcilePass(): Promise<void> {
    if (disposed) return;
    const running = options.backgroundJobBoard
      .list()
      .filter((job) => job.state === 'running');
    if (running.length === 0) return;

    const parentRevisionsAtRequest = new Map<string, number | undefined>();
    const missingResultProbes: Promise<void>[] = [];
    for (const job of running) {
      if (!parentRevisionsAtRequest.has(job.parentSessionID)) {
        parentRevisionsAtRequest.set(
          job.parentSessionID,
          options.getParentActivity?.(job.parentSessionID)?.revision,
        );
      }
    }

    const requestStartedAt = Date.now();
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.statusTimeoutMs,
    });
    if (disposed) return;
    const observedAt = Date.now();
    const graceMs =
      options.stopConfirmationGraceMs ?? DEFAULT_STOP_CONFIRMATION_MS;
    if (snapshot.error) {
      for (const job of running) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          `Runtime status lookup failed: ${snapshot.error}`,
          job.generation,
        );
      }
      log('[task-session-manager] runtime status reconciliation uncertain', {
        activeJobs: running.length,
        error: snapshot.error,
      });
      return;
    }

    for (const job of running) {
      if (disposed) return;
      const current = options.backgroundJobBoard.get(job.taskID);
      if (
        current?.state !== 'running' ||
        current.generation !== job.generation
      ) {
        continue;
      }
      const status = runtimeSessionStatus(snapshot, job.taskID);
      if (status === 'busy' || status === 'retry') {
        options.backgroundJobBoard.markRunningFromLiveSession(
          job.taskID,
          observedAt,
          job.generation,
        );
        continue;
      }
      if (
        status === undefined &&
        snapshot.malformedSessionIDs.has(job.taskID)
      ) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          'Runtime status response did not contain a recognized session state.',
          job.generation,
        );
        continue;
      }

      if (status === undefined) {
        options.backgroundJobBoard.markStatusUncertain(
          job.taskID,
          'Runtime status response did not contain a live session state; task termination is unconfirmed.',
          job.generation,
        );
        missingResultProbes.push(probeMissingRunningJob(job));
        continue;
      }

      const parentStatus = runtimeSessionStatus(
        snapshot,
        current.parentSessionID,
      );
      const parentActivity = options.getParentActivity?.(
        current.parentSessionID,
      );
      const parentRevisionAtRequest = parentRevisionsAtRequest.get(
        current.parentSessionID,
      );
      const parentActivityChangedDuringRequest =
        parentActivity !== undefined &&
        parentActivity.revision !== parentRevisionAtRequest;
      const snapshotActive =
        parentStatus === 'busy' || parentStatus === 'retry';
      const parentFallbackInProgress =
        options.isParentFallbackInProgress?.(current.parentSessionID) === true;
      const parentActivityBlocking = parentFallbackInProgress
        ? true
        : parentActivityChangedDuringRequest
          ? parentActivity?.active === true
          : snapshotActive;
      if (
        !parentActivityBlocking &&
        !parentFallbackInProgress &&
        parentActivity?.active === true &&
        !parentActivityChangedDuringRequest
      ) {
        options.clearParentActivityIfUnchanged?.(
          current.parentSessionID,
          parentActivity.revision,
        );
      }

      const updated = observeNonBusyRuntime({
        backgroundJobBoard: options.backgroundJobBoard,
        taskID: job.taskID,
        observedAt: requestStartedAt,
        generation: job.generation,
        graceMs,
        lastStatusError: parentActivityBlocking
          ? 'Parent session is active; terminal task delivery is pending.'
          : 'Runtime session is idle; task termination is unconfirmed.',
        confirmationBlocked: parentActivityBlocking,
        taskContextTracker: options.taskContextTracker,
      });
      if (updated?.state === 'stopped') {
        log('[task-session-manager] confirmed runtime-stopped job', {
          taskID: updated.taskID,
          alias: updated.alias,
          parentSessionID: updated.parentSessionID,
        });
        continue;
      }
      log(
        '[task-session-manager] runtime session quiescent; terminal result pending',
        {
          taskID: job.taskID,
          generation: job.generation,
        },
      );
    }
    await Promise.all(missingResultProbes);
  }

  async function reconcile(): Promise<void> {
    if (disposed) return;
    if (activeReconcile) {
      rerunRequested = true;
      await activeReconcile;
      return;
    }

    const run = (async () => {
      try {
        do {
          rerunRequested = false;
          await reconcilePass();
        } while (!disposed && rerunRequested);
      } finally {
        activeReconcile = undefined;
        schedule();
      }
    })();
    activeReconcile = run;
    await run;
  }

  function dispose(): void {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { schedule, reconcile, dispose };
}
