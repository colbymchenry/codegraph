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
 *
 * C# reaches F# by its own lookup: an F# module is a static class,
 * so its functions are written through it (`Pricing.discount`), or bare under
 * `using static`; F# types are seen through the namespaces the file is in or
 * imports.
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

  it('reaches a member through a value only on the value\'s type or a type it inherits', () => {
    const save = (container: string): FsharpCandidateScope => candidate(container, { name: 'Save', kind: 'method', namespace: 'Shop.Core' });
    const typed = ref({ qualifiers: ['repo'], receivers: ['Shop.Core.Repo', 'Shop.Core.RepoBase'] });
    expect(isFsharpCandidateReachable(typed, save('Shop.Core.Repo'))).toBe(true);
    expect(isFsharpCandidateReachable(typed, save('Shop.Core.RepoBase'))).toBe(true);
    // Another type with a member of that name, in the same namespace: not the value's type.
    expect(isFsharpCandidateReachable(typed, save('Shop.Core.Cache'))).toBe(false);
    // A value whose type the source does not state names no member.
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['repo'], receivers: null }), save('Shop.Core.Repo'))).toBe(false);
  });

  it('reads many opens in linear time, each naming one declared namespace or module', () => {
    // Twenty opens of outside namespaces: once read as every joining of the ones before, they doubled each time.
    const many = ref({ opens: Array.from({ length: 20 }, (_, i) => `System.N${i}`) });
    const started = Date.now();
    expect(isFsharpCandidateReachable(many, candidate('Shop.Core'))).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
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

  it('reaches a class `let` bare only from inside its type, and a member never', () => {
    const own = candidate('M.T', { kind: 'method', classLet: true });
    expect(isFsharpCandidateReachable(ref({ container: 'M.T' }), own, true)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ container: 'M.Other' }), own, true)).toBe(false);
    expect(isFsharpCandidateReachable(ref({ container: 'M.T' }), own, false)).toBe(false);
    // A member is reached through the self identifier (`this.M`), inside its own type too.
    expect(isFsharpCandidateReachable(ref({ container: 'M.T' }), candidate('M.T', { kind: 'method' }), true)).toBe(false);
  });

  it('never reaches anything through a path the project does not declare', () => {
    // `System.Threading.Tasks.Task.Run`: not the `Run` of a project type that happens to be opened.
    const run = candidate('Ts.Runner', { kind: 'method', namespace: 'Ts', name: 'Run' });
    expect(isFsharpCandidateReachable(ref({ opens: ['Ts'], qualifiers: ['System.Threading.Tasks.Task'], externalQualifier: true }), run)).toBe(false);
    expect(isFsharpCandidateReachable(ref({ opens: ['Ts'], qualifiers: ['System.Threading.Tasks.Task'], receivers: null }), run)).toBe(false);
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

  it('reaches a member through a chain of properties by the type of the value it ends at', () => {
    const save = candidate('Shop.Core.Cfg', { kind: 'method', namespace: 'Shop.Core', name: 'Save' });
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Settings.Current'], receivers: ['Shop.Core.Cfg'] }), save)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['Settings.Current'], receivers: null }), save)).toBe(false);
    // A type's own `ToString` override is what `ToString` means on a value of that type.
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'], receivers: ['Shop.Core.Cfg'] }), { ...save, name: 'ToString' })).toBe(true);
  });

  it('reaches a container written through an `[<AutoOpen>]` module of an opened namespace', () => {
    const agentName = candidate('Core.Domain.AgentName', { autoOpened: ['Core.Domain'] });
    expect(isFsharpCandidateReachable(ref({ opens: ['Core'], qualifiers: ['AgentName'] }), agentName)).toBe(true);
    expect(isFsharpCandidateReachable(ref({ opens: ['Core'], qualifiers: ['AgentName'] }), candidate('Core.Domain.AgentName'))).toBe(false);
  });

  it('reaches nothing but a member through a value', () => {
    // A function is not reached through a value, whatever the value's type.
    expect(isFsharpCandidateReachable(ref({ qualifiers: ['x'], receivers: ['Shop.Core.Calc'] }), candidate('Shop.Core.Calc', { namespace: 'Shop.Core' }))).toBe(false);
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

describe('C# calls into F#', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotnet-to-fsharp-'));
    const files: Record<string, string> = {
      'Domain/Pricing.fs': `namespace Shop.Domain

type Customer = { Name: string; Email: string }

type Order(total: decimal) =
    member _.Total = total
    member _.Confirm() = ()

module Pricing =
    let discount (rate: decimal) price = price * (1m - rate)
    let format (x: decimal) = string x
`,
      'Other/Fmt.fs': `namespace Vendor.Text

module Fmt =
    let format (x: decimal) = string x
    let discount (r: decimal) p = p
`,
      'Web/Controller.cs': `using Shop.Domain;
using static Shop.Domain.Pricing;
using P = Shop.Domain.Pricing;

namespace Shop.Web
{
    public class OrderController
    {
        public decimal ViaModule(decimal p) { return Pricing.discount(0.1m, p); }
        public decimal ViaPath(decimal p) { return Shop.Domain.Pricing.discount(0.2m, p); }
        public decimal ViaAlias(decimal p) { return P.discount(0.3m, p); }
        public string ViaStatic(decimal p) { return format(p); }
        public void Build(decimal p) { var c = new Customer("n", "e"); var o = new Order(p); o.Confirm(); }
    }
}
`,
      'Web/NoUsing.cs': `namespace Elsewhere
{
    public class Lone
    {
        public decimal Run(decimal p) { return discount(0.1m, p) + Fmt.format(p).Length; }
    }
}
`,
      'Store/Order.fs': `namespace Store

type Order(total: decimal) =
    member _.Total = total
    static member Create(t) = Order(t)

module Order =
    let create t = Order(t)

module Prices =
    [<CompiledName("Discount")>]
    let discount (rate: decimal) price = price * (1m - rate)
`,
      'Store/Web.cs': `using Store;
using static Store.Order;

namespace Store.Api
{
    public class C
    {
        public object ViaTypeName(decimal t) { return Order.create(t); }
        public object ViaModuleClass(decimal t) { return OrderModule.create(t); }
        public object ViaCompiledName(decimal p) { return Prices.Discount(0.1m, p); }
        public object ViaFsharpName(decimal p) { return Prices.discount(0.1m, p); }
        public object ViaStaticMember(decimal t) { return Create(t); }
        public object OnForeignValue(System.Net.Http.HttpResponseMessage r) { return r.Total(); }
    }
}
`,
      'Near/Invoice.fs': `namespace Near

type Invoice() =
    member _.Id = 1
`,
      'Near/Domain/Invoice.fs': `namespace Near.Domain

type Invoice() =
    member _.Id = 2
`,
      'Near/Web/Billing.cs': `using Near.Domain;

namespace Near.Web
{
    public class Billing
    {
        public object Make() { return new Invoice(); }
    }
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgesOf = (file: string, method: string, kind: string): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === method)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === kind).map((e) => project.getNode(e.target)!.qualifiedName);
  };

  it('links a C# call through the module, its full path, an alias and `using static`', () => {
    expect(edgesOf('Web/Controller.cs', 'ViaModule', 'calls')).toEqual(['Shop.Domain::Pricing::discount']);
    expect(edgesOf('Web/Controller.cs', 'ViaPath', 'calls')).toEqual(['Shop.Domain::Pricing::discount']);
    expect(edgesOf('Web/Controller.cs', 'ViaAlias', 'calls')).toEqual(['Shop.Domain::Pricing::discount']);
    expect(edgesOf('Web/Controller.cs', 'ViaStatic', 'calls')).toEqual(['Shop.Domain::Pricing::format']);
  });

  it('links a C# construction of F# types and a call of a member on the value', () => {
    expect(edgesOf('Web/Controller.cs', 'Build', 'instantiates').sort()).toEqual(['Shop.Domain::Customer', 'Shop.Domain::Order']);
    expect(edgesOf('Web/Controller.cs', 'Build', 'calls')).toEqual(['Shop.Domain::Order::Confirm']);
  });

  it('links nothing a C# file does not import: not a bare module function, not another namespace\'s module', () => {
    expect(edgesOf('Web/NoUsing.cs', 'Run', 'calls')).toEqual([]);
  });

  it('names a module as C# compiles it: `OrderModule` beside a type `Order`, and a function by its `[<CompiledName>]`', () => {
    expect(edgesOf('Store/Web.cs', 'ViaTypeName', 'calls')).toEqual([]);
    expect(edgesOf('Store/Web.cs', 'ViaModuleClass', 'calls')).toEqual(['Store::Order::create']);
    expect(edgesOf('Store/Web.cs', 'ViaCompiledName', 'calls')).toEqual(['Store::Prices::discount']);
    expect(edgesOf('Store/Web.cs', 'ViaFsharpName', 'calls')).toEqual([]);
  });

  it('links a static member of an F# type under `using static`', () => {
    expect(edgesOf('Store/Web.cs', 'ViaStaticMember', 'calls')).toEqual(['Store::Order::Create']);
  });

  it('leaves a member on a value to its type: a foreign type\'s value links nothing in F#', () => {
    expect(edgesOf('Store/Web.cs', 'OnForeignValue', 'calls')).toEqual([]);
  });

  it('takes a type of a namespace around the code before one a using imports, as C# looks names up', () => {
    // From `namespace Near.Web`, `Invoice` is `Near.Invoice`, found in `Near` before `using Near.Domain;`.
    expect(edgesOf('Near/Web/Billing.cs', 'Make', 'instantiates')).toEqual(['Near::Invoice']);
  });

  it('shows the C# callers of an F# function', () => {
    const discountNode = project.getNodesInFile('Domain/Pricing.fs').find((n) => n.name === 'discount')!;
    const callers = project.getCallers(discountNode.id).map((c) => c.node.filePath).sort();
    expect(callers).toEqual(['Web/Controller.cs', 'Web/Controller.cs', 'Web/Controller.cs']);
  });
});

describe('F# members on a value, by the value\'s type', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-receivers-'));
    const files: Record<string, string> = {
      'T.fs': `namespace Shop

type RepoBase() =
    member _.Save() = 0

type Repo() =
    inherit RepoBase()
    member _.Add(x: int) = ()
    member this.Twice(x: int) = this.Add(x); this.Add(x)

type Cache() =
    member _.Add(x: int) = ()
    member _.Save() = 1
`,
      'U.fs': `module U

open Shop

let onForeign () =
    let xs = ResizeArray<int>()
    xs.Add(1)
let onTyped (r: Repo) = r.Add(1)
let onLocal () =
    let c = Cache()
    c.Add(2)
let inherited (r: Repo) = r.Save()
let unknown r = r.Add(3)
`,
    };
    files['Util.fs'] = `module Util

let format x = string x
`;
    files['Box.fs'] = `module Box

open Util

type Box(v: int) =
    let describe () = "box"
    member this.format() = "box"
    member this.Show() = format v
    member this.Name() = describe ()

type Shape =
    | Circle of float
    | Square of float
`;
    files['UseBox.fs'] = `module UseBox

let viaModule () = Box.Circle 1.0
let viaType () = Box.Shape.Square 2.0
`;
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a bare name inside a type as F# does: a class `let` or an opened function, never a member', () => {
    expect(callsOf('Box.fs', 'Show')).toEqual(['Util::format']);
    expect(callsOf('Box.fs', 'Name')).toEqual(['Box::Box::describe']);
  });

  it('links a union case written through the module its type is declared in, or through the type', () => {
    expect(callsOf('UseBox.fs', 'viaModule')).toEqual(['Box::Shape::Circle']);
    expect(callsOf('UseBox.fs', 'viaType')).toEqual(['Box::Shape::Square']);
  });

  const callsOf = (file: string, name: string): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === name)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === 'calls').map((e) => project.getNode(e.target)!.qualifiedName);
  };

  it('links a member on a value to the member of the value\'s own type', () => {
    expect(callsOf('U.fs', 'onTyped')).toEqual(['Shop::Repo::Add']);
    expect(callsOf('U.fs', 'onLocal')).toEqual(['Shop::Cache::Add']);
    expect(callsOf('T.fs', 'Twice')).toEqual(['Shop::Repo::Add', 'Shop::Repo::Add']);
  });

  it('links a member the value\'s type inherits', () => {
    expect(callsOf('U.fs', 'inherited')).toEqual(['Shop::RepoBase::Save']);
  });

  it('links nothing for a value of a type outside the project, or one the source does not state', () => {
    expect(callsOf('U.fs', 'onForeign')).toEqual([]);
    expect(callsOf('U.fs', 'unknown')).toEqual([]);
  });
});

describe('F# names bound the way F# binds them', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-binding-'));
    const files: Record<string, string> = {
      'Lib.fs': `namespace Lib

module Loose =
    let pick x = x
module Second =
    let pick x = x * 10
module Cases1 =
    type A = | Done | Fail
module Cases2 =
    type B = | Done | Retry
`,
      'Shop.fs': `namespace Shop

module Core =
    let helper x = x
`,
      'Dom.fs': `module Dom

type Customer = { Name: string; Email: string }
type Vendor = { Name: string; Code: int }

let (|Even|Odd|) n = if n % 2 = 0 then Even else Odd
let (|Int|_|) (s: string) = None

[<CompiledName("Calculate")>]
let compute x = x
`,
      'App.fs': `module App

open Lib.Loose
open Lib.Second
open Lib.Cases1
open Lib.Cases2
open Shop
open Core
open Dom

let lastOpen () = pick 1
let lastCase () = Done
let partialOpen () = helper 1
let mk n = { Name = n; Email = "" }
let mkCode n = { Name = n; Code = 1 }
let mkLatest n = { Name = n }
let cp (c: Customer) = { c with Name = "x" }
let qualified () = { Dom.Customer.Name = "y"; Email = "" }
let classify n =
    match n with
    | Even -> "even"
    | Odd -> "odd"
let parse s =
    match s with
    | Int i -> i
    | _ -> 0
`,
      'Web.cs': `public class Web
{
    public int Run(int x) { return Dom.Calculate(x); }
}
`,
      'Calc.fs': `namespace Calc

type Repo() =
    static member Make() = Repo()

type Base(n: int) =
    abstract Speak : unit -> string
    default _.Speak() = "base"

type Derived(n) =
    inherit Base(n)
    override x.Speak() = base.Speak() + "!"

module Ops =
    [<Literal>]
    let Limit = 10
    let inc x = x + 1
`,
      'Ext.fs': `namespace Ext

[<AutoOpen>]
module StringExt =
    type System.String with
        member s.Shout() = s.ToUpper()

type Order(total: decimal) =
    member _.Total = total

module OrderExt =
    type Order with
        member o.Doubled() = o.Total * 2m
`,
      'UseExt.fs': `module UseExt

open Ext
open Ext.OrderExt

let shout (s: string) = s.Shout()
let doubled (o: Order) = o.Doubled()
let mention (x: String) = x
let make () = String('a', 3)
`,
      'NoOpenExt.fs': `module NoOpenExt

let doubled (o: Ext.Order) = o.Doubled()
`,
      'UseCalc.fs': `module UseCalc

open Calc
open type Calc.Repo

let viaOpenType () = Make()
let backPipe () = Ops.inc <| 1
let composed = Ops.inc >> Ops.inc
let limit () = Ops.Limit
`,
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgesOf = (file: string, name: string, kind: string): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === name)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === kind).map((e) => project.getNode(e.target)!.qualifiedName);
  };

  it('takes what the later `open` brings in, for a function and for a union case', () => {
    expect(edgesOf('App.fs', 'lastOpen', 'calls')).toEqual(['Lib::Second::pick']);
    expect(edgesOf('App.fs', 'lastCase', 'references')).toEqual(['Lib::Cases2::B::Done']);
  });

  it('reads an `open` of a module relative to a namespace opened before it', () => {
    expect(edgesOf('App.fs', 'partialOpen', 'calls')).toEqual(['Shop::Core::helper']);
  });

  it('builds the record type F# infers from the labels, the latest declared one when several have them', () => {
    expect(edgesOf('App.fs', 'mk', 'instantiates')).toEqual(['Dom::Customer']);
    expect(edgesOf('App.fs', 'mkCode', 'instantiates')).toEqual(['Dom::Vendor']);
    expect(edgesOf('App.fs', 'mkLatest', 'instantiates')).toEqual(['Dom::Vendor']);
    expect(edgesOf('App.fs', 'cp', 'instantiates')).toEqual(['Dom::Customer']);
    expect(edgesOf('App.fs', 'qualified', 'instantiates')).toEqual(['Dom::Customer']);
  });

  it('links an active pattern\'s cases where a match uses them', () => {
    expect(edgesOf('App.fs', 'classify', 'references').sort()).toEqual(['Dom::(|Even|Odd|)::Even', 'Dom::(|Even|Odd|)::Odd']);
    expect(edgesOf('App.fs', 'parse', 'references')).toEqual(['Dom::(|Int|_|)::Int']);
  });

  it('brings a type\'s static members into scope with `open type`', () => {
    expect(edgesOf('UseCalc.fs', 'viaOpenType', 'calls')).toEqual(['Calc::Repo::Make']);
  });

  it('calls what `<|` applies, and references what `>>` composes and a value read', () => {
    expect(edgesOf('UseCalc.fs', 'backPipe', 'calls')).toEqual(['Calc::Ops::inc']);
    expect(edgesOf('UseCalc.fs', 'composed', 'references')).toEqual(['Calc::Ops::inc', 'Calc::Ops::inc']);
    expect(edgesOf('UseCalc.fs', 'limit', 'references')).toEqual(['Calc::Ops::Limit']);
  });

  it('links a member a type extension adds, where the extension is in scope', () => {
    expect(edgesOf('UseExt.fs', 'shout', 'calls')).toEqual(['Ext::StringExt::System.String::Shout']);
    expect(edgesOf('UseExt.fs', 'doubled', 'calls')).toEqual(['Ext::OrderExt::Order::Doubled']);
    expect(edgesOf('NoOpenExt.fs', 'doubled', 'calls')).toEqual([]);
  });

  it('never takes a type extension for a declaration of the type it extends', () => {
    expect(edgesOf('UseExt.fs', 'mention', 'references')).toEqual([]);
    expect(edgesOf('UseExt.fs', 'make', 'instantiates')).toEqual([]);
  });

  it('links `base.M()` to the member of the type inherited', () => {
    const speak = project.getNodesInFile('Calc.fs').find((n) => n.qualifiedName === 'Calc::Derived::Speak')!;
    expect(project.getOutgoingEdgesFrom([speak.id]).filter((e) => e.kind === 'calls').map((e) => project.getNode(e.target)!.qualifiedName))
      .toEqual(['Calc::Base::Speak']);
  });

  it('links a C# call by a `[<CompiledName>]` no F# name resembles', () => {
    expect(edgesOf('Web.cs', 'Run', 'calls')).toEqual(['Dom::compute']);
  });
});

describe('F# compilation order', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-order-'));
    const files: Record<string, string> = {
      'App/App.fsproj': `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Compile Include="Util.fs" />
    <Compile Include="Early.fs" />
    <Compile Include="Late.fs" />
  </ItemGroup>
</Project>
`,
      'App/Util.fs': `module Util

let helper x = x
`,
      'App/Early.fs': `module Early

let useUtil () = Util.helper 1
let useLate () = Late.helper 1
`,
      'App/Late.fs': `module Late

let helper x = x * 2
let useEarly () = Early.useUtil ()
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const callsOf = (file: string, name: string): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === name)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === 'calls').map((e) => project.getNode(e.target)!.qualifiedName);
  };

  it('links what files compiled before a file declare, and nothing a later file does', () => {
    expect(callsOf('App/Early.fs', 'useUtil')).toEqual(['Util::helper']);
    expect(callsOf('App/Late.fs', 'useEarly')).toEqual(['Early::useUtil']);
    // `Late.fs` is compiled after `Early.fs`: F# does not see its `Late.helper` there.
    expect(callsOf('App/Early.fs', 'useLate')).toEqual([]);
  });
});

describe('F# signature files and union cases as .NET sees them', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-fsi-'));
    const files: Record<string, string> = {
      'Lib.fsi': `module Lib

val shown : int -> int
`,
      'Lib.fs': `module Lib

let shown x = x
let hidden x = x
`,
      'Use.fs': `module Use

let a () = Lib.shown 1
let b () = Lib.hidden 1
`,
      'Shapes.fs': `namespace Geo

type Shape =
    | Circle of float
    | Empty
`,
      'Draw.cs': `using Geo;

public class Draw
{
    public object Make() { return Shape.NewCircle(1.0); }
    public object None() { return Shape.Empty; }
}
`,
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgesOf = (file: string, name: string, kinds: string[]): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === name)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => kinds.includes(e.kind)).map((e) => project.getNode(e.target)!.qualifiedName);
  };

  it('links from another file only what the signature file declares', () => {
    expect(edgesOf('Use.fs', 'a', ['calls'])).toEqual(['Lib::shown']);
    expect(edgesOf('Use.fs', 'b', ['calls'])).toEqual([]);
  });

  it('links C#\'s `Shape.NewCircle(...)` to the union\'s case, and `Shape.Empty` to the union', () => {
    expect(edgesOf('Draw.cs', 'Make', ['calls'])).toEqual(['Geo::Shape::Circle']);
    // A static member read records its type alone in C# (`Color.Red` of a C# enum too): the union type.
    expect(edgesOf('Draw.cs', 'None', ['calls', 'references'])).toEqual(['Geo::Shape']);
  });
});

