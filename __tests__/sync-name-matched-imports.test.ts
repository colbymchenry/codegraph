/**
 * A sync re-links an import a name match took instead of its module.
 *
 * `import { Widget } from '../lib'` resolves through `lib/index.ts`. While the
 * barrel does not pass `Widget` on, the import fails there and a name match
 * links the binding, and every reference through it, to a `Widget` declared
 * somewhere else. An edit that gives the barrel `export { Widget } from
 * './widget'` declares nothing: no definition delta for the rebind (CG-33),
 * no added file for the walks below a barrel (#2512, #2560, #2665), and the
 * binding never failed for the retries (#1240, #2744). The name match stayed,
 * where a full index links the binding through the barrel (#2744's
 * "retargets"). A name match into the edited module itself, `import { Widget }
 * from '../x'` where `x.ts` exports `Widget` only as its default, stayed too
 * once the edit dropped that default, where a full index finds nothing.
 *
 * Each case indexes the first tree, edits it, syncs, and compares edges and
 * unresolved references with a full index of the final tree in a folder of
 * its own (#2411).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

type Files = Record<string, string>;

const run = '{ run(): number { return 1; } }';
const reader = (from: string, name = 'Widget'): string =>
  `import { ${name} } from '${from}';\nexport function make(): unknown { return new ${name}(); }\nexport function call(w: ${name}): number { return w.run(); }\n`;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-name-matched-'));
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

/** Where each reference to `refName` landed and how: `<source> -> <target file>::<qualified name> (<resolvedBy>)`. */
function targetsOf(graph: CodeGraph, refName: string): string[] {
  const ids = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path)).map((n) => n.id);
  return graph.getOutgoingEdgesFrom(ids)
    .filter((e) => e.metadata?.refName === refName)
    .map((e) => {
      const target = graph.getNode(e.target)!;
      return `${graph.getNode(e.source)!.name} -> ${target.filePath}::${target.qualifiedName} (${e.metadata?.resolvedBy})`;
    })
    .sort();
}

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

describe('sync re-links an import a name match took instead of its module', () => {
  it('when an edit gives the barrel a re-export under another name', async () => {
    const before: Files = {
      'src/lib/index.ts': 'export const version = 1;\n',
      'src/lib/impl.ts': `export default class Impl ${run}\n`,
      'src/other/widget.ts': `export class Widget ${run}\n`,
      'src/app/y.ts': reader('../lib'),
    };
    const after: Files = { 'src/lib/index.ts': "export const version = 1;\nexport { default as Widget } from './impl';\n" };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'Widget')).toEqual([
      'call -> src/lib/impl.ts::Impl (import)',
      'make -> src/lib/impl.ts::Impl (import)',
      'y.ts -> src/lib/impl.ts::Impl (import)',
    ]);
    // A value typed by the binding reaches the member of what it binds now.
    expect(targetsOf(graph, 'w.run')).toEqual(['call -> src/lib/impl.ts::Impl::run (instance-method)']);
    expect(stateOf(root, graph)).toEqual(full);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it('when an edit gives the barrel the re-export of a declaration the name match also found', async () => {
    const before: Files = {
      'src/lib/index.ts': 'export const version = 1;\n',
      'src/lib/widget.ts': `export class Widget ${run}\n`,
      'src/other/widget.ts': `export class Widget ${run}\n`,
      'src/app/y.ts': reader('../lib'),
    };
    const after: Files = { 'src/lib/index.ts': "export const version = 1;\nexport { Widget } from './widget';\n" };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'Widget').every((t) => t.endsWith('src/lib/widget.ts::Widget (import)'))).toBe(true);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('when an edit drops the default a named import was matched to', async () => {
    const before: Files = {
      'src/x.ts': `export const VERSION = 1;\nclass Widget ${run}\nexport default Widget;\n`,
      'src/app/y.ts': reader('../x'),
    };
    const after: Files = { 'src/x.ts': `export const VERSION = 1;\nclass Widget ${run}\n` };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'Widget')).toEqual([]);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);

  it('and puts nothing back when the module still lacks the name', async () => {
    const reopened = vi.spyOn(QueryBuilder.prototype, 'replaceResolutionEdgesWithUnresolvedRefs');
    const before: Files = {
      'src/lib/index.ts': 'export const version = 1;\n',
      'src/other/widget.ts': `export class Widget ${run}\n`,
      'src/app/y.ts': reader('../lib'),
    };
    const after: Files = { 'src/lib/index.ts': 'export const version = 2;\n' };
    const { root, graph, full } = await syncEdit(before, after);
    expect(targetsOf(graph, 'Widget').every((t) => t.includes('src/other/widget.ts::Widget'))).toBe(true);
    expect(reopened).not.toHaveBeenCalled();
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);
});
