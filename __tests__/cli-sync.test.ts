import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph sync reporting', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-sync-'));
    fs.writeFileSync(path.join(testDir, 'index.ts'), 'export function original() { return target(); }\nexport function target() { return 1; }');
    const cg = CodeGraph.initSync(testDir);
    try {
      await cg.indexAll();
    } finally {
      cg.destroy();
    }
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function sync(quiet: boolean) {
    return spawnSync(process.execPath, [BIN, 'sync', testDir, ...(quiet ? ['--quiet'] : [])], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
        CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_NO_DAEMON: '1',
        NODE_NO_WARNINGS: '1', NO_COLOR: '1',
      },
    });
  }

  it.each([false, true])('reports pending-reference recovery (quiet=%s)', (quiet) => {
    for (const resolvable of [true, false]) {
      const cg = CodeGraph.openSync(testDir);
      try {
        const queries = (cg as unknown as { queries: import('../src/db/queries').QueryBuilder }).queries;
        const caller = cg.searchNodes('original').find(r => r.node.name === 'original')!.node;
        const target = cg.searchNodes('target').find(r => r.node.name === 'target')!.node;
        queries.db.prepare("DELETE FROM edges WHERE source = ? AND target = ? AND kind = 'calls'")
          .run(caller.id, target.id);
        queries.insertUnresolvedRef({
          fromNodeId: caller.id, referenceName: resolvable ? 'target' : 'missingTarget',
          referenceKind: 'calls', line: 1, column: 37, filePath: 'index.ts', language: 'typescript',
        });
      } finally {
        cg.destroy();
      }
      const recovered = sync(quiet);
      expect(recovered.error).toBeUndefined();
      expect(recovered.status).toBe(0);
      if (quiet) expect(recovered.stdout + recovered.stderr).toBe('');
      else {
        expect(recovered.stdout).not.toContain('Already up to date');
        expect(recovered.stdout).toContain(`Resolved ${resolvable ? 1 : 0} pending references`);
        if (!resolvable) expect(recovered.stdout).toContain('1 unresolved');
      }
      const unchanged = sync(quiet);
      expect(unchanged.status).toBe(0);
      if (quiet) expect(unchanged.stdout + unchanged.stderr).toBe('');
      else expect(unchanged.stdout).toContain('Already up to date');
    }
  });

  it.each([false, true])('reports contention and recovers after release (quiet=%s)', (quiet) => {
    fs.writeFileSync(path.join(testDir, 'index.ts'), 'export function changedUnderLock() { return 2; }');
    const lockPath = path.join(testDir, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lockPath, String(process.pid));

    const locked = sync(quiet);
    expect(locked.error).toBeUndefined();
    expect(locked.status).toBe(1);
    expect(locked.stdout + locked.stderr).not.toContain('Already up to date');
    if (quiet) {
      expect(locked.stdout + locked.stderr).toBe('');
    } else {
      expect(locked.stdout + locked.stderr).toMatch(/busy|lock/i);
      expect(locked.stdout + locked.stderr).toMatch(/retry/i);
    }
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    const before = CodeGraph.openSync(testDir);
    try {
      expect(before.searchNodes('changedUnderLock')).toHaveLength(0);
    } finally {
      before.destroy();
    }

    fs.unlinkSync(lockPath);
    const unlocked = sync(quiet);
    expect(unlocked.error).toBeUndefined();
    expect(unlocked.status).toBe(0);
    const after = CodeGraph.openSync(testDir);
    try {
      expect(after.searchNodes('changedUnderLock')).toHaveLength(1);
    } finally {
      after.destroy();
    }

    const unchanged = sync(quiet);
    expect(unchanged.status).toBe(0);
    if (quiet) expect(unchanged.stdout + unchanged.stderr).toBe('');
    else expect(unchanged.stdout).toContain('Already up to date');
  });
});
