/**
 * SystemVerilog / Verilog extraction tests.
 *
 * Locks in the design-hierarchy mapping (module/instantiation), subroutine-body
 * call capture, enum-member emission, and package/import handling.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { matchReference } from '../src/resolution/name-matcher';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('SystemVerilog language detection', () => {
  it('maps the HDL extensions to systemverilog', () => {
    expect(detectLanguage('rtl/fifo.sv')).toBe('systemverilog');
    expect(detectLanguage('pkg/types.svh')).toBe('systemverilog');
    expect(detectLanguage('legacy/core.v')).toBe('systemverilog');
    expect(detectLanguage('inc/defs.vh')).toBe('systemverilog');
  });
});

describe('SystemVerilog extraction', () => {
  it('emits module nodes and instantiation edges (instantiates + calls) to the module type', () => {
    const code = `
module leaf(input a, output y);
  assign y = ~a;
endmodule
module top(input x, output z);
  leaf u_leaf(.a(x), .y(z));
endmodule
`;
    const r = extractFromSource('top.sv', code);
    const modules = r.nodes.filter((n) => n.kind === 'module').map((n) => n.name);
    expect(modules).toEqual(expect.arrayContaining(['leaf', 'top']));

    // The instantiation binds to the module TYPE (leaf), not the u_leaf label.
    const refs = r.unresolvedReferences.filter((x) => x.referenceName === 'leaf');
    expect(refs.some((x) => x.referenceKind === 'instantiates')).toBe(true);
    expect(refs.some((x) => x.referenceKind === 'calls')).toBe(true);
    expect(refs.some((x) => x.referenceName === 'u_leaf')).toBe(false);
  });

  it('captures calls made inside subroutine (function/task) bodies', () => {
    const code = `
module m;
  function automatic int g(input int v);
    return v;
  endfunction
  task automatic f(input int v);
    int t;
    t = g(v);
  endtask
endmodule
`;
    const r = extractFromSource('m.sv', code);
    const calls = r.unresolvedReferences.filter(
      (x) => x.referenceKind === 'calls' && x.referenceName === 'g'
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it('emits enum members for typedef enums', () => {
    const code = `
package p;
  typedef enum logic [1:0] { A, B, C } e_t;
endpackage
`;
    const r = extractFromSource('p.sv', code);
    expect(r.nodes.some((n) => n.kind === 'enum' && n.name === 'e_t')).toBe(true);
    const members = r.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name);
    expect(members).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });

  it('maps package to a namespace node and package-import to an import node', () => {
    const code = `
package pkg;
  localparam int W = 8;
endpackage
import pkg::*;
module m(input logic clk);
endmodule
`;
    const r = extractFromSource('m.sv', code);
    expect(r.nodes.some((n) => n.kind === 'namespace' && n.name === 'pkg')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'import' && n.name === 'pkg')).toBe(true);
  });

  it('maps a scalar typedef to a type_alias node (engine path, not the hook)', () => {
    const code = `
package p;
  typedef logic [7:0] byte_t;
endpackage
`;
    const r = extractFromSource('p.sv', code);
    expect(r.nodes.some((n) => n.kind === 'type_alias' && n.name === 'byte_t')).toBe(true);
  });

  it('emits one import per package in a comma-separated import statement', () => {
    const code = `
package a; localparam int X = 1; endpackage
package b; localparam int Y = 2; endpackage
import a::*, b::Y;
module m(input logic clk);
endmodule
`;
    const r = extractFromSource('m.sv', code);
    const imports = r.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('parses real-world RTL without errors (non-ANSI ports, generate)', () => {
    const code = `
module leaf_na(o, i);
  output o;
  input  i;
  assign o = ~i;
endmodule
module gen_top #(parameter int N = 4) (input [3:0] x, output [3:0] y);
  genvar gi;
  generate
    for (gi = 0; gi < N; gi++) begin : g_loop
      leaf_na u (.o(y[gi]), .i(x[gi]));
    end
  endgenerate
endmodule
`;
    const r = extractFromSource('gen.sv', code);
    const modules = r.nodes.filter((n) => n.kind === 'module').map((n) => n.name);
    expect(modules).toEqual(expect.arrayContaining(['leaf_na', 'gen_top']));
    // instantiation inside a generate-for is still attributed to the enclosing module
    expect(
      r.unresolvedReferences.some(
        (x) => x.referenceKind === 'instantiates' && x.referenceName === 'leaf_na'
      )
    ).toBe(true);
  });

  it('captures UVM class inheritance, the new constructor, and class-vs-module method scoping', () => {
    const code = `
class base_driver extends uvm_driver #(my_txn);
  function new(string name);
    super.new(name);
  endfunction
  virtual function void build_phase(uvm_phase phase);
    configure();
  endfunction
  function void configure();
  endfunction
endclass
module m;
  function int helper(input int v);
    return v;
  endfunction
endmodule
`;
    const r = extractFromSource('uvm.sv', code);

    // The extends clause binds to the base class (the `#(my_txn)` params are ignored).
    expect(
      r.unresolvedReferences.some(
        (x) => x.referenceKind === 'extends' && x.referenceName === 'uvm_driver'
      )
    ).toBe(true);

    // `function new` is captured as a method named 'new'.
    expect(r.nodes.some((n) => n.kind === 'method' && n.name === 'new')).toBe(true);

    // Class subroutines read as methods ...
    const methods = r.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    expect(methods).toEqual(expect.arrayContaining(['new', 'build_phase', 'configure']));

    // ... while a module-level subroutine stays a function (not mislabeled a method).
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'helper')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'method' && n.name === 'helper')).toBe(false);
  });

  it('still resolves calls made inside a class method body (method dispatch keeps body walk)', () => {
    const code = `
class c;
  virtual function void build_phase();
    configure();
  endfunction
  function void configure();
  endfunction
endclass
`;
    const r = extractFromSource('c.sv', code);
    expect(
      r.unresolvedReferences.some(
        (x) => x.referenceKind === 'calls' && x.referenceName === 'configure'
      )
    ).toBe(true);
  });

  it('binds a package-qualified extends to the base class, not the package scope', () => {
    const code = `
package uvm_pkg;
  class uvm_driver #(type T = int);
  endclass
endpackage
class d extends uvm_pkg::uvm_driver #(my_txn);
endclass
`;
    const r = extractFromSource('d.sv', code);
    const ext = r.unresolvedReferences.filter((x) => x.referenceKind === 'extends');
    // the qualifier is preserved (so the resolver can disambiguate by package) and
    // the package is NOT mistaken for the base class
    expect(ext.some((x) => x.referenceName === 'uvm_pkg::uvm_driver')).toBe(true);
    expect(ext.some((x) => x.referenceName === 'uvm_pkg')).toBe(false);
  });

  it('resolves a package-qualified extends to the matching package class under a name collision', () => {
    const mk = (id: string, qualifiedName: string, filePath: string): Node =>
      ({
        id, name: 'Base', kind: 'class', qualifiedName, filePath,
        language: 'systemverilog', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      } as Node);
    const p1Base = mk('P1', 'p1::Base', 'pkg1/p1.sv');
    const p2Base = mk('P2', 'p2::Base', 'pkg2/p2.sv');
    const ctx = {
      getNodesByName: (n: string) => (n === 'Base' ? [p1Base, p2Base] : []),
      getNodesByQualifiedName: (q: string) =>
        [p1Base, p2Base].filter((n) => n.qualifiedName === q),
      getNodesByKind: () => [],
      getNodesInFile: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    } as unknown as ResolutionContext;
    const ref: UnresolvedRef = {
      fromNodeId: 'D', referenceName: 'p2::Base', referenceKind: 'extends',
      line: 6, column: 0, filePath: 'tb/d.sv', language: 'systemverilog',
    };
    // bare "Base" would tie-break on proximity and could pick p1; the scoped name resolves p2.
    expect(matchReference(ref, ctx)?.targetNodeId).toBe('P2');
  });

  it('extracts out-of-class method/constructor definitions as methods, not loose functions', () => {
    const code = `
class d;
  extern function void cfg();
  extern function new(string name);
endclass
function void d::cfg();
endfunction
function d::new(string name);
endfunction
module m;
  function int helper();
    return 0;
  endfunction
endmodule
`;
    const r = extractFromSource('d.sv', code);
    const methods = r.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    // out-of-class `d::cfg` / `d::new` are methods of class d (receiver path)
    expect(methods).toEqual(expect.arrayContaining(['cfg', 'new']));
    // the module subroutine stays a plain function ...
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'helper')).toBe(true);
    // ... and the out-of-class defs are NOT also emitted as loose functions
    expect(r.nodes.some((n) => n.kind === 'function' && (n.name === 'cfg' || n.name === 'new'))).toBe(false);
  });

  it('resolves an extends reference to a class over a same-named function (resolver kind bias)', () => {
    const mk = (id: string, kind: Node['kind'], filePath: string): Node =>
      ({
        id, name: 'base_c', kind, qualifiedName: 'base_c', filePath,
        language: 'systemverilog', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      } as Node);
    const klass = mk('CLASS', 'class', 'pkg/base.sv');
    const fn = mk('FUNC', 'function', 'rtl/util.sv');
    // function listed FIRST: only the extends kind-bias (not iteration order) can make the class win.
    const ctx = {
      getNodesByName: (n: string) => (n === 'base_c' ? [fn, klass] : []),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesInFile: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    } as unknown as ResolutionContext;
    const ref: UnresolvedRef = {
      fromNodeId: 'D', referenceName: 'base_c', referenceKind: 'extends',
      line: 5, column: 0, filePath: 'tb/d.sv', language: 'systemverilog',
    };
    expect(matchReference(ref, ctx)?.targetNodeId).toBe('CLASS');
  });
});

/**
 * Inheritance-aware `this.`/`super.` call resolution, end-to-end.
 *
 * These index a real on-disk fixture and assert the resolved `calls` EDGES
 * (not extraction-time refs). The load-bearing case is `super.m()` binding to
 * the PARENT's `m` rather than the caller's own — the self-edge trap.
 */
