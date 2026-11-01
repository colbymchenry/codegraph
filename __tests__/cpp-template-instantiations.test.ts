/**
 * A C++ call through a template parameter links to that member of each class
 * the project writes as the template's argument: rocksdb's `Txn::PutEntity(…)`
 * in `template <typename Txn> class SecondaryIndexMixin`, `Traits::ClearOutput`
 * in a function template given two local `Traits`, and a typed test's
 * `TypeParam::KeyGen`. No lookup at the call can answer these, so they are
 * synthesized from the instantiations, one edge per class.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { describeSynthesizedHop } from '../src/graph/synthesized-hop';
import { hasSynthesisPattern } from '../src/resolution/callback-synthesizer';
import { CPP_TEMPLATE_ARGUMENT_CAP } from '../src/resolution/cpp-template-instantiations';
import type { Edge } from '../src/types';

const roots: string[] = [];
const open: CodeGraph[] = [];
afterEach(() => {
  for (const cg of open.splice(0)) cg.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const lines = (...l: string[]): string => [...l, ''].join('\n');

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-template-'));
  roots.push(root);
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function opened(root: string): Promise<CodeGraph> {
  const cg = await CodeGraph.init(root, { index: true });
  open.push(cg);
  return cg;
}

const indexed = (files: Record<string, string>): Promise<CodeGraph> => opened(project(files));

interface Row {
  source: string;
  target: string;
  targetKind: string;
  kind: string;
  line: number;
  via: string;
  argument: string;
  registeredAt: string;
  provenance: string;
  fnRef: number | null;
}

/** Every edge the pass made, as text, in insertion order. */
function templateEdges(cg: CodeGraph): Row[] {
  const db = (cg as unknown as { db: { db: { prepare(sql: string): { all(): Row[] } } } }).db.db;
  return db.prepare(
    `SELECT s.qualified_name source, t.qualified_name target, t.kind targetKind, e.kind kind, e.line line, e.provenance provenance,
       json_extract(e.metadata, '$.via') via, json_extract(e.metadata, '$.argument') argument, json_extract(e.metadata, '$.registeredAt') registeredAt,
       json_extract(e.metadata, '$.fnRef') fnRef
     FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
     WHERE json_extract(e.metadata, '$.synthesizedBy') = 'cpp-template-argument' ORDER BY e.id`
  ).all();
}

/** The targets the pass linked from `source`, sorted. */
function reached(cg: CodeGraph, source: string): string[] {
  return templateEdges(cg).filter((e) => e.source === source).map((e) => e.target).sort();
}

const TXN = lines(
  'class BaseTxn {',
  ' public:',
  '  void Commit() {}',
  '};',
  'class PlainTxn : public BaseTxn {',
  ' public:',
  '  void Put(int k) {}',
  '  void Put(int k, int v) {}',
  '  static void Make() {}',
  '};',
  'class FancyTxn : public BaseTxn {',
  ' public:',
  '  void Put(int k) {}',
  '  static void Make() {}',
  '};',
  'class NoPutTxn {};',
);

/** `Mixin<Txn>` with one call through its parameter, in a header. */
const MIXIN = lines(
  '#include "txn.h"',
  'template <typename Txn>',
  'class Mixin : public Txn {',
  ' public:',
  '  void Add(int k) { Txn::Put(k); }',
  '  void Finish() { Txn::Commit(); }',
  '  static void Build() { Txn::Make(); }',
  '};',
);

const PUT_PLAIN = 'PlainTxn::Put';

