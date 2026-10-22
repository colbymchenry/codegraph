/**
 * A static method and an instance method of the same name are not an override
 * pair: `A.s()` never runs `B.prototype.s`, and `new A().s()` never runs
 * `A.s`. The interface-impl synthesizer matched by name alone, so `B::s ->
 * A::s` was drawn for `class B { s() {} }` / `class A extends B { static s()
 * {} }`. In JavaScript a second cause: methods never recorded `isStatic` at
 * all (TypeScript's extractor had the hook, JavaScript's did not), so even a
 * static/static pair looked like instance/instance (#2761).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-static-override-'));
  const files: Record<string, string> = {
    'ts/a.ts': `export class B {
  s(): void {}
  static t(): void {}
  u(): void {}
}
export class A extends B {
  static s(): void {}
  t(): void {}
  u(): void {}
}
export class S extends B {
  static t(): void {}
}
`,
    'js/a.js': `export class B {
  static s() {}
  s() {}
}
export class A extends B {
  static s() {}
}
export class C extends B {
  s() {}
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Base::m -> Sub::m` of every interface-impl edge drawn inside `file`, with each end's static flag. */
function overridePairs(file: string): string[] {
  const nodes = cg.getNodesInFile(file);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return cg.getOutgoingEdgesFrom(nodes.map((n) => n.id))
    .filter((e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl')
    .map((e) => {
      const s = byId.get(e.source)!;
      const t = cg.getNode(e.target)!;
      const tag = (n: typeof s) => `${n.qualifiedName}${n.isStatic ? '[static]' : ''}`;
      return `${tag(s)} -> ${tag(t)}`;
    })
    .sort();
}

describe('a static and an instance method of one name are not an override pair (#2761)', () => {
  it('TypeScript: only same-kind pairs are linked', () => {
    expect(overridePairs('ts/a.ts')).toEqual([
      'B::t[static] -> S::t[static]',
      'B::u -> A::u',
    ]);
  });

  it('JavaScript: methods record `static`, and only same-kind pairs are linked', () => {
    const statics = cg.getNodesInFile('js/a.js').filter((n) => n.kind === 'method').map((n) => `${n.qualifiedName}${n.isStatic ? '[static]' : ''}`).sort();
    expect(statics).toEqual(['A::s[static]', 'B::s', 'B::s[static]', 'C::s']);
    expect(overridePairs('js/a.js')).toEqual([
      'B::s -> C::s',
      'B::s[static] -> A::s[static]',
    ]);
  });
});
