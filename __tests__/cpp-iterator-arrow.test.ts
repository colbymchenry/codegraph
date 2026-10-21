/**
 * A `->` call on a C++ receiver declared as a container's iterator, like
 * `std::deque<Slice>::const_iterator it; it->data()`, calls a member of the
 * container's element, as `->` on a smart pointer calls one of what it
 * holds. The call was matched by the method's name alone, so it could reach
 * any class with a method of that name.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-iterator-arrow-'));
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

/** `calls` callees of a function or method, as `qualifiedName`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => r.node.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a `->` call on a C++ receiver declared as a container\'s iterator', () => {
  it('reproduction: `std::deque<Slice>::const_iterator it; it->data()` calls the element\'s method', async () => {
    const cg = await indexed({
      'util/buffer.h': lines(
        'class Buffer {',
        ' public:',
        '  const char* data() const { return nullptr; }',
        '};',
      ),
      'include/slice.h': lines(
        'class Slice {',
        ' public:',
        '  const char* data() const { return nullptr; }',
        '};',
      ),
      'util/append.cc': lines(
        '#include <deque>',
        '#include "util/buffer.h"',
        '#include "include/slice.h"',
        'void Append(const std::deque<Slice>& operands) {',
        '  for (std::deque<Slice>::const_iterator it = operands.begin(); it != operands.end(); ++it) {',
        '    it->data();',
        '  }',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Append')).toEqual(['Slice::data']);
    } finally {
      cg.close();
    }
  });

  it('an element of a library type has no project method to call', async () => {
    const cg = await indexed({
      'util/name.h': lines(
        'class Name {',
        ' public:',
        '  const char* c_str() const { return nullptr; }',
        '};',
      ),
      'tools/print.cc': lines(
        '#include <string>',
        '#include <vector>',
        '#include "util/name.h"',
        'void Print(const std::vector<std::string>& names) {',
        '  for (std::vector<std::string>::const_iterator itr = names.begin(); itr != names.end(); ++itr) {',
        '    itr->c_str();',
        '  }',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Print')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('the iterator a project container\'s own alias names: protobuf\'s `RepeatedPtrField<T>::iterator`', async () => {
    const cg = await indexed({
      'src/repeated_ptr_field.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'namespace internal {',
        'template <typename Element>',
        'class RepeatedPtrIterator {',
        ' public:',
        '  Element& operator*() const { return *it_; }',
        '  Element* operator->() const { return it_; }',
        ' private:',
        '  Element* it_;',
        '};',
        '}  // namespace internal',
        'template <typename Element>',
        'class RepeatedPtrField {',
        ' public:',
        '  typedef internal::RepeatedPtrIterator<Element> iterator;',
        '  iterator begin() { return iterator(); }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/descriptor.pb.h': lines(
        'namespace google {',
        'namespace protobuf {',
        'class FileDescriptorProto {',
        ' public:',
        '  int path_size() const { return 1; }',
        '};',
        'class SourceCodeInfo_Location {',
        ' public:',
        '  int path_size() const { return 0; }',
        '};',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'src/option_interpreter.cc': lines(
        '#include "src/repeated_ptr_field.h"',
        '#include "src/descriptor.pb.h"',
        'namespace google {',
        'namespace protobuf {',
        'int Count(RepeatedPtrField<SourceCodeInfo_Location>* locs) {',
        '  RepeatedPtrField<SourceCodeInfo_Location>::iterator loc = locs->begin();',
        '  return loc->path_size();',
        '}',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      expect(calls(cg, 'google::protobuf::Count')).toEqual([
        'google::protobuf::RepeatedPtrField::begin',
        'google::protobuf::SourceCodeInfo_Location::path_size',
      ]);
    } finally {
      cg.close();
    }
  });

  it('an element of the calling template\'s own parameter names no particular class', async () => {
    const cg = await indexed({
      'src/visit.cc': lines(
        '#include <vector>',
        'class Node {',
        ' public:',
        '  void Visit() {}',
        '};',
        'template <typename T>',
        'void VisitAll(typename std::vector<T>::iterator it) {',
        '  it->Visit();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'VisitAll')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('an element only a class template\'s own `operator*` names goes on as before', async () => {
    const cg = await indexed({
      'gtest/param.h': lines(
        'template <typename T>',
        'class ParamIterator {',
        ' public:',
        '  const T& operator*() const { return *value_; }',
        '  const T* operator->() const { return value_; }',
        ' private:',
        '  const T* value_;',
        '};',
        'template <typename T>',
        'class ParamGenerator {',
        ' public:',
        '  typedef ParamIterator<T> iterator;',
        '  iterator begin() const { return iterator(); }',
        '};',
      ),
      'gtest/run.cc': lines(
        '#include "gtest/param.h"',
        'class Case {',
        ' public:',
        '  void Run() const {}',
        '};',
        'void RunAll(const ParamGenerator<Case>& gen) {',
        '  ParamGenerator<Case>::iterator it = gen.begin();',
        '  it->Run();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'RunAll')).toEqual(['Case::Run', 'ParamGenerator::begin']);
    } finally {
      cg.close();
    }
  });
});
