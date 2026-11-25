/**
 * A C or C++ struct/class member whose declarator is a pointer, reference,
 * array or function was recorded as an `extends` edge to the member's type:
 *
 *   struct ThreadState { SharedState* shared; };    // ThreadState extends SharedState
 *   typedef struct { int length; jv elements[]; } jvp_array;   // jvp_array extends jv
 *   class DB { virtual Status Put(const Slice& k) = 0; };      // DB extends Status
 *
 * Both extractors carried Go's struct-embedding check (`type DB struct { *Head }`
 * — a `field_declaration` with no `field_identifier` names an embedded type)
 * and ran it for every grammar with a `field_declaration_list`. tree-sitter-c
 * and -cpp, and the C structs of Objective-C, nest the member's name inside
 * its declarator, so every such member looked embedded and its type showed up
 * as a supertype: in the type hierarchy, the "extends" chips, blast radius
 * and codegraph_explore. google/leveldb had 246 of its 302 `extends` edges
 * from members.
 *
 * Embedding is Go's alone, so the check now runs for Go only. C++ base
 * classes and Objective-C superclasses come from their own clauses and are
 * untouched. Runs against the native kernel (when built) and the wasm
 * extractor, which must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import type { ExtractionResult, Language, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

/** jqlang/jq's shapes: flexible and fixed arrays, pointers, function pointers in a union. */
const C_SOURCE = `typedef struct { int refcnt; } jv;
typedef struct jq_state jq_state;
typedef struct { int length; jv elements[]; } jvp_array;
struct jv_parser {
  jv* stack;
  jv next[2];
  jv value;
  int stackpos;
};
union cfunction {
  jv (*a1)(jq_state *, jv);
  jv (*a2)(jq_state *, jv, jv);
};
struct node {
  struct node *next;
  const jv *const *table;
};
`;

/** google/leveldb's shapes, plus base classes that must survive, one on a later line. */
const CPP_SOURCE = `class Cache {};
class DB {};
class Status {};
class Slice {};
struct SharedState { int total; };
struct ThreadState {
  SharedState* shared;
  const Cache& cache;
  Cache shards[4];
  Status (*hook)(int);
};
class Benchmark {
 public:
  Status Open(int k);
  virtual Status Put(const Slice& key) = 0;
  Slice operator[](int n) const;
 private:
  DB* db_;
  Cache* cache_;
};
class Base {};
namespace ns { template <typename T> class Tpl {}; }
class Derived : public Base, private ns::Tpl<int> {
  Base* parent;
};
struct Plain : Base { Base* next; };
class Wrapped
    : public Base {
  Base* other;
};
`;

/** Go embedding is real inheritance-by-composition and keeps its edges. */
const GO_SOURCE = `package store

type Engine struct{}

type Reader interface{ Read() }

type Store struct {
	*Engine
	Reader
	name   string
	engine *Engine
}
`;

/** Objective-C reuses the C struct grammar; its superclass comes from @interface. */
const OBJC_SOURCE = `#import <Foundation/Foundation.h>
typedef struct { int width; } Size;
struct Frame {
  Size *size;
  Size corners[4];
  Size origin;
};
@interface Image : NSObject <NSCopying> {
  Size *cached;
}
@end
@implementation Image
@end
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<source> <kind> <name>` for every extends/implements ref, sorted. */
function supertypeRefs(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'extends' || r.referenceKind === 'implements')
    .map((r) => `${byId.get(r.fromNodeId)?.name ?? r.fromNodeId} ${r.referenceKind} ${r.referenceName}`)
    .sort();
}

describe('a C/C++ member is not a supertype of its struct', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c', 'cpp', 'go', 'objc']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`C pointer, array and function-pointer members: %s${label}`, (backend) => {
      const result = extract(backend, 'src/jv.c', eol(C_SOURCE), 'c');
      expect(result.nodes.map((n) => n.name)).toEqual(
        expect.arrayContaining(['jvp_array', 'jv_parser', 'cfunction', 'node'])
      );
      expect(supertypeRefs(result)).toEqual([]);
    });

    it.each(backends)(`C++ members, methods and operators; base classes kept: %s${label}`, (backend) => {
      const result = extract(backend, 'benchmarks/db_bench.cc', eol(CPP_SOURCE), 'cpp');
      expect(supertypeRefs(result)).toEqual([
        'Derived extends Base',
        'Derived extends ns::Tpl',
        'Plain extends Base',
        'Wrapped extends Base',
      ]);
    });

    it.each(backends)(`Go embedded fields still extend: %s${label}`, (backend) => {
      const result = extract(backend, 'store/store.go', eol(GO_SOURCE), 'go');
      expect(supertypeRefs(result)).toEqual(['Store extends Engine', 'Store extends Reader']);
    });

    // Objective-C has no kernel walker; the wasm extractor is its only path.
    it(`Objective-C C-struct members; @interface superclass kept: wasm${label}`, () => {
      const result = extractFromSource('Image.m', eol(OBJC_SOURCE), 'objc');
      expect(supertypeRefs(result)).toEqual(['Image extends NSObject', 'Image implements NSCopying']);
    });
  }
});

describe('the type hierarchy of an indexed C/C++ project', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('holds only declared bases and Go embeddings', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-member-supertypes-'));
    const files: Record<string, string> = {
      'include/db.h': 'class Cache {};\nclass DB {\n public:\n  virtual ~DB();\n};\n',
      'benchmarks/db_bench.cc': [
        '#include "db.h"',
        'struct SharedState { int total; };',
        'struct ThreadState {',
        '  SharedState* shared;',
        '};',
        'class Benchmark {',
        '  Cache* cache_;',
        '  DB* db_;',
        '};',
        'class MemDB : public DB {',
        '  Cache* cache_;',
        '};',
        '',
      ].join('\n'),
      'src/jv.c': C_SOURCE,
      'store/store.go': GO_SOURCE,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;

    const one = (name: string): Node => {
      const found = graph.getNodesByName(name).filter((n) => n.kind !== 'file' && n.kind !== 'import');
      expect(found, name).toHaveLength(1);
      return found[0]!;
    };

    const ids = ['ThreadState', 'Benchmark', 'MemDB', 'jvp_array', 'jv_parser', 'cfunction', 'node', 'Store'].map(
      (name) => one(name).id
    );
    const supertypes = graph
      .getOutgoingEdgesFrom(ids, ['extends', 'implements'])
      .map((e) => `${graph.getNode(e.source)?.name} ${e.kind} ${graph.getNode(e.target)?.name}`)
      .sort();
    // An embedded interface resolves as `implements`.
    expect(supertypes).toEqual(['MemDB extends DB', 'Store extends Engine', 'Store implements Reader']);

    // What the viewer's Type hierarchy and the "extends" chips are built from.
    expect(buildTypeHierarchy(graph, one('ThreadState'))).toBeNull();
    expect(buildTypeHierarchy(graph, one('SharedState'))).toBeNull();
    expect(buildTypeHierarchy(graph, one('jv'))).toBeNull();
    expect(buildTypeHierarchy(graph, one('DB'))?.descendants.map((d) => d.node.name)).toEqual(['MemDB']);
    expect(buildTypeHierarchy(graph, one('Cache'))).toBeNull();
    expect(buildTypeHierarchy(graph, one('Engine'))?.descendants.map((d) => d.node.name)).toEqual(['Store']);
  }, 60_000);
});
