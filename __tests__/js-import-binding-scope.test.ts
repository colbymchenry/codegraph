/**
 * A JS/TS file's import binds a name for the whole module, but a call means
 * the binding in scope where it is written:
 * - `this.findAll()` names a member of the instance, never the file's
 *   `import { findAll }`, however the class wraps it (#2954);
 * - `stream.onAbort()` reads `stream` where it is written: a parameter or a
 *   local of that name is the receiver, and a member of an imported FUNCTION
 *   is no call of the function itself (#2953);
 * - a local, a nested function or a parameter in a function AROUND the
 *   calling one shadows the import as one in the calling function does, and
 *   the call is that local declaration's (#2949).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-import-scope-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

/** The calls made by the function or method with this qualified name, as `kind qualifiedName (file:line)`. */
function callsFrom(qualifiedName: string): string[] {
  const from = [...cg!.getNodesByKind('function'), ...cg!.getNodesByKind('method')].find((n) => n.qualifiedName === qualifiedName);
  expect(from, `${qualifiedName} should be indexed`).toBeDefined();
  return cg!.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls')
    .map((e) => { const t = cg!.getNode(e.target)!; return `${t.kind} ${t.qualifiedName} (${t.filePath}:${t.startLine})`; })
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('this.m() is the instance member, not the file import of m (#2954)', () => {
  it('links a wrapper class method and an arrow field to their own class', async () => {
    await index({
      'lib.ts':
        "export function findAll(q: string): string[] { return [q]; }\n" +
        "export const getFactor = (w: number): number => w;\n",
      'tools.ts':
        "import { findAll, getFactor } from './lib';\n" +
        "export class Tools {\n" +
        "  run(q: string) { return this.findAll(q); }\n" +
        "  private findAll(q: string): string[] { return findAll(q).concat('own'); }\n" +
        "  size(w: number) { return this.getFactor(w); }\n" +
        "  private getFactor = (w: number): number => getFactor(w) * 2;\n" +
        "}\n",
    });
    expect(callsFrom('Tools::run')).toEqual(['method Tools::findAll (tools.ts:4)']);
    expect(callsFrom('Tools::size')).toEqual(['method Tools::getFactor (tools.ts:6)']);
    // The wrappers' own bare calls still mean the import.
    expect(callsFrom('Tools::findAll')).toEqual(['function findAll (lib.ts:1)']);
  });
});

const STREAMING =
  "export interface StreamApi { onAbort(f: () => void): void; write(s: string): void; }\n" +
  "export function stream(c: unknown, cb: (s: StreamApi) => Promise<void>): Response { return null as any; }\n";

describe('x.m() reads x where it is written (#2953)', () => {
  it('takes a callback parameter named like the import for the parameter', async () => {
    await index({
      'streaming.ts': STREAMING,
      'app.ts':
        "import { stream } from './streaming';\n" +
        "export function handlerA(c: unknown) {\n" +
        "  return stream(c, async (stream) => {\n" +
        "    stream.onAbort(() => {});\n" +
        "    stream.write('x');\n" +
        "  });\n" +
        "}\n",
    });
    expect(callsFrom('handlerA')).toEqual([
      'function stream (streaming.ts:2)',
      'method StreamApi::onAbort (streaming.ts:1)',
      'method StreamApi::write (streaming.ts:1)',
    ]);
  });

  it('never links a parameter or a local named like the import to the imported function', async () => {
    await index({
      'streaming.ts': STREAMING,
      'app.ts':
        "import { stream } from './streaming';\n" +
        "export function handlerC(stream: { onAbort(f: () => void): void }) {\n" +
        "  stream.onAbort(() => {});\n" +
        "}\n" +
        "export function localConst() {\n" +
        "  const stream = { onAbort(f: () => void) {} };\n" +
        "  stream.onAbort(() => {});\n" +
        "}\n",
    });
    // (What a parameter written with an object type calls is no import's.)
    expect(callsFrom('handlerC')).not.toContain('function stream (streaming.ts:2)');
    expect(callsFrom('localConst').filter((t) => t.includes('streaming.ts'))).toEqual([]);
  });

  it('links no member of an imported function to the function, but call and apply still call it', async () => {
    await index({
      'streaming.ts': STREAMING,
      'app.ts':
        "import { stream } from './streaming';\n" +
        "export function asAny() {\n" +
        "  (stream as any).onAbort();\n" +
        "}\n" +
        "export function viaCall(c: unknown) {\n" +
        "  return stream.call(undefined, c, async () => {});\n" +
        "}\n" +
        "export function direct(c: unknown) {\n" +
        "  return stream(c, async () => {});\n" +
        "}\n",
    });
    expect(callsFrom('asAny')).toEqual([]);
    expect(callsFrom('viaCall')).toEqual(['function stream (streaming.ts:2)']);
    expect(callsFrom('direct')).toEqual(['function stream (streaming.ts:2)']);
  });
});

describe('a local shadows a project import in the functions around the call too (#2949)', () => {
  it('links each call to the binding in scope where it is written', async () => {
    await index({
      'lib.ts': "export function skipString(j: number): number { return j + 1; }\n",
      'use.ts':
        "import { skipString } from './lib';\n" +
        "export function scanA(s: string) {\n" +
        "  const skipString = (j: number): number => j + 2;\n" +
        "  return skipString(0);\n" +
        "}\n" +
        "export function scanB(s: string) {\n" +
        "  function skipString(j: number): number { return j + 3; }\n" +
        "  return skipString(0);\n" +
        "}\n" +
        "export function scanC(s: string) { return skipString(0); }\n" +
        "export function scanD(s: string) {\n" +
        "  const skipString = (j: number): number => j + 2;\n" +
        "  const skipValue = (j: number): number => skipString(j);\n" +
        "  return skipValue(0);\n" +
        "}\n" +
        "export function scanE(s: string) {\n" +
        "  function skipString(j: number): number { return j + 3; }\n" +
        "  const skipValue = (j: number): number => skipString(j);\n" +
        "  return skipValue(0);\n" +
        "}\n",
    });
    expect(callsFrom('scanA')).toEqual(['function scanA::skipString (use.ts:3)']);
    expect(callsFrom('scanB')).toEqual(['function scanB::skipString (use.ts:7)']);
    expect(callsFrom('scanC')).toEqual(['function skipString (lib.ts:1)']);
    expect(callsFrom('scanD::skipValue')).toEqual(['function scanD::skipString (use.ts:12)']);
    expect(callsFrom('scanE::skipValue')).toEqual(['function scanE::skipString (use.ts:17)']);
  });

  it('keeps the import for a call outside the shadowing function', async () => {
    await index({
      'lib.ts': "export function skipString(j: number): number { return j + 1; }\n",
      'use.ts':
        "import { skipString } from './lib';\n" +
        "export function outer() {\n" +
        "  function inner() { const skipString = (j: number) => j; return skipString(1); }\n" +
        "  return skipString(0) + inner();\n" +
        "}\n",
    });
    expect(callsFrom('outer').filter((t) => t.includes('skipString'))).toEqual(['function skipString (lib.ts:1)']);
  });
});
