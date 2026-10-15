import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars, isLanguageSupported, isSourceFile } from '../src/extraction/grammars';

const SAMPLE = `(** Module doc *)
open Core
include Foo.Bar

type color = Red | Green of int
type pt = { x : int; y : int }
type 'a t = 'a list
exception Oops of string
external c_add : int -> int -> int = "c_add"

(** Adds numbers. *)
let add x y = x + y
let rec fact n = if n = 0 then 1 else n * fact (n - 1)
let v = 42
let f = fun x -> add x 1
let (>>=) a b = b a
let () = print_endline (String.concat "," [])

module Inner = struct
  let helper () = add 1 2
  type s = A | B
end

module type SIG = sig
  val foo : int -> int
end

module F (X : SIG) = struct
  let g () = X.foo 1
end

class counter = object
  val mutable n = 0
  method incr = n <- n + 1
end

let use () = Inner.helper ()
`;

describe('OCaml extraction', () => {
  let result: ReturnType<typeof extractFromSource>;
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    result = extractFromSource('lib/sample.ml', SAMPLE);
  });
  const find = (kind: string, name: string) => result.nodes.find((n) => n.kind === kind && n.name === name);
  const callsOf = (fromName: string) => {
    const from = result.nodes.find((n) => n.name === fromName)!;
    return result.unresolvedReferences
      .filter((r) => r.fromNodeId === from.id && r.referenceKind === 'calls')
      .map((r) => r.referenceName);
  };

  it('detects .ml files', () => {
    expect(isLanguageSupported('ocaml')).toBe(true);
    expect(isSourceFile('lib/foo.ml')).toBe(true);
  });

  it('extracts functions, constants and operators', () => {
    expect(find('function', 'add')?.signature).toBe('add x y');
    expect(find('function', 'add')?.docstring).toContain('Adds numbers');
    expect(find('function', 'fact')).toBeDefined();
    expect(find('function', 'f')).toBeDefined(); // fun-valued binding
    expect(find('function', '>>=')).toBeDefined();
    expect(find('constant', 'v')).toBeDefined();
    expect(find('function', 'c_add')).toBeDefined(); // external
  });

  it('extracts types, members and exceptions', () => {
    expect(find('enum', 'color')).toBeDefined();
    expect(find('enum_member', 'Green')).toBeDefined();
    expect(find('struct', 'pt')).toBeDefined();
    expect(find('field', 'y')).toBeDefined();
    expect(find('type_alias', 't')).toBeDefined();
    expect(find('class', 'Oops')).toBeDefined();
  });

  it('extracts modules, module types, functors and classes', () => {
    expect(find('module', 'Inner')).toBeDefined();
    expect(find('function', 'helper')?.qualifiedName).toBe('Sample::Inner::helper');
    expect(find('interface', 'SIG')).toBeDefined();
    expect(find('method', 'foo')).toBeDefined();
    expect(find('function', 'g')?.qualifiedName).toContain('Sample::F::g');
    expect(find('class', 'counter')).toBeDefined();
    expect(find('method', 'incr')).toBeDefined();
  });

  it('emits imports for open and include', () => {
    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toEqual(expect.arrayContaining(['Core', 'Foo.Bar']));
  });

  it('emits calls with module paths as Mod::fn', () => {
    expect(callsOf('fact')).toContain('fact');
    expect(callsOf('f')).toContain('add');
    expect(callsOf('use')).toContain('Inner::helper');
    expect(callsOf('g')).toContain('X::foo');
  });
});

describe('OCaml resolution', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ocaml-'));
    const files: Record<string, string> = {
      'lib/util.ml': `let double x = x * 2\nmodule Math = struct\n  let square x = x * x\nend\n`,
      'bin/main.ml': `let run n = Util.double n + Util.Math.square n\nlet local x = run x\n`,
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

  const callTargets = (file: string, fn: string): string[] => {
    const id = cg.getNodesInFile(file).find((n) => n.name === fn)!.id;
    return cg
      .getOutgoingEdgesFrom([id])
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
  };

  it('links same-file calls', () => {
    expect(callTargets('bin/main.ml', 'local')).toEqual(['Main::run']);
  });

  it('links Module.fn calls across files', () => {
    const targets = callTargets('bin/main.ml', 'run');
    expect(targets.some((t) => t.endsWith('double'))).toBe(true);
    expect(targets.some((t) => t.endsWith('Math::square'))).toBe(true);
  });
});

describe('OCaml dune libraries', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ocaml-dune-'));
    const files: Record<string, string> = {
      'dune-project': '(lang dune 3.0)\n',
      'lib/dune': '; comment (library (name decoy))\n#| (library (name decoy2)) |#\n(library (name my_lib) (public_name my-lib))\n',
      'lib/entry.ml': 'let run x = x\n',
      'raw/dune': '(library (name raw) (wrapped false))\n',
      'raw/cell.ml': 'let get x = x\n',
      'bin/dune': '(executable (name main) (libraries my_lib raw))\n',
      'bin/main.ml': 'let go () = My_lib.Entry.run 1 + Cell.get 2\n',
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

  it('resolves calls through the wrapper of a wrapped library', () => {
    const go = cg.getNodesInFile('bin/main.ml').find((n) => n.name === 'go')!;
    const targets = cg
      .getOutgoingEdgesFrom([go.id])
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
    expect(targets).toEqual(['Cell::get', 'Entry::run']);
  });
});

