/**
 * TypeScript 5.0's type-only re-export of a whole module parses (#2474):
 *
 *   export { FooClient, type FooClientOptions } from "./client.js";
 *   export type * from "./types.js";
 *   export type * as Shapes from "./shapes.js";
 *
 * The grammar has no rule for `export type *` (upstream's neither), so `type`
 * parsed as an error. A barrel of re-exports was then reported as producing no
 * symbols, `codegraph status` listed it among the files it could not parse,
 * and the native kernel handed every file holding such a line to the wasm
 * parser. The TypeScript extractor's preParse now blanks that `type` to spaces
 * where a statement starts, offsets kept, so the line reads as the `export *`
 * it is to the graph, and both engines parse the same bytes. The import
 * resolver reads the statement as written from the file, so a name imported
 * through the barrel still reaches the file that declares it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, tryKernelExtractRaw, resetKernelForTests } from '../src/extraction/kernel';
import { blankExportTypeStar, blanksExportTypeStar } from '../src/extraction/languages/typescript';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

/** The issue's barrel, plus the namespace form. */
const BARREL = [
  'export { FooClient, FooApiError, type FooClientOptions } from "./client.js";',
  'export { DAYS_OF_WEEK } from "./types.js";',
  'export type * from "./types.js";',
  'export type * as Shapes from "./shapes.js";',
  '',
].join('\n');

/** Each statement of the barrel, as its import node keeps it. */
const BARREL_STATEMENTS = BARREL.split('\n').filter(Boolean);

