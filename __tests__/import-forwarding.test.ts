/**
 * An import reaches the declaration its module exports, when the module
 * exports an import of its own or writes its default export as an expression.
 *
 * A module that hands on what it imports — outline's `presenters/index.ts`
 * is `import presentUser from './user'; … export { presentUser, … }`, and an
 * `index.ts` beside a component is `import Avatar from './Avatar'; export
 * default Avatar` — declares nothing under the exported name, so the import
 * fell through to a name match, which took any namesake in the project. A
 * default written as an expression had only the first-exported-function guess
 * behind it: `export default new Logger()` sent a server's logging calls to
 * the browser app's `Logger` (outline makes one in each), and a function a
 * wrapper hands on (`traceFunction({…})(accountProvisioner)`) or one `export
 * { createThing as default }` names was replaced by whatever the module
 * exported first.
 *
 * The sync cases compare the synced graph with a full index of the final tree
 * in a folder of its own (#2411).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-forwarding-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

async function index(files: Files, root = tempRoot()): Promise<CodeGraph> {
  write(root, files);
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** Where the calls out of `source` landed: `<kind> <file>::<qualified name>`. */
function callsOf(graph: CodeGraph, source: string): string[] {
  const nodes = graph.getFiles().flatMap((file) => graph.getNodesInFile(file.path));
  const from = nodes.filter((n) => n.name === source).map((n) => n.id);
  return graph.getOutgoingEdgesFrom(from)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const target = graph.getNode(e.target)!;
      return `${target.kind} ${target.filePath}::${target.qualifiedName}`;
    })
    .sort();
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

/** Index `before`, write `after` over it, sync; return the graph and what a full index of `after` holds. */
async function syncEdit(before: Files, after: Files): Promise<{ root: string; graph: CodeGraph; full: string[] }> {
  const root = tempRoot();
  const graph = await index(before, root);
  write(root, after);
  await graph.sync();
  const fullRoot = tempRoot();
  const full = stateOf(fullRoot, await index({ ...before, ...after }, fullRoot));
  return { root, graph, full };
}

/** A function of the decoy app, named like every one the tests import. */
const decoy = (...names: string[]): Files => ({
  'a-decoy/lib.ts': names.map((n) => `export function ${n}() { return 'decoy'; }\n`).join(''),
});

describe('an import of a module that exports an import of its own', () => {
  it('reaches what the module imports, under its own name or another', async () => {
    const graph = await index({
      ...decoy('presentUser', 'presentTeam'),
      'presenters/user.ts': "export default function presentUser() { return 'user'; }\n",
      'presenters/team.ts': "export function presentTeam() { return 'team'; }\n",
      'presenters/index.ts': "import presentUser from './user';\nimport { presentTeam } from './team';\nexport { presentUser, presentTeam as team };\n",
      'api/users.ts': "import { presentUser, team } from '../presenters';\nexport function show() { return presentUser() + team(); }\n",
      'api/teams.ts': "import * as presenters from '../presenters';\nexport function list() { return presenters.presentUser(); }\n",
    });
    expect(callsOf(graph, 'show')).toEqual([
      'function presenters/team.ts::presentTeam',
      'function presenters/user.ts::presentUser',
    ]);
    expect(callsOf(graph, 'list')).toEqual(['function presenters/user.ts::presentUser']);
  });

  it('reaches the default export a module imports and exports as its own', async () => {
    const graph = await index({
      ...decoy('makeAvatar', 'Marker'),
      'lib/avatar/makeAvatar.ts': "export default function makeAvatar() { return 'avatar'; }\n",
      'lib/avatar/index.ts': "import makeAvatar from './makeAvatar';\nexport default makeAvatar;\n",
      'lib/map/marker.ts': "export function Marker() { return 'marker'; }\n",
      'lib/map/index.ts': "import { Marker } from './marker';\nexport { Marker as default };\n",
      'main.ts': "import makeAvatar from './lib/avatar';\nimport placeMarker from './lib/map';\nexport function start() { return makeAvatar() + placeMarker(); }\n",
    });
    expect(callsOf(graph, 'start')).toEqual([
      'function lib/avatar/makeAvatar.ts::makeAvatar',
      'function lib/map/marker.ts::Marker',
    ]);
  });

  it('follows the module when a sync changes the import it exports as its default', async () => {
    const lib = (from: string): Files => ({ 'lib/index.ts': `import impl from './${from}';\nexport default impl;\n` });
    const before = {
      'lib/a.ts': "export default function runA() { return 'a'; }\n",
      'lib/b.ts': "export default function runB() { return 'b'; }\n",
      'main.ts': "import run from './lib';\nexport function start() { return run(); }\n",
      ...lib('a'),
    };
    const { root, graph, full } = await syncEdit(before, lib('b'));
    expect(callsOf(graph, 'start')).toEqual(['function lib/b.ts::runB']);
    expect(stateOf(root, graph)).toEqual(full);
  }, 120_000);
});

