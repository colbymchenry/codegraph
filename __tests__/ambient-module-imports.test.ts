/**
 * An import of a package the repository declares itself links to that
 * declaration.
 *
 *   // typings/mammoth/index.d.ts — a script: no top-level import or export
 *   declare module 'mammoth' {
 *     export interface MammothOptions { styleMap?: string }
 *     export function convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>;
 *   }
 *
 *   // src/editor.ts
 *   import { convertToHtml, MammothOptions } from 'mammoth';
 *
 * TypeScript looks a specifier up among the ambient modules before it resolves
 * it to a file, so `MammothOptions` here is cord-field's own declaration. The
 * index never linked it: the import resolver follows paths and aliases only,
 * and the out-of-repo guard declines every name a file binds from a package
 * its package.json declares. `convertToHtml` had nothing to link to anyway: a
 * bodiless function in an ambient context (`function_signature`) produced no
 * node, though it is the whole declaration there is.
 *
 * Now the import resolver finds the block that declares the specifier and
 * binds each name to the declaration in that block: named imports, an export
 * clause's names, the default export (`export default class`, `export =`),
 * a namespace import's members, and a namespace or default binding to the
 * declaring file. Only a script declares a module; `declare module` in a
 * module file augments the package's own, and a wildcard pattern or a
 * shorthand `declare module 'x';` declares nothing to bind. Ambient function
 * signatures are extracted by both the native kernel (when built) and the wasm
 * extractor, which must agree.
 *
 * A declaration counts where the checker can see it: its own package, one
 * nested under that, one depending on that. And an import of a module of the
 * repository's own packages is that module, whatever `.d.ts` stubs its name.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { scanAmbientModules } from '../src/resolution/ambient-modules';
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

describe('scanAmbientModules', () => {
  it('finds each block of a script, by position, and skips shorthands', () => {
    const scan = scanAmbientModules(
      [
        '/// <reference types="node" />',
        "declare module 'mammoth' {",
        "  import { ImgHTMLAttributes } from 'react';",
        '  export interface Options { a: string }',
        '}',
        "declare module '*.svg' {",
        '  const src: string;',
        '  export default src;',
        '}',
        "declare module 'shorthand';",
        'declare module "@freiraum/msgreader" { export default class MsgReader {} }',
        'interface Thenable<T> { then(): void }',
      ].join('\n')
    );
    expect(scan.script).toBe(true);
    expect(scan.blocks.map((b) => [b.specifier, b.startLine, b.startColumn, b.endLine, b.endColumn, b.defaultName, b.pattern])).toEqual([
      ['mammoth', 2, 0, 5, 0, null, false],
      // A pattern is kept, marked, to know its members; no import binds to it.
      ['*.svg', 6, 0, 9, 0, 'src', true],
      ['@freiraum/msgreader', 11, 0, 11, 73, 'MsgReader', false],
    ]);
  });

  it('reads a file with a top-level import or export as a module, and every other form as a script', () => {
    const block = "declare module 'x' { export const a: number; }\n";
    expect(scanAmbientModules(`import 'x';\n${block}`).script).toBe(false);
    expect(scanAmbientModules(`${block}export {};\n`).script).toBe(false);
    expect(scanAmbientModules(`export as namespace X;\n${block}`).script).toBe(false);
    expect(scanAmbientModules(`import fs = require('fs');\n${block}`).script).toBe(false);
    // A type that names a module, and an alias of a namespace, import nothing.
    expect(scanAmbientModules(`type T = import('y').Z;\n${block}`).script).toBe(true);
    expect(scanAmbientModules(`import Q = NS.Inner;\n${block}`).script).toBe(true);
    // An import inside a block, a comment or a string is the block's or no one's.
    expect(scanAmbientModules(`declare module 'y' { import { a } from 'x'; }\n// import x from 'z'\nconst s = "export";\n`).script).toBe(true);
  });

  it('reads what a block exports as its default, and the names an export clause gives', () => {
    const scan = scanAmbientModules(
      [
        "declare module 'a' { const main: Main; export = main; }",
        "declare module 'b' { export default abstract class Base {} }",
        "declare module 'c' { export default function convert(): void; }",
        "declare module 'd' { const tool: Tool; export default tool; }",
        "declare module 'e' { interface Hidden {} function helper(): void; export { Hidden as Shown, helper, helper as default }; }",
      ].join('\n')
    );
    expect(scan.blocks.map((b) => [b.specifier, b.defaultName, Object.fromEntries(b.exportAliases)])).toEqual([
      ['a', 'main', {}],
      ['b', 'Base', {}],
      ['c', 'convert', {}],
      ['d', 'tool', {}],
      ['e', 'helper', { Shown: 'Hidden', helper: 'helper' }],
    ]);
  });

  it('is not fooled by braces in strings, comments and template literal types', () => {
    const scan = scanAmbientModules(
      [
        "declare module 'tricky' {",
        "  export type Open = '{';",
        '  /* } a closing brace in a comment */',
        '  // and one } more',
        '  export type Path = `${string}/{id}/${number}`;',
        '  export interface Last { x: `}` }',
        '}',
        "declare module 'after' { export const y: 1; }",
      ].join('\r\n')
    );
    expect(scan.blocks.map((b) => [b.specifier, b.startLine, b.endLine])).toEqual([
      ['tricky', 1, 7],
      ['after', 8, 8],
    ]);
  });
});

/**
 * Bodiless functions in a module file: ambient ones, and an overload before its
 * implementation. Its `declare module` body augments the package's own module,
 * and a namespace's function is only reached through the namespace.
 */
const AMBIENT_SOURCE = `declare function acquireApi(): Api;
declare module 'mammoth' {
  export function convertToHtml(input: Input): Promise<Result>;
  export declare function extractRawText(input: Input): Promise<Result>;
  function internal(): void;
}
declare global {
  function structuredLog(message: string): void;
}
declare namespace Plugins {
  function register(name: string): void;
}
export function overloaded(a: number): number;
export function overloaded(a: string): string;
export function overloaded(a: unknown): unknown { return a; }
`;

