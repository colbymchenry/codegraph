/**
 * A C or C++ struct referenced nothing through its members. `struct redisServer
 * { pause_event pauses[3]; struct client *current; }` had no edge to either type,
 * so impact on `pause_event` missed everything that holds one. 1.6.2 linked some
 * of them, by accident, as false `extends` edges (#2394 removed the label and left
 * nothing in its place), and never a member held by value or named by its tag.
 *
 * A class, struct or union now references the types its members are declared
 * with, on the name; an alias references what it names, so a change to a struct
 * reaches what is declared through `typedef struct redisObject robj;`. The
 * references are the holder's: members mint no nodes, and impact never climbs
 * from a member to its container. A member of an unnamed struct or union is the
 * holder's too, since nothing can name that type.
 *
 * Only a type can be named there, so resolution looks the name up as C++ name
 * lookup does and considers only declarations of types: a function, a macro or
 * a variable of that name is never the target, nor a namesake of another
 * namespace or of a folder the file has nothing to do with. Builtins, the
 * standard library and template parameters link nothing.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { Edge, ExtractionResult, Language, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

/** What a real C header holds. */
const C_SOURCE = `typedef struct pause_event { int paused_actions; long end; } pause_event;
typedef struct ev ev;
struct client { int fd; };
enum level { LOW, HIGH };
typedef enum { RED, GREEN } color;
typedef union { int i; } value;
typedef unsigned long long mstime_t;
typedef struct redisObject robj;
typedef void (*notify_fn)(struct client *c, robj *o);
#define u32 unsigned int

struct holder {
  pause_event by_value;
  pause_event *by_pointer;
  pause_event by_array[3];
  pause_event **by_pointers;
  const pause_event *constant;
  pause_event const *also_constant;
  struct client *tagged;
  struct client *one, two, three[2];
  union extra *tagged_union;
  value in_union;
  enum level tagged_enum;
  color named_enum;
  void (*callback)(struct client *c, value v);
  ev *(*factory)(robj **out);
  int (*table[4])(mstime_t when);
  mstime_t when;
  robj *object;
  u32 mask;
  int n;
  char *s;
  unsigned long l;
  size_t len;
  uint64_t id;
  void *p;
  bool b;
  _Bool flag;
  uintmax_t widest;
  int_least8_t least;
  wchar_t wide;
#ifdef FEATURE
  ev *guarded;
#else
  ev *otherwise;
#endif
  struct { ev *in_unnamed; } named_member;
  union { ev *in_anonymous; int i; };
  struct inner { ev *deep; } nested;
  struct fwd;
  struct holder *next;
  LIST_ENTRY(client) link;
  ev bits : 3;
};

typedef struct listNode {
  struct listNode *prev;
  ev *value;
} listNode;

typedef struct tagged_s {
  struct tagged_s *next;
  struct tagged_t *other;
  listNode *head;
} tagged_t;

typedef union {
  ev *a;
  struct { listNode *b; } c;
} wrapped;
`;

/** What a real C++ header holds. */
const CPP_SOURCE = `namespace ns {
class Foo {};
template <typename K, typename V> class Map {};
}
class Global {};
template <class T>
class Holder : public Global {
 public:
  Status Open(const Slice& key);
  virtual Iterator* NewIterator(const Options& options) = 0;
  const Snapshot& Snap() const;
  Holder(const Holder&);
  operator bool() const;
  void Inline() { Hidden h; }
  friend class Pal;
  using Base::Base;
  typedef ns::Map<int, Foo> Table;
  using Rows = std::vector<ns::Foo*>;
 private:
  ns::Foo plain;
  const ns::Foo& reference;
  ns::Foo* pointer;
  ::Global global;
  std::string text;
  std::vector<Foo> items;
  std::unique_ptr<ns::Foo> owner;
  std::map<Key, std::shared_ptr<Value>> lookup;
  ns::Map<int, Foo*> templated;
  Outer<A>::Inner<B>* nested;
  std::function<void(Callback*, const Reply&)> done;
  typename T::value_type element;
  T* parameter;
  Holder<T>* next;
  decltype(x) computed;
  auto deduced = 1;
  static Registry* instance;
  mutable Mutex mu;
  Version* const version GUARDED_BY(mu);
  bool (*predicate)(const Slice* key);
  enum class Mode : int { A, B } mode;
  Mode other;
  class Fwd;
  class Rep;
  Rep* rep;
  struct Node { Payload* payload; };
  union { Left left; Right right; };
};
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<holder> <name>` for every `references` ref, in the order written. */
function typeRefs(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'references')
    .map((r) => `${byId.get(r.fromNodeId)?.name ?? r.fromNodeId} ${r.referenceName}`)
    .sort();
}