describe('SystemVerilog this./super. call resolution', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Index `code` as a single .sv file and run resolution end-to-end.
  async function indexSv(code: string): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-resolve-'));
    fs.writeFileSync(path.join(tempDir, 'dut.sv'), code);
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  // The method node for `className::methodName` (qualified-name match avoids
  // colliding with a same-named method on another class).
  function method(graph: CodeGraph, className: string, methodName: string): Node {
    const hit = graph
      .getNodesByKind('method')
      .find((n) => n.name === methodName && n.qualifiedName.includes(className));
    expect(hit, `method ${className}::${methodName}`).toBeDefined();
    return hit!;
  }

  function callTargets(graph: CodeGraph, from: Node): string[] {
    return graph
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => e.target);
  }

  it('binds super.m() to the parent class method, not the caller’s own', async () => {
    cg = await indexSv(`
class Base;
  virtual function void m();
  endfunction
endclass
class Derived extends Base;
  virtual function void m();
    super.m();
    this.helper();
  endfunction
  function void helper();
  endfunction
endclass
`);
    const derivedM = method(cg, 'Derived', 'm');
    const baseM = method(cg, 'Base', 'm');
    const derivedHelper = method(cg, 'Derived', 'helper');

    const targets = callTargets(cg, derivedM);

    // super.m() resolves to Base::m ...
    expect(targets).toContain(baseM.id);
    // ... and this.helper() to the enclosing class's helper ...
    expect(targets).toContain(derivedHelper.id);
    // ... but there is NO self-edge Derived::m -> Derived::m.
    expect(targets).not.toContain(derivedM.id);
  });

  it('resolves super.m() across a multi-level chain when the parent lacks m', async () => {
    cg = await indexSv(`
class Base;
  virtual function void m();
  endfunction
endclass
class Derived extends Base;
  virtual function void m();
  endfunction
endclass
class Derived2 extends Derived;
  virtual function void run();
    super.m();
  endfunction
endclass
`);
    const run = method(cg, 'Derived2', 'run');
    const derivedM = method(cg, 'Derived', 'm');
    const baseM = method(cg, 'Base', 'm');

    const targets = callTargets(cg, run);

    // Derived2 has no m; super starts at Derived and finds Derived::m first —
    // the nearest override wins, so it must NOT skip past to Base::m.
    expect(targets).toContain(derivedM.id);
    expect(targets).not.toContain(baseM.id);
  });

  it('resolves this.m() up the extends chain to an inherited method', async () => {
    cg = await indexSv(`
class Base;
  virtual function void shared();
  endfunction
endclass
class Derived extends Base;
  virtual function void go();
    this.shared();
  endfunction
endclass
`);
    const go = method(cg, 'Derived', 'go');
    const baseShared = method(cg, 'Base', 'shared');

    // Derived doesn't declare shared(); this. walks up to Base::shared.
    expect(callTargets(cg, go)).toContain(baseShared.id);
  });

  // Count this./super. rows still sitting in unresolved_refs after resolution.
  // Reads the on-disk db directly (the public API exposes resolved edges, not
  // the residual ref table) and closes its own connection so teardown's
  // destroy() doesn't trip a Windows file lock.
  function lingeringHandleRefs(): number {
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      const rows = db.getDb().prepare(
        `SELECT reference_name FROM unresolved_refs WHERE reference_kind = 'calls'`
      ).all() as Array<{ reference_name: string }>;
      return rows.filter((r) => /^(this|super)\.\w+$/.test(r.reference_name)).length;
    } finally {
      db.close();
    }
  }

  it('drops an unresolvable super.x() (base not indexed): no edge, no lingering ref', async () => {
    // `undefined_base` is referenced but never defined here, so super.run() has
    // no target. The pass must emit no calls edge AND not leave the ref behind
    // to be re-walked on every future sync.
    cg = await indexSv(`
class only_child extends undefined_base;
  virtual function void run();
    super.run();
  endfunction
endclass
`);
    const run = method(cg, 'only_child', 'run');
    // No spurious calls edge from the unresolvable super.run().
    expect(callTargets(cg, run)).toHaveLength(0);
    // And the ref is gone — resolved-or-dropped, never perpetually pending.
    expect(lingeringHandleRefs()).toBe(0);
  });

  it('terminates on a cyclic extends chain without spurious edges', async () => {
    // A <-> B mutual inheritance is illegal SV, but a malformed index must not
    // hang the resolver. The visited-guard breaks the cycle; m() exists nowhere
    // in the (broken) chain, so super.m() binds to nothing.
    cg = await indexSv(`
class A extends B;
  virtual function void go();
    super.m();
  endfunction
endclass
class B extends A;
endclass
`);
    const go = method(cg, 'A', 'go');
    expect(callTargets(cg, go)).toHaveLength(0);
    expect(lingeringHandleRefs()).toBe(0);
  });
});

