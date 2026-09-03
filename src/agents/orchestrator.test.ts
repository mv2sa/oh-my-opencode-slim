import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt } from './orchestrator';

describe('orchestrator prompt', () => {
  test('requires the question tool for blocking user input', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('use the `question` tool');
    expect(prompt).toContain('Enable custom input');
    expect(prompt).toContain('concise pasted response or command output');
    expect(prompt).toContain('small bounded set of options');
    expect(prompt).toContain('ordinary dialogue that does not block work');
  });

  test('requires wait_for_user for external manual work', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).toContain('give the user concrete manual steps');
    expect(prompt).toContain('end the turn');
    expect(prompt).toContain('never use `wait_for_user` to await them');
    expect(prompt).toContain('Do not rely on ordinary text alone');
  });

  test('falls back to question when wait_for_user is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, false);

    expect(prompt).not.toContain(
      'call `wait_for_user` as your final tool action',
    );
    expect(prompt).toContain('`wait_for_user` is disabled');
    expect(prompt).toContain(
      'use the `question` tool as the blocking boundary',
    );
  });

  test('omits end-turn instruction when wake scheduler is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, true, false);

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).not.toContain('End Turn After Background Tasks');
    expect(prompt).toContain('Do not immediately wait after spawning');
  });

  test('includes @outcome-manager description by default', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toContain('@outcome-manager');
    expect(prompt).toContain('Outcome governance');
  });

  test('excludes @outcome-manager description when disabled', () => {
    const prompt = buildOrchestratorPrompt(new Set(['outcome-manager']));
    expect(prompt).not.toContain('@outcome-manager');
  });

  test('enforces outcome contract lifecycle, kickoff ordering, bounded retry, and terminal state invariants', () => {
    const prompt = buildOrchestratorPrompt();

    // Kickoff ordering before other checkpoints
    expect(prompt).toContain(
      'Begin and authenticate kickoff review before taking non-kickoff checkpoints',
    );

    // Forwarding exact packet and reconciliation
    expect(prompt).toContain(
      'forwarding the exact volatile review packet and dispatch marker provided by the Controller',
    );
    expect(prompt).toContain(
      "Reconcile review results with `outcome_control(action: 'reconcile_review', ...)` and inspect authoritative outcome status",
    );

    // Bounded retry
    expect(prompt).toContain(
      'retry kickoff at most once when Controller exposes retry availability',
    );

    // Terminal uncertifiable states
    expect(prompt).toContain(
      'Obey exhausted kickoff attempts or legacy retrospective errors (`legacy_late_missing`, exhausted kickoff gate) as terminal uncertifiable states',
    );

    // No retrospective kickoff after final work
    expect(prompt).toContain(
      'Never open a retrospective kickoff checkpoint after completing final work or after later review activity',
    );

    // Provenance integrity
    expect(prompt).toContain(
      'Never resolve actions or authenticate reviews using synthetic/internal task notices as user provenance',
    );

    // No repeated invalid loop
    expect(prompt).toContain(
      'Do not repeatedly attest evidence or re-dispatch unchanged invalid Manager envelopes',
    );
  });
});
