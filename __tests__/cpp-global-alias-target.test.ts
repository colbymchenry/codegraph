/**
 * A C++ type written from the global scope (`::upb::Arena`) is looked up there
 * alone, also where an alias names it and where a class's base clause or a
 * declaration writes it.
 *
 * protocolbuffers/protobuf's hpb declares `class Arena { … backend::Arena
 * arena_; }`, where `namespace backend = hpb::internal::backend::upb;` and
 * that namespace says `using Arena = ::upb::Arena;`. The alias was looked up
 * as if written `upb::Arena`, from its own namespace, whose nearest `upb` is
 * that namespace itself: the alias named itself, no class was found, and
 * `arena_.Fuse(other.arena_)` fell back to the type's last name, landing on
 * the calling method `hpb::Arena::Fuse`.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-global-alias-'));
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

const UPB_ARENA = lines(
  'namespace upb {',
  'class Arena {',
  ' public:',
  '  bool Fuse(Arena& other) { return true; }',
  '  bool IsFused(Arena& other) const { return false; }',
  '  void RefArena(const Arena& to) {}',
  '};',
  '}  // namespace upb',
);

describe('a C++ alias of a type written from the global scope', () => {
  it('reproduction: protobuf hpb\'s `backend::Arena` is `upb::Arena`, not the calling method\'s own class', async () => {
    const cg = await indexed({
      'upb/mem/arena.hpp': UPB_ARENA,
      'hpb/multibackend.h': lines(
        '#define HPB_INTERNAL_BACKEND_UPB 1',
        '#define HPB_INTERNAL_BACKEND_CPP 2',
        'namespace hpb {',
        'namespace internal {',
        'namespace backend {',
        'namespace upb {}',
        'namespace cpp {}',
        '}  // namespace backend',
        '}  // namespace internal',
        '#if HPB_INTERNAL_BACKEND == HPB_INTERNAL_BACKEND_UPB',
        'namespace backend = hpb::internal::backend::upb;',
        '#elif HPB_INTERNAL_BACKEND == HPB_INTERNAL_BACKEND_CPP',
        'namespace backend = hpb::internal::backend::cpp;',
        '#endif',
        '}  // namespace hpb',
      ),
      'hpb/backend/types.h': lines(
        '#include "hpb/multibackend.h"',
        '#include "upb/mem/arena.hpp"',
        'namespace hpb {',
        'namespace internal {',
        'namespace backend {',
        '#if HPB_INTERNAL_BACKEND == HPB_INTERNAL_BACKEND_UPB',
        'namespace upb {',
        'using Arena = ::upb::Arena;',
        '}',
        '#elif HPB_INTERNAL_BACKEND == HPB_INTERNAL_BACKEND_CPP',
        'namespace cpp {',
        'using Arena = google::protobuf::Arena;',
        '}',
        '#endif',
        '}  // namespace backend',
        '}  // namespace internal',
        '}  // namespace hpb',
      ),
      'hpb/arena.h': lines(
        '#include "hpb/backend/types.h"',
        'namespace hpb {',
        'class Arena {',
        ' public:',
        '  bool Fuse(Arena& other) { return arena_.Fuse(other.arena_); };',
        '  bool IsFused(Arena& other) { return arena_.IsFused(other.arena_); };',
        '  void RefArena(const Arena& to) { arena_.RefArena(to.arena_); }',
        ' private:',
        '  backend::Arena arena_;',
        '};',
        '}  // namespace hpb',
      ),
    });
    try {
      expect(calls(cg, 'hpb::Arena::Fuse')).toEqual(['upb::Arena::Fuse']);
      expect(calls(cg, 'hpb::Arena::IsFused')).toEqual(['upb::Arena::IsFused']);
      expect(calls(cg, 'hpb::Arena::RefArena')).toEqual(['upb::Arena::RefArena']);
    } finally {
      cg.close();
    }
  });

  it('names the global class, not a namesake in the scope around the alias', async () => {
    const cg = await indexed({
      'upb/mem/arena.hpp': UPB_ARENA,
      'hpb/arena.cc': lines(
        '#include "upb/mem/arena.hpp"',
        'namespace hpb {',
        'namespace upb {',
        'class Arena {',
        ' public:',
        '  bool Fuse(Arena& other) { return false; }',
        '};',
        '}  // namespace upb',
        'using GlobalArena = ::upb::Arena;',
        'bool Join(GlobalArena& a, GlobalArena& b) {',
        '  return a.Fuse(b);',
        '}',
        '}  // namespace hpb',
      ),
    });
    try {
      expect(calls(cg, 'hpb::Join')).toEqual(['upb::Arena::Fuse']);
    } finally {
      cg.close();
    }
  });

  it('through an `auto` variable the alias types', async () => {
    const cg = await indexed({
      'upb/mem/arena.hpp': UPB_ARENA,
      'hpb/arena.cc': lines(
        '#include "upb/mem/arena.hpp"',
        'namespace hpb {',
        'namespace upb {',
        'using Arena = ::upb::Arena;',
        '}  // namespace upb',
        'class Arena {',
        ' public:',
        '  bool Fuse(Arena& other) { return false; }',
        '};',
        'upb::Arena MakeArena() { return upb::Arena(); }',
        'bool Join(upb::Arena& other) {',
        '  auto made = MakeArena();',
        '  return made.Fuse(other);',
        '}',
        '}  // namespace hpb',
      ),
    });
    try {
      expect(calls(cg, 'hpb::Join').filter((c) => c.endsWith('::Fuse'))).toEqual(['upb::Arena::Fuse']);
    } finally {
      cg.close();
    }
  });
});

describe('other C++ names written from the global scope', () => {
  it('a base class: `::lib::Options`, not the namespace\'s own `lib::Options`', async () => {
    const cg = await indexed({
      'src/config.cc': lines(
        'namespace app {',
        'struct Inner {',
        '  void Run() {}',
        '};',
        '}  // namespace app',
        'namespace lib {',
        'struct Options {',
        '  struct Inner {',
        '    void Run() {}',
        '  };',
        '};',
        '}  // namespace lib',
        'namespace app {',
        'namespace lib {',
        'struct Options {};',
        '}  // namespace lib',
        'class Config : public ::lib::Options {};',
        'void Use() {',
        '  Config::Inner inner;',
        '  inner.Run();',
        '}',
        '}  // namespace app',
      ),
    });
    try {
      expect(calls(cg, 'app::Use')).toEqual(['lib::Options::Inner::Run']);
    } finally {
      cg.close();
    }
  });
});
