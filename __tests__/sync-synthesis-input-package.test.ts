/**
 * A lazy value that loads a workspace package by its name — `dynamic(() =>
 * import('icons').then((mod) => mod.EdgeFunctions))` — records the module it
 * loads as a synthesis input, and the import resolves a workspace package to
 * its directory, `packages/icons`, which is no indexed file.
 * `synthesis_inputs.file_path` references `files(path)`, so recording it failed
 * the commit with "FOREIGN KEY constraint failed" and rolled back every sync
 * after an edit to that file (#2565). A full index writes its inputs through
 * the same call but swallows the failure (synthesis is best-effort there), so
 * it only left the inputs empty; both are pinned.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const APP = `import dynamic from 'next/dynamic';
const Chart = dynamic(() => import('icons').then((mod) => mod.EdgeFunctions));
export function App() { return <Chart />; }
`;

const FILES: Record<string, string> = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { react: '^18', next: '^14' } }),
  'packages/icons/package.json': JSON.stringify({ name: 'icons', main: './src/icons/index.ts' }),
  'packages/icons/src/icons/index.ts': 'export function EdgeFunctions() { return null; }\n',
  'src/App.tsx': APP,
};

let root: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** The files recorded as synthesis inputs. */
function inputs(graph: CodeGraph): string[] {
  const db = (graph as any).db.db;
  return db.prepare('SELECT file_path FROM synthesis_inputs ORDER BY file_path').all().map((r: any) => r.file_path);
}


function write(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

/** `<parent> -> <file>::<child>` for every synthesized JSX render edge. */
function renders(graph: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of graph.getFiles()) {
    for (const node of graph.getNodesInFile(file.path)) {
      for (const e of graph.getOutgoingEdges(node.id)) {
        if (e.metadata?.synthesizedBy !== 'jsx-render') continue;
        const child = graph.getNode(e.target);
        out.push(`${node.name} -> ${child?.filePath}::${child?.name}`);
      }
    }
  }
  return out.sort();
}

let fresh: CodeGraph | undefined;
let freshRoot: string | undefined;
afterEach(() => {
  fresh?.close();
  fresh = undefined;
  if (freshRoot) fs.rmSync(freshRoot, { recursive: true, force: true });
  freshRoot = undefined;
});

describe('synthesis inputs from a lazily loaded workspace package (#2565)', () => {
  it('records the loading file as an input, and a sync after an edit to it succeeds', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2565-'));
    write(root, FILES);
    cg = await CodeGraph.init(root, { index: true });
    expect(inputs(cg)).toContain('src/App.tsx');
    expect(inputs(cg)).not.toContain('packages/icons');

    fs.appendFileSync(path.join(root, 'src/App.tsx'), '// touched\n');
    await expect(cg.sync()).resolves.toBeDefined();

    const indexed = new Set(cg.getFiles().map((f) => f.path));
    expect(indexed.has('src/App.tsx')).toBe(true);
    expect(indexed.has('packages/icons')).toBe(false);
    expect(inputs(cg)).toContain('src/App.tsx');
    expect(inputs(cg)).not.toContain('packages/icons');
  });
  // The issue's own trigger: the edit is to ANOTHER file with markup, not the
  // one that loads the package, and every such sync failed.
  it('a sync after an edit to another file with markup succeeds', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2565-'));
    write(root, { ...FILES, 'src/Other.tsx': 'export function Other() { return <div />; }\n' });
    cg = await CodeGraph.init(root, { index: true });

    fs.appendFileSync(path.join(root, 'src/Other.tsx'), '// touched\n');
    await expect(cg.sync()).resolves.toBeDefined();
  });

  // An input is matched to the indexed file by its path, so a module spelled
  // with a trailing slash or a `.` segment (`import('@/widgets/Chart/')`) must
  // still be recorded under the file's own path: dropping it left the barrel
  // out of the inputs, and rewiring the barrel never redrew the tag.
  it.each([['@/widgets/Chart/'], ['src/widgets/./Chart']])(
    'records a module spelled %s under its indexed path, so rewiring it redraws the tag',
    async (spec) => {
      const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18', next: '^14' } }),
        'src/App.tsx': `import dynamic from 'next/dynamic';\nconst Chart = dynamic(() => import('${spec}'));\nexport function App() { return <Chart />; }\n`,
        'src/widgets/Chart/index.ts': "export { default } from './Impl';\n",
        'src/widgets/Chart/Impl.tsx': 'export default function ImplA() { return null; }\n',
        'src/widgets/Chart/Other.tsx': 'export default function Other() { return null; }\n',
      };
      const rewired = { ...files, 'src/widgets/Chart/index.ts': "export { default } from './Other';\n" };
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2565-'));
      write(root, files);
      cg = await CodeGraph.init(root, { index: true });
      expect(inputs(cg)).toContain('src/widgets/Chart/index.ts');

      write(root, rewired);
      await cg.sync();

      freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2565-fresh-'));
      write(freshRoot, rewired);
      fresh = await CodeGraph.init(freshRoot, { index: true });
      expect(renders(fresh)).toEqual(['App -> src/widgets/Chart/Other.tsx::Other']);
      expect(renders(cg)).toEqual(renders(fresh));
    }
  );
});
