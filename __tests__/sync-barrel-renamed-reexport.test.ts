/**
 * A sync relinks an import that reaches a module through a barrel which passes
 * it on under another name, once an edit gives the module what is imported.
 *
 * matx's `app/components/index.js` says `export { default as MatxLoading }
 * from './MatxLoading'`, and `MatxSuspense.jsx` imports `{ MatxLoading }` from
 * the barrel. While `MatxLoading.jsx` has no default export, the import and
 * the calls through it fail, parked under the name they use: `MatxLoading`.
 * When an edit adds `export default function Loading`, a sync retries what
 * waits for the names the file now declares (`Loading`) and what waits under
 * the barrel's module key, and neither is `MatxLoading`. Only a fresh index
 * linked them. The same holds for `export { Spinner as AppSpinner } from`.
 *
 * When something else in the project is named `MatxLoading`, the import does
 * not fail while the module lacks it: a name match takes it there. The edit's
 * rebind re-opens the edges into what the file now declares (`Loading`), not
 * into another `MatxLoading`, so that edge stayed too (vben's `alert`, which
 * its alert barrel passes on from `vbenAlert`, stayed on the `alert.vue`
 * component).
 *
 * The barrel also passes on `Card` under the name `Card.js` declares, which
 * the retry by the changed names and the rebind already relink: the fixture
 * keeps it so they go on doing so.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

type Files = Record<string, string>;

const IMPORTERS: Files = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18' } }),
  'src/components/index.js':
    "export { default as MatxLoading } from './MatxLoading';\n" +
    "export { Spinner as AppSpinner } from './Spinner';\n" +
    "export { Card } from './Card';\n",
  'src/components/MatxSuspense.js':
    "import { MatxLoading, AppSpinner, Card } from '.';\n" +
    'export function suspense() {\n  MatxLoading();\n  Card();\n  return AppSpinner();\n}\n',
};

const MODULES: Files = {
  'src/components/MatxLoading.js': 'export default function Loading() {\n  return null;\n}\n',
  'src/components/Spinner.js': 'export function Spinner() {\n  return null;\n}\n',
  'src/components/Card.js': 'export function Card() {\n  return null;\n}\n',
};

/** What a fresh index links from `suspense` through the barrel. */
const CALLS = [
  'suspense -> src/components/Card.js::Card',
  'suspense -> src/components/MatxLoading.js::Loading',
  'suspense -> src/components/Spinner.js::Spinner',
];

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-barrel-rename-'));
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

/** Every edge, by its ends' natural keys, with where it is written and how it resolved. */
function edgesOf(graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  return graph.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`)
    .sort();
}

/** The calls `suspense` makes, as `suspense -> <file>::<name>`. */
function callsOf(graph: CodeGraph): string[] {
  const suspense = graph.getNodesInFile('src/components/MatxSuspense.js').find((n) => n.name === 'suspense');
  if (!suspense) return [];
  return graph.getCallees(suspense.id).map((c) => `suspense -> ${c.node.filePath}::${c.node.name}`).sort();
}

async function fullIndexOf(files: Files): Promise<string[]> {
  const root = tempRoot();
  write(root, files);
  return edgesOf(await index(root));
}

describe('sync relinks an import a barrel passes on under another name', () => {
  it('when an edit gives the module what is imported', async () => {
    const root = tempRoot();
    write(root, IMPORTERS);
    write(root, Object.fromEntries(Object.keys(MODULES).map((file) => [file, 'export const placeholder = 1;\n'])));
    const graph = await index(root);
    expect(callsOf(graph)).toEqual([]);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesModified).toBe(Object.keys(MODULES).length);
    expect(result.filesAdded).toBe(0);
    expect(callsOf(graph)).toEqual(CALLS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
  }, 120_000);

  it('when the module is added after its importers', async () => {
    const root = tempRoot();
    write(root, IMPORTERS);
    const graph = await index(root);
    expect(callsOf(graph)).toEqual([]);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesAdded).toBe(Object.keys(MODULES).length);
    expect(callsOf(graph)).toEqual(CALLS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...MODULES }));
  }, 120_000);
});

/** Declarations elsewhere named as the barrel passes the modules on. */
const NAMESAKES: Files = {
  'src/legacy/MatxLoading.js': 'export function MatxLoading() {\n  return 1;\n}\n',
  'src/legacy/AppSpinner.js': 'export function AppSpinner() {\n  return 1;\n}\n',
  'src/legacy/Card.js': 'export function Card() {\n  return 1;\n}\n',
};

/** Where a name match takes the imports while the modules lack them. */
const NAMESAKE_CALLS = [
  'suspense -> src/legacy/AppSpinner.js::AppSpinner',
  'suspense -> src/legacy/Card.js::Card',
  'suspense -> src/legacy/MatxLoading.js::MatxLoading',
];

describe('sync relinks an import a barrel passes on under another name that a namesake took', () => {
  it('when an edit gives the module what is imported', async () => {
    const root = tempRoot();
    write(root, { ...IMPORTERS, ...NAMESAKES });
    write(root, Object.fromEntries(Object.keys(MODULES).map((file) => [file, 'export const placeholder = 1;\n'])));
    const graph = await index(root);
    expect(callsOf(graph)).toEqual(NAMESAKE_CALLS);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesModified).toBe(Object.keys(MODULES).length);
    expect(callsOf(graph)).toEqual(CALLS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...NAMESAKES, ...MODULES }));
  }, 120_000);

  it('when the module is added after its importers', async () => {
    const root = tempRoot();
    write(root, { ...IMPORTERS, ...NAMESAKES });
    const graph = await index(root);
    expect(callsOf(graph)).toEqual(NAMESAKE_CALLS);

    write(root, MODULES);
    const result = await graph.sync();
    expect(result.filesAdded).toBe(Object.keys(MODULES).length);
    expect(callsOf(graph)).toEqual(CALLS);
    expect(edgesOf(graph)).toEqual(await fullIndexOf({ ...IMPORTERS, ...NAMESAKES, ...MODULES }));
  }, 120_000);
});