describe('a C or C++ type references the types it is declared with', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c', 'cpp']);
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

    it.each(backends)(`every shape of a C member: %s${label}`, (backend) => {
      const result = extract(backend, 'server.h', eol(C_SOURCE), 'c');
      expect(typeRefs(result)).toEqual([
        // A member of an unnamed struct or union is its holder's.
        'holder ev', 'holder ev', 'holder ev', 'holder ev', 'holder ev', 'holder ev',
        'holder client', 'holder client', 'holder client',
        'holder color',
        'holder extra',
        'holder inner',
        'holder level',
        'holder mstime_t', 'holder mstime_t',
        'holder pause_event', 'holder pause_event', 'holder pause_event', 'holder pause_event', 'holder pause_event', 'holder pause_event',
        'holder robj', 'holder robj',
        // What a macro names is read like any type: `u32` links only if a type is named so.
        'holder u32',
        'holder value', 'holder value',
        'inner ev',
        'listNode ev',
        '(*notify_fn) client',
        '(*notify_fn) robj',
        'robj redisObject',
        'tagged_t listNode',
        'wrapped ev',
        'wrapped listNode',
      ].sort());
    });

    it.each(backends)(`every shape of a C++ member: %s${label}`, (backend) => {
      const result = extract(backend, 'holder.h', eol(CPP_SOURCE), 'cpp');
      // Not read: `std::` names, though their template arguments are; a
      // method's parameters; a computed or deduced type; the class's own name;
      // a declaration that declares no member, like `class Fwd;`.
      expect(typeRefs(result)).toEqual([
        'Holder ::Global',
        'Holder Callback',
        'Holder Foo', 'Holder Foo',
        'Holder Iterator',
        'Holder Key',
        'Holder Left',
        'Holder Mode',
        'Holder Mode',
        'Holder Mutex',
        'Holder Outer::Inner', 'Holder A', 'Holder B',
        'Holder Registry',
        'Holder Rep',
        'Holder Reply',
        'Holder Right',
        'Holder Slice',
        'Holder Snapshot',
        'Holder Status',
        'Holder T', 'Holder T',
        'Holder T::value_type',
        'Holder Value',
        'Holder Version',
        'Holder ns::Foo', 'Holder ns::Foo', 'Holder ns::Foo', 'Holder ns::Foo',
        'Holder ns::Map',
        'Node Payload',
        'Rows ns::Foo',
        'Table Foo',
        'Table ns::Map',
      ].sort());
    });

    it.each(backends)(`a reference is written on the name it reads: %s${label}`, (backend) => {
      const source = eol('struct a {\n  const  struct b *x;\n  std::vector<ns::c> y;\n};\n');
      const refs = extract(backend, 'pos.cc', source, 'cpp').unresolvedReferences.filter((r) => r.referenceKind === 'references');
      expect(refs.map((r) => `${r.referenceName}@${r.line}:${r.column}`)).toEqual(['b@2:16', 'ns::c@3:14']);
    });
  }

  it.each(backends)('members mint no nodes: %s', (backend) => {
    const result = extract(backend, 'server.h', C_SOURCE, 'c');
    expect(result.nodes.map((n) => n.name)).not.toEqual(expect.arrayContaining(['by_value']));
    expect(result.nodes.some((n) => n.kind === 'field' || n.kind === 'property')).toBe(false);
  });
});