describe('the forms of a written instantiation', () => {
  const uses = async (use: string): Promise<CodeGraph> => indexed({
    'txn.h': TXN,
    'mixin.h': MIXIN,
    'use.cc': lines('#include "mixin.h"', use),
  });

  it('links to the argument of the one instantiation, the rocksdb SecondaryIndexMixin shape', async () => {
    const cg = await uses('void Run() { auto* m = new Mixin<PlainTxn>(); m->Add(1); }');
    expect(reached(cg, 'Mixin::Add')).toEqual([PUT_PLAIN]);
    expect(reached(cg, 'Mixin::Build')).toEqual(['PlainTxn::Make']);
    const [edge] = templateEdges(cg).filter((e) => e.source === 'Mixin::Add');
    expect(edge).toMatchObject({ kind: 'calls', via: 'Txn', argument: 'PlainTxn', registeredAt: 'use.cc:2', provenance: 'heuristic', line: 5 });
  });

  it('chooses the overload the call makes', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'pair.h': lines('#include "txn.h"', 'template <class T>', 'struct Pair {', '  void Both(int a, int b) { T::Put(a, b); }', '};'),
      'use.cc': lines('#include "pair.h"', 'Pair<PlainTxn> pair;'),
    });
    const [edge] = templateEdges(cg);
    expect(edge?.target).toBe(PUT_PLAIN);
    const db = (cg as unknown as { db: { db: { prepare(sql: string): { all(): Array<{ start_line: number }> } } } }).db.db;
    const line = db.prepare(`SELECT n.start_line FROM edges e JOIN nodes n ON n.id = e.target WHERE json_extract(e.metadata, '$.synthesizedBy') = 'cpp-template-argument'`).all();
    expect(line).toEqual([{ start_line: 8 }]);
  });

  it.each([
    ['a base clause', 'class Logged : public Mixin<PlainTxn> {};'],
    ['a variable', 'Mixin<PlainTxn> global;'],
    ['a member', 'class Holder { Mixin<PlainTxn> held_; };'],
    ['a pointer to it', 'Mixin<PlainTxn>* maybe = nullptr;'],
    ['an argument of another template', 'std::vector<Mixin<PlainTxn>> many;'],
    ['a using alias', 'using Aliased = Mixin<PlainTxn>;'],
    ['a typedef', 'typedef Mixin<PlainTxn> Aliased;'],
    ['an explicit instantiation', 'template class Mixin<PlainTxn>;'],
    ['an extern explicit instantiation', 'extern template class Mixin<PlainTxn>;'],
    ['a static member call', 'void Run() { Mixin<PlainTxn>::Build(); }'],
    ['the name written with a namespace', 'namespace other { ::Mixin<PlainTxn> global; }'],
    ['a list broken over lines', 'Mixin<\n    PlainTxn\n> global;'],
  ])('reads %s', async (_form, use) => {
    const cg = await uses(use);
    expect(reached(cg, 'Mixin::Add')).toEqual([PUT_PLAIN]);
  });

  it('reads past the arrow of a trailing return type', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'bound.h': lines('#include "txn.h"', 'template <class Fn, class T>', 'struct Bound {', '  void Run() { T::Make(); }', '};'),
      'use.cc': lines('#include "bound.h"', 'Bound<auto(int)->int, PlainTxn> bound;'),
    });
    expect(reached(cg, 'Bound::Run')).toEqual(['PlainTxn::Make']);
  });

  it('links an explicit function template argument', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'run.cc': lines(
        '#include "txn.h"',
        'template <typename T>',
        'void Build() { T::Make(); }',
        'void Run() {',
        '  Build<PlainTxn>();',
        '  Build<FancyTxn>();',
        '}',
      ),
    });
    expect(reached(cg, 'Build')).toEqual(['FancyTxn::Make', 'PlainTxn::Make']);
    expect(templateEdges(cg).map((e) => e.registeredAt).sort()).toEqual(['run.cc:5', 'run.cc:6']);
  });

  it('links a member function template and a class template method each to its own head', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'host.h': lines(
        '#include "txn.h"',
        'template <typename A>',
        'class Host {',
        ' public:',
        '  template <typename B>',
        '  void Both() { A::Make(); B::Make(); }',
        '};',
      ),
      'use.cc': lines('#include "host.h"', 'void Run() {', '  Host<PlainTxn> h;', '  h.Both<FancyTxn>();', '}'),
    });
    expect(reached(cg, 'Host::Both')).toEqual(['FancyTxn::Make', 'PlainTxn::Make']);
  });

  it('reads the parameter of a member defined outside its class, by position', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'pair.h': lines(
        '#include "txn.h"',
        'template <int N, typename First, typename Second>',
        'class Pair {',
        ' public:',
        '  void Go();',
        '  template <typename Third> void More();',
        '};',
        'template <int M, typename A, typename B>',
        'void Pair<M, A, B>::Go() { B::Make(); }',
        'template <int M, typename A, typename B>',
        'template <typename C>',
        'void Pair<M, A, B>::More() { A::Make(); C::Make(); }',
      ),
      'use.cc': lines('#include "pair.h"', 'void Run() {', '  Pair<1, PlainTxn, FancyTxn> p;', '  p.More<NoPutTxn>();', '}'),
    });
    expect(reached(cg, 'Pair::Go')).toEqual(['FancyTxn::Make']);
    expect(reached(cg, 'Pair::More')).toEqual(['PlainTxn::Make']);
  });

  it('reads the parameter of a class around the caller, and of a function around a local class', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'all.cc': lines(
        '#include "txn.h"',
        'template <typename T>',
        'class Outer {',
        ' public:',
        '  class Inner {',
        '   public:',
        '    void Go() { T::Make(); }',
        '  };',
        '};',
        'Outer<PlainTxn> outer;',
        'template <typename T>',
        'void Run() {',
        '  struct Local {',
        '    void Go() { T::Make(); }',
        '  };',
        '  auto later = [] { T::Make(); };',
        '}',
        'void Start() { Run<FancyTxn>(); }',
      ),
    });
    expect(reached(cg, 'Outer::Inner::Go')).toEqual(['PlainTxn::Make']);
    expect(reached(cg, 'Run::Local::Go')).toEqual(['FancyTxn::Make']);
    expect(reached(cg, 'Run')).toEqual(['FancyTxn::Make']);
  });

  it('reads the parameter of a nested class defined outside its template', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'list.h': lines(
        '#include "txn.h"',
        'template <typename T>',
        'class List {',
        ' public:',
        '  struct Node;',
        '};',
        'template <typename T>',
        'struct List<T>::Node {',
        '  void Go() { T::Make(); }',
        '};',
      ),
      'use.cc': lines('#include "list.h"', 'List<PlainTxn> list;'),
    });
    expect(templateEdges(cg).map((e) => e.target)).toEqual(['PlainTxn::Make']);
  });

  it('reads a parameter pack', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'pack.h': lines('#include "txn.h"', 'template <int N, typename... Ts>', 'struct All {', '  static void Go() { (Ts::Make(), ...); }', '};'),
      'use.cc': lines('#include "pack.h"', 'All<1, PlainTxn, FancyTxn> all;'),
    });
    expect(reached(cg, 'All::Go')).toEqual(['FancyTxn::Make', 'PlainTxn::Make']);
  });

  it('takes a default the instantiation does not write', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'def.h': lines('#include "txn.h"', 'template <typename A, typename B = FancyTxn>', 'struct Def {', '  void Go() { B::Commit(); B::Put(1); }', '};'),
      'use.cc': lines('#include "def.h"', 'Def<int> plain;', 'Def<int, PlainTxn> written;'),
    });
    expect(reached(cg, 'Def::Go')).toEqual(['BaseTxn::Commit', 'FancyTxn::Put', PUT_PLAIN]);
  });

  it('looks the template up from a namespace, with no declaration around the site', async () => {
    const cg = await indexed({
      'all.h': lines(
        'namespace ns {',
        'struct Item { static void Go() {} };',
        'template <typename T> struct Box { void Run() { T::Go(); } };',
        '}',
      ),
      'other.h': lines('namespace other {', 'struct Item { static void Go() {} };', '}'),
      'use.cc': lines('#include "all.h"', '#include "other.h"', 'namespace ns {', 'template class Box<Item>;', '}'),
    });
    expect(reached(cg, 'ns::Box::Run')).toEqual(['ns::Item::Go']);
  });

  it('counts a namespace a macro opens', async () => {
    const cg = await indexed({
      'macros.h': lines('#define NS_BEGIN namespace ns {', '#define NS_END }'),
      'all.h': lines(
        '#include "macros.h"',
        'NS_BEGIN',
        'struct Item { static void Go() {} };',
        'template <typename T> struct Box { void Run() { T::Go(); } };',
        'NS_END',
      ),
      'use.cc': lines('#include "all.h"', 'NS_BEGIN', 'template class Box<Item>;', 'NS_END'),
    });
    expect(templateEdges(cg).map((e) => e.registeredAt)).toEqual(['use.cc:3']);
  });

  it('reads a function pointer to a member through a parameter', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'use.cc': lines(
        '#include "txn.h"',
        'template <class T>',
        'struct Each {',
        '  void Go() { Run(&T::Make); }',
        '  void Run(void (*fn)()) { fn(); }',
        '};',
        'Each<PlainTxn> each;',
      ),
    });
    const [edge] = templateEdges(cg);
    expect(edge).toMatchObject({ kind: 'references', source: 'Each::Go', target: 'PlainTxn::Make', fnRef: 1 });
  });
});

