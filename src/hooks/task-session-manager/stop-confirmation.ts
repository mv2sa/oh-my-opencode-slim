import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';

/** Default grace after the parent can accept terminal delivery again. */
export const DEFAULT_STOP_CONFIRMATION_MS = 30_000;

export const STOPPED_WITHOUT_TERMINAL_RESULT =
  'Background session stopped before a terminal task result was received.';

export type StopConfirmationTracker = {
  pendingManagedTaskIds: Set<string>;
  contextFilesForPrompt(taskId: string): ContextFile[];
  prune(board: { taskIDs(): Set<string> }): void;
};

export function applyConfirmedStop(options: {
  backgroundJobBoard: BackgroundJobStore;
  taskID: string;
  observedAt: number;
  generation: number;
  taskContextTracker: StopConfirmationTracker;
}): BackgroundJobRecord | undefined {
  const stopped = options.backgroundJobBoard.markStopped(
    options.taskID,
    STOPPED_WITHOUT_TERMINAL_RESULT,
    options.observedAt,
    options.generation,
  );
  if (stopped?.state !== 'stopped') return stopped;
  options.taskContextTracker.pendingManagedTaskIds.delete(options.taskID);
  options.backgroundJobBoard.addContext(
    options.taskID,
    options.taskContextTracker.contextFilesForPrompt(options.taskID),
  );
  options.taskContextTracker.prune(options.backgroundJobBoard);
  return stopped;
}

/**
 * Host-declared idle is only a stop candidate. The first observation starts a
 * grace clock; a later observation after the grace confirms the stop. Live
 * child activity or a parent terminal-delivery barrier leaves the job running.
 */
export function observeNonBusyRuntime(options: {
  backgroundJobBoard: BackgroundJobStore;
  taskID: string;
  observedAt: number;
  generation: number;
  graceMs: number;
  lastStatusError: string;
  confirmationBlocked?: boolean;
  taskContextTracker: StopConfirmationTracker;
}): BackgroundJobRecord | undefined {
  const job = options.backgroundJobBoard.get(options.taskID);
  if (job?.state !== 'running' || job.generation !== options.generation) {
    return job;
  }
  if (
    job.lastLiveBusyAt !== undefined &&
    job.lastLiveBusyAt > options.observedAt
  ) {
    return job;
  }
  if (options.confirmationBlocked) {
    options.backgroundJobBoard.clearStopConfirmation(
      options.taskID,
      options.generation,
    );
    return options.backgroundJobBoard.markStatusUncertain(
      options.taskID,
      options.lastStatusError,
      options.generation,
      options.observedAt,
    );
  }

  const observationTime = options.observedAt + 1;
  const startedAt = job.stopConfirmationStartedAt;
  if (
    startedAt === undefined ||
    observationTime - startedAt < options.graceMs
  ) {
    if (startedAt === undefined) {
      options.backgroundJobBoard.noteStopConfirmation(
        options.taskID,
        observationTime,
        options.generation,
      );
    }
    return options.backgroundJobBoard.markStatusUncertain(
      options.taskID,
      options.lastStatusError,
      options.generation,
      options.observedAt,
    );
  }

  return applyConfirmedStop({
    backgroundJobBoard: options.backgroundJobBoard,
    taskID: options.taskID,
    observedAt: observationTime,
    generation: options.generation,
    taskContextTracker: options.taskContextTracker,
  });
}
