/**
 * Go's implicit interface satisfaction (#584) is not only for structs. Any
 * defined type can declare methods, and plenty of real implementers are not
 * structs at all:
 *
 *   type staticDiscoverer []*targetgroup.Group     // prometheus discovery
 *   func (c staticDiscoverer) Run(ctx context.Context, up chan<- []*targetgroup.Group)
 *
 *   type formSource map[string][]string            // gin binding
 *   func (form formSource) TrySet(…) (bool, error)
 *
 *   type Int64Comparable int64                     // etcd pkg/adt
 *   func (v Int64Comparable) Compare(c Comparable) int
 *
 * Such a type is extracted as a `type_alias` that owns its methods through
 * `contains` edges, but goImplementsEdges only ever offered structs as
 * implementers, and the interface-dispatch bridge only walked class, struct and
 * union. So `Discoverer` never listed the static discoverer, and a call
 * through `Discoverer.Run` could not reach its `Run`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import type { Edge, Node } from '../src/types';

const RING_STRUCTS = 40;

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // prometheus's discovery package.
  'discovery/discovery.go': `package discovery

import "context"

type Group struct{ Source string }

type Discoverer interface {
	Run(ctx context.Context, up chan<- []*Group)
}

type Config interface {
	Name() string
	NewDiscoverer() (Discoverer, error)
}

// A list of groups that is a Config, and hands out a Discoverer over itself.
type StaticConfig []*Group

func (StaticConfig) Name() string { return "static" }

func (c StaticConfig) NewDiscoverer() (Discoverer, error) { return staticDiscoverer(c), nil }

type staticDiscoverer []*Group

func (c staticDiscoverer) Run(ctx context.Context, up chan<- []*Group) {
	select {
	case <-ctx.Done():
	case up <- c:
	}
}

// A true alias: the same type as staticDiscoverer, not a second one.
type StaticDiscoverer = staticDiscoverer

// A name but no NewDiscoverer: no Config.
type namedGroups []*Group

func (namedGroups) Name() string { return "named" }
`,
  // gin's binding package: two setters over a map and over a struct type, the
  // second with its method in another file.
  'binding/form_mapping.go': `package binding

type setOptions struct{ isDefaultExists bool }

type setter interface {
	TrySet(key string, opt setOptions) (bool, error)
}

type formSource map[string][]string

func (form formSource) TrySet(key string, opt setOptions) (bool, error) { return false, nil }

// No method at all.
type keys []string
`,
  'binding/multipart_form_mapping.go': `package binding

import "net/http"

type multipartRequest http.Request
`,
  'binding/multipart_set.go': `package binding

func (r *multipartRequest) TrySet(key string, opt setOptions) (bool, error) { return false, nil }
`,
  // etcd's pkg/adt.
  'adt/interval_tree.go': `package adt

type Comparable interface {
	Compare(c Comparable) int
}

type StringComparable string

func (s StringComparable) Compare(c Comparable) int { return 0 }

type Int64Comparable int64

func (v Int64Comparable) Compare(c Comparable) int { return 0 }
`,
  // An adapter over a function type, a generic defined type, and a defined
  // type whose underlying type is an interface.
  'web/handler.go': `package web

type Request struct{}

type ResponseWriter interface {
	Write(b []byte) (int, error)
}

type Handler interface {
	ServeHTTP(w ResponseWriter, r *Request)
}

type HandlerFunc func(ResponseWriter, *Request)

func (f HandlerFunc) ServeHTTP(w ResponseWriter, r *Request) { f(w, r) }

type Lener interface {
	Len() int
}

type Set[T comparable] map[T]struct{}

func (s Set[T]) Len() int { return len(s) }

// An interface type by another name: never an implementer itself.
type Serving Handler
`,
  // More implementers that declare Tick than the cap: a defined type in the
  // file listed first, then the structs.
  'ring/a.go': 'package ring\n\ntype Ticker interface{ Tick() }\n\ntype alarm int\n\nfunc (alarm) Tick() {}\n',
  'ring/b.go': [
    'package ring',
    '',
    ...Array.from({ length: RING_STRUCTS }, (_, i) => {
      const name = `tick${String(i).padStart(2, '0')}`;
      return `type ${name} struct{}\n\nfunc (${name}) Tick() {}\n`;
    }),
  ].join('\n'),
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-defined-types-'));
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

/** Every Go type in the graph that could implement an interface. */
function goTypes(g: CodeGraph): Node[] {
  return [...g.getNodesByKind('struct'), ...g.getNodesByKind('type_alias')].filter((n) => n.language === 'go');
}

/** Every synthesized type → interface edge, as `pkg.Type -> pkg.Interface`. */
function goImplements(): string[] {
  return cg
    .getOutgoingEdgesFrom(goTypes(cg).map((n) => n.id), ['implements'])
    .filter((e) => meta(e).synthesizedBy === 'go-implements')
    .map((e) => `${pkg(cg.getNode(e.source))} -> ${pkg(cg.getNode(e.target))}`)
    .filter((e) => !e.startsWith('ring.'))
    .sort();
}