describe('a call on a value of the parameter\'s type', () => {
  const body = (code: string): Record<string, string> => ({
    'shards.h': lines(
      'struct Inner { void Deep() {} };',
      'struct FastShard { using Part = Inner; void Clear() {} };',
      'struct SlowShard { using Part = Inner; void Clear() {} };',
    ),
    'cache.h': lines(
      '#include "shards.h"',
      'template <typename Shard>',
      'class Cache {',
      ' public:',
      code,
      ' private:',
      '  Shard own_;',
      '  Shard* many_;',
      '};',
    ),
    'use.cc': lines('#include "cache.h"', 'Cache<FastShard> fast;', 'Cache<SlowShard> slow;'),
  });
  const CLEARS = ['FastShard::Clear', 'SlowShard::Clear'];

  it.each([
    ['a parameter by reference', 'void Run(Shard& shard) { shard.Clear(); }'],
    ['a parameter by const reference', 'void Run(const Shard& shard) { shard.Clear(); }'],
    ['a parameter by pointer', 'void Run(Shard* shard) { shard->Clear(); }'],
    ['a local', 'void Run() { Shard shard; shard.Clear(); }'],
    ['a member', 'void Run() { own_.Clear(); }'],
    ['a pointer member', 'void Run() { many_->Clear(); }'],
  ])('reads %s', async (_form, code) => {
    const cg = await indexed(body(code));
    expect(reached(cg, 'Cache::Run')).toEqual(CLEARS);
  });

  it('reads a member of the parameter\'s type, unless a local of another type hides it', async () => {
    const hidden = await indexed(body('void Run() { Inner own_; own_.Clear(); }'));
    expect(templateEdges(hidden)).toEqual([]);
  });

  it('reads a member type of the parameter', async () => {
    const cg = await indexed(body('void Run() { typename Shard::Part part; part.Deep(); }'));
    expect(reached(cg, 'Cache::Run')).toEqual(['Inner::Deep']);
  });

  it('reads an alias of a member type', async () => {
    const cg = await indexed(body('using Part = typename Shard::Part;\n  void Run(Part& part) { part.Deep(); }'));
    expect(reached(cg, 'Cache::Run')).toEqual(['Inner::Deep']);
  });

  it('keeps out an arrow on a value: that is the argument\'s own operator', async () => {
    const cg = await indexed(body('void Run(Shard& shard) { shard->Clear(); }'));
    expect(templateEdges(cg)).toEqual([]);
  });

  it('keeps out a variable of another type', async () => {
    const cg = await indexed(body('void Run(Other& shard) { shard.Clear(); }'));
    expect(templateEdges(cg)).toEqual([]);
  });

  it('leaves a call a resolver links alone', async () => {
    const cg = await indexed(body('void Run(Inner& inner) { inner.Deep(); }'));
    expect(templateEdges(cg)).toEqual([]);
    expect(cg.getCallees(cg.getNodesByKind('method').find((n) => n.qualifiedName === 'Cache::Run')!.id).map((r) => r.node.qualifiedName)).toEqual(['Inner::Deep']);
  });
});

describe('a deduced argument', () => {
  const deduced = (use: string): Promise<CodeGraph> => indexed({
    'txn.h': TXN,
    'run.cc': lines(
      '#include "txn.h"',
      'template <typename T> void ByValue(T x) { T::Make(); }',
      'template <typename T> void ByRef(const T& x) { T::Make(); }',
      'template <typename T> void ByPointer(T* x) { T::Make(); }',
      'template <typename T> void ByHolder(std::vector<T>* x) { T::Make(); }',
      use,
    ),
  });

  it('reads the type of a declared argument, whole', async () => {
    const cg = await deduced('void Run() { PlainTxn p; ByValue(p); ByRef(p); }');
    expect(reached(cg, 'ByValue')).toEqual(['PlainTxn::Make']);
    expect(reached(cg, 'ByRef')).toEqual(['PlainTxn::Make']);
  });

  it('reads what a pointer points at', async () => {
    const cg = await deduced('void Run() { FancyTxn f; ByPointer(&f); FancyTxn* q = nullptr; ByPointer(q); }');
    expect(reached(cg, 'ByPointer')).toEqual(['FancyTxn::Make']);
  });

  it('follows an argument whose type is the caller\'s own parameter', async () => {
    const cg = await deduced('template <typename U> void Outer(U u) { ByRef(u); }\nvoid Run() { Outer<PlainTxn>(PlainTxn()); }');
    expect(reached(cg, 'ByRef')).toEqual(['PlainTxn::Make']);
  });

  it('gives no edge for a literal, an unknown name or a type the parameter only holds', async () => {
    const cg = await deduced('void Run(int i) { ByValue(1); ByRef(nowhere); ByRef(i); std::vector<PlainTxn> v; ByHolder(&v); PlainTxn p; ByPointer(p); }');
    expect(templateEdges(cg)).toEqual([]);
  });

  it('keeps a call that gives a type beside one that gives a literal', async () => {
    const cg = await deduced('void Run() { ByValue(1); PlainTxn p; ByValue(p); }');
    expect(reached(cg, 'ByValue')).toEqual(['PlainTxn::Make']);
  });

  it('takes the written argument over the deduced one', async () => {
    const cg = await deduced('void Run() { PlainTxn p; ByValue<FancyTxn>(p); }');
    expect(reached(cg, 'ByValue')).toEqual(['FancyTxn::Make']);
  });
});

describe('an instantiation inside another template', () => {
  it('follows the argument to the outer template, through a chain', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'chain.h': lines(
        '#include "mixin.h"',
        'template <typename U>',
        'class Middle : public Mixin<U> {};',
        'template <typename V>',
        'using Short = Middle<V>;',
        'template <typename W>',
        'void Outer() { Short<W> s; }',
      ),
      'use.cc': lines('#include "chain.h"', 'void Run() { Outer<PlainTxn>(); }', 'Short<FancyTxn> direct;'),
    });
    expect(reached(cg, 'Mixin::Add')).toEqual(['FancyTxn::Put', PUT_PLAIN]);
    expect(templateEdges(cg).find((e) => e.target === PUT_PLAIN)?.registeredAt).toBe('use.cc:2');
  });

  it('links no call to itself', async () => {
    const cg = await indexed({
      'all.cc': lines(
        'template <typename D>',
        'struct Base { static void Make() { D::Make(); } };',
        'struct Plain : public Base<Plain> {};',
        'struct Own : public Base<Own> { static void Make() {} };',
      ),
    });
    expect(reached(cg, 'Base::Make')).toEqual(['Own::Make']);
  });

  it('follows an argument written const', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'inner.h': lines(
        '#include "txn.h"',
        'template <typename T> struct Inner { void Go() { T::Make(); } };',
        'template <typename U> struct Outer { Inner<const U> held; };',
      ),
      'use.cc': lines('#include "inner.h"', 'Outer<PlainTxn> outer;'),
    });
    expect(reached(cg, 'Inner::Go')).toEqual(['PlainTxn::Make']);
  });

  it('stops at a cycle, keeping what the rest of the walk finds', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'loop.h': lines(
        '#include "txn.h"',
        'template <typename T> class B;',
        'template <typename T>',
        'class A {',
        ' public:',
        '  void Go() { T::Make(); }',
        '  B<T>* next_;',
        '};',
        'template <typename T>',
        'class B {',
        '  A<T>* next_;',
        '  A<B<T>>* self_;',
        '};',
      ),
      'use.cc': lines('#include "loop.h"', 'B<PlainTxn> start;'),
    });
    expect(reached(cg, 'A::Go')).toEqual(['PlainTxn::Make']);
  });

  it.each([
    [4, ['PlainTxn::Make']],
    [5, []],
  ])('follows an argument through %i templates at most, and stops short of a wrong answer', async (depth, targets) => {
    const chain = Array.from({ length: depth }, (_, i) => lines(`template <typename T> class C${i} : public C${i + 1}<T> {};`)).reverse();
    const cg = await indexed({
      'txn.h': TXN,
      'chain.h': lines(
        '#include "txn.h"',
        `template <typename T> class C${depth} { public: void Go() { T::Make(); } };`,
        ...chain,
      ),
      'use.cc': lines('#include "chain.h"', 'C0<PlainTxn> deep;'),
    });
    expect(reached(cg, `C${depth}::Go`)).toEqual(targets);
  });
});

