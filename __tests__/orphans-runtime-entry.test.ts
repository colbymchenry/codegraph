/**
 * `codegraph orphans` on symbols a language runtime calls, though no code in
 * the index does: a Go package's top-level `init` functions, and Python's
 * dunder methods and module-level `__getattr__` function. Run on a real CodeGraph
 * index of a fixture git repo through `runOrphans`.
 *
 * One repo: commit C1 (tagged), then C2 adds every file below, so each symbol
 * is added by rule 1. Indexed once at C2 in beforeAll.
 *
 *   - Runtime entry points, excluded and counted as entry, never listed: the
 *     two top-level Go `init` functions (pkg/store/cache.go, pkg/store/index.go),
 *     Python's `__len__` and `__iter__` methods of `Bag` (lib/bag.py) and the
 *     module-level `__getattr__` (lib/lazy.py). The Go runtime and Python's data
 *     model call them.
 *   - Controls that stay listed, since none of them is a runtime entry point: a
 *     Go method named `init` on a type (pkg/store/cache.go), a TypeScript
 *     function named `init` (src/init.ts), a Python function named `init` and
 *     one named `len_` (lib/helpers.py), a module-level Python function named
 *     `__len__` (lib/hooks.py), and a dunder function defined inside another
 *     function (`__repr__` inside `make_box`, lib/nested.py). Python's data model
 *     calls the dunder methods and the module-level hooks, and neither of these
 *     two dunder functions is one of those.
 *
 * The "fixture:" tests assert the node kinds the cases depend on first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { runOrphans, type OrphansArgs } from '../src/graph/orphans-run';

/** The report text of a run that must succeed. */
async function output(root: string, args: OrphansArgs): Promise<string> {
  const r = await runOrphans(root, args);
  if (!r.ok) throw new Error(`orphans failed: ${r.message}`);
  return r.output;
}

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const C1_FILES: Record<string, string> = {
  'src/base.ts': 'export function base(): number {\n  return 0;\n}\n',
};

const C2_FILES: Record<string, string> = {
  'pkg/store/cache.go': [
    'package store',
    '',
    'var registry = map[string]int{}',
    '',
    'type Cache struct {',
    '\tn int',
    '}',
    '',
    'func (c *Cache) init() {',
    '\tc.n = 0',
    '}',
    '',
    'func init() {',
    '\tregistry["cache"] = 1',
    '}',
    '',
  ].join('\n'),
  'pkg/store/index.go': ['package store', '', 'func init() {', '\tregistry["index"] = 2', '}', ''].join('\n'),
  'lib/bag.py': [
    'class Bag:',
    '    items = []',
    '',
    '    def __len__(self):',
    '        return len(self.items)',
    '',
    '    def __iter__(self):',
    '        return iter(self.items)',
    '',
  ].join('\n'),
  'lib/lazy.py': 'def __getattr__(name):\n    raise AttributeError(name)\n',
  'lib/helpers.py': 'def init():\n    return 1\n\n\ndef len_(items):\n    return len(items)\n',
  'src/init.ts': 'export function init(): number {\n  return 1;\n}\n',
  'lib/hooks.py': 'def __len__():\n    return 0\n',
  'lib/nested.py': 'def make_box():\n    def __repr__(self):\n        return "box"\n    return 0\n',
};

interface Entry { id: string; name: string; kind: string; path: string; span: string }
interface NodeRow { id: string; name: string; kind: string; file_path: string }
interface OrphansJson {
  added: number;
  orphans: Entry[];
  guessed: Entry[];
  excluded: { test: number; implementation: number; constructor: number; entry: number };
}

let root = '';
let report: OrphansJson;
let nodes: NodeRow[] = [];

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-runtime-')));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(C1_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  for (const [rel, content] of Object.entries(C2_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2: add symbols');

  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();

  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    nodes = conn.getDb()
      .prepare("SELECT id, name, kind, file_path FROM nodes WHERE kind NOT IN ('file','import','parameter')")
      .all() as unknown as NodeRow[];
  } finally {
    conn.close();
  }

  report = JSON.parse(await output(root, { base: 'C1', format: 'json' })) as OrphansJson;
}, 60_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** A node or a listed entry, as `path#kind:name`. Kind is in the key: a Go method and a top-level function may share a name in one file. */
const keyOf = (n: { file_path?: string; path?: string; kind: string; name: string }): string =>
  `${n.file_path ?? n.path}#${n.kind}:${n.name}`;
const listedKeys = (): string[] => [...report.orphans, ...report.guessed].map(keyOf);

describe('orphans runtime entry points', () => {
  it('fixture: the Go init functions and method, the Python dunders and the control names are nodes of the kinds the cases assume', () => {
    expect(nodes.map(keyOf)).toEqual(expect.arrayContaining([
      'pkg/store/cache.go#function:init',
      'pkg/store/cache.go#method:init',
      'pkg/store/index.go#function:init',
      'lib/bag.py#method:__len__',
      'lib/bag.py#method:__iter__',
      'lib/lazy.py#function:__getattr__',
      'lib/helpers.py#function:init',
      'lib/helpers.py#function:len_',
      'src/init.ts#function:init',
    ]));
  });

  it('fixture: the module-level __len__ and the dunder inside make_box are function nodes', () => {
    expect(nodes.map(keyOf)).toEqual(expect.arrayContaining([
      'lib/hooks.py#function:__len__',
      'lib/nested.py#function:make_box',
      'lib/nested.py#function:__repr__',
    ]));
  });

  it('a top-level Go init function is not listed', () => {
    expect(listedKeys()).not.toContain('pkg/store/cache.go#function:init');
    expect(listedKeys()).not.toContain('pkg/store/index.go#function:init');
  });

  it('a Python dunder method or module-level dunder function is not listed', () => {
    expect(listedKeys()).not.toContain('lib/bag.py#method:__len__');
    expect(listedKeys()).not.toContain('lib/bag.py#method:__iter__');
    expect(listedKeys()).not.toContain('lib/lazy.py#function:__getattr__');
  });

  it('those five are counted as entry points and under no other exclusion', () => {
    expect(report.excluded).toEqual({ test: 0, implementation: 0, constructor: 0, entry: 5 });
  });
});

describe('orphans runtime entry controls', () => {
  it('a Go method named init on a type is still listed', () => {
    expect(listedKeys()).toContain('pkg/store/cache.go#method:init');
  });

  it('a TypeScript function named init is still listed', () => {
    expect(listedKeys()).toContain('src/init.ts#function:init');
  });

  it('a Python function named init is still listed', () => {
    expect(listedKeys()).toContain('lib/helpers.py#function:init');
  });

  it('a Python function named len_ is still listed', () => {
    expect(listedKeys()).toContain('lib/helpers.py#function:len_');
  });

  it('a module-level Python function named __len__ is still listed', () => {
    expect(listedKeys()).toContain('lib/hooks.py#function:__len__');
  });

  it('a dunder function defined inside a function is still listed', () => {
    expect(listedKeys()).toContain('lib/nested.py#function:__repr__');
  });
});
