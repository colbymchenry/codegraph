/**
 * A JS/TS receiver declared with a package's type in a function around the
 * calling one, or at the module's top level, calls none of the project's
 * methods (#2589).
 *
 * react-dom's `root.render(<X />)` went to the project's one class `render()`
 * (an error boundary) when `root` was a module's `let root: Root | null`, or
 * a `let popupRoot: Root | null` of an enclosing function a nested one
 * renders through: the receiver's type was read only in the calling function.
 * A receiver typed there already got no edge.
 *
 * Anything nearer that binds the name — a local, a parameter, a destructured
 * name, a later declarator — decides instead, and a binding inside another
 * function is not in scope. A project type declared this way is not used to
 * resolve a call: those are guessed as before.
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

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', typedi: '^0.10.0' } }),
  'src/Boundary.tsx': `import { Component } from "react";
export class Boundary extends Component<{ children?: React.ReactNode }> {
  render() { return this.props.children; }
}
export function makeBoundary() { return new Boundary(); }
`,
  'src/popup.tsx': `import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { Container } from "typedi";
import { Boundary, makeBoundary } from "./Boundary";

let root: Root | null = null;
export function showPopup(el: HTMLElement) {
  if (!root) root = createRoot(el);
  root.render(<div />);
}

let modRoot: Root;
export function a1(el: HTMLElement) { modRoot = createRoot(el); modRoot.render(<div />); }

export function outer(el: HTMLElement) {
  let popupRoot: Root | null = null;
  function renderPopup() { popupRoot!.render(<div />); }
  popupRoot = createRoot(el);
  return renderPopup;
}

export function typedHere(el: HTMLElement) {
  const t: Root = createRoot(el);
  t.render(<div />);
}

let own: Boundary;
export function ownTyped() { own.render(); }

export function ownNew() { const b = new Boundary(); b.render(); }

export function ownCall() { const m = makeBoundary(); m.render(); }

export function shadowed(root: any) { root.render(); }

export function arrowParam(items: Boundary[]) { items.forEach((root) => root.render()); }

export function destructured() { const [root] = useState(new Boundary()); root.render(); }

export function caught() { try { makeBoundary(); } catch (root: any) { root.render(); } }

export function injected() { const root = Container.get(Boundary); root.render(); }

let loose: any;
export function untypedOuter() { loose = new Boundary(); loose.render(); }

export function sibling() { let other: Root | null = null; return other; }
export function afterSibling() { const b = makeBoundary(); other.render(); }

let wrapped: InstanceType<typeof Boundary>;
export function viaWrapper() { wrapped.render(); }

// let commented: Root;
let commented = makeBoundary();
export function afterComment() { commented.render(); }
`,
};

/** The module's `ob` is a react-dom `Root`; the project's one `render()` is `Other`'s. */
const SHADOW: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-dom': '^19.0.0' } }),
  'src/Other.tsx': `export class Other { render() { return 2; } }
export function makeOther() { return new Other(); }
`,
  'src/shadow.tsx': `import type { Root } from "react-dom/client";
import { Other, makeOther } from "./Other";

let ob: Root | null = null;
export function outside() { ob!.render(); }
export function fnExpr(items: Other[]) { items.forEach(function (ob) { ob.render(); }); }
export function laterDeclarator() { let n = 0, ob = makeOther(); ob.render(); }
export function multiLine() {
  const {
    ob,
  } = { ob: makeOther() };
  ob.render();
}
export function declaratorBelow() {
  const a = 1,
    ob = makeOther();
  ob.render();
}
export function destructDefault(o: any) { const { ob = makeOther() } = o; ob.render(); }
export function multiDefault(o: any) {
  const {
    ob = makeOther(),
  } = o;
  ob.render();
}
export function commentedDeclarator() {
  let n = 0, // counter
    ob = makeOther();
  ob.render();
}
export const returnsArrow = () => { return ob => ob.render(); };
`,
};

/** The project's one `render()` is a namesake of the package type a receiver is declared with. */
const NAMESAKE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-dom': '^19.0.0' } }),
  'src/Root.ts': `export class Root { render() { return 3; } }
`,
  'src/use.ts': `import * as RD from "react-dom/client";
let qualified: RD.Root | null = null;
export function viaNamespace() { qualified!.render(); }
`,
};

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-outer-receiver-'));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return CodeGraph.init(dir, { index: true });
}

/** The names of the functions with a `calls` edge to the method `qualifiedName`. */
function callersOf(cg: CodeGraph, file: string, qualifiedName: string): Set<string | undefined> {
  const method = cg.getNodesInFile(file).find((n) => n.kind === 'method' && n.qualifiedName === qualifiedName)!;
  expect(method).toBeDefined();
  return new Set(cg.getIncomingEdgesTo([method.id], ['calls']).map((e) => cg.getNode(e.source)?.name));
}

describe('JS/TS: a receiver typed in a scope around the call', () => {
  it('has that type; a nearer binding, or one in another function, does not', async () => {
    const cg = await indexed(FILES);
    try {
      const callers = callersOf(cg, 'src/Boundary.tsx', 'Boundary::render');
      for (const outside of ['showPopup', 'a1', 'renderPopup', 'typedHere']) {
        expect(callers.has(outside), outside).toBe(false);
      }
      for (const project of ['ownTyped', 'ownNew', 'ownCall', 'shadowed', 'arrowParam', 'destructured', 'caught', 'injected', 'untypedOuter', 'afterSibling', 'viaWrapper', 'afterComment']) {
        expect(callers.has(project), project).toBe(true);
      }
    } finally {
      cg.close();
    }
  });

  it('gives way to a nearer binding of the name, which still reaches the project', async () => {
    const cg = await indexed(SHADOW);
    try {
      const callers = callersOf(cg, 'src/Other.tsx', 'Other::render');
      expect(callers.has('outside'), 'outside').toBe(false);
      for (const nearer of ['fnExpr', 'laterDeclarator', 'multiLine', 'declaratorBelow', 'destructDefault', 'multiDefault', 'commentedDeclarator', 'returnsArrow']) {
        expect(callers.has(nearer), nearer).toBe(true);
      }
    } finally {
      cg.close();
    }
  });

  it("keeps a package namespace's type, not the project's namesake", async () => {
    const cg = await indexed(NAMESAKE);
    try {
      expect(callersOf(cg, 'src/Root.ts', 'Root::render').has('viaNamespace')).toBe(false);
    } finally {
      cg.close();
    }
  });
});
