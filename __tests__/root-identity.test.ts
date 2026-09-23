/**
 * One index, two spellings (#1057).
 *
 * The MCP server caches its open-DB connections by resolved-root PATH STRING, so
 * two spellings of one physical repo — a symlinked checkout, or a case-variant
 * on a case-insensitive mount (macOS, NTFS, WSL DrvFs `/mnt/c`) — each opened a
 * SEPARATE connection to the same `.codegraph/codegraph.db`. The cache stays
 * path-keyed (a same-path recreate must still heal in place, #925); a miss now
 * checks whether an open root is the same index as the new spelling, compared
 * as it is on disk NOW, and files the spelling as an alias of that connection.
 *
 * The symlink case is the deterministic, filesystem-agnostic stand-in for the
 * case-insensitive-mount scenario: both give two path strings for one inode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCodeGraphDir, isSameIndexRoot, statInode } from '../src/directory';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';

const posixOnly = it.runIf(process.platform !== 'win32');
const windowsOnly = it.runIf(process.platform === 'win32');

describe('isSameIndexRoot (#1057)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rootid-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeProject(name: string): string {
    const proj = path.join(tmp, name);
    fs.mkdirSync(path.join(proj, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.codegraph', 'codegraph.db'), 'x');
    return proj;
  }

  it('treats a directory and a symlink that points at it as one index', () => {
    const real = makeProject('proj');
    const link = path.join(tmp, 'projLink');
    fs.symlinkSync(real, link, 'junction');

    expect(path.resolve(real)).not.toBe(path.resolve(link));
    expect(isSameIndexRoot(link, real)).toBe(true);
  });

  it('keeps distinct projects apart', () => {
    expect(isSameIndexRoot(makeProject('a'), makeProject('b'))).toBe(false);
  });

  it('never matches a root that is gone', () => {
    const real = makeProject('proj');
    const gone = path.join(tmp, 'does-not-exist');
    expect(isSameIndexRoot(gone, real)).toBe(false);
    expect(isSameIndexRoot(real, gone)).toBe(false);
  });

  posixOnly('never matches a deleted root, even when its inode is handed to a new one', () => {
    // Inode reuse after delete is filesystem-dependent, so force the worst case
    // by comparing against what the old root WAS: once it is gone it no longer
    // stats, so no later directory can claim its identity.
    const old = makeProject('old');
    const oldId = statInode(getCodeGraphDir(old));
    fs.rmSync(old, { recursive: true, force: true });
    const fresh = makeProject('fresh');

    expect(oldId).not.toBeNull();
    expect(isSameIndexRoot(old, fresh)).toBe(false);
  });

  posixOnly('reads inodes exactly, as bigints', () => {
    const id = statInode(makeProject('proj'));
    expect(id).toMatch(/^\d+:\d+$/);
    const s = fs.statSync(path.join(tmp, 'proj'), { bigint: true });
    expect(id).toBe(`${s.dev}:${s.ino}`);
  });

  windowsOnly('has no inode on Windows, and compares case-folded real paths instead', () => {
    const real = makeProject('Proj');
    expect(statInode(real)).toBeNull();
    expect(isSameIndexRoot(real, real.toLowerCase())).toBe(true);
  });
});

describe('ToolHandler connection cache (#1057)', () => {
  let tmp: string;
  let handler: ToolHandler;
  const graphs: CodeGraph[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rootcache-'));
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(null);
  });
  afterEach(() => {
    handler.closeAll();
    __setLoadCodeGraphForTests(null);
    for (const cg of graphs.splice(0)) {
      try { cg.close(); } catch { /* already closed */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function makeIndexed(name: string): Promise<string> {
    const proj = path.join(tmp, name);
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    const cg = CodeGraph.initSync(proj);
    await cg.indexAll();
    cg.close();
    return proj;
  }

  function open(p: string): CodeGraph {
    return (handler as unknown as { getCodeGraph(p: string): CodeGraph }).getCodeGraph(p);
  }

  it('serves a symlinked spelling from the connection already open', async () => {
    const real = await makeIndexed('proj');
    const link = path.join(tmp, 'projLink');
    fs.symlinkSync(real, link, 'junction');

    const first = open(real);
    expect(open(link)).toBe(first);
    // And the alias is remembered: the same spelling is a direct cache hit.
    expect(open(link)).toBe(first);
  });

  it('shares the default instance with another spelling of its root', async () => {
    const real = await makeIndexed('proj');
    const link = path.join(tmp, 'projLink');
    fs.symlinkSync(real, link, 'junction');

    const def = CodeGraph.openSync(real);
    graphs.push(def);
    handler = new ToolHandler(def);
    expect(open(link)).toBe(def);
  });

  it('opens distinct projects on distinct connections', async () => {
    const a = await makeIndexed('a');
    const b = await makeIndexed('b');
    expect(open(a)).not.toBe(open(b));
  });

  it('closes an aliased connection once', async () => {
    const real = await makeIndexed('proj');
    const link = path.join(tmp, 'projLink');
    fs.symlinkSync(real, link, 'junction');

    const cg = open(real);
    open(link);
    let closes = 0;
    const close = cg.close.bind(cg);
    cg.close = () => { closes++; close(); };
    handler.closeAll();
    expect(closes).toBe(1);
  });

  posixOnly('still heals a root recreated at the same path in place (#925)', async () => {
    const real = await makeIndexed('proj');
    const first = open(real);

    fs.rmSync(getCodeGraphDir(real), { recursive: true, force: true });
    const cg = CodeGraph.initSync(real);
    await cg.indexAll();
    cg.close();

    // Same path, same cached instance — reopened onto the new index, not a
    // second connection beside a leaked one.
    const again = open(real);
    expect(again).toBe(first);
    expect(again.searchNodes('a').length).toBeGreaterThan(0);
  });

  posixOnly('never hands a new root the connection of a deleted one', async () => {
    const old = await makeIndexed('old');
    const oldCg = open(old);
    fs.rmSync(old, { recursive: true, force: true });

    const fresh = await makeIndexed('fresh');
    expect(open(fresh)).not.toBe(oldCg);
  });
});