/**
 * Class-composition (`has-a`) edges, end-to-end. A class field of a user-class
 * type yields a `references` edge class->field-type, giving the UVM testbench
 * topology (test has-an env, env has-an agent, ...). Builtin-typed and
 * self-typed fields produce no edge.
 */
describe('SystemVerilog class-composition (has-a) edges', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function indexSv(code: string): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-compose-'));
    fs.writeFileSync(path.join(tempDir, 'tb.sv'), code);
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  function classNode(graph: CodeGraph, name: string): Node {
    const hit = graph.getNodesByKind('class').find((n) => n.name === name);
    expect(hit, `class ${name}`).toBeDefined();
    return hit!;
  }

  // Qualified-name strings of every `references`-edge target from a class.
  function refTargets(graph: CodeGraph, from: Node): string[] {
    return graph
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'references')
      .map((e) => graph.getNode(e.target)?.qualifiedName ?? e.target);
  }

  // `references` rows still pending in unresolved_refs (used to prove a builtin
  // field left nothing behind). Closes its own db connection for clean teardown.
  function lingeringRefs(): number {
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      const row = db.getDb().prepare(
        `SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_kind = 'references'`
      ).get() as { c: number };
      return row.c;
    } finally {
      db.close();
    }
  }

  it('emits a class->field-type references edge (deduped across multiple fields)', async () => {
    cg = await indexSv(`
class Sub;
endclass
class Top;
  Sub a;
  Sub b;
endclass
`);
    const top = classNode(cg, 'Top');
    const sub = classNode(cg, 'Sub');
    expect(cg.getOutgoingEdges(top.id).some((e) => e.kind === 'references' && e.target === sub.id)).toBe(true);
  });

  it('does not emit a self-reference for a self-typed field', async () => {
    cg = await indexSv(`
class Node1;
  Node1 nxt;
endclass
`);
    const node1 = classNode(cg, 'Node1');
    // A class pointing at itself is noise in a has-a graph — must be dropped.
    expect(cg.getOutgoingEdges(node1.id).some((e) => e.kind === 'references' && e.target === node1.id)).toBe(false);
  });

  it('ignores builtin-typed fields: no edge, no lingering reference', async () => {
    cg = await indexSv(`
class HasPrimitives;
  int count;
  string name;
endclass
`);
    const c = classNode(cg, 'HasPrimitives');
    expect(refTargets(cg, c)).toHaveLength(0);
    // int/string never become a ref at all, so nothing lingers unresolved.
    expect(lingeringRefs()).toBe(0);
  });

  it('binds a package-qualified field type to the scoped class', async () => {
    cg = await indexSv(`
package pkg;
  class Base;
  endclass
endpackage
class Holder;
  pkg::Base h;
endclass
`);
    const holder = classNode(cg, 'Holder');
    // The qualifier is preserved so the resolver lands on pkg::Base specifically.
    expect(refTargets(cg, holder)).toContain('pkg::Base');
  });

  it('emits an edge for fields behind property qualifiers (rand/local/protected/const)', async () => {
    // UVM fields are overwhelmingly `rand <txn>` / `local`/`protected <comp>`.
    // Most qualifiers parse as a sibling node before the data_declaration; a
    // `const` member instead exposes data_type directly (no data_declaration
    // wrapper). The type extractor must handle both. Distinct types per
    // qualifier ensure a miss can't be masked by dedup against the plain field.
    cg = await indexSv(`
class qa; endclass
class qb; endclass
class qc; endclass
class qd; endclass
class qe; endclass
class qf; endclass
class holder;
  qa plain_h;
  rand qb rand_h;
  local qc local_h;
  protected qd prot_h;
  rand local qe rl_h;
  const qf const_h;
endclass
`);
    const holder = classNode(cg, 'holder');
    const targets = refTargets(cg, holder);
    for (const ty of ['qa', 'qb', 'qc', 'qd', 'qe', 'qf']) {
      expect(targets, `holder should reference ${ty}`).toContain(ty);
    }
  });
});

