import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    // NODE_NO_WARNINGS: skipping the relaunch also skips its
    // --disable-warning=ExperimentalWarning, and Node 22 then prints the
    // node:sqlite warning to stderr, which the quiet case counts line by line.
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1', NODE_NO_WARNINGS: '1' },
  });
}

const lockPath = () => path.join(root, '.codegraph', 'codegraph.lock');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-locked-'));
  fs.writeFileSync(path.join(root, 'original.ts'), 'export function original() { return 1; }\n');
  const cg = CodeGraph.initSync(root);
  try { await cg.indexAll(); } finally { cg.close(); }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('codegraph sync while another process holds the index lock', () => {
  it('sync() reports the lock instead of all-zero success counts', async () => {
    // The test process itself is the live holder — the same thing FileLock.acquire writes.
    fs.writeFileSync(lockPath(), String(process.pid));
    const cg = CodeGraph.openSync(root);
    try {
      const result = await cg.sync();
      expect(result.skippedReason).toBe('locked');
      expect(result.lockHolderPid).toBe(process.pid);
      expect(result.filesChecked).toBe(0);
    } finally { cg.close(); }
  });

  it.each([false, true])('CLI exits 1 with the reason on stderr, quiet=%s', (quiet) => {
    fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
    fs.writeFileSync(lockPath(), String(process.pid));

    const result = run('sync', ...(quiet ? ['--quiet'] : []));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another process holds the index lock');
    expect(result.stderr).toContain(`PID ${process.pid}`);
    expect(result.stderr).toContain('codegraph sync');
    expect(result.stdout + result.stderr).not.toContain('Already up to date');
    if (quiet) {
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
    }

    // Nothing was synced and the foreign lock was left alone.
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(String(process.pid));
    const cg = CodeGraph.openSync(root);
    try { expect(cg.getStats().fileCount).toBe(1); } finally { cg.close(); }
  });

  it.each([false, true])('syncs normally once the lock is released, quiet=%s', (quiet) => {
    fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
    const result = run('sync', ...(quiet ? ['--quiet'] : []));
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('index lock');
    const cg = CodeGraph.openSync(root);
    try { expect(cg.getStats().fileCount).toBe(2); } finally { cg.close(); }
  });
});
