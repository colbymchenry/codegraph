/**
 * A full sync reads the package manifests again to see a workspace edit
 * (#2456, #2502), and finding them took a walk of the whole tree: on django,
 * 3,251 folders for one `package.json`, every sync. In a git repository the
 * sync's own scan already lists every file the walk could find except what git
 * ignores, so a sync where git lists the same manifests as at the last walk,
 * and the folders it ignores hold the same ones, reads them where they are,
 * each one again. These tests hold every case the walk exists for: a manifest
 * edited, added, removed or moved, one in an ignored folder, a path
 * dependency's folder or a `pnpm-workspace.yaml` appearing, a checkout, and
 * the projects git can't vouch for (no git, an embedded repository, a tree
 * near the walk's folder budget).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodeGraph } from '../src';
import { countWalkedFolders, loadWorkspacePackages, workspaceFingerprint } from '../src/resolution/workspace-packages';

// A copy of `fs` whose functions can be spied on (an ES module namespace can't be).
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function write(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    if (content === null) {
      fs.rmSync(file, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

/** The issue's layout plus 80 folders of filler, so the walk is worth skipping. */
function project(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'repo', private: true }),
    'packages/common/package.json': JSON.stringify({ name: 'acme-shared' }),
    'packages/common/utils.ts': 'export function formatLabel(name: string): string { return name; }\n',
    'packages/api/package.json': JSON.stringify({ name: 'acme-api', dependencies: { 'acme-shared': 'file:../common' } }),
    'packages/api/handler.ts': "import { formatLabel } from 'acme-shared/utils';\nexport const h = (n: string) => formatLabel(n);\n",
    'apps/web/web.ts': "import { formatLabel } from 'acme-shared/utils';\nexport const w = (n: string) => formatLabel(n);\n",
    ...extra,
  };
  for (let i = 0; i < 80; i++) files[`filler/f${i}/mod${i}.ts`] = `export function filler${i}(): number { return ${i}; }\n`;
  return files;
}

/**
 * Index `files` in a new folder: a git repository with them committed unless
 * `git` is false. `before` runs first, on the written folder.
 */
async function index(files: Record<string, string>, opts: { git?: boolean; before?: (root: string) => void } = {}): Promise<{ graph: CodeGraph; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-walk-'));
  roots.push(root);
  write(root, files);
  opts.before?.(root);
  if (opts.git !== false) {
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return { graph, root };
}

/**
 * Sync, and say whether the manifest walk ran: whether any folder was read
 * from inside it (named `collectPathDeps` before the walk had its own name).
 */
async function syncWalked(graph: CodeGraph): Promise<boolean> {
  const original = fs.readdirSync.bind(fs) as (...args: unknown[]) => unknown;
  let walked = false;
  const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 64;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = limit;
    if (/\b(?:discoverManifests|collectPathDeps)\b/.test(stack)) walked = true;
    return original(...args);
  }) as unknown as typeof fs.readdirSync);
  try {
    await graph.sync();
  } finally {
    spy.mockRestore();
  }
  return walked;
}

/** The files `file`'s import statements link it to. */
function moduleImports(graph: CodeGraph, file: string): string[] {
  const out = new Set<string>();
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'imports') continue;
      const target = graph.getNode(e.target)!;
      if (target.kind === 'file') out.add(target.filePath);
    }
  }
  return [...out].sort();
}

/** The workspace digest the synced index holds, and the one a fresh walk of the tree gives now. */
function fingerprints(graph: CodeGraph, root: string): { synced: string | null; fresh: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const synced = (graph as any).queries.getMetadata('js_workspace_fingerprint') as string | null;
  return { synced, fresh: workspaceFingerprint(loadWorkspacePackages(root)) };
}

describe('a full sync finds the package manifests without walking when git shows none came or went', () => {
  it('reads them where the last walk found them when nothing changed', async () => {
    const { graph, root } = await index(project());
    expect(await syncWalked(graph)).toBe(false);
    expect(await syncWalked(graph)).toBe(false);
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual(['packages/common/utils.ts']);
    const { synced, fresh } = fingerprints(graph, root);
    expect(synced).toBe(fresh);
  }, 120_000);

  it('still sees an edit to a manifest it knows, without walking', async () => {
    const { graph, root } = await index(project({ 'apps/web/package.json': JSON.stringify({ name: 'web' }) }));
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual([]);
    write(root, { 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'acme-shared': 'file:../../packages/common' } }) });
    expect(await syncWalked(graph)).toBe(false);
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual(['packages/common/utils.ts']);
    const { synced, fresh } = fingerprints(graph, root);
    expect(synced).toBe(fresh);
  }, 120_000);

  it("still sees a path dependency's folder appear, and a pnpm-workspace.yaml beside a manifest it knows", async () => {
    const { graph, root } = await index(project({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'acme-local': 'file:./local' } }),
      'apps/web/local-user.ts': "import { localFn } from 'acme-local/fn';\nexport const u = () => localFn();\n",
      'tools/package.json': JSON.stringify({ name: 'tools' }),
    }));
    expect(moduleImports(graph, 'apps/web/local-user.ts')).toEqual([]);
    write(root, {
      'apps/web/local/fn.ts': 'export function localFn(): number { return 1; }\n',
      'tools/pnpm-workspace.yaml': 'packages:\n  - "x/*"\n',
    });
    expect(await syncWalked(graph)).toBe(false);
    expect(moduleImports(graph, 'apps/web/local-user.ts')).toEqual(['apps/web/local/fn.ts']);
    const { synced, fresh } = fingerprints(graph, root);
    expect(synced).toBe(fresh);
  }, 120_000);
});

