/**
 * A C++ call on a data member reached through a member chain, like rocksdb's
 * `options.cf_paths.emplace_back(…)` on a `std::vector<DbPath>` or
 * `props->rep.db_id.size()` on a `std::string`, calls the library type's own
 * method, none of the project's. The extractor records such a call by its
 * bare name, so it went to any project method of that name: rocksdb's
 * `autovector::emplace_back`, `BlobContents::size`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C++ call on a member chain of a type from outside the project', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-member-chain-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // The project's namesakes of library methods, which a call matched by its bare name lands on.
    write('src/types.h', lines(
      'namespace rocksdb {',
      'template <class T, int kSize = 8>',
      'class autovector {',
      ' public:',
      '  void emplace_back(T v) {}',
      '  void clear() {}',
      '  int size() const { return 0; }',
      '};',
      'class BlobContents {',
      ' public:',
      '  int size() const { return 0; }',
      '};',
      '}  // namespace rocksdb',
      'namespace proto {',
      'class Option {',
      ' public:',
      '  bool has_value() const { return false; }',
      '};',
      '}  // namespace proto',
      'namespace util {',
      'class Status {',
      ' public:',
      '  bool ok() const { return true; }',
      '};',
      '}  // namespace util',
      'class FilePtr {',
      ' public:',
      '  void reset() {}',
      '};',
      'class Engine {',
      ' public:',
      '  void Run() {}',
      '};',
    ));
    write('src/use.cc', lines(
      '#include <memory>',
      '#include <optional>',
      '#include <string>',
      '#include <vector>',
      '#include "absl/status/status.h"',
      '#include "src/types.h"',
      'struct Options {',
      '  std::vector<int> cf_paths;',
      '  std::string name;',
      '};',
      'struct Rep {',
      '  std::string db_id;',
      '};',
      'struct Props {',
      '  Rep rep;',
      '};',
      'struct State {',
      '  std::optional<int> child_pid;',
      '  std::shared_ptr<Engine> engine;',
      '  Engine plain;',
      '  absl::Status status;',
      '};',
      'void Library(Options& options) { options.cf_paths.emplace_back(1); options.name.size(); }',
      'void TwoHops(Props* props) { props->rep.db_id.size(); }',
      'void Optional(State* state) { state->child_pid.has_value(); }',
      'void HolderOwn(State& state) { state.engine.reset(); }',
      'void OutsideQualified(State& state) { state.status.ok(); }',
      'void HolderArrow(State& state) { state.engine->Run(); }',
      'void ProjectMember(State& state) { state.plain.Run(); }',
      'class Cache {',
      ' public:',
      '  void Touch() { this->keys_.clear(); this->engine_->Run(); }',
      ' private:',
      '  std::vector<int> keys_;',
      '  Engine* engine_;',
      '};',
      'template <class T>',
      'struct Box {',
      '  std::vector<T> items;',
      '  std::unique_ptr<T> owner;',
      '};',
      'template <class T>',
      'void Drain(Box<T>& box) { box.items.clear(); box.owner.reset(); }',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `calls` callees of the function or method `name`, as `qualifiedName`. */
  const calls = (name: string): string[] => {
    const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find((n: Node) => n.name === name);
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller!.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.qualifiedName).sort();
  };

  it("a library container's or string's method reached through a member", () => {
    expect(calls('Library')).toEqual([]);
    expect(calls('TwoHops')).toEqual([]);
  });

  it("an optional's method, and a smart pointer's own through `.`", () => {
    expect(calls('Optional')).toEqual([]);
    expect(calls('HolderOwn')).toEqual([]);
  });

  it('a type under a namespace the project declares nothing in', () => {
    expect(calls('OutsideQualified')).toEqual([]);
  });

  it("`->` on a smart pointer, and a member of a project class's type, still call the project's", () => {
    expect(calls('HolderArrow')).toEqual(['Engine::Run']);
    expect(calls('ProjectMember')).toEqual(['Engine::Run']);
  });

  it('a chain through `this`', () => {
    expect(calls('Touch')).toEqual(['Engine::Run']);
  });

  it("a library template of a template parameter's type is still the library's", () => {
    expect(calls('Drain')).toEqual([]);
  });
});
