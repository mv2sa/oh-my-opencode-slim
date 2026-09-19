import { describe, expect, test } from 'bun:test';
import { orchestratorRestartRecoveryText } from './index';

describe('orchestrator restart-recovery reminder text', () => {
  test('names outcome_control only while the outcome layer is wired', () => {
    const enabled = orchestratorRestartRecoveryText(true);
    const disabled = orchestratorRestartRecoveryText(false);

    expect(enabled).toContain('outcome_control');
    expect(disabled).not.toContain('outcome_control');

    // The recovery instruction itself must survive in both variants; only the
    // inspection hints change, so the reminder never names a missing tool.
    for (const text of [enabled, disabled]) {
      expect(text).toContain('must not be blindly re-executed');
      expect(text).toContain('task_status');
      expect(text.startsWith('<system-reminder>')).toBe(true);
      expect(text.endsWith('</system-reminder>')).toBe(true);
    }

    // Default matches the wired variant (existing behavior preserved).
    expect(orchestratorRestartRecoveryText()).toBe(enabled);
  });
});
