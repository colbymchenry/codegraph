/**
 * A Go struct's fields referenced nothing: `type PutResponse struct { Header
 * *ResponseHeader }` (etcd) or gin's `type Context struct { handlers
 * HandlersChain }` was a `struct` node with no `references` edge to the types
 * its fields are declared with, so impact on `ResponseHeader` or
 * `HandlersChain` missed every struct that holds one, and everything that
 * uses those structs. Only embedded fields were read, as `extends` edges.
 *
 * The struct now references each type a named field's type names, on the
 * name, where resolution reads a package qualifier back. The references are
 * the struct's: Go fields mint no nodes, as Dart's don't (#2327), and impact
 * never climbs from a member to its container, so a field node would have
 * stopped impact short of the struct. Not references: an embedded field (an
 * `extends` edge already), the struct's own type parameters, Go's predeclared
 * types, and the struct's own name written bare (`next *node`), which names
 * the struct itself: no self-edge, and no unresolved row for the name.
 *
 * Resolution reads each as any type position: a bare name is its own
 * package's type, `pb.ResponseHeader` the import's, `context.Context` (a
 * package outside the project) nothing, and a name written through a package
 * the index doesn't know links to nothing either.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

/** Every shape a field's type can take, beside the declarations that skip names. */
const FIELDS_SOURCE = `package etcdserverpb

import (
	"context"
	"sync"

	mvccpb "go.etcd.io/etcd/api/v3/mvccpb"
	"go.uber.org/zap"
	"k8s.io/client-go/gentype"
)

type ResponseHeader struct {
	ClusterId uint64
	Revision  int64
}

// PutResponse is etcd's: a header and the previous key-value.
type PutResponse struct {
	Header *ResponseHeader \`protobuf:"bytes,1,opt,name=header,proto3" json:"header,omitempty"\`
	PrevKv *mvccpb.KeyValue
}

type Server struct {
	mu       sync.RWMutex
	lg       *zap.Logger
	ctx      context.Context
	handlers HandlersChain
	byKey    map[Key][]*Watcher
	events   <-chan Event
	grid     [4][4]Cell
	cb       func(ctx context.Context, req *Request) (*Response, error)
	wrapped  (Cell)
	a, b     Pair
	cache    *List[Item]
	boxed    mvccpb.Box[Item]
	conf     struct {
		inner Inner
		*Base
	}
	codec interface {
		Encode(Message) ([]byte, error)
	}
	err  error
	n    int
	opts []any
}

// Embedded fields are its supertypes, not references; the type arguments of
// an embedded generic are references, as client-go's typed clients name the
// resource they serve.
type Embedder struct {
	*Base
	Queryable
	mvccpb.Embedded
	*mvccpb.Pointer \`json:"-"\`
	List[int]
	*gentype.ClientWithList[*Pod, *mvccpb.PodList]
	error
	name string
}

type Node struct {
	next     *Node
	children map[string]*Node
	build    func(*Node) error
	remote   *mvccpb.Node
}

type List[T any] struct {
	items []T
	head  *elem[T]
	next  *List[T]
	extra Extra
}

type Pairs[K comparable, V any] struct {
	byKey map[K]V
	list  List[V]
	List[K]
	*Box[Pairs[K, V]]
}

type Anon = struct {
	w Widget
}

type Empty struct{}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<kind> <name>` of every node but the file and its imports, in source order. */
function declarations(result: ExtractionResult): string[] {
  return result.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'import').map((n) => `${n.kind} ${n.name}`);
}

/** `<struct> <name>` for every `references` ref out of a struct, sorted. */
function fieldRefs(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'references' && byId.get(r.fromNodeId)?.kind === 'struct')
    .map((r) => `${byId.get(r.fromNodeId)!.name} ${r.referenceName}`)
    .sort();
}

