/**
 * A C++ call written with no receiver, or on `this`, inside a member function
 * is a call on the function's object: C++ looks the name up in the function's
 * class, then in the classes it derives from, then in the classes it is nested
 * in, and only then at namespace scope. The resolver matched it by name alone,
 * so a same-named member of another class won by file proximity:
 * - protobuf's generated `Api::operator=` calling `InternalSwap(&from)` went to
 *   `Any::InternalSwap`, in every generated message class;
 * - `Any::InternalSwap` calling the `GetArena()` it inherits from `MessageLite`
 *   went to `Arena::InternalHelper::GetArena`;
 * - googletest's `~linked_ptr() { depart(); }` (vendored in rocksdb) went to
 *   `linked_ptr_internal::depart`, declared just above it.
 * Nothing changes for a call the lookup can't place: a free function's, one
 * through a receiver the extractor dropped, one naming a parameter, or one
 * into a base that depends on a template parameter.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

function writeProject(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** The edges carrying a call's name out of the function or method `qualifiedName` in `file`. */
function callEdgesFrom(cg: CodeGraph, file: string, qualifiedName: string) {
  const from = cg.getNodesInFile(file).filter((n) => n.qualifiedName === qualifiedName && (n.kind === 'function' || n.kind === 'method'));
  expect(from.length).toBeGreaterThan(0);
  return cg.getOutgoingEdgesFrom(from.map((n) => n.id)).flatMap((e) => {
    const metadata = e.metadata as { refName?: string; resolvedBy?: string } | undefined;
    return metadata?.refName ? [{ refName: metadata.refName, resolvedBy: metadata.resolvedBy, target: cg.getNode(e.target)!.qualifiedName }] : [];
  });
}

/** `name -> target qualified name` for each call (or construction) the named function or method in `file` makes. */
function callsFrom(cg: CodeGraph, file: string, qualifiedName: string): string[] {
  return callEdgesFrom(cg, file, qualifiedName).map((e) => `${e.refName} -> ${e.target}`).sort();
}

/** Whether C++ name lookup from the calling function (not a guess by name) placed the call `refName`. */
function placedByLookup(cg: CodeGraph, file: string, qualifiedName: string, refName: string): boolean {
  return callEdgesFrom(cg, file, qualifiedName).some((e) => e.refName === refName && e.resolvedBy === 'instance-method');
}

const MESSAGE_LITE = `#pragma once
namespace pb {
class Arena {
 public:
  class InternalHelper {
   public:
    static Arena* GetArena(const void* object) { return nullptr; }
  };
};

class MessageLite {
 public:
  Arena* GetArena() const { return arena_; }
  void Clear() {}

 private:
  Arena* arena_ = nullptr;
};

class Message : public MessageLite {};
}  // namespace pb
`;

// Two generated message classes, each defining InternalSwap out of line;
// Any's comes first in the index.
const ANY_H = `#pragma once
#include "pb/message.h"
namespace pb {
class Any final : public Message {
 public:
  Any& operator=(Any&& from) noexcept {
    InternalSwap(&from);
    return *this;
  }
  void InternalSwap(Any* other);
};
}  // namespace pb
`;

const API_H = `#pragma once
#include "pb/message.h"
namespace pb {
class Api final : public Message {
 public:
  Api& operator=(Api&& from) noexcept {
    InternalSwap(&from);
    return *this;
  }
  void Swap(Api* other) {
    if (other == this) return;
    this->InternalSwap(other);
  }
  void InternalSwap(Api* other);
};
}  // namespace pb
`;