/** A script declaration file: a module declared whole, and a global. */
const DECLARATION_SCRIPT_SOURCE = `declare module 'mammoth' {
  export function convertToHtml(input: Input): Promise<Result>;
  export declare function extractRawText(input: Input): Promise<Result>;
  function internal(): void;
  namespace sub {
    function hidden(): void;
  }
}
declare function acquireVsCodeApi(): unknown;
`;

/** A module-style declaration file, as tsc emits one, or written by hand. */
const DECLARATION_FILE_SOURCE = `export declare function emitted(value: string): void;
export function handWritten(value: number): void;
export function handWritten(value: string): void;
export declare namespace clipboards {
  export function write(text: string): Promise<void>;
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a bodiless function in an ambient context is a function', () => {
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
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  /** `name@line exported` for every function node. */
  const functions = (result: ExtractionResult): string[] =>
    result.nodes.filter((n) => n.kind === 'function').map((n) => `${n.name}@${n.startLine} ${n.isExported ? 'exported' : 'local'}`);

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`in a module file, under declare and outside a namespace or an augmentation: %s${label}`, (backend) => {
      expect(functions(extract(backend, 'src/env.ts', eol(AMBIENT_SOURCE), 'typescript'))).toEqual([
        'acquireApi@1 local',
        'structuredLog@8 exported',
        // The implementation is the function; the overloads before it are not.
        'overloaded@15 exported',
      ]);
    });

    it.each(backends)(`in a declaration file's declare module body, and its globals: %s${label}`, (backend) => {
      expect(functions(extract(backend, 'typings/mammoth.d.ts', eol(DECLARATION_SCRIPT_SOURCE), 'typescript'))).toEqual([
        'convertToHtml@2 exported',
        'extractRawText@3 exported',
        'internal@4 exported',
        'acquireVsCodeApi@9 local',
      ]);
    });

    it.each(backends)(`anywhere at a declaration file's top level: %s${label}`, (backend) => {
      expect(functions(extract(backend, 'types/index.d.ts', eol(DECLARATION_FILE_SOURCE), 'typescript'))).toEqual([
        'emitted@1 exported',
        'handWritten@2 exported',
        'handWritten@3 exported',
      ]);
    });

    it.each(backends)(`in a tsx file too: %s${label}`, (backend) => {
      const source = eol('declare function useIcon(name: string): JSX.Element;\nexport const App = () => <main>{useIcon("x")}</main>;\n');
      expect(functions(extract(backend, 'src/main.tsx', source, 'tsx'))).toContain('useIcon@1 local');
    });
  }

  it.runIf(kernelAvailable)('the kernel and the wasm extractor agree on every node', () => {
    for (const [file, source] of [
      ['src/env.ts', AMBIENT_SOURCE],
      ['typings/mammoth.d.ts', DECLARATION_SCRIPT_SOURCE],
      ['types/index.d.ts', DECLARATION_FILE_SOURCE],
    ] as const) {
      const canon = (r: ExtractionResult) =>
        r.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort();
      expect(canon(extract('kernel', file, source, 'typescript'))).toEqual(
        canon(extract('wasm', file, source, 'typescript'))
      );
    }
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

type Files = Record<string, string>;

function write(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ambient-modules-'));
  roots.push(root);
  return root;
}

/** `<kind> <target file>:<target qualified name>` for every edge leaving `file`'s nodes. */
function edgesFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains')
    .map((e) => {
      const target = cg.getNode(e.target);
      return `${e.kind} ${target?.filePath}:${target?.qualifiedName}`;
    })
    .sort();
}

const PACKAGE_JSON = JSON.stringify({
  name: 'editor',
  dependencies: {
    mammoth: '^1.6.0',
    '@freiraum/msgreader': '^1.0.0',
    'stacktrace-gps': '^3.0.0',
    'listed-lib': '^1.0.0',
    'web-vitals': '^1.1.0',
    'styled-components': '^6.1.0',
    'shorthand-lib': '^1.0.0',
  },
});

/** The repository's declarations of the packages it uses, cord-field's and happa's shapes. */
const DECLARATIONS: Files = {
  'typings/mammoth/index.d.ts': `declare module 'mammoth' {
  export interface MammothOptions { styleMap?: string }
  export interface MammothResult { value: string }
  export type MammothInput = { path: string };
  export function convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>;
  export class Converter { run(): void; }
}
`,
  'typings/msgreader.d.ts': `declare module '@freiraum/msgreader' {
  // eslint-disable-next-line import/no-default-export
  export default class MsgReader {
    constructor(buffer: ArrayBuffer);
    getFileData(): OutlookMsgData;
  }
  export interface OutlookMsgData { body: string }
}
`,
  'typings/legacy.d.ts': `declare module 'stacktrace-gps' {
  export interface IStackTraceGPS { pinpoint(frame: string): string }
  const StackTrace: IStackTraceGPS;
  export = StackTrace;
}
declare module 'listed-lib' {
  interface Unlisted { a: string }
  export interface Listed { b: string }
  function helper(): void;
  export { Unlisted as Renamed, helper };
}
declare module '*.svg' {
  const src: string;
  export default src;
}
declare module 'shorthand-lib';
`,
  'src/@types/web-vitals.d.ts': `declare module 'web-vitals' {
  export interface Metric { name: string; value: number }
  export declare function getCLS(onReport: (metric: Metric) => void, all?: boolean): void;
  export declare function getCLS(onReport: (metric: Metric) => void): void;
  export declare function getLCP(onReport: (metric: Metric) => void): void;
}
`,
  // A module file: this augments the package's own module.
  'src/@types/styled-components.d.ts': `import 'styled-components';
declare module 'styled-components' {
  export interface DefaultTheme { color: string }
}
`,
};

/** Project symbols named like the packages' own: a match by name would take them. */
const NAMESAKES: Files = {
  'src/legacy/options.ts': `export interface MammothOptions { decoy: true }
export function convertToHtml(): string { return ''; }
export class Converter { run(): void {} }
export interface DefaultTheme { decoy: true }
export function getLCP(): void {}
`,
};

const APP: Files = {
  'src/editor.ts': `import { convertToHtml, MammothOptions, Converter } from 'mammoth';
import MsgReader, { OutlookMsgData } from '@freiraum/msgreader';
import StackTraceGPS from 'stacktrace-gps';
import { Renamed, Listed, Unlisted, helper } from 'listed-lib';
import { getCLS, getLCP as lcp, Metric } from 'web-vitals';
import * as vitals from 'web-vitals';
import { DefaultTheme, css } from 'styled-components';
import { anything } from 'shorthand-lib';

export class Reader extends MsgReader {
  data(): OutlookMsgData { return this.getFileData(); }
}
export interface Row extends Listed, Renamed {}
export function render(options: MammothOptions, metric: Metric, theme: DefaultTheme): void {
  convertToHtml({ path: 'doc.docx' }, options);
  const converter = new Converter();
  converter.run();
  new MsgReader(new ArrayBuffer(1)).getFileData();
  StackTraceGPS.pinpoint('frame');
  helper();
  getCLS(() => {});
  lcp(() => {});
  vitals.getLCP(() => {});
  css\`color: \${theme.color}\`;
  console.log(anything);
  const unlisted: Unlisted = { a: '' };
}
`,
};

describe('an import of a package the repository declares itself', () => {
  it('links each name to its declaration in the block that declares the package', async () => {
    const root = tempRoot();
    write(root, { 'package.json': PACKAGE_JSON, ...DECLARATIONS, ...NAMESAKES, ...APP });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const edges = edgesFrom(cg, 'src/editor.ts');
      expect(edges).toEqual(expect.arrayContaining([
        // Named imports, a call, a type, `new`, and a method through the class.
        'imports typings/mammoth/index.d.ts:convertToHtml',
        'imports typings/mammoth/index.d.ts:MammothOptions',
        'imports typings/mammoth/index.d.ts:Converter',
        'calls typings/mammoth/index.d.ts:convertToHtml',
        'references typings/mammoth/index.d.ts:MammothOptions',
        'instantiates typings/mammoth/index.d.ts:Converter',
        'calls typings/mammoth/index.d.ts:Converter::run',
        // A default import's binding is the declaring file; the class is its default export.
        'imports typings/msgreader.d.ts:typings/msgreader.d.ts',
        'imports typings/msgreader.d.ts:OutlookMsgData',
        'extends typings/msgreader.d.ts:MsgReader',
        'instantiates typings/msgreader.d.ts:MsgReader',
        // `export =`: the module is that value, whose type has the method.
        'calls typings/legacy.d.ts:IStackTraceGPS::pinpoint',
        // An export clause renames and exports.
        'imports typings/legacy.d.ts:Unlisted',
        'imports typings/legacy.d.ts:helper',
        'calls typings/legacy.d.ts:helper',
        // Overloads, an aliased import, a namespace import's member.
        'calls src/@types/web-vitals.d.ts:getCLS',
        'calls src/@types/web-vitals.d.ts:getLCP',
        'imports src/@types/web-vitals.d.ts:src/@types/web-vitals.d.ts',
      ]));
      // Nothing the file imports from a package lands on a project namesake.
      expect(edges.filter((e) => e.includes('src/legacy/options.ts'))).toEqual([]);
      // An augmentation, a wildcard pattern and a shorthand declare nothing a
      // name binds to, and a name the block doesn't export binds to nothing.
      expect(edges.filter((e) => /DefaultTheme|:css|anything|:src$/.test(e))).toEqual([]);
      expect(edges).not.toContain('references typings/legacy.d.ts:Unlisted');
      // The class's own declaration in the file.
      expect(edges).toContain('calls typings/msgreader.d.ts:MsgReader::getFileData');
    } finally {
      cg.close();
    }
  }, 60_000);

  it('takes the declaration nearest the importing file when two apps declare the package', async () => {
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'mono', dependencies: { 'shared-lib': '^1.0.0' } }),
      'apps/a/typings/shared.d.ts': "declare module 'shared-lib' {\n  export function make(): string;\n}\n",
      'apps/b/typings/shared.d.ts': "declare module 'shared-lib' {\n  export function make(): number;\n}\n",
      'apps/a/src/use.ts': "import { make } from 'shared-lib';\nexport const a = make();\n",
      'apps/b/src/use.ts': "import { make } from 'shared-lib';\nexport const b = make();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'apps/a/src/use.ts')).toEqual([
        'calls apps/a/typings/shared.d.ts:make',
        // The import statement's module, as a relative import's links its file.
        'imports apps/a/typings/shared.d.ts:apps/a/typings/shared.d.ts',
        'imports apps/a/typings/shared.d.ts:make',
      ]);
      expect(edgesFrom(cg, 'apps/b/src/use.ts')).toEqual([
        'calls apps/b/typings/shared.d.ts:make',
        'imports apps/b/typings/shared.d.ts:apps/b/typings/shared.d.ts',
        'imports apps/b/typings/shared.d.ts:make',
      ]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('links through a catch-all path alias that maps the package to its typings folder', async () => {
    // cord-field: `"*": ["./typings/*"]` maps `mammoth` to the folder
    // `typings/mammoth`, which holds the declaration but is no module.
    const root = tempRoot();
    write(root, {
      'package.json': PACKAGE_JSON,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '*': ['./typings/*'] } } }),
      'typings/mammoth/index.d.ts': DECLARATIONS['typings/mammoth/index.d.ts']!,
      'src/use.ts': "import { convertToHtml } from 'mammoth';\nexport const html = convertToHtml({ path: 'a' });\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'src/use.ts')).toEqual([
        'calls typings/mammoth/index.d.ts:convertToHtml',
        'imports typings/mammoth/index.d.ts:convertToHtml',
        'imports typings/mammoth/index.d.ts:typings/mammoth/index.d.ts',
      ]);
    } finally {
      cg.close();
    }
  }, 60_000);
  it('binds a module function only through an import of that module, never by its bare name', async () => {
    // excalidraw's `packages/excalidraw/global.d.ts` declares untyped packages'
    // functions; `encode` there is png-chunks-encode's, and only an import of
    // that package calls it.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'draw', dependencies: { 'png-chunks-encode': '^1.0.0' } }),
      'src/global.d.ts': "declare module 'png-chunks-encode' {\n  function encode(chunks: unknown[]): Uint8Array;\n  export default encode;\n}\n",
      'src/export.ts': "import encodePng from 'png-chunks-encode';\nexport const png = (chunks: unknown[]) => encodePng(chunks);\n",
      'src/text.ts': "export function pack(text: string) { return encode(text); }\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'src/export.ts')).toContain('calls src/global.d.ts:encode');
      expect(edgesFrom(cg, 'src/text.ts')).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('reaches any declaration of the module only from a file that reaches the module', async () => {
    // vscode's own shapes. A namespace import's `vscode.TextDocument`, a name
    // from a file re-exporting the module (copilot's `vscodeTypes.ts`), and the
    // proposed API files' own declarations of `vscode` reach `vscode.d.ts`.
    // Node's `fs`, electron's `clipboard`, a `ProcessEnv` the file never
    // imports, and an LSP `TextDocument` through a barrel don't, though the
    // module declares the names.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'ext' }),
      'typings/vscode.d.ts': `declare module 'vscode' {
  export interface TextDocument { uri: string }
  export class Disposable { dispose(): void; }
  export class EventEmitter<T> { fire(data: T): void; }
  export interface FileSystem { readFile(path: string): Promise<Uint8Array> }
  export interface Clipboard { writeText(value: string): Promise<void> }
  export type ProcessEnv = { [key: string]: string };
  export namespace workspace {
    export const fs: FileSystem;
  }
  export namespace env {
    export const clipboard: Clipboard;
  }
}
`,
      'typings/vscode.proposed.watch.d.ts': `declare module 'vscode' {
  export interface Watcher extends Disposable {
    document: TextDocument;
  }
}
`,
      'src/vscodeTypes.ts': "import * as vscode from 'vscode';\nexport import TextDocument = vscode.TextDocument;\n",
      'src/ext.ts': "import * as vscode from 'vscode';\nexport function title(doc: vscode.TextDocument): string { return doc.uri; }\n",
      'src/viaShim.ts': "import { TextDocument } from './vscodeTypes';\nexport function size(doc: TextDocument): number { return doc.uri.length; }\n",
      'src/node.ts': "import { readFileSync } from 'fs';\nexport function read(): string { return readFileSync('x', 'utf8'); }\n",
      'src/main.ts': "import { clipboard } from 'electron';\nexport function copy(): void { clipboard.writeText('x'); }\n",
      'src/env.ts': "export function home(env: ProcessEnv): string { return env.HOME ?? ''; }\n",
      'src/languageModes.ts': "export { TextDocument } from 'vscode-languageserver-textdocument';\n",
      'src/html.ts': "import { TextDocument } from './languageModes';\nexport function lineCount(doc: TextDocument): number { return 0; }\n",
      // `new vscode.EventEmitter<T>()` is recorded by its last name, as a type is.
      'src/emitter.ts': "import * as vscode from 'vscode';\nexport const changed = new vscode.EventEmitter<string>();\n",
      // A file that imports the module, but binds the bare name elsewhere.
      'src/mixed.ts': "import * as vscode from 'vscode';\nimport { TextDocument } from 'vscode-languageserver-textdocument';\nexport function lines(doc: TextDocument): number { return vscode ? 0 : 1; }\n",
      // typescript-language-features' protocol.d.ts: a module augmenting a
      // package's namespace, which its `export =` hands out.
      'typings/protocol.d.ts': `import type ts from 'typescript-lib';
export = ts.server.protocol;
declare module 'typescript-lib' {
  namespace server.protocol {
    interface Response { readonly _serverType?: string }
  }
}
`,
      'src/cached.ts': "import type * as Proto from '../typings/protocol';\nexport function ok(response: Proto.Response): boolean { return !!response; }\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'src/ext.ts')).toContain('references typings/vscode.d.ts:TextDocument');
      expect(edgesFrom(cg, 'src/viaShim.ts')).toContain('references typings/vscode.d.ts:TextDocument');
      expect(edgesFrom(cg, 'src/emitter.ts')).toContain('instantiates typings/vscode.d.ts:EventEmitter');
      expect(edgesFrom(cg, 'src/cached.ts')).toContain('references typings/protocol.d.ts:Response');
      expect(edgesFrom(cg, 'src/mixed.ts').filter((e) => e.includes('typings/vscode.d.ts:TextDocument'))).toEqual([]);
      expect(edgesFrom(cg, 'typings/vscode.proposed.watch.d.ts')).toEqual(expect.arrayContaining([
        'extends typings/vscode.d.ts:Disposable',
        'references typings/vscode.d.ts:TextDocument',
      ]));
      for (const file of ['src/node.ts', 'src/env.ts', 'src/languageModes.ts', 'src/html.ts']) {
        expect(edgesFrom(cg, file).filter((e) => e.includes('typings/vscode.d.ts')), file).toEqual([]);
      }
      expect(edgesFrom(cg, 'src/main.ts')).not.toContain('imports typings/vscode.d.ts:clipboard');
    } finally {
      cg.close();
    }
  }, 60_000);

  it('never takes a test fixture’s copy of the declaration for the program’s', async () => {
    // copilot keeps fixture copies of vscode's proposed API typings, which its
    // tsconfig leaves out of the build.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'mono', dependencies: { 'shared-lib': '^1.0.0' } }),
      'typings/shared.d.ts': "declare module 'shared-lib' {\n  export function make(): string;\n}\n",
      'packages/app/test/fixtures/shared.d.ts': "declare module 'shared-lib' {\n  export function make(): number;\n}\n",
      'packages/app/src/use.ts': "import { make } from 'shared-lib';\nexport const a = make();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'packages/app/src/use.ts')).toEqual([
        'calls typings/shared.d.ts:make',
        'imports typings/shared.d.ts:make',
        'imports typings/shared.d.ts:typings/shared.d.ts',
      ]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('takes the declared module before a file a path alias maps the specifier to', async () => {
    // copilot maps `vscode` to a runtime shim for its test runner; the type
    // checker takes the ambient module first, so `TextLine` is the API's.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'ext' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { vscode: ['./src/shims/vscodeTypesShim.ts'] } } }),
      'src/shims/vscodeTypesShim.ts': 'export class Position { constructor(readonly line: number) {} }\n',
      'typings/vscode.d.ts': "declare module 'vscode' {\n  export class Position { constructor(line: number); }\n  export interface TextLine { text: string }\n}\n",
      'src/lines.ts': "import { TextLine, Position } from 'vscode';\nexport function first(line: TextLine): Position { return new Position(line.text.length); }\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const edges = edgesFrom(cg, 'src/lines.ts');
      expect(edges).toEqual(expect.arrayContaining([
        'imports typings/vscode.d.ts:TextLine',
        'references typings/vscode.d.ts:TextLine',
        'imports typings/vscode.d.ts:Position',
        'instantiates typings/vscode.d.ts:Position',
      ]));
      expect(edges.filter((e) => e.includes('vscodeTypesShim'))).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('finds a member wherever the files declaring the module merge it', async () => {
    // vscode's proposed API files add members to `vscode.d.ts`'s interfaces.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'host' }),
      'typings/vscode.d.ts': "declare module 'vscode' {\n  export interface InlineProvider {\n    provide(): void;\n  }\n}\n",
      'typings/vscode.proposed.inline.d.ts': "declare module 'vscode' {\n  export interface InlineProvider {\n    setCurrentModelId?(id: string): void;\n  }\n}\n",
      // copilot's shape: the type imported by name, held in a field.
      'src/stream.ts': "import type { InlineProvider } from 'vscode';\nexport class Wrapper {\n  private readonly _wrapped: InlineProvider;\n  constructor(provider: InlineProvider) { this._wrapped = provider; }\n  run(): void { this._wrapped.setCurrentModelId?.('w'); }\n}\n",
      'src/host.ts': "import type * as vscode from 'vscode';\nexport class Host {\n  constructor(private readonly _provider: vscode.InlineProvider) {}\n  run(): void {\n    this._provider.provide();\n    this._provider.setCurrentModelId?.('m');\n  }\n}\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'src/host.ts')).toEqual(expect.arrayContaining([
        'calls typings/vscode.d.ts:InlineProvider::provide',
        'calls typings/vscode.proposed.inline.d.ts:InlineProvider::setCurrentModelId',
      ]));
      expect(edgesFrom(cg, 'src/stream.ts')).toContain('calls typings/vscode.proposed.inline.d.ts:InlineProvider::setCurrentModelId');
    } finally {
      cg.close();
    }
  }, 60_000);
});