describe('a default export written as an expression', () => {
  it('is an instance of the class it makes, whose methods its importers call', async () => {
    const logger = 'class Logger {\n  info(m: string) { return m; }\n  warn(m: string) { return m; }\n}\nexport default new Logger();\n';
    const graph = await index({
      'app/logger.ts': `export function format(m: string) { return m; }\n${logger}`,
      'server/logger.ts': logger,
      'server/jobs.ts': "import Logger from './logger';\nexport function work() { Logger.info('start'); return Logger.warn('done'); }\n",
    });
    expect(callsOf(graph, 'work')).toEqual(['method server/logger.ts::Logger::info', 'method server/logger.ts::Logger::warn']);
  });

  it('is what a wrapper call hands on, or the declaration a clause names', async () => {
    const graph = await index({
      ...decoy('provision', 'make'),
      'tracing.ts': 'export function traceFunction(opts: object) { return <T>(fn: T) => fn; }\nexport function withRetry<T>(fn: T) { return fn; }\n',
      'provisioner.ts': "import { traceFunction } from './tracing';\nexport function helperFirst() { return 1; }\nasync function accountProvisioner() { return { ok: true }; }\nexport default traceFunction({ spanName: 'accountProvisioner' })(accountProvisioner);\n",
      'job.ts': "import { withRetry } from './tracing';\nexport function helperFirst() { return 1; }\nfunction SyncJob() { return 2; }\nexport default withRetry(SyncJob);\n",
      'svc.ts': 'export function first() { return 1; }\nfunction createThing() { return 2; }\nexport { createThing as default };\n',
      'main.ts': "import provision from './provisioner';\nimport job from './job';\nimport make from './svc';\nexport async function start() { await provision(); job(); return make(); }\n",
    });
    expect(callsOf(graph, 'start')).toEqual([
      'function job.ts::SyncJob',
      'function provisioner.ts::accountProvisioner',
      'function svc.ts::createThing',
    ]);
  });

  it('is not the argument of a factory, nor anything past the call it ends with', async () => {
    const graph = await index({
      'factory.ts': 'export function createStore(r: (s: unknown) => unknown) { return { dispatch(a: unknown) { return r(a); } }; }\n',
      'store.ts': "import { createStore } from './factory';\nfunction reducer(state: unknown) { return state; }\nexport default createStore(reducer);\n",
      'client.ts': 'class Client { configure() { return this; } send() { return 1; } }\nexport function connect() { return 0; }\nexport default new Client()\n  .configure();\n',
      'main.ts': "import store from './store';\nimport client from './client';\nexport function start() { client.send(); return store.dispatch({ type: 'go' }); }\n",
    });
    const calls = callsOf(graph, 'start');
    expect(calls.some((c) => c.endsWith('::reducer'))).toBe(false);
    expect(calls.some((c) => c.startsWith('method client.ts::Client::'))).toBe(false);
  });
});
