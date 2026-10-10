/**
 * A barrel's type-only re-exports are re-exports: `export type * from
 * './types'` (TypeScript 5.0), `export type { Options } from './options'`, and
 * a `type` modifier on one name of a list. The re-export reader knew none of
 * the three, so a name imported through one was matched by name instead — the
 * right declaration while the name was unique, any same-named one otherwise.
 * `export type *` is also not in the grammar: the file parsed with an error,
 * and a barrel made only of it "produced no symbols" (#2474).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { blankExportTypeStar } from '../src/extraction/languages/typescript';
import { extractReExports } from '../src/resolution/import-resolver';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-type-reexport-'));
  const files: Record<string, string> = {
    'src/client.ts': `export class Client {}
export interface ClientOptions { retries: number }
`,
    'src/options.ts': `export interface Options { verbose: boolean }
`,
    'src/types.ts': `export interface Extra { tag: string }
`,
    // Same names, declared where nothing re-exports them: what name matching may pick.
    'src/legacy/shapes.ts': `export interface ClientOptions { old: true }
export interface Options { old: true }
export interface Extra { old: true }
`,
    'src/index.ts': `export { Client, type ClientOptions } from './client';
export type { Options } from './options';
export type * from './types';
`,
    'src/app.ts': `import { Client, type ClientOptions, type Options, type Extra } from './index';

export function run(options: Options, client: ClientOptions, extra: Extra): Client {
  return new Client();
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `name -> file (resolvedBy)` of what `src/app.ts` imports by name. */
const imported = () => {
  const file = cg.getNodesInFile('src/app.ts').find((n) => n.kind === 'file')!;
  return cg.getOutgoingEdges(file.id).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)!)
    .filter((t) => t.kind !== 'file').map((t) => `${t.name} -> ${t.filePath}`).sort();
};

describe('type-only re-exports through a barrel', () => {
  it('lead to the declaration the barrel re-exports, in all three forms', () => {
    expect(imported()).toEqual([
      'Client -> src/client.ts',
      'ClientOptions -> src/client.ts',
      'Extra -> src/types.ts',
      'Options -> src/options.ts',
    ]);
  });

  it('are read as re-exports', () => {
    expect(extractReExports(`export type * from './types';`, 'typescript')).toEqual([{ kind: 'wildcard', source: './types' }]);
    expect(extractReExports(`export type * as Types from './types';`, 'typescript')).toEqual([
      { kind: 'namespace', exportedName: 'Types', source: './types' },
    ]);
    expect(extractReExports(`export type { Options as Opts } from './options';`, 'typescript')).toEqual([
      { kind: 'named', exportedName: 'Opts', originalName: 'Options', source: './options' },
    ]);
    expect(extractReExports(`export { Client, type ClientOptions, type as kind } from './client';`, 'typescript')).toEqual([
      { kind: 'named', exportedName: 'Client', originalName: 'Client', source: './client' },
      { kind: 'named', exportedName: 'ClientOptions', originalName: 'ClientOptions', source: './client' },
      { kind: 'named', exportedName: 'kind', originalName: 'type', source: './client' },
    ]);
  });

  it('`export type *` reads as the `export *` it is to the grammar, offsets kept', () => {
    expect(blankExportTypeStar(`export type * from './types';\n  export type * as T from './t';`))
      .toBe(`export      * from './types';\n  export      * as T from './t';`);
    // A declared type, and a type named in a list, are not re-export-all.
    const kept = `export type Star = '*';\nexport type { A } from './a';`;
    expect(blankExportTypeStar(kept)).toBe(kept);
  });
});