describe('F# reads a file top to bottom, picks an overload by its arguments, and C# binds by its own lookup', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-order-'));
    const files: Record<string, string> = {
      'Order.fs': `module Order
let helper () = 1
module Inner =
    let run () = helper ()
    let helper () = 2
let rec isEven n = n = 0 || isOdd (n - 1)
and isOdd n = n <> 0 && isEven (n - 1)
module rec Both =
    let first () = second ()
    let second () = 1
let g () = 0
let f () = g ()
and g () = 1
type Tree =
    | Leaf
    | Node of Forest
// A forest is a list of trees.
and Forest = { Trees: Tree list }
`,
      'Shop.fs': `namespace Shop
module Pricing =
    let internal inner x = x
    let discount x = x
type Box() =
    member this.Add(x: int) = x
    member this.Add(x: string) = x
    member this.Put(x: int) = x
    member this.Put(x: int, y: int) = x + y
module Use =
    let one () =
        let b = Box()
        b.Add(1)
    let text () =
        let b = Box()
        b.Add("s")
    let pair () =
        let b = Box()
        b.Put(1, 2)
module private Helpers =
    let tidy x = x
`,
      'Shape.fs': `namespace Shop
[<RequireQualifiedAccess>]
type Shape = | Circle of float | Empty
module UseShape =
    let through () = Shape.Circle 1.0
    let bare () = Circle 1.0
type Tag = Tag of string
module Tag =
    let value (Tag t) = t
module UseTag =
    let make () = Tag "a"
    let read (t: Tag) = Tag.value t
    let wrap () = List.map Tag ["a"]
    let pair (m: Map<string, Tag>) = m
type Wrap<'a> =
    private Wrap of (unit -> 'a)
[<RequireQualifiedAccess>]
module Wrap =
    let build f = Wrap f
module Limits =
    let Limit = 3
    let under x = x < Limit
    let twice x = x * Limit
    let finish r = match r with Ok _ -> Shape.Empty | Error _ -> Shape.Empty
    let rest x xs = x :: Limit :: xs
    let lift (f: int -> Wrap<int>) = f
`,
      'Domain.fs': `namespace Shop.Domain
module Pricing =
    [<CompiledName("ApplyDiscount")>]
    let discount x = x
type Customer(name: string) =
    member this.Name = name
`,
      'Global.fs': `namespace global
module Util =
    let helper () = 1
`,
      'App.fs': `module App
open Util
let run () = helper ()
`,
      'WebPricing.cs': 'namespace Shop.Web { public static class Pricing { public static int discount(int x) { return x; } } public class Customer { } }\n',
      'Web.cs': `using Shop.Domain;
namespace Shop.Web { class Page { void Render() { Pricing.discount(1); var c = new Customer(); } } }
`,
      'Other.cs': `using Shop.Domain;
namespace Elsewhere { class Report { void Run() { Pricing.ApplyDiscount(1); var c = new Customer(); } void Closed() { Shop.Helpers.tidy(1); Shop.Pricing.inner(1); } } }
`,
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgesOf = (file: string, name: string, kinds: string[] = ['calls']): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === name)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => kinds.includes(e.kind)).map((e) => {
      const t = project.getNode(e.target)!;
      return `${t.language}:${t.qualifiedName}@${t.startLine}`;
    });
  };

  it('binds a name to what is declared above it, not to a namesake declared below', () => {
    expect(edgesOf('Order.fs', 'run')).toEqual(['fsharp:Order::helper@2']);
  });

  it('lets the bindings of one `let rec … and …`, the types of one `type … and …` and the contents of a `module rec` see each other', () => {
    expect(edgesOf('Order.fs', 'isEven')).toEqual(['fsharp:Order::isOdd@7']);
    expect(edgesOf('Order.fs', 'isOdd')).toEqual(['fsharp:Order::isEven@6']);
    expect(edgesOf('Order.fs', 'first')).toEqual(['fsharp:Order::Both::second@10']);
    // Without `rec` the bindings joined by `and` do not see each other: `f` calls the `g` above it.
    expect(edgesOf('Order.fs', 'f')).toEqual(['fsharp:Order::g@11']);
    // The types of one `type … and …` always do.
    expect(edgesOf('Order.fs', 'Node', ['references'])).toEqual(['fsharp:Order::Forest@18']);
  });

  it('picks the overload the arguments fit: by a literal\'s type, and by how many are passed', () => {
    expect(edgesOf('Shop.fs', 'one')).toEqual(['fsharp:Shop::Box::Add@6']);
    expect(edgesOf('Shop.fs', 'text')).toEqual(['fsharp:Shop::Box::Add@7']);
    expect(edgesOf('Shop.fs', 'pair')).toEqual(['fsharp:Shop::Box::Put@9']);
  });

  it('reaches a case of a `[<RequireQualifiedAccess>]` union only through its type', () => {
    expect(edgesOf('Shape.fs', 'through')).toEqual(['fsharp:Shop::Shape::Circle@3']);
    expect(edgesOf('Shape.fs', 'bare')).toEqual([]);
  });

  it('reads the name of a single-case union as its case where a value is written and as its type where a type is, never as its module', () => {
    expect(edgesOf('Shape.fs', 'make')).toEqual(['fsharp:Shop::Tag::Tag@7']);
    expect(edgesOf('Shape.fs', 'wrap', ['calls', 'references']).sort()).toEqual(['fsharp:Shop::Tag::Tag@7']);
    expect(edgesOf('Shape.fs', 'read', ['calls', 'references']).sort()).toEqual(['fsharp:Shop::Tag::value@9', 'fsharp:Shop::Tag@7']);
    expect(edgesOf('Shape.fs', 'pair', ['calls', 'references'])).toEqual(['fsharp:Shop::Tag@7']);
    // `[<RequireQualifiedAccess>]` on the module of the type's name is the module's, not the type's.
    expect(edgesOf('Shape.fs', 'build')).toEqual(['fsharp:Shop::Wrap::Wrap@16']);
    // A comparison, a product, a cons and a match arm are written where values are.
    expect(edgesOf('Shape.fs', 'under', ['references'])).toEqual(['fsharp:Shop::Limits::Limit@21']);
    expect(edgesOf('Shape.fs', 'twice', ['references'])).toEqual(['fsharp:Shop::Limits::Limit@21']);
    expect(edgesOf('Shape.fs', 'rest', ['references'])).toEqual(['fsharp:Shop::Limits::Limit@21']);
    expect(edgesOf('Shape.fs', 'finish', ['references'])).toEqual(['fsharp:Shop::Shape::Empty@3', 'fsharp:Shop::Shape::Empty@3']);
    // After an arrow either may stand, but only a type takes type arguments.
    expect(edgesOf('Shape.fs', 'lift', ['references'])).toEqual(['fsharp:Shop::Wrap@15']);
  });

  it('opens a module of `namespace global` by its name', () => {
    expect(edgesOf('App.fs', 'run')).toEqual(['fsharp:global::Util::helper@3']);
  });

  it('lets a C# namesake in a namespace around the code win over F# reached through a using', () => {
    expect(edgesOf('Web.cs', 'Render', ['calls', 'instantiates']).sort()).toEqual(['csharp:Shop.Web::Customer@1', 'csharp:Shop.Web::Pricing::discount@1']);
    expect(edgesOf('Other.cs', 'Run', ['calls', 'instantiates']).sort()).toEqual(['fsharp:Shop.Domain::Customer@5', 'fsharp:Shop.Domain::Pricing::discount@4']);
  });

  it('never links C# to what F# keeps inside its assembly: a private module\'s contents, an internal binding', () => {
    expect(edgesOf('Other.cs', 'Closed')).toEqual([]);
  });
});

