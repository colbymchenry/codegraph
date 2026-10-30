/**
 * A class that implements or extends a parameterized type is linked to that
 * type. The Java and TypeScript grammars wrap `Store<String>` in a
 * `generic_type`, and the supertype clause reader took the whole text as the
 * name — which the index holds nothing under. So `class MapStore implements
 * Store<String>` had no `implements` edge, and none of the interface-impl
 * links that follow from it; the same for `extends Base<Integer>`, an
 * interface's `extends Store<T>`, and TypeScript's `implements Store<string>`.
 * The reference now names the type before its arguments, on the wasm path
 * and in the kernel alike. (A package- or namespace-qualified supertype,
 * `extends app.Base`, `implements ns.Other`, stays unresolved as before,
 * with or without arguments.)
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-generic-supertypes-'));
  const files: Record<string, string> = {
    'src/Store.java': `package app;

public interface Store<T> {
    void save(T entity);
}
`,
    'src/Sub.java': `package app;

interface Sub<T> extends Store<T> {}
`,
    'src/MapStore.java': `package app;

import java.io.Serializable;

public class MapStore implements Store<String>, Serializable {
    public void save(String entity) {}
}
`,
    'src/Base.java': `package app;

public class Base<T> {
    public void init() {}
}
`,
    'src/Derived.java': `package app;

public class Derived extends Base<Integer> {
    public void init() {}
}
`,
    'src/store.ts': `export interface Store<T> { save(entity: T): void }
export interface Named { name: string }
export class MapStore implements Store<string>, Named {
  name = 'map';
  save(entity: string) {}
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `kind -> qualified name` of the supertype edges of `name` in `file`. */
const supertypes = (file: string, name: string): string[] => {
  const node = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'file')!;
  expect(node, `${file} ${name}`).toBeDefined();
  return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'extends' || e.kind === 'implements')
    .map((e) => `${e.kind} -> ${cg.getNode(e.target)!.qualifiedName}`).sort();
};

describe('a parameterized supertype names its type (Java, TypeScript)', () => {
  it('Java: implements Store<String>, extends Base<Integer>, interface extends Store<T>', () => {
    expect(supertypes('src/MapStore.java', 'MapStore')).toEqual(['implements -> app::Store']);
    expect(supertypes('src/Derived.java', 'Derived')).toEqual(['extends -> app::Base']);
    expect(supertypes('src/Sub.java', 'Sub')).toEqual(['extends -> app::Store']);
  });

  it('Java: the interface method links its implementation, the base method its override', () => {
    const save = cg.getNodesInFile('src/Store.java').find((n) => n.name === 'save')!;
    expect(cg.getOutgoingEdges(save.id).filter((e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl')
      .map((e) => cg.getNode(e.target)!.qualifiedName)).toEqual(['app::MapStore::save']);
    const init = cg.getNodesInFile('src/Base.java').find((n) => n.name === 'init')!;
    expect(cg.getOutgoingEdges(init.id).filter((e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl')
      .map((e) => cg.getNode(e.target)!.qualifiedName)).toEqual(['app::Derived::init']);
  });

  it('TypeScript: implements Store<string>, beside a plain interface', () => {
    expect(supertypes('src/store.ts', 'MapStore')).toEqual(['implements -> Named', 'implements -> Store']);
  });
});
