import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FailureVerdict } from './classify-failure';
import { CooldownRegistry, getCooldownRegistry } from './cooldown-registry';

const transient: FailureVerdict = {
  class: 'transient',
  cooldownMs: 30_000,
  reason: 'network',
};

let directory: string;
let file: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-cooldowns-'));
  file = path.join(directory, 'cooldowns.json');
  process.env.OMOS_COOLDOWN_FILE = file;
  delete process.env.OMOS_COOLDOWN_DISABLED;
});

afterEach(() => {
  delete process.env.OMOS_COOLDOWN_FILE;
  delete process.env.OMOS_COOLDOWN_DISABLED;
  fs.rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cross-process worker harness
// ---------------------------------------------------------------------------

const registryUrl = pathToFileURL(
  path.join(import.meta.dir, 'cooldown-registry.ts'),
).href;

const workerPath = path.join(
  os.tmpdir(),
  `omos-cooldown-worker-${process.pid}.ts`,
);
fs.writeFileSync(
  workerPath,
  [
    `import { CooldownRegistry } from ${JSON.stringify(registryUrl)};`,
    "const mode = process.env.OMOS_TEST_MODE ?? '';",
    "const file = process.env.OMOS_TEST_FILE ?? '';",
    "const model = process.env.OMOS_TEST_MODEL ?? '';",
    "const cooldownMs = Number(process.env.OMOS_TEST_COOLDOWN_MS ?? '30000');",
    "const now = Number(process.env.OMOS_TEST_NOW ?? '1000');",
    "const iterations = Number(process.env.OMOS_TEST_ITERATIONS ?? '1');",
    "const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    'async function main() {',
    "  if (mode === 'writer') {",
    '    const registry = new CooldownRegistry(file);',
    "    const outcome = registry.markFailure(model, { class: 'transient', cooldownMs, reason: 'test' }, now);",
    '    emit({ outcome, entry: registry.list(now)[model] ?? null });',
    "  } else if (mode === 'writer-loop') {",
    '    const registry = new CooldownRegistry(file);',
    '    for (let i = 0; i < iterations; i++) {',
    "      registry.markFailure(model, { class: 'transient', cooldownMs, reason: 'test' }, now + i);",
    '    }',
    '    emit({ done: true });',
    "  } else if (mode === 'reader-loop') {",
    "    const fs = await import('node:fs');",
    '    let torn = false;',
    '    let reads = 0;',
    '    for (let i = 0; i < iterations; i++) {',
    '      try {',
    "        const raw = fs.readFileSync(file, 'utf8');",
    '        JSON.parse(raw);',
    '        reads++;',
    '      } catch (error) {',
    "        if (error && error.code === 'ENOENT') continue;",
    '        torn = true;',
    '        break;',
    '      }',
    '      await new Promise((resolve) => setTimeout(resolve, 1));',
    '    }',
    '    emit({ torn, reads });',
    "  } else if (mode === 'reader') {",
    '    const registry = new CooldownRegistry(file);',
    '    emit({ dead: registry.isDead(model, now), list: registry.list(now) });',
    '  }',
    '}',
    'main();',
  ].join('\n'),
);

afterAll(() => {
  try {
    fs.unlinkSync(workerPath);
  } catch {
    // Best-effort cleanup.
  }
});

async function spawnWorker(
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, workerPath],
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parseWorkerResult(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').pop() ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CooldownRegistry', () => {
  test('persists across instances', () => {
    new CooldownRegistry().markFailure('provider/model', transient, 1000);
    expect(new CooldownRegistry().isDead('provider/model', 2000)).toBe(true);
  });

  test('prunes expired entries', () => {
    const registry = new CooldownRegistry();
    registry.markFailure('provider/model', transient, 1000);
    expect(registry.isDead('provider/model', 31_001)).toBe(false);
    expect(registry.list(31_001)).toEqual({});
  });

  test('merges instances and keeps later deadUntil', () => {
    const first = new CooldownRegistry();
    const second = new CooldownRegistry();
    first.markFailure('provider/model', transient, 10_000);
    second.markFailure(
      'provider/model',
      { ...transient, cooldownMs: 10_000 },
      20_000,
    );
    expect(
      new CooldownRegistry().list(20_000)['provider/model']?.deadUntil,
    ).toBe(40_000);
  });

  test('is disabled by environment', () => {
    process.env.OMOS_COOLDOWN_DISABLED = '1';
    const registry = new CooldownRegistry();
    expect(registry.markFailure('provider/model', transient, 1000)).toBe(
      'disabled',
    );
    expect(registry.isDead('provider/model', 1001)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('ignores a zero-cooldown verdict without writing', () => {
    const registry = new CooldownRegistry();
    expect(
      registry.markFailure(
        'provider/model',
        { ...transient, cooldownMs: 0 },
        1000,
      ),
    ).toBe('ignored');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('tolerates corrupt JSON', () => {
    fs.writeFileSync(file, '{not json');
    expect(new CooldownRegistry().list()).toEqual({});
  });

  test('tolerates truncated JSON', () => {
    fs.writeFileSync(file, '{"provider/model":{"deadUntil":12');
    expect(new CooldownRegistry().list()).toEqual({});
  });

  test('repairs a non-object document to empty state', () => {
    fs.writeFileSync(file, '[1, 2, 3]');
    expect(new CooldownRegistry().list()).toEqual({});
    fs.writeFileSync(file, '"hello"');
    expect(new CooldownRegistry().list()).toEqual({});
    fs.writeFileSync(file, '42');
    expect(new CooldownRegistry().list()).toEqual({});
  });

  test('drops malformed entries but keeps valid ones', () => {
    const now = Date.now();
    const deadUntil = now + 900_000;
    fs.writeFileSync(
      file,
      JSON.stringify({
        'good/model': {
          deadUntil,
          reason: 'quota',
          class: 'quota',
          hits: 1,
          lastSeen: now,
        },
        'bad/no-dead-until': { reason: 'quota', class: 'quota' },
        'bad/not-object': 'nope',
        'bad/null': null,
        'bad/wrong-class': {
          deadUntil,
          reason: 'quota',
          class: 'not-a-class',
          hits: 1,
          lastSeen: now,
        },
      }),
    );
    const list = new CooldownRegistry().list();
    expect(Object.keys(list).sort()).toEqual(['bad/wrong-class', 'good/model']);
    expect(list['good/model']).toEqual(
      expect.objectContaining({ deadUntil, hits: 1 }),
    );
    // Unknown class value is coerced to 'unknown', not dropped.
    fs.writeFileSync(
      file,
      JSON.stringify({
        'weird/model': {
          deadUntil,
          class: 'not-a-class',
          hits: 2,
          lastSeen: now,
        },
      }),
    );
    expect(new CooldownRegistry().list()['weird/model']?.class).toBe('unknown');
  });

  test('escalates the third recent transient strike to five minutes', () => {
    const registry = new CooldownRegistry();
    registry.markFailure('provider/model', transient, 1000);
    registry.markFailure('provider/model', transient, 2000);
    registry.markFailure('provider/model', transient, 3000);
    expect(registry.list(3000)['provider/model']).toEqual(
      expect.objectContaining({ deadUntil: 303_000, hits: 3 }),
    );
  });

  test('override prevents creation at the configured default path', () => {
    const fakeDefault = path.join(directory, 'default');
    process.env.XDG_CONFIG_HOME = fakeDefault;
    getCooldownRegistry().markFailure('provider/model', transient, 1000);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(fakeDefault, 'opencode'))).toBe(false);
    delete process.env.XDG_CONFIG_HOME;
  });

  test('rapid replacement is observed even with equal mtimes', () => {
    // Atomic-rename writes replace the inode; a filesystem reporting coarse
    // (equal) mtimes must not hide the replacement. The two single-entry states
    // use same-length keys so the JSON size is identical — only the inode
    // differs between them.
    const reader = new CooldownRegistry(file);
    const writer = new CooldownRegistry(file);

    // State 1: only 'a/a'.
    const now = Date.now();
    writer.markFailure('a/a', transient, now);
    fs.utimesSync(file, 5_000, 5_000);
    expect(reader.list()).toEqual({
      'a/a': expect.objectContaining({ deadUntil: now + 30_000 }),
    });

    // State 2: only 'b/b' — equal mtime and equal size, but a new inode.
    writer.clear('a/a');
    writer.markFailure('b/b', transient, now);
    fs.utimesSync(file, 5_000, 5_000);

    expect(reader.list()).toEqual({
      'b/b': expect.objectContaining({ deadUntil: now + 30_000 }),
    });
    expect(reader.list()['a/a']).toBeUndefined();
  });
});

describe('CooldownRegistry cross-process', () => {
  test('persists across process exit (independent writer and reader)', async () => {
    const write = await spawnWorker({
      OMOS_TEST_MODE: 'writer',
      OMOS_TEST_FILE: file,
      OMOS_TEST_MODEL: 'provider/model',
      OMOS_TEST_COOLDOWN_MS: '30000',
      OMOS_TEST_NOW: '1000',
    });
    expect(write.exitCode).toBe(0);
    expect(parseWorkerResult(write.stdout).outcome).toBe('written');

    const read = await spawnWorker({
      OMOS_TEST_MODE: 'reader',
      OMOS_TEST_FILE: file,
      OMOS_TEST_MODEL: 'provider/model',
      OMOS_TEST_NOW: '2000',
    });
    expect(read.exitCode).toBe(0);
    expect(parseWorkerResult(read.stdout)).toEqual(
      expect.objectContaining({ dead: true }),
    );
  });

  test('concurrent writers for different models preserve both entries', async () => {
    const [a, b] = await Promise.all([
      spawnWorker({
        OMOS_TEST_MODE: 'writer',
        OMOS_TEST_FILE: file,
        OMOS_TEST_MODEL: 'a/a',
        OMOS_TEST_COOLDOWN_MS: '10000',
        OMOS_TEST_NOW: '1000',
      }),
      spawnWorker({
        OMOS_TEST_MODE: 'writer',
        OMOS_TEST_FILE: file,
        OMOS_TEST_MODEL: 'b/b',
        OMOS_TEST_COOLDOWN_MS: '20000',
        OMOS_TEST_NOW: '1000',
      }),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(parseWorkerResult(a.stdout).outcome).toBe('written');
    expect(parseWorkerResult(b.stdout).outcome).toBe('written');

    const list = new CooldownRegistry(file).list(2000);
    expect(Object.keys(list).sort()).toEqual(['a/a', 'b/b']);
    expect(list['a/a']?.deadUntil).toBe(11_000);
    expect(list['b/b']?.deadUntil).toBe(21_000);
  });

  test('concurrent writers for one model preserve max deadUntil and hit accounting', async () => {
    const [a, b] = await Promise.all([
      spawnWorker({
        OMOS_TEST_MODE: 'writer',
        OMOS_TEST_FILE: file,
        OMOS_TEST_MODEL: 'x/y',
        OMOS_TEST_COOLDOWN_MS: '10000',
        OMOS_TEST_NOW: '1000',
      }),
      spawnWorker({
        OMOS_TEST_MODE: 'writer',
        OMOS_TEST_FILE: file,
        OMOS_TEST_MODEL: 'x/y',
        OMOS_TEST_COOLDOWN_MS: '30000',
        OMOS_TEST_NOW: '1000',
      }),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const entry = new CooldownRegistry(file).list(2000)['x/y'];
    expect(entry).toEqual(
      expect.objectContaining({
        deadUntil: 31_000,
        hits: 2,
      }),
    );
  });

  test('readers during replacement never observe a partial file', async () => {
    new CooldownRegistry(file).markFailure('w/model', transient, 1000);

    const [writer, reader] = await Promise.all([
      spawnWorker({
        OMOS_TEST_MODE: 'writer-loop',
        OMOS_TEST_FILE: file,
        OMOS_TEST_MODEL: 'w/model',
        OMOS_TEST_COOLDOWN_MS: '30000',
        OMOS_TEST_NOW: '1000',
        OMOS_TEST_ITERATIONS: '100',
      }),
      spawnWorker({
        OMOS_TEST_MODE: 'reader-loop',
        OMOS_TEST_FILE: file,
        OMOS_TEST_ITERATIONS: '200',
      }),
    ]);
    expect(writer.exitCode).toBe(0);
    expect(reader.exitCode).toBe(0);
    const readerResult = parseWorkerResult(reader.stdout);
    expect(readerResult.torn).toBe(false);
    expect(readerResult.reads).toBeGreaterThan(0);
  });
});

describe('CooldownRegistry lock semantics', () => {
  test('contends (not deadlocks) when a live owner holds the lock', () => {
    const lockPath = `${file}.lock`;
    const ownerPath = path.join(lockPath, 'owner');
    fs.mkdirSync(lockPath, { recursive: true });
    // A live owner: our own pid. A well-behaved contender must never remove
    // another owner's lock.
    fs.writeFileSync(ownerPath, `${process.pid}\n${Date.now()}\n`);

    const registry = new CooldownRegistry(file);
    expect(registry.markFailure('x/y', transient, 1000)).toBe('contention');

    // The live owner's lock is untouched.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(ownerPath)).toBe(true);
  });

  test('fails closed on a stale lock instead of risking successor deletion', async () => {
    // Spawn + exit a child to obtain a pid that is guaranteed dead.
    const probe = Bun.spawn({
      cmd: [process.execPath, '-e', 'process.exit(0)'],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const deadPid = probe.pid;
    await probe.exited;

    const lockPath = `${file}.lock`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, 'owner'),
      `${deadPid}\n${Date.now()}\n`,
    );

    const registry = new CooldownRegistry(file);
    expect(registry.markFailure('x/y', transient, 1000)).toBe('contention');
    expect(registry.isDead('x/y', 2000)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('never releases a successor lock after ownership changes', () => {
    const registry = new CooldownRegistry(file) as unknown as {
      acquireLock(): string | undefined;
      releaseLock(token: string): void;
    };
    const token = registry.acquireLock();
    expect(token).toBeString();
    const lockPath = `${file}.lock`;
    fs.writeFileSync(
      path.join(lockPath, 'owner'),
      `${process.pid}\n${Date.now()}\nsuccessor-token\n`,
    );

    registry.releaseLock(token as string);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).toContain(
      'successor-token',
    );
  });
});
