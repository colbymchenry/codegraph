/**
 * A Go defined type (`type WatchChan <-chan WatchResponse`, gin's `type
 * HandlerFunc func(*Context)` and `type HandlersChain []HandlerFunc`) is a
 * `type_alias` node, and it referenced nothing: only an alias (`type A = B`)
 * named the types on its right-hand side. Impact on `WatchResponse` or gin's
 * `Context` missed the declarations built from them, and everything that uses
 * those.
 *
 * A defined type now references each type its right-hand side names, as an
 * alias does: on the type's name, where resolution reads a package qualifier
 * back, without its own type parameters or Go's predeclared types. Written
 * bare, its own name is the declaration itself (`type stateFn func(*Lexer)
 * stateFn`), which a recursive type names without depending on anything: no
 * reference, so neither a self-edge nor an unresolved row for the name.
 *
 * Resolution reads the reference as any type position: a bare name is its own
 * package's type, `pb.PutResponse` the import's, and a name written through a
 * package the index doesn't know links to nothing. A defined type is a new
 * type, though: unlike an alias, it does not have its underlying type's
 * methods, so a method called on one is not looked up there.
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

/** Every right-hand side a defined type can have, beside the types it names. */
const DEFINED_SOURCE = `package gin

import (
	"context"

	"github.com/gin-gonic/gin/render"
)

// HandlerFunc defines the handler used by gin middleware as return value.
type HandlerFunc func(*Context)

// HandlersChain defines a HandlerFunc slice.
type HandlersChain []HandlerFunc

type Context struct {
	handlers HandlersChain
}

type WatchChan <-chan WatchResponse

type WatchResponse struct{}

type (
	// Render names another package's type of its own name.
	Render   render.Render
	Lookup   map[Key]*WatchResponse
	Grid     [4][4]Cell
	Pipeline func(ctx context.Context, in <-chan Cell) (Key, error)
	Wrapped  (Cell)
	Named    Cell
	Tables   map[string]struct {
		cell Cell
		*Key
	}
)

type Generic[T any] List[T]

type Pair[K comparable, V any] map[K]List[V]

type stateFn func(*Lexer) stateFn

type Tree []*Tree

type List[T any] struct {
	items []T
}

type Cell struct{}

type Key string

type Dur int

type Mode uint8

type Lexer struct{}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<kind> <name>` of every node but the file and its imports, in source order. */
function declarations(result: ExtractionResult): string[] {
  return result.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'import').map((n) => `${n.kind} ${n.name}`);
}

/** `<source> <name>` for every `references` ref out of a type declaration, sorted. */
function typeRefs(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'references' && ['type_alias', 'struct', 'interface'].includes(byId.get(r.fromNodeId)?.kind ?? ''))
    .map((r) => `${byId.get(r.fromNodeId)!.name} ${r.referenceName}`)
    .sort();
}

describe('a Go defined type references the types it is defined from', () => {
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

    it.each(backends)(`a defined type is still one type_alias node: %s${label}`, (backend) => {
      const result = extract(backend, 'gin.go', eol(DEFINED_SOURCE));
      expect(declarations(result)).toEqual([
        'type_alias HandlerFunc',
        'type_alias HandlersChain',
        'struct Context',
        'type_alias WatchChan',
        'struct WatchResponse',
        'type_alias Render',
        'type_alias Lookup',
        'type_alias Grid',
        'type_alias Pipeline',
        'type_alias Wrapped',
        'type_alias Named',
        'type_alias Tables',
        'type_alias Generic',
        'type_alias Pair',
        'type_alias stateFn',
        'type_alias Tree',
        'struct List',
        'struct Cell',
        'type_alias Key',
        'type_alias Dur',
        'type_alias Mode',
        'struct Lexer',
      ]);
    });

    it.each(backends)(`a defined type references each type it names: %s${label}`, (backend) => {
      const source = eol(DEFINED_SOURCE);
      const result = extract(backend, 'gin.go', source);
      // A qualified name keeps its package in the source (`render.Render`,
      // `context.Context`). Not referenced: the predeclared types (string,
      // int, uint8, error, comparable), the type parameters T, K and V, and a
      // type's own name written bare (stateFn, Tree).
      expect(typeRefs(result)).toEqual([
        'Generic List',
        'Grid Cell',
        'HandlerFunc Context',
        'HandlersChain HandlerFunc',
        'Lookup Key',
        'Lookup WatchResponse',
        'Named Cell',
        'Pair List',
        'Pipeline Cell',
        'Pipeline Context',
        'Pipeline Key',
        'Render Render',
        'Tables Cell',
        'Tables Key',
        'WatchChan WatchResponse',
        'Wrapped Cell',
        'stateFn Lexer',
      ]);
      // Each sits on its name, where resolution reads the qualifier back.
      const lines = source.split(/\r?\n/);
      for (const r of result.unresolvedReferences.filter((u) => u.referenceKind === 'references')) {
        expect(lines[r.line - 1]!.startsWith(r.referenceName, r.column), `${r.referenceName} at ${r.line}:${r.column}`).toBe(true);
      }
      const render = result.unresolvedReferences.find((r) => r.referenceName === 'Render')!;
      expect(lines[render.line - 1]!.slice(0, render.column).trimStart()).toBe('Render   render.');
    });
  }
});

