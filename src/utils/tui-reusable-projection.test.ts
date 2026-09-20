import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getTuiStatePath,
  readTuiSnapshot,
  recordTuiSessionParent,
} from '../tui-state';
import { BackgroundJobBoard } from './background-job-fixture';
import { createTuiReusableProjection } from './tui-reusable-projection';

describe('tui-reusable-projection', () => {
  let root: string;
  let projectDir: string;
  let originalDataHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-reusable-proj-'));
    projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    originalDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(root, 'data');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
  });

  function seedReconciled(
    board: BackgroundJobBoard,
    taskID: string,
    opts: { agent?: string; launchAt?: number; reconciledAt?: number } = {},
  ) {
    const launchAt = opts.launchAt ?? 100;
    board.registerLaunch({
      taskID,
      parentSessionID: 'parent-1',
      agent: opts.agent ?? 'oracle',
      description: `${taskID} job`,
      now: launchAt,
    });
    board.updateStatus({
      taskID,
      state: 'completed' as never,
      resultSummary: 'done',
      now: launchAt + 50,
    });
    board.markReconciled(taskID, opts.reconciledAt ?? launchAt + 100);
  }

  test('a finished session is projected before the parent acknowledges it', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'oracle',
        description: 'ses_1 job',
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_1',
        state: 'completed' as never,
        resultSummary: 'done',
        now: 150,
      });

      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.oracle,
      ).toMatchObject({
        taskID: 'ses_1',
        terminalState: 'completed',
      });
    } finally {
      projection.dispose();
    }
  });

  test('board mutation projects the latest reconciled session into the snapshot', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_1');

      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.reusableByAgent['parent-1']?.oracle).toMatchObject({
        taskID: 'ses_1',
        alias: 'ora-1',
        terminalState: 'completed',
      });
    } finally {
      projection.dispose();
    }
  });

  test('creation clears a stale reusable section left by a previous host process', () => {
    // First host process projects a reconciled session and exits.
    const board = new BackgroundJobBoard();
    const first = createTuiReusableProjection({ board, projectDir });
    try {
      seedReconciled(board, 'ses_1');
      expect(
        readTuiSnapshot(projectDir).reusableByAgent['parent-1']?.oracle,
      ).toBeDefined();
    } finally {
      first.dispose();
    }

    // Second host process starts over an empty board: the creation
    // sweep must wipe the dead dots without waiting for any mutation
    // (decision: the board is the store; nothing survives a restart).
    const freshBoard = new BackgroundJobBoard();
    const second = createTuiReusableProjection({
      board: freshBoard,
      projectDir,
    });
    try {
      expect(readTuiSnapshot(projectDir).reusableByAgent).toEqual({});
    } finally {
      second.dispose();
    }
  });

  test('a mutation that changes nothing does not rewrite the state file', async () => {
    const fsModule = await import('node:fs');
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_1');
      const statePath = getTuiStatePath(projectDir);

      // A mutation that does not change the derived section (a new
      // running job, not yet reconciled) must not rewrite the file.
      let writes = 0;
      const writeSpy = spyOn(fsModule, 'writeFileSync').mockImplementation(
        (...args: Parameters<typeof fs.writeFileSync>) => {
          if (String(args[0]) === statePath) writes += 1;
          return fs.writeFileSync(...args);
        },
      );
      try {
        board.registerLaunch({
          taskID: 'ses_running_other',
          parentSessionID: 'parent-2',
          agent: 'fixer',
          now: 500,
        });
        expect(writes).toBe(0);
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      projection.dispose();
    }
  });

  test('dropping the selected job cleans the section', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      seedReconciled(board, 'ses_1');
      expect(readTuiSnapshot(projectDir).reusableByAgent['parent-1']).toEqual(
        expect.objectContaining({ oracle: expect.anything() }),
      );

      board.drop('ses_1');

      const section = readTuiSnapshot(projectDir).reusableByAgent;
      expect(section['parent-1']).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });

  test('section is scoped per parent and survives alongside other snapshot sections', () => {
    const board = new BackgroundJobBoard();
    const projection = createTuiReusableProjection({ board, projectDir });

    try {
      // Another writer persists a parent link; the projection must not
      // clobber sibling sections when it rewrites reusableByAgent.
      recordTuiSessionParent('ses_1', 'parent-1', projectDir);
      seedReconciled(board, 'ses_1', { agent: 'oracle' });
      board.registerLaunch({
        taskID: 'ses_fix',
        parentSessionID: 'parent-2',
        agent: 'fixer',
        now: 100,
      });
      board.updateStatus({
        taskID: 'ses_fix',
        state: 'completed' as never,
        resultSummary: 'done',
        now: 150,
      });
      board.markReconciled('ses_fix', 200);

      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.sessionParents.ses_1).toBe('parent-1');
      expect(snapshot.reusableByAgent['parent-1']?.oracle?.taskID).toBe(
        'ses_1',
      );
      expect(snapshot.reusableByAgent['parent-2']?.fixer?.taskID).toBe(
        'ses_fix',
      );
    } finally {
      projection.dispose();
    }
  });
});
