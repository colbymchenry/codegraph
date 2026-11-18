/**
 * A `workspaces` entry that leaves the project names no member (#3093).
 *
 * With `"workspaces": ["../sibling"]`, the loader read `../sibling/package.json`
 * and took its name (`left-pad2`) for a package of the project. Nothing under
 * `../sibling` is indexed, so an import of `left-pad2` resolved to no file,
 * but it no longer read as an outside package's either, and the name matcher
 * bound `import { pad } from 'left-pad2'` and its call to the project's own
 * unrelated `src/util.ts` `pad`. A member is a folder of the project: entries
 * that leave it (`../x`, `../*`, an absolute path) now name none, so the
 * import is an outside package's, as it is with no `workspaces` at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
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

/** A temp folder holding `files`; the project is its `app/` folder. */
function layout(files: Files): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-outside-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return path.join(root, 'app');
}

/** The issue's layout: an app importing `left-pad2`, a sibling folder (outside the app) named that. */
function issueLayout(app: Record<string, unknown>, extra: Files = {}): string {
  return layout({
    'app/package.json': JSON.stringify({ name: 'app', ...app, dependencies: { 'left-pad2': '^1.0.0' } }),
    'app/src/util.ts': 'export function pad(s: string) { return s; }\n',
    'app/src/main.ts': "import { pad } from 'left-pad2';\nexport function run() { return pad('x'); }\n",
    'sibling/package.json': JSON.stringify({ name: 'left-pad2', main: 'index.ts' }),
    'sibling/index.ts': 'export function pad(s: string) { return s; }\n',
    ...extra,
  });
}

async function calleesOfRun(project: string): Promise<string[]> {
  const cg = CodeGraph.initSync(project);
  graphs.push(cg);
  await cg.indexAll();
  const run = cg.searchNodes('run').find((r) => r.node.name === 'run')!;
  return cg.getCallees(run.node.id).map((c) => `${c.node.name} @ ${c.node.filePath}`);
}

const memberNames = (project: string): string[] => [...(loadWorkspacePackages(project)?.byName.keys() ?? [])].sort();

describe('workspaces entries outside the project (#3093)', () => {
  it("doesn't bind an import of a package outside the project to a project namesake", async () => {
    const project = issueLayout({ workspaces: ['../sibling'] });
    expect(memberNames(project)).toEqual([]);
    expect(await calleesOfRun(project)).toEqual([]);
  });

  it.each([
    ['a glob that walks the parent folder', { workspaces: ['../*'] }],
    ['a path that climbs back out', { workspaces: ['packages/../../sibling'] }],
    ["Yarn's object form", { workspaces: { packages: ['../sibling'] } }],
  ])('names no member through %s', async (_label, app) => {
    const project = issueLayout(app);
    expect(memberNames(project)).toEqual([]);
    expect(await calleesOfRun(project)).toEqual([]);
  });

  it('names no member through pnpm-workspace.yaml or an absolute path', () => {
    const project = issueLayout({}, { 'app/pnpm-workspace.yaml': "packages:\n  - '../sibling'\n" });
    expect(memberNames(project)).toEqual([]);
    const absolute = issueLayout({ workspaces: [path.resolve(project, '..', 'sibling')] });
    expect(memberNames(absolute)).toEqual([]);
  });

  it('keeps members inside the project, written with or without ./', async () => {
    const project = layout({
      'app/package.json': JSON.stringify({ name: 'app', workspaces: ['./packages/*', '../sibling'] }),
      'app/packages/left-pad2/package.json': JSON.stringify({ name: 'left-pad2', main: 'index.ts' }),
      'app/packages/left-pad2/index.ts': 'export function pad(s: string) { return s; }\n',
      'app/src/util.ts': 'export function pad(s: string) { return s; }\n',
      'app/src/main.ts': "import { pad } from 'left-pad2';\nexport function run() { return pad('x'); }\n",
      'sibling/package.json': JSON.stringify({ name: 'outside-pkg' }),
    });
    expect(memberNames(project)).toEqual(['left-pad2']);
    expect(await calleesOfRun(project)).toEqual(['pad @ packages/left-pad2/index.ts']);
  });
});
