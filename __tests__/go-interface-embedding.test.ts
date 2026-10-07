/**
 * Go interface embedding produced no supertype edge in either extractor:
 *
 *   type IRouter interface {     // gin-gonic/gin: IRouter never reached IRoutes
 *     IRoutes
 *     Group(string, ...HandlerFunc) *RouterGroup
 *   }
 *
 * extractInheritance looked for a `constraint_elem`, a node type that neither
 * the vendored tree-sitter-go wasm nor the kernel's grammar crate has. Both
 * parse an embedded interface as a `type_elem` holding one type: a
 * `type_identifier` for `IRoutes`, a `qualified_type` for `io.Closer`. A
 * `type_elem` is also how a type-set constraint is written (`~int | ~string`,
 * `float32 | float64`, a lone `int64`), and a constraint is no supertype.
 *
 * An embedded type is now read the same way in an interface and in a struct:
 * `T`, `*T`, `pkg.T` and `T[X]` all embed `T`, recorded at the name itself so
 * resolution reads the package back from the source. `storage.LabelQuerier`
 * reaches that package's interface; `io.Closer` and `sync.Mutex` stay
 * unresolved rather than landing on a project type that shares the name.
 * Go's predeclared types are never recorded: `int64` is a constraint's term,
 * and `error`, `any` and `comparable` exist in no graph. Runs against the
 * native kernel (when built) and the wasm extractor, which must agree.
 *
 * Resolution keeps an embedded type in its package. A bare name is its own
 * package's type, not another package's struct of that name, which the Go
 * framework heuristics preferred (promql/parser's `Node` interface, etcd's
 * `Lease`). A package that is none of the file's imports as indexed (`yaml`
 * under an unaliased `go.yaml.in/yaml/v3`) leaves the type unresolved.
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
import type { ExtractionResult, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

/** Embedded interfaces of every shape, beside constraints that embed nothing. */
const INTERFACE_SOURCE = `package store

import (
	"io"

	"example.com/app/storage"
)

type Queryable interface{ Q() }

type Querier interface {
	Queryable
	io.Closer
	storage.LabelQuerier // a project package's interface
	Select(sorted bool) int
}

type Lister[T any] interface{ List() []T }

type Pager interface {
	Lister[int]
	Page() int
}

type Timeout interface {
	error
	Timeout() bool
}

type Number interface {
	~int | ~float64
}

type Float interface{ float32 | float64 }

type Exact interface{ int64 }

type Text interface{ ~string }

type Ordered interface {
	Number | Float | ~string
}
`;

/** gin-gonic/gin's router interfaces. */
const GIN_SOURCE = `package gin

type HandlerFunc func(*Context)

type IRoutes interface {
	Use(...HandlerFunc) IRoutes
	Handle(string, string, ...HandlerFunc) IRoutes
}

type IRouter interface {
	IRoutes
	Group(string, ...HandlerFunc) *RouterGroup
}
`;

