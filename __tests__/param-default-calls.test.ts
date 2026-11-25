/**
 * A parameter's default value is code its function runs, each time a call
 * leaves that argument out: `function render(note = buildNote())` calls
 * buildNote as surely as `const note = buildNote()` in its body would. The
 * extractors walked only the body, so a call or `new` in a default was never
 * seen (#2588). Each default, and a computed key in a destructured parameter,
 * is now walked with the function on the stack — for functions, arrows,
 * methods, constructors, class-field arrows, object-literal methods and the
 * render functions of React wrappers — in the kernel and the wasm extractor
 * alike. The names a parameter binds and its type are not code, and a Python
 * default, which runs once when the `def` does, is left as it was.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
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

const TS_SOURCE = `import { buildNote, fallback, make, pickKey, logError, Options, Service, throttle } from './lib';
export function plain(note = buildNote()) { return note; }
export const arrow = (note = buildNote()) => note;
export function destr({ n } = buildNote() as any) { return n; }
export function nested({ a = fallback(), b: { c = make() } = {} as any }: any) { return a + c; }
export function computed({ [pickKey()]: v }: any) { return v; }
export function rest(...[first = fallback()]: number[]) { return first; }
export function optional(x?: number, y: number = fallback()) { return (x ?? 0) + y; }
export function typed(x: ReturnType<typeof shape> = buildNote()) { return x; }
export function withNew(opts = new Options()) { return opts; }
export function handler(onError = (e: unknown) => logError(e)) { onError(1); }
export async function* stream(note = buildNote()) { yield note; }
export class K {
  constructor(private readonly svc = new Service()) {}
  m(note = buildNote()) { return note; }
  static s(note = buildNote()) { return note; }
  field = (note = buildNote()) => note;
  wrapped = throttle((note = fallback()) => note);
}
export const api = { load(note = buildNote()) { return note; }, save: (note = make()) => note };
export function outer() {
  function inner(note = buildNote()) { return note; }
  return inner();
}
export function over(x: number): number;
export function over(x: number = fallback()): number { return x; }
export function inBody() { return buildNote(); }
`;

const TS_EXPECTED = [
  'api::load calls buildNote',
  'api::save calls make',
  'arrow calls buildNote',
  'computed calls pickKey',
  'K::constructor instantiates Service',
  'destr calls buildNote',
  'K::field calls buildNote',
  'handler calls logError',
  'handler calls onError',
  'inBody calls buildNote',
  'outer::inner calls buildNote',
  'K::m calls buildNote',
  'K::s calls buildNote',
  'nested calls fallback',
  'nested calls make',
  'optional calls fallback',
  'outer calls inner',
  'over calls fallback',
  'plain calls buildNote',
  'rest calls fallback',
  'stream calls buildNote',
  // The type annotation's `typeof shape` is a type, not a call.
  'typed calls buildNote',
  'withNew instantiates Options',
  'K::wrapped calls fallback',
];

const JS_SOURCE = `import { buildNote, fallback, pickKey, Options } from './lib';
export function plain(note = buildNote()) { return note; }
export function nested({ a = fallback(), b: { c = buildNote() } = {} }) { return a + c; }
export function arr([x = fallback(), , y = buildNote()] = []) { return x + y; }
export function computed({ [pickKey()]: v }) { return v; }
export const arrow = (note = buildNote()) => note;
export class J {
  constructor(o = new Options()) { this.o = o; }
  m(note = buildNote()) { return note; }
  field = (note = fallback()) => note;
}
export default function (note = buildNote()) { return note; }
export function inBody() { return buildNote(); }
`;

const JS_EXPECTED = [
  'J::m calls buildNote',
  'arr calls buildNote',
  'arr calls fallback',
  'arrow calls buildNote',
  'computed calls pickKey',
  'J::constructor instantiates Options',
  'J::field calls fallback',
  'inBody calls buildNote',
  'nested calls buildNote',
  'nested calls fallback',
  'plain calls buildNote',
  // An anonymous function's code is its enclosing scope's: here, the file's.
  'src/plain.js calls buildNote',
];

const TSX_SOURCE = `import { forwardRef, memo } from 'react';
import styled from 'styled-components';
import { buildNote, fallback } from './lib';
export const Button = forwardRef(function Button({ size = fallback() }: any, ref: any) { return <b ref={ref}>{size}</b>; });
export const Card = memo(({ note = buildNote() }: any) => <i>{note}</i>);
export const Box = styled.div.attrs((p = buildNote()) => ({ p }))\`
  color: red;
\`;
export const Nested = memo(forwardRef(({ title = buildNote() }: any, ref: any) => <p ref={ref}>{title}</p>));
export function Page({ title = fallback() }: { title?: string }) { return <h1>{title}</h1>; }
setTimeout((n = fallback()) => n, 0);
`;

const TSX_EXPECTED = [
  'Box calls buildNote',
  'Button calls fallback',
  'Card calls buildNote',
  'Nested calls buildNote',
  'Page calls fallback',
  // An anonymous function's code is its enclosing scope's: here, the file's.
  'src/ui.tsx calls fallback',
  'src/ui.tsx calls setTimeout',
];

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a call in a parameter default is the function’s call (#2588)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx']);
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

  /** `caller kind callee` for every call and `new` the file records, by its caller's qualified name. */
  function callsOf(result: ExtractionResult): string[] {
    const names = new Map(result.nodes.map((n) => [n.id, n.kind === 'file' ? n.filePath : n.qualifiedName]));
    return result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls' || r.referenceKind === 'instantiates')
      .map((r) => `${names.get(r.fromNodeId)} ${r.referenceKind} ${r.referenceName}`)
      .sort();
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`in TypeScript functions, arrows, methods, fields and object literals: %s${label}`, (backend) => {
      expect(callsOf(extract(backend, 'src/use.ts', eol(TS_SOURCE), 'typescript'))).toEqual([...TS_EXPECTED].sort());
    });

    it.each(backends)(`in JavaScript, through assignment and destructuring patterns: %s${label}`, (backend) => {
      expect(callsOf(extract(backend, 'src/plain.js', eol(JS_SOURCE), 'javascript'))).toEqual([...JS_EXPECTED].sort());
      expect(callsOf(extract(backend, 'src/plain.jsx', eol(JS_SOURCE), 'jsx'))).toEqual(
        JS_EXPECTED.map((s) => s.replace('src/plain.js ', 'src/plain.jsx ')).sort()
      );
    });

    it.each(backends)(`in a React wrapper's render function and a styled attrs function: %s${label}`, (backend) => {
      expect(callsOf(extract(backend, 'src/ui.tsx', eol(TSX_SOURCE), 'tsx'))).toEqual([...TSX_EXPECTED].sort());
    });
  }

  it.runIf(kernelAvailable)('the kernel and the wasm extractor agree on every node, edge and reference', () => {
    const canon = (r: ExtractionResult) => ({
      nodes: r.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort(),
      edges: r.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
      refs: r.unresolvedReferences.map((x) => JSON.stringify(x, Object.keys(x).sort())).sort(),
    });
    for (const [file, source, language] of [
      ['src/use.ts', TS_SOURCE, 'typescript'],
      ['src/plain.js', JS_SOURCE, 'javascript'],
      ['src/ui.tsx', TSX_SOURCE, 'tsx'],
    ] as const) {
      expect(canon(extract('kernel', file, source, language)), file).toEqual(canon(extract('wasm', file, source, language)));
    }
  });
});

