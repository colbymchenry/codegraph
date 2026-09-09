/**
 * In JS/TS a receiver-less call can never bind to a class method: `serialize(x)`
 * inside `Record.serialize` means the module-scope function, and the method
 * itself — which the same-file proximity term used to pick, producing a
 * self-edge — is not a candidate (#1714). `this.serialize(x)` still is.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function callsFromMethod(source: string, methodName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1714-'));
  fs.writeFileSync(path.join(tempDir, 'record.ts'), source);
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('method').find((n) => n.name === methodName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.qualifiedName ?? n.name}`);
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a receiver-less JS/TS call never binds to a method (#1714)', () => {
  it('resolves the bare call onto the module-scope function, not the enclosing method', async () => {
    const callees = await callsFromMethod(
      [
        'function serialize(value: string): string {',
        '  return value.trim();',
        '}',
        '',
        'export class Record {',
        '  constructor(private readonly raw: string) {}',
        '  serialize(): string {',
        '    return serialize(this.raw);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'serialize'
    );
    expect(callees).toContain('function:serialize');
    expect(callees).not.toContain('method:Record::serialize');
  });

  it('keeps `this.serialize()` — a real recursive self-call', async () => {
    const callees = await callsFromMethod(
      [
        'function serialize(value: string): string {',
        '  return value.trim();',
        '}',
        '',
        'export class Record {',
        '  constructor(private readonly raw: string, private depth = 0) {}',
        '  serialize(): string {',
        '    if (this.depth > 0) return this.serialize();',
        '    return this.raw;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'serialize'
    );
    expect(callees).toContain('method:Record::serialize');
  });

  it('a bare call to a name the file binds itself has no cross-file candidate', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1714-'));
    fs.writeFileSync(path.join(tempDir, 'config.ts'), 'export function resolve(p: string) { return p; }\nexport function transform(c: string) { return c; }\nexport function now() { return 0; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'client.ts'),
      [
        'const transform = makeTransform();',
        'export function ping(): Promise<void> {',
        '  return new Promise((resolve, reject) => {',
        '    setTimeout(() => resolve(), 10);',
        '  });',
        '}',
        'export function run(options: { now?: () => number }) {',
        '  const now = options.now || (() => Date.now());',
        '  return now() + transform("x").length;',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const targets = cg.getNodesByKind('function').filter((n) => n.filePath === 'config.ts').map((n) => n.id);
    const callers = cg.getNodesByKind('function').filter((n) => n.filePath === 'client.ts');
    const crossFile = callers.flatMap((c) => cg!.getOutgoingEdges(c.id)).filter((e) => e.kind === 'calls' && targets.includes(e.target));
    expect(crossFile).toEqual([]);
  });

  it('a destructured require or a string mentioning the name is not a local binding', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1714-'));
    fs.writeFileSync(path.join(tempDir, 'public-ip.js'), 'function lookupPublicIPv4() { return "1.2.3.4"; }\nfunction test(name, fn) { return fn(); }\nmodule.exports = { lookupPublicIPv4, test };\n');
    fs.writeFileSync(
      path.join(tempDir, 'main.js'),
      [
        'const { lookupPublicIPv4 } = require("./public-ip");',
        'const { test } = require("./public-ip");',
        'async function prepare() {',
        '  const ip = await lookupPublicIPv4();',
        '  test("a test of the thing", () => {});',
        '  return ip;',
        '}',
        'module.exports = { prepare };',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const prepare = cg.getNodesByKind('function').find((n) => n.name === 'prepare')!;
    const names = cg.getOutgoingEdges(prepare.id).filter((e) => e.kind === 'calls').map((e) => cg!.getNode(e.target)?.name);
    expect(names).toContain('lookupPublicIPv4');
    expect(names).toContain('test');
  });

  it('keeps `other.serialize()` — a call through a receiver', async () => {
    const callees = await callsFromMethod(
      [
        'export class Record {',
        '  serialize(): string { return ""; }',
        '  copyOf(other: Record): string {',
        '    return other.serialize();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'copyOf'
    );
    expect(callees).toContain('method:Record::serialize');
  });
});