describe('gtest typed tests', () => {
  const RIBBON = lines(
    '#include <gtest/gtest.h>',
    'struct SmallGen { SmallGen(int a, int b) {} };',
    'struct BigGen { BigGen(int a, int b) {} };',
    'struct Base { using KeyGen = BigGen; static int Chance() { return 1; } };',
    'struct Small : public Base { using KeyGen = SmallGen; static int Chance() { return 2; } };',
    'struct Other : public Base {};',
    'template <typename T>',
    'class RibbonTest : public ::testing::Test {};',
    'using Listed = ::testing::Types<',
    '    Small,',
    '    Other>;',
    'TYPED_TEST_SUITE(RibbonTest, Listed);',
    'TYPED_TEST(RibbonTest, Works) {',
    '  using KeyGen = typename TypeParam::KeyGen;',
    '  KeyGen one(1, 2);',
    '  int c = TypeParam::Chance();',
    '}',
  );

  it('links TypeParam to each listed type, inherited or its own', async () => {
    const cg = await indexed({ 'ribbon_test.cc': RIBBON });
    const edges = templateEdges(cg);
    expect(edges.filter((e) => e.kind === 'calls' && e.target.endsWith('Chance')).map((e) => e.target).sort()).toEqual(['Base::Chance', 'Small::Chance']);
    expect(edges.filter((e) => e.kind === 'instantiates').map((e) => e.target).sort()).toEqual(['Base::KeyGen', 'Small::KeyGen']);
    expect(edges.filter((e) => e.kind === 'instantiates').every((e) => e.targetKind === 'type_alias')).toBe(true);
    expect(edges.find((e) => e.target === 'Small::KeyGen')).toMatchObject({ via: 'TypeParam', argument: 'Small', registeredAt: 'ribbon_test.cc:10' });
  });

  it('links the constructor of what each member alias names', async () => {
    const cg = await indexed({ 'ribbon_test.cc': RIBBON });
    expect(templateEdges(cg).filter((e) => /Gen$/.test(e.target) && e.targetKind === 'method').map((e) => e.target).sort())
      .toEqual(['BigGen::BigGen', 'SmallGen::SmallGen']);
  });

  it.each([
    ['TYPED_TEST_CASE', 'TYPED_TEST_CASE(T1, Listed);', 'TYPED_TEST(T1, Works)'],
    ['a list written in the macro', 'TYPED_TEST_SUITE(T1, ::testing::Types<A>);', 'TYPED_TEST(T1, Works)'],
    ['a typedef of the list', 'typedef ::testing::Types<A> Spare; TYPED_TEST_SUITE(T1, Spare);', 'TYPED_TEST(T1, Works)'],
    ['a parameterized suite', 'INSTANTIATE_TYPED_TEST_SUITE_P(Pre, T1, Listed);', 'TYPED_TEST_P(T1, Works)'],
    ['the older parameterized macro', 'INSTANTIATE_TYPED_TEST_CASE_P(Pre, T1, Listed);', 'TYPED_TEST_P(T1, Works)'],
  ])('reads %s', async (_form, suite, test) => {
    const cg = await indexed({
      'a_test.cc': lines(
        '#include <gtest/gtest.h>',
        'struct A { static int Go() { return 1; } };',
        'template <typename T> class T1 : public ::testing::Test { public: int Own() { return T::Go(); } };',
        'using Listed = ::testing::Types<A>;',
        suite,
        `${test} { TypeParam::Go(); }`,
      ),
    });
    const targets = templateEdges(cg).map((e) => e.target);
    expect(targets).toContain('A::Go');
    expect(reached(cg, 'T1::Own')).toEqual(['A::Go']);
  });

  it('reads a typed suite whose tests live in a header', async () => {
    const cg = await indexed({
      'suite.h': lines(
        'template <typename T> class Suite : public ::testing::Test {};',
        'TYPED_TEST_SUITE_P(Suite);',
        'TYPED_TEST_P(Suite, Works) { TypeParam::Go(); }',
      ),
      'a_test.cc': lines(
        '#include "suite.h"',
        'struct A { static int Go() { return 1; } };',
        'using Listed = ::testing::Types<A>;',
        'INSTANTIATE_TYPED_TEST_SUITE_P(My, Suite, Listed);',
      ),
    });
    expect(templateEdges(cg).map((e) => e.target)).toEqual(['A::Go']);
  });

  it('follows TypeParam into a helper the test instantiates', async () => {
    const cg = await indexed({
      'a_test.cc': lines(
        '#include <gtest/gtest.h>',
        'struct A { static int Go() { return 1; } };',
        'template <typename T> void Helper() { T::Go(); }',
        'template <typename T> class T1 : public ::testing::Test {};',
        'TYPED_TEST_SUITE(T1, ::testing::Types<A>);',
        'TYPED_TEST(T1, Works) { Helper<TypeParam>(); }',
      ),
    });
    expect(reached(cg, 'Helper')).toEqual(['A::Go']);
  });
});

