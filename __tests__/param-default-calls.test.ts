/**
 * A call written in a parameter's default value belongs to the function
 * (#2588).
 *
 *   export function renderWithNote(note = buildNote()) { … }
 *
 * JavaScript evaluates a default on every call that omits the argument, in the
 * function's own scope, so `renderWithNote` calls `buildNote`. The extractor
 * pushed the function and walked only its body, so the call was never seen:
 * no edge and no unresolved reference. Now each parameter's default value is
 * walked while the function is the enclosing node — for functions, arrows,
 * class methods and arrow class fields, HOC-wrapped components, and defaults
 * nested in destructuring patterns — by both the wasm extractor and the
 * native kernel. An anonymous function's defaults go where its body's calls
 * go: to the enclosing node.
 *
 * Python is deliberately left alone: `def f(x=g())` runs `g()` once, when the
 * `def` executes, so `f` does not call `g`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const kernelBuilt = fs.existsSync(path.join(
  __dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node'
));

const roots: string[] = [];
const savedKernel = process.env.CODEGRAPH_KERNEL;

afterEach(() => {
  if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = savedKernel;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** `<source name> <kind> <target name>` for every calls/instantiates edge. */
function flowEdges(cg: CodeGraph, files: string[]): string[] {
  const nodes = files.flatMap((f) => cg.getNodesInFile(f));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return cg
    .getOutgoingEdgesFrom(nodes.map((n) => n.id))
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => `${byId.get(e.source)?.name} ${e.kind} ${cg.getNode(e.target)?.name}`)
    .sort();
}

const TS = `export function buildNote() { return { id: 1 }; }
export class Note { id = 1; }
export function renderWithNote(note = buildNote()) { return note.id; }
export const arrow = (note = buildNote()) => note.id;
export class K { m(note = buildNote()) { return note.id; } }
export function destr({ n } = buildNote() as any) { return n; }
export function nested({ n = buildNote().id } = {}) { return n; }
export function made(note = new Note()) { return note.id; }
export function typed(note: { id: number } = buildNote()) { return note.id; }
export function optional(note?: Note) { return note; }
export function inBody() { const note = buildNote(); return note.id; }
export class Fields {
  handle = (note = buildNote()) => note.id;
  other = function (n = buildNote()) { return n; };
  wrapped = once((n = buildNote()) => n);
}
function once<T>(fn: T): T { return fn; }
`;

const TSX = `import { forwardRef, memo } from 'react';
import { buildNote } from './f';
export const Fwd = forwardRef(({ title = buildNote() }: any, ref: any) => <div ref={ref}>{title}</div>);
export const Memo = memo(function Memo({ title = buildNote() }: any) { return <div>{title}</div>; });
export const Nested = memo(forwardRef(({ title = buildNote() }: any, ref: any) => <div ref={ref}>{title}</div>));
`;

const ANON = `import { buildNote } from './f';
setTimeout((n = buildNote()) => n, 0);
export default function (n = buildNote()) { return n; }
register({ go(a = buildNote()) { return a; } });
function register(o: unknown) { return o; }
`;

const JS = `import { buildNote } from './f';
export function jsDefault(note = buildNote()) { return note; }
export const jsArrow = ({ n = buildNote() }) => n;
export function viaCallback(make = () => buildNote()) { return make(); }
`;

const PY = `def build():
    return 1

def f(x=build()):
    return x
`;

describe.each([
  ['the wasm extractor', '0', false],
  ['the native kernel', '1', !kernelBuilt],
])('a call in a parameter default, with %s', (_label, kernel, skip) => {
  it.skipIf(skip)('links the function to the call', async () => {
    process.env.CODEGRAPH_KERNEL = kernel;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-param-default-'));
    roots.push(root);
    write(root, { 'src/f.ts': TS, 'src/g.js': JS, 'src/c.tsx': TSX, 'src/anon.ts': ANON, 'py/m.py': PY });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(flowEdges(cg, ['src/f.ts', 'src/g.js', 'src/c.tsx'])).toEqual([
        'Fwd calls buildNote',
        'Memo calls buildNote',
        'Nested calls buildNote',
        'arrow calls buildNote',
        'destr calls buildNote',
        'handle calls buildNote',
        'inBody calls buildNote',
        'jsArrow calls buildNote',
        'jsDefault calls buildNote',
        'm calls buildNote',
        'made instantiates Note',
        'nested calls buildNote',
        'other calls buildNote',
        'renderWithNote calls buildNote',
        'typed calls buildNote',
        'viaCallback calls buildNote',
        'wrapped calls buildNote',
      ]);
      // An anonymous function's defaults are the enclosing scope's, as its body is.
      // An anonymous function's defaults, and a module-scope object literal
      // method's, are the enclosing scope's (here the file), as their bodies are.
      const anon = cg.getNodesInFile('src/anon.ts');
      const anonIds = new Set(anon.map((n) => n.id));
      const fileId = anon.find((n) => n.kind === 'file')?.id;
      const lines = cg.getOutgoingEdgesFrom([...anonIds])
        .filter((e) => e.kind === 'calls' && e.source === fileId && cg.getNode(e.target)?.name === 'buildNote')
        .map((e) => e.line)
        .sort();
      expect(lines).toEqual([2, 3, 4]);
      // A Python default runs when the def executes, not when f is called.
      expect(flowEdges(cg, ['py/m.py'])).not.toContain('f calls build');
    } finally {
      cg.close();
    }
  });
});