describe('the types of C and C++ members in an indexed project', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-member-types-'));
    write(files);
    cg = await CodeGraph.init(root, { index: true });
    return cg;
  }

  function write(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
  }

  const named = (name: string, kind?: string, file?: string): Node => {
    const found = cg!.getNodesByName(name).filter((n) =>
      n.kind !== 'file' && n.kind !== 'import' && (!kind || n.kind === kind) && (!file || n.filePath === file));
    expect(found, `${kind ?? ''} ${name} ${file ?? ''}`).toHaveLength(1);
    return found[0]!;
  };

  /** `<kind> <qualified name> @<file>` of what a holder references, sorted and deduplicated. */
  const referenced = (holder: Node): string[] => [...new Set(
    cg!.getOutgoingEdges(holder.id)
      .filter((e: Edge) => e.kind === 'references')
      .map((e: Edge) => {
        const target = cg!.getNode(e.target)!;
        return `${target.kind} ${target.qualifiedName} @${target.filePath}`;
      })
  )].sort();

  /** What impact on a declaration reaches, by name, without the declaration. */
  const impactOf = (node: Node, depth = 2): string[] => [...new Set(
    [...cg!.getImpactRadius(node.id, depth).nodes.values()].filter((n) => n.id !== node.id).map((n) => n.name)
  )].sort();

  it('the struct that holds a member is back in impact on its type', async () => {
    await index({
      'server.h': [
        'typedef struct pause_event {',
        '    int paused_actions;',
        '    long end;',
        '} pause_event;',
        '',
        'struct client {',
        '    int fd;',
        '};',
        '',
        'struct redisServer {',
        '    pause_event client_pause_per_purpose[3];',
        '    struct client *current_client;',
        '    int port;',
        '};',
        '',
      ].join('\n'),
      'server.c': [
        '#include "server.h"',
        'struct redisServer server;',
        'int isPaused(struct redisServer *s) {',
        '    return s->client_pause_per_purpose[0].paused_actions;',
        '}',
        '',
      ].join('\n'),
    });
    expect(impactOf(named('pause_event'))).toEqual(['redisServer']);
    expect(impactOf(named('client'))).toEqual(['redisServer']);
    expect(referenced(named('redisServer'))).toEqual(['struct client @server.h', 'struct pause_event @server.h']);
    // The relation is what the code says; no false supertype came back.
    const holder = named('redisServer');
    expect(cg!.getOutgoingEdges(holder.id).filter((e: Edge) => e.kind === 'extends')).toEqual([]);
  });

  it('a type held by value, by pointer, in an array or through a function pointer', async () => {
    await index({
      'a.h': [
        'typedef struct ev { int x; } ev;',
        'struct holder {',
        '    ev by_value;',
        '    ev *by_pointer;',
        '    ev by_array[3];',
        '    ev (*by_fn)(int);',
        '    ev *(*by_parameter)(ev e);',
        '};',
        '',
      ].join('\n'),
    });
    const edges = cg!.getOutgoingEdges(named('holder').id).filter((e: Edge) => e.kind === 'references');
    expect(edges.map((e: Edge) => e.line)).toEqual([3, 4, 5, 6, 7, 7]);
    expect(impactOf(named('ev'))).toEqual(['holder']);
  });

  it('impact goes on from the holder to what uses it', async () => {
    await index({
      'a.h': 'typedef struct ev { int x; } ev;\nstruct holder { ev *e; };\nstruct owner { struct holder h; };\n',
      'a.c': '#include "a.h"\nint use(struct owner *o) { return sizeof(*o); }\nint touch(struct holder *h) { return h->e->x; }\nvoid fresh(void) { struct holder h; (void)h; touch(&h); }\n',
    });
    expect(impactOf(named('ev'), 2)).toEqual(['holder', 'owner']);
  });

  it('a type declared through a typedef reaches what it names', async () => {
    await index({
      'server.h': [
        'typedef struct redisObject robj;',
        'typedef struct dict dict;',
        'struct redisObject { int type; };',
        'struct dict { int size; };',
        'struct db { robj *key; dict *keys; struct dict *tagged; };',
        '',
      ].join('\n'),
    });
    expect(referenced(named('db'))).toEqual([
      'struct dict @server.h',
      'type_alias robj @server.h',
    ]);
    // `dict` is the struct itself, and the alias of it stays out of the way.
    expect(impactOf(named('dict', 'struct'))).toEqual(['db']);
    expect(referenced(named('robj'))).toEqual(['struct redisObject @server.h']);
    expect(impactOf(named('redisObject'))).toEqual(['db', 'robj']);
  });

  it('a builtin, or a macro expanding to one, links nothing', async () => {
    await index({
      'a.h': [
        '#define u32 unsigned int',
        '#define counter_t long',
        'struct holder {',
        '    u32 mask;',
        '    counter_t hits;',
        '    int n;',
        '    size_t len;',
        '    uint64_t id;',
        '    wchar_t c;',
        '    FILE *out;',
        '    time_t at;',
        '};',
        '',
      ].join('\n'),
      'b.c': '#include "a.h"\nint size_t_of(void) { return 0; }\n',
    });
    expect(referenced(named('holder'))).toEqual([]);
  });

  it('a compiler shim of a standard type is no type of the project', async () => {
    await index({
      'deps/compat/C99/stdbool.h': 'typedef int _Bool;\ntypedef unsigned long long uintmax_t;\n',
      'src/a.h': 'struct holder { _Bool flag; uintmax_t widest; };\n',
    });
    expect(referenced(named('holder'))).toEqual([]);
  });

  it('only a type is a member’s type: no function, variable or macro of that name', async () => {
    await index({
      'a.h': [
        'struct holder {',
        '    log *to;',
        '    struct stat st;',
        '    counter hits;',
        '    limit cap;',
        '};',
        '',
      ].join('\n'),
      'a.c': [
        '#include "a.h"',
        '#define limit 10',
        'int stat(const char *path) { return 0; }',
        'void log(const char *m) {}',
        'int counter = 3;',
        '',
      ].join('\n'),
    });
    expect(referenced(named('holder'))).toEqual([]);
  });

  it('a type its header declares and its source file defines is that source file’s', async () => {
    await index({
      // redis: a vendored copy declares the name in a header every file can see.
      'deps/hiredis/dict.h': 'typedef struct dictEntry { void *key; } dictEntry;\nstruct vendored { dictEntry *head; };\n',
      'src/dict.h': 'typedef struct dictEntry dictEntry;\nstruct dict { dictEntry **table; };\n',
      'src/dict.c': '#include "dict.h"\nstruct dictEntry { void *key; int v; };\nstruct walker { dictEntry *at; };\n',
      'src/kvstore.c': '#include "dict.h"\nstruct kvstore { dictEntry *rehashing; };\n',
    });
    const mine = 'struct dictEntry @src/dict.c';
    expect(referenced(named('dict', 'struct'))).toEqual([mine]);
    expect(referenced(named('walker'))).toEqual([mine]);
    expect(referenced(named('kvstore'))).toEqual([mine]);
    expect(referenced(named('vendored'))).toEqual(['struct dictEntry @deps/hiredis/dict.h']);
  });

  it('a struct only another source file defines, that no header declares, is not seen', async () => {
    await index({
      'a.c': 'struct state { int a; };\nint f(void) { return 0; }\n',
      'b.c': 'struct holder { struct state *s; };\n',
    });
    expect(referenced(named('holder'))).toEqual([]);
  });

  it('a nested C struct is found by its own name, from outside the struct that defines it', async () => {
    await index({
      'a.h': 'struct outer { struct inner { int x; } i; };\nstruct other { struct inner *p; };\n',
    });
    expect(referenced(named('outer'))).toEqual(['struct outer::inner @a.h']);
    expect(referenced(named('other'))).toEqual(['struct outer::inner @a.h']);
  });

  it('a member of an unnamed struct or union belongs to the struct that holds it', async () => {
    await index({
      'a.h': [
        'typedef struct { int x; } ev;',
        'struct holder {',
        '    union { ev *in_anonymous; int i; };',
        '    struct { ev *in_unnamed; } named_member;',
        '};',
        '',
      ].join('\n'),
    });
    expect(referenced(named('holder'))).toEqual(['struct ev @a.h']);
    // (Impact on a struct walks what it contains, so the unnamed union is listed with it.)
    expect(impactOf(named('ev'))).toContain('holder');
  });

  it('a C++ member names what name lookup finds, not a namesake', async () => {
    await index({
      'include/types.h': [
        'namespace other { class Foo {}; class Slice {}; }',
        'namespace ns {',
        'class Foo {};',
        'class Slice {};',
        'template <typename K, typename V> class Map {};',
        'enum class Color { Red };',
        '}',
        'class Global {};',
        '',
      ].join('\n'),
      'src/holder.h': [
        '#include "types.h"',
        'namespace ns {',
        'class Outer {',
        '  struct Nested {};',
        '  enum Mode { A, B };',
        '  Foo bare;',
        '  ns::Foo qualified;',
        '  other::Foo elsewhere;',
        '  ::Global global;',
        '  Nested nested;',
        '  Mode mode;',
        '  Color color;',
        '  const Slice& reference;',
        '  Map<int, Foo*> map;',
        '  std::vector<Slice> items;',
        '  std::unique_ptr<other::Slice> owner;',
        '};',
        '}',
        '',
      ].join('\n'),
    });
    expect(referenced(named('Outer'))).toEqual([
      'class Global @include/types.h',
      'class ns::Foo @include/types.h',
      'class ns::Map @include/types.h',
      'class ns::Slice @include/types.h',
      'class other::Foo @include/types.h',
      'class other::Slice @include/types.h',
      'enum ns::Color @include/types.h',
      'enum ns::Outer::Mode @src/holder.h',
      'struct ns::Outer::Nested @src/holder.h',
    ]);
  });

  it('a using-declaration or -directive, and a namespace alias, say where a name comes from', async () => {
    await index({
      'include/types.h': [
        'namespace db { class Options {}; class Slice {}; class string {}; }',
        'namespace internal { class Slice {}; }',
        '',
      ].join('\n'),
      'src/a.h': [
        '#include "types.h"',
        'using db::Slice;',
        'namespace d = db;',
        'class A { Slice slice; d::Options options; };',
        '',
      ].join('\n'),
      'src/b.h': [
        '#include "types.h"',
        'using namespace db;',
        'class B { Options options; };',
        '',
      ].join('\n'),
      'src/c.h': [
        '#include "types.h"',
        '#include <string>',
        'using std::string;',
        'class C { string text; };',
        '',
      ].join('\n'),
    });
    expect(referenced(named('A'))).toEqual(['class db::Options @include/types.h', 'class db::Slice @include/types.h']);
    expect(referenced(named('B'))).toEqual(['class db::Options @include/types.h']);
    expect(referenced(named('C'))).toEqual([]);
  });

  it('a name no lookup finds is not a namesake in a scope the class is not in', async () => {
    await index({
      'include/port.h': [
        'namespace db { namespace port { using pthread_key_t = int; class Latch {}; } }',
        'class Outer { public: using Hash = int; };',
        '',
      ].join('\n'),
      'src/a.h': [
        '#include "port.h"',
        'namespace db {',
        'class A { pthread_key_t key; Hash hash; port::Latch latch; };',
        '}',
        '',
      ].join('\n'),
    });
    expect(referenced(named('A'))).toEqual(['class db::port::Latch @include/port.h']);
  });

  it('an alias template is found, though the reference carries no template arguments', async () => {
    await index({
      'include/containers.h': [
        'namespace db {',
        'template <class K, class V> using UnorderedMap = Other<K, V>;',
        'class Key {};',
        'class Holder { UnorderedMap<int, Key*> map; };',
        '}',
        '',
      ].join('\n'),
    });
    expect(referenced(named('Holder'))).toEqual([
      'class db::Key @include/containers.h',
      'type_alias db::UnorderedMap @include/containers.h',
    ]);
  });

  it('of several declarations of a name in the file, the nearest above is the one in force', async () => {
    await index({
      'src/a.h': [
        '#ifdef WIDE',
        'typedef long width_t;',
        'struct first { width_t w; };',
        '#else',
        'typedef int width_t;',
        'struct second { width_t w; };',
        '#endif',
        '',
      ].join('\n'),
    });
    const line = (holder: string): number[] => cg!.getOutgoingEdges(named(holder).id)
      .filter((e: Edge) => e.kind === 'references')
      .map((e: Edge) => cg!.getNode(e.target)!.startLine);
    expect(line('first')).toEqual([2]);
    expect(line('second')).toEqual([5]);
  });

  it('a class local to a gtest body is seen only from that body', async () => {
    await index({
      'src/a_test.cc': [
        'namespace db {',
        'TEST_F(Suite, First) {',
        '  struct Item { int a; };',
        '  struct Box { Item item; };',
        '}',
        'TEST_F(Suite, Second) {',
        '  struct Item { int b; };',
        '  struct Crate { Item item; };',
        '}',
        '}',
        '',
      ].join('\n'),
    });
    const line = (holder: string): number[] => cg!.getOutgoingEdges(named(holder).id)
      .filter((e: Edge) => e.kind === 'references')
      .map((e: Edge) => cg!.getNode(e.target)!.startLine);
    expect(line('Box')).toEqual([3]);
    expect(line('Crate')).toEqual([7]);
  });

  it('a template parameter, or a member of one, names no particular type', async () => {
    await index({
      'include/t.h': [
        'class T {};',
        'class Element {};',
        'class value_type {};',
        'template <class T, typename Element = int>',
        'class Box {',
        '  T item;',
        '  Element* pointer;',
        '  typename T::value_type inner;',
        '  Element other[2];',
        '};',
        'template <class T> class Tree {',
        '  class Node { T value; };',
        '  Node* root;',
        '};',
        '',
      ].join('\n'),
    });
    expect(referenced(named('Box'))).toEqual([]);
    expect(referenced(named('Node'))).toEqual([]);
    expect(referenced(named('Tree'))).toEqual(['class Tree::Node @include/t.h']);
  });

  it('a pimpl’s nested type, which only the source file defines', async () => {
    await index({
      'include/table.h': [
        'namespace db {',
        'class Table {',
        ' private:',
        '  struct Rep;',
        '  Rep* rep_;',
        '};',
        '}',
        '',
      ].join('\n'),
      'src/table.cc': [
        '#include "table.h"',
        'namespace db {',
        'struct Table::Rep { int n; };',
        '}',
        '',
      ].join('\n'),
      'src/other.cc': [
        '#include "table.h"',
        'namespace other {',
        'struct Rep { int m; };',
        '}',
        '',
      ].join('\n'),
    });
    // other.cc includes the header too, but its `Rep` is in no scope the class can name.
    expect(referenced(named('Table'))).toEqual(['struct db::Table::Rep @src/table.cc']);
  });

  it('a struct naming itself has no edge to itself and no unresolved row for its name', async () => {
    await index({
      'a.h': [
        'typedef struct node { struct node *next; node_t *other; } node_t;',
        'typedef struct listNode { struct listNode *prev; } listNode;',
        'struct plain { struct plain *next; };',
        '',
      ].join('\n'),
    });
    for (const name of ['node_t', 'listNode', 'plain']) expect(referenced(named(name))).toEqual([]);
  });

  it('explore spends no window on a member: a class’s types are not its flow', async () => {
    const members = Array.from({ length: 600 }, (_, i) => `  Type${i} member_with_a_long_name_${i};`).join('\n');
    const types = Array.from({ length: 600 }, (_, i) => `class Type${i} {};`).join('\n');
    await index({
      'src/types.h': `${types}\n`,
      'src/reader.h': [
        '#include "types.h"',
        'class Reader {',
        ' public:',
        '  int Get(int key);',
        '  int Size() const { return count_; }',
        ' private:',
        '  int count_;',
        members,
        '};',
        '',
      ].join('\n'),
      'src/reader.cc': [
        '#include "reader.h"',
        'static int Lookup(int key) { return key + 1; }',
        'int Reader::Get(int key) {',
        '  return Lookup(key) + Size();',
        '}',
        '',
      ].join('\n'),
    });
    expect(referenced(named('Reader'))).toHaveLength(600);
    const result = await new ToolHandler(cg!).execute('codegraph_explore', { query: 'Reader::Get Size Lookup' });
    const text = result.content[0]!.text;
    expect(text).toContain('return Lookup(key) + Size();');
    expect(text).toContain('int Size() const');
    expect(text).not.toContain('(references)');
    expect(text).not.toContain('member_with_a_long_name_50');
  });

  it('a member’s type links once its file is added, and survives an edit of that file', async () => {
    await index({
      'src/holder.h': '#include "ev.h"\nstruct holder { ev *e; };\n',
    });
    expect(referenced(named('holder'))).toEqual([]);

    write({ 'src/ev.h': 'typedef struct ev { int x; } ev;\n' });
    await cg!.sync();
    expect(referenced(named('holder'))).toEqual(['struct ev @src/ev.h']);

    write({ 'src/ev.h': '/* moved */\n\ntypedef struct ev { int x; int y; } ev;\n' });
    await cg!.sync();
    expect(referenced(named('holder'))).toEqual(['struct ev @src/ev.h']);
    expect(impactOf(named('ev'))).toEqual(['holder']);
  });
});
