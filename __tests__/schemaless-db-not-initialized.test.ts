/**
 * A schema-less `codegraph.db` does not make a project initialized (#1895).
 *
 * `isInitialized()` used to accept any existing `.codegraph/codegraph.db`, so
 * an empty or table-less file in an ANCESTOR directory (an interrupted `init`,
 * a stray `touch`, a never-populated `$HOME/.codegraph/`) captured the upward
 * resolution of every project beneath it: the CLI and the MCP server operated
 * on the broken file instead of the project's own index, or instead of the
 * "not initialized" guidance. An initialized project is now one whose db
 * carries the codegraph schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite');
import { CodeGraph } from '../src';
import { isInitialized, findNearestCodeGraphRoot, resolveServerRoot, planFrontload } from '../src/directory';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** A `.codegraph/codegraph.db` that exists but is not a codegraph index. */
function plantBrokenDb(dir: string, kind: 'empty' | 'no-tables' | 'garbage'): string {
  const cgDir = path.join(dir, '.codegraph');
  fs.mkdirSync(cgDir, { recursive: true });
  const dbPath = path.join(cgDir, 'codegraph.db');
  if (kind === 'empty') {
    fs.writeFileSync(dbPath, '');
  } else if (kind === 'garbage') {
    fs.writeFileSync(dbPath, 'x'.repeat(4096));
  } else {
    // A valid SQLite file with zero tables — what an interrupted init leaves.
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t(x); DROP TABLE t;');
    db.close();
  }
  return dbPath;
}

async function indexProject(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), 'def alpha(x):\n    return beta(x) + 1\n\ndef beta(x):\n    return x * 2\n');
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close();
}