/** The module of the indexed tests: etcd's and gin's shapes, with namesakes in a package that sorts first. */
const MODULE: Record<string, string> = {
  'go.mod': 'module go.etcd.io/etcd\n\ngo 1.24\n',
  'api/v3/etcdserverpb/rpc.pb.go': [
    'package etcdserverpb',
    '',
    'type PutResponse struct {',
    '\tHeader *ResponseHeader',
    '}',
    '',
    'type ResponseHeader struct{}',
    '',
    'func (m *PutResponse) GetHeader() *ResponseHeader { return m.Header }',
    '',
  ].join('\n'),
  // A lookup by name meets these first.
  'alpha/names.go': [
    'package alpha',
    '',
    'type PutResponse struct{}',
    '',
    'func (m *PutResponse) GetHeader() int { return 0 }',
    '',
    'type WatchResponse struct{}',
    '',
    'type Context struct{}',
    '',
    'type Op struct{}',
    '',
    'type watcher struct{}',
    '',
  ].join('\n'),
  'client/v3/watch.go': [
    'package clientv3',
    '',
    'import pb "go.etcd.io/etcd/api/v3/etcdserverpb"',
    '',
    'type PutResponse pb.PutResponse',
    '',
    'type WatchChan <-chan WatchResponse',
    '',
    'type WatchResponse struct {',
    '\tCanceled bool',
    '}',
    '',
    'type Op struct{}',
    '',
    'type watcher struct{}',
    '',
    'func (w *watcher) Watch() WatchChan { return nil }',
    '',
    'func header(r *PutResponse) { r.GetHeader() }',
    '',
    'type stateFn func(*watcher) stateFn',
    '',
  ].join('\n'),
  // Package clientv3, known to the index by its path (`v3`, `client`) only.
  'client/v3/ordering/util.go': [
    'package ordering',
    '',
    'import "go.etcd.io/etcd/client/v3"',
    '',
    'type OrderViolationFunc func(op clientv3.Op) error',
    '',
  ].join('\n'),
  'gin/gin.go': [
    'package gin',
    '',
    'type HandlerFunc func(*Context)',
    '',
    'type HandlersChain []HandlerFunc',
    '',
    'type Context struct {',
    '\thandlers HandlersChain',
    '}',
    '',
    'type Engine struct{}',
    '',
    'func (engine *Engine) Use(middleware ...HandlerFunc) {}',
    '',
  ].join('\n'),
};

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('an indexed Go module links its defined types (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-defined-'));
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

  /** `file:qualifiedName` of every node impact on `name` in `file` reaches, sorted. */
  const impactOf = (file: string, name: string) =>
    [...cg!.getImpactRadius(nodeNamed(file, name).id, 3).nodes.values()].map((n) => `${n.filePath}:${n.qualifiedName}`).sort();

  it('a defined type references the types it names, each in its own package', () => {
    expect(linksFrom('client/v3/watch.go', 'WatchChan')).toEqual(['references client/v3/watch.go:WatchResponse']);
    expect(linksFrom('gin/gin.go', 'HandlerFunc')).toEqual(['references gin/gin.go:Context']);
    expect(linksFrom('gin/gin.go', 'HandlersChain')).toEqual(['references gin/gin.go:HandlerFunc']);
  });

  it('a name written through an import is that package’s type, not the declaration of its name', () => {
    expect(linksFrom('client/v3/watch.go', 'PutResponse')).toEqual(['references api/v3/etcdserverpb/rpc.pb.go:PutResponse']);
  });

  it('a recursive defined type has no edge to itself and no unresolved row for its name', () => {
    expect(linksFrom('client/v3/watch.go', 'stateFn')).toEqual(['references client/v3/watch.go:watcher']);
    expect(cg!.getUnresolvedReferencesFrom(nodeNamed('client/v3/watch.go', 'stateFn').id)).toEqual([]);
  });

  it('a name written through a package the index does not know links to nothing', () => {
    expect(linksFrom('client/v3/ordering/util.go', 'OrderViolationFunc')).toEqual([]);
    const refs = cg!.getUnresolvedReferencesFrom(nodeNamed('client/v3/ordering/util.go', 'OrderViolationFunc').id);
    expect(refs.map((r) => `${r.referenceKind} ${r.referenceName}`)).toEqual(['references Op']);
  });

  it('a defined type does not have its underlying type’s methods', () => {
    // `r.GetHeader()` on a PutResponse defined from pb.PutResponse: Go has no
    // such method, so neither pb's nor alpha's is the callee.
    expect(linksFrom('client/v3/watch.go', 'header')).toEqual(['references client/v3/watch.go:PutResponse']);
  });

  it('impact on a type reaches the defined types built from it, and their users', () => {
    expect(impactOf('client/v3/watch.go', 'WatchResponse')).toEqual([
      'client/v3/watch.go:WatchChan',
      'client/v3/watch.go:WatchResponse',
      'client/v3/watch.go:watcher::Watch',
    ]);
    expect(impactOf('gin/gin.go', 'Context')).toEqual([
      'gin/gin.go:Context',
      'gin/gin.go:Engine::Use',
      'gin/gin.go:HandlerFunc',
      'gin/gin.go:HandlersChain',
    ]);
  });
});
