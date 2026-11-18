/**
 * A Python name declared with `typing.overload` is a run of `def`s: stubs whose
 * bodies are `...`, then the `def` without `@overload` that every call runs.
 * A reference to the name links to that implementation, not to the first stub
 * (#2963), whether it is a call, an import, a decorator use or a method call,
 * and a stub with nothing below it (a Protocol) stays the target. Another
 * library's `overload` (plum's), whose bodies all run, is left alone, and a
 * sync moves the callers when an implementation is added or removed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2963-'));
  write(files);
  cg = await CodeGraph.init(tempDir, { index: true });
  return cg;
}

function write(files: Record<string, string>): void {
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir!, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir!, rel), source);
  }
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** Every edge into a def named `name`, as `kind from-name -> def line`. */
function into(name: string): string[] {
  return [...cg!.getNodesByKind('function'), ...cg!.getNodesByKind('method')]
    .filter((n) => n.name === name)
    .flatMap((n) => cg!.getIncomingEdges(n.id)
      .filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${cg!.getNode(e.source)?.name} -> ${n.startLine}`))
    .sort();
}

const DECO = [
  'import typing as t',
  '',
  '',
  '@t.overload',
  'def command(name: t.Callable) -> int: ...',
  '',
  '',
  '@t.overload',
  'def command(name: str | None = None) -> str: ...',
  '',
  '',
  'def command(name=None):',
  '    return real_work(name)',
  '',
  '',
  'def real_work(n):',
  '    return n',
  '',
  '',
  'class Prompt:',
  '    @t.overload',
  '    @classmethod',
  '    def ask(cls, p: str) -> str: ...',
  '',
  '    @t.overload',
  '    @classmethod',
  '    def ask(cls, p: str, d: int) -> int: ...',
  '',
  '    @classmethod',
  '    def ask(cls, p, d=None):',
  '        return real_work(p)',
  '',
].join('\n');

const USE = [
  'import pkg',
  'from pkg import command, Prompt',
  '',
  '',
  '@pkg.command()',
  'def cli():',
  '    pass',
  '',
  '',
  'def run():',
  '    command("x")',
  '    Prompt.ask("y")',
  '',
].join('\n');

describe('a reference to a Python name declared with typing.overload (#2963)', () => {
  it("the issue's repro: calls, the decorator use and the imports reach the implementation", async () => {
    await index({ 'pkg/deco.py': DECO, 'pkg/__init__.py': 'from .deco import command, Prompt\n', 'use.py': USE });
    const command = into('command');
    expect(command.filter((e) => !e.endsWith('-> 12'))).toEqual([]);
    expect(command).toContain('calls run -> 12');
    expect(command.some((e) => e.startsWith('imports '))).toBe(true);
    expect(into('ask')).toEqual(['calls run -> 30']);
    // The path from run reaches real_work through the implementation.
    const impl = cg!.getNodesByKind('function').find((n) => n.name === 'command' && n.startLine === 12)!;
    expect(cg!.getOutgoingEdges(impl.id).filter((e) => e.kind === 'calls').map((e) => cg!.getNode(e.target)?.name)).toEqual(['real_work']);
  });

  it.each([
    ['bare, imported from typing', 'from typing import overload\n', '@overload'],
    ['under an alias', 'from typing import overload as ov\n', '@ov'],
    ['through the typing module', 'import typing\n', '@typing.overload'],
    ['from typing_extensions', 'from typing_extensions import overload\n', '@overload'],
    ['with a blank line and a comment before the def', 'from typing import overload\n', '@overload\n\n# int in, int out'],
  ])('reads the decorator written %s', async (_label, header, decorator) => {
    await index({
      'lib.py': `${header}\n\n${decorator}\ndef go(x: int) -> int: ...\n\n\n${decorator}\ndef go(x: str) -> str: ...\n\n\ndef go(x):\n    return x\n`,
      'use.py': 'from lib import go\n\n\ndef main():\n    return go(1)\n',
    });
    const implLine = fs.readFileSync(path.join(tempDir!, 'lib.py'), 'utf8').split('\n').indexOf('def go(x):') + 1;
    expect(into('go').filter((e) => e.startsWith('calls '))).toEqual([`calls main -> ${implLine}`]);
  });

  it('reaches the implementation of an overloaded method called on an instance', async () => {
    await index({
      'store.py': [
        'from typing import overload',
        '',
        '',
        'class Store:',
        '    @overload',
        '    def get(self, key: int) -> int: ...',
        '    @overload',
        '    def get(self, key: str) -> str: ...',
        '    def get(self, key):',
        '        return key',
        '',
        '',
        'def use():',
        '    s = Store()',
        '    return s.get(1)',
        '',
      ].join('\n'),
    });
    expect(into('get')).toEqual(['calls use -> 9']);
  });

  it('keeps the stub when no implementation follows it, as in a Protocol', async () => {
    await index({
      'proto.py': [
        'from typing import Protocol, overload',
        '',
        '',
        'class Reader(Protocol):',
        '    @overload',
        '    def read(self, n: int) -> bytes: ...',
        '    @overload',
        '    def read(self) -> bytes: ...',
        '',
        '',
        'def use(r: Reader):',
        '    return r.read(1)',
        '',
      ].join('\n'),
    });
    expect(into('read')).toEqual(['calls use -> 6']);
  });

  it("leaves another library's overload alone: its bodies all run", async () => {
    await index({
      'lib.py': 'from plum import overload\n\n\n@overload\ndef go(x: int):\n    return x\n\n\n@overload\ndef go(x: str):\n    return x\n\n\ndef go(x):\n    return x\n',
      'use.py': 'from lib import go\n\n\ndef main():\n    return go(1)\n',
    });
    expect(into('go').filter((e) => e.startsWith('calls '))).toEqual(['calls main -> 5']);
  });
});

describe('a sync of a Python overload set (#2963)', () => {
  const STUBS = 'from typing import overload\n\n\n@overload\ndef go(x: int) -> int: ...\n\n\n@overload\ndef go(x: str) -> str: ...\n';
  const IMPL = '\n\ndef go(x):\n    return x\n';
  const USER = 'from lib import go\n\n\ndef main():\n    return go(1)\n';

  it('moves the callers to an implementation added below the stubs, and back when it goes', async () => {
    await index({ 'lib.py': STUBS, 'use.py': USER });
    expect(into('go').filter((e) => e.startsWith('calls '))).toEqual(['calls main -> 5']);

    write({ 'lib.py': STUBS + IMPL });
    await cg!.sync();
    expect(into('go').filter((e) => e.startsWith('calls '))).toEqual(['calls main -> 12']);

    write({ 'lib.py': STUBS });
    await cg!.sync();
    expect(into('go').filter((e) => e.startsWith('calls '))).toEqual(['calls main -> 5']);
  });
});
