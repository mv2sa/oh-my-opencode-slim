import { randomBytes } from 'node:crypto';

const PROCESS_EPOCH_SYMBOL = Symbol.for('omos.outcome.process_epoch');

/**
 * Returns the process-global epoch string for this OS process.
 * Shared across plugin instance recreations within the same process via `globalThis`.
 * Format includes the OS process PID and a cryptographic random nonce.
 */
export function getProcessEpoch(): string {
  const globalStore = globalThis as unknown as Record<
    symbol,
    string | undefined
  >;
  const existing = globalStore[PROCESS_EPOCH_SYMBOL];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const nonce = randomBytes(16).toString('hex');
  const epoch = `epoch_${process.pid}_${nonce}_${Date.now()}`;
  globalStore[PROCESS_EPOCH_SYMBOL] = epoch;
  return epoch;
}
