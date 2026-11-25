/**
 * A C++ call written by its bare name, `format(…)`, on a name the calling
 * function binds itself — a parameter, a lambda's parameter, a local lambda or
 * functor, a range-`for` variable — calls that local. C++ lookup finds the
 * local before any function or method of that name, so no project function or
 * method is what it calls.
 *
 * protocolbuffers/protobuf's code generators take a `const Formatter& format`
 * and call `format("…")`. The call went to the one other `format` the project
 * has, the conformance suite's `TestResult::format`, by name. facebook/rocksdb's
 * tests call local lambdas, `auto key = [](int i) {…};` then `key(10)`, and
 * those went to `ArenaWrappedDBIter::key`.
 *
 * A name the function declares as a function (`void helper(int);`) or a type
 * still links as before, and so does a local whose block closed before the
 * call, or an expression that only reads like a declaration (`!force &&
 * MaybeInsertDummy(key)`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-local-callable-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function callable(cg: CodeGraph, qualifiedName: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, constructors aside, as `qualifiedName`, one per callee. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .filter((r) => {
      const [owner, name] = r.node.qualifiedName.split('::').slice(-2);
      return owner !== name;
    })
    .map((r) => r.node.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** The project's other `format`, `key`, `append`, `fn` and `Value`: what a call on the local could be mistaken for. */
const ELSEWHERE = {
  'conformance/testee.h': lines(
    'namespace conformance {',
    'class TestResult {',
    ' public:',
    '  int format() const { return 0; }',
    '};',
    'class Iterator {',
    ' public:',
    '  int key() const { return 1; }',
    '};',
    'class LeftoverBuffer {',
    ' public:',
    '  void append(const char* s) {}',
    '};',
    'class Runner {',
    ' public:',
    '  void fn() {}',
    '};',
    '}  // namespace conformance',
  ),
};

describe('a C++ bare call on a name the calling function binds', () => {
  it('reproduction: protobuf\'s `format(…)` on a `const Formatter& format` parameter is no TestResult::format', async () => {
    const cg = await indexed({
      ...ELSEWHERE,
      'compiler/cpp/message.cc': lines(
        '#include <string>',
        'namespace compiler {',
        'class Formatter {',
        ' public:',
        '  void operator()(const char* text) const {}',
        '};',
        'class MessageGenerator {',
        ' public:',
        '  void GenerateFieldNames(const Formatter& format);',
        '};',
        'void MessageGenerator::GenerateFieldNames(const Formatter& format) {',
        '  format("static const char kNames[] = {");',
        '  format("};");',
        '}',
        '}  // namespace compiler',
      ),
    });
    try {
      expect(calls(cg, 'compiler::MessageGenerator::GenerateFieldNames')).toEqual([]);
      expect(cg.getCallers(callable(cg, 'conformance::TestResult::format').id).filter((r) => r.edge.kind === 'calls')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a local lambda, a local functor, a lambda\'s parameter and a range-for variable', async () => {
    const cg = await indexed({
      ...ELSEWHERE,
      'db/iter_test.cc': lines(
        '#include <functional>',
        '#include <string>',
        '#include <vector>',
        'namespace db {',
        'class Formatter {',
        ' public:',
        '  explicit Formatter(int indent) {}',
        '  void operator()(const char* text) const {}',
        '};',
        'int Lambda() {',
        '  auto key = [](int i) { return i * 2; };',
        '  return key(10) + key(90);',
        '}',
        'void Functor(int indent) {',
        '  Formatter format(indent);',
        '  format("x");',
        '}',
        'void LambdaParameter(const std::function<void(std::function<void(const char*)>)>& with) {',
        '  with([&](auto append) {',
        '    append("tail");',
        '  });',
        '}',
        'void Loop(const std::vector<std::function<void()>>& callbacks) {',
        '  for (auto& fn : callbacks) fn();',
        '}',
        '}  // namespace db',
      ),
    });
    try {
      expect(calls(cg, 'db::Lambda')).toEqual([]);
      expect(calls(cg, 'db::Functor')).toEqual([]);
      expect(calls(cg, 'db::LambdaParameter')).toEqual([]);
      expect(calls(cg, 'db::Loop')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a function the body declares, a local out of scope and an expression still link', async () => {
    const cg = await indexed({
      'cache/helpers.h': lines(
        'namespace cache {',
        'int helper(int n);',
        'int key(int i);',
        '}  // namespace cache',
      ),
      'cache/helpers.cc': lines(
        '#include "cache/helpers.h"',
        'namespace cache {',
        'int helper(int n) { return n; }',
        'int key(int i) { return i; }',
        '}  // namespace cache',
      ),
      'cache/secondary_cache.cc': lines(
        '#include "cache/helpers.h"',
        'namespace cache {',
        'int Declared() {',
        '  int helper(int n);',
        '  return helper(1);',
        '}',
        'int OutOfScope(bool shadow) {',
        '  if (shadow) {',
        '    auto key = [](int i) { return -i; };',
        '    return key(1);',
        '  }',
        '  return key(2);',
        '}',
        'class SecondaryCache {',
        ' public:',
        '  bool Insert(int k, bool force_insert);',
        '  bool MaybeInsertDummy(int k) { return k > 0; }',
        '};',
        'bool SecondaryCache::Insert(int k, bool force_insert) {',
        '  if (!force_insert && MaybeInsertDummy(k)) {',
        '    return false;',
        '  }',
        '  return true;',
        '}',
        '}  // namespace cache',
      ),
    });
    try {
      expect(calls(cg, 'cache::Declared')).toEqual(['cache::helper']);
      expect(calls(cg, 'cache::OutOfScope')).toEqual(['cache::key']);
      expect(calls(cg, 'cache::SecondaryCache::Insert')).toEqual(['cache::SecondaryCache::MaybeInsertDummy']);
    } finally {
      cg.close();
    }
  });
});