describe('a full sync walks again when git shows a manifest came, went or moved', () => {
  it('walks for a manifest git lists that the last walk did not find', async () => {
    const { graph, root } = await index(project());
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual([]);
    write(root, { 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'acme-shared': 'file:../../packages/common' } }) });
    expect(await syncWalked(graph)).toBe(true);
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual(['packages/common/utils.ts']);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
    // And reads them where they are again once the walk is recorded.
    expect(await syncWalked(graph)).toBe(false);
  }, 120_000);

  it('walks for a manifest deleted from disk, though git still tracks it', async () => {
    const { graph, root } = await index(project());
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual(['packages/common/utils.ts']);
    write(root, { 'packages/api/package.json': null });
    expect(await syncWalked(graph)).toBe(true);
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual([]);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
  }, 120_000);

  it('walks for a manifest that moved to another folder', async () => {
    const { graph, root } = await index(project());
    const manifest = fs.readFileSync(path.join(root, 'packages/api/package.json'), 'utf8');
    write(root, { 'packages/api/package.json': null, 'apps/web/package.json': manifest.replace('../common', '../../packages/common') });
    expect(await syncWalked(graph)).toBe(true);
    expect(moduleImports(graph, 'packages/api/handler.ts')).toEqual([]);
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual(['packages/common/utils.ts']);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
  }, 120_000);

  it('walks after a checkout brings a manifest in or takes it away', async () => {
    const { graph, root } = await index(project());
    git(root, 'checkout', '-q', '-b', 'web');
    write(root, { 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'acme-shared': 'file:../../packages/common' } }) });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'web package');
    expect(await syncWalked(graph)).toBe(true);
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual(['packages/common/utils.ts']);
    git(root, 'checkout', '-q', '-');
    expect(await syncWalked(graph)).toBe(true);
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual([]);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
  }, 120_000);

  it('walks for a manifest in a folder git ignores, and reads it where it is after that', async () => {
    const { graph, root } = await index(project({ '.gitignore': 'generated/\n', 'generated/notes.txt': 'x\n' }));
    const before = fingerprints(graph, root).synced;
    // A nested workspace root: the fingerprint names it.
    write(root, { 'generated/pkgs/package.json': JSON.stringify({ name: 'gen', workspaces: ['x/*'] }) });
    expect(await syncWalked(graph)).toBe(true);
    const after = fingerprints(graph, root);
    expect(after.synced).toBe(after.fresh);
    expect(after.synced).not.toBe(before);
    expect(await syncWalked(graph)).toBe(false);
    // One more inside the same ignored folder.
    write(root, { 'generated/more/package.json': JSON.stringify({ name: 'more', workspaces: ['y/*'] }) });
    expect(await syncWalked(graph)).toBe(true);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
  }, 120_000);
});

describe('a full sync always walks where git cannot vouch for the tree', () => {
  it('in a folder that is not a git repository', async () => {
    const { graph, root } = await index(project(), { git: false });
    expect(await syncWalked(graph)).toBe(true);
    write(root, { 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { 'acme-shared': 'file:../../packages/common' } }) });
    expect(await syncWalked(graph)).toBe(true);
    expect(moduleImports(graph, 'apps/web/web.ts')).toEqual(['packages/common/utils.ts']);
  }, 120_000);

  it('in a repository holding an embedded one, whose ignored files it never lists', async () => {
    const { graph, root } = await index(project({ 'vendor-repo/lib.ts': 'export const v = 1;\n', 'vendor-repo/.gitignore': 'gen/\n' }), {
      before: (dir) => {
        const inner = path.join(dir, 'vendor-repo');
        git(inner, 'init', '-q');
        git(inner, 'add', '-A');
        git(inner, 'commit', '-q', '-m', 'vendored');
      },
    });
    expect(await syncWalked(graph)).toBe(true);
    write(root, { 'vendor-repo/gen/pkg/package.json': JSON.stringify({ name: 'v', workspaces: ['z/*'] }) });
    expect(await syncWalked(graph)).toBe(true);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
  }, 120_000);

  it('once the folders git ignores could take a walk past half its folder budget', async () => {
    const { graph, root } = await index(project({ '.gitignore': 'generated/\n', 'generated/notes.txt': 'x\n' }));
    expect(await syncWalked(graph)).toBe(false);
    for (let i = 0; i < 4_000; i++) fs.mkdirSync(path.join(root, 'generated', `g${i}`), { recursive: true });
    expect(await syncWalked(graph)).toBe(true);
    expect(fingerprints(graph, root).synced).toBe(fingerprints(graph, root).fresh);
  }, 120_000);

  it("in a tree past half the walk's folder budget, since folders git cannot see count toward it", async () => {
    const { graph } = await index(project(), {
      before: (dir) => { for (let i = 0; i < 4_000; i++) fs.mkdirSync(path.join(dir, 'empty', `e${i}`), { recursive: true }); },
    });
    expect(await syncWalked(graph)).toBe(true);
    expect(await syncWalked(graph)).toBe(true);
  }, 120_000);
});

describe('countWalkedFolders', () => {
  it('counts each folder the walk enters once in git order, and never fewer out of order', () => {
    const sorted = ['.github/w.yml', 'a/b/c.ts', 'a/b/d.ts', 'a/e.ts', 'f/g/h/i.ts', 'node_modules/x/y.js', 'top.ts'];
    // root, a, a/b, f, f/g, f/g/h
    expect(countWalkedFolders(sorted)).toBe(6);
    expect(countWalkedFolders([...sorted].reverse())).toBeGreaterThanOrEqual(6);
    // Seven levels down: the walk stops at six.
    expect(countWalkedFolders(['1/2/3/4/5/6/7/8.ts'])).toBe(7);
  });
});
