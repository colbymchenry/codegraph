/**
 * A Go struct can satisfy an interface with methods it gets by embedding:
 *
 *   type blockBaseSeriesSet struct{ … }      // prometheus's tsdb/querier.go
 *   func (b *blockBaseSeriesSet) Next() bool  // Next, Err, Warnings — no At
 *
 *   type blockSeriesSet struct{ blockBaseSeriesSet }
 *   func (b *blockSeriesSet) At() storage.Series
 *
 * go-implements links blockSeriesSet to storage.SeriesSet, and a call through
 * `SeriesSet.Next` then runs blockBaseSeriesSet's Next. The interface-dispatch
 * bridge linked an interface's methods only to the methods the implementing
 * struct declares, so that call reached nothing: blockBaseSeriesSet has no At
 * and implements nothing itself. The bridge now follows the embedding to the
 * method Go's selector picks — the shallowest one, none when two tie — and
 * stops at an embedded interface, whose method is a dynamic call again.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { Edge, Node } from '../src/types';

const BIG_METHODS = 45;
const big = (i: number) => `M${String(i).padStart(2, '0')}`;

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'storage/interface.go': `package storage

type Series interface{ Labels() string }

type ChunkSeries interface{ Labels() string }

type SeriesSet interface {
	Next() bool
	At() Series
	Err() error
	Warnings() []string
}

type ChunkSeriesSet interface {
	Next() bool
	At() ChunkSeries
	Err() error
	Warnings() []string
}
`,
  'tsdb/querier.go': `package tsdb

import "example.com/app/storage"

// Next, Err and Warnings for the two series sets below. No At: it is
// neither series set itself.
type blockBaseSeriesSet struct {
	err error
}

func (b *blockBaseSeriesSet) Next() bool         { return false }
func (b *blockBaseSeriesSet) Err() error         { return b.err }
func (b *blockBaseSeriesSet) Warnings() []string { return nil }

type blockSeriesSet struct {
	blockBaseSeriesSet
}

func (b *blockSeriesSet) At() storage.Series { return nil }

type blockChunkSeriesSet struct {
	blockBaseSeriesSet
}

func (b *blockChunkSeriesSet) At() storage.ChunkSeries { return nil }

func newBlockSeriesSet() storage.SeriesSet { return &blockSeriesSet{} }
`,
  'promql/engine.go': `package promql

import "example.com/app/storage"

func expandSeriesSet(it storage.SeriesSet) int {
	n := 0
	for it.Next() {
		n++
	}
	return n
}
`,
  'selector/selector.go': `package selector

type Doer interface {
	Do()
	Name() string
}

type Runner interface{ Do() }

// Do from two levels down.
type inner struct{}

func (inner) Do() {}

type middle struct{ inner }

type deep struct {
	middle
}

func (deep) Name() string { return "" }

// near's Do at depth 1 hides far's at depth 2.
type near struct{}

func (near) Do() {}

type far struct{}

func (far) Do() {}

type farWrap struct{ far }

type shadowed struct {
	farWrap
	near
}

func (shadowed) Name() string { return "" }

// Two Dos at depth 1: Go rejects t.Do(), no method runs.
type left struct{}

func (left) Do() {}

type right struct{}

func (right) Do() {}

type tie struct {
	left
	right
}

func (tie) Name() string { return "" }

// One type's Do at depth 2 along two paths: as ambiguous.
type core struct{}

func (core) Do() {}

type viaA struct{ core }

type viaB struct{ core }

type diamond struct {
	viaA
	viaB
}

func (diamond) Name() string { return "" }

// Do from the interface it embeds: whatever that holds runs.
type delegate struct{ Runner }

func (delegate) Name() string { return "" }

// The embedded interface's Do at depth 1 hides buried's at depth 2.
type buried struct{}

func (buried) Do() {}

type cover struct{ buried }

type hidden struct {
	cover
	Runner
}

func (hidden) Name() string { return "" }

// Do from the defined type it embeds.
type Chain []func()

func (c Chain) Do() {}

type chained struct{ Chain }

func (chained) Name() string { return "" }

// full is a Doer itself: its own edge, whoever embeds it.
type fullWrap struct{ full }

type full struct{}

func (full) Do()          {}
func (full) Name() string { return "" }
`,
  // More of the interface than the cap: one method of its own, the rest from
  // a base that lacks the last.
  'big/big.go': [
    'package big',
    '',
    'type Big interface {',
    ...Array.from({ length: BIG_METHODS }, (_, i) => `\t${big(i)}()`),
    '}',
    '',
    'type bigBase struct{}',
    '',
    ...Array.from({ length: BIG_METHODS - 1 }, (_, i) => `func (bigBase) ${big(i)}() {}`),
    '',
    'type bigOne struct{ bigBase }',
    '',
    `func (bigOne) ${big(BIG_METHODS - 1)}() {}`,
    '',
  ].join('\n'),
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-promoted-'));
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

/** `file:line` of the first fixture line containing `text`. */
function at(file: string, text: string): string {
  const line = FILES[file]!.split('\n').findIndex((l) => l.includes(text));
  expect(line, `${text} in ${file}`).toBeGreaterThanOrEqual(0);
  return `${file}:${line + 1}`;
}

