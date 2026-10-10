/**
 * An F# name binds the way it is written:
 * - bare (`helper`): its own file, a scope around it, the contents of what the
 *   file opens (not a module that merely sits in an opened namespace), an
 *   `[<AutoOpen>]` module in an opened one, or `namespace global`;
 * - through a module or type (`Calc.helper`): that container, by its full path,
 *   relative to an `open`, or relative to a scope around the reference;
 * - through a value (`x.Add`): a member of a type near what the file can see.
 * A same-named function in a namespace nothing reaches (`map`, `bind`, `format`
 * exist in every library) is never what the name means. A private binding and
 * the top of a script stay in their file, and a call never lands on a module.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  isFsharpCandidateReachable,
  type FsharpCandidateScope,
  type FsharpRefScope,
} from '../src/resolution/fsharp-scope';

describe('isFsharpCandidateReachable', () => {
  const ref = (over: Partial<FsharpRefScope> = {}): FsharpRefScope => ({
    container: 'Shop.Core.Use',
    namespace: 'Shop.Core',
    opens: [],
    qualifiers: [],
    externalQualifier: false,
    ...over,
  });
  const candidate = (container: string, over: Partial<FsharpCandidateScope> = {}): FsharpCandidateScope => ({
    name: 'f',
    container,
    namespace: '',
    kind: 'function',
    holders: [container],
    autoOpened: [],
    ...over,
  });

  it('reaches, bare, what encloses the reference', () => {
    expect(isFsharpCandidateReachable(ref(), candidate('Shop.Core'))).toBe(true);
    expect(isFsharpCandidateReachable(ref(), candidate('Shop.Core.Use'))).toBe(true);
  });

  it('does not reach, bare, a sibling module or an unopened namespace', () => {
    expect(isFsharpCandidateReachable(ref(), candidate('Shop.Core.Calc'))).toBe(false);
    expect(isFsharpCandidateReachable(ref(), candidate('Other.Lib.Fn'))).toBe(false);
  });

  it('reaches, bare, the contents of what is opened and no module that only sits inside it', () => {
    expect(isFsharpCandidateReachable(ref({ opens: ['Other.Lib.Fn'] }), candidate('Other.Lib.Fn'))).toBe(true);
    // `open Other.Lib` does not open its module `Fn`: a bare `int` is not `TryParse.int`.
    expect(isFsharpCandidateReachable(ref({ opens: ['Other.Lib'] }), candidate('Other.Lib.Fn'))).toBe(false);
  });

  it('reads an open relative to the scope it is written in', () => {
    expect(isFsharpCandidateReachable(ref({ container: 'Shop.App', opens: ['Lib'] }), candidate('Shop.Lib'))).toBe(true);
    expect(isFsharpCandidateReachable(ref({ container: 'Shop.App', opens: ['Library'] }), candidate('Shop.Lib'))).toBe(false);
  });

  it('reaches an `[<AutoOpen>]` module through the namespace around it', () => {
    const prelude = candidate('Shop.Prelude', { holders: ['Shop.Prelude', 'Shop'] });
    expect(isFsharpCandidateReachable(ref({ opens: ['Shop'] }), prelude)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ opens: ['Shop'] }), candidate('Shop.Prelude'))).toBe(false);
  });

  it('reaches a union case where its type is declared', () => {
    const openWizard = candidate('Ns.Msg', { kind: 'enum_member', holders: ['Ns'] });
    expect(isFsharpCandidateReachable(ref({ opens: ['Ns'] }), openWizard)).toBe(true);
    expect(isFsharpCandidateReachable(ref(), openWizard)).toBe(false);
  });

  it('reaches the case of a .NET-style enum only through its type', () => {
    // `Error` is not `LogEventType.Error`, which is why a bare `Error x` is the Result case.
    const error = candidate('Ns.LogEventType', { kind: 'enum_member', holders: [] });
    expect(isFsharpCandidateReachable(ref({ opens: ['Ns'] }), error)).toBe(false);
    expect(isFsharpCandidateReachable(ref({ opens: ['Ns'], qualifiers: ['LogEventType'] }), error)).toBe(true);
  });

  it('reaches a type member bare only from inside its type, in its file', () => {
    const own = candidate('M.T', { kind: 'method' });
    expect(isFsharpCandidateReachable(ref({ container: 'M.T' }), own, true)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ container: 'M.Other' }), own, true)).toBe(false);
    expect(isFsharpCandidateReachable(ref({ container: 'M.T' }), own, false)).toBe(false);
  });

  it('never reaches anything through a path the project does not declare', () => {
    // `System.Threading.Tasks.Task.Run`: not the `Run` of a project type that happens to be opened.
    const run = candidate('Ts.Runner', { kind: 'method', namespace: 'Ts', name: 'Run' });
    expect(isFsharpCandidateReachable(ref({ opens: ['Ts'], qualifiers: ['System.Threading.Tasks.Task'] }), run)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ opens: ['Ts'], qualifiers: ['System.Threading.Tasks.Task'], externalQualifier: true }), run)).toBe(false);
  });

  it('never reaches a type member bare', () => {
    expect(isFsharpCandidateReachable(ref({ opens: ['Shop.Core.Order'] }), candidate('Shop.Core.Order', { kind: 'method' }))).toBe(false);
  });

  it('reaches a container written by its path', () => {
    const calc = candidate('Shop.Core.Calc');
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Calc'] }), calc)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Shop.Core.Calc'] }), calc)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Other'] }), calc)).toBe(false);
  });

  it('reaches a container written through a partial open', () => {
    const inner = candidate('Other.Lib.Fn.Inner');
    expect(isFsharpCandidateReachable(ref({ opens: ['Other'], qualifiers: ['Lib.Fn.Inner'] }), inner)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ opens: ['Other.Lib'], qualifiers: ['Fn.Inner'] }), inner)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Lib.Fn.Inner'] }), inner)).toBe(false);
  });

  it('reaches a member through a chain of properties, but not the members every object has', () => {
    const save = candidate('Shop.Core.Cfg', { kind: 'method', namespace: 'Shop.Core', name: 'Save' });
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Settings.Current'] }), save)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'] }), { ...save, name: 'ToString' })).toBe(false);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'] }), { ...save, name: 'Add' })).toBe(true);
  });

  it('reaches a container written through an `[<AutoOpen>]` module of an opened namespace', () => {
    const agentName = candidate('Core.Domain.AgentName', { autoOpened: ['Core.Domain'] });
    expect(isFsharpCandidateReachable(ref({ opens: ['Core'], qualifiers: ['AgentName'] }), agentName)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ opens: ['Core'], qualifiers: ['AgentName'] }), candidate('Core.Domain.AgentName'))).toBe(false);
  });

  it('reaches a type member through a value only near what the file can see', () => {
    const add = (container: string, namespace: string) => candidate(container, { kind: 'method', namespace });
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'] }), add('Shop.Core.Order', 'Shop.Core'))).toBe(true);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'] }), add('Other.Lib.Order', 'Other.Lib'))).toBe(false);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'], opens: ['Other.Lib'] }), add('Other.Lib.Order', 'Other.Lib'))).toBe(true);
    // An open reaches the types directly under it, not those further down; the scopes around the reference are near.
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'], opens: ['Other'] }), add('Other.Lib.Order', 'Other.Lib'))).toBe(false);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'] }), add('Shop.Core.Use.Inner', ''))).toBe(true);
    // A function is not reached through a value.
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'] }), candidate('Shop.Core.Calc', { namespace: 'Shop.Core' }))).toBe(false);
  });

  it('reaches `namespace global` from everywhere and the top of a script from nowhere else', () => {
    expect(isFsharpCandidateReachable(ref(), candidate('global'))).toBe(true);
    // The namespace is always open, not the modules in it.
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Async'] }), candidate('global.Async'))).toBe(true);
    expect(isFsharpCandidateReachable(ref(), candidate('global.Async'))).toBe(false);
    expect(isFsharpCandidateReachable(ref(), candidate(''))).toBe(false);
  });
});

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-scope-'));
  const files: Record<string, string> = {
    'src/Other/Fn.fs': `namespace Other.Lib

module Fn =
    let map x = x
    let onlyOther x = x
`,
    'src/Shop/Calc.fs': `namespace Shop.Core

module Calc =
    let map x = x + 1
    let helper x = x * 2
    let private secret x = x
`,
    'src/Shop/Use.fs': `namespace Shop.Core

module Use =
    let run () =
        let a = Calc.helper 1
        let b = Calc.map 2
        secret 3
`,
    'src/Shop/Opens.fs': `module Shop.App

open Other.Lib.Fn

let go () = onlyOther 1
`,
    'src/Shop/Partial.fs': `module Shop.Partial

open Other.Lib

let go3 () = Fn.onlyOther 1
`,
    'src/Shop/Unopened.fs': `module Shop.Unopened

open Other.Lib

let go4 () = onlyOther 1
`,
    'src/Shop/Lonely.fs': `module Shop.Lonely

let go2 () = onlyOther 1
`,
    'src/Shop/Types.fs': `namespace Shop.Core

type IGreeter =
    abstract Greet : unit -> string

type Base() =
    member _.Hello() = 1
`,
    'src/Shop/Derived.fs': `namespace Shop.Core

type Derived() =
    inherit Base()
    interface IGreeter with
        member _.Greet() = "hi"
`,
    'src/Bare/Utils.fs': `module Utils

let bareHelper x = x
`,
    'src/Bare/Program.fs': `module Program

let main () = Utils.bareHelper 1
`,
    'src/Bare/Short.fs': `module Short

let viaTail () = Lib.Fn.onlyOther 1
`,
    'src/Bare/NoQual.fs': `module NoQual

let bad () = bareHelper 1
`,
    'src/Q/Full.fs': `namespace Shop.Q

module M =
    let go () = Other.Lib.Fn.map 1
`,
    'src/Q/Alias.fs': `module Shop.Alias

module F = Other.Lib.Fn

let go () = F.onlyOther 1
`,
    'src/Cs/Maybe.cs': `namespace Lib.Monad
{
    public static class Maybe
    {
        public static int Some(int x) { return x; }
    }
}
`,
    'src/Cs/NoOpen.fs': `module NoOpen

let a () = Maybe.Some 1
`,
    'src/Cs/WithOpen.fs': `module WithOpen

open Lib.Monad

let b () = Maybe.Some 1
`,
    'src/Cs/BareOpen.fs': `module BareOpen

open Lib.Monad

let c () = Some 1
`,
    'src/Mod/Add.fs': `namespace Elsewhere

module Add =
    let x = 1
`,
    'src/Mod/UseAdd.fs': `module UseAdd

let f (xs: System.Collections.Generic.List<string>) = xs.Add "1"
`,
    'src/Mod/Same.fs': `module Same

module Add =
    let x = 1

let f (xs: System.Collections.Generic.List<string>) = xs.Add "1"
`,
    'src/Auto/Domain.fs': `namespace Vision.Core

[<AutoOpen>]
module Domain =
    module AgentName =
        let unwrap x = x
`,
    'src/Auto/View.fs': `module View

open Vision.Core

let f x = AgentName.unwrap x
`,
    'src/Self/Logging.fs': `namespace Self.Core

module Logging =
    let msgToStr x = x
`,
    'src/Self/Wrapper.fs': `namespace Self.Core

module Wrapper =
    let msgToStr x = Logging.msgToStr x
    let again x = msgToStr x
`,
    'src/G/GlobAsync.fs': `namespace global

module Async =
    let mapG x = x
`,
    'src/G/UseAsync1.fs': `module UseAsync1

let a x = Async.mapG x
`,
    'src/G/UseAsync2.fs': `module UseAsync2

let b x = mapG x
`,
    'src/Pipe/Calc2.fs': `module Calc2

let helper2 x = x
`,
    'src/Pipe/UsePipe.fs': `module UsePipe

open Calc2

let f xs =
    xs
    |> Calc2.helper2
`,
    'src/Pipe/UseBare.fs': `module UseBare

let g xs =
    xs
    |> helper2
`,
    'src/Auto/Fs.fs': `[<AutoOpen>]
module Lib.Core.FileSystem

module IO =
    let writeAllText x = x

let topHelper x = x
`,
    'src/Auto/UseFs.fs': `module UseFs

open Lib.Core

let f x = IO.writeAllText x
let g x = topHelper x
`,
    'src/Enum/Log.fs': `module Log

type LogEventType =
    | Information = 0
    | Error = 2
`,
    'src/Enum/UseLog.fs': `module UseLog

open Log

let f x = Error x
`,
    'src/Per/Other.fs': `module Other

let helper x = x
`,
    'src/Per/Mine.fs': `module Mine

let helper x = x
`,
    'src/Per/Use.fs': `module Use

open Mine

let f x = helper (Other.helper x)
let g x = x |> Other.helper |> helper
`,
    'src/Uni/Thing.fs': `namespace Uni

type Thing() =
    override _.ToString() = "thing"
`,
    'src/Uni/UseUni.fs': `namespace Uni

module UseUni =
    let f (k: obj) = k.ToString()
`,
    'src/Chain/Cfg.fs': `namespace Chain

type Cfg() =
    member _.Save() = 1

module Settings =
    let Current = Cfg()
`,
    'src/Chain/UseChain.fs': `namespace Chain

module UseChain =
    let f () = Settings.Current.Save()
`,
    'src/Cs/GlobalCs.cs': `public class GlobalCs
{
    public static int F(int x) { return x; }
}
`,
    'src/Cs/UseGlobal.fs': `module UseGlobal

let g x = GlobalCs.F x
`,
    'src/Bt/Mod.fs': "module ``My Mod``\n\nlet f x = x\n",
    'src/Bt/UseBt.fs': "module UseBt\n\nlet g x = ``My Mod``.f x\n",
    'src/Rz/Error.razor': `<h1>Error</h1>
`,
    'src/Rz/UseErr.fs': `module UseErr

let f x = if x then Ok 1 else Error "bad"
`,
    'src/Fs2/Util.fs': `namespace Other.Stuff

module Util =
    let Compute x = x
`,
    'src/Fs2/Use.cs': `public class UseCs
{
    public int Run(int n) { return Compute(n); }
}
`,
    'src/Ext/Runner.fs': `namespace Ts

type Runner() =
    member _.Run (x: int) = x
`,
    'src/Ext/UseTask.fs': `module UseTask

open Ts

let f () = System.Threading.Tasks.Task.Run(fun () -> 1)
`,
    'src/Same/Nest.fs': `module Nest

let helper () = 1

module Other =
    let helper () = 2

let go () = helper ()
`,
    'src/Same/Cls.fs': `module Cls

type C() =
    let helper () = 1
    do helper () |> ignore
`,
    'src/Repo/Repo.fs': `namespace Shop.Core

type Repo() =
    member _.Add (x: int) = x
`,
    'src/Repo/UseNo.fs': `module UseNo

let f (r: obj) = r.Add 1
`,
    'src/Repo/UseYes.fs': `module UseYes

open Shop.Core

let g (r: Repo) = r.Add 1
`,
    'web/string.ts': `export function toConsole(x: string) { return x; }
`,
    'src/Shop/Logs.fs': `module Shop.Logs

let log () = toConsole "x"
`,
    'scripts/a.fsx': `let scriptHelper x = x
`,
    'scripts/b.fsx': `let y = scriptHelper 1
`,
    'scripts/c.fsx': `open A

let z = scriptHelper 2
`,
    'scripts/d.fsx': `let w = A.scriptHelper 3
`,
    'src/G/Glob.fs': `namespace global

type Gt() =
    member _.X = 1
`,
    'src/G/UseG.fs': `module UseG

let mk () = Gt()
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** `qualifiedName` of everything the symbols of `file` point at with edges of `kind`. */
function targetsFrom(file: string, kind: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)!)
    .map((t) => t.qualifiedName);
}