/** Struct embedding takes the same shapes, and keeps its named fields out. */
const STRUCT_SOURCE = `package store

import (
	"sync"

	"example.com/app/storage"
)

type Store struct {
	*Engine
	Reader
	sync.Mutex
	*storage.Base
	List[int]
	error
	name   string
	engine *Engine
	items  []storage.Base
}
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

describe('Go embedded types are supertypes', () => {
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

  /** Every supertype ref sits on its name, where resolution reads a package qualifier back. */
  function expectRefsOnTheirNames(result: ExtractionResult, source: string): void {
    const lines = source.split(/\r?\n/);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(lines[r.line - 1]!.startsWith(r.referenceName, r.column), `${r.referenceName} at ${r.line}:${r.column}`).toBe(true);
    }
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`an embedded interface extends; a constraint does not: %s${label}`, (backend) => {
      const source = eol(INTERFACE_SOURCE);
      const result = extract(backend, 'store/querier.go', source);
      expect(result.nodes.filter((n) => n.kind === 'interface').map((n) => n.name).sort()).toEqual(
        ['Exact', 'Float', 'Lister', 'Number', 'Ordered', 'Pager', 'Querier', 'Queryable', 'Text', 'Timeout']
      );
      expect(supertypeRefs(result)).toEqual([
        'Pager extends Lister',
        'Querier extends Closer',
        'Querier extends LabelQuerier',
        'Querier extends Queryable',
      ]);
      expectRefsOnTheirNames(result, source);
      // The interfaces' own methods are still its members, the embeddings are not.
      const querier = result.nodes.find((n) => n.name === 'Querier')!;
      const members = result.edges
        .filter((e) => e.kind === 'contains' && e.source === querier.id)
        .map((e) => result.nodes.find((n) => n.id === e.target)?.name);
      expect(members).toEqual(['Select']);
    });

    it.each(backends)(`gin's IRouter extends IRoutes: %s${label}`, (backend) => {
      const result = extract(backend, 'routergroup.go', eol(GIN_SOURCE));
      expect(supertypeRefs(result)).toEqual(['IRouter extends IRoutes']);
    });

    it.each(backends)(`an embedded struct field of any shape extends: %s${label}`, (backend) => {
      const source = eol(STRUCT_SOURCE);
      const result = extract(backend, 'store/store.go', source);
      expect(supertypeRefs(result)).toEqual([
        'Store extends Base',
        'Store extends Engine',
        'Store extends List',
        'Store extends Mutex',
        'Store extends Reader',
      ]);
      expectRefsOnTheirNames(result, source);
    });
  }
});

