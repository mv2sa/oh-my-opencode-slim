import { expect, test } from 'bun:test';
import {
  extractTaskSummary,
  formatCancelledTaskStatusOutput,
} from './status-utils';

test('status utilities format diagnostics, not board transitions', () => {
  expect(extractTaskSummary('<summary> stopped </summary>')).toBe('stopped');
  expect(
    formatCancelledTaskStatusOutput('child-1', 'user requested'),
  ).toContain('<task_error>\nuser requested\n</task_error>');
});
