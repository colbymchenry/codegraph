/**
 * Issue #2577: an import spelled with a trailing slash (`@/widgets/Chart/`), a
 * `.` segment (`src/widgets/./Chart`), a doubled slash or a `..` segment names
 * the same file as the plain spelling, but the alias, workspace and direct-path
 * branches of the import resolver joined the specifier as written. The disk
 * check accepts any spelling of a file, so the import came back as
 * `src/widgets/Chart//index.tsx`, which no file node is keyed by: the file
 * import was dropped, the names fell back to name matching, and a lazily loaded
 * component rendered the importing file's own `lazy(…)` constant.
 *
 * A trailing slash still names a folder: `@/widgets/Chart/` is
 * `Chart/index.tsx`, never a `Chart.tsx` beside it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const CHART = `export default function ChartView() { return null; }
export function Legend() { return 1; }
`;
/** An app that imports and lazily loads `Chart` through `spec`. */
const app = (spec: string): string => `import { lazy } from 'react';
import { Legend } from '${spec}';
const Chart = lazy(() => import('${spec}'));
export function App() { Legend(); return <Chart />; }
`;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'], dependencies: { react: '^18.0.0' } }),
  'src/widgets/Chart/index.tsx': CHART,
  'src/Plain.tsx': app('@/widgets/Chart'),
  'src/TrailingSlash.tsx': app('@/widgets/Chart/'),
  'src/DotSegment.tsx': app('src/widgets/./Chart'),
  'src/DoubleSlash.tsx': app('@/widgets//Chart'),
  'src/DotDot.tsx': app('@/other/../widgets/Chart'),
  'src/other/x.ts': `export const x = 1;
`,
  // A trailing slash names the folder, not the file beside it.
  'src/cards/Card.tsx': `export function Legend() { return 2; }
`,
  'src/cards/Card/index.tsx': CHART,
  'src/Folder.tsx': app('@/cards/Card/'),
  // A workspace member, imported as `@acme/ui/` and through a `.` segment.
  'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
  'packages/ui/index.tsx': CHART,
  'packages/ui/widgets/legend.ts': `export function Legend() { return 3; }
`,
  'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/ui': 'workspace:*', react: '^18.0.0' } }),
  'packages/app/src/Member.tsx': app('@acme/ui/'),
  'packages/app/src/MemberPath.ts': `import { Legend } from '@acme/ui/./widgets/legend';
export function show() { return Legend(); }
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-path-spelling-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `kind name@file` of every edge but `contains` leaving the nodes of `file`. */
function edgesFrom(file: string): string[] {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const e of cg.getOutgoingEdges(node.id)) {
      if (e.kind === 'contains') continue;
      const target = cg.getNode(e.target)!;
      out.push(`${e.kind} ${target.name}@${target.filePath}`);
    }
  }
  return out;
}

/** What the plain spelling gives: the file import, the lazily loaded component, and the named import by import. */
function expectLinked(file: string, module: string): void {
  const edges = edgesFrom(file);
  expect(edges).toContain(`imports ${path.posix.basename(module)}@${module}`);
  expect(edges).toContain(`calls ChartView@${module}`);
  expect(edges).toContain(`calls Legend@${module}`);
  expect(edges.filter((e) => e.startsWith('calls Chart@'))).toEqual([]);
}

describe('an import spelled with a trailing slash or a `.`, `..` or empty segment (#2577)', () => {
  it('links like the plain spelling', () => {
    expectLinked('src/Plain.tsx', 'src/widgets/Chart/index.tsx');
  });

  it('with a trailing slash', () => {
    expectLinked('src/TrailingSlash.tsx', 'src/widgets/Chart/index.tsx');
  });

  it('with a `.` segment, a doubled slash and a `..` segment', () => {
    expectLinked('src/DotSegment.tsx', 'src/widgets/Chart/index.tsx');
    expectLinked('src/DoubleSlash.tsx', 'src/widgets/Chart/index.tsx');
    expectLinked('src/DotDot.tsx', 'src/widgets/Chart/index.tsx');
  });

  it('a trailing slash names the folder, not a same-named file beside it', () => {
    expectLinked('src/Folder.tsx', 'src/cards/Card/index.tsx');
    expect(edgesFrom('src/Folder.tsx')).not.toContain('calls Legend@src/cards/Card.tsx');
  });

  it('through a workspace member', () => {
    expectLinked('packages/app/src/Member.tsx', 'packages/ui/index.tsx');
    expect(edgesFrom('packages/app/src/MemberPath.ts')).toEqual(expect.arrayContaining([
      'imports legend.ts@packages/ui/widgets/legend.ts',
      'calls Legend@packages/ui/widgets/legend.ts',
    ]));
  });
});
