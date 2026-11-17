/**
 * A bare JS/TS call means the binding of its name in scope where it is
 * written:
 * - of two functions named alike in one file, each in its own `describe(…)`
 *   callback (which is no node), a call reaches the one its own block
 *   declares, however near the other is (#2944);
 * - a call after a spread, `{...register('email')}`, is as bare as one
 *   without it, so a destructured local of the name shadows every other
 *   file's `register` (#2962).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bare-scope-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

/** Every `calls` edge out of `file`'s nodes, as `<line> -> <qualifiedName>@<file>:<line>`. */
function callsIn(file: string): string[] {
  const out: string[] = [];
  for (const n of cg!.getNodesInFile(file)) {
    for (const e of cg!.getOutgoingEdges(n.id)) {
      if (e.kind !== 'calls') continue;
      const t = cg!.getNode(e.target)!;
      out.push(`${e.line} -> ${t.qualifiedName}@${t.filePath}:${t.startLine}`);
    }
  }
  return out.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const GLOBALS = 'declare function describe(name: string, fn: () => void): void;\ndeclare function it(name: string, fn: () => void): void;\n';
const PAD = Array.from({ length: 20 }, (_, i) => `  // pad ${i + 3}\n`).join('');

describe('same-named functions in two describe() callbacks (#2944)', () => {
  it('links each call to the function its own block declares', async () => {
    await index({
      'globals.d.ts': GLOBALS,
      'a.test.ts':
        "describe('first', () => {\n" +
        '  function setup(): number { return 1; }\n' +
        PAD +
        "  it('uses first', () => { setup(); });\n" +
        '});\n' +
        "describe('second', () => {\n" +
        '  function setup(): number { return 2; }\n' +
        "  it('uses second', () => { setup(); });\n" +
        '});\n',
    });
    expect(callsIn('a.test.ts').filter((c) => c.includes('setup'))).toEqual([
      '23 -> setup@a.test.ts:2',
      '27 -> setup@a.test.ts:26',
    ]);
  });

  it('does the same for arrow-function helpers', async () => {
    await index({
      'globals.d.ts': GLOBALS,
      'b.test.ts':
        "describe('first', () => {\n" +
        '  const setup = (): number => 1;\n' +
        PAD +
        "  it('uses first', () => { setup(); });\n" +
        '});\n' +
        "describe('second', () => {\n" +
        '  const setup = (): number => 2;\n' +
        "  it('uses second', () => { setup(); });\n" +
        '});\n',
    });
    expect(callsIn('b.test.ts').filter((c) => c.includes('setup'))).toEqual([
      '23 -> setup@b.test.ts:2',
      '27 -> setup@b.test.ts:26',
    ]);
  });

  it('keeps a top-level function for a call outside the block that hides it', async () => {
    await index({
      'globals.d.ts': GLOBALS,
      'c.test.ts':
        'function setup(): number { return 0; }\n' +
        "describe('inner', () => {\n" +
        '  function setup(): number { return 1; }\n' +
        "  it('uses inner', () => { setup(); });\n" +
        '});\n' +
        "describe('outer', () => {\n" +
        "  it('uses top', () => { setup(); });\n" +
        '});\n',
    });
    expect(callsIn('c.test.ts').filter((c) => c.includes('setup'))).toEqual([
      '4 -> setup@c.test.ts:3',
      '7 -> setup@c.test.ts:1',
    ]);
  });
});

describe('a call after a spread is a bare call (#2962)', () => {
  it('links no other file\'s function to a destructured local called in a spread', async () => {
    await index({
      'auth.ts': "export function register(email: string): Promise<void> { return Promise.resolve(); }\n",
      'use.tsx':
        "import { useForm } from 'react-hook-form';\n" +
        'declare function f(...a: unknown[]): void;\n' +
        'export function objSpread() {\n' +
        '  const { register } = useForm();\n' +
        "  const props = { ...register('email') };\n" +
        '  return props;\n' +
        '}\n' +
        'export function jsxSpread() {\n' +
        '  const { register } = useForm();\n' +
        "  return <input {...register('email')} />;\n" +
        '}\n' +
        'export function jsxSpreadNested() {\n' +
        '  const { register } = useForm();\n' +
        "  return <form><input {...register('email')} /></form>;\n" +
        '}\n' +
        'export function aliased() {\n' +
        '  const { reg: register } = useForm();\n' +
        "  return <input {...register('email')} />;\n" +
        '}\n' +
        'export function arraySpread() {\n' +
        '  const { register } = useForm();\n' +
        "  return [...register('x')];\n" +
        '}\n' +
        'export function argSpread() {\n' +
        '  const { register } = useForm();\n' +
        "  f(...register('x'));\n" +
        '}\n',
    });
    expect(callsIn('use.tsx').filter((c) => c.includes('auth.ts'))).toEqual([]);
  });

  it('still links a spread call of an imported or a local function', async () => {
    await index({
      'props.ts': 'export function makeProps(): object { return {}; }\n',
      'use.ts':
        "import { makeProps } from './props';\n" +
        'function local(): object { return {}; }\n' +
        'export function build() {\n' +
        '  return { ...makeProps(), ...local() };\n' +
        '}\n',
    });
    expect(callsIn('use.ts')).toEqual([
      '4 -> local@use.ts:2',
      '4 -> makeProps@props.ts:1',
    ]);
  });
});