describe('blankExportTypeStar', () => {
  it('blanks the `type` of a type-only star re-export, keeping every offset', () => {
    const cases: Array<[string, string]> = [
      ['export type * from "./types";', 'export      * from "./types";'],
      ['export type * as Types from "./types";', 'export      * as Types from "./types";'],
      ["export type * as 'my types' from './types';", "export      * as 'my types' from './types';"],
      ['export type *from"./types";', 'export      *from"./types";'],
      ['export\ttype\t*\tfrom "./types";', 'export\t    \t*\tfrom "./types";'],
      // `from` on the next line.
      ['export type *\n  from "./types";', 'export      *\n  from "./types";'],
      // Indented in an ambient module, and after `{`, `;` or a block comment on the same line.
      ['declare module "m" {\n  export type * from "./y";\n}', 'declare module "m" {\n  export      * from "./y";\n}'],
      ['declare module "m" { export type * from "./y"; }', 'declare module "m" { export      * from "./y"; }'],
      ['export * from "./a"; export type * from "./b";', 'export * from "./a"; export      * from "./b";'],
      ['/* types */ export type * from "./b";', '/* types */ export      * from "./b";'],
      ['export * from "./a";\r\nexport type * from "./b";\r\n', 'export * from "./a";\r\nexport      * from "./b";\r\n'],
    ];
    for (const [source, expected] of cases) {
      const blanked = blankExportTypeStar(source);
      expect(blanked).toBe(expected);
      expect(blanked).toHaveLength(source.length);
    }
  });

  it('leaves everything else as written', () => {
    for (const source of [
      'export type Star = "*";',
      'export type { A } from "./a";',
      'export { type A } from "./a";',
      'export * from "./a";',
      'export * as ns from "./a";',
      // Not where a statement starts: a mention in a comment, a doc or a string.
      '// Re-export them with export type * from "./types".',
      '/**\n * export type * from "./types";\n */',
      'const hint = "export type * from \'./types\'";',
    ]) {
      expect(blankExportTypeStar(source)).toBe(source);
    }
  });
});

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a type-only star re-export parses in both engines', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    // Null when the kernel defers the file to the wasm parser, as it does every file with a parse error.
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    for (const [file, language] of [
      ['src/index.ts', 'typescript'],
      ['src/index.tsx', 'tsx'],
    ] as const) {
      it.each(backends)(`a barrel in ${file}${crlf ? ' (CRLF)' : ''}: %s`, (backend) => {
        const result = extract(backend, file, eol(BARREL), language);
        expect(result.errors).toEqual([]);
        // Each statement imports its module, as `export * from` does.
        expect(result.nodes.filter((n) => n.kind === 'import').map((n) => `${n.name}@${n.startLine}`)).toEqual([
          './client.js@1',
          './types.js@2',
          './types.js@3',
          './shapes.js@4',
        ]);
        expect(result.unresolvedReferences.map((r) => `${r.referenceName}@${r.line}`).sort()).toEqual([
          './client.js@1',
          './shapes.js@4',
          './types.js@2',
          './types.js@3',
          'DAYS_OF_WEEK@2',
          'FooApiError@1',
          'FooClient@1',
          'FooClientOptions@1',
        ]);
        // Each import node keeps its statement as written, `type` included.
        expect(result.nodes.filter((n) => n.kind === 'import').map((n) => n.signature)).toEqual(BARREL_STATEMENTS);
      });
    }
  }

  it.runIf(kernelAvailable)('keeps a re-export as written in a file the kernel hands to the wasm parser', () => {
    // `export const = ;` is an error, so the kernel defers the whole file.
    const source = 'export type * from "./types.js";\nexport const = ;\n';
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    expect(tryKernelExtract('src/broken.ts', source, 'typescript')).toBeNull();
    const result = extractFromSource('src/broken.ts', source, 'typescript');
    expect(result.nodes.filter((n) => n.kind === 'import').map((n) => n.signature)).toEqual([
      'export type * from "./types.js";',
    ]);
  });

  it.runIf(kernelAvailable)('leaves the undecoded kernel path to files with nothing to keep as written', () => {
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    // Its import nodes' text is restored on the decoded path, which the parse worker falls back to.
    expect(tryKernelExtractRaw('src/index.ts', BARREL, 'typescript')).toBeNull();
    const plain = 'export { FooClient } from "./client.js";\nexport * from "./types.js";\n';
    expect(tryKernelExtractRaw('src/plain.ts', plain, 'typescript')).not.toBeNull();
    expect(blanksExportTypeStar(BARREL)).toBe(true);
    expect(blanksExportTypeStar(plain)).toBe(false);
    // A mention only in a comment blanks nothing.
    expect(blanksExportTypeStar('// prefer export type * from "./types"\nexport * from "./types";\n')).toBe(false);
  });

  it.each(backends)('in a declaration file\'s declare module body: %s', (backend) => {
    const source = 'declare module "sdk" {\n  export type * from "./types";\n  export function connect(): void;\n}\n';
    const result = extract(backend, 'typings/sdk.d.ts', source, 'typescript');
    expect(result.errors).toEqual([]);
    expect(result.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind} ${n.name}`)).toEqual([
      'import ./types',
      'function connect',
    ]);
  });

  it.runIf(kernelAvailable)('the kernel and the wasm extractor agree', () => {
    const canon = (r: ExtractionResult) => [
      ...r.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort(),
      ...r.unresolvedReferences.map((ref) => JSON.stringify(ref, Object.keys(ref).sort())).sort(),
    ];
    for (const [file, language] of [
      ['src/index.ts', 'typescript'],
      ['src/index.tsx', 'tsx'],
    ] as const) {
      expect(canon(extract('kernel', file, BARREL, language))).toEqual(canon(extract('wasm', file, BARREL, language)));
    }
  });
});

describe('indexing a barrel with `export type *` (#2474)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-export-type-star-'));
    const files: Record<string, string> = {
      'packages/sdk/src/client.ts':
        'export interface FooClientOptions { baseUrl: string }\n' +
        'export class FooApiError extends Error {}\n' +
        'export class FooClient {\n' +
        '  constructor(private opts: FooClientOptions) {}\n' +
        '  get(path: string) { return this.opts.baseUrl + path; }\n' +
        '}\n',
      'packages/sdk/src/types.ts': "export const DAYS_OF_WEEK = ['mon', 'tue'];\nexport type Schedule = { day: string };\n",
      'packages/sdk/src/shapes.ts': 'export interface Circle { radius: number }\n',
      'packages/sdk/src/index.ts': BARREL,
      // Same names, declared where nothing re-exports them: what a name match could pick.
      'app/shapes.ts': 'export interface FooClientOptions { decoy: true }\nexport type Schedule = { decoy: true };\n',
      'app/main.ts':
        'import { FooClient, type FooClientOptions } from "../packages/sdk/src/index.js";\n' +
        'import type { Schedule } from "../packages/sdk/src/index.js";\n' +
        'export function run(o: FooClientOptions, s: Schedule) {\n' +
        '  return new FooClient(o).get(s.day);\n' +
        '}\n',
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

  it('stores the barrel without a parse error', () => {
    const barrel = cg.getFile('packages/sdk/src/index.ts');
    expect(barrel).not.toBeNull();
    expect(barrel!.errors ?? []).toEqual([]);
  });

  it('stores each re-export as written', () => {
    const imports = cg.getNodesInFile('packages/sdk/src/index.ts').filter((n) => n.kind === 'import');
    expect(imports.sort((a, b) => a.startLine - b.startLine).map((n) => n.signature)).toEqual(BARREL_STATEMENTS);
  });

  it('links each name imported through the barrel to the file that declares it', () => {
    const ids = cg.getNodesInFile('app/main.ts').map((n) => n.id);
    const imported = cg
      .getOutgoingEdgesFrom(ids, ['imports'])
      .map((e) => cg.getNode(e.target)!)
      .filter((t) => t.kind !== 'file')
      .map((t) => `${t.name} -> ${t.filePath}`)
      .sort();
    expect(imported).toEqual([
      'FooClient -> packages/sdk/src/client.ts',
      'FooClientOptions -> packages/sdk/src/client.ts',
      // Reached only through `export type * from "./types.js"`.
      'Schedule -> packages/sdk/src/types.ts',
    ]);
  });
});