describe('F# overloads with function types and optional parameters, named arguments, types in expressions, and `private`', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-access-'));
    const files: Record<string, string> = {
      'M.fs': `module M
let size = 3
type IShape = abstract Area : float
type Circle(r: float) =
    interface IShape with member _.Area = r
    member this.Scale(size: int) = size
type Box() =
    member this.Map(f: int -> int, y: int) = f y
    member this.Map(f: int -> int) = f 0
    member this.Opt(a: int, ?b: int) = a
    member this.Opt(a: int64) = int a
let named () = Circle(1.0).Scale(size = 2)
let equality () = List.exists (fun x -> x = size) [1]
let typeTest (o: obj) = match o with :? Circle as c -> 1 | _ -> 0
let upcast' (c: Circle) = c :> IShape
let typeOf () = typeof<Circle>
let useMap () =
    let b = Box()
    b.Map((fun x -> x), 1)
let useOpt () =
    let b = Box()
    b.Opt(1)
let namedApplied () = Circle(1.0).Scale(size = id 2)
`,
      'A.fs': `namespace Shop
type private Cache() =
    member _.Get() = 1
module private Helpers =
    let tidy x = x
`,
      'B.fs': `namespace Shop
module Use =
    let cache () = Cache()
    let tidy () = Helpers.tidy 1
`,
      'Other.fs': `namespace Elsewhere
open Shop
module Use =
    let tidy () = Helpers.tidy 1
`,
      'Domain.fs': `namespace Shop.Domain
type Customer(name: string) =
    member this.Name = name
module Pricing =
    let discount x = x
`,
      'Web.cs': `using static Shop.Domain.Pricing;
using Shop.Domain;
namespace Web {
  class Own { class Customer { } static int discount(int x) { return x; } void Run() { discount(1); var c = new Customer(); } }
  class Plain { void Run() { discount(1); var c = new Customer(); } }
}
`,
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgesOf = (file: string, name: string, kinds: string[] = ['calls', 'instantiates', 'references'], owner?: string): string[] => {
    const id = project.getNodesInFile(file).find((n) => n.name === name && (!owner || n.qualifiedName.includes(owner)))!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => kinds.includes(e.kind)).map((e) => {
      const t = project.getNode(e.target)!;
      return `${e.kind}:${t.language}:${t.qualifiedName}@${t.startLine}`;
    }).sort();
  };

  it('splits arguments and parameters past the arrows of function types and lambdas', () => {
    expect(edgesOf('M.fs', 'useMap', ['calls'])).toEqual(['calls:fsharp:M::Box::Map@8']);
  });

  it('lets a call leave an optional parameter out, and prefers the exact type then', () => {
    expect(edgesOf('M.fs', 'useOpt', ['calls'])).toEqual(['calls:fsharp:M::Box::Opt@10']);
  });

  it('reads a named argument\'s label as the parameter it sets, and an equality handed to a function as a value', () => {
    expect(edgesOf('M.fs', 'named', ['references'])).toEqual([]);
    // `size = id 2` is read as `(size = id) 2`, still a named argument.
    expect(edgesOf('M.fs', 'namedApplied', ['references'])).toEqual([]);
    expect(edgesOf('M.fs', 'equality', ['references'])).toEqual(['references:fsharp:M::size@2']);
  });

  it('references the types of type tests, casts and `typeof`', () => {
    expect(edgesOf('M.fs', 'typeTest', ['references'])).toEqual(['references:fsharp:M::Circle@4']);
    expect(edgesOf('M.fs', 'upcast\'', ['references'])).toEqual(['references:fsharp:M::Circle@4', 'references:fsharp:M::IShape@3']);
    expect(edgesOf('M.fs', 'typeOf', ['references'])).toEqual(['references:fsharp:M::Circle@4']);
  });

  it('keeps a namespace\'s `private` to that namespace, in any of its files, and no further', () => {
    expect(edgesOf('B.fs', 'cache', ['instantiates'])).toEqual(['instantiates:fsharp:Shop::Cache@2']);
    expect(edgesOf('B.fs', 'tidy', ['calls'])).toEqual(['calls:fsharp:Shop::Helpers::tidy@5']);
    expect(edgesOf('Other.fs', 'tidy', ['calls'])).toEqual([]);
  });

  it('lets a C# type\'s own member or nested type win over what `using` and `using static` bring from F#', () => {
    expect(edgesOf('Web.cs', 'Run', ['calls', 'instantiates'], 'Own')).toEqual(['calls:csharp:Web::Own::discount@4', 'instantiates:csharp:Web::Own::Customer@4']);
    expect(edgesOf('Web.cs', 'Run', ['calls', 'instantiates'], 'Plain')).toEqual(['calls:fsharp:Shop.Domain::Pricing::discount@5', 'instantiates:fsharp:Shop.Domain::Customer@2']);
  });
});