describe('what an argument is', () => {
  it('finds a class local to the function that writes it, one per function', async () => {
    const cg = await indexed({
      'batch.cc': lines(
        'namespace ns {',
        'class Batch {',
        ' public:',
        '  template <typename Traits> void Impl();',
        '  void Get();',
        '  void GetEntity();',
        '};',
        'template <typename Traits>',
        'void Batch::Impl() { Traits::Clear(); }',
        'void Batch::Get() {',
        '  struct Traits { static void Clear() {} };',
        '  Impl<Traits>();',
        '}',
        'void Batch::GetEntity() {',
        '  struct Traits { static void Clear() {} };',
        '  Impl<Traits>();',
        '}',
        '}  // namespace ns',
      ),
    });
    expect(templateEdges(cg).map((e) => [e.source, e.registeredAt])).toEqual([
      ['ns::Batch::Impl', 'batch.cc:12'],
      ['ns::Batch::Impl', 'batch.cc:16'],
    ]);
    expect(reached(cg, 'ns::Batch::Impl')).toHaveLength(2);
  });

  it('follows an alias of the class, at namespace scope and in the function', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines(
        '#include "mixin.h"',
        'namespace ns { using Named = PlainTxn; }',
        'ns::Named* unused;',
        'Mixin<ns::Named> global;',
        'void Run() {',
        '  using Local = FancyTxn;',
        '  Mixin<Local> local;',
        '}',
      ),
    });
    expect(reached(cg, 'Mixin::Add')).toEqual(['FancyTxn::Put', PUT_PLAIN]);
  });

  it('looks an argument up from where it is written', async () => {
    const cg = await indexed({
      'a.h': lines('namespace a { struct Item { static void Go() {} }; }'),
      'b.h': lines('namespace b { struct Item { static void Go() {} }; }'),
      'box.h': lines('template <typename T>', 'struct Box { void Run() { T::Go(); } };'),
      'use.cc': lines('#include "a.h"', '#include "b.h"', '#include "box.h"', 'namespace b { Box<Item> here; }'),
    });
    expect(reached(cg, 'Box::Run')).toEqual(['b::Item::Go']);
  });

  it('takes no class of a scope the site does not name', async () => {
    const cg = await indexed({
      'txn.h': lines(TXN, 'namespace deep { struct Hidden { static void Make() {} }; }'),
      'box.h': lines('#include "txn.h"', 'template <typename T>', 'struct Box { void Run() { T::Make(); } };'),
      'use.cc': lines('#include "box.h"', 'Box<Hidden> b;'),
    });
    expect(templateEdges(cg)).toEqual([]);
  });

  it('gives an outside argument no edge, and keeps the others', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines(
        '#include "mixin.h"',
        '#include <string>',
        'Mixin<std::string> s;',
        'Mixin<int> i;',
        'Mixin<PlainTxn> p;',
      ),
    });
    expect(reached(cg, 'Mixin::Add')).toEqual([PUT_PLAIN]);
  });

  it('gives a pointer or a reference no edge: no such instantiation has the member', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines('#include "mixin.h"', 'Mixin<PlainTxn*> p;', 'Mixin<PlainTxn&> r;', 'Mixin<const FancyTxn> c;'),
    });
    expect(reached(cg, 'Mixin::Add')).toEqual(['FancyTxn::Put']);
  });

  it('links a member a class inherits, and none it lacks', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines('#include "mixin.h"', 'Mixin<PlainTxn> p;', 'Mixin<NoPutTxn> n;'),
    });
    expect(reached(cg, 'Mixin::Finish')).toEqual(['BaseTxn::Commit']);
    expect(reached(cg, 'Mixin::Add')).toEqual([PUT_PLAIN]);
  });

  it('reads a member type of a parameter', async () => {
    const cg = await indexed({
      'all.cc': lines(
        'struct Key { static void Make() {} };',
        'struct Lock { static void Make() {} };',
        'struct Traits { using K = Key; struct Nested { static void Go() {} }; };',
        'template <typename T>',
        'struct User {',
        '  using Mine = typename T::K;',
        '  void Run() { Mine::Make(); T::Nested::Go(); }',
        '};',
        'User<Traits> user;',
      ),
    });
    expect(reached(cg, 'User::Run')).toEqual(['Key::Make', 'Traits::Nested::Go']);
  });

  it('reads a member enum of a parameter', async () => {
    const cg = await indexed({
      'item.h': lines('struct Item { enum Kind { One }; };', 'struct Odd { enum Kind { Two }; };'),
      'box.h': lines('#include "item.h"', 'template <typename T>', 'struct Box { void Run() { using K = typename T::Kind; K kind(0); } };'),
      'use.cc': lines('#include "box.h"', 'Box<Item> box;'),
    });
    expect(reached(cg, 'Box::Run')).toEqual(['Item::Kind']);
  });

  it('constructs through a parameter', async () => {
    const cg = await indexed({
      'all.cc': lines(
        'struct Two { Two(int a, int b) {} };',
        'template <typename T>',
        'void Make() {',
        '  T value(1, 2);',
        '  T* made = new T(3, 4);',
        '}',
        'void Run() { Make<Two>(); }',
      ),
    });
    const edges = templateEdges(cg);
    expect(edges.filter((e) => e.kind === 'instantiates').map((e) => e.target)).toEqual(['Two']);
    expect(edges.filter((e) => e.kind === 'calls').map((e) => e.target)).toEqual(['Two::Two']);
  });
});

