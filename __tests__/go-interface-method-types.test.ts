/**
 * A Go interface's methods are `method` nodes, and their signatures named no
 * types: etcd's `KV.Put(ctx context.Context, key, val string, opts
 * ...OpOption) (*PutResponse, error)` had no edge to `OpOption` or
 * `PutResponse`. A call through the interface reaches that method, so impact
 * on `PutResponse` missed the interface method and every caller that goes
 * through it — the usual way Go code calls a dependency.
 *
 * An interface method now references each type its parameters and results
 * name, as a function does, on the name. Not references: Go's predeclared
 * types, and the interface's own type parameters written bare (`T` in
 * `type Store[T any] interface { Get(string) (T, error) }`). The interface's
 * own name is a type its method names (`Children() []Node`).
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

/** Every shape an interface method's signature can take. */
const IFACE_SOURCE = `package clientv3

import (
	"context"

	pb "go.etcd.io/etcd/api/v3/etcdserverpb"
)

type KV interface {
	// Put puts a key-value pair into etcd.
	Put(ctx context.Context, key, val string, opts ...OpOption) (*PutResponse, error)
	Get(ctx context.Context, key string, opts ...OpOption) (*GetResponse, error)
	Do(ctx context.Context, op Op) (OpResponse, error)
	Txn(ctx context.Context) Txn
	Close() error
	Header() *pb.ResponseHeader
	Watch(fn func(Event) bool, ch chan<- []Event, filters map[string]Filter) (<-chan WatchResponse, int64)
}

type Store[T any, K comparable] interface {
	Get(key K) (T, bool)
	Put(key K, value T) Store[T, K]
	Fetch(item Item[T]) any
}

type Node interface {
	Children() []Node
	Name() string
}

type Embedding interface {
	KV
	Lease
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<Interface::method> <name>` for every `references` ref out of a method, sorted. */
function methodRefs(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'references' && byId.get(r.fromNodeId)?.kind === 'method')
    .map((r) => `${byId.get(r.fromNodeId)!.qualifiedName} ${r.referenceName}`)
    .sort();
}

describe('a Go interface method references the types its signature names', () => {
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

    it.each(backends)(`each method references the types of its parameters and results: %s${label}`, (backend) => {
      const source = eol(IFACE_SOURCE);
      const result = extract(backend, 'kv.go', source);
      // Not references: string, error, bool, int64, any; Store's own type
      // parameters T and K; the embedded KV and Lease, which are its supertypes.
      expect(methodRefs(result)).toEqual([
        'KV::Do Context',
        'KV::Do Op',
        'KV::Do OpResponse',
        'KV::Get Context',
        'KV::Get GetResponse',
        'KV::Get OpOption',
        'KV::Header ResponseHeader',
        'KV::Put Context',
        'KV::Put OpOption',
        'KV::Put PutResponse',
        'KV::Txn Context',
        'KV::Txn Txn',
        'KV::Watch Event',
        'KV::Watch Event',
        'KV::Watch Filter',
        'KV::Watch WatchResponse',
        'Node::Children Node',
        'Store::Fetch Item',
        'Store::Put Store',
      ]);
      // Each sits on its name, where resolution reads a package qualifier back.
      const lines = source.split(/\r?\n/);
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      for (const r of result.unresolvedReferences.filter((u) => u.referenceKind === 'references' && byId.get(u.fromNodeId)?.kind === 'method')) {
        expect(lines[r.line - 1]!.startsWith(r.referenceName, r.column), `${r.referenceName} at ${r.line}:${r.column}`).toBe(true);
      }
    });

    it.each(backends)(`the methods are still the interface's, and embeddings still its supertypes: %s${label}`, (backend) => {
      const result = extract(backend, 'kv.go', eol(IFACE_SOURCE));
      expect(result.nodes.filter((n) => n.kind === 'method').map((n) => n.qualifiedName)).toEqual([
        'KV::Put', 'KV::Get', 'KV::Do', 'KV::Txn', 'KV::Close', 'KV::Header', 'KV::Watch',
        'Store::Get', 'Store::Put', 'Store::Fetch',
        'Node::Children', 'Node::Name',
      ]);
      const embedding = result.nodes.find((n) => n.name === 'Embedding')!;
      expect(result.unresolvedReferences.filter((r) => r.fromNodeId === embedding.id)
        .map((r) => `${r.referenceKind} ${r.referenceName}`)).toEqual(['extends KV', 'extends Lease']);
    });
  }
});