describe('F# names as the extractor writes them: the path, its position, and the type a binding gives a value', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-bindings-'));
    const files: Record<string, string> = {
      'Types.fs': `namespace Shop

type Repo() =
    member _.Save() = 1
    member this.Add(x: int) : Repo = this

type Cache() =
    member _.Save() = 2

module Settings =
    let Current = Repo()
`,
      'Use.fs': `module Use

open Shop

module Calc =
    let helper x = x

let helper x = x + 1
let make () = Repo()

let shadowed (r: Cache) =
    let r = Repo()
    r.Save()
let twoOnALine () = Calc.helper 1 + helper 2
let viaFactory () =
    let r = make ()
    r.Save()
let repo = Repo()
let viaModuleValue () = repo.Save()
let viaOtherFile () = Settings.Current.Save()
let viaChain () = (Repo()).Add(1).Save()

type Svc() as self =
    let store = Cache()
    member _.Go() = store.Save()
    member _.Run() = self.Go()
`,
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const callsOf = (name: string): string[] => {
    const id = project.getNodesInFile('Use.fs').find((n) => n.name === name)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === 'calls').map((e) => project.getNode(e.target)!.qualifiedName).sort();
  };

  it('types a value by the nearest binding of its name: a `let` over a parameter wins', () => {
    expect(callsOf('shadowed')).toEqual(['Shop::Repo::Save']);
  });

  it('reads each call of a line at its own name, with its own qualifier', () => {
    expect(callsOf('twoOnALine')).toEqual(['Use::Calc::helper', 'Use::helper']);
  });

  it('types a value by what the function it is bound to returns', () => {
    expect(callsOf('viaFactory')).toEqual(['Shop::Repo::Save', 'Use::make']);
  });

  it('types a module value, in this file or another, by what it is bound to', () => {
    expect(callsOf('viaModuleValue')).toEqual(['Shop::Repo::Save']);
    expect(callsOf('viaOtherFile')).toEqual(['Shop::Repo::Save']);
  });

  it('types a chain of calls by what each member returns', () => {
    expect(callsOf('viaChain')).toEqual(['Shop::Repo::Add', 'Shop::Repo::Save']);
  });

  it('types a class `let` and the `as self` identifier', () => {
    expect(callsOf('Go')).toEqual(['Shop::Cache::Save']);
    expect(callsOf('Run')).toEqual(['Use::Svc::Go']);
  });
});