describe('what is no instantiation', () => {
  it('reads nothing from a comment, a string, a raw string or a macro body', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines(
        '#include "mixin.h"',
        '// Mixin<PlainTxn> in a line comment',
        '/* Mixin<PlainTxn> in a block',
        '   Mixin<PlainTxn> comment */',
        'const char* s = "Mixin<PlainTxn>";',
        'const char* r = R"cc(',
        '  Mixin<PlainTxn> raw;',
        ')cc";',
        '#define USES Mixin<PlainTxn>',
        '#define CONTINUED \\',
        '  Mixin<PlainTxn>',
      ),
    });
    expect(templateEdges(cg)).toEqual([]);
  });

  it('reads no typed suite from a macro body', async () => {
    const cg = await indexed({
      'a_test.cc': lines(
        '#include <gtest/gtest.h>',
        'struct A { static int Go() { return 1; } };',
        'struct B { static int Go() { return 2; } };',
        'template <typename T> class T1 : public ::testing::Test {};',
        '#define NEVER TYPED_TEST_SUITE(T1, ::testing::Types<B>)',
        'TYPED_TEST_SUITE(T1, ::testing::Types<A>);',
        'TYPED_TEST(T1, Works) { TypeParam::Go(); }',
      ),
    });
    expect(templateEdges(cg).map((e) => e.target)).toEqual(['A::Go']);
  });

  it('reads no longer name that ends in the template\'s', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines('#include "mixin.h"', 'template <typename T> struct SuperMixin {};', 'SuperMixin<FancyTxn> other;', 'Mixin<PlainTxn> mine;'),
    });
    expect(reached(cg, 'Mixin::Add')).toEqual([PUT_PLAIN]);
  });

  it('reads no friend, and no comparison', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines(
        '#include "mixin.h"',
        'class Friendly { friend class Mixin<PlainTxn>; };',
        'int Mixin = 3;',
        'bool Less(int PlainTxn, int x) { return Mixin < PlainTxn && x > 1; }',
      ),
    });
    expect(templateEdges(cg)).toEqual([]);
  });

  it('keeps a namesake template out', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': lines(
        '#include "txn.h"',
        'namespace mine {',
        'template <typename Txn>',
        'class Mixin { public: void Add(int k) { Txn::Put(k); } };',
        '}',
      ),
      'other.h': lines('namespace yours {', 'template <typename X> class Mixin {};', '}'),
      'use.cc': lines(
        '#include "mixin.h"',
        '#include "other.h"',
        'yours::Mixin<PlainTxn> elsewhere;',
        'mine::Mixin<FancyTxn> here;',
      ),
    });
    expect(reached(cg, 'mine::Mixin::Add')).toEqual(['FancyTxn::Put']);
  });

  it('keeps a template of a source file to that file', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'a.cc': lines('#include "txn.h"', 'template <typename T> struct Local { void Go() { T::Make(); } };', 'Local<PlainTxn> a;'),
      'b.cc': lines('#include "txn.h"', 'template <typename T> struct Local { void Go() { T::Make(); } };', 'Local<FancyTxn> b;'),
    });
    const edges = templateEdges(cg).map((e) => `${e.target} ${e.registeredAt}`).sort();
    expect(edges).toEqual(['FancyTxn::Make b.cc:3', 'PlainTxn::Make a.cc:3']);
  });

  it('keeps a call from a file that cannot see the function template out', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'run.h': lines('#include "txn.h"', 'template <typename T>', 'void Run() { T::Make(); }'),
      'use.cc': lines('#include "run.h"', 'void Use() { Run<PlainTxn>(); }'),
      'other.cc': lines('#include "txn.h"', 'void Elsewhere() { Run<FancyTxn>(); }'),
    });
    expect(reached(cg, 'Run')).toEqual(['PlainTxn::Make']);
  });

  it('keeps a member template call out, whatever it shares a name with', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'get.h': lines('#include "txn.h"', 'template <typename T> struct get { void Run() { T::Make(); } };'),
      'use.cc': lines('#include "get.h"', 'void Run(Holder& h, Holder* p) { h.get<PlainTxn>(); p->get<PlainTxn>(); }'),
    });
    expect(templateEdges(cg)).toEqual([]);
  });

  it('reads a parameter in a head no node holds as a parameter, not as a class of its name', async () => {
    const cg = await indexed({
      'all.h': lines(
        'struct T { static void Go() {} };',
        'template <typename U> struct Box { void Run() { U::Go(); } };',
        'template <typename T> Box<T> Make();',
        'template <typename T, typename V = Box<T>> struct Other {};',
      ),
    });
    expect(templateEdges(cg)).toEqual([]);
  });

  it('keeps two headers that declare one fixture name apart', async () => {
    const test = (kind: string): string => lines(
      'template <typename T> class Shared : public ::testing::Test {};',
      'TYPED_TEST_SUITE_P(Shared);',
      `TYPED_TEST_P(Shared, ${kind}) { TypeParam::Go(); }`,
    );
    const unit = (kind: string): string => lines(
      `#include "${kind.toLowerCase()}_test.h"`,
      `struct ${kind}Type { static int Go() { return 1; } };`,
      `INSTANTIATE_TYPED_TEST_SUITE_P(${kind}, Shared, ::testing::Types<${kind}Type>);`,
    );
    const cg = await indexed({
      'map_test.h': test('Map'),
      'set_test.h': test('Set'),
      'map_test.cc': unit('Map'),
      'set_test.cc': unit('Set'),
    });
    const db = (cg as unknown as { db: { db: { prepare(sql: string): { all(): Array<{ file: string; target: string }> } } } }).db.db;
    expect(db.prepare(
      `SELECT s.file_path file, t.qualified_name target FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata, '$.synthesizedBy') = 'cpp-template-argument' ORDER BY file`
    ).all()).toEqual([{ file: 'map_test.h', target: 'MapType::Go' }, { file: 'set_test.h', target: 'SetType::Go' }]);
  });

  it('keeps a vendored copy of a class out of a file that does not include it', async () => {
    const cg = await indexed({
      'include/item.h': lines('namespace lib { struct Item { static void Go() {} }; }'),
      'tests/abi/item.h': lines('namespace lib { struct Item { static void Go() {} }; }'),
      'include/box.h': lines('#include "item.h"', 'namespace lib {', 'template <typename T>', 'struct Box { void Run() { T::Go(); } };', '}'),
      'tests/use.cc': lines('#include "../include/box.h"', 'lib::Box<lib::Item> b;'),
    });
    expect(templateEdges(cg).map((e) => e.registeredAt)).toEqual(['tests/use.cc:2']);
    const db = (cg as unknown as { db: { db: { prepare(sql: string): { all(): Array<{ file_path: string }> } } } }).db.db;
    expect(db.prepare(`SELECT n.file_path FROM edges e JOIN nodes n ON n.id = e.target WHERE json_extract(e.metadata, '$.synthesizedBy') = 'cpp-template-argument'`).all())
      .toEqual([{ file_path: 'include/item.h' }]);
  });
});

describe('a vendored copy under a plain namespace', () => {
  it.each([
    ['at file scope', lines('using Mine = lib::Item;', 'Box<Mine> b;')],
    ['in a function', lines('void Use() {', '  using Mine = lib::Item;', '  Box<Mine> b;', '}')],
  ])('is not what an alias %s names when a macro hides the real one', async (_where, use) => {
    const cg = await indexed({
      'include/macros.h': lines('#define NS_BEGIN namespace lib {', '#define NS_END }'),
      'include/item.h': lines('#include "macros.h"', 'NS_BEGIN', 'struct Item { static void Go() {} };', 'NS_END'),
      'tests/abi/item.h': lines('namespace lib { struct Item { static void Go() {} }; }'),
      'include/box.h': lines('#include "item.h"', 'template <typename T>', 'struct Box { void Run() { T::Go(); } };'),
      'tests/use.cc': lines('#include "../include/box.h"', use),
    });
    const db = (cg as unknown as { db: { db: { prepare(sql: string): { all(): Array<{ file_path: string }> } } } }).db.db;
    expect(db.prepare(`SELECT n.file_path FROM edges e JOIN nodes n ON n.id = e.target WHERE json_extract(e.metadata, '$.synthesizedBy') = 'cpp-template-argument' AND n.file_path LIKE 'tests/%'`).all())
      .toEqual([]);
  });
});

describe('a member alias', () => {
  it('names a class the file declaring it can see, not a vendored copy\'s', async () => {
    const cg = await indexed({
      'macros.h': lines('#define NS_BEGIN namespace lib {', '#define NS_END }'),
      'real/part.h': lines('#include "../macros.h"', 'NS_BEGIN', 'struct Part { static void Make() {} };', 'NS_END'),
      'vendored/part.h': lines('namespace lib { struct Part { static void Make() {} }; }'),
      'real/item.h': lines('#include "part.h"', 'struct Item { using P = ::lib::Part; };'),
      'other.h': lines('struct Lone { static void Make() {} };'),
      'box.h': lines('#include "real/item.h"', '#include "other.h"', 'template <typename T>', 'struct Box { void Run() { using P = typename T::P; P::Make(); } };'),
      'use.cc': lines('#include "box.h"', 'Box<Item> b;'),
    });
    expect(templateEdges(cg).map((e) => e.target)).not.toContain('lib::Part::Make');
  });
});