/** The one non-import node with this name in this file. */
function one(name: string, file: string): Node {
  const found = cg.getNodesByName(name).filter((n) => n.filePath === file && n.kind !== 'import');
  expect(found, `${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** An interface's method. */
function methodOf(graph: CodeGraph, iface: Node, name: string): Node {
  const m = graph
    .getOutgoingEdgesFrom([iface.id], ['contains'])
    .map((e) => graph.getNode(e.target))
    .find((n) => n?.name === name);
  expect(m, `${iface.name}.${name}`).toBeTruthy();
  return m!;
}

/** Where a call through the method dispatches, as `Target::m` or `Target::m <- promotedInto @registeredAt`. */
function dispatch(graph: CodeGraph, method: Node): string[] {
  return graph
    .getOutgoingEdgesFrom([method.id], ['calls'])
    .filter((e) => meta(e).synthesizedBy === 'interface-impl')
    .map((e) => {
      const target = graph.getNode(e.target)?.qualifiedName;
      const into = meta(e).promotedInto;
      return into === undefined ? `${target}` : `${target} <- ${into} @${meta(e).registeredAt}`;
    })
    .sort();
}

describe('a call through a Go interface reaches the method embedding promotes', () => {
  it('links the interface method to the embedded type that declares it', () => {
    const seriesSet = one('SeriesSet', 'storage/interface.go');
    const chunkSet = one('ChunkSeriesSet', 'storage/interface.go');
    // blockSeriesSet's embedding, the first of the two.
    const embedding = at('tsdb/querier.go', '\tblockBaseSeriesSet');
    // Both structs satisfy both interfaces by name, and both get Next from
    // the same base: one edge, through the first of them.
    for (const iface of [seriesSet, chunkSet]) {
      expect(dispatch(cg, methodOf(cg, iface, 'Next'))).toEqual([`blockBaseSeriesSet::Next <- blockSeriesSet @${embedding}`]);
      expect(dispatch(cg, methodOf(cg, iface, 'Err'))).toEqual([`blockBaseSeriesSet::Err <- blockSeriesSet @${embedding}`]);
      expect(dispatch(cg, methodOf(cg, iface, 'At'))).toEqual(['blockChunkSeriesSet::At', 'blockSeriesSet::At']);
    }
  });

  it('picks the provider the way Go\'s selector does', () => {
    const doer = one('Doer', 'selector/selector.go');
    const file = 'selector/selector.go';
    expect(dispatch(cg, methodOf(cg, doer, 'Do'))).toEqual(
      [
        // The defined type's method.
        `Chain::Do <- chained @${at(file, 'type chained struct')}`,
        // full's own edge, though fullWrap comes first.
        'full::Do',
        // Two levels down, through deep's own embedding of middle.
        `inner::Do <- deep @${at(file, '\tmiddle')}`,
        // near at depth 1, not far at depth 2.
        `near::Do <- shadowed @${at(file, '\tnear')}`,
      ].sort()
    );
    // Not linked: left and right (tie), core (two paths), the Runner that
    // delegate and hidden embed, and buried behind it.
  });

  it('keeps the provider\'s own edge as it was', () => {
    const doer = one('Doer', 'selector/selector.go');
    const doEdge = cg
      .getOutgoingEdgesFrom([methodOf(cg, doer, 'Do').id], ['calls'])
      .find((e) => cg.getNode(e.target)?.qualifiedName === 'full::Do');
    expect(doEdge).toMatchObject({
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'interface-impl', via: 'Do', registeredAt: at('selector/selector.go', 'func (full) Do()') },
    });
    expect(meta(doEdge!)).not.toHaveProperty('promotedInto');
  });

  it('caps a struct\'s links into one interface, keeping its own method', () => {
    const bigIface = one('Big', 'big/big.go');
    const targets = Array.from({ length: BIG_METHODS }, (_, i) => dispatch(cg, methodOf(cg, bigIface, big(i)))).flat();
    const embedding = at('big/big.go', 'type bigOne struct');
    expect(targets).toHaveLength(40);
    expect(targets).toContain(`bigOne::${big(BIG_METHODS - 1)}`);
    // The 39 slots left go to methods the base promotes.
    const promoted = targets.filter((t) => t.startsWith('bigBase::'));
    expect(promoted).toHaveLength(39);
    for (const t of promoted) expect(t).toMatch(new RegExp(`^bigBase::M\\d\\d <- bigOne @${embedding}$`));
  });

  it('shows the hop in codegraph_explore as a promoted method with its embedding', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'expandSeriesSet SeriesSet.Next blockBaseSeriesSet.Next',
    });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(
      `dynamic: interface → method promoted into blockSeriesSet @${at('tsdb/querier.go', '\tblockBaseSeriesSet')}`
    );
  });
});

describe('a sync that changes what the struct declares', () => {
  let dir = '';
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('moves the link between the promoted method and the struct\'s own', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-promoted-sync-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    const wrap = 'package wrap\n\nimport "example.com/app/base"\n\ntype Wrapper struct {\n\tbase.Base\n}\n\nfunc (Wrapper) Name() string { return "" }\n';
    write('go.mod', 'module example.com/app\n\ngo 1.22\n');
    write('api/api.go', 'package api\n\ntype NamedCloser interface {\n\tClose() error\n\tName() string\n}\n');
    write('base/base.go', 'package base\n\ntype Base struct{}\n\nfunc (Base) Close() error { return nil }\n');
    write('wrap/wrap.go', wrap);
    graph = await CodeGraph.init(dir, { index: true });
    const g = graph;
    const close = () => dispatch(g, methodOf(g, g.getNodesByName('NamedCloser')[0]!, 'Close'));

    // Close comes from base.Base, embedded on line 6.
    expect(close()).toEqual(['Base::Close <- Wrapper @wrap/wrap.go:6']);
    write('wrap/wrap.go', `${wrap}\nfunc (Wrapper) Close() error { return nil }\n`);
    await g.sync({ paths: ['wrap/wrap.go'] });
    expect(close()).toEqual(['Wrapper::Close']);
    write('wrap/wrap.go', wrap);
    await g.sync({ paths: ['wrap/wrap.go'] });
    expect(close()).toEqual(['Base::Close <- Wrapper @wrap/wrap.go:6']);
  }, 60_000);
});
