/**
 * An import specifier spelled with a trailing slash (`@/widgets/Chart/`) or a
 * `.` segment (`src/widgets/./Chart`) names the same file as its plain
 * spelling, and resolves to that file's indexed path (#2577). Before, the
 * fallback-alias and direct-path branches returned the spelling as written
 * (`src/widgets/Chart//index.tsx`), which the disk probe accepts but no
 * lookup keyed by the indexed path finds: the lazily loaded component and
 * the file import were lost.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveImportPath } from '../src/resolution/import-resolver';
import type { ResolutionContext } from '../src/resolution';

/** A context whose `fileExists` accepts any spelling the filesystem would. */
function contextWithFiles(files: string[]): ResolutionContext {
  const set = new Set(files);
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (p: string) => set.has(path.posix.normalize(p)),
    readFile: () => null,
    getProjectRoot: () => '/test',
    getAllFiles: () => files,
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  } as unknown as ResolutionContext;
}

describe('resolveImportPath returns the indexed spelling of a path', () => {
  const ctx = contextWithFiles(['src/App.tsx', 'src/widgets/Chart/index.tsx', 'src/lib/util.ts']);

  it('drops the doubled slash a trailing-slash specifier leaves', () => {
    expect(resolveImportPath('@/widgets/Chart/', 'src/App.tsx', 'tsx', ctx)).toBe('src/widgets/Chart/index.tsx');
  });

  it('drops a `.` segment', () => {
    expect(resolveImportPath('src/widgets/./Chart', 'src/App.tsx', 'tsx', ctx)).toBe('src/widgets/Chart/index.tsx');
    expect(resolveImportPath('@/./lib/util', 'src/App.tsx', 'tsx', ctx)).toBe('src/lib/util.ts');
  });

  it('folds a `..` segment', () => {
    expect(resolveImportPath('src/widgets/../lib/util', 'src/App.tsx', 'tsx', ctx)).toBe('src/lib/util.ts');
  });

  it('leaves the plain spelling unchanged', () => {
    expect(resolveImportPath('@/widgets/Chart', 'src/App.tsx', 'tsx', ctx)).toBe('src/widgets/Chart/index.tsx');
    expect(resolveImportPath('./lib/util', 'src/App.tsx', 'tsx', ctx)).toBe('src/lib/util.ts');
  });
});

describe('an import spelled with a trailing slash or a `.` segment (#2577)', () => {
  let root = '';
  let cg: CodeGraph;

  // One importing file per spelling of the same folder.
  const SPELLINGS: Record<string, string> = {
    Plain: '@/widgets/Chart',
    Slash: '@/widgets/Chart/',
    Dot: 'src/widgets/./Chart',
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-spelling-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { react: '^18' } }),
      'src/widgets/Chart/index.tsx': `export default function ChartView() { return null; }
export function Legend() { return 1; }
`,
    };
    for (const [label, spec] of Object.entries(SPELLINGS)) {
      files[`src/App${label}.tsx`] = `import { lazy } from 'react';
import { Legend } from '${spec}';
const Chart = lazy(() => import('${spec}'));
export function App${label}() { Legend(); return <Chart />; }
`;
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `kind -> name@file` for every non-`contains` edge out of a node. */
  const edgesFrom = (nodeId: string): string[] =>
    cg.getOutgoingEdges(nodeId)
      .filter((e) => e.kind !== 'contains')
      .map((e) => {
        const target = cg.getNode(e.target)!;
        return `${e.kind} -> ${target.name}@${target.filePath}`;
      })
      .sort();

  const fileNode = (filePath: string) =>
    cg.getNodesByKind('file').find((n) => n.filePath === filePath)!;
  const appNode = (label: string) =>
    cg.getNodesByKind('function').find((n) => n.name === `App${label}`)!;

  for (const [label, spec] of Object.entries(SPELLINGS)) {
    it(`links the lazy component and the file import for '${spec}'`, () => {
      const fromApp = edgesFrom(appNode(label).id);
      expect(fromApp).toContain('calls -> ChartView@src/widgets/Chart/index.tsx');
      expect(fromApp).toContain('calls -> Legend@src/widgets/Chart/index.tsx');
      // Not the file's own `Chart` const standing in for the component.
      expect(fromApp).not.toContain(`calls -> Chart@src/App${label}.tsx`);
      expect(edgesFrom(fileNode(`src/App${label}.tsx`).id)).toContain(
        'imports -> index.tsx@src/widgets/Chart/index.tsx',
      );
    });
  }
});
