import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const { DatabaseSync } = require('node:sqlite');
let root: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-stale-'));
  fs.writeFileSync(path.join(root, 'original.ts'), 'export function original() { return 1; }\n');
  const cg = CodeGraph.initSync(root);
  try { await cg.indexAll(); } finally { cg.close(); }
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('explicit CLI sync with stale extraction', () => {
  for (const stamp of [EXTRACTION_VERSION - 1, null]) {
    for (const quiet of [false, true]) {
      it(`rejects stamp ${stamp} before syncing, quiet=${quiet}`, () => {
        setStamp(stamp);
        const args = quiet ? ['sync', '--quiet'] : ['sync'];
        for (const changed of [false, true]) {
          if (changed) fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
          const result = run(...args);
          expect(result.status).toBe(1);
          const output = result.stdout + result.stderr;
          expect(output).toContain('Run "codegraph index"');
          expect(output).not.toContain('Already up to date');
          if (quiet) {
            // One explanatory line on stderr, nothing on stdout, so a hook that
            // fails the commit on exit 1 still shows the user why. (#1798)
            expect(result.stdout).toBe('');
            expect(result.stderr.trim().split('\n')).toHaveLength(1);
          }
          const cg = CodeGraph.openSync(root);
          try {
            expect(cg.isIndexStale()).toBe(true);
            expect(cg.getStats().fileCount).toBe(1);
          } finally { cg.close(); }
        }
      });
    }
  }

  it.each([false, true])('still syncs a current index, quiet=%s', (quiet) => {
    fs.writeFileSync(path.join(root, 'added.ts'), 'export const added = 2;\n');
    expect(run('sync', ...(quiet ? ['--quiet'] : [])).status).toBe(0);
    const cg = CodeGraph.openSync(root);
    try {
      expect(cg.isIndexStale()).toBe(false);
      expect(cg.getStats().fileCount).toBe(2);
    } finally { cg.close(); }
  });

  it('accepts sync after the prescribed full rebuild', () => {
    setStamp(EXTRACTION_VERSION - 1);
    expect(run('sync').status).toBe(1);
    expect(run('index').status).toBe(0);
    expect(run('sync').status).toBe(0);
  });
});