describe('C++ calls on the calling function’s own object', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-this-', {
      'src/pb/message.h': MESSAGE_LITE,
      'src/pb/any.pb.h': ANY_H,
      'src/pb/any.pb.cc': `#include "pb/any.pb.h"
namespace pb {
void Any::InternalSwap(Any* other) {
  auto* arena = GetArena();
  (void)arena;
}
}  // namespace pb
`,
      'src/pb/api.pb.h': API_H,
      'src/pb/api.pb.cc': `#include "pb/api.pb.h"
namespace pb {
void Api::InternalSwap(Api* other) {
  (*this).Clear();
}
}  // namespace pb
`,
      'third_party/gtest/linked_ptr.h': `#pragma once
namespace testing {
namespace internal {
class linked_ptr_internal {
 public:
  bool depart() { return next_ == this; }

 private:
  mutable linked_ptr_internal const* next_;
};

template <typename T>
class linked_ptr {
 public:
  ~linked_ptr() { depart(); }
  void reset(T* ptr = nullptr) {
    depart();
    value_ = ptr;
  }

  T* get() const { return value_; }
  T* operator->() const { return value_; }
  T& operator*() const { return *value_; }

  bool operator==(T* p) const { return value_ == p; }
  bool operator!=(T* p) const { return value_ != p; }

  template <typename U>
  bool operator==(linked_ptr<U> const& ptr) const {
    return value_ == ptr.get();
  }
  template <typename U>
  bool operator!=(linked_ptr<U> const& ptr) const {
    return value_ != ptr.get();
  }

 private:
  template <typename U>
  friend class linked_ptr;

  // Takes ownership of p, which must be the only linked_ptr to it:
  // the link starts out as a one-element ring.
  void capture(T* p) {
    value_ = p;
  }

  // Joins the ring another linked_ptr belongs to, sharing what it points to.
  template <typename U>
  void copy(linked_ptr<U> const* ptr) {
    value_ = ptr->get();
  }

  // Leaves the ring; the last one out deletes the object.
  void depart() {
    if (link_.depart()) delete value_;
  }

  T* value_;
  linked_ptr_internal link_;
};
}  // namespace internal
}  // namespace testing
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('links a bare call to the calling class’s own method, not another class’s namesake', () => {
    expect(callsFrom(cg, 'src/pb/api.pb.h', 'pb::Api::operator=')).toEqual(['InternalSwap -> pb::Api::InternalSwap']);
    expect(callsFrom(cg, 'src/pb/any.pb.h', 'pb::Any::operator=')).toEqual(['InternalSwap -> pb::Any::InternalSwap']);
  });

  it('links a call on `this->` or `(*this).` the same way', () => {
    expect(callsFrom(cg, 'src/pb/api.pb.h', 'pb::Api::Swap')).toEqual(['InternalSwap -> pb::Api::InternalSwap']);
    expect(callsFrom(cg, 'src/pb/api.pb.cc', 'pb::Api::InternalSwap')).toEqual(['Clear -> pb::MessageLite::Clear']);
  });

  it('links a method the class inherits, through its own base classes', () => {
    expect(callsFrom(cg, 'src/pb/any.pb.cc', 'pb::Any::InternalSwap')).toEqual(['GetArena -> pb::MessageLite::GetArena']);
  });

  it('prefers the class’s own method over a namesake declared nearer the call', () => {
    expect(callsFrom(cg, 'third_party/gtest/linked_ptr.h', 'testing::internal::linked_ptr::~linked_ptr'))
      .toEqual(['depart -> testing::internal::linked_ptr::depart']);
    expect(callsFrom(cg, 'third_party/gtest/linked_ptr.h', 'testing::internal::linked_ptr::reset'))
      .toEqual(['depart -> testing::internal::linked_ptr::depart']);
  });
});

describe('C++ name lookup from a member function', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-this-scopes-', {
      'src/db/db.h': `#pragma once
#include <functional>
namespace db {
class Stats {
 public:
  static int Count() { return 1; }
};

class Table {
 public:
  static int Count();
  void Flush();
  void Compact();
  void Reset() {}
  void Close() {}
  void OnDone(std::function<void()> Close) { Close(); }

  class Builder {
   public:
    int Size() const { return Count(); }
  };
};

struct Item {
  void Clear() {}
};
}  // namespace db
`,
      'src/db/table.cc': `#include "db/db.h"
namespace db {
static void Reset() {}
static void Trim() {}

class Job {
 public:
  void Compact() {}
};

void Table::Flush() {
  Reset();
  Trim();
  auto finish = [this]() { Compact(); };
  finish();
}

void Rebuild() {
  Trim();
  Reset();
}
}  // namespace db
`,
      'src/db/compact.cc': `#include "db/db.h"
namespace db {
int Table::Count() { return 0; }

void Table::Compact() {
  Item items[2];
  items[0].Clear();
}
}  // namespace db
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('takes the class’s member over a file-static function of its name, and the function when the class has none', () => {
    const calls = callsFrom(cg, 'src/db/table.cc', 'db::Table::Flush');
    expect(calls).toContain('Reset -> db::Table::Reset');
    expect(calls).toContain('Trim -> db::Trim');
  });

  it('links a bare call in a lambda to the member function’s class', () => {
    expect(callsFrom(cg, 'src/db/table.cc', 'db::Table::Flush')).toContain('Compact -> db::Table::Compact');
  });

  it('links a nested class’s bare call to the enclosing class’s static member', () => {
    expect(callsFrom(cg, 'src/db/db.h', 'db::Table::Builder::Size')).toEqual(['Count -> db::Table::Count']);
  });

  it('leaves a free function, static or not, to find what its namespace declares', () => {
    expect(callsFrom(cg, 'src/db/table.cc', 'db::Rebuild')).toEqual(['Reset -> db::Reset', 'Trim -> db::Trim']);
  });

  it('never takes a receiver the extractor dropped for the calling object', () => {
    expect(callsFrom(cg, 'src/db/compact.cc', 'db::Table::Compact')).toEqual(['Clear -> db::Item::Clear']);
  });

  it('does not take a parameter named like a member for the member', () => {
    expect(placedByLookup(cg, 'src/db/db.h', 'db::Table::OnDone', 'Close')).toBe(false);
  });
});

