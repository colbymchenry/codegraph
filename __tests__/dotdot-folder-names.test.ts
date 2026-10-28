/**
 * A folder whose name starts with two dots, like `..generated/`, is inside the
 * project.
 *
 * Several places asked whether a relative path leaves the root with
 * `rel.startsWith('..')`, which is also true of `..generated/client.ts`. So a
 * `paths` alias into such a folder linked nothing (`"@generated/*":
 * ["..generated/*"]`), the file watcher dropped every edit there, a gitignored
 * folder of that name could not be brought back with `include`, a `.gitignore`
 * rule for one was never applied when walking a folder that isn't a git
 * repository, and `deprioritize` never matched one. A path leaves the root
 * only through a `..` segment, or as an absolute path (another drive on
 * Windows).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { escapesRoot } from '../src/utils';
import { applyAliases, aliasAndBaseUrlCandidates, loadProjectAliases } from '../src/resolution/path-aliases';
import { scanDirectory } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';
import { FileWatcher, __emitWatchEventForTests } from '../src/sync/watcher';

let dirs: string[] = [];
let graphs: CodeGraph[] = [];
let watchers: FileWatcher[] = [];
afterEach(() => {
  for (const watcher of watchers) watcher.stop();
  for (const graph of graphs) graph.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  watchers = [];
  graphs = [];
  dirs = [];
  clearProjectConfigCache();
});

const project = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotdot-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
};

const gitCommitAll = (dir: string): void => {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir });
};

const CLIENT = 'export function makeClient(): number { return 1; }\n';

describe('escapesRoot', () => {
  it('leaves the root only through a `..` segment or an absolute path', () => {
    for (const rel of ['..', '../x', '..\\x', '../..']) expect(escapesRoot(rel), rel).toBe(true);
    expect(escapesRoot(path.resolve(os.tmpdir(), 'elsewhere'))).toBe(true);
    for (const rel of ['..generated', '..generated/client.ts', '..generated\\client.ts', 'src/..x/y.ts', '.hidden/z.ts', '']) {
      expect(escapesRoot(rel), rel).toBe(false);
    }
  });
});

describe('a path alias into a folder named like `..generated`', () => {
  it('maps into the folder, and still drops a target outside the project', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@generated/*': ['..generated/*', '../outside/*'] } } }),
    });
    expect(applyAliases('@generated/client', loadProjectAliases(root)!, root)).toEqual(['..generated/client']);
  });

  it('reads a specifier from a baseUrl that is such a folder', () => {
    const root = project({ 'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '..generated' } }) });
    expect(aliasAndBaseUrlCandidates('client', loadProjectAliases(root)!, root)).toEqual(['..generated/client']);
  });

  it('links the import and the calls through it', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@generated/*': ['..generated/*'] } } }),
      '..generated/client.ts': CLIENT,
      'src/app.ts': "import { makeClient as mk } from '@generated/client';\nexport function run(): number { return mk(); }\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);
    const run = cg.getNodesByName('run')[0]!;
    expect(cg.getCallees(run.id).map((c) => `${c.node.name}@${c.node.filePath}`)).toEqual(['makeClient@..generated/client.ts']);
  });
});

describe('the file watcher and a folder named like `..generated`', () => {
  it('records an edit there, and still drops a path outside the project', async () => {
    const root = project({ '..generated/client.ts': CLIENT, 'src/app.ts': 'export const app = 1;\n' });
    const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    const watcher = new FileWatcher(root, syncFn, { inertForTests: true, debounceMs: 100 });
    watchers.push(watcher);
    watcher.start();
    await watcher.waitUntilReady();

    fs.writeFileSync(path.join(root, '..generated/client.ts'), 'export function makeClient(): number { return 2; }\n');
    __emitWatchEventForTests(root, '..generated/client.ts');
    __emitWatchEventForTests(root, '../outside.ts');
    expect(watcher.getPendingFiles().map((p) => p.path)).toEqual(['..generated/client.ts']);
  });

  it('skips such a folder in the per-folder watch tree when .gitignore lists it', async () => {
    const root = project({ '..cache/x.ts': 'export const x = 1;\n', '.gitignore': '..cache/\n' });
    const watcher = new FileWatcher(root, vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 }), { inertForTests: true });
    watchers.push(watcher);
    watcher.start();
    await watcher.waitUntilReady();
    expect((watcher as unknown as { shouldIgnoreDir(p: string): boolean }).shouldIgnoreDir(path.join(root, '..cache'))).toBe(true);
  });
});

describe('scanning a folder named like `..generated`', () => {
  const scan = (dir: string) => scanDirectory(dir).map((f) => f.replace(/\\/g, '/')).sort();

  it('brings a gitignored one back when `include` names it', () => {
    const root = project({
      'app/main.ts': 'export const main = 1;\n',
      '..generated/client.ts': CLIENT,
      '.gitignore': '..generated/\n',
      'codegraph.json': JSON.stringify({ include: ['..generated/'] }),
    });
    gitCommitAll(root);
    expect(scan(root)).toEqual(['..generated/client.ts', 'app/main.ts']);
  });

  it('applies a .gitignore rule for one when the folder is no git repository', () => {
    const root = project({ 'app/main.ts': 'export const main = 1;\n', '..cache/x.ts': 'export const x = 1;\n', '.gitignore': '..cache/\n' });
    expect(scan(root)).toEqual(['app/main.ts']);
  });
});

describe('deprioritize and a folder named like `..generated`', () => {
  it('ranks what such a folder holds lower when codegraph.json names it', async () => {
    const files = {
      '..generated/client.ts': 'export function makeClient(): number { return 1; }\n',
      'src/client.ts': 'export function makeClient(): number { return 2; }\n',
    };
    const score = async (config: object | null): Promise<number> => {
      const root = project(config ? { ...files, 'codegraph.json': JSON.stringify(config) } : files);
      const cg = await CodeGraph.init(root, { index: true });
      graphs.push(cg);
      return cg.searchNodes('makeClient', { limit: 10 }).find((r) => r.node.filePath === '..generated/client.ts')!.score;
    };
    expect(await score({ deprioritize: ['..generated/'] })).toBeLessThan(await score(null));
  });
});