describe('a Go struct references the types its fields are declared with', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['go']);
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

  function extract(backend: 'kernel' | 'wasm', file: string, source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, 'go');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, 'go');
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`a field mints no node of its own: %s${label}`, (backend) => {
      const result = extract(backend, 'rpc.pb.go', eol(FIELDS_SOURCE));
      expect(declarations(result)).toEqual([
        'struct ResponseHeader',
        'struct PutResponse',
        'struct Server',
        'struct Embedder',
        'struct Node',
        'struct List',
        'struct Pairs',
        'struct Anon',
        'struct Empty',
      ]);
    });

    it.each(backends)(`a struct references each type its named fields name: %s${label}`, (backend) => {
      const source = eol(FIELDS_SOURCE);
      const result = extract(backend, 'rpc.pb.go', source);
      // Not references: the predeclared types (uint64, int64, error, int, any,
      // byte), the type parameters T, K and V, a struct's own name written bare
      // (Node, List, Pairs), and the type an embedded field embeds. A qualified
      // name keeps its package in the source (`zap.Logger`, `mvccpb.Node`), and
      // an anonymous struct or interface in a field is the field's type: its
      // fields, embedded or not, and its methods' types are the struct's.
      expect(fieldRefs(result)).toEqual([
        'Anon Widget',
        'Embedder Pod',
        'Embedder PodList',
        'List Extra',
        'List elem',
        'Node Node',
        'Pairs List',
        'PutResponse KeyValue',
        'PutResponse ResponseHeader',
        'Server Base',
        'Server Box',
        'Server Cell',
        'Server Cell',
        'Server Context',
        'Server Context',
        'Server Event',
        'Server HandlersChain',
        'Server Inner',
        'Server Item',
        'Server Item',
        'Server Key',
        'Server List',
        'Server Logger',
        'Server Message',
        'Server Pair',
        'Server RWMutex',
        'Server Request',
        'Server Response',
        'Server Watcher',
      ]);
      // Each sits on its name, where resolution reads the qualifier back.
      const lines = source.split(/\r?\n/);
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references' && byId.get(r.fromNodeId)?.kind === 'struct');
      for (const r of refs) {
        expect(lines[r.line - 1]!.startsWith(r.referenceName, r.column), `${r.referenceName} at ${r.line}:${r.column}`).toBe(true);
      }
      const remote = refs.find((r) => byId.get(r.fromNodeId)!.name === 'Node')!;
      expect(lines[remote.line - 1]!.slice(0, remote.column).trimStart()).toBe('remote   *mvccpb.');
    });

    it.each(backends)(`an embedded field is still a supertype, and its type arguments references: %s${label}`, (backend) => {
      const result = extract(backend, 'rpc.pb.go', eol(FIELDS_SOURCE));
      const refsOf = (name: string) => {
        const struct = result.nodes.find((n) => n.kind === 'struct' && n.name === name)!;
        return result.unresolvedReferences
          .filter((r) => r.fromNodeId === struct.id)
          .map((r) => `${r.referenceKind} ${r.referenceName}`)
          .sort();
      };
      // An embedded `error` is an embedding too: the one predeclared type with a method.
      expect(refsOf('Embedder')).toEqual([
        'extends Base',
        'extends ClientWithList',
        'extends Embedded',
        'extends List',
        'extends Pointer',
        'extends Queryable',
        'extends error',
        'references Pod',
        'references PodList',
      ]);
      // `List[K]` and `*Box[Pairs[K, V]]` hold a type parameter or the struct
      // itself, and nothing else.
      expect(refsOf('Pairs')).toEqual(['extends Box', 'extends List', 'references List']);
    });
  }
});

