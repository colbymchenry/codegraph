/**
 * A sync links an import of a file that appears later, even when the key the
 * import waits under is one a popular import shares.
 *
 * Sync looks a failed import up by what an added file can be imported as — its
 * name, its stem, its folder — and skips a key more than 500 failed imports
 * share, as noise one file cannot answer. But a path import is parked under
 * its path's stem, which a package's imports share with every file of that
 * name: `utils` is the stem of every `jotai/utils` and `@scope/pkg/utils` as
 * much as of a project's own `./utils`, and `assert` the name of every
 * binding of `import * as assert from 'assert'`. In a large project those
 * crowded the key past the ceiling, so the project's own `utils.ts`, added
 * after its importers were indexed or restored after a delete, never linked
 * until the importers changed or the project was re-indexed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

interface Case {
  name: string;
  initial: Record<string, string>;
  added: Record<string, string>;
  /** `imports` edges the sync must make: `<from file> -> <kind> <file>`. */
  expected: string[];
}

/** One file importing `count` package modules whose paths all end in `/utils`. */
function packageUtils(count: number): string {
  return Array.from({ length: count }, (_, i) => `import 'kit${i}/utils';\n`).join('');
}

const CASES: Case[] = [
  {
    name: "a project's utils.ts among package subpaths named utils",
    initial: {
      'package.json': JSON.stringify({ name: 'app', dependencies: Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`kit${i}`, '1.0.0'])) }),
      'src/vendor.ts': packageUtils(520),
      'src/settings/view.ts': "import { format } from './utils';\nexport const view = () => format();\n",
      'src/settings/panel/list.ts': "import { format } from '../utils';\nexport const list = () => format();\n",
    },
    added: { 'src/settings/utils.ts': "export function format() { return ''; }\n" },
    expected: [
      'src/settings/view.ts -> file src/settings/utils.ts',
      'src/settings/panel/list.ts -> file src/settings/utils.ts',
    ],
  },
  {
    name: "a project's assert.ts among bindings of the assert package",
    initial: {
      'package.json': JSON.stringify({ name: 'app', devDependencies: { assert: '2.0.0' } }),
      // Each statement is a module reference to the package and a binding,
      // both waiting under `assert`: 520 in all.
      'test/all.test.ts': Array.from({ length: 260 }, () => "import * as assert from 'assert';\n").join('') + 'assert.ok(true);\n',
      'src/common/strings.ts': "import { ok } from './assert';\nexport const check = (s: string) => ok(s.length > 0);\n",
    },
    added: { 'src/common/assert.ts': 'export function ok(value: boolean) { return value; }\n' },
    expected: ['src/common/strings.ts -> file src/common/assert.ts'],
  },
  {
    // bitwarden imports its `account.service` from 724 files: not noise at all.
    name: 'a file more than 500 imports name',
    initial: Object.fromEntries(Array.from({ length: 510 }, (_, i) => [
      `src/features/f${i}.ts`,
      `import { format } from '../shared/utils';\nexport const f${i} = () => format();\n`,
    ])),
    added: { 'src/shared/utils.ts': "export function format() { return ''; }\n" },
    expected: ['src/features/f0.ts -> file src/shared/utils.ts', 'src/features/f509.ts -> file src/shared/utils.ts'],
  },
];

const roots: string[] = [];
const graphs: CodeGraph[] = [];

afterEach(() => {
  // Close before removing: a held database makes the unlink EBUSY on Windows.
  for (const graph of graphs.splice(0)) graph.destroy();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-crowded-key-'));
  roots.push(dir);
  return dir;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** Every `imports` edge between two files of the project: `<from file> -> <kind> <file>`. */
function fileImports(graph: CodeGraph): string[] {
  const edges = new Set<string>();
  for (const file of graph.getFiles()) {
    const ids = graph.getNodesInFile(file.path).map((n) => n.id);
    for (const edge of graph.getOutgoingEdgesFrom(ids, ['imports'])) {
      const target = graph.getNode(edge.target);
      if (target && target.filePath !== file.path) edges.add(`${file.path} -> ${target.kind} ${target.filePath}`);
    }
  }
  return [...edges].sort();
}

describe('sync links an import under a key a popular import crowds', () => {
  it.each(CASES)('$name', async (c) => {
    const root = tempRoot();
    write(root, c.initial);
    const graph = await CodeGraph.init(root, { index: true });
    graphs.push(graph);
    for (const edge of c.expected) expect(fileImports(graph)).not.toContain(edge);

    write(root, c.added);
    expect((await graph.sync()).filesAdded).toBe(Object.keys(c.added).length);
    const synced = fileImports(graph);
    expect(synced).toEqual(expect.arrayContaining(c.expected));

    // A fresh index of the same tree, in a folder of its own, links the same.
    const fresh = tempRoot();
    write(fresh, { ...c.initial, ...c.added });
    const oracle = await CodeGraph.init(fresh, { index: true });
    graphs.push(oracle);
    expect(synced).toEqual(fileImports(oracle));
  }, 120_000);
});
