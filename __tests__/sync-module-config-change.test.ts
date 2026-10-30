/**
 * A sync follows a change to the files import resolution is configured by
 * (#2977): `tsconfig.json` / `jsconfig.json` `paths` and `baseUrl`, their
 * `extends` chain, and a `go.mod` module path. The resolver read them once and
 * kept the maps for its lifetime, and the watcher follows source files only,
 * so an edit kept resolving imports by the old mapping — in the same process,
 * and in later ones too, since a sync re-resolves only the changed files.
 *
 * Each case indexes the first tree, edits it, syncs, and compares edges and
 * unresolved references with a full index of the final tree in a folder of
 * its own.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { ExtractionOrchestrator } from '../src/extraction';

type Files = Record<string, string>;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-module-config-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

async function index(root: string): Promise<CodeGraph> {
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** Every edge by its ends' natural keys, and every reference left unresolved. */
function stateOf(root: string, graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = graph.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`);
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const refs = (db.getDb()
      .prepare('SELECT reference_name, reference_kind, file_path, line, col, status, name_tail FROM unresolved_refs')
      .all() as Array<Record<string, unknown>>)
      .map((r) => `ref ${r.file_path}:${r.line}:${r.col} ${r.reference_kind} ${r.reference_name} ${r.status} ${r.name_tail}`);
    return [...edges, ...refs].sort();
  } finally {
    db.close();
  }
}

/** The files the calls written in `caller` land in. */
function callTargets(graph: CodeGraph, caller: string): string[] {
  const node = graph.getNodesByQualifiedName(caller)[0]!;
  return graph.getOutgoingEdges(node.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${graph.getNode(e.target)!.filePath}::${graph.getNode(e.target)!.qualifiedName}`)
    .sort();
}

const tsconfig = (target: string): string =>
  JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': [`${target}/*`] } } });

const TS_BEFORE: Files = {
  'package.json': JSON.stringify({ name: 'app' }),
  'tsconfig.json': tsconfig('lib1'),
  'lib1/u.ts': 'export function foo() { return 1; }\n',
  'lib2/u.ts': 'export function foo() { return 2; }\n',
  'c.ts': "import { foo } from '@lib/u';\nexport function bar() { return foo(); }\n",
};

const GO_BEFORE: Files = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'util/u.go': 'package util\n\nfunc Foo() int { return 1 }\n',
  'main.go': 'package main\n\nimport "example.com/app/util"\n\nfunc run() int { return util.Foo() }\n',
};

/** Index `before`, write `after` over it, sync; return the graph and what a full index of the final tree holds. */
async function syncEdit(before: Files, after: Files): Promise<{ root: string; graph: CodeGraph; full: string[] }> {
  const root = tempRoot();
  write(root, before);
  const graph = await index(root);
  write(root, after);
  await graph.sync();
  const fullRoot = tempRoot();
  write(fullRoot, { ...before, ...after });
  return { root, graph, full: stateOf(fullRoot, await index(fullRoot)) };
}

describe('a sync follows a module-config change (#2977)', () => {
  it('tsconfig paths retargeted, the importer untouched', async () => {
    const { root, graph, full } = await syncEdit(TS_BEFORE, { 'tsconfig.json': tsconfig('lib2') });
    expect(callTargets(graph, 'bar')).toEqual(['lib2/u.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('tsconfig paths retargeted and the importer touched, as the issue did', async () => {
    const { root, graph, full } = await syncEdit(TS_BEFORE, {
      'tsconfig.json': tsconfig('lib2'),
      'c.ts': "import { foo } from '@lib/u';\nexport function bar() { return foo() + 0; }\n",
    });
    expect(callTargets(graph, 'bar')).toEqual(['lib2/u.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a mapping declared in the extends chain', async () => {
    const before: Files = {
      ...TS_BEFORE,
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { strict: true } }),
      'tsconfig.base.json': tsconfig('lib1'),
    };
    const { root, graph, full } = await syncEdit(before, { 'tsconfig.base.json': tsconfig('lib2') });
    expect(callTargets(graph, 'bar')).toEqual(['lib2/u.ts::foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a go.mod module path renamed, with the imports written for it', async () => {
    const { root, graph, full } = await syncEdit(GO_BEFORE, {
      'go.mod': 'module example.com/other\n\ngo 1.22\n',
      'main.go': 'package main\n\nimport "example.com/other/util"\n\nfunc run() int { return util.Foo() }\n',
    });
    expect(callTargets(graph, 'run')).toEqual(['util/u.go::Foo']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('a later process sees the change too', async () => {
    const root = tempRoot();
    write(root, TS_BEFORE);
    const first = await index(root);
    expect(callTargets(first, 'bar')).toEqual(['lib1/u.ts::foo']);
    first.close();
    graphs.splice(graphs.indexOf(first), 1);

    write(root, { 'tsconfig.json': tsconfig('lib2') });
    const second = await CodeGraph.open(root);
    graphs.push(second);
    await second.sync();
    expect(callTargets(second, 'bar')).toEqual(['lib2/u.ts::foo']);
  }, 120_000);

  it('an unchanged config re-opens nothing', async () => {
    const root = tempRoot();
    write(root, TS_BEFORE);
    const graph = await index(root);
    const before = stateOf(root, graph);
    // A body edit elsewhere: the import map is read again and found the same.
    write(root, { 'lib2/u.ts': 'export function foo() { return 3; }\n' });
    const result = await graph.sync();
    expect(result.filesModified).toBe(1);
    expect(stateOf(root, graph)).toEqual(before);
  }, 120_000);

  it('a config edit that moves no mapping re-opens nothing: a tsconfig flag, a go.mod requirement', async () => {
    const tsRoot = tempRoot();
    write(tsRoot, TS_BEFORE);
    const ts = await index(tsRoot);
    const tsBefore = stateOf(tsRoot, ts);
    const goRoot = tempRoot();
    write(goRoot, GO_BEFORE);
    const go = await index(goRoot);
    const goBefore = stateOf(goRoot, go);
    // Every import a language has goes back for the sweep when its map moves;
    // an edit resolution never reads must not send them there.
    const reopen = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectResolutionEdgesForLanguage');
    try {
      write(tsRoot, { 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib1/*'] }, strict: true } }) });
      await ts.sync();
      write(goRoot, { 'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire golang.org/x/text v0.14.0\n' });
      await go.sync();
      expect(reopen).not.toHaveBeenCalled();
    } finally {
      reopen.mockRestore();
    }
    expect(stateOf(tsRoot, ts)).toEqual(tsBefore);
    expect(stateOf(goRoot, go)).toEqual(goBefore);
  }, 120_000);
});
