import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

async function calls(files: Record<string, string>): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-lexical-'));
  let cg: CodeGraph | undefined;
  try {
    for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, name), source);
    cg = await CodeGraph.init(root, { index: true });
    return cg.getOutgoingEdgesFrom(Object.keys(files).flatMap((name) => cg!.getNodesInFile(name).map((n) => n.id)))
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.source)!.qualifiedName + ' -> ' + cg!.getNode(e.target)!.qualifiedName);
  } finally {
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('F# lexical scope regressions', () => {
  it('does not call the module function through a local binding, including a pipe', async () => {
    expect(await calls({ 'Use.fs': `module Use
let helper x = x
let run () =
    let helper = fun x -> x + 1
    helper 1 + (2 |> helper)
` })).not.toContain('Use::run -> Use::helper');
  });

  it('does not resolve a recursive local function to its module namesake', async () => {
    expect(await calls({ 'Use.fs': `module Use
let helper x = x
let run () =
    let rec helper x = if x = 0 then 0 else helper (x - 1)
    helper 2
` })).not.toContain('Use::run -> Use::helper');
  });

  it('keeps the outer binding visible in a non-recursive initializer', async () => {
    expect(await calls({ 'Use.fs': `module Use
let helper x = fun y -> x + y
let run () =
    let helper = helper 1
    helper 2
` })).toEqual(['Use::run -> Use::helper']);
  });

  it('does not leak a local binding out of its branch', async () => {
    expect(await calls({ 'Use.fs': `module Use
let helper x = x
let run () =
    if true then
        let helper x = x + 1
        helper 1 |> ignore
    helper 2
` })).toContain('Use::run -> Use::helper');
  });

  it('keeps constructor parameters in scope in methods and pipelines', async () => {
    expect(await calls({ 'Use.fs': `module Use
let helper x = x
type T(helper: int -> int) =
    member _.Run() = helper 1
    member _.Pipe() = 2 |> helper
type Other() =
    member _.Run() = helper 3
` })).toEqual(['Use::Other::Run -> Use::helper']);
  });

  it('limits a nested open to that module and its descendants', async () => {
    const result = await calls({ 'Lib.fs': `module Lib
let ignore x = ()
`, 'Use.fs': `module Use
module A =
    open Lib
    let a () = ignore 1
    module Inner =
        let inner () = ignore 2
module B =
    let b () = ignore 3
` });
    expect(result).toContain('Use::A::a -> Lib::ignore');
    expect(result).toContain('Use::A::Inner::inner -> Lib::ignore');
    expect(result).not.toContain('Use::B::b -> Lib::ignore');
  });

  it('does not apply an open to earlier declarations', async () => {
    const result = await calls({ 'Lib.fs': `module Lib
let ignore x = ()
`, 'Use.fs': `module Use
let before () = ignore 1
open Lib
let after () = ignore 2
` });
    expect(result).not.toContain('Use::before -> Lib::ignore');
    expect(result).toContain('Use::after -> Lib::ignore');
  });

  it('inherits a file-level open without leaking a nested module alias', async () => {
    const result = await calls({ 'Lib.fs': `module Lib
let ignore x = ()
`, 'Use.fs': `module Use
open Lib
module A =
    module L = Lib
    let a () = L.ignore 1
module B =
    let b () = ignore 2
    let externalCall () = L.ignore 3
` });
    expect(result).toContain('Use::A::a -> Lib::ignore');
    expect(result).toContain('Use::B::b -> Lib::ignore');
    expect(result).not.toContain('Use::B::externalCall -> Lib::ignore');
  });
});