/** Where a call through the interface's method is bridged to. */
function dispatchTargets(iface: string, file: string, method: string): string[] {
  const m = cg
    .getOutgoingEdgesFrom([one(iface, file).id], ['contains'])
    .map((e) => cg.getNode(e.target))
    .find((n) => n?.name === method)!;
  return cg
    .getOutgoingEdgesFrom([m.id], ['calls'])
    .filter((e) => meta(e).synthesizedBy === 'interface-impl')
    .map((e) => cg.getNode(e.target)?.qualifiedName ?? '?')
    .sort();
}

describe('Go implicit satisfaction counts defined types as implementers', () => {
  it('links every defined type whose methods cover the interface', () => {
    expect(goImplements()).toEqual([
      'adt.Int64Comparable -> adt.Comparable',
      'adt.StringComparable -> adt.Comparable',
      'binding.formSource -> binding.setter',
      'binding.multipartRequest -> binding.setter',
      'discovery.StaticConfig -> discovery.Config',
      'discovery.staticDiscoverer -> discovery.Discoverer',
      'web.HandlerFunc -> web.Handler',
      'web.Set -> web.Lener',
    ]);
  });

  it('bridges a call through the interface to the defined type\'s method', () => {
    expect(dispatchTargets('Discoverer', 'discovery/discovery.go', 'Run')).toEqual(['staticDiscoverer::Run']);
    expect(dispatchTargets('Config', 'discovery/discovery.go', 'NewDiscoverer')).toEqual([
      'StaticConfig::NewDiscoverer',
    ]);
    expect(dispatchTargets('setter', 'binding/form_mapping.go', 'TrySet')).toEqual([
      'formSource::TrySet',
      'multipartRequest::TrySet',
    ]);
    expect(dispatchTargets('Comparable', 'adt/interval_tree.go', 'Compare')).toEqual([
      'Int64Comparable::Compare',
      'StringComparable::Compare',
    ]);
    expect(dispatchTargets('Handler', 'web/handler.go', 'ServeHTTP')).toEqual(['HandlerFunc::ServeHTTP']);
  });

  it('shows them in the type hierarchy, both ways', () => {
    const below = buildTypeHierarchy(cg, one('Comparable', 'adt/interval_tree.go'))?.descendants ?? [];
    expect(below.map((d) => `${d.relation} ${pkg(d.node)}${d.synthesized ? ' (synthesized)' : ''}`).sort()).toEqual([
      'implements adt.Int64Comparable (synthesized)',
      'implements adt.StringComparable (synthesized)',
    ]);
    const above = buildTypeHierarchy(cg, one('staticDiscoverer', 'discovery/discovery.go'))?.ancestors ?? [];
    expect(above.map((a) => `${a.relation} ${pkg(a.node)}`)).toEqual(['implements discovery.Discoverer']);
  });

  it('keeps a true alias and an interface by another name from implementing anything', () => {
    const named = (name: string) =>
      cg
        .getNodesByName(name)
        .filter((n) => n.language === 'go' && n.kind !== 'import')
        .flatMap((n) => cg.getOutgoingEdgesFrom([n.id], ['implements']));
    expect(named('StaticDiscoverer')).toEqual([]);
    expect(named('Serving')).toEqual([]);
    // The type the alias names is linked once.
    expect(goImplements().filter((e) => e.includes('staticDiscoverer'))).toHaveLength(1);
  });

  it('caps an interface at 40 implementers, taking defined types in file order with the declaring structs', () => {
    const linked = cg
      .getIncomingEdgesTo([one('Ticker', 'ring/a.go').id], ['implements'])
      .filter((e) => meta(e).synthesizedBy === 'go-implements')
      .map((e) => cg.getNode(e.source)!.name);
    // alarm and 40 structs declare Tick. alarm comes first in file order, so
    // the last struct is the one the cap leaves out.
    expect(linked).toHaveLength(40);
    expect(linked).toContain('alarm');
    expect(linked).not.toContain(`tick${RING_STRUCTS - 1}`);
    expect(dispatchTargets('Ticker', 'ring/a.go', 'Tick')).toContain('alarm::Tick');
  });
});

describe('a sync that edits a defined type\'s method', () => {
  let dir = '';
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('re-derives what the defined type satisfies', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-defined-types-sync-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    const int64 = 'package adt\n\ntype Int64Comparable int64\n\nfunc (v Int64Comparable) Compare(c Comparable) int { return 0 }\n';
    write('go.mod', 'module example.com/app\n\ngo 1.22\n');
    write('adt/comparable.go', 'package adt\n\ntype Comparable interface {\n\tCompare(c Comparable) int\n}\n');
    write('adt/int64.go', int64);
    graph = await CodeGraph.init(dir, { index: true });
    const g = graph;
    const linked = () =>
      g
        .getOutgoingEdgesFrom(goTypes(g).map((n) => n.id), ['implements'])
        .filter((e) => meta(e).synthesizedBy === 'go-implements')
        .map((e) => `${g.getNode(e.source)?.name} -> ${g.getNode(e.target)?.name}`);

    expect(linked()).toEqual(['Int64Comparable -> Comparable']);
    write('adt/int64.go', int64.replace('Compare(', 'Cmp('));
    await g.sync({ paths: ['adt/int64.go'] });
    expect(linked()).toEqual([]);
    write('adt/int64.go', int64);
    await g.sync({ paths: ['adt/int64.go'] });
    expect(linked()).toEqual(['Int64Comparable -> Comparable']);
  }, 60_000);
});
