import { beforeEach, expect, test } from 'bun:test';
import { externalMessage } from '../external-message';
import {
  canAttemptRestartRecovery,
  canReserveOutcomeIdleWake,
  commitOutcomeIdleWake,
  commitRestartRecoverySuccess,
  commitWakeReservation,
  getRestartRecoveryState,
  getWakeProgress,
  noteExternalWakeMessage,
  noteHostProgress,
  observeWakeLifecycle,
  recordRestartRecoveryFailure,
  releaseRestartRecovery,
  releaseUncommittedWakeEvaluation,
  releaseWakeEvaluation,
  resetOrchestratorWakeGateForTests,
  tryBeginRestartRecovery,
  tryBeginWakeEvaluation,
  wakeGateSizesForTests,
} from './wake-gate';

beforeEach(resetOrchestratorWakeGateForTests);

function requireOwner(owner: symbol | null): symbol {
  if (!owner) throw new Error('Expected admitted owner');
  return owner;
}

test('shared whole-message provenance rejects dirty/mixed metadata and authoritative empty output', () => {
  const input = {
    sessionID: 'root',
    messageID: 'host',
    parts: [{ type: 'text', text: 'Stop' }],
  };
  expect(externalMessage(input, undefined)?.messageID).toBe('host');
  expect(externalMessage(input, { parts: [] })).toBeUndefined();
  for (const part of [
    { type: 'text', text: 'internal', synthetic: true },
    {
      type: 'text',
      text: 'internal',
      providerMetadata: { compaction_continue: true },
    },
    {
      type: 'text',
      text: 'internal',
      metadata: { 'oh-my-opencode-slim:outcome-controller': true },
    },
  ]) {
    expect(
      externalMessage(input, { parts: [...input.parts, part] }),
    ).toBeUndefined();
  }
  expect(
    externalMessage(input, {
      message: { id: 'authoritative', role: 'assistant' },
    }),
  ).toBeUndefined();
  expect(
    externalMessage(input, { message: { id: 'authoritative' } })?.messageID,
  ).toBe('authoritative');
});

test('all components share two attempts, first/missing telemetry cannot refill, commits are owner-safe', () => {
  const owner = requireOwner(tryBeginWakeEvaluation('root'));
  expect(tryBeginWakeEvaluation('root')).toBeNull();
  expect(commitOutcomeIdleWake('root', Symbol())).toBe(false);
  expect(commitOutcomeIdleWake('root', owner)).toBe(true);
  expect(commitOutcomeIdleWake('root', owner)).toBe(false);
  releaseUncommittedWakeEvaluation('root', owner);
  expect(tryBeginWakeEvaluation('root')).toBeNull();
  releaseWakeEvaluation('root', Symbol());
  expect(tryBeginWakeEvaluation('root')).toBeNull();
  releaseWakeEvaluation('root', owner);
  noteHostProgress('root', 'todo baseline');
  noteHostProgress('root', 'controller baseline', 'controller');
  const second = requireOwner(tryBeginWakeEvaluation('root'));
  observeWakeLifecycle('root', 'busy');
  observeWakeLifecycle('root', 'idle');
  expect(commitWakeReservation('root', second, 'todo baseline')).toBe(true);
  releaseWakeEvaluation('root', second);
  const third = requireOwner(tryBeginWakeEvaluation('root'));
  expect(commitOutcomeIdleWake('root', third)).toBe(false);
  expect(getWakeProgress('root').unchangedWakeCount).toBe(2);
  noteHostProgress('root', 'controller baseline', 'controller');
  noteHostProgress('root', 'todo baseline');
  expect(commitWakeReservation('root', third)).toBe(false);
  noteHostProgress('root', 'changed TODO');
  expect(commitWakeReservation('root', third)).toBe(true);
  releaseWakeEvaluation('root', third);
  expect(noteExternalWakeMessage('root', 'host-1')).toBe(true);
  const fourth = requireOwner(tryBeginWakeEvaluation('root'));
  expect(commitWakeReservation('root', fourth)).toBe(true);
  expect(noteExternalWakeMessage('root', 'host-1')).toBe(false);
  expect(getWakeProgress('root').unchangedWakeCount).toBe(1);
});

