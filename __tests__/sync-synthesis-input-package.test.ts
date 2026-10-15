/**
 * A lazy value that loads a workspace package by its name — `dynamic(() =>
 * import('icons').then((mod) => mod.EdgeFunctions))` — records the module it
 * loads as a synthesis input, and the import resolves a workspace package to
 * its directory, `packages/icons`, which is no indexed file.
 * `synthesis_inputs.file_path` references `files(path)`, so recording it failed
 * the commit with "FOREIGN KEY constraint failed" and rolled back every sync
 * after an edit to that file (#2565). A full index commits inputs the same
 * way, so it is pinned too.
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

describe('synthesis inputs from a lazily loaded workspace package (#2565)', () => {
  it('a sync after an edit to the loading file succeeds', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2565-'));
    for (const [file, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    cg = await CodeGraph.init(root, { index: true });

    fs.appendFileSync(path.join(root, 'src/App.tsx'), '// touched\n');
    await expect(cg.sync()).resolves.toBeDefined();

    const indexed = new Set(cg.getFiles().map((f) => f.path));
    expect(indexed.has('src/App.tsx')).toBe(true);
    expect(indexed.has('packages/icons')).toBe(false);
  });
});
