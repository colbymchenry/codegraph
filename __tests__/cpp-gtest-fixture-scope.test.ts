/**
 * A gtest `TEST_F(Fixture, Name) { … }` or `TEST_P` body is a member function
 * of a class derived from its fixture, so an unqualified name in it finds the
 * body's own declarations, then the fixture's members, its bases' included,
 * then the enclosing namespaces'. C++ lookup from the body started at the
 * function and went straight to the namespaces, so facebook/rocksdb's
 * `new TestUserDefinedIndexFactory()`, a class nested in the fixture's base,
 * was found only as the one class of that name the file could see (0.7), and
 * a namespace-level class of the same name won over the fixture's.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-fixture-scope-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** The `instantiates` edges of every function named `name`, by its first line, as `startLine -> qualifiedName @confidence`. */
function made(cg: CodeGraph, name: string): string[] {
  return cg.getNodesByKind('function').filter((n: Node) => n.name === name).sort((a, b) => a.startLine - b.startLine)
    .flatMap((fn) => cg.getOutgoingEdgesFrom([fn.id], ['instantiates'])
      .map((e) => `${fn.startLine} -> ${cg.getNode(e.target)?.qualifiedName} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`));
}

describe('C++ names in a gtest TEST_F or TEST_P body', () => {
  it("find the fixture's nested types, its bases' included", async () => {
    const cg = await indexed({
      'table/table_test.cc': lines(
        'namespace rocksdb {',
        'class UserDefinedIndexTestBase : public testing::Test {',
        ' public:',
        '  class TestUserDefinedIndexFactory {',
        '   public:',
        '    TestUserDefinedIndexFactory() {}',
        '  };',
        '};',
        'class UserDefinedIndexTest : public UserDefinedIndexTestBase {};',
        'TEST_F(UserDefinedIndexTest, Basic) {',
        '  auto factory = new TestUserDefinedIndexFactory();',
        '}',
        'TEST_P(UserDefinedIndexTest, Params) {',
        '  auto factory = new TestUserDefinedIndexFactory();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const nested = 'rocksdb::UserDefinedIndexTestBase::TestUserDefinedIndexFactory @0.9';
      expect(made(cg, 'TEST_F')).toEqual([`10 -> ${nested}`]);
      expect(made(cg, 'TEST_P')).toEqual([`13 -> ${nested}`]);
    } finally {
      cg.close();
    }
  });

  it("find the fixture's type before a namespace's, and the body's own before both", async () => {
    const cg = await indexed({
      'db/db_test.cc': lines(
        'namespace rocksdb {',
        'class Listener {',
        ' public:',
        '  explicit Listener(int n) {}',
        '};',
        'class DBTest : public testing::Test {',
        ' public:',
        '  class Listener {',
        '   public:',
        '    explicit Listener(int n) {}',
        '  };',
        '};',
        'TEST_F(DBTest, Fixture) {',
        '  Listener listener(1);',
        '}',
        'TEST_F(DBTest, Local) {',
        '  class Listener {',
        '   public:',
        '    explicit Listener(int n) {}',
        '  };',
        '  Listener listener(2);',
        '}',
        'TEST(DBPlainTest, NoFixture) {',
        '  Listener listener(3);',
        '}',
        'void Helper() { Listener listener(4); }',
        '}  // namespace rocksdb',
      ),
    });
    try {
      expect(made(cg, 'TEST_F')).toEqual(['13 -> rocksdb::DBTest::Listener @0.9', '16 -> rocksdb::TEST_F::Listener @0.9']);
      expect(made(cg, 'TEST')).toEqual(['23 -> rocksdb::Listener @0.9']);
      expect(made(cg, 'Helper')).toEqual(['26 -> rocksdb::Listener @0.9']);
    } finally {
      cg.close();
    }
  });

  it("call the methods of the body's own local class, not another body's", async () => {
    const cg = await indexed({
      'db/listener_test.cc': lines(
        'namespace rocksdb {',
        'class ListenerTest : public testing::Test {};',
        'TEST_F(ListenerTest, First) {',
        '  class Listener {',
        '   public:',
        '    void Fire() {}',
        '  };',
        '  Listener listener;',
        '  listener.Fire();',
        '}',
        'TEST_F(ListenerTest, Second) {',
        '  class Listener {',
        '   public:',
        '    void Fire() {}',
        '  };',
        '  Listener listener;',
        '  listener.Fire();',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const fired = cg.getNodesByKind('function').filter((n: Node) => n.name === 'TEST_F').sort((a, b) => a.startLine - b.startLine)
        .map((fn) => cg.getOutgoingEdgesFrom([fn.id], ['calls'])
          .map((e) => `${fn.startLine} -> ${cg.getNode(e.target)?.qualifiedName}:${cg.getNode(e.target)?.startLine} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`));
      expect(fired).toEqual([['3 -> rocksdb::TEST_F::Listener::Fire:6 @0.9'], ['11 -> rocksdb::TEST_F::Listener::Fire:14 @0.9']]);
    } finally {
      cg.close();
    }
  });

  it("find the body's own local class from a method of that class", async () => {
    // rocksdb's env_test.cc: two bodies each declare a `CB`, and a static
    // method of the second's calls `cb->Run()` on a `CB*`.
    const cg = await indexed({
      'env/env_test.cc': lines(
        'namespace rocksdb {',
        'class EnvTest : public testing::Test {};',
        'TEST_F(EnvTest, RunMany) {',
        '  struct CB {',
        '    void Run() {}',
        '  };',
        '}',
        'TEST_F(EnvTest, TwoPools) {',
        '  class CB {',
        '   public:',
        '    static void Trampoline(void* v) {',
        '      CB* cb = static_cast<CB*>(v);',
        '      cb->Run();',
        '    }',
        '    void Run() {}',
        '  };',
        '}',
        '}  // namespace rocksdb',
      ),
    });
    try {
      const from = cg.getNodesByKind('method').find((n: Node) => n.name === 'Trampoline')!;
      const calls = cg.getOutgoingEdgesFrom([from.id], ['calls'])
        .map((e) => `${cg.getNode(e.target)?.qualifiedName}:${cg.getNode(e.target)?.startLine} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`);
      expect(calls).toEqual(['rocksdb::TEST_F::CB::Run:15 @0.9']);
    } finally {
      cg.close();
    }
  });
});
