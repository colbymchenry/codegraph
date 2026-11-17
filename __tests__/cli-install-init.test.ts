/**
 * `codegraph install --init` and `codegraph init --yes` (#1578): the one-shot,
 * non-interactive "wire agents + build this project's index" bootstrap a fresh
 * container / CI job needs.
 *
 * Exercised end-to-end against the built binary so the CLI wiring (the shared
 * `runInit` flow, the flag plumbing, exit codes) is what's covered. Every run
 * uses `--target none`, so the installer touches no agent config on the
 * machine running the suite; the only side effect is the temp project's
 * `.codegraph/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with stdin closed — a prompt that blocks would hang / fail here. */
function runCodegraph(args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

describe('codegraph install --init / init --yes (#1578)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-init-'));
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function greet(name: string) { return hello(name); }\n` +
        `export function hello(n: string) { return 'hi ' + n; }\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('install --yes --target none --init builds the current project\'s index in one command', () => {
    const r = runCodegraph(['install', '--yes', '--target', 'none', '--init'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // The installer ran (and had nothing to wire) …
    expect(r.stdout).toContain('No agent targets selected');
    // … and the init ran afterwards, in cwd.
    expect(r.stdout).toContain(`Initialized in ${fs.realpathSync(tempDir)}`);
    expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(true);
  });

  it('install --init on an already-initialized project reports that and still exits 0', () => {
    expect(runCodegraph(['init', '--yes'], tempDir).status).toBe(0);
    const r = runCodegraph(['install', '--yes', '--target', 'none', '--init'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Already initialized');
  });

  it('install --init refuses an unsafe root (filesystem root) with exit code 1, like init does', () => {
    // `/` (or the drive root on Windows) is the canonical unsafe root: the
    // refusal fires before anything is created, so nothing is written there.
    const root = path.parse(process.cwd()).root;
    const r = runCodegraph(['install', '--yes', '--target', 'none', '--init'], root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Refusing to initialize');
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });

  it('init --yes runs non-interactively with stdin closed and builds the index', () => {
    const r = runCodegraph(['init', '--yes'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Initialized in');
    expect(fs.existsSync(path.join(tempDir, '.codegraph', 'codegraph.db'))).toBe(true);
  });

  it('documents the new flags in --help', () => {
    expect(runCodegraph(['init', '--help'], tempDir).stdout).toMatch(/-y, --yes\b/);
    expect(runCodegraph(['install', '--help'], tempDir).stdout).toMatch(/-i, --init\b/);
  });
});

/**
 * A first index that stops partway (killed, out of memory, an error while
 * resolving) leaves `.codegraph/` behind, so a second `init` used to answer
 * "Already initialized" and point at `sync`, as if the setup worked (#3228).
 * It now says how the last run ended, with the words `status` uses, and tells
 * an interrupted run from one another process is running right now.
 */
describe('codegraph init on an index whose last run did not finish (#3228)', () => {
  let tempDir: string;
  const USUAL_HINT = 'Use "codegraph index" to re-index or "codegraph sync" to update';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-init-unfinished-'));
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
    expect(runCodegraph(['init', '--yes'], tempDir).status).toBe(0);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** The marker a run leaves in the index when it dies or ends badly. */
  function setIndexState(state: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      db.prepare(
        "INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', ?, 0) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(state);
    } finally {
      db.close();
    }
  }

  it.each([
    ['indexing', 'The last index run never finished'],
    ['partial', 'The last index run silently dropped files'],
    ['failed', 'The last index run failed'],
  ])('says an index left %s is incomplete, and how to rebuild it', (state, words) => {
    setIndexState(state);
    for (const args of [['init', '--yes'], ['install', '--yes', '--target', 'none', '--init']]) {
      const r = runCodegraph(args, tempDir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('its index is incomplete');
      expect(r.stdout).toContain(words);
      expect(r.stdout).toContain('Re-run "codegraph index"');
      expect(r.stdout).not.toContain('Already initialized');
      expect(r.stdout).not.toContain(USUAL_HINT);
    }
  });

  it('keeps the usual answer for a complete index', () => {
    const r = runCodegraph(['init', '--yes'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Already initialized');
    expect(r.stdout).toContain(USUAL_HINT);
    expect(r.stdout).not.toContain('incomplete');
  });

  it('tells a rebuild running in another process from a run that died', () => {
    // What `codegraph index` holds while it rebuilds: its `indexing` marker and
    // the rebuild lock, here naming this (live) test process.
    setIndexState('indexing');
    const lock = JSON.stringify({ pid: process.pid, mode: 'rebuild', startedAt: Date.now(), ready: false });
    fs.writeFileSync(path.join(tempDir, '.codegraph', 'rebuild.pid'), lock);
    const r = runCodegraph(['init', '--yes'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Already initialized');
    expect(r.stdout).toContain('An index rebuild ("codegraph index") is running in another process');
    expect(r.stdout).not.toContain('never finished');

    // The same lock left by a process that is gone is no rebuild.
    fs.writeFileSync(path.join(tempDir, '.codegraph', 'rebuild.pid'), JSON.stringify({ pid: 2_147_483_000, mode: 'rebuild', startedAt: 0, ready: false }));
    const dead = runCodegraph(['init', '--yes'], tempDir);
    expect(dead.stdout).toContain('The last index run never finished');
  });
});
