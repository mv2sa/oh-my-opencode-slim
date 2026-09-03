import type { Plugin } from '@opencode-ai/plugin';
import type { OutcomeController } from '../../outcome/controller';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import { isRecord } from '../../utils/guards';
import {
  createInternalAgentTextPart,
  INTERNAL_INITIATOR_METADATA_KEY,
  isInternalInitiatorPart,
} from '../../utils/internal-initiator';
import { parseTaskIdFromTaskOutput } from '../../utils/task';
import {
  appendTrailingVolatileMessage,
  stripTaggedContent,
} from '../cache-safe-injection';
import {
  isMessageWithParts,
  type MessageInfo,
  type MessageWithParts,
} from '../types';

export const OUTCOME_CONTROLLER_METADATA_KEY =
  'oh-my-opencode-slim:outcome-controller';

export const OUTCOME_CONTROLLER_WAKE_TEXT =
  'Action required on outcome protocol. Check outcome_control status or pending checkpoint instructions.';

function hasInternalMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  return (
    metadata[INTERNAL_INITIATOR_METADATA_KEY] === true ||
    metadata.compaction_continue === true ||
    metadata[OUTCOME_CONTROLLER_METADATA_KEY] === true ||
    metadata['oh-my-opencode-slim.backgroundJobBoard'] === true
  );
}

export function isInternalOrSyntheticPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (part.synthetic === true) return true;
  if (isInternalInitiatorPart(part)) return true;
  if (hasInternalMetadata(part.metadata)) return true;
  if (hasInternalMetadata(part.providerMetadata)) return true;
  return false;
}

const EXTERNAL_HANDOFF_ERROR =
  "Managed orchestrators cannot directly restart the current OpenCode process. Call outcome_control(action='external_handoff', handoffKind='restart_current_opencode', ...) and give the user restart instructions instead.";

function isCurrentPidTermination(command: string, currentPid: number): boolean {
  return new RegExp(
    `^\\s*(?:/[^\\s;]+/)?kill(?:\\s+-[A-Za-z0-9]+)*\\s+${currentPid}\\s*;?\\s*$`,
  ).test(command);
}

function isExplicitOpenCodeRestart(command: string): boolean {
  const trimmed = command.trim().replace(/;$/, '').trim();
  const words = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''));
  if (words.length === 0) return false;

  const executable = words[0].split('/').at(-1)?.toLowerCase();
  const lower = words.map((word) => word.toLowerCase());

  if (executable === 'pkill' || executable === 'killall') {
    return (
      lower.length >= 2 &&
      lower
        .slice(1)
        .every((word) => word.startsWith('-') || word === 'opencode') &&
      lower.at(-1) === 'opencode'
    );
  }

  if (executable === 'systemctl') {
    let index = 1;
    if (lower[index] === '--user') index += 1;
    return (
      lower[index] === 'restart' &&
      /^opencode(?:\.service)?$/.test(lower[index + 1] ?? '')
    );
  }

  return (
    executable === 'service' &&
    /^opencode(?:\.service)?$/.test(lower[1] ?? '') &&
    lower[2] === 'restart'
  );
}

/**
 * Recognizes only literal, direct restart forms. Shell aliases, scripts,
 * substitutions, pipelines, and obfuscated equivalents are intentionally out
 * of scope.
 */
export function isRecognizableDirectOpenCodeRestart(
  command: string,
  currentPid = process.pid,
): boolean {
  return (
    isCurrentPidTermination(command, currentPid) ||
    isExplicitOpenCodeRestart(command)
  );
}

interface PendingToolCall {
  callId: string;
  rootSessionId: string;
  toolName: string;
  argumentDigest: string;
  subagentType?: string;
}

export interface OutcomeControllerHookOptions {
  controller: OutcomeController;
  shouldManageSession: (sessionID: string) => boolean;
  backgroundJobBoard?: BackgroundJobStore;
  resolveAgentName?: (agent: string) => string;
}

export interface OutcomeManagerDispatchReservation {
  rootSessionId: string;
  callId: string;
}

