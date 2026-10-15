/**
 * A receiver-less call that is the body of a braceless `if`, `while` or `for`
 * — `if (e.key === "Escape") setOpen(false);` — is still a bare call (#2585).
 * The character before the name is the `)` that closes the statement's header,
 * and that `)` used to read as the end of a receiver. The call then skipped
 * both guards a bare JS/TS call gets: no type member, and no other file's
 * symbol when the file binds the name itself. A `setOpen` from
 * `const [open, setOpen] = useState(false)` linked to a context interface's
 * `setOpen` property in another file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const CTX = `export interface PaletteCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
}
`;

const DIALOG = `import { useState } from "react";
export function Dialog(xs: number[]) {
  const [open, setOpen] = useState(false);
  function a(e: KeyboardEvent) {
    if (e.key === "Escape") setOpen(false);
  }
  function b() {
    setOpen(false);
  }
  function c(e: KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); }
  }
  function w() {
    while (xs.length > 99) setOpen(false);
  }
  function f() {
    for (const x of xs) setOpen(x > 0);
  }
  function g() {
    if (open) { setOpen(false); } else setOpen(true);
  }
  async function h(src: AsyncIterable<number>) {
    for await (const x of src) setOpen(x > 0);
  }
  function k(e: KeyboardEvent) {
    if (e.key === "Escape" && (open || xs.length)) setOpen(false);
  }
  function m(s: string) {
    if (xs.length > 0 &&
        open) setOpen(false);
    if (s === ")") setOpen(true);
    if (/\\)/.test(s)) setOpen(false);
    if (\`\${s})\` === s) setOpen(true);
    if (s === "(") setOpen(false);
  }
  function n() {
    do setOpen(false); while (open);
  }
  return [a, b, c, w, f, g, h, k, m, n];
}
`;

describe('a call that is the body of a braceless if/while/for (#2585)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    tmpDir = undefined;
  });

  /** `calls` targets of the function `name`, as `<kind>:<name>`. */
  const callees = (graph: CodeGraph, name: string): string[] => {
    const from = graph.getNodesByName(name).find((n) => n.kind === 'function')!;
    return graph.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls')
      .map((e) => graph.getNode(e.target)!)
      .map((n) => `${n.kind}:${n.name}`);
  };

  it('is a bare call: it never reaches another file\'s type member', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-braceless-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src/ctx.ts'), CTX);
    fs.writeFileSync(path.join(tmpDir, 'src/Dialog.tsx'), DIALOG);
    cg = await CodeGraph.init(tmpDir, { index: true });

    for (const fn of ['a', 'b', 'c', 'w', 'f', 'g', 'h', 'k', 'm', 'n']) {
      expect(callees(cg, fn), fn).not.toContain('property:setOpen');
    }
  });

  it('still resolves a call on a receiver after a braceless header', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-braceless-'));
    fs.writeFileSync(path.join(tmpDir, 'svc.ts'), `export class Svc {
  setOpen(v: boolean) { return v; }
  run() { return 1; }
}
export function use(svc: Svc, open: boolean) {
  if (open) svc.setOpen(false);
  while (open) svc.run();
}
`);
    cg = await CodeGraph.init(tmpDir, { index: true });

    expect(callees(cg, 'use').sort()).toEqual(['method:run', 'method:setOpen']);
  });
});