describe('a member alias of a vendored copy', () => {
  it('is no member of the class the argument names', async () => {
    const cg = await indexed({
      'real/item.h': lines('struct Item {};'),
      'vendored/item.h': lines('struct Item { using Spare = int; };'),
      'box.h': lines('#include "real/item.h"', 'template <typename T>', 'struct Box { void Run() { using S = typename T::Spare; S spare(0); } };'),
      'use.cc': lines('#include "box.h"', 'Box<Item> b;'),
    });
    expect(templateEdges(cg)).toEqual([]);
  });
});

describe('specializations', () => {
  const HEADER = lines(
    '#include "txn.h"',
    'template <typename T, typename U = void>',
    'struct Traits {',
    '  void Primary() { T::Make(); }',
    '};',
    'template <>',
    'struct Traits<PlainTxn> {',
    '  void Full() {}',
    '};',
    'template <typename U>',
    'struct Traits<FancyTxn, U> {',
    '  void Partial() { U::Make(); }',
    '};',
    'template <typename T>',
    'struct Traits<T*, int> {',
    '  void Pointer() { T::Make(); }',
    '};',
  );

  it('an instantiation a full specialization takes does not run the template', async () => {
    const cg = await indexed({
      'txn.h': lines(TXN, 'class ThirdTxn { public: static void Make() {} };'),
      'traits.h': HEADER,
      'use.cc': lines('#include "traits.h"', 'Traits<PlainTxn> full;', 'Traits<ThirdTxn> plain;'),
    });
    expect(reached(cg, 'Traits::Primary')).toEqual(['ThirdTxn::Make']);
  });

  it('a partial specialization reads its own parameter from what it matches', async () => {
    const cg = await indexed({
      'txn.h': lines(TXN, 'class ThirdTxn { public: static void Make() {} };'),
      'traits.h': HEADER,
      'use.cc': lines('#include "traits.h"', 'Traits<FancyTxn, PlainTxn> a;', 'Traits<ThirdTxn*, int> b;'),
    });
    expect(reached(cg, '<anonymous>::Partial')).toEqual(['PlainTxn::Make']);
    expect(reached(cg, '<anonymous>::Pointer')).toEqual(['ThirdTxn::Make']);
    expect(reached(cg, 'Traits::Primary')).toEqual([]);
  });

  it('an instantiation no specialization matches stays with the template', async () => {
    const cg = await indexed({
      'txn.h': lines(TXN, 'class ThirdTxn { public: static void Make() {} };'),
      'traits.h': HEADER,
      'use.cc': lines('#include "traits.h"', 'Traits<ThirdTxn, int> a;'),
    });
    expect(reached(cg, 'Traits::Primary')).toEqual(['ThirdTxn::Make']);
    expect(reached(cg, '<anonymous>::Pointer')).toEqual([]);
  });

  it('each specialization keeps to the instantiations it takes', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'holder.h': lines(
        '#include "txn.h"',
        'template <typename T> struct Holder {};',
        'template <typename T> struct Holder<T*> { void Pointer() { T::Make(); } };',
        'template <typename T> struct Holder<T&> { void Ref() { T::Make(); } };',
      ),
      'use.cc': lines('#include "holder.h"', 'Holder<PlainTxn*> a;', 'Holder<FancyTxn&> b;'),
    });
    expect(reached(cg, '<anonymous>::Pointer')).toEqual(['PlainTxn::Make']);
    expect(reached(cg, '<anonymous>::Ref')).toEqual(['FancyTxn::Make']);
  });

  it('reads a member of a partial specialization defined outside it', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'pair.h': lines(
        '#include "txn.h"',
        'template <typename T, typename U>',
        'struct Pair { void Go(); };',
        'template <typename T>',
        'struct Pair<T, int> { void Go(); };',
        'template <typename T>',
        'void Pair<T, int>::Go() { T::Make(); }',
      ),
      'use.cc': lines('#include "pair.h"', 'Pair<PlainTxn, int> a;', 'Pair<FancyTxn, long> b;'),
    });
    expect(templateEdges(cg).map((e) => e.target)).toEqual(['PlainTxn::Make']);
  });

  it('a condition no one can read keeps an instantiation out of the template', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'traits.h': lines(
        '#include "txn.h"',
        'template <typename T, typename Enable = void>',
        'struct Traits { void Primary() { T::Make(); } };',
        'template <typename T>',
        'struct Traits<T, std::enable_if_t<sizeof(T) == 1>> { void Small() {} };',
      ),
      'use.cc': lines('#include "traits.h"', 'Traits<PlainTxn> maybe;'),
    });
    expect(reached(cg, 'Traits::Primary')).toEqual([]);
  });

  it('a member specialized out of line leaves the instantiation with the rest', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines('#include "mixin.h"', 'template <> void Mixin<PlainTxn>::Finish() {}', 'Mixin<PlainTxn> p;'),
    });
    expect(reached(cg, 'Mixin::Add')).toEqual([PUT_PLAIN]);
  });
});

describe('the cap', () => {
  const classes = (n: number): string => Array.from({ length: n }, (_, i) => `struct C${i} { static void Go() {} };`).join('\n');
  const uses = (n: number): string => Array.from({ length: n }, (_, i) => `Box<C${i}> b${i};`).join('\n');
  const box = lines('template <typename T>', 'struct Box { void Run() { T::Go(); } };');

  it('links every class up to the cap', async () => {
    const cg = await indexed({ 'all.cc': `${box}${classes(CPP_TEMPLATE_ARGUMENT_CAP)}\n${uses(CPP_TEMPLATE_ARGUMENT_CAP)}\n` });
    expect(reached(cg, 'Box::Run')).toHaveLength(CPP_TEMPLATE_ARGUMENT_CAP);
  });

  it('links none past it, not some', async () => {
    const n = CPP_TEMPLATE_ARGUMENT_CAP + 1;
    const cg = await indexed({ 'all.cc': `${box}${classes(n)}\n${uses(n)}\n` });
    expect(reached(cg, 'Box::Run')).toEqual([]);
  });

  it('counts classes, not sites', async () => {
    const sites = Array.from({ length: CPP_TEMPLATE_ARGUMENT_CAP * 3 }, (_, i) => `Box<C0> s${i};`).join('\n');
    const cg = await indexed({ 'all.cc': `${box}${classes(1)}\n${sites}\n` });
    expect(reached(cg, 'Box::Run')).toEqual(['C0::Go']);
  });

  it('counts a chain with the classes it reaches', async () => {
    const n = CPP_TEMPLATE_ARGUMENT_CAP + 1;
    const wrapped = Array.from({ length: n }, (_, i) => `Wrap<C${i}> w${i};`).join('\n');
    const cg = await indexed({ 'all.cc': `${box}template <typename U> struct Wrap : Box<U> {};\n${classes(n)}\n${wrapped}\n` });
    expect(reached(cg, 'Box::Run')).toEqual([]);
  });
});