export function createOutcomeControllerHook(
  ctx: Parameters<Plugin>[0] | unknown,
  options: OutcomeControllerHookOptions,
) {
  const { controller, shouldManageSession, backgroundJobBoard } = options;
  const resolveAgentName =
    options.resolveAgentName ?? ((agent: string) => agent);

  const pendingToolCalls = new Map<string, PendingToolCall>();
  const idleWokenSessions = new Set<string>();

  const failReservedManagerDispatch = (
    reservation: OutcomeManagerDispatchReservation,
    reason: string,
  ): void => {
    if (
      !controller.hasDispatchCall(reservation.rootSessionId, reservation.callId)
    ) {
      return;
    }
    const failed = controller.failManagerDispatch(
      reservation.rootSessionId,
      reservation.callId,
      reason,
    );
    if (!failed.success && failed.code !== 'manager_binding_invalid') {
      throw new Error(
        `Failed to retire Outcome Manager dispatch: ${failed.error}`,
      );
    }
  };

  return {
    reserveManagerDispatch: (
      input: {
        tool: string;
        sessionID?: string;
        callID?: string;
      },
      output: { args?: Record<string, unknown> },
    ): OutcomeManagerDispatchReservation | undefined => {
      const args = output.args ?? {};
      const subagentType =
        typeof args.subagent_type === 'string' ? args.subagent_type : undefined;
      if (
        input.tool !== 'task' ||
        !subagentType ||
        resolveAgentName(subagentType) !== 'outcome-manager'
      ) {
        return undefined;
      }
      if (!input.callID?.trim()) {
        throw new Error(
          'Outcome Manager task dispatch requires a non-empty callID',
        );
      }
      if (!input.sessionID || !shouldManageSession(input.sessionID)) {
        throw new Error(
          'Outcome Manager can only be dispatched from a known managed root orchestrator session',
        );
      }
      const promptText = typeof args.prompt === 'string' ? args.prompt : '';
      const marked = controller.validateAndMarkDispatching(
        input.sessionID,
        input.callID,
        promptText,
      );
      if (!marked.success) throw new Error(marked.error);
      return { rootSessionId: input.sessionID, callId: input.callID };
    },

    failReservedManagerDispatch,

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: unknown[] },
    ): Promise<void> => {
      const messages = output.messages;
      stripTaggedContent(messages, OUTCOME_CONTROLLER_METADATA_KEY);

      // Find root session ID from messages
      let sessionID: string | undefined;
      for (const msg of messages) {
        if (isMessageWithParts(msg) && msg.info.sessionID) {
          sessionID = msg.info.sessionID;
          break;
        }
      }

      if (!sessionID || !shouldManageSession(sessionID)) {
        return;
      }

      const nudge = controller.getPendingNudge(sessionID);
      if (!nudge) {
        return;
      }

      // Find last user turn
      let lastUserMsg: MessageWithParts | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (isMessageWithParts(m) && m.info.role === 'user') {
          lastUserMsg = m;
          break;
        }
      }

      if (!lastUserMsg) return;

      const info: MessageInfo = {
        role: 'user',
        agent: 'orchestrator',
        sessionID,
        id: `msg_outcome_nudge_${sessionID}`,
      };

      const text =
        nudge.kind === 'dispatch' ? nudge.instruction : nudge.message;

      appendTrailingVolatileMessage(messages, info, {
        text,
        metadataKey: OUTCOME_CONTROLLER_METADATA_KEY,
      });
    },

    'tool.execute.before': async (
      input: {
        tool: string;
        sessionID?: string;
        callID?: string;
        agent?: string;
      },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      const callID = input.callID;
      const toolName = input.tool || '';
      const args = output?.args ?? {};

      if (toolName === 'outcome_control') {
        return;
      }

      if (
        toolName.toLowerCase() === 'bash' &&
        sessionID &&
        shouldManageSession(sessionID) &&
        typeof args.command === 'string' &&
        isRecognizableDirectOpenCodeRestart(args.command)
      ) {
        throw new Error(EXTERNAL_HANDOFF_ERROR);
      }

      const subagentType =
        typeof args.subagent_type === 'string' ? args.subagent_type : undefined;
      const resolvedAgent = subagentType
        ? resolveAgentName(subagentType)
        : undefined;

      if (toolName === 'task' && resolvedAgent === 'outcome-manager') {
        if (!callID || typeof callID !== 'string' || callID.trim() === '') {
          throw new Error(
            'Outcome Manager task dispatch requires a non-empty callID',
          );
        }
        if (!sessionID || !shouldManageSession(sessionID)) {
          throw new Error(
            'Outcome Manager can only be dispatched from a known managed root orchestrator session',
          );
        }

        if (!controller.hasDispatchCall(sessionID, callID)) {
          const promptText = typeof args.prompt === 'string' ? args.prompt : '';
          const markRes = controller.validateAndMarkDispatching(
            sessionID,
            callID,
            promptText,
          );
          if (!markRes.success) {
            throw new Error(markRes.error);
          }
        }
        // The durable Manager claim is the authority for this protocol lane.
        // Do not also create a generic running operation: task-session
        // preflight still runs after reservation and may reject before native
        // launch, which would otherwise leave an operation that only a process
        // restart could interrupt.
        return;
      }

      if (
        sessionID &&
        callID &&
        shouldManageSession(sessionID) &&
        controller.isManaged(sessionID)
      ) {
        pendingToolCalls.set(callID, {
          callId: callID,
          rootSessionId: sessionID,
          toolName,
          argumentDigest: '',
          subagentType,
        });

        const observed = controller.observeToolBefore(
          sessionID,
          callID,
          toolName,
          args,
        );
        if (!observed.success) {
          if (toolName === 'task' && resolvedAgent === 'outcome-manager') {
            controller.failManagerDispatch(
              sessionID,
              callID,
              `Failed to persist Manager tool start: ${observed.error}`,
            );
          }
          throw new Error(
            `Failed to persist managed tool start: ${observed.error}`,
          );
        }
      }
    },

    'tool.execute.after': async (
      input: {
        tool: string;
        sessionID?: string;
        callID?: string;
        agent?: string;
      },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      const callID = input.callID;
      const toolName = input.tool || '';
      const rawOutput = output?.output;

      if (toolName === 'outcome_control' || !callID) {
        return;
      }

      const pending = pendingToolCalls.get(callID);
      pendingToolCalls.delete(callID);
      const durableRecord = sessionID
        ? controller.readRecord(sessionID)
        : undefined;
      const durableManagerCall =
        durableRecord?.success === true &&
        durableRecord.data.checkpoint?.dispatchCallId === callID &&
        (durableRecord.data.checkpoint.state === 'dispatching' ||
          durableRecord.data.checkpoint.state === 'running');
      const isManagerDispatch =
        durableManagerCall ||
        (pending?.toolName === 'task' &&
          pending.subagentType !== undefined &&
          resolveAgentName(pending.subagentType) === 'outcome-manager');

      if (
        sessionID &&
        shouldManageSession(sessionID) &&
        controller.isManaged(sessionID) &&
        !isManagerDispatch
      ) {
        const observed = controller.observeToolAfter(
          sessionID,
          callID,
          toolName,
          rawOutput,
        );
        if (!observed.success) {
          throw new Error(
            `Failed to persist managed tool completion: ${observed.error}`,
          );
        }
      }

      if (isManagerDispatch && sessionID) {
        const outputString =
          typeof rawOutput === 'string'
            ? rawOutput
            : rawOutput && typeof rawOutput === 'object'
              ? JSON.stringify(rawOutput)
              : '';

        const taskID = parseTaskIdFromTaskOutput(outputString);
        if (taskID) {
          const bound = controller.bindManagerTask(sessionID, callID, taskID);
          if (!bound.success) {
            const alreadyBound = controller.readRecord(sessionID);
            if (
              alreadyBound.success &&
              alreadyBound.data.checkpoint?.state === 'running' &&
              alreadyBound.data.checkpoint.dispatchCallId === callID &&
              alreadyBound.data.checkpoint.managerTaskId === taskID
            ) {
              return;
            }
            throw new Error(
              `Failed to bind Outcome Manager task: ${bound.error}`,
            );
          }
        } else {
          const failed = controller.failManagerDispatch(
            sessionID,
            callID,
            'Native task output did not contain a Manager task ID',
          );
          if (!failed.success && failed.code !== 'manager_binding_invalid') {
            throw new Error(
              `Failed to persist invalid Manager dispatch: ${failed.error}`,
            );
          }
        }
      }
    },

    'chat.message': async (
      input: {
        sessionID: string;
        agent?: string;
        parts?: unknown[];
        messageID?: string;
      },
      output?: { message?: { id?: string }; parts?: unknown[] },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID || !shouldManageSession(sessionID)) return;

      const messageID = input.messageID?.trim()
        ? input.messageID.trim()
        : output?.message?.id?.trim()
          ? output.message.id.trim()
          : undefined;
      if (!messageID) return;

      // An explicitly supplied output.parts array is authoritative even when
      // empty. Never fall back to dirtier input parts after a host transform
      // removed content.
      const rawParts = Array.isArray(output?.parts)
        ? output.parts
        : Array.isArray(input.parts)
          ? input.parts
          : [];

      if (rawParts.length === 0) return;

      // Reject entire message if any authoritative part is synthetic, internal initiator, or compaction continuation
      for (const part of rawParts) {
        if (isInternalOrSyntheticPart(part)) {
          return;
        }
      }

      const textParts: string[] = [];
      for (const part of rawParts) {
        if (
          isRecord(part) &&
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.trim().length > 0
        ) {
          textParts.push(part.text);
        }
      }

      if (textParts.length === 0) return;

      const fullText = textParts.join('\n');

      idleWokenSessions.delete(sessionID);
      const observed = controller.observeExternalUserTurn(
        sessionID,
        messageID,
        fullText,
      );
      if (!observed.success) {
        // The first external turn precedes outcome_control(begin), so no durable
        // outcome exists yet. Preserve unmanaged behavior for that boundary;
        // every failure after a record exists remains fail closed.
        if (observed.code === 'missing') return;
        throw new Error(
          `Failed to persist external user message: ${observed.error}`,
        );
      }
    },

    event: async (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string };
          sessionID?: string;
          status?: { type?: string };
        };
      };
    }): Promise<void> => {
      const event = input.event;
      if (event.type === 'server.instance.disposed') {
        pendingToolCalls.clear();
        idleWokenSessions.clear();
        return;
      }

      const eventSessionID =
        event.properties?.info?.id || event.properties?.sessionID;
      const statusType = event.properties?.status?.type;

      if (
        eventSessionID &&
        (event.type === 'session.idle' ||
          (event.type === 'session.status' && statusType === 'idle'))
      ) {
        if (!shouldManageSession(eventSessionID)) return;

        const readResult = controller.readRecord(eventSessionID);
        if (!readResult.success) {
          if (readResult.code === 'missing') return;
          throw new Error(
            `Failed to read managed outcome during idle handling: ${readResult.error.message}`,
          );
        }
        const record = readResult.data;
        if (record.phase === 'accepted') return;

        // Valid waits suppress idle continuation
        if (controller.validateManagedWait(eventSessionID).allowed) {
          return;
        }

        // Active children suppress idle continuation
        if (backgroundJobBoard?.hasRunning?.(eventSessionID)) {
          return;
        }

        const reconcileRes =
          controller.store.reconcileIdleOperations(eventSessionID);
        if (!reconcileRes.success) {
          throw new Error(
            `Failed to reconcile idle operations: ${reconcileRes.error.message}`,
          );
        }
        const updatedRecord = reconcileRes.data;

        const hasTerminalUnreconciledChildren =
          backgroundJobBoard?.hasTerminalUnreconciled?.(eventSessionID) ??
          false;

        // Send one-flight promptAsync if actionable
        if (
          (updatedRecord.phase === 'action_required' ||
            updatedRecord.checkpoint?.state === 'claimed' ||
            updatedRecord.checkpoint?.state === 'review_uncertain' ||
            hasTerminalUnreconciledChildren) &&
          !idleWokenSessions.has(eventSessionID)
        ) {
          const client = (
            ctx as {
              client?: {
                session?: { promptAsync?: (req: unknown) => Promise<unknown> };
              };
            }
          )?.client;
          if (client?.session?.promptAsync) {
            idleWokenSessions.add(eventSessionID);
            try {
              await client.session.promptAsync({
                path: { id: eventSessionID },
                query: {
                  directory: (ctx as { directory?: string }).directory ?? '',
                },
                body: {
                  agent: 'orchestrator',
                  parts: [
                    createInternalAgentTextPart(OUTCOME_CONTROLLER_WAKE_TEXT),
                  ],
                },
                throwOnError: true,
              });
            } catch {
              idleWokenSessions.delete(eventSessionID);
            }
          }
        }
      } else if (
        eventSessionID &&
        event.type === 'session.status' &&
        (statusType === 'busy' || statusType === 'retry')
      ) {
        idleWokenSessions.delete(eventSessionID);
      }
    },
  };
}
