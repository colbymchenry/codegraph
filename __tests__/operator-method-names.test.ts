/**
 * A method whose name is not a plain word: C++'s `operator++` and
 * `operator()`, Scala's `++`, a Kotlin name written in backticks. The
 * resolver writes names into the patterns it reads source with, and these
 * went in as pattern syntax:
 *
 * - `operator++` is "Nothing to repeat". Choosing between a method's
 *   overloads reads the call's argument list after its name, so one
 *   `this->operator++();` inside `operator++(int)` stopped a whole index,
 *   and a sync after an edit, at "Resolving refs" (#2457, #2482, #2636).
 * - `operator()` matched the empty `()` of its own name, so a call to the
 *   two-argument overload read as one with no arguments and stayed linked
 *   to the overload it was written in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** The 1-based line of `text` that contains `needle` (exactly one must). */
const lineOf = (text: string, needle: string): number => {
  const at = text.split('\n').map((l, i) => (l.includes(needle) ? i + 1 : 0)).filter(Boolean);
  if (at.length !== 1) throw new Error(`${JSON.stringify(needle)} is on ${at.length} lines`);
  return at[0]!;
};

const COUNTER_HPP = lines(
  '#pragma once',
  '#include <cstddef>',
  '#include <compare>',
  '',
  'struct Counter {',
  '  int value = 0;',
  '  Counter operator++(int) {',
  '    Counter before = *this;',
  '    this->operator++();',
  '    return before;',
  '  }',
  '  Counter& operator++() {',
  '    ++value;',
  '    return *this;',
  '  }',
  '  Counter& operator+=(int n) {',
  '    value += n;',
  '    return *this;',
  '  }',
  '  Counter& operator+=(const Counter& other) {',
  '    value += other.value;',
  '    return *this;',
  '  }',
  '  auto operator<=>(const Counter& other) const = default;',
  '  explicit operator bool() const { return value != 0; }',
  '};',
  '',
  'struct Scale {',
  '  int operator()(int x) {',
  '    return this->operator()(x, 2);',
  '  }',
  '  int operator()(int x, int factor) {',
  '    return x * factor;',
  '  }',
  '};',
  '',
  'struct Table {',
  '  int cells[8] = {};',
  '  int& operator[](std::size_t i) { return cells[i]; }',
  '};',
  '',
  'struct Pointee {',
  '  int field = 0;',
  '  int read() const { return field; }',
  '};',
  '',
  'struct Handle {',
  '  Pointee* target = nullptr;',
  '  Pointee* operator->() const { return target; }',
  '  int& operator->*(int Pointee::*m) const { return target->*m; }',
  '};',
  '',
  'struct Pool {',
  '  static void* operator new[](std::size_t n);',
  '  static void operator delete(void* p);',
  '  static void operator delete[](void* p);',
  '  static void* grab(std::size_t n) { return Pool::operator new[](n); }',
  '  static void drop(void* p) { Pool::operator delete(p); }',
  '};',
  '',
  'struct Distance { long double km; };',
  'Distance operator"" _km(long double v);',
);

const COUNTER_CPP = lines(
  '#include "counter.hpp"',
  '#include <cstdlib>',
  '',
  'void* Pool::operator new[](std::size_t n) { return std::malloc(n); }',
  'void Pool::operator delete(void* p) { std::free(p); }',
  'void Pool::operator delete[](void* p) { Pool::operator delete(p); }',
  'Distance operator"" _km(long double v) { return Distance{v}; }',
  '',
  'int useAll() {',
  '  Counter c;',
  '  c.operator++();',
  '  c.operator++(0);',
  '  c.operator+=(3);',
  '  Counter d;',
  '  d.operator+=(c);',
  '  bool nonzero = c.operator bool();',
  '  auto order = c.operator<=>(d);',
  '  (void)order;',
  '  Scale s;',
  '  int scaled = s.operator()(4);',
  '  Table t;',
  '  t.operator[](1) = 7;',
  '  Pointee pointee;',
  '  Handle h{&pointee};',
  '  int got = h.operator->()->read() + h.operator->*(&Pointee::field);',
  '  void* arr = Pool::operator new[](32);',
  '  Pool::operator delete[](arr);',
  '  Distance near = operator"" _km(2.0L);',
  '  return scaled + got + (nonzero ? 1 : 0) + static_cast<int>(near.km);',
  '}',
);

