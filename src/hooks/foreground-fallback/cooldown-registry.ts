import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../utils/logger';
import type { FailureClass, FailureVerdict } from './classify-failure';

export interface CooldownEntry {
  deadUntil: number;
  reason: string;
  class: FailureClass;
  hits: number;
  lastSeen: number;
}

/**
 * Outcome of a registry mutation. Exported so callers and tests can assert
 * explicit behavior for the contended, disabled, and failed paths instead of
 * silently swallowing them.
 */
export type RegistryWriteResult =
  | 'written'
  | 'disabled'
  | 'ignored'
  | 'contention'
  | 'failed';

type Store = Record<string, CooldownEntry>;

const FAILURE_CLASSES: ReadonlySet<string> = new Set<FailureClass>([
  'quota',
  'rate-limit',
  'transient',
  'request-fatal',
  'unknown',
]);

/**
 * How long markFailure/clear wait for the lock before giving up. A write that
 * cannot be serialized within this window is reported as `'contention'`, never
 * retried indefinitely (which would stall the fallback event handler).
 */
const LOCK_TIMEOUT_MS = 200;

/** Two recent hits within this window keep the failure "recent". */
const RECENT_WINDOW_MS = 300_000;

/** Third recent transient strike escalates to this fixed window. */
const TRANSIENT_ESCALATION_MS = 300_000;

/** Number of prior hits (>= this) that triggers transient escalation. */
const TRANSIENT_ESCALATION_HITS = 2;

function defaultFile(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'opencode',
    'model-cooldowns.json',
  );
}

/**
 * Synchronous sleep used only inside the lock-acquisition loop. `Atomics.wait`
 * is the cheapest correct primitive; the busy-wait fallback covers runtimes
 * that disallow it.
 */
function sleepSync(ms: number): void {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy-wait fallback.
    }
  }
}

