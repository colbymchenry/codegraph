/**
 * `codegraph index <path>` rebuilds <path>, never an ancestor (#1524).
 *
 * The command used to resolve an uninitialized <path> upward to the nearest
 * initialized parent and rebuild THAT under a normal "Done" — so
 * `codegraph index child` from a monorepo re-indexed the whole container and
 * never said so. An explicit path that is not initialized is now an error that
 * names the ancestor it would have picked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('codegraph index <path> (#1524)', () => {
  let root: string;
  let parent: string;
  let child: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-path-'));
    parent = path.join(root, 'parent');
    child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(parent, 'p.py'), 'def parent_only():\n    return 1\n');
    fs.writeFileSync(path.join(child, 'c.py'), 'def child_only():\n    return 2\n');
    const cg = CodeGraph.initSync(parent);
    await cg.indexAll();
    cg.close();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses an explicit path that has no index of its own, naming the ancestor it would have rebuilt', () => {
    const before = fs.statSync(path.join(parent, '.codegraph', 'codegraph.db')).mtimeMs;
    const r = run(root, ['index', child, '--quiet']);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`not initialized in ${child}`);
    expect(r.out).toContain(parent);
    // The parent's index was not touched.
    expect(fs.statSync(path.join(parent, '.codegraph', 'codegraph.db')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(child, '.codegraph'))).toBe(false);
  });

  it('rebuilds the explicit path when it is initialized, and a bare `index` still resolves upward from a subdirectory', () => {
    expect(run(root, ['index', parent, '--quiet']).status).toBe(0);
    expect(run(child, ['index', '--quiet']).status).toBe(0);
  });
});
