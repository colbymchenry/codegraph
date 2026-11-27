/**
 * A method call on an untyped receiver is never given to the one method of its
 * name in the caller's own language while a method of that name sits in a
 * sibling language of the same family (#3443).
 *
 * Name matching keeps TypeScript and TSX apart (#1662), so for a `.tsx` caller a
 * `.ts` class's method is set aside, not dropped from existence. The `.tsx`
 * method left is then no likelier than before, and taking it as "the only one"
 * linked excalidraw's 27 `scene.mutateElement(…)` calls in `.tsx` files to
 * `App.mutateElement`, where the compiler resolves `Scene.mutateElement` in
 * `scene.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tsx-lone-guess-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** `function -> Owner::method` for every calls edge out of the file. */
function callsFrom(cg: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const n of cg.getNodesInFile(file)) {
    for (const e of cg.getOutgoingEdgesFrom([n.id], ['calls'])) {
      const t = cg.getNode(e.target);
      out.push(`${n.name} -> ${t ? `${path.basename(t.filePath)}:${t.qualifiedName}` : '?'}`);
    }
  }
  return out.sort();
}

const SCENE_TS = `export class Scene {
  mutateElement(id: number): number { return id; }
  onlyScene(): void {}
}
`;
const APP_TSX = `export class App {
  mutateElement(id: number): number { return -id; }
}
`;