/** The template edges as text, for comparing two graphs. */
const asText = (cg: CodeGraph): string[] => templateEdges(cg).map((e) => JSON.stringify(e)).sort();

describe('sync matches a fresh index', () => {
  const BASE = {
    'txn.h': TXN,
    'mixin.h': MIXIN,
    'keep.cc': lines('#include "mixin.h"', 'Mixin<PlainTxn> kept;'),
  };

  /** Index `before`, write `after`, sync, and compare with a fresh index of `after`. */
  const syncs = async (before: Record<string, string>, after: Record<string, string>, removed: string[] = []): Promise<string[]> => {
    const root = project(before);
    const cg = await opened(root);
    write(root, after);
    for (const file of removed) fs.rmSync(path.join(root, file));
    await cg.sync();
    const fresh = await indexed(Object.fromEntries(
      Object.entries({ ...before, ...after }).filter(([file]) => !removed.includes(file))));
    expect(asText(cg)).toEqual(asText(fresh));
    return reached(cg, 'Mixin::Add');
  };

  it('an instantiation added in a third file', async () => {
    expect(await syncs(BASE, { 'added.cc': lines('#include "mixin.h"', 'Mixin<FancyTxn> added;') }))
      .toEqual(['FancyTxn::Put', PUT_PLAIN]);
  });

  it('an instantiation changed in a third file', async () => {
    const before = { ...BASE, 'third.cc': lines('#include "mixin.h"', 'Mixin<FancyTxn> third;') };
    expect(await syncs(before, { 'third.cc': lines('#include "mixin.h"', 'Mixin<NoPutTxn> third;') })).toEqual([PUT_PLAIN]);
  });

  it('an instantiation removed from a third file', async () => {
    const before = { ...BASE, 'third.cc': lines('#include "mixin.h"', 'Mixin<FancyTxn> third;') };
    expect(await syncs(before, { 'third.cc': lines('#include "mixin.h"', 'int nothing;') })).toEqual([PUT_PLAIN]);
  });

  it('the file holding an instantiation deleted', async () => {
    const before = { ...BASE, 'third.cc': lines('#include "mixin.h"', 'Mixin<FancyTxn> third;') };
    expect(await syncs(before, {}, ['third.cc'])).toEqual([PUT_PLAIN]);
  });

  it('a file holding nothing but an instantiation', async () => {
    const before = {
      ...BASE,
      'bare.hpp': 'int nothing;\n',
      'unit.cc': lines('#include "mixin.h"', '#include "bare.hpp"'),
    };
    expect(await syncs(before, { 'bare.hpp': 'Mixin<FancyTxn> bare;\n' })).toEqual(['FancyTxn::Put', PUT_PLAIN]);
    expect(hasSynthesisPattern('bare.hpp', 'Mixin<FancyTxn> bare;\n')).toBe(true);
  });

  it('a member added to, and removed from, an argument', async () => {
    const before = { ...BASE, 'third.cc': lines('#include "mixin.h"', 'Mixin<NoPutTxn> third;') };
    const withPut = TXN.replace('class NoPutTxn {};', 'class NoPutTxn { public: void Put(int k) {} };');
    expect(await syncs(before, { 'txn.h': withPut })).toEqual(['NoPutTxn::Put', PUT_PLAIN]);
  });

  it('a template edited to call another member', async () => {
    const after = { 'mixin.h': MIXIN.replace('Txn::Commit();', 'Txn::Commit(); Txn::Make();') };
    await syncs(BASE, after);
  });

  it('a typed list edited', async () => {
    const test = (list: string): string => lines(
      '#include <gtest/gtest.h>',
      'struct A { static int Go() { return 1; } };',
      'struct B { static int Go() { return 2; } };',
      'template <typename T> class T1 : public ::testing::Test {};',
      'TYPED_TEST_SUITE(T1, ::testing::Types<A>);',
      'TYPED_TEST(T1, Works) { TypeParam::Go(); }',
    ).replace('Types<A>', `Types<${list}>`);
    const root = project({ 'a_test.cc': test('A') });
    const cg = await opened(root);
    write(root, { 'a_test.cc': test('A, B') });
    await cg.sync();
    const fresh = await indexed({ 'a_test.cc': test('A, B') });
    expect(asText(cg)).toEqual(asText(fresh));
    expect(templateEdges(cg).map((e) => e.target).sort()).toEqual(['A::Go', 'B::Go']);
  });
});

describe('determinism', () => {
  const FILES = {
    'txn.h': TXN,
    'mixin.h': MIXIN,
    'b.cc': lines('#include "mixin.h"', 'Mixin<FancyTxn> b;', 'Mixin<PlainTxn> again;'),
    'a.cc': lines('#include "mixin.h"', 'Mixin<PlainTxn> a;'),
  };

  it('gives the same edges, in the same order, with the resolver pool and without', async () => {
    const before = process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN;
    try {
      process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN = '999999999';
      const sequential = (await indexed(FILES));
      process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN = '0';
      const pooled = (await indexed(FILES));
      expect(templateEdges(pooled)).toEqual(templateEdges(sequential));
      expect(templateEdges(sequential).length).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN;
      else process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN = before;
    }
  });

  it('names the first site by file and line, whichever a run reads first', async () => {
    const cg = await indexed(FILES);
    expect(templateEdges(cg).find((e) => e.target === PUT_PLAIN)?.registeredAt).toBe('a.cc:2');
  });
});

describe('how a hop reads', () => {
  it('says which argument, for which parameter, and where', () => {
    const edge = {
      source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic',
      metadata: { synthesizedBy: 'cpp-template-argument', via: 'Txn', argument: 'PlainTxn', registeredAt: 'use.cc:2' },
    } as unknown as Edge;
    expect(describeSynthesizedHop(edge)).toEqual({ summary: 'template argument `PlainTxn` for `Txn`', detail: '', registeredAt: 'use.cc:2' });
  });

  it('connects a flow through the template in explore', async () => {
    const cg = await indexed({
      'txn.h': TXN,
      'mixin.h': MIXIN,
      'use.cc': lines('#include "mixin.h"', 'void Start() { Mixin<PlainTxn> m; m.Add(1); }'),
    });
    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_explore', { query: 'Start Mixin::Add PlainTxn::Put' });
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('template argument `PlainTxn` for `Txn`');
    expect(text).toContain('use.cc:2');
  });
});