describe('C# deriving from an F# class', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fsharp-derive-'));
    fs.writeFileSync(path.join(dir, 'Handler.fs'), `namespace Shop

type Handler() =
    member _.Confirm() = ()
    static member Shared() = 1
`);
    fs.writeFileSync(path.join(dir, 'MyHandler.cs'), `using Shop;
namespace Web {
  class MyHandler : Handler {
    void Bare() { Confirm(); }
    void ViaThis() { this.Confirm(); }
    void ViaBase() { base.Confirm(); }
    void Static() { Shared(); }
  }
  class Own : Handler {
    void Confirm() { }
    void Bare() { Confirm(); }
  }
}
`);
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const callsOf = (owner: string, name: string): string[] => {
    const id = project.getNodesInFile('MyHandler.cs').find((n) => n.name === name && n.qualifiedName.includes(owner))!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === 'calls').map((e) => project.getNode(e.target)!.qualifiedName);
  };

  it('reaches the members it inherits from F#, bare and through `this` and `base`, static ones too', () => {
    expect(callsOf('MyHandler', 'Bare')).toEqual(['Shop::Handler::Confirm']);
    expect(callsOf('MyHandler', 'ViaThis')).toEqual(['Shop::Handler::Confirm']);
    expect(callsOf('MyHandler', 'ViaBase')).toEqual(['Shop::Handler::Confirm']);
    expect(callsOf('MyHandler', 'Static')).toEqual(['Shop::Handler::Shared']);
  });

  it('lets its own member hide the inherited one', () => {
    expect(callsOf('Own', 'Bare')).toEqual(['Web::Own::Confirm']);
  });
});