describe('the type hierarchy of an indexed Go module', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('links embedded interfaces and structs to the package that declares them', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-embedding-'));
    const files: Record<string, string> = {
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'storage/storage.go': [
        'package storage',
        '',
        'type LabelQuerier interface {',
        '\tLabelValues(name string) []string',
        '}',
        '',
        'type Base struct{}',
        '',
        'func (b *Base) Close() error { return nil }',
        '',
      ].join('\n'),
      // Named like io.Closer, io.Reader, sync.Mutex and yaml.Node: never what those name.
      'other/other.go': [
        'package other',
        '',
        'type Closer interface{ Close() error }',
        '',
        'type Mutex struct{}',
        '',
        'type Reader interface{ Read(p []byte) (int, error) }',
        '',
        'type Node struct{}',
        '',
      ].join('\n'),
      'store/store.go': [
        'package store',
        '',
        'import (',
        '\t"io"',
        '\t"sync"',
        '',
        '\t"example.com/app/storage"',
        '\t"go.yaml.in/yaml/v3"',
        ')',
        '',
        '// The package is yaml, though the index knows its import as v3.',
        'type RuleGroupNode struct {',
        '\tyaml.Node',
        '\tName string',
        '}',
        '',
        'type Queryable interface{ Q() }',
        '',
        'type Querier interface {',
        '\tQueryable',
        '\tio.Closer',
        '\tstorage.LabelQuerier',
        '\tSelect(sorted bool) int',
        '}',
        '',
        'type Number interface {',
        '\t~int | ~float64',
        '}',
        '',
        'type Engine struct{}',
        '',
        'type Reader interface{ Read() }',
        '',
        'type List[T any] struct{ items []T }',
        '',
        'type Store struct {',
        '\t*Engine',
        '\tReader',
        '\tsync.Mutex',
        '\t*storage.Base',
        '\tList[int]',
        '}',
        '',
      ].join('\n'),
      // Named like the io.Reader it embeds.
      'wrap/wrap.go': [
        'package wrap',
        '',
        'import "io"',
        '',
        'type Reader interface {',
        '\tio.Reader',
        '\tPeek() byte',
        '}',
        '',
      ].join('\n'),
      'gin/routergroup.go': GIN_SOURCE,
      // prometheus's promql/parser: its own `Node` interface, while other/ has a `Node` struct.
      'parser/ast.go': [
        'package parser',
        '',
        'type Node interface{ String() string }',
        '',
        'type Expr interface {',
        '\tNode',
        '\tType() string',
        '}',
        '',
        'type exprWrapper struct {',
        '\tNode',
        '}',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;

    const one = (name: string, file: string): Node => {
      const found = graph.getNodesByName(name).filter((n) => n.filePath === file && n.kind !== 'import');
      expect(found, `${name} in ${file}`).toHaveLength(1);
      return found[0]!;
    };
    const where = (n: Node | null) => `${n?.name}@${n?.filePath}`;

    const sources = [
      one('Querier', 'store/store.go'),
      one('Number', 'store/store.go'),
      one('Store', 'store/store.go'),
      one('RuleGroupNode', 'store/store.go'),
      one('Reader', 'wrap/wrap.go'),
      one('IRouter', 'gin/routergroup.go'),
      one('Expr', 'parser/ast.go'),
      one('exprWrapper', 'parser/ast.go'),
    ];
    // Declared edges only: Store also satisfies other.Closer with the Close
    // that storage.Base promotes, which go-implements synthesizes from names.
    const supertypes = graph
      .getOutgoingEdgesFrom(sources.map((n) => n.id), ['extends', 'implements'])
      .filter((e) => e.provenance !== 'heuristic')
      .map((e) => `${graph.getNode(e.source)?.name} ${e.kind} ${where(graph.getNode(e.target))}`)
      .sort();
    // An embedded interface of a struct resolves as `implements`; one of an
    // interface stays `extends`. io.Closer, sync.Mutex, io.Reader and yaml.Node
    // are outside the project, so nothing named like them is linked. A bare
    // name is its own package's type, whatever kind another package's is.
    expect(supertypes).toEqual([
      'Expr extends Node@parser/ast.go',
      'IRouter extends IRoutes@gin/routergroup.go',
      'Querier extends LabelQuerier@storage/storage.go',
      'Querier extends Queryable@store/store.go',
      'Store extends Base@storage/storage.go',
      'Store extends Engine@store/store.go',
      'Store extends List@store/store.go',
      'Store implements Reader@store/store.go',
      'exprWrapper implements Node@parser/ast.go',
    ]);

    // The outside supertypes are kept as unresolved references, not dropped.
    const unresolved = (n: Node) =>
      graph
        .getUnresolvedReferencesFrom(n.id)
        .filter((r) => r.referenceKind === 'extends')
        .map((r) => r.referenceName)
        .sort();
    expect(unresolved(one('Querier', 'store/store.go'))).toEqual(['Closer']);
    expect(unresolved(one('Store', 'store/store.go'))).toEqual(['Mutex']);
    expect(unresolved(one('RuleGroupNode', 'store/store.go'))).toEqual(['Node']);
    expect(unresolved(one('Reader', 'wrap/wrap.go'))).toEqual(['Reader']);

    // What the viewer's Type hierarchy and codegraph_explore read. Declared
    // subtypes only: Go's implicit-satisfaction edges are synthesized from
    // method names (Base's Close() satisfies other.Closer) and drawn apart.
    const subtypes = (n: Node) =>
      (buildTypeHierarchy(graph, n)?.descendants ?? [])
        .filter((d) => !d.synthesized)
        .map((d) => `${d.relation} ${where(d.node)}`);
    expect(subtypes(one('IRoutes', 'gin/routergroup.go'))).toEqual(['extends IRouter@gin/routergroup.go']);
    expect(subtypes(one('LabelQuerier', 'storage/storage.go'))).toEqual(['extends Querier@store/store.go']);
    expect(subtypes(one('Base', 'storage/storage.go'))).toEqual(['extends Store@store/store.go']);
    const declaredInto = graph
      .getIncomingEdgesTo(['Closer', 'Mutex', 'Reader', 'Node'].map((name) => one(name, 'other/other.go').id), ['extends', 'implements'])
      .filter((e) => e.provenance !== 'heuristic');
    expect(declaredInto).toEqual([]);
    expect(
      (buildTypeHierarchy(graph, one('IRouter', 'gin/routergroup.go'))?.ancestors ?? []).map((a) => `${a.relation} ${where(a.node)}`)
    ).toEqual(['extends IRoutes@gin/routergroup.go']);
  }, 60_000);
});