describe('a schema-less codegraph.db is not an initialized project (#1895)', () => {
  let tmp: string;
  let parent: string;
  let child: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1895-')));
    parent = path.join(tmp, 'parent');
    child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['empty', 'no-tables', 'garbage'] as const)('isInitialized() rejects a %s codegraph.db', (kind) => {
    plantBrokenDb(parent, kind);
    expect(isInitialized(parent)).toBe(false);
    expect(findNearestCodeGraphRoot(child)).toBeNull();
    expect(resolveServerRoot(child).root).toBeNull();
    expect(planFrontload(child, 'how does alpha call beta').exploreRoot).toBeNull();
  });

  // Root ignores mode bits and Windows has no chmod-based directory permissions.
  const canDenyWrite = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.runIf(canDenyWrite)('fails OPEN: a WAL db in a directory we cannot open read-only is still initialized', async () => {
    // SQLite needs to create `-shm` to open a WAL database; with the directory
    // non-writable the read-only open throws. That is a database we cannot
    // inspect, not a schema-less one — it must keep resolving (#1913 review).
    await indexProject(parent);
    const src = path.join(parent, '.codegraph', 'codegraph.db');
    const other = path.join(tmp, 'other');
    fs.mkdirSync(path.join(other, '.codegraph'), { recursive: true });
    fs.copyFileSync(src, path.join(other, '.codegraph', 'codegraph.db'));
    const dir = path.join(other, '.codegraph');
    fs.chmodSync(dir, 0o555);
    try {
      expect(isInitialized(other)).toBe(true);
      expect(findNearestCodeGraphRoot(path.join(other, 'sub'))).toBe(other);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('a real index still resolves upward from a subdirectory', async () => {
    await indexProject(parent);
    expect(isInitialized(parent)).toBe(true);
    expect(findNearestCodeGraphRoot(child)).toBe(parent);
    const r = run(child, ['status']);
    expect(r.status).toBe(0);
    expect(r.out).toContain(parent);
  });

  it('the cache follows the file: a db that gains its schema flips to initialized', async () => {
    plantBrokenDb(parent, 'no-tables');
    expect(isInitialized(parent)).toBe(false);
    await indexProject(parent); // repairs the file in place
    expect(isInitialized(parent)).toBe(true);
  });

  it('(a) an empty db in the parent does not hijack the initialized child', async () => {
    plantBrokenDb(parent, 'empty');
    await indexProject(child);
    expect(findNearestCodeGraphRoot(child)).toBe(child);
    expect(resolveServerRoot(child).root).toBe(child);

    const status = run(child, ['status']);
    expect(status.status).toBe(0);
    expect(status.out).toContain(child);
    expect(status.out).not.toMatch(/SQLITE_|not a database|no such table/i);

    const explore = run(child, ['explore', 'alpha']);
    expect(explore.status).toBe(0);
    expect(explore.out).toContain('alpha');
  });

  it('(a) a workspace container adopts its indexed sub-project even under a schema-less ancestor', async () => {
    // The issue's exact reproduction: ws/ has .git and no index, ws/sub is
    // indexed, and an ancestor of ws carries a zero-table db.
    plantBrokenDb(tmp, 'no-tables');
    const ws = path.join(tmp, 'ws');
    const sub = path.join(ws, 'sub');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    await indexProject(sub);
    fs.writeFileSync(path.join(sub, 'pyproject.toml'), '[project]\nname = "sub"\nversion = "0.1"\n');
    const res = resolveServerRoot(ws);
    expect(res.root).toBe(sub);
    expect(res.viaSubScan).toBe(true);
  });

  it('(b) CLI: parent with a schema-less db, child not initialized → not-initialized guidance, never a SQLite error', () => {
    plantBrokenDb(parent, 'no-tables');
    const r = run(child, ['status']);
    expect(r.out).toMatch(/not initialized/i);
    expect(r.out).toContain('codegraph init');
    expect(r.out).not.toMatch(/SQLITE_|not a database|no such table/i);
  });

  it('(b) MCP: the handler returns success-shaped not-indexed guidance for the child', async () => {
    plantBrokenDb(parent, 'no-tables');
    const handler = new ToolHandler(null);
    const res = await handler.execute('codegraph_explore', { query: 'alpha', projectPath: child });
    expect(res.isError).toBeUndefined();
    const text = res.content.map((c: any) => c.text ?? '').join('\n');
    expect(text).toMatch(/isn't indexed|codegraph init/i);
    expect(text).not.toMatch(/SQLITE_|not a database|no such table/i);
  });

  it('(d) codegraph init in the directory with the broken file repairs it', () => {
    const dbPath = plantBrokenDb(parent, 'no-tables');
    fs.writeFileSync(path.join(parent, 'a.py'), 'def alpha():\n    return 1\n');
    const r = run(parent, ['init', '--yes']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('without the codegraph schema');
    expect(r.out).not.toContain('Already initialized');
    expect(isInitialized(parent)).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get() as { c: number };
    db.close();
    expect(row.c).toBe(1);
  });

  it('(d) an empty file is repaired too; a file that is not SQLite is refused with guidance and left alone', () => {
    plantBrokenDb(parent, 'empty');
    fs.writeFileSync(path.join(parent, 'a.py'), 'def alpha():\n    return 1\n');
    const empty = run(parent, ['init', '--yes']);
    expect(empty.status).toBe(0);
    expect(empty.out).toContain('without the codegraph schema');
    expect(isInitialized(parent)).toBe(true);

    for (const bytes of ['x'.repeat(4096), 'hello']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1895-foreign-'));
      try {
        const cgDir = path.join(dir, '.codegraph');
        fs.mkdirSync(cgDir);
        const dbPath = path.join(cgDir, 'codegraph.db');
        fs.writeFileSync(dbPath, bytes);
        fs.writeFileSync(path.join(dir, 'a.py'), 'def alpha():\n    return 1\n');
        const r = run(dir, ['init', '--yes']);
        expect(r.status).toBe(1);
        expect(r.out).toContain('is not a SQLite database');
        expect(r.out).not.toContain('rebuilding');
        expect(r.out).not.toContain('file is not a database');
        // Nothing is deleted or rewritten behind the user's back.
        expect(fs.readFileSync(dbPath, 'utf-8')).toBe(bytes);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