describe('C# reaches F# only where C#\'s own lookup finds it', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotnet-checked-'));
    const files: Record<string, string> = {
      'Lib/Core.fs': `namespace global

[<RequireQualifiedAccess>]
module List =
    let all p xs = true

[<RequireQualifiedAccess>]
module Result =
    let map f r = r
`,
      'Lib/Proxies.fs': `namespace Io.Proxies

type IDirectoryProxy =
    abstract Exists : string -> bool

type Box<'T>(v: 'T) =
    member _.Value = v

type Pair<'a, 'b> = { A: 'a; B: 'b }

type Abbrev = int list

type Measured<[<Measure>] 'u> = { V: float<'u> }

type GrpcLogger() =
    member _.Debug(message: string) = ()

type ProvidedField() =
    member _.GetCustomAttributes(inherit: bool) = [||]

type ProvidedProperty() =
    member _.GetCustomAttributes(inherit: bool) = [||]

type ImageAlbum() =
    member _.Count = 0

[<CompiledName("Wrapped\`1")>]
type Wrapped<'a> = private Wrapped of 'a

[<CompiledName("Wrapped")>]
[<RequireQualifiedAccess>]
module Wrapped =
    let zero = 0
`,
      'Lib/Hidden.fs': `namespace Vendor.Internal

module Reader =
    type File() =
        member _.Name = ""

module Task =
    let run x = x
`,
      'App/Shared/Result.cs': 'namespace App.Shared { public struct Result<T> { public T Value; } }\n',
      'App/Files/IFile.cs': `namespace App.Files
{
    public interface IFile { bool Exists(string path); }
    public class AtomicFile { public bool Exists(string path) { return true; } }
}
`,
      'App/Ui/Vm.cs': `using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using App.Shared;
using Io.Proxies;
using ImageAlbum = System.Collections.Immutable.ImmutableList<int>;

namespace App.Ui
{
    public class Vm
    {
        private readonly IDirectoryProxy _dirs;
        public Result<int> Get() { var list = new List<int>(); return default; }
        public void Files() { if (File.Exists("x")) { } }
        public async void Tasks() { await Task.WhenAll(); }
        public void Logs() { Log.Logger.Debug("x"); }
        public void Fields() { foreach (var field in typeof(Vm).GetFields()) { field.GetCustomAttributes(false); } }
        public void Proxy() { if (_dirs.Exists("d")) { } }
        public object Boxes() { return new Box<int>(1); }
        public object Pairs(Pair<int, string> p) { return p; }
        public object Abbrevs(Abbrev a) { return a; }
        public object Measures(Measured m) { return m; }
        public object Wraps(Wrapped<int> w) { return w; }
    }

    public class Group : List<int> { }

    public class DirProxy : IDirectoryProxy { public bool Exists(string path) { return true; } }
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const edgesOf = (method: string, kind: string): string[] => {
    const id = project.getNodesInFile('App/Ui/Vm.cs').find((n) => n.name === method)!.id;
    return project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === kind)
      .map((e) => `${project.getNode(e.target)!.language}:${project.getNode(e.target)!.qualifiedName}`).sort();
  };

  it('takes a name written with type arguments as a type declaring as many: no F# module', () => {
    expect(edgesOf('Get', 'instantiates')).toEqual([]);
    expect(edgesOf('Get', 'references')).toEqual(['csharp:App.Shared::Result']);
  });

  it('links an F# type written with as many type arguments as it declares', () => {
    expect(edgesOf('Boxes', 'instantiates')).toEqual(['fsharp:Io.Proxies::Box']);
    expect(edgesOf('Pairs', 'references')).toEqual(['fsharp:Io.Proxies::Pair']);
  });

  it('reads the metadata name of a generic type, Wrapped`1, as the name C# writes with one type argument', () => {
    const id = project.getNodesInFile('App/Ui/Vm.cs').find((n) => n.name === 'Wraps')!.id;
    const targets = project.getOutgoingEdgesFrom([id]).filter((e) => e.kind === 'references').map((e) => project.getNode(e.target)!)
      .map((t) => `${t.kind}:${t.qualifiedName}`);
    expect(targets).toEqual(['union:Io.Proxies::Wrapped']);
  });

  it('counts no unit-of-measure parameter, which .NET erases, and links no abbreviation, which it erases too', () => {
    expect(edgesOf('Measures', 'references')).toEqual(['fsharp:Io.Proxies::Measured']);
    expect(edgesOf('Abbrevs', 'references')).toEqual([]);
  });

  it('guesses no project method for a library type because F# declares a namesake the file cannot see', () => {
    expect(edgesOf('Files', 'calls')).toEqual([]);
    expect(edgesOf('Tasks', 'calls')).toEqual([]);
  });

  it('links no F# member by a word its owner shares with the receiver, nor on a value of a library type', () => {
    expect(edgesOf('Logs', 'calls')).toEqual([]);
    expect(edgesOf('Fields', 'calls')).toEqual([]);
  });

  it('takes a base type written with type arguments as a type declaring as many', () => {
    expect(edgesOf('Group', 'extends')).toEqual([]);
  });

  it('links an F# interface a C# class lists as a base', () => {
    expect(edgesOf('DirProxy', 'implements')).toEqual(['fsharp:Io.Proxies::IDirectoryProxy']);
  });

  it('imports no F# type a using alias is named like: the alias names what it stands for', () => {
    const imports = project.getNodesInFile('App/Ui/Vm.cs').flatMap((n) => project.getOutgoingEdgesFrom([n.id]))
      .filter((e) => e.kind === 'imports').map((e) => project.getNode(e.target)!)
      .filter((t) => t.language === 'fsharp').map((t) => t.qualifiedName).sort();
    expect(imports).toEqual(['Io.Proxies']);
  });

  it('links a member of the F# type C# reads a value to have', () => {
    expect(edgesOf('Proxy', 'calls')).toEqual(['fsharp:Io.Proxies::IDirectoryProxy::Exists']);
  });
});

