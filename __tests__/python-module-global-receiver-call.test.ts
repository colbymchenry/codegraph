/**
 * A Python call through a module-level instance — `_svc = SceneService()` at
 * module scope, `_svc.delete(obj)` inside a function — reaches the method of
 * the instance's class, inherited ones included, even when other classes
 * share the method's name (#2582). The method-value form already did (#2074).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function calls(files: Record<string, string>, fromName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2582-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('function').find((n) => n.name === fromName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => [e.kind, cg!.getNode(e.target)] as const)
    .filter(([, n]) => !!n)
    .map(([kind, n]) => `${kind === 'calls' ? '' : `${kind} `}${n!.qualifiedName}@${n!.filePath}`)
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const BASE = 'class GenericCRUDService:\n    def delete(self, obj):\n        return obj\n';
const OTHER = 'class Unrelated:\n    def delete(self, obj):\n        return None\n\n    def purge(self):\n        return None\n';
const SVC = (body: string) =>
  `from base import GenericCRUDService\n\n\nclass SceneService(GenericCRUDService):\n    def purge(self):\n        return 1\n\n\n_svc = SceneService()\n\n\n${body}\n`;

describe('a Python call through a module-level instance (#2582)', () => {
  it.each([
    ['an inherited method', 'def use(obj):\n    _svc.delete(obj)', ['GenericCRUDService::delete@base.py']],
    ['the class\'s own method', 'def use():\n    _svc.purge()', ['SceneService::purge@svc.py']],
  ])('reaches %s', async (_label, body, expected) => {
    const out = await calls({ 'base.py': BASE, 'other.py': OTHER, 'svc.py': SVC(body) }, 'use');
    expect(out).toEqual(expected);
  });

  it('does not use the global where a local of the same name shadows it', async () => {
    const out = await calls(
      { 'base.py': BASE, 'other.py': OTHER, 'svc.py': SVC('def use(_svc):\n    _svc.purge()') },
      'use'
    );
    expect(out).not.toContain('SceneService::purge@svc.py');
  });

  it.each([
    ['an instance attribute', 'class SceneService:\n    def __init__(self, h):\n        self.handler = h\n\n\n_svc = SceneService(print)\n\n\ndef use():\n    _svc.handler()\n', ['Unrelated::handler@other.py']],
    ['a class attribute', 'class SceneService:\n    handler = None\n\n\n_svc = SceneService()\n\n\ndef use():\n    _svc.handler()\n', ['Unrelated::handler@other.py']],
    ['a property', 'class SceneService:\n    @property\n    def handler(self):\n        return len\n\n\n_svc = SceneService()\n\n\ndef use():\n    _svc.handler()\n', []],
    ['a base class from outside the project', 'from thirdparty import Session\n\n\nclass SceneService(Session):\n    pass\n\n\n_svc = SceneService()\n\n\ndef use():\n    _svc.handler()\n', ['Unrelated::handler@other.py']],
    ['one of two candidate classes lacking it', 'class A:\n    def handler(self):\n        return 1\n\n\nclass B:\n    pass\n\n\nif X:\n    _svc = A()\nelse:\n    _svc = B()\n\n\ndef use():\n    _svc.handler()\n', []],
  ])('falls back to name matching, never the class or its getter, when the member is %s', async (_label, code, expected) => {
    // Unrelated.handler is the project's only other `handler`, so upstream's
    // name matching links it when the global's own class can't supply one
    // (known limit); a getter competing with it leaves the name ambiguous.
    const other = 'class Unrelated:\n    def handler(self):\n        return None\n';
    expect(await calls({ 'other.py': other, 'svc.py': code }, 'use')).toEqual(expected);
  });

  it('lets a nested class shadow the global', async () => {
    const code = 'class A:\n    def run(self):\n        return 1\n\n\n_svc = A()\n\n\ndef use():\n    class _svc:\n        def run(self):\n            return 2\n\n    _svc.run()\n';
    const out = await calls({ 'other.py': 'class Z:\n    def run(self):\n        return 3\n', 'svc.py': code }, 'use');
    expect(out).toEqual(['use::_svc::run@svc.py']);
  });

  it.each([
    ['a multi-line base list', 'class Base:\n    def run(self):\n        return 1\n\n\nclass A(\n    Base,\n):\n    pass\n', 'Base::run@svc.py'],
    ['a subscripted base', 'from typing import Generic, TypeVar\n\nT = TypeVar("T")\n\n\nclass Base(Generic[T]):\n    def run(self):\n        return 1\n\n\nclass A(Base[int]):\n    pass\n', 'Base::run@svc.py'],
    ['a member-like line in another method', 'class A:\n    def run(self):\n        return 1\n\n    def other(self):\n        return dict(\n            run=1,\n        )\n', 'A::run@svc.py'],
  ])('keeps the name-matched edge through %s', async (_label, classes, expected) => {
    const code = `${classes}\n\n_svc = A()\n\n\ndef use():\n    _svc.run()\n`;
    expect(await calls({ 'svc.py': code }, 'use')).toEqual([expected]);
  });

  it('keeps a recursive call through the global', async () => {
    const code = 'class A:\n    def run(self, n):\n        if n:\n            _svc.run(n - 1)\n\n\n_svc = A()\n';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2582-'));
    fs.writeFileSync(path.join(tempDir, 'svc.py'), code);
    fs.writeFileSync(path.join(tempDir, 'other.py'), 'class Z:\n    def run(self, n):\n        return n\n');
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
    const run = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'A::run')!;
    const targets = cg.getOutgoingEdges(run.id).filter((e) => e.kind === 'calls').map((e) => cg!.getNode(e.target)?.qualifiedName);
    expect(targets).toEqual(['A::run']);
  });

  it('is not shadowed by a class nested in a helper function', async () => {
    const code = 'class A:\n    def run(self):\n        return 1\n\n\n_svc = A()\n\n\ndef use():\n    def helper():\n        class _svc:\n            def run(self):\n                return 2\n\n        return _svc\n\n    _svc.run()\n';
    const out = await calls({ 'other.py': 'class Z:\n    def run(self):\n        return 3\n', 'svc.py': code }, 'use');
    expect(out).toEqual(['A::run@svc.py']);
  });
});