describe('a method whose name is not a plain word', () => {
  const roots: string[] = [];
  const graphs: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of graphs.splice(0)) cg.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const project = (files: Record<string, string>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-operator-names-'));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  };

  const index = async (root: string): Promise<CodeGraph> => {
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);
    return cg;
  };

  /** `<qualified name>@<file>:<line>` of each call from the node at `file`:`line`. */
  const callsFrom = (cg: CodeGraph, file: string, line: number): string[] => {
    const from = cg.getNodesInFile(file).find((n: Node) => n.startLine === line && (n.kind === 'method' || n.kind === 'function'));
    expect(from, `${file}:${line}`).toBeDefined();
    return cg.getCallees(from!.id).filter((r) => r.edge.kind === 'calls')
      .map((r) => `${r.node.qualifiedName}@${path.basename(r.node.filePath)}:${r.node.startLine}`)
      .sort();
  };

  const hpp = (needle: string): string => `counter.hpp:${lineOf(COUNTER_HPP, needle)}`;
  const cpp = (needle: string): string => `counter.cpp:${lineOf(COUNTER_CPP, needle)}`;

  it('C++: an index of overloaded operators that call each other by name finishes, and each call reaches its overload', async () => {
    const cg = await index(project({ 'src/counter.hpp': COUNTER_HPP, 'src/counter.cpp': COUNTER_CPP }));

    // `this->operator++();` inside the postfix `operator++(int)`: the prefix one.
    expect(callsFrom(cg, 'src/counter.hpp', lineOf(COUNTER_HPP, 'Counter operator++(int)')))
      .toEqual([`Counter::operator++@${hpp('Counter& operator++()')}`]);
    // `this->operator()(x, 2)` inside the one-argument `operator()`: the two-argument one.
    expect(callsFrom(cg, 'src/counter.hpp', lineOf(COUNTER_HPP, 'int operator()(int x) {')))
      .toEqual([`Scale::operator()@${hpp('int operator()(int x, int factor)')}`]);
    expect(callsFrom(cg, 'src/counter.hpp', lineOf(COUNTER_HPP, 'static void* grab')))
      .toEqual([`Pool::operator new[]@${cpp('void* Pool::operator new[]')}`]);
    expect(callsFrom(cg, 'src/counter.hpp', lineOf(COUNTER_HPP, 'static void drop')))
      .toEqual([`Pool::operator delete@${cpp('void Pool::operator delete(void* p)')}`]);

    const useAll = callsFrom(cg, 'src/counter.cpp', lineOf(COUNTER_CPP, 'int useAll()'));
    expect(useAll).toEqual(expect.arrayContaining([
      `Counter::operator++@${hpp('Counter& operator++()')}`,
      `Counter::operator++@${hpp('Counter operator++(int)')}`,
      `Counter::operator+=@${hpp('Counter& operator+=(int n)')}`,
      `Counter::operator+=@${hpp('Counter& operator+=(const Counter& other)')}`,
      `Counter::operator<=>@${hpp('auto operator<=>')}`,
      `Scale::operator()@${hpp('int operator()(int x) {')}`,
      `Table::operator[]@${hpp('int& operator[]')}`,
      `Handle::operator->@${hpp('Pointee* operator->()')}`,
      `Handle::operator->*@${hpp('int& operator->*')}`,
      `Pool::operator new[]@${cpp('void* Pool::operator new[]')}`,
      `Pool::operator delete[]@${cpp('void Pool::operator delete[]')}`,
      `operator"" _km@${cpp('Distance operator"" _km(long double v) {')}`,
    ]));
  }, 120_000);

  it('C++: a sync that adds such calls to an indexed project finishes, and links them', async () => {
    // Indexed first without a single call of `operator++` by its name.
    const strip = (text: string): string => text
      .replace('    this->operator++();\n', '    ++value;\n')
      .replace('  c.operator++();\n', '')
      .replace('  c.operator++(0);\n', '');
    const root = project({ 'src/counter.hpp': strip(COUNTER_HPP), 'src/counter.cpp': strip(COUNTER_CPP) });
    const cg = await index(root);
    expect(callsFrom(cg, 'src/counter.hpp', lineOf(COUNTER_HPP, 'Counter operator++(int)'))).toEqual([]);

    fs.writeFileSync(path.join(root, 'src/counter.hpp'), COUNTER_HPP);
    fs.writeFileSync(path.join(root, 'src/counter.cpp'), COUNTER_CPP);
    await cg.sync();

    expect(callsFrom(cg, 'src/counter.hpp', lineOf(COUNTER_HPP, 'Counter operator++(int)')))
      .toEqual([`Counter::operator++@${hpp('Counter& operator++()')}`]);
    expect(callsFrom(cg, 'src/counter.cpp', lineOf(COUNTER_CPP, 'int useAll()'))).toEqual(expect.arrayContaining([
      `Counter::operator++@${hpp('Counter& operator++()')}`,
      `Counter::operator++@${hpp('Counter operator++(int)')}`,
    ]));
  }, 120_000);

  it('C++: the argument list of an `operator()` call is the one after the name, not the name\'s own parentheses', async () => {
    // No `operator++` here: nothing threw before, the calls just went to the wrong overloads.
    const hppText = lines(
      'struct Scale {',
      '  int operator()(int x) { return this->operator()(x, 2); }',
      '  int operator()(int x, int factor) { return x * factor; }',
      '};',
      'struct Total {',
      '  int value = 0;',
      '  Total& operator+=(int n) { value += n; return *this; }',
      '  Total& operator+=(const Total& other) { value += other.value; return *this; }',
      '};',
    );
    const cppText = lines(
      '#include "scale.hpp"',
      'int addUp() {',
      '  Total a;',
      '  Total b;',
      '  b.operator+=(a);',
      '  return b.value;',
      '}',
    );
    const cg = await index(project({ 'src/scale.hpp': hppText, 'src/scale.cpp': cppText }));
    expect(callsFrom(cg, 'src/scale.hpp', lineOf(hppText, 'int operator()(int x) {')))
      .toEqual([`Scale::operator()@scale.hpp:${lineOf(hppText, 'int operator()(int x, int factor)')}`]);
    expect(callsFrom(cg, 'src/scale.cpp', lineOf(cppText, 'int addUp()')))
      .toEqual([`Total::operator+=@scale.hpp:${lineOf(hppText, 'Total& operator+=(const Total& other)')}`]);
  }, 120_000);

  it('C++: `operator[](0)` still reaches the `size_type` overload, now that its arguments are read', async () => {
    // nlohmann/json's `p = &p->operator[](0);`: the index overload, as before, not the C-string key one.
    // A container's `size_type` is a number, which a `0` fits better than it fits a pointer.
    const hppText = lines(
      'struct Json {',
      '  using size_type = unsigned long;',
      '  Json& operator[](size_type idx) { return *this; }',
      '  template <typename T>',
      '  JSON_NON_NULL(2)',
      '  Json& operator[](T* key) { return *this; }',
      '};',
      'Json* walk(Json* p) { return &p->operator[](0); }',
    );
    const cg = await index(project({ 'src/json.hpp': hppText }));
    expect(callsFrom(cg, 'src/json.hpp', lineOf(hppText, 'Json* walk(')))
      .toEqual([`Json::operator[]@json.hpp:${lineOf(hppText, 'operator[](size_type idx)')}`]);
  }, 120_000);

  it('Scala and Kotlin: overloads named `++` or in backticks no longer stop the index', async () => {
    const scala = lines(
      'class Vec(val x: Int) {',
      '  def ++(o: Vec): Vec = new Vec(x + o.x)',
      '  def ++(n: Int, m: Int): Vec = this.++(new Vec(n + m))',
      '  def twice: Vec = this.++(1, 2)',
      '}',
    );
    const kotlin = lines(
      'class Weird {',
      '  fun `reads (a value`(x: Int): Int = x',
      '  fun `reads (a value`(x: Int, y: Int): Int = `reads (a value`(x + y)',
      '  fun use(): Int = `reads (a value`(1, 2)',
      '}',
    );
    const cg = await index(project({ 'src/Vec.scala': scala, 'src/Weird.kt': kotlin }));
    expect(callsFrom(cg, 'src/Vec.scala', lineOf(scala, 'def twice'))).toEqual([`Vec::++@Vec.scala:${lineOf(scala, 'def ++(n: Int, m: Int)')}`]);
    expect(callsFrom(cg, 'src/Weird.kt', lineOf(kotlin, 'fun use()'))).toEqual([`Weird::\`reads (a value\`@Weird.kt:${lineOf(kotlin, 'x: Int, y: Int')}`]);
  }, 120_000);
});