/** etcd's shape, with namesakes in a package that sorts first. */
const MODULE: Record<string, string> = {
  'go.mod': 'module go.etcd.io/etcd\n\ngo 1.24\n',
  'alpha/names.go': [
    'package alpha',
    '',
    'type OpOption struct{}',
    '',
    'type PutResponse struct{}',
    '',
    'type T struct{}',
    '',
  ].join('\n'),
  'api/v3/etcdserverpb/rpc.pb.go': [
    'package etcdserverpb',
    '',
    'type ResponseHeader struct{}',
    '',
  ].join('\n'),
  'client/v3/kv.go': [
    'package clientv3',
    '',
    'import (',
    '\t"context"',
    '',
    '\tpb "go.etcd.io/etcd/api/v3/etcdserverpb"',
    ')',
    '',
    'type PutResponse struct {',
    '\tHeader *pb.ResponseHeader',
    '}',
    '',
    'type Op struct{}',
    '',
    'type OpOption func(*Op)',
    '',
    'type KV interface {',
    '\tPut(ctx context.Context, key, val string, opts ...OpOption) (*PutResponse, error)',
    '}',
    '',
    'type T struct{}',
    '',
    'type Getter[T any] interface {',
    '\tGet(key string) (T, error)',
    '}',
    '',
  ].join('\n'),
  'server/store.go': [
    'package server',
    '',
    'import (',
    '\t"context"',
    '',
    '\tclientv3 "go.etcd.io/etcd/client/v3"',
    ')',
    '',
    'func save(ctx context.Context, kv clientv3.KV) {',
    '\tkv.Put(ctx, "k", "v")',
    '}',
    '',
  ].join('\n'),
};

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('an indexed Go module links its interface methods’ types (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-iface-'));
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

  const nodeNamed = (file: string, qualifiedName: string) => {
    const nodes = cg!.getNodesInFile(file).filter((n) => n.qualifiedName === qualifiedName && n.kind !== 'import');
    expect(nodes, `${qualifiedName} in ${file}`).toHaveLength(1);
    return nodes[0]!;
  };

  const linksFrom = (file: string, qualifiedName: string) =>
    cg!.getOutgoingEdgesFrom([nodeNamed(file, qualifiedName).id])
      .filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${cg!.getNode(e.target)!.filePath}:${cg!.getNode(e.target)!.name}`)
      .sort();

  const impactOf = (file: string, qualifiedName: string) =>
    [...cg!.getImpactRadius(nodeNamed(file, qualifiedName).id, 3).nodes.values()].map((n) => `${n.filePath}:${n.qualifiedName}`).sort();

  it('an interface method references its own package’s types, and nothing for an outside package', () => {
    // `context.Context` is outside the project; alpha's namesakes sort first.
    expect(linksFrom('client/v3/kv.go', 'KV::Put')).toEqual([
      'references client/v3/kv.go:OpOption',
      'references client/v3/kv.go:PutResponse',
    ]);
  });

  it('a generic interface’s own type parameter is no type its method references', () => {
    expect(linksFrom('client/v3/kv.go', 'Getter::Get')).toEqual([]);
    expect(cg!.getUnresolvedReferencesFrom(nodeNamed('client/v3/kv.go', 'Getter::Get').id)).toEqual([]);
  });

  it('impact on a type reaches the interface methods that name it, and the callers that go through them', () => {
    expect(impactOf('client/v3/kv.go', 'OpOption')).toEqual([
      'client/v3/kv.go:KV::Put',
      'client/v3/kv.go:OpOption',
      'server/store.go:save',
    ]);
  });
});