describe('C++ overloads a call’s arguments pick', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-this-overloads-', {
      'include/opts/configurable.h': `#pragma once
#include <string>
namespace opts {
class Configurable {
 public:
  template <typename T>
  void RegisterOptions(T* opt_ptr, const int* opt_map) {
    RegisterOptions(T::kClassName(), opt_ptr, opt_map);
  }
  void RegisterOptions(const std::string& name, void* opt_ptr, const int* opt_map);

  void Add(int key) { Add(key, 1); }
  void Add(int key, int count);
};
}  // namespace opts
`,
      'src/opts/configurable.cc': `#include "opts/configurable.h"
namespace opts {
void Configurable::RegisterOptions(const std::string& name, void* opt_ptr, const int* opt_map) {}
void Configurable::Add(int key, int count) {}
}  // namespace opts
`,
      'test/simple.cc': `#include "opts/configurable.h"
namespace opts {
class SimpleConfigurable : public Configurable {
 public:
  SimpleConfigurable() {
    RegisterOptions(std::string("Simple") + "Unique", &unique_, &info_);
  }

 private:
  int unique_ = 0;
  int info_ = 0;
};
}  // namespace opts
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('takes the inherited overload the arguments fit', () => {
    // Both overloads are `opts::Configurable::RegisterOptions`: the three-parameter one is defined in the .cc.
    const threeParameters = cg.getNodesInFile('src/opts/configurable.cc').find((n) => n.name === 'RegisterOptions');
    const ctor = cg.getNodesInFile('test/simple.cc').find((n) => n.qualifiedName === 'opts::SimpleConfigurable::SimpleConfigurable');
    const edge = cg.getOutgoingEdges(ctor!.id).find((e) => (e.metadata as { refName?: string } | undefined)?.refName === 'RegisterOptions');
    expect(edge?.target).toBe(threeParameters?.id);
  });

  it('weighs a class’s out-of-line overloads with its inline ones', () => {
    const add = cg.getNodesInFile('include/opts/configurable.h').find((n) => n.name === 'Add');
    const outOfLine = cg.getNodesInFile('src/opts/configurable.cc').find((n) => n.name === 'Add');
    const edge = cg.getOutgoingEdges(add!.id).find((e) => (e.metadata as { refName?: string } | undefined)?.refName === 'Add');
    expect(edge?.target).toBe(outOfLine?.id);
  });
});

describe('C++ classes the index can only see part of', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-this-partial-', {
      // Two translation units each declare a `FileState` of their own.
      'helpers/memenv.cc': `namespace kv {
namespace {
class FileState {
 public:
  void Truncate() {}
  ~FileState() { Truncate(); }
};
}  // namespace
}  // namespace kv
`,
      'db/fault_injection_test.cc': `namespace kv {
namespace {
int Truncate(const char* name, long length) { return 0; }

struct FileState {
  const char* filename_;
  long pos_;
  int DropUnsyncedData() const;
};
}  // namespace

int FileState::DropUnsyncedData() const {
  return Truncate(filename_, pos_);
}
}  // namespace kv
`,
      'src/reflection.cc': `#define LOCAL_VAR_ACCESSOR(type, name) \\
  type Get##name() const { return value; }

namespace pb {
class Message {};

class Reflection {
 public:
  Message* GetMessage() const { return nullptr; }
  void SwapField() const;
};

void Reflection::SwapField() const {
  struct LocalVarWrapper {
    LOCAL_VAR_ACCESSOR(Message*, Message);
    Message* UnsafeGetMessage() const { return GetMessage(); }
    Message* value;
  };
}
}  // namespace pb
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('never lends one translation unit’s class members to another’s class of the same name', () => {
    expect(callsFrom(cg, 'helpers/memenv.cc', 'kv::FileState::~FileState')).toEqual(['Truncate -> kv::FileState::Truncate']);
    expect(placedByLookup(cg, 'db/fault_injection_test.cc', 'kv::FileState::DropUnsyncedData', 'Truncate')).toBe(false);
    expect(callsFrom(cg, 'db/fault_injection_test.cc', 'kv::FileState::DropUnsyncedData')).not.toContain('Truncate -> kv::FileState::Truncate');
  });

  it('stops at a class whose macro may declare the name, rather than take an outer class’s', () => {
    const wrapper = cg.getNodesInFile('src/reflection.cc').find((n) => n.name === 'UnsafeGetMessage');
    expect(wrapper).toBeDefined();
    expect(placedByLookup(cg, 'src/reflection.cc', wrapper!.qualifiedName, 'GetMessage')).toBe(false);
  });
});