interface LockOwner {
  pid: number;
  createdAt: number;
  token?: string;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const raw = fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim();
    const separator = raw.indexOf('\n');
    if (separator <= 0) return undefined;
    const pid = Number.parseInt(raw.slice(0, separator), 10);
    const createdAt = Number.parseInt(raw.slice(separator + 1), 10);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAt)) {
      return undefined;
    }
    const token = raw
      .slice(separator + 1)
      .split('\n')[1]
      ?.trim();
    return { pid, createdAt, ...(token ? { token } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Validate and repair a single cooldown entry. Drops entries that are not
 * objects or lack a numeric `deadUntil` (unusable); coerces the remaining
 * fields to safe defaults so a partially-corrupt entry never crashes a reader.
 */
export function repairCooldownEntry(
  modelId: string,
  entry: unknown,
): CooldownEntry | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    log('[cooldown] dropping malformed entry', { modelId });
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (
    typeof record.deadUntil !== 'number' ||
    !Number.isFinite(record.deadUntil)
  ) {
    log('[cooldown] dropping entry without numeric deadUntil', { modelId });
    return undefined;
  }
  return {
    deadUntil: record.deadUntil,
    reason: typeof record.reason === 'string' ? record.reason : '',
    class:
      typeof record.class === 'string' && FAILURE_CLASSES.has(record.class)
        ? (record.class as FailureClass)
        : 'unknown',
    hits:
      typeof record.hits === 'number' && Number.isFinite(record.hits)
        ? record.hits
        : 0,
    lastSeen:
      typeof record.lastSeen === 'number' && Number.isFinite(record.lastSeen)
        ? record.lastSeen
        : 0,
  };
}

interface Freshness {
  mtimeMs: number;
  size: number;
  ino: number;
}

export class CooldownRegistry {
  private readonly file: string;
  private readonly disabled: boolean;
  private cache: Store = {};
  private freshness: Freshness | undefined;

  constructor(file = process.env.OMOS_COOLDOWN_FILE ?? defaultFile()) {
    this.file = file;
    this.disabled = process.env.OMOS_COOLDOWN_DISABLED === '1';
  }

  private get lockPath(): string {
    return `${this.file}.lock`;
  }

  private prune(store: Store, now: number): Store {
    const result: Store = {};
    for (const [modelId, entry] of Object.entries(store)) {
      if (entry.deadUntil > now) result[modelId] = entry;
    }
    return result;
  }

  /**
   * Parse + validate the raw state file into a {@link Store}. A non-object or
   * malformed document is repaired to `{}` (fail open: never block a model on
   * unreadable state); individual malformed entries are dropped.
   */
  private parseStore(raw: string): Store {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      log('[cooldown] registry state is not an object; resetting', {});
      return {};
    }
    const store: Store = {};
    for (const [modelId, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const repaired = repairCooldownEntry(modelId, entry);
      if (repaired) store[modelId] = repaired;
    }
    return store;
  }

  private read(now = Date.now(), force = false): Store {
    if (this.disabled) return {};
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('[cooldown] registry stat failed', { error: String(error) });
      }
      this.cache = {};
      this.freshness = undefined;
      return this.cache;
    }

    // Fast path: an atomic-rename replacement changes the inode, so comparing
    // inode + size + mtime detects replacements even when a filesystem reports
    // coarse (equal) mtimes. Only the inode is load-bearing here; size and
    // mtime are cheap secondary hints.
    if (
      !force &&
      this.freshness !== undefined &&
      stat.ino === this.freshness.ino &&
      stat.size === this.freshness.size &&
      stat.mtimeMs === this.freshness.mtimeMs
    ) {
      this.cache = this.prune(this.cache, now);
      return this.cache;
    }

    try {
      const parsed = this.parseStore(fs.readFileSync(this.file, 'utf8'));
      this.cache = this.prune(parsed, now);
      this.freshness = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ino: stat.ino,
      };
      return this.cache;
    } catch (error) {
      log('[cooldown] registry read failed', { error: String(error) });
      this.cache = {};
      this.freshness = undefined;
      return this.cache;
    }
  }

  /**
   * Acquire the directory lock (`mkdirSync` is atomic). Records the owner's pid
   * + creation time inside the lock directory so a later contender can decide
   * whether the holder is still alive.
   */
  private acquireLock(): string | undefined {
    const lockPath = this.lockPath;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch (error) {
      log('[cooldown] lock dir creation failed', { error: String(error) });
      return undefined;
    }
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(lockPath);
        try {
          fs.writeFileSync(
            path.join(lockPath, 'owner'),
            `${process.pid}\n${Date.now()}\n${token}\n`,
          );
        } catch (error) {
          log('[cooldown] lock metadata write failed', {
            error: String(error),
          });
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {}
          return undefined;
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          log('[cooldown] lock acquisition failed', { error: String(error) });
          return undefined;
        }
      }
      if (Date.now() >= deadline) {
        log('[cooldown] lock contended', {
          lockPath,
          timeoutMs: LOCK_TIMEOUT_MS,
        });
        return undefined;
      }
      sleepSync(1);
    }
  }

  private releaseLock(token: string): void {
    try {
      const owner = readLockOwner(this.lockPath);
      if (
        owner?.pid !== process.pid ||
        owner.token === undefined ||
        owner.token !== token
      ) {
        log('[cooldown] refusing to release lock owned by another process', {
          lockPath: this.lockPath,
        });
        return;
      }
      const releasePath = `${this.lockPath}.release.${process.pid}.${token}`;
      fs.renameSync(this.lockPath, releasePath);
      fs.rmSync(releasePath, { recursive: true, force: true });
    } catch {
      // Best-effort: the lock may already be gone.
    }
  }

  private write(store: Store): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx');
      try {
        fs.writeSync(descriptor, `${JSON.stringify(store, null, 2)}\n`);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.file);
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // Best-effort temp cleanup.
      }
    }
    const stat = fs.statSync(this.file);
    this.cache = store;
    this.freshness = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
    };
  }

  isDead(modelId: string, now = Date.now()): boolean {
    return !this.disabled && (this.read(now)[modelId]?.deadUntil ?? 0) > now;
  }

  markFailure(
    modelId: string,
    verdict: FailureVerdict,
    now = Date.now(),
  ): RegistryWriteResult {
    if (this.disabled) return 'disabled';
    if (verdict.cooldownMs <= 0) return 'ignored';
    const lockToken = this.acquireLock();
    if (!lockToken) return 'contention';
    try {
      const store = this.read(now, true);
      const previous = store[modelId];
      const recent =
        previous !== undefined && now - previous.lastSeen <= RECENT_WINDOW_MS;
      const duration =
        verdict.class === 'transient' &&
        recent &&
        (previous?.hits ?? 0) >= TRANSIENT_ESCALATION_HITS
          ? TRANSIENT_ESCALATION_MS
          : verdict.cooldownMs;
      store[modelId] = {
        deadUntil: Math.max(previous?.deadUntil ?? 0, now + duration),
        reason: verdict.reason,
        class: verdict.class,
        hits: (recent ? (previous?.hits ?? 0) : 0) + 1,
        lastSeen: now,
      };
      this.write(store);
      return 'written';
    } catch (error) {
      log('[cooldown] registry write failed', { error: String(error) });
      return 'failed';
    } finally {
      this.releaseLock(lockToken);
    }
  }

  list(now = Date.now()): Store {
    if (this.disabled) return {};
    return { ...this.read(now) };
  }

  clear(modelId?: string): RegistryWriteResult {
    if (this.disabled) return 'disabled';
    const lockToken = this.acquireLock();
    if (!lockToken) return 'contention';
    try {
      const store = this.read(Date.now(), true);
      if (modelId) delete store[modelId];
      else for (const key of Object.keys(store)) delete store[key];
      this.write(store);
      return 'written';
    } catch (error) {
      log('[cooldown] registry clear failed', { error: String(error) });
      return 'failed';
    } finally {
      this.releaseLock(lockToken);
    }
  }
}

let sharedRegistry: CooldownRegistry | undefined;
let sharedFile: string | undefined;

export function getCooldownRegistry(): CooldownRegistry {
  const file = process.env.OMOS_COOLDOWN_FILE ?? defaultFile();
  if (!sharedRegistry || sharedFile !== file) {
    sharedRegistry = new CooldownRegistry(file);
    sharedFile = file;
  }
  return sharedRegistry;
}