/**
 * UVM factory-create composition + TLM-connect dataflow, end-to-end. A
 * `h = T::type_id::create(...)` yields a class->T `references` edge and feeds a
 * per-class handle->component map; an `a.b.connect(c.d)` resolves both dotted
 * chains through that map and emits a component->component dataflow edge.
 */
describe('SystemVerilog factory-create + TLM-connect (dataflow)', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    } else if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function indexSv(code: string): Promise<CodeGraph> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sv-tlm-'));
    fs.writeFileSync(path.join(tempDir, 'tb.sv'), code);
    const graph = await CodeGraph.init(tempDir, { index: true });
    graph.resolveReferences();
    return graph;
  }

  function classNode(graph: CodeGraph, name: string): Node {
    const hit = graph.getNodesByKind('class').find((n) => n.name === name);
    expect(hit, `class ${name}`).toBeDefined();
    return hit!;
  }

  function refTargetNames(graph: CodeGraph, from: Node): string[] {
    return graph
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'references')
      .map((e) => graph.getNode(e.target)?.name ?? e.target);
  }

  // Any `__sv_*__` marker still pending after resolution (must be zero).
  function lingeringMarkers(): number {
    const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
    try {
      const row = db.getDb().prepare(
        `SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_name LIKE '__sv\\_%' ESCAPE '\\'`
      ).get() as { c: number };
      return row.c;
    } finally {
      db.close();
    }
  }

  it('emits a class->type edge for a factory create', async () => {
    cg = await indexSv(`
class Sub; endclass
class Top;
  Sub h;
  function void build_phase();
    h = Sub::type_id::create("h", this);
  endfunction
endclass
`);
    const top = classNode(cg, 'Top');
    expect(refTargetNames(cg, top)).toContain('Sub');
    expect(lingeringMarkers()).toBe(0);
  });

  it('captures a factory override: a base-typed handle created as a derived type', async () => {
    cg = await indexSv(`
class base_drv; endclass
class deriv_drv extends base_drv; endclass
class agent_c;
  base_drv drv;
  function void build_phase();
    drv = deriv_drv::type_id::create("drv", this);
  endfunction
endclass
`);
    const agent = classNode(cg, 'agent_c');
    // The create binds the DERIVED type even though the handle is base-typed —
    // the factory-override win that a field-only view would miss.
    expect(refTargetNames(cg, agent)).toContain('deriv_drv');
  });

  it('resolves a TLM connect chain to a component->component dataflow edge', async () => {
    cg = await indexSv(`
class M;
  int ap;
endclass
class B;
  int export_h;
endclass
class A;
  M m;
  function void build_phase();
    m = M::type_id::create("m", this);
  endfunction
endclass
class env_c;
  A a;
  B b;
  function void build_phase();
    a = A::type_id::create("a", this);
    b = B::type_id::create("b", this);
  endfunction
  function void connect_phase();
    a.m.ap.connect(b.export_h);
  endfunction
endclass
`);
    const m = classNode(cg, 'M');
    const b = classNode(cg, 'B');
    // a -> A, A.m -> M (chain), `ap` is a port (not created) so the walk stops
    // at M; the arg chain stops at B. Dataflow edge M -> B.
    expect(cg.getOutgoingEdges(m.id).some((e) => e.kind === 'references' && e.target === b.id)).toBe(true);
    // The port token must NOT produce an edge to a non-component.
    expect(refTargetNames(cg, m)).not.toContain('A');
    expect(lingeringMarkers()).toBe(0);
  });

  it('drops a connect whose handles do not resolve: no edge, no lingering marker', async () => {
    cg = await indexSv(`
class lonely;
  function void connect_phase();
    foo.bar.connect(baz.qux);   // no creates anywhere -> chains resolve to nothing
  endfunction
endclass
`);
    const lonely = classNode(cg, 'lonely');
    expect(refTargetNames(cg, lonely)).toHaveLength(0);
    // The unresolvable connect marker must not linger to be re-walked each sync.
    expect(lingeringMarkers()).toBe(0);
  });

  it('handles a `__`-bearing handle in a factory override (marker split is `|`, not `__`)', async () => {
    // `my__h` is a legal SV name; a `__`-delimited marker would split the body
    // mid-identifier and silently drop the override edge.
    cg = await indexSv(`
class base_t; endclass
class deriv_t extends base_t; endclass
class Holder;
  base_t my__h;
  function void build_phase();
    my__h = deriv_t::type_id::create("h", this);
  endfunction
endclass
`);
    const holder = classNode(cg, 'Holder');
    // The factory-override edge to the DERIVED type must survive.
    expect(refTargetNames(cg, holder)).toContain('deriv_t');
    expect(lingeringMarkers()).toBe(0);
  });

  it('resolves a TLM connect that hops through a `__`-bearing handle', async () => {
    cg = await indexSv(`
class M;
  int ap;
endclass
class B;
  int export_h;
endclass
class A;
  M sub__mon;
  function void build_phase();
    sub__mon = M::type_id::create("sub__mon", this);
  endfunction
endclass
class env_c;
  A a__inst;
  B b;
  function void build_phase();
    a__inst = A::type_id::create("a__inst", this);
    b       = B::type_id::create("b", this);
  endfunction
  function void connect_phase();
    a__inst.sub__mon.ap.connect(b.export_h);
  endfunction
endclass
`);
    const m = classNode(cg, 'M');
    const b = classNode(cg, 'B');
    // Chain a__inst -> A, A.sub__mon -> M, port `ap` stops -> dataflow M -> B.
    expect(cg.getOutgoingEdges(m.id).some((e) => e.kind === 'references' && e.target === b.id)).toBe(true);
    expect(lingeringMarkers()).toBe(0);
  });

  it('does not duplicate the field edge: a declared+created type yields exactly one row', async () => {
    cg = await indexSv(`
class Comp; endclass
class Owner;
  Comp c;
  function void build_phase();
    c = Comp::type_id::create("c", this);
  endfunction
endclass
`);
    const owner = classNode(cg, 'Owner');
    const comp = classNode(cg, 'Comp');
    // Field decl + factory create of the SAME type → ONE references row, not two
    // (the create edge is suppressed because the field edge already covers it).
    const toComp = cg
      .getOutgoingEdges(owner.id)
      .filter((e) => e.kind === 'references' && e.target === comp.id);
    expect(toComp).toHaveLength(1);
  });
});