describe('C++ name lookup in a class template', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-cpp-this-template-', {
      'src/util/list.h': `#pragma once
namespace util {
template <typename T>
class ListBase {
 public:
  void Grow(int n) {}
  void Shrink() {}
};

inline void Grow(int n) {}

template <typename T>
class List : public ListBase<T> {
 public:
  void Push() {
    Grow(1);
    this->Shrink();
  }
};

class IntList : public ListBase<int> {
 public:
  void Push() { Grow(1); }
};
}  // namespace util
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('looks a bare name up in a base that depends on a template parameter only when written `this->`', () => {
    expect(callsFrom(cg, 'src/util/list.h', 'util::List::Push')).toContain('Shrink -> util::ListBase::Shrink');
    expect(placedByLookup(cg, 'src/util/list.h', 'util::List::Push', 'Shrink')).toBe(true);
    // `ListBase<T>` is not searched for a bare `Grow(1)`: C++ finds the namespace's `util::Grow`.
    expect(placedByLookup(cg, 'src/util/list.h', 'util::List::Push', 'Grow')).toBe(false);
  });

  it('looks it up in a base with no template parameter of the class in it', () => {
    expect(callsFrom(cg, 'src/util/list.h', 'util::IntList::Push')).toEqual(['Grow -> util::ListBase::Grow']);
  });
});
