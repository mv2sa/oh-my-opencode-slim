import { expect, test } from 'bun:test';
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { completedNarrationTurn } from './notice-state';

test('host history traversal crosses only incomplete assistants/internal wakes, never external or tool boundaries', () => {
  const completed = {
    info: {
      role: 'assistant',
      sessionID: 'root',
      id: 'done',
      time: { completed: 1 },
    },
    parts: [{ type: 'text', text: 'Still stopped' }],
  };
  const current = {
    info: {
      role: 'assistant',
      sessionID: 'root',
      id: 'current',
      time: { created: 3 },
    },
    parts: [],
  };
  const wake = {
    info: { role: 'user', sessionID: 'root', id: 'wake' },
    parts: [createInternalAgentTextPart('internal')],
  };
  expect(completedNarrationTurn([completed, wake, current], 'root')).toBe(
    'done',
  );
  expect(
    completedNarrationTurn(
      [
        completed,
        { ...wake, parts: [{ type: 'text', text: 'Stop' }] },
        current,
      ],
      'root',
    ),
  ).toBeUndefined();
  expect(
    completedNarrationTurn(
      [completed, { ...current, parts: [{ type: 'tool', tool: 'read' }] }],
      'root',
    ),
  ).toBeUndefined();
  expect(
    completedNarrationTurn(
      [
        { ...completed, parts: [{ type: 'tool', tool: 'read' }] },
        wake,
        current,
      ],
      'root',
    ),
  ).toBeUndefined();
  expect(
    completedNarrationTurn(
      [completed, { info: current.info, parts: null }],
      'root',
    ),
  ).toBeUndefined();
});
