/**
 * Issue #3093: a `workspaces` entry that leaves the project (`../sibling`)
 * was scanned as a workspace member. Registering the outside folder's
 * package name made an import of that name look local, and the name matcher
 * then linked the call to an unrelated same-named function in the project —
 * `import { pad } from 'left-pad2'` called `pad` in `src/util.ts`.
 *
 * Workspace patterns are relative to their root and never leave it: an entry
 * with a `..` segment (`../sibling`, `packages/../sibling`), a glob whose
 * walk starts outside it (`../*`), or an absolute path names no member. The
 * absolute path was already ignored before this fix and stays ignored.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { loadWorkspacePackages } from '../src/resolution/workspace-packages';

type Files = Record<string, string>;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function write(root: string, files: Files): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

/**
 * The issue's fixture: `app/` imports `pad` from `left-pad2`, an outside
 * package beside it, and has its own unrelated `pad`. `workspaces`, when
 * given, is written into app's package.json.
 */
function fixture(workspaces?: string[], extra: Files = {}): string {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-outside-'));
  roots.push(outer);
  const app = path.join(outer, 'app');
  write(outer, {
    'sibling/package.json': JSON.stringify({ name: 'left-pad2', main: 'index.ts' }),
    'sibling/index.ts': 'export function pad(s: string) { return s; }\n',
    'app/src/util.ts': 'export function pad(s: string) { return s; }\n',
    'app/src/main.ts': "import { pad } from 'left-pad2';\nexport function run() { return pad('x'); }\n",
    'app/package.json': JSON.stringify({
      name: 'app',
      ...(workspaces ? { workspaces } : {}),
      dependencies: { 'left-pad2': '^1.0.0' },
    }),
    ...extra,
  });
  return app;
}

/** `run()`'s resolved calls, as `name @ file`. */
async function runCalls(app: string): Promise<string[]> {
  const graph = await CodeGraph.init(app, { index: true });
  graphs.push(graph);
  const run = graph.searchNodes('run').find((r) => r.node.name === 'run');
  expect(run).toBeDefined();
  return graph.getCallees(run!.node.id).map((c) => `${c.node.name} @ ${c.node.filePath}`);
}

/** The loader's member map, as sorted `name -> dir` lines. */
function members(app: string): string[] {
  const ws = loadWorkspacePackages(app);
  return [...(ws?.byName ?? new Map<string, string>())].map(([name, dir]) => `${name} -> ${dir}`).sort();
}

describe('workspaces entries outside the project (#3093)', () => {
  it('does not register the outside folder as a member', () => {
    expect(members(fixture(['../sibling']))).toEqual([]);
  });

  it('does not link an import to a project symbol when the member is outside', async () => {
    expect(await runCalls(fixture(['../sibling']))).toEqual([]);
  });

  it('still resolves an in-project workspace glob', async () => {
    const app = fixture(['packages/*'], {
      'app/packages/left-pad2/package.json': JSON.stringify({ name: 'left-pad2', main: 'index.ts' }),
      'app/packages/left-pad2/index.ts': 'export function pad(s: string) { return s; }\n',
    });
    expect(members(app)).toEqual(['left-pad2 -> packages/left-pad2']);
    expect(await runCalls(app)).toEqual(['pad @ packages/left-pad2/index.ts']);
  });

  it('leaves a project without workspaces unchanged', async () => {
    expect(members(fixture())).toEqual([]);
    expect(await runCalls(fixture())).toEqual([]);
  });

  it('ignores an entry that escapes after normalisation', () => {
    expect(members(fixture(['packages/../../sibling']))).toEqual([]);
  });

  it('ignores a `..` entry even when it resolves back inside the project', () => {
    const app = fixture(['packages/../sibling'], {
      'app/sibling/package.json': JSON.stringify({ name: 'inner-sibling' }),
    });
    expect(members(app)).toEqual([]);
  });

  it('does not walk outside the project for a glob', () => {
    expect(members(fixture(['../*']))).toEqual([]);
  });

  it('keeps ignoring an absolute path entry', () => {
    const app = fixture();
    const sibling = path.join(path.dirname(app), 'sibling');
    write(app, {
      'package.json': JSON.stringify({ name: 'app', workspaces: [sibling], dependencies: { 'left-pad2': '^1.0.0' } }),
    });
    expect(members(app)).toEqual([]);
  });
});
