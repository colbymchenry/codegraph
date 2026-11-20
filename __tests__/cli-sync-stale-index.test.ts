import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const { DatabaseSync } = require('node:sqlite');
const WARNING = 'Run "codegraph index" for a full rebuild';
let root: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
  });
}

function setStamp(stamp: number | null) {
  const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'));
  try {
    if (stamp === null) {
      db.prepare('DELETE FROM project_metadata WHERE key = ?').run('indexed_with_extraction_version');
    } else {
      db.prepare('UPDATE project_metadata SET value = ? WHERE key = ?')
        .run(String(stamp), 'indexed_with_extraction_version');
    }
  } finally {
    db.close();
  }
}

function indexState() {
  const cg = CodeGraph.openSync(root);
  try {
    return { stale: cg.isIndexStale(), files: cg.getStats().fileCount };
  } finally { cg.close(); }
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-stale-'));
  fs.writeFileSync(path.join(root, 'original.ts'), 'export function original() { return 1; }\n');
  const cg = CodeGraph.initSync(root);
  try { await cg.indexAll(); } finally { cg.close(); }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('explicit CLI sync with stale extraction', () => {
  for (const stamp of [EXTRACTION_VERSION - 1, null]) {
    it(`warns for stamp ${stamp} and still syncs`, () => {
      setStamp(stamp);

      const unchanged = run('sync');
      expect(unchanged.status).toBe(0);
      expect(unchanged.stdout).toContain(WARNING);
      expect(unchanged.stdout).toContain('No files changed');
      expect(unchanged.stdout).not.toContain('Already up to date');
      expect(unchanged.stdout).not.toContain('codegraph sync');

      // The git hooks depend on this half: the changed file goes in.
      fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
      const changed = run('sync');
      expect(changed.status).toBe(0);
      expect(changed.stdout).toContain('Synced 1 changed files');
      expect(changed.stdout).toContain(WARNING);
      // A sync can't stand in for the rebuild, so the warning keeps coming.
      expect(indexState()).toEqual({ stale: true, files: 2 });
    }, 60_000);

    it(`stays silent and still syncs for stamp ${stamp} under --quiet`, () => {
      setStamp(stamp);
      fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
      const result = run('sync', '--quiet');
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toBe('');
      expect(indexState()).toEqual({ stale: true, files: 2 });
    }, 60_000);
  }

  it('does not warn about a current index', () => {
    fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
    const changed = run('sync');
    expect(changed.status).toBe(0);
    expect(changed.stdout).not.toContain(WARNING);
    expect(indexState()).toEqual({ stale: false, files: 2 });

    const unchanged = run('sync');
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).toContain('Already up to date');
    expect(unchanged.stdout).not.toContain(WARNING);
  }, 60_000);

  it('stops warning after the full rebuild it names', () => {
    setStamp(EXTRACTION_VERSION - 1);
    expect(run('sync').stdout).toContain(WARNING);
    expect(run('index').status).toBe(0);
    const after = run('sync');
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('Already up to date');
    expect(after.stdout).not.toContain(WARNING);
  }, 60_000);
});
