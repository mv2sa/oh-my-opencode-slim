import { log } from '../../utils/logger';

/**
 * Tool loop guard.
 *
 * Detects a session re-issuing the exact same tool call (same tool, same
 * arguments) consecutively with no change, which is how model-side infinite
 * loops present (see issue #1071: sub-agent repeating identical read/grep
 * calls forever).
 *
 * Behavior:
 * - N consecutive calls with identical arguments AND identical results
 *   (LOOP_GUARD_WARN_AT): append corrective text to the tool output telling
 *   the model to stop and change approach.
 * - For read-only file tools (READONLY_BLOCK_TOOLS), M consecutive calls
 *   with identical arguments AND identical results (LOOP_GUARD_BLOCK_AT):
 *   refuse the next identical call in tool.execute.before by throwing, so
 *   the loop terminates instead of running forever.
 * - The run counter only advances in tool.execute.after, when an identical-
 *   args call produced an output byte-identical to the prior call. A call
 *   that returns NEW information resets the run, so it can never accumulate
 *   toward a block (a legitimate re-read after the file changed).
 * - task_status/task_result use a separate task-ID/lifecycle-state stream, so
 *   alternating polls are still recognized without treating tool changes as
 *   progress. The stream resets at a parent turn boundary or meaningful
 *   action.
 * - tool.execute.before never increments the counter, so overlapping
 *   parallel calls cannot inflate the count before their results are known.
 *   A refusal only happens after the run is already confirmed identical.
 *
 * Scope is deliberately narrow to avoid breaking legitimate repeated calls:
 * - All non-exempt tools warn at N confirmed-identical consecutive calls.
 * - Only read-only file-analysis tools (read, grep, glob) hard-block after M
 *   confirmed identical results to prevent infinite loops (#1071).
 * - External async process/task supervision tools (task_status, task_result)
 *   warn at N calls but stay warn-only (never hard-block) to avoid deadlocking
 *   terminal result retrieval for long-running background tasks.
 * - Task management and lifecycle tools (task, task_cancel, task_message,
 *   task_revive, wait_for_*) remain exempt; task-session-manager owns its
 *   own duplicate-spawn guards (#1056/#1070).
 *
 * Precedent: json-error-recovery (output warning) and task-session-manager
 * (before-hook refusal).
 */

const LOOP_GUARD_WARN_AT = 3;
const LOOP_GUARD_BLOCK_AT = 5;

/**
 * Tools exempt from the entire guard: long-lived task management / lifecycle
 * tools whose identical repeated invocation is legitimate.
 */
const LOOP_GUARD_EXEMPT: Record<string, true> = {
  task: true,
  task_cancel: true,
  task_message: true,
  task_revive: true,
  wait_for_user: true,
  wait_for_background_tasks: true,
};

/**
 * Tools that may be hard-blocked when repeated. Only read-only file analysis
 * (read, grep, glob) hard-blocks after confirmed identical results (#1071).
 * External task supervision tools (task_status, task_result) and tools with
 * side effects stay warn-only to prevent terminal result retrieval deadlocks.
 */
const LOOP_GUARD_BLOCK_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
};

const LOOP_GUARD_MARKER = '[REPEATED TOOL CALLS - STOP]';

export const LOOP_GUARD_WARNING = `
${LOOP_GUARD_MARKER}

You have issued the exact same tool call with identical arguments ${LOOP_GUARD_WARN_AT} times in a row and received identical results. This is an infinite loop and you are making no progress.

STOP repeating this call. Instead:
1. Reconsider what you are looking for; the result above already contains what this call can tell you.
2. If you need different information, make a DIFFERENT call (different path, pattern, or tool).
3. If the task is actually done, produce your final answer now instead of calling more tools.
`;

/** Max sessions tracked before evicting the least-recently-observed session. */
const MAX_TRACKED_SESSIONS = 512;

/** Deterministic fingerprint of tool + args, insensitive to key order. */
function fingerprint(tool: string, args: unknown): string {
  return `${tool.toLowerCase()}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`;
}

interface SessionState {
  /** Fingerprint of the most recent completed eligible call (args). */
  last: string;
  /** Consecutive completed calls with identical args AND identical output. */
  runs: number;
  /** Fingerprint of the most recent completed call's output. */
  lastOutput: string;
}

interface CallState {
  sessionID: string;
  key: string;
  taskID?: string;
}

interface TaskSupervisionState {
  lifecycleState: string;
  runs: number;
}

const TASK_SUPERVISION_TOOLS = new Set(['task_status', 'task_result']);

function taskIDFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return undefined;
  const taskID = (args as Record<string, unknown>).task_id;
  return typeof taskID === 'string' && taskID.trim() !== ''
    ? taskID.trim()
    : undefined;
}

function taskIDFromOutput(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const match = output.match(/(?:task_id:\s*|Task\s+[^\n(]*\()([^\s)]+)/i);
  return match?.[1];
}

function lifecycleStateFromOutput(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const state = output.match(/^state:\s*([\w-]+)/im)?.[1]?.toLowerCase();
  if (!state) return undefined;
  const normalized = state === 'busy' ? 'running' : state;
  const uncertain =
    /state:\s*[^\n]*\(unconfirmed\)/i.test(output) ||
    /^status_uncertain:\s*true$/im.test(output);
  return uncertain ? `${normalized}:uncertain` : normalized;
}

export interface ToolLoopGuardHook {
  'tool.execute.before': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { args?: unknown },
  ) => Promise<void>;
  'tool.execute.after': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { output: unknown; metadata?: unknown },
  ) => Promise<void>;
  observeNewUserMessage(sessionID: string, messageID: string): void;
  resetTurn(sessionID: string): void;
  resetSession(sessionID: string): void;
  resetForTests(): void;
}