describe('OCaml interface files', () => {
  const MLI = `(** Doc for foo. *)
val foo : int -> int
type t
type 'a r = { x : 'a }
exception Bad of string
module M : sig val x : int end
module type S = sig val y : int end
open Core
`;
  let result: ReturnType<typeof extractFromSource>;
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    result = extractFromSource('lib/api.mli', MLI);
  });

  it('detects .mli files as their own language', () => {
    expect(isSourceFile('lib/api.mli')).toBe(true);
    expect(result.nodes.find((n) => n.kind === 'file')?.language).toBe('ocaml_interface');
  });

  it('extracts specs, types, modules and module types', () => {
    const find = (kind: string, name: string) => result.nodes.find((n) => n.kind === kind && n.name === name);
    expect(find('module', 'Api')).toBeDefined();
    expect(find('function', 'foo')?.signature).toBe('val foo : int -> int');
    expect(find('function', 'foo')?.docstring).toContain('Doc for foo');
    expect(find('type_alias', 't')).toBeDefined();
    expect(find('struct', 'r')).toBeDefined();
    expect(find('class', 'Bad')).toBeDefined();
    expect(find('function', 'x')?.qualifiedName).toBe('Api::M::x');
    expect(find('interface', 'S')).toBeDefined();
    expect(find('method', 'y')?.qualifiedName).toBe('Api::S::y');
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'Core')).toBe(true);
  });
});

describe('OCaml .ml / .mli pairs', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ocaml-pair-'));
    const files: Record<string, string> = {
      'lib/util.mli': '(** Doubles. *)\nval double : int -> int\n',
      'lib/util.ml': 'let double x = x * 2\n',
      'bin/main.ml': 'let run n = Util.double n\n',
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

  it('links a call to the implementation, not the interface spec', () => {
    const run = cg.getNodesInFile('bin/main.ml').find((n) => n.name === 'run')!;
    const targets = cg
      .getOutgoingEdgesFrom([run.id])
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).toEqual(['lib/util.ml']);
  });
});

describe('OCaml dune library with interface files', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ocaml-dune-mli-'));
    const files: Record<string, string> = {
      'dune-project': '(lang dune 3.0)\n',
      'lib/dune': '(library (name my_lib))\n',
      'lib/entry.mli': 'val run : int -> int\n',
      'lib/entry.ml': 'let run x = x\n',
      'bin/main.ml': 'let go () = My_lib.Entry.run 1\n',
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

  it('resolves through the wrapper to the implementation', () => {
    const go = cg.getNodesInFile('bin/main.ml').find((n) => n.name === 'go')!;
    const targets = cg
      .getOutgoingEdgesFrom([go.id])
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).toEqual(['lib/entry.ml']);
  });
});

describe('OCaml name scoping', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ocaml-scope-'));
    const files: Record<string, string> = {
      'util.ml': 'let double x = x * 2\nlet tag x = x\nmodule Deep = struct let sq x = x * x end\n',
      'types.ml': 'type entry = { tag : int }\ntype kind = double | other\n',
      // a local helper called `tag`, and no `open`: must not reach Util.tag or the record field
      'plain.ml': 'let f n =\n  let rec walk acc = tag acc\n  and tag acc = acc in\n  walk n + double n\n',
      'alias.ml': 'module U = Util\nmodule D = Util.Deep\nmodule E = D\nlet f n = U.double n + D.sq n + E.sq n\nlet g n = let module V = Util in V.double n\n',
      'opened.ml': 'open Util\nlet f n = double n\n',
      'local_open.ml': 'let f n = let open Util in double n\nlet g n = Util.(double n)\n',
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const callTargets = (file: string, fn: string): string[] => {
    const id = cg.getNodesInFile(file).find((n) => n.name === fn)!.id;
    return cg
      .getOutgoingEdgesFrom([id])
      .filter((e) => e.kind === 'calls')
      .map((e) => `${cg.getNode(e.target)!.kind}:${cg.getNode(e.target)!.qualifiedName}`)
      .sort();
  };

  it('does not link a bare call to another file that is not opened, or to a non-function', () => {
    expect(callTargets('plain.ml', 'f')).toEqual([]);
  });

  it('follows module aliases, local ones and chains of them', () => {
    expect(callTargets('alias.ml', 'f')).toEqual(['function:Util::Deep::sq', 'function:Util::Deep::sq', 'function:Util::double']);
    expect(callTargets('alias.ml', 'g')).toEqual(['function:Util::double']);
  });

  it('links a bare call into a module that is opened', () => {
    expect(callTargets('opened.ml', 'f')).toEqual(['function:Util::double']);
  });

  it('links a bare call after a local open', () => {
    expect(callTargets('local_open.ml', 'f')).toEqual(['function:Util::double']);
    expect(callTargets('local_open.ml', 'g')).toEqual(['function:Util::double']);
  });
});