describe('#3443: no lone guess past a same-family method set aside', () => {
  it('the issue repro: a callback-typed parameter does not take the .tsx method', async () => {
    const cg = await indexed({
      'src/scene.ts': SCENE_TS,
      'src/app.tsx': APP_TSX,
      'src/types.ts': `import type { Scene } from './scene';
export type OnChange = (props: { scene: Scene; value: number }) => void;
export type OnScene = (scene: Scene) => void;
`,
      'src/angle.tsx': `import type { Scene } from './scene';
import type { OnChange, OnScene } from './types';

export const destructured: OnChange = ({ scene, value }) => {
  scene.mutateElement(value);
};

export const plain: OnScene = (scene) => {
  scene.mutateElement(1);
};

export const annotated = ({ scene, value }: { scene: Scene; value: number }) => {
  scene.mutateElement(value);
};
`,
    });
    try {
      const calls = callsFrom(cg, 'src/angle.tsx');
      expect(calls).not.toContain('destructured -> app.tsx:App::mutateElement');
      expect(calls).not.toContain('plain -> app.tsx:App::mutateElement');
      // A written annotation still decides the receiver.
      expect(calls).toContain('annotated -> scene.ts:Scene::mutateElement');
    } finally {
      cg.close();
    }
  });

  it("excalidraw's shape: a receiver taken off an untyped object in a .tsx file", async () => {
    const cg = await indexed({
      'src/scene.ts': SCENE_TS,
      'src/app.tsx': APP_TSX,
      'src/actionFinalize.tsx': `export function finalize(app: any, id: number) {
  const { scene } = app;
  scene.mutateElement(id);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/actionFinalize.tsx')).not.toContain('finalize -> app.tsx:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it('works the other way round: a .ts caller does not take the .ts method past a .tsx one', async () => {
    const cg = await indexed({
      'src/scene.tsx': `export class Scene {
  mutateElement(id: number): number { return id; }
}
`,
      'src/app.ts': `export class App {
  mutateElement(id: number): number { return -id; }
}
`,
      'src/use.ts': `export function run(holder: any) {
  const thing = holder.current;
  thing.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/use.ts')).not.toContain('run -> app.ts:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it('keeps the lone guess when no sibling-language method of the name exists', async () => {
    const cg = await indexed({
      'src/app.tsx': APP_TSX,
      'src/use.tsx': `export function run(holder: any) {
  const thing = holder.current;
  thing.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/use.tsx')).toContain('run -> app.tsx:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it("keeps the lone guess in production code when the sibling method is a test helper's", async () => {
    const cg = await indexed({
      'src/app.tsx': APP_TSX,
      'src/tests/helpers/api.ts': `export class API {
  static mutateElement(id: number): number { return id; }
}
`,
      'src/use.tsx': `export function run(holder: any) {
  const thing = holder.current;
  thing.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/use.tsx')).toContain('run -> app.tsx:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it('keeps the lone guess when the other method of the name is in another family', async () => {
    const cg = await indexed({
      'src/app.tsx': APP_TSX,
      'tools/scene.py': `class Scene:
    def mutateElement(self, id):
        return id
`,
      'src/use.tsx': `export function run(holder: any) {
  const thing = holder.current;
  thing.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/use.tsx')).toContain('run -> app.tsx:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it('still scores the one reachable method by receiver name past a .ts sibling', async () => {
    // A function-local class is out of reach, so the one method left is scored
    // against the receiver (`cache` names `BaseCache`) rather than guessed.
    const cg = await indexed({
      'src/b.tsx': `export class BaseCache {
  aadd(x: number) { return x; }
}
export function go(cache: any) {
  cache.aadd(1);
}
`,
      'src/a.ts': `export class Other {
  aadd(x: number) { return x; }
}
`,
      'src/t.tsx': `export function wrap() {
  class Local {
    aadd(x: number) { return x; }
  }
  return Local;
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/b.tsx')).toContain('go -> b.tsx:BaseCache::aadd');
    } finally {
      cg.close();
    }
  });

  it('ignores a sibling method the later filters rule out (a React lifecycle method)', async () => {
    const cg = await indexed({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0' } }),
      'src/comp.ts': `import React from 'react';
export class Boundary extends React.Component {
  render() { return null; }
}
`,
      'src/app.tsx': `export class Viewer {
  render(x: number) { return x; }
}
export function go(v: any) {
  v.render(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/app.tsx')).toContain('go -> app.tsx:Viewer::render');
    } finally {
      cg.close();
    }
  });

  it('keeps the lone guess past the .ts interface or abstract method it implements', async () => {
    const cg = await indexed({
      'src/types.ts': `export interface Frobber { frob(x: number): number }
`,
      'src/base.ts': `export abstract class Base { abstract spin(x: number): number }
`,
      'src/app.tsx': `import type { Frobber } from './types';
import { Base } from './base';
export class Widget extends Base implements Frobber {
  frob(x: number) { return x; }
  spin(x: number) { return x; }
}
export function go(v: any) {
  v.frob(1);
  v.spin(1);
}
`,
    });
    try {
      const calls = callsFrom(cg, 'src/app.tsx');
      expect(calls).toContain('go -> app.tsx:Widget::frob');
      expect(calls).toContain('go -> app.tsx:Widget::spin');
    } finally {
      cg.close();
    }
  });

  it('keeps the lone guess past a .ts subclass that overrides it', async () => {
    const cg = await indexed({
      'src/app.tsx': `export class Widget {
  frob(x: number) { return x; }
}
export function go(v: any) {
  v.frob(1);
}
`,
      'src/fancy.ts': `import { Widget } from './app';
export class FancyWidget extends Widget {
  frob(x: number) { return x * 2; }
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/app.tsx')).toContain('go -> app.tsx:Widget::frob');
    } finally {
      cg.close();
    }
  });

  it('counts a test helper for a test caller', async () => {
    const cg = await indexed({
      'src/app.tsx': APP_TSX,
      'src/tests/helpers/api.ts': `export class API {
  static mutateElement(id: number): number { return id; }
}
`,
      'src/tests/use.test.tsx': `export function run(holder: any) {
  const thing = holder.current;
  thing.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/tests/use.test.tsx')).not.toContain('run -> app.tsx:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it('ignores a sibling the filters rule out: function-local, or a dispatched view action', async () => {
    const cg = await indexed({
      'src/app.tsx': `export class Widget {
  fiddle(x: number) { return x; }
  create(x: number) { return x; }
}
export function go(v: any) {
  v.fiddle(1);
  v.create(1);
}
`,
      'src/local.ts': `export function wrap() {
  class Loc {
    fiddle(x: number) { return x; }
  }
  return Loc;
}
`,
      'src/views.ts': `export class UserView {
  create(x: number) { return x; }
}
`,
    });
    try {
      const calls = callsFrom(cg, 'src/app.tsx');
      expect(calls).toContain('go -> app.tsx:Widget::fiddle');
      expect(calls).toContain('go -> app.tsx:Widget::create');
    } finally {
      cg.close();
    }
  });

  it('keeps the lone guess through a deeper chain, an interface chain, and from a .ts caller', async () => {
    const cg = await indexed({
      'src/base.ts': `export abstract class Base { abstract deep(x: number): number }
export interface Root { chained(x: number): number }
export interface Leaf extends Root {}
`,
      'src/mid.tsx': `import { Base } from './base';
export abstract class Mid extends Base {}
`,
      'src/app.tsx': `import { Mid } from './mid';
import type { Leaf } from './base';
export class Widget extends Mid implements Leaf {
  deep(x: number) { return x; }
  chained(x: number) { return x; }
}
export function go(v: any) {
  v.deep(1);
  v.chained(1);
}
`,
      'src/shape.tsx': `export interface Shape { area(): number }
`,
      'src/square.ts': `import type { Shape } from './shape';
export class Square implements Shape {
  area() { return 4; }
}
export function measure(s: any) {
  s.area();
}
`,
    });
    try {
      const calls = callsFrom(cg, 'src/app.tsx');
      expect(calls).toContain('go -> app.tsx:Widget::deep');
      expect(calls).toContain('go -> app.tsx:Widget::chained');
      expect(callsFrom(cg, 'src/square.ts')).toContain('measure -> square.ts:Square::area');
    } finally {
      cg.close();
    }
  });

  it("ignores a sibling the receiver's declared type rules out", async () => {
    // `api: Api`, whose member of the name is a property: only a class that
    // extends or implements `Api`, or whose file names it, is a candidate
    // (#3035). `Scene` in scene.ts is neither, so it is no rival to `App`.
    const cg = await indexed({
      'src/types.ts': `export interface Api { mutateElement: (id: number) => number }
`,
      'src/app.tsx': `import type { Api } from './types';
export class App {
  api(): Api { return this as unknown as Api; }
  mutateElement(id: number): number { return -id; }
}
`,
      'src/scene.ts': SCENE_TS,
      'src/use.tsx': `import type { Api } from './types';
export function go(api: Api) {
  api.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/use.tsx')).toContain('go -> app.tsx:App::mutateElement');
    } finally {
      cg.close();
    }
  });

  it("ignores another test file's constructor-function method", async () => {
    const cg = await indexed({
      'src/app.tsx': `export class Widget {
  frobnicate(x: number) { return x; }
}
`,
      'src/tests/server.test.ts': `function Server() {}
Server.prototype.frobnicate = function (x: number) { return x; };
export { Server };
`,
      'src/tests/use.test.tsx': `export function run(holder: any) {
  const thing = holder.current;
  thing.frobnicate(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/tests/use.test.tsx')).toContain('run -> app.tsx:Widget::frobnicate');
    } finally {
      cg.close();
    }
  });

  it('leaves JavaScript callers as they were (TypeScript and TSX only)', async () => {
    const cg = await indexed({
      'src/a.js': `export class Widget {
  frobnicate(x) { return x; }
}
export function go(w) {
  w.frobnicate(1);
}
`,
      'src/b.ts': `export class Gadget {
  frobnicate(x: number) { return x; }
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/a.js')).toContain('go -> a.js:Widget::frobnicate');
    } finally {
      cg.close();
    }
  });

  it('keeps scoring by receiver name among same-language methods', async () => {
    const cg = await indexed({
      'src/scene.tsx': `export class Scene {
  mutateElement(id: number): number { return id; }
}
`,
      'src/app.tsx': APP_TSX,
      'src/other.ts': `export class Other {
  mutateElement(id: number): number { return id; }
}
`,
      'src/use.tsx': `export function run(holder: any) {
  const scene = holder.current;
  scene.mutateElement(1);
}
`,
    });
    try {
      expect(callsFrom(cg, 'src/use.tsx')).toContain('run -> scene.tsx:Scene::mutateElement');
    } finally {
      cg.close();
    }
  });
});