export function createToolLoopGuardHook(): ToolLoopGuardHook {
  const sessions = new Map<string, SessionState>();
  /** Per-call state so `after` can re-check without re-deriving args. */
  const callKeys = new Map<string, CallState>();
  /** Polling state is shared by task_status/task_result for each task. */
  const taskSupervision = new Map<string, Map<string, TaskSupervisionState>>();
  /** Last durable user-message identity observed for each session. */
  const userMessageIdentities = new Map<string, string>();

  function resetTaskSupervision(sessionID: string): void {
    taskSupervision.delete(sessionID);
  }

  /** Prune the session map to MAX_TRACKED_SESSIONS (FIFO by insertion). */
  function keepSessionsBounded(): void {
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const tool = input.tool.toLowerCase();
      if (LOOP_GUARD_EXEMPT[tool]) {
        resetTaskSupervision(sessionID);
        return;
      }

      const key = fingerprint(tool, output.args);
      if (TASK_SUPERVISION_TOOLS.has(tool)) {
        if (input.callID) {
          callKeys.set(input.callID, {
            sessionID,
            key,
            taskID: taskIDFromArgs(output.args),
          });
        }
        return;
      }

      // A non-polling tool call is a meaningful action. It starts a new
      // supervision observation, while alternating polling tools do not.
      resetTaskSupervision(sessionID);
      const existing = sessions.get(sessionID);

      // Refuse only on a CONFIRMED identical run: the previous BLOCK_AT
      // calls all had identical args AND identical results. The current
      // call's result is not yet known, but the run is already degenerate.
      if (
        existing &&
        existing.last === key &&
        existing.runs >= LOOP_GUARD_BLOCK_AT &&
        LOOP_GUARD_BLOCK_TOOLS[tool]
      ) {
        log('[tool-loop-guard] blocked repeated tool call', {
          sessionID,
          tool,
          runs: existing.runs,
        });
        throw new Error(
          `Refusing to execute "${tool}": this exact call (same tool, same arguments) has returned identical results ${existing.runs} times in a row and constitutes an infinite loop. Stop repeating it. Reassess your goal, make a different call, or produce your final answer.`,
        );
      }

      if (input.callID) callKeys.set(input.callID, { sessionID, key });
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const tool = input.tool.toLowerCase();
      if (LOOP_GUARD_EXEMPT[tool]) return;

      const call = input.callID ? callKeys.get(input.callID) : undefined;
      if (input.callID) callKeys.delete(input.callID);
      // An after hook without a matching before hook is stale. In particular,
      // do not let a late after hook recreate state after session deletion.
      if (!input.callID || !call) return;
      if (TASK_SUPERVISION_TOOLS.has(tool)) {
        const taskID = taskIDFromOutput(output.output) ?? call?.taskID;
        const lifecycleState = lifecycleStateFromOutput(output.output);
        if (!taskID || !lifecycleState) return;

        let states = taskSupervision.get(sessionID);
        if (!states) {
          states = new Map();
          taskSupervision.set(sessionID, states);
        }
        const previous = states.get(taskID);
        const state: TaskSupervisionState = {
          lifecycleState,
          runs:
            previous?.lifecycleState === lifecycleState ? previous.runs + 1 : 1,
        };
        states.set(taskID, state);
        if (
          state.runs >= LOOP_GUARD_WARN_AT &&
          typeof output.output === 'string' &&
          !output.output.includes(LOOP_GUARD_MARKER)
        ) {
          log('[tool-loop-guard] warned repeated task supervision', {
            sessionID,
            tool,
            taskID,
            lifecycleState,
            runs: state.runs,
          });
          output.output += `\n${LOOP_GUARD_WARNING}`;
        }
        return;
      }
      const key = call?.key;
      const outputHash = fingerprint(tool, output.output);

      const existing = sessions.get(sessionID);
      let state: SessionState;
      if (existing && key !== undefined && key === existing.last) {
        // Identical args. Advance the run only when the result is also
        // identical; a changed result is progress and restarts the run.
        state = {
          last: key,
          runs: outputHash === existing.lastOutput ? existing.runs + 1 : 1,
          lastOutput: outputHash,
        };
      } else {
        // Different args or untracked call: start a fresh run.
        state = {
          last: key ?? `${tool}:<untracked>`,
          runs: 1,
          lastOutput: outputHash,
        };
      }
      sessions.set(sessionID, state);
      keepSessionsBounded();

      if (state.runs < LOOP_GUARD_WARN_AT) return;
      if (typeof output.output !== 'string') return;
      if (output.output.includes(LOOP_GUARD_MARKER)) return;
      log('[tool-loop-guard] warned repeated tool call', {
        sessionID,
        tool,
        runs: state.runs,
      });
      output.output += `\n${LOOP_GUARD_WARNING}`;
    },

    /** Record a new durable user message, once per message identity. */
    observeNewUserMessage(sessionID: string, messageID: string): void {
      if (userMessageIdentities.get(sessionID) === messageID) return;
      userMessageIdentities.set(sessionID, messageID);
      resetTaskSupervision(sessionID);
    },

    /** Clear task supervision state at a completed parent turn. */
    resetTurn(sessionID: string): void {
      resetTaskSupervision(sessionID);
    },

    /** Clear all state for a finished/deleted session. */
    resetSession(sessionID: string): void {
      sessions.delete(sessionID);
      resetTaskSupervision(sessionID);
      userMessageIdentities.delete(sessionID);
      for (const [callID, call] of callKeys) {
        if (call.sessionID === sessionID) callKeys.delete(callID);
      }
    },

    /** Test seam: wipe state between cases. */
    resetForTests(): void {
      sessions.clear();
      callKeys.clear();
      taskSupervision.clear();
      userMessageIdentities.clear();
    },
  };
}