describe('F# resolution after an edit', () => {
  it('reads the opens of a file again once it is synced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-sync-'));
    const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);
    write('Lib.fs', `namespace Other.Lib

module Fn =
    let onlyOther x = x
`);
    write('Use.fs', `module Use

let go () = onlyOther 1
`);
    const project = await CodeGraph.init(dir, { index: true });
    try {
      const targets = () =>
        project
          .getOutgoingEdgesFrom(project.getNodesInFile('Use.fs').map((n) => n.id))
          .filter((e) => e.kind === 'calls')
          .map((e) => project.getNode(e.target)!.qualifiedName);
      expect(targets()).toEqual([]);
      write('Use.fs', `module Use

open Other.Lib.Fn

let go () = onlyOther 1
`);
      await project.sync();
      expect(targets()).toEqual(['Other.Lib::Fn::onlyOther']);
    } finally {
      project.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('F# cross-file resolution', () => {
  it('links a call written through a sibling module, not a namesake in another namespace', () => {
    const calls = targetsFrom('src/Shop/Use.fs', 'calls');
    expect(calls).toContain('Shop.Core::Calc::helper');
    expect(calls).toContain('Shop.Core::Calc::map');
    expect(calls).not.toContain('Other.Lib::Fn::map');
  });

  it('keeps a private binding in its file', () => {
    expect(targetsFrom('src/Shop/Use.fs', 'calls')).not.toContain('Shop.Core::Calc::secret');
  });

  it('links a bare call into what the file opens, and nothing the open merely sits above', () => {
    expect(targetsFrom('src/Shop/Opens.fs', 'calls')).toContain('Other.Lib::Fn::onlyOther');
    expect(targetsFrom('src/Shop/Unopened.fs', 'calls')).not.toContain('Other.Lib::Fn::onlyOther');
    expect(targetsFrom('src/Shop/Lonely.fs', 'calls')).not.toContain('Other.Lib::Fn::onlyOther');
  });

  it('links a call written through a module under an opened namespace', () => {
    expect(targetsFrom('src/Shop/Partial.fs', 'calls')).toContain('Other.Lib::Fn::onlyOther');
  });

  it('links a call written through the name of a namespace-less module', () => {
    expect(targetsFrom('src/Bare/Program.fs', 'calls')).toContain('Utils::bareHelper');
    expect(targetsFrom('src/Bare/NoQual.fs', 'calls')).not.toContain('Utils::bareHelper');
  });

  it('does not take a partial qualifier for the module it ends', () => {
    expect(targetsFrom('src/Bare/Short.fs', 'calls')).not.toContain('Other.Lib::Fn::onlyOther');
  });

  it('links a call written through a full path or a module alias, with no open', () => {
    expect(targetsFrom('src/Q/Full.fs', 'calls')).toEqual(['Other.Lib::Fn::map']);
    expect(targetsFrom('src/Q/Alias.fs', 'calls')).toContain('Other.Lib::Fn::onlyOther');
  });

  it('reaches a C# declaration through its namespace, and a static method only through its type', () => {
    expect(targetsFrom('src/Cs/NoOpen.fs', 'calls')).not.toContain('Lib.Monad::Maybe::Some');
    expect(targetsFrom('src/Cs/WithOpen.fs', 'calls')).toContain('Lib.Monad::Maybe::Some');
    expect(targetsFrom('src/Cs/BareOpen.fs', 'calls')).not.toContain('Lib.Monad::Maybe::Some');
  });

  it('links a call written through a module inside an `[<AutoOpen>]` module of an opened namespace', () => {
    expect(targetsFrom('src/Auto/View.fs', 'calls')).toEqual(['Vision.Core::Domain::AgentName::unwrap']);
  });

  it('does not take a function for the call it makes to a same-named function of another module', () => {
    const wrapper = cg.getNodesInFile('src/Self/Wrapper.fs');
    const edgesOf = (name: string) => {
      const id = wrapper.find((n) => n.name === name)!.id;
      return cg.getOutgoingEdgesFrom([id]).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName);
    };
    expect(edgesOf('msgToStr')).toEqual(['Self.Core::Logging::msgToStr']);
    // Bare, the name is the function in the same module.
    expect(edgesOf('again')).toEqual(['Self.Core::Wrapper::msgToStr']);
  });

  it('reads the qualifier of a name written on a later line of its expression', () => {
    expect(targetsFrom('src/Pipe/UsePipe.fs', 'calls')).toContain('Calc2::helper2');
    expect(targetsFrom('src/Pipe/UseBare.fs', 'calls')).toEqual([]);
  });

  it('reaches the contents of a file-level `[<AutoOpen>]` module through the namespace around it', () => {
    expect(targetsFrom('src/Auto/UseFs.fs', 'calls').sort()).toEqual([
      'Lib.Core.FileSystem::IO::writeAllText',
      'Lib.Core.FileSystem::topHelper',
    ]);
  });

  it('never links a bare name to the case of a .NET-style enum', () => {
    expect(targetsFrom('src/Enum/UseLog.fs', 'calls')).toEqual([]);
  });

  it('reads the qualifier of each reference on its own', () => {
    expect(targetsFrom('src/Per/Use.fs', 'calls').sort()).toEqual(['Mine::helper', 'Mine::helper', 'Other::helper', 'Other::helper']);
  });

  it('leaves the members every object has to the type of the value', () => {
    expect(targetsFrom('src/Uni/UseUni.fs', 'calls')).toEqual([]);
  });

  it('reaches a member through a chain of properties', () => {
    expect(targetsFrom('src/Chain/UseChain.fs', 'calls')).toEqual(['Chain::Cfg::Save']);
  });

  it('reaches a C# type outside every namespace, and a module named in backticks', () => {
    expect(targetsFrom('src/Cs/UseGlobal.fs', 'calls')).toEqual(['GlobalCs::F']);
    expect(targetsFrom('src/Bt/UseBt.fs', 'calls')).toEqual(['``My Mod``::f']);
  });

  it('never links an F# name to a Razor component, or a C# name to an F# declaration', () => {
    expect(targetsFrom('src/Rz/UseErr.fs', 'calls')).toEqual([]);
    expect(targetsFrom('src/Fs2/Use.cs', 'calls')).toEqual([]);
  });

  it('does not take a fully qualified .NET path for a chain through a project type', () => {
    expect(targetsFrom('src/Ext/UseTask.fs', 'calls')).toEqual([]);
  });

  it('reads a bare name in its own file as it is read in another', () => {
    expect(targetsFrom('src/Same/Nest.fs', 'calls')).toEqual(['Nest::helper']);
    expect(targetsFrom('src/Same/Cls.fs', 'calls')).toContain('Cls::C::helper');
  });

  it('never lands a call on a module', () => {
    expect(targetsFrom('src/Mod/UseAdd.fs', 'calls')).toEqual([]);
    expect(targetsFrom('src/Mod/Same.fs', 'calls')).toEqual([]);
  });

  it('reaches a type member through a value only when the type is near', () => {
    expect(targetsFrom('src/Repo/UseNo.fs', 'calls')).toEqual([]);
    expect(targetsFrom('src/Repo/UseYes.fs', 'calls')).toEqual(['Shop.Core::Repo::Add']);
  });

  it('never links a call to a function in another language family', () => {
    expect(targetsFrom('src/Shop/Logs.fs', 'calls')).toEqual([]);
  });

  it('keeps the top of a script in its file unless opened or written through its module', () => {
    expect(targetsFrom('scripts/b.fsx', 'calls')).not.toContain('scriptHelper');
    expect(targetsFrom('scripts/c.fsx', 'calls')).toContain('scriptHelper');
    expect(targetsFrom('scripts/d.fsx', 'calls')).toContain('scriptHelper');
  });

  it('reaches a module of `namespace global` only through its name', () => {
    expect(targetsFrom('src/G/UseAsync1.fs', 'calls')).toEqual(['global::Async::mapG']);
    expect(targetsFrom('src/G/UseAsync2.fs', 'calls')).toEqual([]);
  });

  it('reaches `namespace global` from every file', () => {
    // A call to a type's constructor is an `instantiates` edge.
    expect(targetsFrom('src/G/UseG.fs', 'instantiates')).toContain('global::Gt');
  });

  it('links `inherit` and `interface ... with` across files', () => {
    expect(targetsFrom('src/Shop/Derived.fs', 'extends')).toContain('Shop.Core::Base');
    expect(targetsFrom('src/Shop/Derived.fs', 'implements')).toContain('Shop.Core::IGreeter');
  });
});