describe('a declare module answers the package it is in', () => {
  /** React's shape: the ESLint plugin stubs a Flow file of the `shared` package for tsc alone. */
  const FLAGS: Files = {
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'packages/eslint/package.json': JSON.stringify({ name: 'eslint-plugin' }),
    'packages/eslint/src/shared/ReactFeatureFlags.d.ts': `declare module 'shared/ReactFeatureFlags' {
  export const enableFoo: boolean;
  export const onlyDeclared: boolean;
}
`,
    'packages/eslint/src/rule.ts': "import { enableFoo, onlyDeclared } from 'shared/ReactFeatureFlags';\nexport const on = enableFoo && onlyDeclared;\n",
    'packages/reconciler/package.json': JSON.stringify({ name: 'reconciler' }),
    'packages/reconciler/src/work.js': `import { enableFoo, flagName, onlyDeclared } from 'shared/ReactFeatureFlags';
export function work() {
  return enableFoo && onlyDeclared ? flagName() : null;
}
`,
    'packages/shared/package.json': JSON.stringify({ name: 'shared' }),
    'packages/shared/ReactFeatureFlags.js': "export const enableFoo = true;\nexport function flagName() { return 'foo'; }\n",
  };

  it('never takes a real module of the repository from another package', async () => {
    const root = tempRoot();
    write(root, FLAGS);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const edges = edgesFrom(cg, 'packages/reconciler/src/work.js');
      expect(edges).toEqual(expect.arrayContaining([
        'imports packages/shared/ReactFeatureFlags.js:enableFoo',
        'imports packages/shared/ReactFeatureFlags.js:flagName',
        'calls packages/shared/ReactFeatureFlags.js:flagName',
      ]));
      // Nothing, not even a name only the stub declares, crosses into the ESLint package.
      expect(edges.filter((e) => e.includes('packages/eslint/'))).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('gives way to the real module in its own package too, and answers what only it declares', async () => {
    const root = tempRoot();
    write(root, FLAGS);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const edges = edgesFrom(cg, 'packages/eslint/src/rule.ts');
      expect(edges).toContain('imports packages/shared/ReactFeatureFlags.js:enableFoo');
      expect(edges).not.toContain('imports packages/eslint/src/shared/ReactFeatureFlags.d.ts:enableFoo');
      expect(edges).toContain('imports packages/eslint/src/shared/ReactFeatureFlags.d.ts:onlyDeclared');
    } finally {
      cg.close();
    }
  }, 60_000);

  it('keeps TypeScript’s order against a package whose module is only a declaration file', async () => {
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/types-only/package.json': JSON.stringify({ name: 'types-only', types: 'index.d.ts' }),
      'packages/types-only/index.d.ts': 'export function make(): string;\n',
      'packages/app/package.json': JSON.stringify({ name: 'app' }),
      'packages/app/typings/own.d.ts': "declare module 'types-only' {\n  export function make(): number;\n}\n",
      'packages/app/src/use.ts': "import { make } from 'types-only';\nexport const made = make();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'packages/app/src/use.ts')).toEqual([
        'calls packages/app/typings/own.d.ts:make',
        'imports packages/app/typings/own.d.ts:make',
        'imports packages/app/typings/own.d.ts:packages/app/typings/own.d.ts',
      ]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('links a module imported whole to the real file, and a namespace import’s members', async () => {
    const root = tempRoot();
    write(root, {
      ...FLAGS,
      'packages/eslint/src/whole.ts': "import * as flags from 'shared/ReactFeatureFlags';\nimport 'shared/ReactFeatureFlags';\nexport const name = flags.flagName();\n",
      'packages/reconciler/src/whole.js': "import * as flags from 'shared/ReactFeatureFlags';\nexport const name = flags.flagName();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      for (const file of ['packages/eslint/src/whole.ts', 'packages/reconciler/src/whole.js']) {
        const edges = edgesFrom(cg, file);
        expect(edges, file).toEqual(expect.arrayContaining([
          'imports packages/shared/ReactFeatureFlags.js:packages/shared/ReactFeatureFlags.js',
          'calls packages/shared/ReactFeatureFlags.js:flagName',
        ]));
        expect(edges.filter((e) => e.includes('.d.ts')), file).toEqual([]);
      }
    } finally {
      cg.close();
    }
  }, 60_000);

  it('keeps a test’s stub to the tests of its own package, behind the real module', async () => {
    // `packages/react/src/__tests__/testDefinitions/` declares `react`, the
    // workspace's own package, and `prop-types`, an npm one, for a TypeScript test.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/react/package.json': JSON.stringify({ name: 'react', main: 'index.js' }),
      'packages/react/index.js': "export function createElement() { return null; }\n",
      'packages/react/src/__tests__/testDefinitions/React.d.ts': "declare module 'react' {\n  export function createElement(): unknown;\n}\n",
      'packages/react/src/__tests__/testDefinitions/PropTypes.d.ts': "declare module 'prop-types' {\n  export function string(): unknown;\n}\n",
      'packages/react/src/__tests__/Own-test.ts': "import { createElement } from 'react';\nimport { string } from 'prop-types';\nexport const made = [createElement(), string()];\n",
      'packages/dom/package.json': JSON.stringify({ name: 'dom', peerDependencies: { react: '*' } }),
      'packages/dom/src/__tests__/Dom-test.js': "import { createElement } from 'react';\nimport { string } from 'prop-types';\nexport const made = [createElement(), string()];\n",
      'packages/dom/src/render.js': "import { string } from 'prop-types';\nexport const made = string();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const own = edgesFrom(cg, 'packages/react/src/__tests__/Own-test.ts');
      expect(own).toContain('calls packages/react/index.js:createElement');
      expect(own).toContain('calls packages/react/src/__tests__/testDefinitions/PropTypes.d.ts:string');
      expect(own.filter((e) => e.includes('React.d.ts'))).toEqual([]);
      const other = edgesFrom(cg, 'packages/dom/src/__tests__/Dom-test.js');
      expect(other).toContain('calls packages/react/index.js:createElement');
      expect(other.filter((e) => e.includes('testDefinitions'))).toEqual([]);
      expect(edgesFrom(cg, 'packages/dom/src/render.js')).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('is no rival to a real namesake where it does not count', async () => {
    // `createRef` passes through `packages/react`'s barrels as a binding the
    // import resolver doesn't follow; a name match finds it, and a stub's
    // bodiless `createRef` in another package must not stand in its way.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/react/package.json': JSON.stringify({ name: 'react', main: 'index.js' }),
      'packages/react/index.js': "export { createRef } from './src/ReactClient';\n",
      'packages/react/src/ReactClient.js': "import { createRef } from './ReactCreateRef';\nexport { createRef };\n",
      // A `@flow` file is read as TSX, which ranks with the stub's TypeScript.
      'packages/react/src/ReactCreateRef.js': '/** @flow */\nexport function createRef() { return { current: null }; }\n',
      'packages/react/src/__tests__/testDefinitions/React.d.ts': "declare module 'react' {\n  export function createRef(): unknown;\n}\n",
      'fixtures/clock/package.json': JSON.stringify({ name: 'clock', dependencies: { react: '^19.0.0' } }),
      'fixtures/clock/src/Clock.js': "import { createRef } from 'react';\nexport const faceRef = createRef();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const edges = edgesFrom(cg, 'fixtures/clock/src/Clock.js');
      expect(edges).toContain('calls packages/react/src/ReactCreateRef.js:createRef');
      expect(edges.filter((e) => e.includes('.d.ts'))).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('answers its own package when it is the only answer, and no sibling', async () => {
    const stub = "declare module 'untyped-lib' {\n  export function make(): string;\n  export interface Made { id: string }\n}\n";
    const use = "import { make, Made } from 'untyped-lib';\nexport const made: Made = make();\n";
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      'packages/typed/package.json': JSON.stringify({ name: 'typed', dependencies: { 'untyped-lib': '^1.0.0' } }),
      'packages/typed/typings/lib.d.ts': stub,
      'packages/typed/src/use.ts': use,
      'packages/typed/src/deep/nested/use.ts': use,
      'packages/listed/package.json': JSON.stringify({ name: 'listed', dependencies: { 'untyped-lib': '^1.0.0' } }),
      'packages/listed/src/use.ts': use,
      'packages/unlisted/package.json': JSON.stringify({ name: 'unlisted' }),
      'packages/unlisted/src/use.ts': use,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      for (const file of ['packages/typed/src/use.ts', 'packages/typed/src/deep/nested/use.ts']) {
        expect(edgesFrom(cg, file), file).toEqual([
          'calls packages/typed/typings/lib.d.ts:make',
          'imports packages/typed/typings/lib.d.ts:Made',
          'imports packages/typed/typings/lib.d.ts:make',
          'imports packages/typed/typings/lib.d.ts:packages/typed/typings/lib.d.ts',
          'references packages/typed/typings/lib.d.ts:Made',
        ]);
      }
      expect(edgesFrom(cg, 'packages/listed/src/use.ts')).toEqual([]);
      expect(edgesFrom(cg, 'packages/unlisted/src/use.ts')).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('answers a package that depends on the one it is in', async () => {
    // Astro's `client.d.ts` declares `astro:assets`, and each project on `astro` reads it.
    const use = "import { getImage } from 'astro:assets';\nexport const image = getImage();\n";
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'astro-monorepo', private: true, workspaces: ['packages/*', 'examples/*'] }),
      'packages/astro/package.json': JSON.stringify({ name: 'astro' }),
      'packages/astro/client.d.ts': "declare module 'astro:assets' {\n  export function getImage(): string;\n}\n",
      'packages/astro/src/own.ts': use,
      'packages/mdx/package.json': JSON.stringify({ name: '@astrojs/mdx', peerDependencies: { astro: '^7.0.0' } }),
      'packages/mdx/src/server.ts': use,
      'examples/blog/package.json': JSON.stringify({ name: '@example/blog', dependencies: { astro: '^7.0.0' } }),
      'examples/blog/src/pages/deep/index.ts': use,
      'examples/plain/package.json': JSON.stringify({ name: '@example/plain', dependencies: { other: '^1.0.0' } }),
      'examples/plain/src/index.ts': use,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      for (const file of ['packages/astro/src/own.ts', 'packages/mdx/src/server.ts', 'examples/blog/src/pages/deep/index.ts']) {
        expect(edgesFrom(cg, file), file).toContain('calls packages/astro/client.d.ts:getImage');
      }
      expect(edgesFrom(cg, 'examples/plain/src/index.ts')).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('answers the packages nested under the one it is in', async () => {
    // VS Code's `src/vscode-dts/vscode.d.ts` is the root package's; each extension
    // is a package of its own that its tsconfig points at the file.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'code-oss' }),
      'src/vscode-dts/vscode.d.ts': "declare module 'vscode' {\n  export class Disposable { dispose(): void; }\n  export namespace window { export const active: string; }\n}\n",
      'extensions/git/package.json': JSON.stringify({ name: 'git' }),
      'extensions/git/src/main.ts': "import { Disposable } from 'vscode';\nexport const held = new Disposable();\n",
      'extensions/git/test/fixtures/app/package.json': JSON.stringify({ name: 'fixture-app' }),
      'extensions/git/test/fixtures/app/use.ts': "import { Disposable } from 'vscode';\nexport const held = new Disposable();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      for (const file of ['extensions/git/src/main.ts', 'extensions/git/test/fixtures/app/use.ts']) {
        expect(edgesFrom(cg, file), file).toEqual(expect.arrayContaining([
          'imports src/vscode-dts/vscode.d.ts:Disposable',
          'instantiates src/vscode-dts/vscode.d.ts:Disposable',
        ]));
      }
    } finally {
      cg.close();
    }
  }, 60_000);

  it('takes a marker package.json for no package', async () => {
    // `{"type":"commonjs"}` says how Node reads a folder, as vscode's `scripts/` and `test/` do.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'untyped-lib': '^1.0.0' } }),
      'src/esm/package.json': JSON.stringify({ type: 'module' }),
      'src/esm/lib.d.ts': "declare module 'untyped-lib' {\n  export function make(): string;\n}\n",
      'src/use.ts': "import { make } from 'untyped-lib';\nexport const made = make();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'src/use.ts')).toContain('calls src/esm/lib.d.ts:make');
    } finally {
      cg.close();
    }
  }, 60_000);

  it('takes the nearest declaration a package can see, past a sibling’s nearer one', async () => {
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }),
      'typings/lib.d.ts': "declare module 'untyped-lib' {\n  export function make(): string;\n}\n",
      'apps/a/package.json': JSON.stringify({ name: 'a' }),
      'apps/a/src/deep/lib.d.ts': "declare module 'untyped-lib' {\n  export function make(): number;\n}\n",
      'apps/a/src/deep/use.ts': "import { make } from 'untyped-lib';\nexport const made = make();\n",
      'apps/b/package.json': JSON.stringify({ name: 'b' }),
      'apps/b/src/deep/use.ts': "import { make } from 'untyped-lib';\nexport const made = make();\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'apps/a/src/deep/use.ts')).toContain('calls apps/a/src/deep/lib.d.ts:make');
      expect(edgesFrom(cg, 'apps/b/src/deep/use.ts')).toContain('calls typings/lib.d.ts:make');
    } finally {
      cg.close();
    }
  }, 60_000);

  it('merges a block only with the blocks its package can see', async () => {
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
      // A class is a candidate of the fuzzy match too, which the gate on its answer stops.
      'packages/a/lib.d.ts': "declare module 'untyped-lib' {\n  export interface Made extends Base {}\n  export class Built extends Core {}\n}\n",
      'packages/b/package.json': JSON.stringify({ name: 'b' }),
      'packages/b/lib.d.ts': "declare module 'untyped-lib' {\n  export interface Base { id: string }\n  export class Core {}\n}\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'packages/a/lib.d.ts')).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('still takes a package’s declaration through a file that reaches it', async () => {
    // Importing the declaring file brings its block into the program, wherever it lives.
    const root = tempRoot();
    write(root, {
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
      'packages/a/lib.d.ts': "declare module 'untyped-lib' {\n  export interface Made { id: string }\n}\n",
      'packages/b/package.json': JSON.stringify({ name: 'b' }),
      'packages/b/src/use.ts': "import type { Made } from '../../a/lib';\nexport function id(made: Made): string { return made.id; }\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'packages/b/src/use.ts')).toContain('references packages/a/lib.d.ts:Made');
    } finally {
      cg.close();
    }
  }, 60_000);
});

/** Every edge, by its ends' natural keys, with where it is written and how it resolved. */
function edgesOf(cg: CodeGraph): string[] {
  const keys = new Map(
    cg.getFiles()
      .flatMap((file) => cg.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  return cg.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`)
    .sort();
}

async function fullIndexOf(files: Files): Promise<string[]> {
  const root = tempRoot();
  write(root, files);
  const cg = await CodeGraph.init(root, { index: true });
  try {
    return edgesOf(cg);
  } finally {
    cg.close();
  }
}

describe('sync links an import of a package once the repository declares it', () => {
  /** Bindings whose names the declaration never carries: aliased, default, namespace. */
  const importers: Files = {
    'package.json': PACKAGE_JSON,
    'src/app.ts': `import { convertToHtml as toHtml, MammothOptions } from 'mammoth';
import Reader from '@freiraum/msgreader';
import * as vitals from 'web-vitals';
export function run(options: MammothOptions): void {
  toHtml({ path: 'a' }, options);
  new Reader(new ArrayBuffer(1));
  vitals.getLCP(() => {});
}
`,
  };
  const declarations: Files = {
    'typings/mammoth/index.d.ts': DECLARATIONS['typings/mammoth/index.d.ts']!,
    'typings/msgreader.d.ts': DECLARATIONS['typings/msgreader.d.ts']!,
    'src/@types/web-vitals.d.ts': DECLARATIONS['src/@types/web-vitals.d.ts']!,
  };

  it('when the declaration file is added after its importers', async () => {
    const root = tempRoot();
    write(root, importers);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'src/app.ts').filter((e) => e.includes('.d.ts'))).toEqual([]);
      write(root, declarations);
      const result = await cg.sync();
      expect(result.filesAdded).toBe(Object.keys(declarations).length);
      expect(result.filesModified).toBe(0);
      expect(edgesFrom(cg, 'src/app.ts')).toEqual(expect.arrayContaining([
        'calls typings/mammoth/index.d.ts:convertToHtml',
        'imports typings/mammoth/index.d.ts:convertToHtml',
        'instantiates typings/msgreader.d.ts:MsgReader',
        'imports typings/msgreader.d.ts:typings/msgreader.d.ts',
        'calls src/@types/web-vitals.d.ts:getLCP',
        'imports src/@types/web-vitals.d.ts:src/@types/web-vitals.d.ts',
      ]));
      expect(edgesOf(cg)).toEqual(await fullIndexOf({ ...importers, ...declarations }));
    } finally {
      cg.close();
    }
  }, 120_000);

  it('when an edit gives the declaration what its importers import', async () => {
    const root = tempRoot();
    write(root, importers);
    write(root, Object.fromEntries(Object.keys(declarations).map((file) => [file, '// declarations to come\n'])));
    const cg = await CodeGraph.init(root, { index: true });
    try {
      write(root, declarations);
      const result = await cg.sync();
      expect(result.filesModified).toBe(Object.keys(declarations).length);
      expect(edgesFrom(cg, 'src/app.ts')).toEqual(expect.arrayContaining([
        'calls typings/mammoth/index.d.ts:convertToHtml',
        'instantiates typings/msgreader.d.ts:MsgReader',
        'imports src/@types/web-vitals.d.ts:src/@types/web-vitals.d.ts',
      ]));
      expect(edgesOf(cg)).toEqual(await fullIndexOf({ ...importers, ...declarations }));
    } finally {
      cg.close();
    }
  }, 120_000);

  describe('beside a module of the repository', () => {
    const packages: Files = {
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/eslint/package.json': JSON.stringify({ name: 'eslint-plugin' }),
      'packages/eslint/src/flags.d.ts': "declare module 'shared/flags' {\n  export const enableFoo: boolean;\n}\n",
      'packages/eslint/src/rule.ts': "import { enableFoo } from 'shared/flags';\nexport const on = enableFoo;\n",
      'packages/reconciler/package.json': JSON.stringify({ name: 'reconciler' }),
      'packages/reconciler/src/work.js': "import { enableFoo } from 'shared/flags';\nexport const on = enableFoo;\n",
      'packages/shared/package.json': JSON.stringify({ name: 'shared' }),
      'packages/shared/other.js': 'export const other = 1;\n',
    };
    const real: Files = { 'packages/shared/flags.js': 'export const enableFoo = true;\n' };

    it('moves its package’s importers to a real module that appears', async () => {
      const root = tempRoot();
      write(root, packages);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/eslint/src/flags.d.ts:enableFoo');
        expect(edgesFrom(cg, 'packages/reconciler/src/work.js')).toEqual([]);
        write(root, real);
        await cg.sync();
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/shared/flags.js:enableFoo');
        expect(edgesFrom(cg, 'packages/reconciler/src/work.js')).toContain('imports packages/shared/flags.js:enableFoo');
        expect(edgesOf(cg)).toEqual(await fullIndexOf({ ...packages, ...real }));
      } finally {
        cg.close();
      }
    }, 120_000);

    it('moves its package’s importers to a package that appears', async () => {
      const root = tempRoot();
      const { 'packages/shared/package.json': manifest, 'packages/shared/other.js': other, ...withoutPackage } = packages;
      write(root, withoutPackage);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/eslint/src/flags.d.ts:enableFoo');
        write(root, { 'packages/shared/package.json': manifest!, 'packages/shared/other.js': other!, ...real });
        await cg.sync();
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/shared/flags.js:enableFoo');
        expect(edgesOf(cg)).toEqual(await fullIndexOf({ ...packages, ...real }));
      } finally {
        cg.close();
      }
    }, 120_000);

    it('takes its package’s importers back when the real module goes', async () => {
      const root = tempRoot();
      write(root, { ...packages, ...real });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/shared/flags.js:enableFoo');
        fs.rmSync(path.join(root, 'packages/shared/flags.js'));
        await cg.sync();
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/eslint/src/flags.d.ts:enableFoo');
        expect(edgesFrom(cg, 'packages/reconciler/src/work.js')).toEqual([]);
        expect(edgesOf(cg)).toEqual(await fullIndexOf(packages));
      } finally {
        cg.close();
      }
    }, 120_000);

    it('leaves the real module’s importers on it when a stub is added', async () => {
      const root = tempRoot();
      const { 'packages/eslint/src/flags.d.ts': stub, ...withoutStub } = packages;
      write(root, { ...withoutStub, ...real });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        write(root, { 'packages/eslint/src/flags.d.ts': stub! });
        await cg.sync();
        expect(edgesFrom(cg, 'packages/eslint/src/rule.ts')).toContain('imports packages/shared/flags.js:enableFoo');
        expect(edgesFrom(cg, 'packages/reconciler/src/work.js')).toContain('imports packages/shared/flags.js:enableFoo');
        expect(edgesOf(cg)).toEqual(await fullIndexOf({ ...packages, ...real }));
      } finally {
        cg.close();
      }
    }, 120_000);
  });
});
