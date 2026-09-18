import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobStore } from '../utils/background-job-store';
import {
  createBackgroundJobTerminalGate,
  type BackgroundJobTerminalGate,
  runtimeObservationFromSnapshot,
} from '../utils/background-job-terminal-gate';
import {
  classifyTerminalEvidence,
  fetchChildTranscript,
} from '../utils/child-transcript';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN } from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
  type RuntimeSessionStatusSnapshot,
} from '../utils/session-runtime-status';

interface TaskResultToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  terminalGate?: BackgroundJobTerminalGate;
}

function pending(
  taskID: string,
  uncertain: boolean,
  status?: 'busy' | 'idle' | 'retry',
  tracked = true,
): string {
  if (status === 'idle')
    return [
      `task_id: ${taskID}`,
      'state: pending',
      'message: Task is quiescent; wait for terminal reconciliation before retrieving its result.',
      'next: retry task_result after the terminal notification',
    ].join('\n');
  return [
    `task_id: ${taskID}`,
    uncertain
      ? 'state: running (unconfirmed)'
      : `state: ${status === 'retry' ? 'retry' : 'running'}`,
    uncertain
      ? 'message: Live task status is uncertain; no definitive running state is available.'
      : 'message: Task is still running. Wait for its terminal result.',
    `next: ${!tracked ? 'retry task_result after the task finishes' : uncertain ? 'retry task_result or use task_status to inspect the task' : 'use task_status to inspect the task'}`,
  ].join('\n');
}

export function createTaskResultTool(
  options: TaskResultToolOptions,
): Record<string, ToolDefinition> {
  const gate =
    options.terminalGate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard: options.backgroundJobBoard,
      input: options.input,
    });
  return {
    task_result: tool({
      description: `Retrieve the final text already produced by a specialist task, or inspect its active state without resuming or re-running it.

Use this when the user asks to see a prior task's full result, or before retrying work whose completed output may already answer the request. If the task is still running, this returns a status message; only a completed task returns its final text. Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board. This tool is read-only and never sends a new prompt to the specialist.`,
      args: {
        task_id: tool.schema
          .string()
          .describe('Task ID or Background Job Board alias'),
      },
      async execute(args, toolContext) {
        const parentSessionID = toolContext?.sessionID;
        if (!parentSessionID) throw new Error('task_result requires sessionID');
        const requested = args.task_id.trim();
        if (!requested) throw new Error('task_result requires task_id');
        const board = options.backgroundJobBoard;
        const tracked = board.resolve(parentSessionID, requested);
        const taskID = tracked?.taskID ?? requested;
        if (!SESSION_ID_PATTERN.test(taskID))
          throw new Error(`Unknown task ID or alias: ${requested}`);

        // Inspect every retained state BEFORE rejection, acknowledgement or text
        // retrieval. Busy retracts even a consumed or timed-out publication.
        let snapshot: RuntimeSessionStatusSnapshot | undefined;
        if (
          tracked &&
          typeof getClient(options.input).session?.status === 'function'
        ) {
          const observation = gate.capture(tracked);
          if (observation) {
            snapshot = await getRuntimeSessionStatusSnapshot(options.input);
            gate.observe(
              observation,
              runtimeObservationFromSnapshot(
                snapshot,
                taskID,
                observation.readStartedAt,
              ),
            );
          }
        }
        const result = tracked ? await gate.reconcile(tracked) : undefined;
        const current = board.resolve(parentSessionID, requested);
        if (
          tracked &&
          (!current ||
            current.generation !== tracked.generation ||
            result?.kind === 'stale')
        ) {
          throw new Error(
            `Task ${requested} changed generation while its result was being retrieved`,
          );
        }
        if (current?.state === 'running')
          return pending(
            taskID,
            current.statusUncertain,
            snapshot && runtimeSessionStatus(snapshot, taskID),
          );

        const token = current ? gate.capture(current) : undefined;
        const client = getClient(options.input);
        if (typeof client.session.get === 'function') {
          const response = await client.session.get({
            path: { id: taskID },
            query: { directory: options.input.directory },
          });
          if (response.data?.parentID !== parentSessionID)
            throw new Error(
              `Task ${requested} does not belong to this session`,
            );
        } else if (!current)
          throw new Error(
            `Task ${requested} is not tracked by this session and cannot be verified`,
          );

        if (current) {
          const latest = board.get(taskID);
          const after = gate.capture(current);
          if (
            latest?.generation !== current.generation ||
            latest.terminalRevision !== current.terminalRevision ||
            after?.activityRevision !== token?.activityRevision ||
            after?.attemptRevision !== token?.attemptRevision ||
            after?.episode !== token?.episode
          ) {
            throw new Error(
              `Task ${requested} changed generation or publication while its result was being retrieved; wait for its current terminal result instead of retrieving it.`,
            );
          }
          const state =
            current.state === 'reconciled'
              ? current.terminalState
              : current.state;
          if (state === 'completed' && result?.kind !== 'committed')
            return pending(taskID, true);
          board.markUsed(parentSessionID, taskID);
          if (state === 'error')
            throw new Error(
              `Task ${requested} ended in error: ${current.lastStatusError ?? current.resultSummary ?? 'no error details available'}`,
            );
          if (state === 'cancelled')
            throw new Error(
              `Task ${requested} was cancelled: ${current.resultSummary?.replace(/^cancelled:\s*/i, '') ?? 'cancelled'}`,
            );
          if (state !== 'completed' || !current.resultSummary?.trim())
            throw new Error(
              `Task ${requested} has no confirmed completed result`,
            );
          return current.resultSummary;
        }

        snapshot = await getRuntimeSessionStatusSnapshot(options.input);
        const status = runtimeSessionStatus(snapshot, taskID);
        if (status === 'busy' || status === 'retry')
          return pending(taskID, false, status, false);
        if (snapshot.error || snapshot.malformedSessionIDs.has(taskID))
          return pending(taskID, true, undefined, false);
        const response = await fetchChildTranscript(
          client,
          taskID,
          options.input.directory,
        );
        const evidence = classifyTerminalEvidence(response);
        if (evidence.verdict !== 'completed')
          throw new Error(
            `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
          );
        return evidence.text;
      },
    }),
  };
}