describe('the default value links to what it calls', () => {
  let root = '';
  let graph: CodeGraph | null = null;

  afterEach(() => {
    graph?.close();
    graph = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('gives buildNote its callers from defaults, and leaves a Python default alone', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-param-default-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'app' }),
      // The issue's reproduction, verbatim.
      'src/f.ts':
        'export function buildNote() { return { id: 1 }; }\n' +
        'export function renderWithNote(note = buildNote()) {\n  return note.id;\n}\n' +
        'export const arrow = (note = buildNote()) => note.id;\n' +
        'export class K { m(note = buildNote()) { return note.id; } }\n' +
        'export function destr({ n } = buildNote() as any) { return n; }\n' +
        'export function inBody() { const note = buildNote(); return note.id; }\n',
      // Python evaluates a default once, when the `def` runs: not the function's call.
      'tool/ctl.py': 'def build():\n    return 1\n\n\ndef uses_default(x=build()):\n    return x\n\n\ndef in_body():\n    return build()\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    graph = await CodeGraph.init(root, { index: true });

    const callers = (file: string, name: string): string[] => {
      const target = graph!.getNodesInFile(file).find((n) => n.name === name)!;
      return graph!.getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => graph!.getNode(e.source)!.name)
        .sort();
    };
    expect(callers('src/f.ts', 'buildNote')).toEqual(['arrow', 'destr', 'inBody', 'm', 'renderWithNote']);
    expect(callers('tool/ctl.py', 'build')).toEqual(['in_body']);
  }, 120_000);
});
