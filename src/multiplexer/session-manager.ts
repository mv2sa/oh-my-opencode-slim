import type { PluginInput } from '@opencode-ai/plugin';
import { POLL_INTERVAL_BACKGROUND_MS } from '../config';
import type { MultiplexerConfig } from '../config/schema';
import {
  getMultiplexer,
  isServerRunning,
  type Multiplexer,
  type SessionReadinessOptions,
  waitForSessionReady,
} from '../multiplexer';
import type { BackgroundJobState } from '../utils/background-job-board';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { log } from '../utils/logger';
import {
  CmuxSessionLifecycle,
  type CmuxSessionLifecycleOptions,
} from './cmux/session-lifecycle';
import { CmuxSessionStore } from './cmux/session-state';

type BackgroundJobReader = Pick<
  BackgroundJobStore,
  'getState' | 'deferIfRunning' | 'clearDeferredClose'
>;

interface TrackedSession {
  sessionId: string;
  paneId: string;
  parentId: string;
  title: string;
  directory: string;
  ownerInstanceId: string;
  closeState?: PaneCloseState;
}

interface PaneCloseState {
  reason: CloseReason;
  phase: 'closing' | 'retrying' | 'exhausted';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface KnownSession {
  parentId: string;
  title: string;
  directory: string;
}

interface SharedSessionState {
  sessions: Map<string, TrackedSession>;
  knownSessions: Map<string, KnownSession>;
  spawningSessions: Set<string>;
  closingSessions: Map<string, Promise<void>>;
  permanentlyClosedSessions: Set<string>;
}

interface SessionEvent {
  type: string;
  properties?: {
    info?: {
      id?: string;
      parentID?: string;
      title?: string;
      directory?: string;
      sessionID?: string;
    };
    part?: { sessionID?: string };
    sessionID?: string;
    status?: { type: string };
  };
}

type CloseReason = 'idle' | 'deleted';

const SHARED_STATE_KEY = Symbol.for(
  'oh-my-opencode-slim.multiplexer-session-manager.state',
);

function getSharedState(): SharedSessionState {
  const globalWithState = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedSessionState;
  };

  let state = globalWithState[SHARED_STATE_KEY];
  if (!state) {
    state = {
      sessions: new Map(),
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    };
    globalWithState[SHARED_STATE_KEY] = state;
  }
  // Migrate state created by older plugin instances in this process.
  state.permanentlyClosedSessions ??= new Set();
  return state;
}

export function resetMultiplexerSessionManagerState(): void {
  const state = getSharedState();
  state.sessions.clear();
  state.knownSessions.clear();
  state.spawningSessions.clear();
  state.closingSessions.clear();
  state.permanentlyClosedSessions.clear();
  new CmuxSessionStore().resetForTests();
}

export type MultiplexerSessionManagerOptions = CmuxSessionLifecycleOptions &
  SessionReadinessOptions;

