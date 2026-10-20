/**
 * Go keeps an unexported name inside its package: prometheus tsdb's
 * `[]*memSeries` in head_append.go can only mean the `memSeries` head.go
 * declares, never the one in `tsdb/agent`. Name matching scored the two the
 * same — directory proximity counts shared leading directories, so a child
 * package's file ties with a file of the package's own directory — and the
 * one met first, `tsdb/agent`'s, was then vetoed as invisible, so the
 * reference linked to nothing. Parameters, results, struct fields, composite
 * literals and calls all failed this way whenever a child package declared
 * the same unexported name.
 *
 * A Go candidate the reference cannot see is now out of the pool before the
 * ranking, as for C#, Java and PHP, so the package's own declaration wins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

/** prometheus's shape: package tsdb, with namesakes in its child packages. */
const MODULE: Record<string, string> = {
  'go.mod': 'module example.com/prom\n\ngo 1.24\n',
  'tsdb/head.go': [
    'package tsdb',
    '',
    'type Head struct {',
    '\tseries map[uint64]*memSeries',
    '}',
    '',
    'type memSeries struct {',
    '\tref uint64',
    '}',
    '',
    'type sample struct {',
    '\tt int64',
    '}',
    '',
    'func newSeries() *memSeries { return &memSeries{} }',
    '',
    'func init() {}',
    '',
  ].join('\n'),
  'tsdb/head_append.go': [
    'package tsdb',
    '',
    'type appendBatch struct {',
    '\tseries  []*memSeries',
    '\tsamples []sample',
    '}',
    '',
    'func appendTo(h *Head, s *memSeries, xs []sample) *memSeries {',
    '\tm := newSeries()',
    '\t_ = memSeries{}',
    '\treturn m',
    '}',
    '',
    '// onlyAgent is declared in tsdb/agent alone: nothing here can name it.',
    'func orphan(x *onlyAgent) {}',
    '',
    'func shadowed() *memSeries {',
    '\tnewSeries := func() *memSeries { return nil }',
    '\tinit := func() {}',
    '\tinit()',
    '\treturn newSeries()',
    '}',
    '',
  ].join('\n'),
  'tsdb/agent/series.go': [
    'package agent',
    '',
    'type memSeries struct{}',
    '',
    'type onlyAgent struct{}',
    '',
    'func newSeries() *memSeries { return &memSeries{} }',
    '',
    'func use(s *memSeries) { _ = newSeries() }',
    '',
  ].join('\n'),
  'tsdb/chunks/samples.go': [
    'package chunks',
    '',
    'type sample struct{}',
    '',
  ].join('\n'),
};

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('a Go unexported name is its own package’s, whatever a child package declares (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-namesake-'));
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

  /** `kind file:name` of each non-contains edge out of `name` in `file`, sorted, duplicates kept. */
  const linksFrom = (file: string, name: string) =>
    cg!.getOutgoingEdgesFrom([nodeNamed(file, name).id])
      .filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${cg!.getNode(e.target)!.filePath}:${cg!.getNode(e.target)!.name}`)
      .sort();

  const unresolvedFrom = (file: string, name: string) =>
    cg!.getUnresolvedReferencesFrom(nodeNamed(file, name).id).map((r) => `${r.referenceKind} ${r.referenceName}`).sort();

  it('a parameter, a result, a composite literal and a call name the package’s own declarations', () => {
    expect(linksFrom('tsdb/head_append.go', 'appendTo')).toEqual([
      'calls tsdb/head.go:newSeries',
      'instantiates tsdb/head.go:memSeries',
      'references tsdb/head.go:Head',
      'references tsdb/head.go:memSeries',
      'references tsdb/head.go:memSeries',
      'references tsdb/head.go:sample',
    ]);
    expect(unresolvedFrom('tsdb/head_append.go', 'appendTo')).toEqual([]);
  });

  it('a struct’s fields name the package’s own types', () => {
    expect(linksFrom('tsdb/head_append.go', 'appendBatch')).toEqual([
      'references tsdb/head.go:memSeries',
      'references tsdb/head.go:sample',
    ]);
  });

  it('the child package keeps its own declarations', () => {
    expect(linksFrom('tsdb/agent/series.go', 'use')).toEqual([
      'calls tsdb/agent/series.go:newSeries',
      'references tsdb/agent/series.go:memSeries',
    ]);
  });

  it('a name the function binds itself is that binding, not the package’s declaration', () => {
    // Its result type still links; the two calls are to its own closures,
    // neither to tsdb's `newSeries` nor to `func init()`, which Go never lets
    // a program name.
    expect(linksFrom('tsdb/head_append.go', 'shadowed')).toEqual(['references tsdb/head.go:memSeries']);
  });

  it('an unexported name only another package declares links to nothing', () => {
    expect(linksFrom('tsdb/head_append.go', 'orphan')).toEqual([]);
    expect(unresolvedFrom('tsdb/head_append.go', 'orphan')).toEqual(['references onlyAgent']);
  });
});