/** The module of the indexed tests: etcd's and gin's shapes, with namesakes in a package that sorts first. */
const MODULE: Record<string, string> = {
  'go.mod': 'module go.etcd.io/etcd\n\ngo 1.24\n',
  // A lookup by name meets these first.
  'alpha/names.go': [
    'package alpha',
    '',
    'type ResponseHeader struct{}',
    '',
    'type KeyValue struct{}',
    '',
    'type Context struct{}',
    '',
    'type Config struct{}',
    '',
    'type Client struct{}',
    '',
    'type Op struct{}',
    '',
    'type HandlersChain []int',
    '',
    'type Engine struct{}',
    '',
    'type node struct{}',
    '',
    'type elem struct{}',
    '',
    'type T struct{}',
    '',
    'type Pod struct{}',
    '',
  ].join('\n'),
  // client-go's lister: the resource is a type argument of the embedded generic.
  'k8s/api/core/v1/types.go': [
    'package v1',
    '',
    'type Pod struct {',
    '\tName string',
    '}',
    '',
  ].join('\n'),
  'k8s/client-go/listers/generic.go': [
    'package listers',
    '',
    'type ResourceIndexer[T any] struct {',
    '\titems []T',
    '}',
    '',
  ].join('\n'),
  'k8s/client-go/listers/core/v1/pod.go': [
    'package v1',
    '',
    'import (',
    '\tcorev1 "go.etcd.io/etcd/k8s/api/core/v1"',
    '\t"go.etcd.io/etcd/k8s/client-go/listers"',
    ')',
    '',
    'type podLister struct {',
    '\tlisters.ResourceIndexer[*corev1.Pod]',
    '}',
    '',
  ].join('\n'),
  'api/v3/etcdserverpb/rpc.pb.go': [
    'package etcdserverpb',
    '',
    'import mvccpb "go.etcd.io/etcd/api/v3/mvccpb"',
    '',
    'type ResponseHeader struct {',
    '\tRevision int64',
    '}',
    '',
    'type PutResponse struct {',
    '\tHeader *ResponseHeader',
    '}',
    '',
    'type RangeResponse struct {',
    '\tHeader *ResponseHeader',
    '\tKvs    []*mvccpb.KeyValue',
    '}',
    '',
  ].join('\n'),
  'api/v3/mvccpb/kv.pb.go': [
    'package mvccpb',
    '',
    'type KeyValue struct {',
    '\tKey []byte',
    '}',
    '',
  ].join('\n'),
  'client/v3/client.go': [
    'package clientv3',
    '',
    'import (',
    '\t"context"',
    '',
    '\tpb "go.etcd.io/etcd/api/v3/etcdserverpb"',
    ')',
    '',
    '// A namesake of context.Context in the same file.',
    'type Context struct{}',
    '',
    'type Config struct{}',
    '',
    'type Client struct {',
    '\tctx    context.Context',
    '\tcfg    Config',
    '\theader *pb.ResponseHeader',
    '}',
    '',
    'func (c *Client) Header() *pb.ResponseHeader { return c.header }',
    '',
    'func dial(c *Client) {}',
    '',
  ].join('\n'),
  // Package clientv3, known to the index by its path (`v3`, `client`) only.
  'client/v3/ordering/kv.go': [
    'package ordering',
    '',
    'import "go.etcd.io/etcd/client/v3"',
    '',
    'type Op struct{}',
    '',
    'type kvOrdering struct {',
    '\tkv clientv3.Client',
    '\top clientv3.Op',
    '}',
    '',
  ].join('\n'),
  'gin/gin.go': [
    'package gin',
    '',
    'import "sync"',
    '',
    'type HandlerFunc func(*Context)',
    '',
    'type HandlersChain []HandlerFunc',
    '',
    'type Context struct {',
    '\thandlers HandlersChain',
    '\tengine   *Engine',
    '}',
    '',
    'type Engine struct {',
    '\tpool  sync.Pool',
    '\ttrees methodTrees',
    '}',
    '',
    'type methodTrees []methodTree',
    '',
    'type methodTree struct {',
    '\tmethod string',
    '\troot   *node',
    '}',
    '',
    'type node struct {',
    '\tchildren []*node',
    '\thandlers HandlersChain',
    '}',
    '',
    'func (engine *Engine) handle(c *Context) {}',
    '',
  ].join('\n'),
  'pkg/adt/list.go': [
    'package adt',
    '',
    '// A namesake of the type parameter in its own package.',
    'type T struct{}',
    '',
    'type List[T any] struct {',
    '\titems []T',
    '\thead  *elem[T]',
    '}',
    '',
    'type elem[T any] struct {',
    '\tnext *elem[T]',
    '\tval  T',
    '}',
    '',
  ].join('\n'),
};

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('an indexed Go module links its struct fields’ types (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-fields-'));
    for (const [rel, content] of Object.entries(MODULE)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), eol === 'CRLF' ? content.replace(/\n/g, '\r\n') : content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  const nodeNamed = (file: string, name: string) => {
    const nodes = cg!.getNodesInFile(file).filter((n) => n.name === name && n.kind !== 'import');
    expect(nodes, `${name} in ${file}`).toHaveLength(1);
    return nodes[0]!;
  };

  /** `kind file:qualifiedName` of each non-contains edge out of `name` in `file`, sorted. */
  const linksFrom = (file: string, name: string) => {
    const links = cg!.getOutgoingEdgesFrom([nodeNamed(file, name).id])
      .filter((e) => e.kind !== 'contains')
      .map((e) => ({ kind: e.kind, target: cg!.getNode(e.target)! }))
      .map(({ kind, target }) => `${kind} ${target.filePath}:${target.qualifiedName}`);
    return [...new Set(links)].sort();
  };

  /** `kind name` of each reference out of `name` in `file` that resolution left unresolved, sorted. */
  const unresolvedFrom = (file: string, name: string) =>
    cg!.getUnresolvedReferencesFrom(nodeNamed(file, name).id).map((r) => `${r.referenceKind} ${r.referenceName}`).sort();

  /** `file:qualifiedName` of every node impact on `name` in `file` reaches, sorted. */
  const impactOf = (file: string, name: string) =>
    [...cg!.getImpactRadius(nodeNamed(file, name).id, 3).nodes.values()].map((n) => `${n.filePath}:${n.qualifiedName}`).sort();

  it('a struct references the types its fields name, each in its own package', () => {
    expect(linksFrom('api/v3/etcdserverpb/rpc.pb.go', 'PutResponse')).toEqual([
      'references api/v3/etcdserverpb/rpc.pb.go:ResponseHeader',
    ]);
    expect(linksFrom('api/v3/etcdserverpb/rpc.pb.go', 'RangeResponse')).toEqual([
      'references api/v3/etcdserverpb/rpc.pb.go:ResponseHeader',
      'references api/v3/mvccpb/kv.pb.go:KeyValue',
    ]);
    expect(linksFrom('gin/gin.go', 'Context')).toEqual([
      'references gin/gin.go:Engine',
      'references gin/gin.go:HandlersChain',
    ]);
    expect(linksFrom('gin/gin.go', 'methodTree')).toEqual(['references gin/gin.go:node']);
  });

  it('a name written through an import is that package’s type, and through an outside package nothing', () => {
    // `context.Context` is neither the same file's Context nor alpha's.
    expect(linksFrom('client/v3/client.go', 'Client')).toEqual([
      'references api/v3/etcdserverpb/rpc.pb.go:ResponseHeader',
      'references client/v3/client.go:Config',
    ]);
    expect(unresolvedFrom('client/v3/client.go', 'Client')).toEqual(['references Context']);
    // `sync.Pool` is no project type.
    expect(linksFrom('gin/gin.go', 'Engine')).toEqual(['references gin/gin.go:methodTrees']);
  });

  it('a struct naming itself has no edge to itself and no unresolved row for its name', () => {
    expect(linksFrom('gin/gin.go', 'node')).toEqual(['references gin/gin.go:HandlersChain']);
    expect(unresolvedFrom('gin/gin.go', 'node')).toEqual([]);
  });

  it('an embedded generic is a supertype, and the types it is instantiated with references', () => {
    expect(linksFrom('k8s/client-go/listers/core/v1/pod.go', 'podLister')).toEqual([
      'extends k8s/client-go/listers/generic.go:ResourceIndexer',
      'references k8s/api/core/v1/types.go:Pod',
    ]);
    expect(impactOf('k8s/api/core/v1/types.go', 'Pod')).toEqual([
      'k8s/api/core/v1/types.go:Pod',
      'k8s/client-go/listers/core/v1/pod.go:podLister',
    ]);
  });

  it('a generic struct’s own type parameters are no types it references', () => {
    expect(linksFrom('pkg/adt/list.go', 'List')).toEqual(['references pkg/adt/list.go:elem']);
    expect(linksFrom('pkg/adt/list.go', 'elem')).toEqual([]);
    expect(unresolvedFrom('pkg/adt/list.go', 'List')).toEqual([]);
    expect(unresolvedFrom('pkg/adt/list.go', 'elem')).toEqual([]);
  });

  it('a name written through a package the index does not know links to nothing', () => {
    expect(linksFrom('client/v3/ordering/kv.go', 'kvOrdering')).toEqual([]);
    expect(unresolvedFrom('client/v3/ordering/kv.go', 'kvOrdering')).toEqual(['references Client', 'references Op']);
  });

  it('impact on a type reaches the structs that hold it, and their users', () => {
    expect(impactOf('api/v3/etcdserverpb/rpc.pb.go', 'ResponseHeader')).toEqual([
      'api/v3/etcdserverpb/rpc.pb.go:PutResponse',
      'api/v3/etcdserverpb/rpc.pb.go:RangeResponse',
      'api/v3/etcdserverpb/rpc.pb.go:ResponseHeader',
      'client/v3/client.go:Client',
      'client/v3/client.go:Client::Header',
      'client/v3/client.go:dial',
    ]);
    expect(impactOf('gin/gin.go', 'HandlersChain')).toEqual([
      'gin/gin.go:Context',
      'gin/gin.go:Engine::handle',
      'gin/gin.go:HandlerFunc',
      'gin/gin.go:HandlersChain',
      'gin/gin.go:methodTree',
      'gin/gin.go:methodTrees',
      'gin/gin.go:node',
    ]);
  });

  it('no Go field is a node', () => {
    for (const file of Object.keys(MODULE).filter((f) => f.endsWith('.go'))) {
      expect(cg!.getNodesInFile(file).filter((n) => n.kind === 'field'), file).toEqual([]);
    }
  });
});

describe.each(['default', 'wasm'])('a field’s type declared after the index links on sync (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-fields-sync-'));
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n\ngo 1.24\n');
    fs.mkdirSync(path.join(root, 'store'));
    fs.writeFileSync(path.join(root, 'store', 'store.go'), 'package store\n\ntype Store struct {\n\tidx *Index\n}\n');
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it('links the struct to the type once its file is added', async () => {
    const store = () => cg!.getNodesInFile('store/store.go').find((n) => n.name === 'Store')!;
    expect(cg!.getOutgoingEdgesFrom([store().id]).filter((e) => e.kind === 'references')).toEqual([]);
    fs.writeFileSync(path.join(root, 'store', 'index.go'), 'package store\n\ntype Index struct{}\n');
    await cg!.sync();
    const targets = cg!.getOutgoingEdgesFrom([store().id])
      .filter((e) => e.kind === 'references')
      .map((e) => `${cg!.getNode(e.target)!.filePath}:${cg!.getNode(e.target)!.name}`);
    expect(targets).toEqual(['store/index.go:Index']);
  }, 60_000);
});