function validServerUrl(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  try {
    const url = new URL(value.toString());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function clientBaseUrl(client: unknown): string | null {
  try {
    if (!client || typeof client !== 'object' || !('_client' in client))
      return null;
    const internal = client._client;
    if (!internal || typeof internal !== 'object' || !('getConfig' in internal))
      return null;
    const getConfig = internal.getConfig;
    if (typeof getConfig !== 'function') return null;
    const config: unknown = getConfig.call(internal);
    if (!config || typeof config !== 'object' || !('baseUrl' in config))
      return null;
    return validServerUrl(config.baseUrl);
  } catch {
    return null;
  }
}

function createServerUrlResolver(ctx: PluginInput): () => string | null {
  return () => {
    try {
      const serverUrl = validServerUrl(ctx.serverUrl);
      if (serverUrl) return serverUrl;
    } catch {}
    try {
      return clientBaseUrl(ctx.client);
    } catch {
      return null;
    }
  };
}

/**
 * Tracks child sessions and spawns/closes multiplexer panes for them.
 *
 * Uses session.status events for completion detection instead of polling,
 * with polling kept as a fallback for reliability.
 */
export class MultiplexerSessionManager {
  private instanceId = Math.random().toString(36).slice(2, 8);
  private readonly resolveServerUrl: () => string | null;
  private directory: string;
  private multiplexer: Multiplexer | null = null;
  private sessions: SharedSessionState['sessions'];
  private knownSessions: SharedSessionState['knownSessions'];
  private spawningSessions: SharedSessionState['spawningSessions'];
  private closingSessions: SharedSessionState['closingSessions'];
  private permanentlyClosedSessions: SharedSessionState['permanentlyClosedSessions'];
  private pollInterval?: ReturnType<typeof setInterval>;
  private enabled = false;
  private cmuxLifecycle?: CmuxSessionLifecycle;
  private readonly readiness: SessionReadinessOptions;
  private readonly now: () => number;
  private readonly closeRetryMs: number;
  private readonly closeRetryMaxAttempts: number;
  private readonly shutdownTimeoutMs: number;
  private readinessAbort?: AbortController;
  private cleanupInProgress = false;
  /**
   * Sessions that signaled `busy` while a spawn/readiness pass was in flight
   * (the busy handler defers to the pending pass). Consumed after the pass:
   * if the pass failed to attach a pane, the session is retried immediately
   * instead of being silently orphaned.
   */
  private readonly busyDuringSpawn = new Set<string>();

  constructor(
    ctx: PluginInput,
    config: MultiplexerConfig,
    private readonly backgroundJobBoard?: BackgroundJobReader,
    options: MultiplexerSessionManagerOptions = {},
  ) {
    const sharedState = getSharedState();
    this.sessions = sharedState.sessions;
    this.knownSessions = sharedState.knownSessions;
    this.spawningSessions = sharedState.spawningSessions;
    this.closingSessions = sharedState.closingSessions;
    this.permanentlyClosedSessions = sharedState.permanentlyClosedSessions;
    this.readiness = options;
    this.now = options.now ?? Date.now;
    this.closeRetryMs = Number.isFinite(options.closeRetryMs)
      ? Math.max(0, options.closeRetryMs ?? 1_000)
      : 1_000;
    this.closeRetryMaxAttempts = Number.isFinite(options.closeRetryMaxAttempts)
      ? Math.max(1, Math.floor(options.closeRetryMaxAttempts ?? 4))
      : 4;
    this.shutdownTimeoutMs = Number.isFinite(options.shutdownTimeoutMs)
      ? Math.max(0, options.shutdownTimeoutMs ?? 5_000)
      : 5_000;

    this.directory = ctx.directory;
    this.resolveServerUrl = createServerUrlResolver(ctx);

    this.multiplexer = getMultiplexer(config);
    this.enabled =
      config.type !== 'none' &&
      this.multiplexer !== null &&
      this.multiplexer.isInsideSession();
    if (this.enabled && this.multiplexer?.type === 'cmux') {
      // cmux exclusion contract: the cmux adapter is NOT subject to the
      // generic readiness gate. All events are delegated to
      // CmuxSessionLifecycle, which has its own spawn machinery (server
      // health check plus deferred spawn retry with a TTL) and never calls
      // waitForSessionReady.
      this.cmuxLifecycle = new CmuxSessionLifecycle(
        this.instanceId,
        this.multiplexer,
        this.resolveServerUrl,
        this.directory,
        this.backgroundJobBoard,
        {
          ...options,
          permanentlyClosedSessions: this.permanentlyClosedSessions,
        },
      );
    }

    log('[multiplexer-session-manager] initialized', {
      instanceId: this.instanceId,
      enabled: this.enabled,
      type: config.type,
      serverUrl: 'dynamic',
      trackedSessions: this.sessions.size,
      knownSessions: this.knownSessions.size,
    });
  }

  /** Fresh options for a readiness wait; the manager owns the abort signal. */
  private readinessOptions(): SessionReadinessOptions {
    const controller = new AbortController();
    this.readinessAbort = controller;
    return { ...this.readiness, signal: controller.signal };
  }

  /** Abort an in-flight readiness wait during cleanup or disposal. */
  private abortInFlightReadiness(): void {
    this.readinessAbort?.abort();
    this.readinessAbort = undefined;
  }

  async onSessionCreated(event: SessionEvent): Promise<void> {
    if (this.cmuxLifecycle) return this.cmuxLifecycle.onSessionCreated(event);
    if (!this.enabled || !this.multiplexer) return;
    if (event.type !== 'session.created') return;

    const info = event.properties?.info;
    if (!info?.id || !info?.parentID) return;

    const sessionId = info.id;
    const parentId = info.parentID;
    const title = info.title ?? 'Subagent';
    const directory = info.directory ?? this.directory;

    if (this.permanentlyClosedSessions.has(sessionId)) {
      log('[multiplexer-session-manager] ignoring permanently closed session', {
        instanceId: this.instanceId,
        sessionId,
      });
      return;
    }

    if (this.isTrackedOrSpawning(sessionId)) {
      log('[multiplexer-session-manager] session already tracked or spawning', {
        instanceId: this.instanceId,
        sessionId,
      });
      return;
    }

    const closing = this.closingSessions.get(sessionId);
    if (closing) await closing;

    if (this.permanentlyClosedSessions.has(sessionId)) return;
    if (this.isTrackedOrSpawning(sessionId)) return;

    this.knownSessions.set(sessionId, {
      parentId,
      title,
      directory,
    });

    this.spawningSessions.add(sessionId);

    try {
      const serverUrl = this.resolveServerUrl();
      if (!serverUrl) {
        log(
          '[multiplexer-session-manager] no valid server URL, skipping spawn',
          { instanceId: this.instanceId, sessionId },
        );
        return;
      }
      const serverRunning = await isServerRunning(serverUrl);
      if (!serverRunning) {
        log('[multiplexer-session-manager] server not running, skipping', {
          instanceId: this.instanceId,
          serverUrl,
        });
        return;
      }

      // Attach only after the child session is visible to the server.
      const readinessOptions = this.readinessOptions();
      const sessionReady = await waitForSessionReady(serverUrl, sessionId, {
        ...readinessOptions,
        directory,
      });
      if (!sessionReady || readinessOptions.signal?.aborted) {
        log(
          '[multiplexer-session-manager] child session not ready, skipping spawn',
          { instanceId: this.instanceId, sessionId, parentId },
        );
        return;
      }

      if (
        this.permanentlyClosedSessions.has(sessionId) ||
        this.closingSessions.has(sessionId) ||
        this.sessions.has(sessionId)
      )
        return;

      const paneResult = await this.multiplexer
        .spawnPane(
          sessionId,
          title,
          serverUrl,
          directory,
          this.multiplexer.type === 'tmux'
            ? { parentSessionId: parentId }
            : undefined,
        )
        .catch((err) => {
          log('[multiplexer-session-manager] failed to spawn pane', {
            instanceId: this.instanceId,
            error: String(err),
          });
          return { success: false, paneId: undefined };
        });

      if (!paneResult.success || !paneResult.paneId) return;

      if (
        !this.knownSessions.has(sessionId) ||
        this.closingSessions.has(sessionId) ||
        this.permanentlyClosedSessions.has(sessionId)
      ) {
        await this.trackAndCloseStalePane(
          sessionId,
          paneResult.paneId,
          parentId,
          title,
          directory,
        );
        return;
      }

      this.sessions.set(sessionId, {
        sessionId,
        paneId: paneResult.paneId,
        parentId,
        title,
        directory,
        ownerInstanceId: this.instanceId,
      });

      log('[multiplexer-session-manager] pane spawned', {
        instanceId: this.instanceId,
        sessionId,
        paneId: paneResult.paneId,
      });

      this.startPolling();
    } finally {
      this.spawningSessions.delete(sessionId);
      if (
        this.busyDuringSpawn.delete(sessionId) &&
        !this.sessions.has(sessionId)
      ) {
        await this.respawnIfKnown(sessionId);
      }
    }
  }

  async onSessionStatus(event: SessionEvent): Promise<void> {
    if (this.cmuxLifecycle) return this.cmuxLifecycle.onSessionStatus(event);
    if (!this.enabled) return;

    const sessionId = this.getSessionId(event);
    if (!sessionId) return;

    const statusType =
      event.type === 'session.idle'
        ? 'idle'
        : event.type === 'session.status'
          ? event.properties?.status?.type
          : undefined;
    if (!statusType) return;

    if (statusType === 'idle') {
      log('[multiplexer-session-manager] session idle event received', {
        instanceId: this.instanceId,
        sessionId,
        tracked: this.sessions.has(sessionId),
        known: this.knownSessions.has(sessionId),
        ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
        backgroundJobState: this.backgroundJobState(sessionId),
      });
      await this.closeSession(sessionId, 'idle');
      return;
    }

    if (statusType !== 'busy') {
      this.backgroundJobBoard?.clearDeferredClose(sessionId);
      this.cancelFailedIdleClose(sessionId);
      return;
    }

    log('[multiplexer-session-manager] session busy event received', {
      instanceId: this.instanceId,
      sessionId,
      tracked: this.sessions.has(sessionId),
      known: this.knownSessions.has(sessionId),
      ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
      backgroundJobState: this.backgroundJobState(sessionId),
    });
    await this.respawnIfKnown(sessionId);
  }

  async onSessionDeleted(event: SessionEvent): Promise<void> {
    if (this.cmuxLifecycle) return this.cmuxLifecycle.onSessionDeleted(event);
    if (!this.enabled) return;
    if (event.type !== 'session.deleted') return;

    const sessionId = this.getSessionId(event);
    if (!sessionId) return;

    log('[multiplexer-session-manager] session deleted, closing pane', {
      instanceId: this.instanceId,
      sessionId,
      tracked: this.sessions.has(sessionId),
      known: this.knownSessions.has(sessionId),
      ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
      backgroundJobState: this.backgroundJobState(sessionId),
    });

    await this.closeSession(sessionId, 'deleted');
  }

  private startPolling(): void {
    if (this.pollInterval || this.cleanupInProgress) return;
    this.pollInterval = setInterval(
      () => this.pollSessions(),
      POLL_INTERVAL_BACKGROUND_MS,
    );
    log('[multiplexer-session-manager] polling started', {
      instanceId: this.instanceId,
    });
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      log('[multiplexer-session-manager] polling stopped', {
        instanceId: this.instanceId,
      });
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.cmuxLifecycle) return this.cmuxLifecycle.pollOnce();

    const ownedSessions = () =>
      [...this.sessions.entries()].filter(([, tracked]) =>
        this.isPollableSession(tracked),
      );
    if (ownedSessions().length === 0) {
      this.stopPolling();
      return;
    }

    let allStatuses: Record<string, { type: string }> | undefined;
    try {
      allStatuses = await this.fetchSessionStatuses();
    } catch (err) {
      log('[multiplexer-session-manager] poll error', { error: String(err) });
    }

    await this.retryDueCloses(allStatuses);
    if (ownedSessions().length === 0) {
      this.stopPolling();
      return;
    }
    if (!allStatuses) return;

    const sessionsToClose: string[] = [];
    for (const [sessionId, tracked] of ownedSessions()) {
      if (tracked.closeState) continue;

      const status = allStatuses[sessionId];
      if (!status) {
        // An absent map entry is only diagnostic; it is not deletion evidence.
        log('[multiplexer-session-manager] status absent; retaining pane', {
          instanceId: this.instanceId,
          ownerInstanceId: tracked.ownerInstanceId,
          sessionId,
          paneId: tracked.paneId,
          backgroundJobState: this.backgroundJobState(sessionId),
        });
        continue;
      }

      if (status.type !== 'idle') {
        this.backgroundJobBoard?.clearDeferredClose(sessionId);
        continue;
      }

      sessionsToClose.push(sessionId);
    }

    for (const sessionId of sessionsToClose)
      await this.closeSession(sessionId, 'idle');
  }

  private async retryDueCloses(
    allStatuses?: Record<string, { type: string }>,
  ): Promise<void> {
    const now = this.now();
    const retryIds = [...this.sessions.entries()]
      .filter(([sessionId, tracked]) => {
        if (tracked.ownerInstanceId !== this.instanceId) {
          log('[multiplexer-session-manager] skipping non-owner close retry', {
            instanceId: this.instanceId,
            ownerInstanceId: tracked.ownerInstanceId,
            sessionId,
            paneId: tracked.paneId,
          });
          return false;
        }
        const close = tracked.closeState;
        if (close?.phase !== 'retrying') return false;
        if (close.nextAttemptAt > now) return false;
        if (
          close.reason === 'idle' &&
          allStatuses?.[sessionId] &&
          allStatuses[sessionId].type !== 'idle'
        ) {
          tracked.closeState = undefined;
          log(
            '[multiplexer-session-manager] cancelled idle close after busy poll',
            {
              instanceId: this.instanceId,
              sessionId,
              paneId: tracked.paneId,
            },
          );
          return false;
        }
        return true;
      })
      .map(([sessionId]) => sessionId);

    for (const sessionId of retryIds) {
      const reason = this.sessions.get(sessionId)?.closeState?.reason;
      if (reason) await this.closeSession(sessionId, reason, true);
    }
  }

  private async fetchSessionStatuses(): Promise<
    Record<string, { type: string }>
  > {
    const serverUrl = this.resolveServerUrl();
    if (!serverUrl) {
      log('[multiplexer-session-manager] no valid server URL, skipping poll', {
        instanceId: this.instanceId,
      });
      return {};
    }
    const url = new URL('/session/status', serverUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });

    if (!response.ok)
      throw new Error(
        `session status request failed: ${response.status} ${response.statusText}`,
      );

    const body = await response.text();
    if (body.trim() === '')
      throw new Error('session status response was empty');

    try {
      return JSON.parse(body) as Record<string, { type: string }>;
    } catch (err) {
      throw new Error(`session status response was not valid JSON: ${err}`);
    }
  }

  private async trackAndCloseStalePane(
    sessionId: string,
    paneId: string,
    parentId: string,
    title: string,
    directory: string,
  ): Promise<void> {
    const trackingId = `${sessionId}\0stale\0${paneId}`;
    this.sessions.set(trackingId, {
      sessionId: trackingId,
      paneId,
      parentId,
      title,
      directory,
      ownerInstanceId: this.instanceId,
    });
    log('[multiplexer-session-manager] tracking stale spawned pane', {
      instanceId: this.instanceId,
      sessionId,
      trackingId,
      paneId,
    });
    await this.closeSession(trackingId, 'deleted', true);
  }

  private async closeSession(
    sessionId: string,
    reason: CloseReason,
    skipPolicyCheck = false,
  ): Promise<void> {
    if (reason === 'deleted') {
      this.knownSessions.delete(sessionId);
      this.backgroundJobBoard?.clearDeferredClose(sessionId);
    }

    const tracked = this.sessions.get(sessionId);
    if (!tracked || !this.multiplexer) {
      log('[multiplexer-session-manager] close skipped; session not tracked', {
        instanceId: this.instanceId,
        sessionId,
        reason,
        tracked: !!tracked,
        hasMultiplexer: !!this.multiplexer,
      });
      return;
    }

    // A session.deleted event is global deletion evidence and keeps the
    // existing behavior of closing the known pane. Idle/retry work is owner
    // scoped so another manager cannot close a shared record.
    if (reason === 'idle' && tracked.ownerInstanceId !== this.instanceId) {
      log('[multiplexer-session-manager] close skipped; non-owner instance', {
        instanceId: this.instanceId,
        ownerInstanceId: tracked.ownerInstanceId,
        sessionId,
        paneId: tracked.paneId,
        reason,
      });
      return;
    }

    const existingClose = this.closingSessions.get(sessionId);
    if (existingClose) {
      if (reason === 'deleted' && tracked.closeState)
        tracked.closeState.reason = 'deleted';
      return existingClose;
    }

    if (
      reason === 'idle' &&
      !skipPolicyCheck &&
      !this.shouldCloseNow(sessionId)
    ) {
      log(
        '[multiplexer-session-manager] close skipped; background job running',
        {
          instanceId: this.instanceId,
          sessionId,
          paneId: tracked.paneId,
          reason,
          backgroundJobState: this.backgroundJobState(sessionId),
        },
      );
      return;
    }

    const closeState = this.getOrCreateCloseState(tracked, reason);
    if (closeState.phase === 'exhausted') {
      log('[multiplexer-session-manager] close retry budget exhausted', {
        instanceId: this.instanceId,
        sessionId,
        paneId: tracked.paneId,
        reason: closeState.reason,
        attempts: closeState.attempts,
        lastError: closeState.lastError,
      });
      return;
    }
    if (closeState.nextAttemptAt > this.now()) return;

    closeState.phase = 'closing';
    closeState.attempts += 1;
    const paneId = tracked.paneId;
    log('[multiplexer-session-manager] closing session pane', {
      instanceId: this.instanceId,
      sessionId,
      paneId,
      reason: closeState.reason,
      attempt: closeState.attempts,
      backgroundJobState: this.backgroundJobState(sessionId),
      parentId: tracked.parentId,
      title: tracked.title,
    });

    const closePromise = this.performClose(
      sessionId,
      tracked,
      paneId,
      closeState,
      this.multiplexer,
    ).finally(() => {
      if (this.closingSessions.get(sessionId) !== closePromise) return;
      this.closingSessions.delete(sessionId);
      this.updatePolling();
    });
    this.closingSessions.set(sessionId, closePromise);
    await closePromise;
  }

  private async performClose(
    sessionId: string,
    tracked: TrackedSession,
    paneId: string,
    closeState: PaneCloseState,
    multiplexer: Multiplexer,
  ): Promise<void> {
    let closed = false;
    let error: string | undefined;
    try {
      // Await the adapter operation. A later retry cannot reuse this pane ID
      // until this promise has settled.
      closed = await multiplexer.closePane(paneId);
    } catch (err) {
      error = String(err);
    }

    const current = this.sessions.get(sessionId);
    const deletionClose = closeState.reason === 'deleted';
    if (
      !current ||
      current !== tracked ||
      current.paneId !== paneId ||
      (current.ownerInstanceId !== this.instanceId && !deletionClose)
    ) {
      log('[multiplexer-session-manager] ignoring stale pane close result', {
        instanceId: this.instanceId,
        sessionId,
        paneId,
        closed,
        error,
      });
      return;
    }

    if (closed) {
      current.closeState = undefined;
      this.sessions.delete(sessionId);
      log('[multiplexer-session-manager] session pane close confirmed', {
        instanceId: this.instanceId,
        sessionId,
        paneId,
        attempt: closeState.attempts,
      });
      return;
    }

    closeState.lastError = error ?? 'closePane returned false';
    if (closeState.attempts >= this.closeRetryMaxAttempts) {
      closeState.phase = 'exhausted';
      closeState.nextAttemptAt = Number.POSITIVE_INFINITY;
    } else {
      closeState.phase = 'retrying';
      closeState.nextAttemptAt = this.now() + this.closeRetryMs;
    }
    log(
      '[multiplexer-session-manager] failed to close session pane; retained',
      {
        instanceId: this.instanceId,
        sessionId,
        paneId,
        reason: closeState.reason,
        attempt: closeState.attempts,
        phase: closeState.phase,
        nextAttemptAt: closeState.nextAttemptAt,
        error: closeState.lastError,
      },
    );
  }

  private getOrCreateCloseState(
    tracked: TrackedSession,
    reason: CloseReason,
  ): PaneCloseState {
    const existing = tracked.closeState;
    if (!existing) {
      const state: PaneCloseState = {
        reason,
        phase: 'retrying',
        attempts: 0,
        nextAttemptAt: this.now(),
      };
      tracked.closeState = state;
      return state;
    }

    if (reason === 'deleted' && existing.reason !== 'deleted') {
      existing.reason = 'deleted';
      if (existing.phase !== 'closing') {
        existing.phase = 'retrying';
        existing.attempts = 0;
        existing.nextAttemptAt = this.now();
        existing.lastError = undefined;
      }
    }
    return existing;
  }

  private cancelFailedIdleClose(sessionId: string): void {
    const tracked = this.sessions.get(sessionId);
    if (
      tracked?.ownerInstanceId === this.instanceId &&
      tracked.closeState?.reason === 'idle' &&
      !this.closingSessions.has(sessionId)
    ) {
      tracked.closeState = undefined;
      this.updatePolling();
    }
  }

  private async respawnIfKnown(sessionId: string): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (this.permanentlyClosedSessions.has(sessionId)) return;

    const trackedBeforeClose = this.sessions.get(sessionId);
    if (
      trackedBeforeClose &&
      trackedBeforeClose.ownerInstanceId !== this.instanceId
    ) {
      log('[multiplexer-session-manager] respawn skipped; non-owner instance', {
        instanceId: this.instanceId,
        ownerInstanceId: trackedBeforeClose.ownerInstanceId,
        sessionId,
        paneId: trackedBeforeClose.paneId,
      });
      return;
    }

    const closing = this.closingSessions.get(sessionId);
    if (closing) await closing;

    if (this.permanentlyClosedSessions.has(sessionId)) return;
    const tracked = this.sessions.get(sessionId);
    if (tracked) {
      if (tracked.closeState?.reason === 'idle') {
        // A failed idle close leaves the pane attached; busy activity can use
        // it without spawning a second pane.
        tracked.closeState = undefined;
        this.updatePolling();
        log('[multiplexer-session-manager] retained pane after close failure', {
          instanceId: this.instanceId,
          sessionId,
          paneId: tracked.paneId,
        });
      }
      return;
    }

    if (this.isTrackedOrSpawning(sessionId)) {
      if (this.spawningSessions.has(sessionId))
        this.busyDuringSpawn.add(sessionId);
      return;
    }

    const known = this.knownSessions.get(sessionId);
    if (!known) return;

    this.spawningSessions.add(sessionId);
    try {
      const serverUrl = this.resolveServerUrl();
      if (!serverUrl) {
        log(
          '[multiplexer-session-manager] no valid server URL, skipping respawn',
          { instanceId: this.instanceId, sessionId },
        );
        return;
      }
      const serverRunning = await isServerRunning(serverUrl);
      if (!serverRunning) {
        log(
          '[multiplexer-session-manager] server not running, skipping busy respawn',
          { instanceId: this.instanceId, serverUrl, sessionId },
        );
        return;
      }

      const readinessOptions = this.readinessOptions();
      const sessionReady = await waitForSessionReady(serverUrl, sessionId, {
        ...readinessOptions,
        directory: known.directory,
      });
      if (!sessionReady || readinessOptions.signal?.aborted) {
        log(
          '[multiplexer-session-manager] child session not ready, skipping respawn',
          { instanceId: this.instanceId, sessionId, parentId: known.parentId },
        );
        return;
      }

      if (
        this.permanentlyClosedSessions.has(sessionId) ||
        this.sessions.has(sessionId) ||
        this.closingSessions.has(sessionId)
      )
        return;

      const paneResult = await this.multiplexer
        .spawnPane(
          sessionId,
          known.title,
          serverUrl,
          known.directory,
          this.multiplexer.type === 'tmux'
            ? { parentSessionId: known.parentId }
            : undefined,
        )
        .catch((err) => {
          log('[multiplexer-session-manager] failed to respawn pane', {
            instanceId: this.instanceId,
            error: String(err),
          });
          return { success: false, paneId: undefined };
        });

      if (!paneResult.success || !paneResult.paneId) return;

      if (
        !this.knownSessions.has(sessionId) ||
        this.closingSessions.has(sessionId) ||
        this.permanentlyClosedSessions.has(sessionId)
      ) {
        await this.trackAndCloseStalePane(
          sessionId,
          paneResult.paneId,
          known.parentId,
          known.title,
          known.directory,
        );
        return;
      }

      this.sessions.set(sessionId, {
        sessionId,
        paneId: paneResult.paneId,
        parentId: known.parentId,
        title: known.title,
        directory: known.directory,
        ownerInstanceId: this.instanceId,
      });
      this.backgroundJobBoard?.clearDeferredClose(sessionId);

      log('[multiplexer-session-manager] pane respawned on busy', {
        instanceId: this.instanceId,
        sessionId,
        paneId: paneResult.paneId,
      });

      this.startPolling();
    } finally {
      this.spawningSessions.delete(sessionId);
      if (
        this.busyDuringSpawn.delete(sessionId) &&
        !this.sessions.has(sessionId)
      )
        await this.respawnIfKnown(sessionId);
    }
  }

  private isTrackedOrSpawning(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.spawningSessions.has(sessionId);
  }

  private updatePolling(): void {
    if (
      [...this.sessions.values()].some((tracked) =>
        this.isPollableSession(tracked),
      )
    )
      this.startPolling();
    else this.stopPolling();
  }

  private isPollableSession(tracked: TrackedSession): boolean {
    return (
      tracked.ownerInstanceId === this.instanceId &&
      !this.closingSessions.has(tracked.sessionId) &&
      tracked.closeState?.phase !== 'exhausted'
    );
  }

  private getSessionId(event: SessionEvent): string | undefined {
    return event.properties?.info?.id || event.properties?.sessionID;
  }

  private backgroundJobState(
    sessionId: string,
  ): BackgroundJobState | undefined {
    return this.backgroundJobBoard?.getState(sessionId);
  }

  private shouldCloseNow(sessionId: string): boolean {
    return this.backgroundJobBoard?.deferIfRunning(sessionId) ?? true;
  }

  async closeSessionFromCoordinator(sessionId: string): Promise<void> {
    if (this.cmuxLifecycle)
      return this.cmuxLifecycle.closeSessionFromCoordinator(sessionId);
    if (!this.enabled) return;
    // The coordinator already checked lifecycle policy; skip the second check.
    await this.closeSession(sessionId, 'idle', true);
  }

  /** Permanently close a wall-clock timed-out pane and block late busy respawn. */
  async closeSessionPermanentlyFromCoordinator(
    sessionId: string,
  ): Promise<void> {
    if (this.cmuxLifecycle) {
      return this.cmuxLifecycle.closeSessionPermanentlyFromCoordinator(
        sessionId,
      );
    }
    if (!this.enabled) return;
    this.permanentlyClosedSessions.add(sessionId);
    await this.closeSession(sessionId, 'deleted', true);
  }

  async cleanup(): Promise<void> {
    if (this.cmuxLifecycle) {
      await this.cmuxLifecycle.cleanup();
      this.permanentlyClosedSessions.clear();
      return;
    }

    this.cleanupInProgress = true;
    this.abortInFlightReadiness();
    this.stopPolling();
    const deadlineAt = Date.now() + this.shutdownTimeoutMs;

    try {
      const ownedSessionIds = [...this.sessions.entries()]
        .filter(([, tracked]) => tracked.ownerInstanceId === this.instanceId)
        .map(([sessionId]) => sessionId);
      const closeWork = ownedSessionIds.map((sessionId) => {
        const existing = this.closingSessions.get(sessionId);
        return existing ?? this.closeSession(sessionId, 'deleted', true);
      });
      await this.waitForSettlements(closeWork, deadlineAt);

      this.knownSessions.clear();
      this.spawningSessions.clear();
      this.permanentlyClosedSessions.clear();
      this.busyDuringSpawn.clear();
    } finally {
      this.cleanupInProgress = false;
      // A failed close remains in `sessions` with a retry record. Re-enable
      // the shared polling executor after cleanup has stopped blocking it.
      this.updatePolling();
    }

    log('[multiplexer-session-manager] cleanup complete');
  }

  private async waitForSettlements(
    pending: Promise<unknown>[],
    deadlineAt: number,
  ): Promise<boolean> {
    if (pending.length === 0) return true;
    const settled = Promise.allSettled(pending).then(() => true);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      void settled;
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (completed: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(completed);
      };
      timer = setTimeout(() => finish(false), remaining);
      timer.unref?.();
      void settled.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }

  async cleanupOnInstanceDisposed(): Promise<void> {
    if (this.cmuxLifecycle) await this.cmuxLifecycle.cleanup();
    else this.abortInFlightReadiness();
  }
}

/**
 * @deprecated Use MultiplexerSessionManager instead
 */
export const TmuxSessionManager = MultiplexerSessionManager;
