/**
 * Go's implicit interface satisfaction (#584) compares method sets, and in Go
 * both sides include what embedding brings in:
 *
 *   type AuthReadTx interface {   // etcd's server/auth/store.go
 *     RLock()
 *     RUnlock()
 *     UnsafeAuthReader            // UnsafeReadAuthEnabled, UnsafeGetUser, …
 *   }
 *
 *   type blockQuerier struct {    // Select of its own; LabelValues, LabelNames
 *     *storage.BaseQuerier        // and Close promoted from BaseQuerier
 *   }
 *
 * goImplementsEdges read each type's own methods only. AuthReadTx asked for
 * RLock and RUnlock, so etcd's RWMutex "implemented" it, and an interface
 * that only embeds others (`ChunkQuerier { LabelQuerier }`) asked for nothing
 * and was skipped. Embedded interfaces are `extends` edges now, embedded
 * structs `extends` and embedded interfaces of a struct `implements`, so both
 * method sets follow those declared edges, however deep and around cycles.
 * Reading only the interface side would have dropped every struct that
 * satisfies an interface through promoted methods, like blockQuerier.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import type { Edge, Node } from '../src/types';

const FLEET_UNITS = 45;

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // prometheus's storage interfaces.
  'storage/storage.go': `package storage

type LabelQuerier interface {
	LabelValues(name string) []string
	LabelNames() []string
	Close() error
}

type Querier interface {
	LabelQuerier
	Select(sorted bool) int
}

// No method of its own.
type ChunkQuerier interface {
	LabelQuerier
}

// Promotes its methods into every struct that embeds it.
type BaseQuerier struct{}

func (b *BaseQuerier) LabelValues(name string) []string { return nil }
func (b *BaseQuerier) LabelNames() []string            { return nil }
func (b *BaseQuerier) Close() error                    { return nil }

type Appender interface {
	Append(ref uint64, v float64) (uint64, error)
	Commit() error
	Rollback() error
}

type Committer interface {
	Commit() error
	Rollback() error
}
`,
  'tsdb/querier.go': `package tsdb

import "example.com/app/storage"

// A storage.Querier through BaseQuerier's promoted methods and its own Select.
type blockQuerier struct {
	*storage.BaseQuerier
	mint, maxt int64
}

func (q *blockQuerier) Select(sorted bool) int { return 0 }

// Select and nothing else: no Querier.
type exemplarQuerier struct{}

func (e *exemplarQuerier) Select(sorted bool) int { return 0 }

// Embeds the interface it wraps, so it already declares that it is one.
type limitAppender struct {
	storage.Appender
	limit int
}

func (a *limitAppender) Append(ref uint64, v float64) (uint64, error) {
	return a.Appender.Append(ref, v)
}
`,
  // etcd's server/auth/store.go.
  'auth/store.go': `package auth

type UnsafeAuthReader interface {
	UnsafeReadAuthEnabled() bool
	UnsafeGetUser(name string) string
}

type AuthReadTx interface {
	RLock()
	RUnlock()
	UnsafeAuthReader
}

// A lock: no auth reader.
type RWMutex struct{}

func (m *RWMutex) Lock()    {}
func (m *RWMutex) Unlock()  {}
func (m *RWMutex) RLock()   {}
func (m *RWMutex) RUnlock() {}

type authReadTx struct{}

func (t *authReadTx) RLock()                           {}
func (t *authReadTx) RUnlock()                         {}
func (t *authReadTx) UnsafeReadAuthEnabled() bool      { return false }
func (t *authReadTx) UnsafeGetUser(name string) string { return name }
`,
  // gin's router: Engine overrides Use and gets the rest from RouterGroup.
  'gin/gin.go': `package gin

type HandlerFunc func()

type HandlersChain []HandlerFunc

func (c HandlersChain) Last() HandlerFunc { return nil }

type IRoutes interface {
	Use(...HandlerFunc) IRoutes
	GET(string, ...HandlerFunc) IRoutes
}

type IRouter interface {
	IRoutes
	Group(string, ...HandlerFunc) *RouterGroup
}

type RouterGroup struct{ Handlers HandlersChain }

func (g *RouterGroup) Use(...HandlerFunc) IRoutes                { return g }
func (g *RouterGroup) GET(string, ...HandlerFunc) IRoutes        { return g }
func (g *RouterGroup) Group(string, ...HandlerFunc) *RouterGroup { return g }

type Engine struct {
	RouterGroup
	trees []string
}

func (e *Engine) Use(middleware ...HandlerFunc) IRoutes {
	e.RouterGroup.Use(middleware...)
	return e
}

type Chain interface {
	Last() HandlerFunc
	Reset()
}

// Last is promoted from the defined type it embeds.
type routeInfo struct {
	HandlersChain
	path string
}

func (r *routeInfo) Reset() {}
`,
  'cycles/cycles.go': `package cycles

type Walker interface{ Walk() }

// A struct may embed a pointer to itself.
type Node struct {
	*Node
	next *Node
}

func (n *Node) Walk() {}

type Peer interface {
	Send()
	Reply()
}

// Each embeds the other through a pointer, so each has both methods.
type Client struct{ *Server }

type Server struct{ *Client }

func (c *Client) Send()  {}
func (s *Server) Reply() {}

// Not valid Go, but a graph can hold it: each embeds the other.
type Left interface {
	Right
	L()
}

type Right interface {
	Left
	R()
}

type both struct{}

func (both) L() {}
func (both) R() {}
`,
  'empty/empty.go': `package empty

import "io"

type Any interface{}

// Embeds only what the project does not declare: nothing to match.
type Closer interface{ io.Closer }
`,
  // More implementers than the cap: every unit through the base they all
  // embed, and heart, declared after them, with a Beat of its own.
  'fleet/fleet.go': [
    'package fleet',
    '',
    'type Beater interface{ Beat() }',
    '',
    'type Base struct{}',
    '',
    'func (Base) Beat() {}',
    '',
    ...Array.from({ length: FLEET_UNITS }, (_, i) => `type unit${String(i).padStart(2, '0')} struct{ Base }`),
    '',
  ].join('\n'),
  'fleet/heart.go': 'package fleet\n\ntype heart struct{}\n\nfunc (heart) Beat() {}\n',
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-implements-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  cg?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const meta = (e: Edge): Record<string, unknown> => (e.metadata ?? {}) as Record<string, unknown>;
const pkg = (n: Node | null): string => `${path.posix.dirname(n?.filePath ?? '?')}.${n?.name}`;

/** The one non-import node with this name in this file. */
function one(name: string, file: string): Node {
  const found = cg.getNodesByName(name).filter((n) => n.filePath === file && n.kind !== 'import');
  expect(found, `${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** Every synthesized struct → interface edge, as `pkg.Struct -> pkg.Interface`. */
function goImplements(): string[] {
  const structs = cg.getNodesByKind('struct').filter((n) => n.language === 'go');
  return cg
    .getOutgoingEdgesFrom(structs.map((n) => n.id), ['implements'])
    .filter((e) => meta(e).synthesizedBy === 'go-implements')
    .map((e) => `${pkg(cg.getNode(e.source))} -> ${pkg(cg.getNode(e.target))}`)
    .filter((e) => !e.startsWith('fleet.'))
    .sort();
}

describe('Go implicit satisfaction counts embedded methods on both sides', () => {
  it('links exactly the structs whose method set, embeddings included, covers the interface', () => {
    expect(goImplements()).toEqual([
      'auth.authReadTx -> auth.AuthReadTx',
      'auth.authReadTx -> auth.UnsafeAuthReader',
      'cycles.Client -> cycles.Peer',
      'cycles.Node -> cycles.Walker',
      'cycles.Server -> cycles.Peer',
      'cycles.both -> cycles.Left',
      'cycles.both -> cycles.Right',
      'gin.Engine -> gin.IRouter',
      'gin.Engine -> gin.IRoutes',
      'gin.RouterGroup -> gin.IRouter',
      'gin.RouterGroup -> gin.IRoutes',
      'gin.routeInfo -> gin.Chain',
      'storage.BaseQuerier -> storage.ChunkQuerier',
      'storage.BaseQuerier -> storage.LabelQuerier',
      'tsdb.blockQuerier -> storage.ChunkQuerier',
      'tsdb.blockQuerier -> storage.LabelQuerier',
      'tsdb.blockQuerier -> storage.Querier',
      'tsdb.limitAppender -> storage.Committer',
    ]);
  });

  it('asks for an embedded interface\'s methods too, so a lock is no AuthReadTx', () => {
    const implementers = (name: string, file: string) =>
      (buildTypeHierarchy(cg, one(name, file))?.descendants ?? []).map((d) => `${d.relation} ${pkg(d.node)}`).sort();
    expect(implementers('AuthReadTx', 'auth/store.go')).toEqual(['implements auth.authReadTx']);
    expect(implementers('Querier', 'storage/storage.go')).toEqual(['implements tsdb.blockQuerier']);
  });

  it('keeps a struct that embeds the interface to its declared edge', () => {
    const edges = cg
      .getOutgoingEdgesFrom([one('limitAppender', 'tsdb/querier.go').id], ['implements', 'extends'])
      .map((e) => `${e.kind} ${pkg(cg.getNode(e.target))}${e.provenance === 'heuristic' ? ' (synthesized)' : ''}`)
      .sort();
    expect(edges).toEqual(['implements storage.Appender', 'implements storage.Committer (synthesized)']);
  });

  it('bridges a call through the interface to an override on the embedding struct', () => {
    const use = cg
      .getOutgoingEdgesFrom([one('IRoutes', 'gin/gin.go').id], ['contains'])
      .map((e) => cg.getNode(e.target))
      .find((n) => n?.name === 'Use')!;
    const targets = cg
      .getOutgoingEdgesFrom([use.id], ['calls'])
      .filter((e) => meta(e).synthesizedBy === 'interface-impl')
      .map((e) => cg.getNode(e.target)?.qualifiedName)
      .sort();
    // RouterGroup was linked before. Engine satisfies IRoutes only with the
    // GET that RouterGroup promotes into it.
    expect(targets).toEqual(['Engine::Use', 'RouterGroup::Use']);
  });

  it('skips an interface it knows no method of', () => {
    const into = (name: string, file: string) =>
      cg.getIncomingEdgesTo([one(name, file).id], ['implements']).filter((e) => meta(e).synthesizedBy === 'go-implements');
    expect(into('Any', 'empty/empty.go')).toEqual([]);
    expect(into('Closer', 'empty/empty.go')).toEqual([]);
  });

  it('caps an interface at 40 implementers, keeping those that declare its methods', () => {
    const beater = one('Beater', 'fleet/fleet.go');
    const linked = cg
      .getIncomingEdgesTo([beater.id], ['implements'])
      .filter((e) => meta(e).synthesizedBy === 'go-implements')
      .map((e) => cg.getNode(e.source)!.name);
    // Base, heart and 45 units satisfy Beater. heart is declared after the
    // units, but a call through Beater reaches its Beat, not theirs.
    expect(linked).toHaveLength(40);
    expect(linked).toEqual(expect.arrayContaining(['Base', 'heart']));
    expect(linked.filter((n) => n.startsWith('unit'))).toHaveLength(38);
    const beat = cg
      .getOutgoingEdgesFrom([beater.id], ['contains'])
      .map((e) => cg.getNode(e.target))
      .find((n) => n?.name === 'Beat')!;
    expect(
      cg
        .getOutgoingEdgesFrom([beat.id], ['calls'])
        .filter((e) => meta(e).synthesizedBy === 'interface-impl')
        .map((e) => cg.getNode(e.target)!.qualifiedName)
        .sort()
    ).toEqual(['Base::Beat', 'heart::Beat']);
  });
});

describe('a sync that edits only the embedded type', () => {
  let dir = '';
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('re-derives what the struct embedding it satisfies', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-implements-sync-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    const base = 'package base\n\ntype Base struct{}\n\nfunc (Base) Close() error { return nil }\n';
    write('go.mod', 'module example.com/app\n\ngo 1.22\n');
    write('api/api.go', 'package api\n\ntype NamedCloser interface {\n\tClose() error\n\tName() string\n}\n');
    write('base/base.go', base);
    write('wrap/wrap.go', 'package wrap\n\nimport "example.com/app/base"\n\ntype Wrapper struct{ base.Base }\n\nfunc (Wrapper) Name() string { return "" }\n');
    graph = await CodeGraph.init(dir, { index: true });
    const g = graph;
    const linked = () =>
      g
        .getOutgoingEdgesFrom(g.getNodesByKind('struct').map((n) => n.id), ['implements'])
        .filter((e) => meta(e).synthesizedBy === 'go-implements')
        .map((e) => `${g.getNode(e.source)?.name} -> ${g.getNode(e.target)?.name}`);

    // Close comes from Base, in a file neither Wrapper's nor the interface's.
    expect(linked()).toEqual(['Wrapper -> NamedCloser']);
    write('base/base.go', base.replace('Close()', 'Shutdown()'));
    await g.sync({ paths: ['base/base.go'] });
    expect(linked()).toEqual([]);
    write('base/base.go', base);
    await g.sync({ paths: ['base/base.go'] });
    expect(linked()).toEqual(['Wrapper -> NamedCloser']);
  }, 60_000);
});