test('restart transport admission debits before await and stale/repeated callbacks do not mutate owner state', () => {
  const owner = requireOwner(tryBeginRestartRecovery('root'));
  expect(commitWakeReservation('root', owner)).toBe(true);
  expect(getWakeProgress('root').expectingWakeBusy).toBe(true);
  expect(tryBeginWakeEvaluation('root')).toBeNull();
  recordRestartRecoveryFailure('root', Symbol());
  releaseRestartRecovery('root', Symbol());
  commitRestartRecoverySuccess('root', Symbol());
  expect(getRestartRecoveryState('root')).toMatchObject({
    inFlight: true,
    attempts: 0,
    succeeded: false,
  });
  recordRestartRecoveryFailure('root', owner);
  recordRestartRecoveryFailure('root', owner);
  expect(getRestartRecoveryState('root').attempts).toBe(1);
  expect(getWakeProgress('root').unchangedWakeCount).toBe(1);
  releaseRestartRecovery('root', owner);
  observeWakeLifecycle('root', 'busy');
  observeWakeLifecycle('root', 'idle');
  const replacement = requireOwner(tryBeginRestartRecovery('root'));
  commitRestartRecoverySuccess('root', owner);
  releaseRestartRecovery('root', owner);
  expect(commitWakeReservation('root', replacement)).toBe(true);
  commitRestartRecoverySuccess('root', replacement);
  releaseRestartRecovery('root', replacement);
  expect(tryBeginRestartRecovery('root')).toBeNull();
  expect(getWakeProgress('root').unchangedWakeCount).toBe(2);
});

test('bounded host-ID dedup and session pressure never evict a live spent budget', () => {
  for (let i = 0; i < 300; i++) noteExternalWakeMessage('root', `host-${i}`);
  expect(getWakeProgress('root').externalMessageIDs.size).toBe(256);
  const owner = requireOwner(tryBeginWakeEvaluation('root'));
  commitWakeReservation('root', owner);
  releaseWakeEvaluation('root', owner);
  for (let i = 0; i < 300; i++) getWakeProgress(`other-${i}`);
  expect(getWakeProgress('root').unchangedWakeCount).toBe(1);
  const second = requireOwner(tryBeginWakeEvaluation('root'));
  observeWakeLifecycle('root', 'busy');
  observeWakeLifecycle('root', 'idle');
  expect(commitWakeReservation('root', second)).toBe(true);
  expect(noteExternalWakeMessage('root', 'host-0')).toBe(false);
  expect(noteExternalWakeMessage('root', 'unrecognized-after-capacity')).toBe(
    false,
  );
  expect(getWakeProgress('root').unchangedWakeCount).toBe(2);
  for (let i = 0; i < 2000; i++) {
    getRestartRecoveryState(`other-${i}`);
    tryBeginWakeEvaluation(`other-${i}`);
  }
  const sizes = wakeGateSizesForTests();
  for (const size of Object.values(sizes))
    expect(size).toBeLessThanOrEqual(256);
  expect(tryBeginWakeEvaluation('root')).toBeNull();
  expect(tryBeginWakeEvaluation('overflow')).toBeNull();
});

test('restart success blocks only restart after genuine user rearm', () => {
  const owner = requireOwner(tryBeginRestartRecovery('root'));
  commitWakeReservation('root', owner);
  commitRestartRecoverySuccess('root', owner);
  releaseRestartRecovery('root', owner);
  expect(canReserveOutcomeIdleWake('root')).toBe(false);
  noteExternalWakeMessage('root', 'new-user');
  expect(canReserveOutcomeIdleWake('root')).toBe(true);
  expect(canAttemptRestartRecovery('root')).toBe(false);
});