describe('C# and Razor names are read as written: the whole path, the type arguments, the directives', () => {
  let dir = '';
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotnet-written-'));
    const files: Record<string, string> = {
      'Lib/Lib.fsproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="Model.fs" /><Compile Include="Build.fs" /></ItemGroup></Project>\n',
      'Lib/Model.fs': `namespace Shop.Model

type Color =
    | Red
    | Green

type ImageAlbum() =
    member _.Count = 0

type VersionedIO<'a> =
    | Fresh of 'a
    | Stale of 'a * int

type Customer = { Name: string }

module Pricing =
    let discount (rate: decimal) price = price * (1m - rate)
`,
      'Lib/Build.fs': `namespace Shop.Build

type BuildInfo() =
    static member Version = "1"
    member _.Stamp() = 0

type Grid<'T>() =
    member _.Rows = 0
`,
      'Lib/Top.fs': `namespace global

type Gt() =
    member _.Id = 0
`,
      'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Razor"><PropertyGroup><RootNamespace>Shop.App</RootNamespace></PropertyGroup><ItemGroup><Using Include="Shop.Build" /><ProjectReference Include="..\\Lib\\Lib.fsproj" /></ItemGroup></Project>\n',
      'App/Paint.cs': `using System.Collections.Immutable;
using Shop.Model;
using ImageAlbum = System.Collections.Immutable.ImmutableList<Shop.Model.Customer>;
using Versions = Shop.Model.VersionedIO<int>;
using M = Shop.Model;

namespace Shop.App
{
    public class Paint
    {
        public object Qualified(System.Drawing.Color c) { return c; }
        public object Bare(Color c) { return c; }
        public object Aliased(ImageAlbum a) { return a; }
        public object Generic(VersionedIO<int> v) { return v; }
        public object Unwritten(VersionedIO v) { return v; }
        public object ViaAlias(Versions v) { return v; }
        public object ViaNamespaceAlias(decimal p) { return M.Pricing.discount(0.1m, p); }
        public object AroundTheCode(decimal p) { return Model.Pricing.discount(0.1m, p); }
        public object Global() { return new Gt(); }
        public object GlobalQualified() { return new global::Shop.Model.ImageAlbum(); }
        public object FromProjectUsing() { return new BuildInfo().Stamp(); }
    }
}
`,
      'App/Views/Card.cs': 'namespace Shop.Model.Views { public class Card { } }\n',
      'Other/Far.cs': `using Shop;

namespace Elsewhere
{
    public class Far
    {
        public object NotThroughAUsing(decimal p) { return Model.Pricing.discount(0.1m, p); }
    }
}
`,
      'App/_Imports.razor': '@using Shop.Model\n',
      'App/Pages/Info.razor': `@page "/info"
@inject BuildInfo Build

<h1>@Build.Stamp()</h1>
<Grid TItem="Customer" />

@code {
    private Color shade = Color.Red;
    private int Stamp() { return Build.Stamp(); }
}
`,
      'App/Pages/Plain.razor': `<p>plain</p>

@code {
    private System.Drawing.Color shade;
    private BuildInfo info = new BuildInfo();
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fsharpTargets = (file: string, name: string | null, kind: string): string[] =>
    project.getNodesInFile(file).filter((n) => name === null || n.name === name)
      .flatMap((n) => project.getOutgoingEdgesFrom([n.id])).filter((e) => e.kind === kind)
      .map((e) => project.getNode(e.target)!).filter((t) => t.language === 'fsharp')
      .map((t) => `${t.kind}:${t.qualifiedName}`).sort();

  it('reads a path from its first name: `System.Drawing.Color` is no project type named Color', () => {
    expect(fsharpTargets('App/Paint.cs', 'Qualified', 'references')).toEqual([]);
    expect(fsharpTargets('App/Paint.cs', 'Bare', 'references')).toEqual(['union:Shop.Model::Color']);
  });

  it('reads an alias as what it stands for, type arguments and all', () => {
    expect(fsharpTargets('App/Paint.cs', 'Aliased', 'references')).toEqual([]);
    expect(fsharpTargets('App/Paint.cs', 'ViaAlias', 'references')).toEqual(['union:Shop.Model::VersionedIO']);
    expect(fsharpTargets('App/Paint.cs', 'ViaNamespaceAlias', 'calls')).toEqual(['function:Shop.Model::Pricing::discount']);
  });

  it('links a generic union written with as many type arguments as it declares, and with no other count', () => {
    expect(fsharpTargets('App/Paint.cs', 'Generic', 'references')).toEqual(['union:Shop.Model::VersionedIO']);
    expect(fsharpTargets('App/Paint.cs', 'Unwritten', 'references')).toEqual([]);
  });

  it('looks a path up in each namespace around the code, and through no using of a namespace above it', () => {
    expect(fsharpTargets('App/Paint.cs', 'AroundTheCode', 'calls')).toEqual(['function:Shop.Model::Pricing::discount']);
    expect(fsharpTargets('Other/Far.cs', 'NotThroughAUsing', 'calls')).toEqual([]);
  });

  it('reaches the global namespace from anywhere, bare and through `global::`', () => {
    expect(fsharpTargets('App/Paint.cs', 'Global', 'instantiates')).toEqual(['class:global::Gt']);
    expect(fsharpTargets('App/Paint.cs', 'GlobalQualified', 'instantiates')).toEqual(['class:Shop.Model::ImageAlbum']);
  });

  it('imports the F# namespace a using names, where C# declares only namespaces inside it', () => {
    const imports = project.getNodesInFile('App/Paint.cs').flatMap((n) => project.getOutgoingEdgesFrom([n.id]))
      .filter((e) => e.kind === 'imports').map((e) => project.getNode(e.target)!)
      .map((t) => `${t.language}:${t.kind}:${t.qualifiedName}`).sort();
    expect(imports).toContain('fsharp:namespace:Shop.Model');
  });

  it('takes a project file\'s `<Using>` items as usings of every file of the project', () => {
    expect(fsharpTargets('App/Paint.cs', 'FromProjectUsing', 'instantiates')).toEqual(['class:Shop.Build::BuildInfo']);
    expect(fsharpTargets('App/Paint.cs', 'FromProjectUsing', 'calls')).toEqual(['method:Shop.Build::BuildInfo::Stamp']);
  });

  it('links what a Razor file names in its directives, tags and code, through its own and `_Imports.razor`\'s usings', () => {
    const all = [...new Set(['references', 'calls', 'instantiates', 'type_of'].flatMap((kind) => fsharpTargets('App/Pages/Info.razor', null, kind)))].sort();
    expect(all).toEqual([
      'class:Shop.Build::BuildInfo',
      'class:Shop.Build::Grid',
      'class:Shop.Model::Customer',
      'method:Shop.Build::BuildInfo::Stamp',
      'union:Shop.Model::Color',
    ]);
  });

  it('links no F# type a Razor file writes a library path for', () => {
    const all = [...new Set(['references', 'calls', 'instantiates', 'type_of'].flatMap((kind) => fsharpTargets('App/Pages/Plain.razor', null, kind)))].sort();
    expect(all).toEqual(['class:Shop.Build::BuildInfo']);
  });

  it('looks a name up the same way after a sync: a new C# file, and a using an edit adds', async () => {
    fs.writeFileSync(path.join(dir, 'App/Later.cs'), 'namespace Shop.App { public class Later { public object Make() { return new Shop.Model.ImageAlbum(); } } }\n');
    fs.writeFileSync(path.join(dir, 'Other/Far.cs'), 'using Shop.Model;\nnamespace Elsewhere { public class Far { public object NotThroughAUsing(decimal p) { return Pricing.discount(0.1m, p); } } }\n');
    await project.sync();
    expect(fsharpTargets('App/Later.cs', 'Make', 'instantiates')).toEqual(['class:Shop.Model::ImageAlbum']);
    expect(fsharpTargets('Other/Far.cs', 'NotThroughAUsing', 'calls')).toEqual(['function:Shop.Model::Pricing::discount']);
  });
});

describe('C# sees the F# of the projects its project references', () => {
  let dir = '';
  let project: CodeGraph;
  const appProject = (references: string[]): string =>
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>${references.map((r) => `<ProjectReference Include="${r}" />`).join('')}</ItemGroup></Project>\n`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotnet-projects-'));
    const files: Record<string, string> = {
      'Fs/LibA/LibA.fsproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="A.fs" /></ItemGroup></Project>\n',
      'Fs/LibA/A.fs': 'namespace Shop.A\n\ntype Order() =\n    member _.Id = 0\n',
      'Fs/LibB/LibB.fsproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="B.fs" /><Compile Include="..\\Shared\\Linked.fs" /></ItemGroup></Project>\n',
      'Fs/LibB/B.fs': 'namespace global\n\nmodule Task =\n    let FromResult x = x\n',
      'Fs/LibC/LibC.fsproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="C.fs" /></ItemGroup></Project>\n',
      'Fs/LibC/C.fs': 'namespace Shop.C\n\ntype Invoice() =\n    member _.Total = 0\n',
      'Fs/Shared/Linked.fs': 'namespace Shop.Linked\n\ntype Note() =\n    member _.Text = ""\n',
      'Cs/Mid/Mid.csproj': appProject(['..\\..\\Fs\\LibC\\LibC.fsproj']),
      'Cs/Mid/Mid.cs': 'namespace Shop.Mid { public class Mid { } }\n',
      'Cs/App/App.csproj': appProject(['..\\..\\Fs\\LibA\\LibA.fsproj', '..\\Mid\\Mid.csproj']),
      'Cs/App/Use.cs': `using System.Threading.Tasks;
using Shop.A;
using Shop.C;
using Shop.Linked;

namespace Shop.App
{
    public class Use
    {
        public object Direct() { return new Order(); }
        public object Transitive() { return new Invoice(); }
        public object Unreferenced() { return Task.FromResult(1); }
        public object LinkedFile() { return new Note(); }
    }
}
`,
      'Loose/Free.cs': 'using Shop.Linked;\nnamespace Loose { public class Free { public object Any() { return new Note(); } } }\n',
      'Cs/Core/Core.cs': 'namespace Shop.Mixed { public static class Strings { } }\n',
      'Cs/App/Mixed.fs': 'namespace Shop.Mixed\n\ntype Near() =\n    member _.Id = 0\n',
      'Cs/App/UsesMixed.cs': 'using Shop.Mixed;\nnamespace Shop.App { public class UsesMixed { } }\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    project = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    project?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fsharpTargets = (file: string, name: string | null, kind: string): string[] =>
    project.getNodesInFile(file).filter((n) => name === null || n.name === name)
      .flatMap((n) => project.getOutgoingEdgesFrom([n.id])).filter((e) => e.kind === kind)
      .map((e) => project.getNode(e.target)!).filter((t) => t.language === 'fsharp')
      .map((t) => `${t.kind}:${t.qualifiedName}`).sort();

  it('links an F# type of a project the C# project references, directly or through another project', () => {
    expect(fsharpTargets('Cs/App/Use.cs', 'Direct', 'instantiates')).toEqual(['class:Shop.A::Order']);
    expect(fsharpTargets('Cs/App/Use.cs', 'Transitive', 'instantiates')).toEqual(['class:Shop.C::Invoice']);
  });

  it('links nothing of an F# project the C# project does not reference, a file it compiles from elsewhere included', () => {
    expect(fsharpTargets('Cs/App/Use.cs', 'Unreferenced', 'calls')).toEqual([]);
    expect(fsharpTargets('Cs/App/Use.cs', 'LinkedFile', 'instantiates')).toEqual([]);
    expect(fsharpTargets('Cs/App/Use.cs', null, 'imports')).toEqual(['namespace:Shop.A', 'namespace:Shop.C']);
  });

  it('links a using of a namespace C# declares to C#\'s, however near an F# declaration of it is', () => {
    const imports = project.getNodesInFile('Cs/App/UsesMixed.cs').flatMap((n) => project.getOutgoingEdgesFrom([n.id]))
      .filter((e) => e.kind === 'imports').map((e) => project.getNode(e.target)!).map((t) => `${t.language}:${t.qualifiedName}`);
    expect(imports).toEqual(['csharp:Shop.Mixed']);
  });

  it('lets C# that no project compiles see every F# declaration', () => {
    expect(fsharpTargets('Loose/Free.cs', 'Any', 'instantiates')).toEqual(['class:Shop.Linked::Note']);
  });

  it('looks again after a sync when a project file gains a reference', async () => {
    fs.writeFileSync(path.join(dir, 'Cs/App/App.csproj'), appProject(['..\\..\\Fs\\LibA\\LibA.fsproj', '..\\Mid\\Mid.csproj', '..\\..\\Fs\\LibB\\LibB.fsproj']));
    await project.sync();
    expect(fsharpTargets('Cs/App/Use.cs', 'Unreferenced', 'calls')).toEqual(['function:global::Task::FromResult']);
    expect(fsharpTargets('Cs/App/Use.cs', 'LinkedFile', 'instantiates')).toEqual(['class:Shop.Linked::Note']);
  });
});
