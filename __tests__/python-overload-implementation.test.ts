/**
 * A Python name declared with `typing.overload` runs one function: the `def`
 * below its stubs. The stubs are indexed as separate nodes, and a call by name
 * landed on the first of them, whose body is `...`. So the implementation had no
 * callers, a call path broke at the stub, and click's `command`, called hundreds
 * of times, looked unreferenced.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const DECO = [
  'import typing as t',                                  // 1
  'from typing import overload',                         // 2
  '',                                                    // 3
  '@t.overload',                                         // 4
  'def command(name: t.Callable) -> int: ...',           // 5
  '',                                                    // 6
  '@overload  # a comment on the decorator',             // 7
  '# and one between it and the def',                    // 8
  'def command(name: str | None = None) -> str: ...',    // 9
  '',                                                    // 10
  'def command(name=None):',                             // 11
  '    return real_work(name)',                          // 12
  '',                                                    // 13
  'def real_work(n):',                                   // 14
  '    return n',                                        // 15
  '',                                                    // 16
  'class Prompt:',                                       // 17
  '    @t.overload',                                     // 18
  '    @classmethod',                                    // 19
  '    def ask(cls, p: str) -> str: ...',                // 20
  '',                                                    // 21
  '    @classmethod',                                    // 22
  '    @t.overload',                                     // 23
  '    def ask(cls, p: str, d: int) -> int: ...',        // 24
  '',                                                    // 25
  '    @classmethod',                                    // 26
  '    def ask(cls, p, d=None):',                        // 27
  '        return real_work(p)',                         // 28
  '',
].join('\n');

const USE = [
  'import pkg',
  'from pkg import command, Prompt',
  '',
  'def run():',
  '    command("x")',
  '    Prompt.ask("y")',
  '',
  'def through_module():',
  '    pkg.command("x")',
  '',
].join('\n');

const PACKAGE = { 'pkg/deco.py': DECO, 'pkg/__init__.py': 'from .deco import command, Prompt\n', 'use.py': USE };

describe('a call to a Python name declared with typing.overload', () => {
  let root: string;
  let cg: CodeGraph;

  const index = async (files: Record<string, string>): Promise<void> => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-overload-'));
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    }
    cg = await CodeGraph.init(root, { index: true });
  };

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const named = (name: string): Node[] => [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')]
    .filter((n) => n.name === name);
  const fn = (name: string): Node => named(name)[0]!;
  const calleeLines = (caller: string, name: string): number[] => cg.getCallees(fn(caller).id)
    .filter((c) => c.node.name === name).map((c) => c.node.startLine).sort((a, b) => a - b);

  it('links the implementation, not the first stub', async () => {
    await index(PACKAGE);
    expect(calleeLines('run', 'command')).toEqual([11]);
    expect(calleeLines('through_module', 'command')).toEqual([11]);
  });

  it('links the implementation of a classmethod, wherever overload stands among the decorators', async () => {
    await index(PACKAGE);
    expect(calleeLines('run', 'ask')).toEqual([27]);
  });

  it('gives the implementation the callers, and leaves the stubs without any', async () => {
    await index(PACKAGE);
    const impl = named('command').find((n) => n.startLine === 11)!;
    expect(cg.getCallers(impl.id).map((c) => c.node.name)).toEqual(expect.arrayContaining(['run', 'through_module']));
    for (const stub of named('command').filter((n) => n.startLine !== 11)) {
      expect(cg.getCallers(stub.id)).toEqual([]);
    }
  });

  it('takes the implementation below the stub it reached, when a file has two sets', async () => {
    await index({
      'twice.py': [
        'import sys',
        'from typing import overload',
        '',
        'if sys.version_info >= (3, 11):',
        '    @overload',
        '    def pick(a: int) -> int: ...',          // 6
        '    def pick(a):',                          // 7
        '        return a',
        'else:',
        '    @overload',
        '    def pick(a: str) -> str: ...',          // 11
        '    def pick(a):',                          // 12
        '        return a',
        '',
        'def caller():',
        '    return pick(1)',
        '',
      ].join('\n'),
    });
    const lines = calleeLines('caller', 'pick');
    expect(lines.length).toBe(1);
    expect([7, 12]).toContain(lines[0]);
  });

  it('keeps the stub when no implementation follows it', async () => {
    await index({
      'proto.py': [
        'from typing import Protocol, overload',
        '',
        'class Reader(Protocol):',
        '    @overload',
        '    def read(self, n: int) -> bytes: ...',  // 5
        '    @overload',
        '    def read(self) -> str: ...',            // 7
        '',
        'def use(r: Reader):',
        '    return r.read()',
        '',
      ].join('\n'),
    });
    expect(calleeLines('use', 'read').length).toBe(1);
    expect([5, 7]).toContain(calleeLines('use', 'read')[0]);
  });

  it('leaves a same-named method of another class alone', async () => {
    await index({
      'two.py': [
        'from typing import overload',
        '',
        'class A:',
        '    @overload',
        '    def go(self, x: int) -> int: ...',      // 5
        '    def go(self, x):',                      // 6
        '        return x',
        '',
        'class B:',
        '    def go(self, x):',                      // 10
        '        return x',
        '',
        'def use():',
        '    A().go(1)',
        '    B().go(1)',
        '',
      ].join('\n'),
    });
    expect(calleeLines('use', 'go')).toEqual([6, 10]);
  });
});
