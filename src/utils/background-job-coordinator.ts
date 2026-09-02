import type {
  BackgroundJobBoard,
  BackgroundJobLaunchInput,
  BackgroundJobLease,
  BackgroundJobPromptMetadata,
  BackgroundJobRecord,
  BackgroundJobStatusInput,
  ContextFile,
  WallClockTimeoutClaimInput,
  WallClockTimeoutFinalizeInput,
} from './background-job-board';
import type { BackgroundJobStore } from './background-job-store';
import { log } from './logger';

type TerminalStateListener = (taskID: string) => void;
type TerminalOutcomeListener = (record: BackgroundJobRecord) => void;

/**
 * BackgroundJobCoordinator owns the lifecycle policy for background jobs.
 * It sits between the board and its consumers, providing:
 * - Subscription interface for terminal state notifications (replaces fire-and-forget)
 * - Lifecycle policy: determines when jobs are terminal, when closes should be deferred
 * - Single-writer contract: coordinator is the sole writer to the board
 *
 * The board's guards prevent silent overwrites. The coordinator adds:
 * - Centralized notification with guaranteed delivery
 * - Re-checks board state before notifying (handles races)
 */
export class BackgroundJobCoordinator implements BackgroundJobStore {
  private terminalStateListeners: TerminalStateListener[] = [];
  private terminalOutcomeListeners: TerminalOutcomeListener[] = [];
  // Stores session IDs (which equal task IDs) awaiting close after background job completes
  private readonly deferredIdleCloses = new Set<string>();

  constructor(private readonly board: BackgroundJobBoard) {
    // Subscribe to the board's terminal state notifications
    this.board.addTerminalStateListener((taskID) => {
      this.handleTerminalState(taskID);
    });
  }

  // ── Terminal state notification (guaranteed delivery) ─────────────

  addTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners.push(listener);
  }

  removeTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners = this.terminalStateListeners.filter(
      (entry) => entry !== listener,
    );
  }

  /**
   * Handle terminal state from board. Re-checks board state to handle races.
   * This is the centralized lifecycle policy.
   */
  private handleTerminalState(taskID: string): void {
    // Re-check board state to handle races
    const state = this.board.getState(taskID);
    if (state === undefined) return; // Job was already cleaned up

    // Check if this session should now close
    if (this.retryDeferredClose(taskID)) {
      // Notify listeners that session should close
      for (const listener of this.terminalStateListeners) {
        try {
          listener(taskID);
        } catch (error) {
          log('Coordinator terminal state listener threw', {
            taskID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const record = this.board.get?.(taskID);
    if (record) {
      for (const listener of this.terminalOutcomeListeners) {
        try {
          listener(record);
        } catch (error) {
          log('Coordinator terminal outcome listener threw', {
            taskID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** Observe every canonical terminal publication, including non-idle jobs. */
  addTerminalOutcomeListener(listener: TerminalOutcomeListener): void {
    this.terminalOutcomeListeners.push(listener);
  }

  removeTerminalOutcomeListener(listener: TerminalOutcomeListener): void {
    this.terminalOutcomeListeners = this.terminalOutcomeListeners.filter(
      (entry) => entry !== listener,
    );
  }

  // ── Lifecycle policy ─────────────────────────────────────────────

  /**
   * Evaluate close policy. Returns true if session should close now.
   * Mutates deferred state: adds to deferred set if running, removes if not.
   */
  deferIfRunning(sessionId: string): boolean {
    if (!this.board.isRunning(sessionId)) {
      this.deferredIdleCloses.delete(sessionId);
      return true;
    }
    this.deferredIdleCloses.add(sessionId);
    return false;
  }

  /**
   * Retry closing a deferred session. Called when a background job completes.
   * Returns true if the session should now close.
   */
  retryDeferredClose(sessionId: string): boolean {
    if (!this.deferredIdleCloses.has(sessionId)) return false;
    return this.deferIfRunning(sessionId);
  }

  /**
   * Clear deferred close state for a session being deleted.
   */
  clearDeferredClose(sessionId: string): void {
    this.deferredIdleCloses.delete(sessionId);
  }

  // ── Mutation methods (sole writer to board) ──────────────────────

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    return this.board.registerLaunch(input);
  }

  acquireCancellationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireCancellationLease(taskID, generation);
  }

  acquireRelaunchLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireRelaunchLease(taskID, generation);
  }

  acquireMessageLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireMessageLease(taskID, generation);
  }

  acquireTerminalNotificationLease(
    taskID: string,
    generation: number,
  ): BackgroundJobLease | undefined {
    return this.board.acquireTerminalNotificationLease(taskID, generation);
  }

  validateLease(lease: BackgroundJobLease): boolean {
    return this.board.validateLease(lease);
  }

  releaseLease(lease: BackgroundJobLease): boolean {
    return this.board.releaseLease(lease);
  }

  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined {
    return this.board.updateStatus(input);
  }

  updateFromStatusOutput(output: string): BackgroundJobRecord | undefined {
    return this.board.updateFromStatusOutput(output);
  }

  claimWallClockDeadline(
    input: WallClockTimeoutClaimInput,
  ): BackgroundJobRecord | undefined {
    return this.board.claimWallClockDeadline(input);
  }

  finalizeWallClockTimeout(
    input: WallClockTimeoutFinalizeInput,
  ): BackgroundJobRecord | undefined {
    return this.board.finalizeWallClockTimeout(input);
  }

  markRunningFromLiveSession(
    taskID: string,
    now = Date.now(),
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    return this.board.markRunningFromLiveSession(
      taskID,
      now,
      expectedGeneration,
    );
  }

  markStopped(
    taskID: string,
    resultSummary: string,
    observedAt = Date.now(),
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    return this.board.markStopped(
      taskID,
      resultSummary,
      observedAt,
      expectedGeneration,
      now,
    );
  }

  noteStopConfirmation(
    taskID: string,
    startedAt: number,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    return this.board.noteStopConfirmation(
      taskID,
      startedAt,
      expectedGeneration,
    );
  }

  clearStopConfirmation(
    taskID: string,
    expectedGeneration?: number,
  ): BackgroundJobRecord | undefined {
    return this.board.clearStopConfirmation(taskID, expectedGeneration);
  }

  markStatusUncertain(
    taskID: string,
    lastStatusError: string,
    expectedGeneration?: number,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    return this.board.markStatusUncertain(
      taskID,
      lastStatusError,
      expectedGeneration,
      now,
    );
  }

  markReconciled(
    taskID: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    return this.board.markReconciled(taskID, now);
  }

  markCancelled(
    taskID: string,
    reason?: string,
    now = Date.now(),
    options: {
      force?: boolean;
      expectedGeneration?: number;
      cancellationLease?: BackgroundJobLease;
    } = {},
  ): BackgroundJobRecord | undefined {
    return this.board.markCancelled(taskID, reason, now, options);
  }

  // ── Query methods ────────────────────────────────────────────────

  get(taskID: string): BackgroundJobRecord | undefined {
    return this.board.get(taskID);
  }

  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined {
    return this.board.field(taskID, key);
  }

  isRunning(taskID: string): boolean {
    return this.board.isRunning(taskID);
  }

  isTerminalUnreconciled(taskID: string): boolean {
    return this.board.isTerminalUnreconciled(taskID);
  }

  getResultSummary(taskID: string): string | undefined {
    return this.board.getResultSummary(taskID);
  }

  getLastLiveBusyAt(taskID: string): number | undefined {
    return this.board.getLastLiveBusyAt(taskID);
  }

  getParentSessionID(taskID: string): string | undefined {
    return this.board.getParentSessionID(taskID);
  }

  getState(taskID: string): BackgroundJobRecord['state'] | undefined {
    return this.board.getState(taskID);
  }

  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined {
    return this.board.resolve(parentSessionID, taskIDOrAlias);
  }

  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    return this.board.resolveReusable(parentSessionID, taskIDOrAlias, agent);
  }

  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    return this.board.resolveRecoverable(parentSessionID, taskIDOrAlias, agent);
  }

  markUsed(parentSessionID: string, key: string, now = Date.now()): void {
    this.board.markUsed(parentSessionID, key, now);
  }

  taskIDs(): Set<string> {
    return this.board.taskIDs();
  }

  addContext(taskID: string, files: ContextFile[]): void {
    this.board.addContext(taskID, files);
  }

  list(parentSessionID?: string): BackgroundJobRecord[] {
    return this.board.list(parentSessionID);
  }

  hasRunning(parentSessionID: string): boolean {
    return this.board.hasRunning(parentSessionID);
  }

  hasTerminalUnreconciled(parentSessionID: string): boolean {
    return this.board.hasTerminalUnreconciled(parentSessionID);
  }

  hasConvergenceSignals(taskID: string, threshold = 3): boolean {
    return this.board.hasConvergenceSignals(taskID, threshold);
  }

  formatForPrompt(
    parentSessionID: string,
    now = Date.now(),
  ): string | undefined {
    return this.board.formatForPrompt(parentSessionID, now);
  }

  formatForPromptWithMetadata(
    parentSessionID: string,
    now = Date.now(),
  ): BackgroundJobPromptMetadata | undefined {
    return this.board.formatForPromptWithMetadata(parentSessionID, now);
  }

  clearParent(parentSessionID: string): void {
    this.board.clearParent(parentSessionID);
  }

  drop(taskID: string): void {
    this.board.drop(taskID);
  }
}
