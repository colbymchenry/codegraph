/**
 * A Go alias declaration (`type Event = mvccpb.Event`, `type ( A = B )`) was
 * in neither extractor's graph. tree-sitter-go parses it as a `type_alias`
 * beside the `type_spec` of a defined type (`type WatchChan <-chan
 * WatchResponse`), and both extractors only read `type_spec`, so etcd's
 * client/v3 `Event` had no node while the line below it did.
 *
 * An alias is now a node of the kind a declaration of its type gets: a
 * `type_alias` that references the types it names, a `struct` or an
 * `interface` when it names a struct or interface literal. Each reference sits
 * on the type's name, where resolution reads a package qualifier back. A
 * generic alias (`type Set[T any] = …`, Go 1.24) has no rule in this grammar:
 * it parses as a `type_spec` around an error, so the kernel hands the file to
 * the wasm extractor, which reads it as an alias too, without its type
 * parameters.
 *
 * Resolution treats the alias as the type it names. A bare `Event{}` or
 * `*Event` in its package links to the alias, a method called on an `*Event`
 * is the aliased type's method, methods written with the alias as the
 * receiver make it implement what they satisfy, and an alias whose target is
 * written through a package the index doesn't know (`clientv3` under an
 * unaliased `go.etcd.io/etcd/client/v3`, known as `v3` or `client`) never
 * links to itself or to a namesake.
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

/** Every alias shape the grammar has a rule for, beside defined types. */
const ALIAS_SOURCE = `package clientv3

import (
	"context"

	"go.etcd.io/etcd/api/v3/mvccpb"
)

// Event is the event a watcher reports.
type Event = mvccpb.Event

type WatchChan <-chan WatchResponse

type WatchResponse struct {
	Events []*Event
}

type (
	// Local names a type of this package.
	Local   = WatchResponse
	Ptr     = *WatchResponse
	Slice   = []WatchResponse
	Handler = func(ctx context.Context, r WatchResponse) error
	Index   = map[string]*mvccpb.KeyValue
	Defined WatchResponse
)

type Plain = List[WatchResponse]

type Anon = struct {
	Key string
}

type Closer = interface {
	Close() error
}

type Type = string

type Word = uint
`;

/** Generic aliases: no grammar rule, so a parse error the kernel defers. */
const GENERIC_SOURCE = `package clientv3

type List[T any] struct {
	items []T
}

// Set is a set of comparable values.
type Set[T comparable] = map[T]struct{}

type Items[T any] = List[T]

type Pairs[K comparable, V any] = map[K]List[V]
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

describe('Go alias declarations are extracted', () => {
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

  /** Each type ref sits on its name, where resolution reads a package qualifier back. */
  function expectRefsOnTheirNames(result: ExtractionResult, source: string): void {
    const lines = source.split(/\r?\n/);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(lines[r.line - 1]!.startsWith(r.referenceName, r.column), `${r.referenceName} at ${r.line}:${r.column}`).toBe(true);
    }
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`an alias is a node of its type's kind: %s${label}`, (backend) => {
      const result = extract(backend, 'client/v3/watch.go', eol(ALIAS_SOURCE));
      expect(declarations(result)).toEqual([
        'type_alias Event',
        'type_alias WatchChan',
        'struct WatchResponse',
        'type_alias Local',
        'type_alias Ptr',
        'type_alias Slice',
        'type_alias Handler',
        'type_alias Index',
        'type_alias Defined',
        'type_alias Plain',
        'struct Anon',
        'interface Closer',
        'method Close',
        'type_alias Type',
        'type_alias Word',
      ]);
      const event = result.nodes.find((n) => n.name === 'Event')!;
      expect(event.isExported).toBe(true);
      expect(event.startLine).toBe(10);
      // A doc comment is read as for any type declaration: inside a group.
      expect(result.nodes.find((n) => n.name === 'Local')!.docstring).toBe('Local names a type of this package.');
      // Nested under the file, as a defined type is.
      const file = result.nodes.find((n) => n.kind === 'file')!;
      expect(result.edges.some((e) => e.kind === 'contains' && e.source === file.id && e.target === event.id)).toBe(true);
    });

    it.each(backends)(`an alias references the types it names: %s${label}`, (backend) => {
      const source = eol(ALIAS_SOURCE);
      const result = extract(backend, 'client/v3/watch.go', source);
      // The package of mvccpb.Event / context.Context stays in the source;
      // predeclared types (string, uint, error) are no references. The
      // defined types (WatchChan, Defined) reference theirs too.
      expect(typeRefs(result)).toEqual([
        'Defined WatchResponse',
        'Event Event',
        'Handler Context',
        'Handler WatchResponse',
        'Index KeyValue',
        'Local WatchResponse',
        'Plain List',
        'Plain WatchResponse',
        'Ptr WatchResponse',
        'Slice WatchResponse',
        'WatchChan WatchResponse',
      ]);
      expectRefsOnTheirNames(result, source);
    });
  }

  it.each([false, true])('a generic alias is an alias without its type parameters (wasm; CRLF: %s)', (crlf) => {
    const source = crlf ? GENERIC_SOURCE.replace(/\n/g, '\r\n') : GENERIC_SOURCE;
    if (kernelAvailable) {
      delete process.env.CODEGRAPH_KERNEL;
      process.env.CODEGRAPH_KERNEL_LANGS = 'all';
      // No grammar rule: a parse error, which the kernel leaves to wasm.
      expect(tryKernelExtract('client/v3/set.go', source, 'go')).toBeNull();
    }
    const result = extract('wasm', 'client/v3/set.go', source);
    expect(declarations(result)).toEqual(['struct List', 'type_alias Set', 'type_alias Items', 'type_alias Pairs']);
    expect(result.nodes.find((n) => n.name === 'Set')!.isExported).toBe(true);
    expect(typeRefs(result)).toEqual(['Items List', 'Pairs List']);
    expectRefsOnTheirNames(result, source);
  });
});

describe('an indexed Go module resolves through its aliases', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-alias-'));
    const files: Record<string, string> = {
      'go.mod': 'module go.etcd.io/etcd\n\ngo 1.24\n',
      'api/v3/mvccpb/kv.go': [
        'package mvccpb',
        '',
        'type Event struct {',
        '\tType int',
        '}',
        '',
        'func (e *Event) IsCreate() bool { return e.Type == 0 }',
        '',
      ].join('\n'),
      // A namesake package that sorts first, so a lookup by name meets its
      // `Event` and `Event::IsCreate` before mvccpb's.
      'alpha/event.go': [
        'package alpha',
        '',
        'type Event struct{}',
        '',
        'func (e *Event) IsCreate() bool { return false }',
        '',
      ].join('\n'),
      'client/v3/watch.go': [
        'package clientv3',
        '',
        'import "go.etcd.io/etcd/api/v3/mvccpb"',
        '',
        'type Event = mvccpb.Event',
        '',
        'type WatchResponse struct {',
        '\tEvents []*Event',
        '}',
        '',
        'func (wr *WatchResponse) Err() error { return nil }',
        '',
        'type (',
        '\tLocal = WatchResponse',
        '\tPtr   = *Local',
        ')',
        '',
        'func newEvent() Event { return Event{} }',
        '',
        'func isCreate(e *Event) bool { return e.IsCreate() }',
        '',
        'func check(p Ptr) error { return p.Err() }',
        '',
      ].join('\n'),
      // A generic alias: the file parses with an error and goes to wasm.
      'client/v3/list.go': [
        'package clientv3',
        '',
        'type List[T any] struct{ items []T }',
        '',
        'func (l *List[T]) Len() int { return len(l.items) }',
        '',
        'type Items[T any] = List[T]',
        '',
        'func count(xs *Items[int]) int { return xs.Len() }',
        '',
      ].join('\n'),
      // prometheus's discovery/xds: methods written on the alias are SDConfig's.
      'discovery/kuma.go': [
        'package discovery',
        '',
        'type Config interface {',
        '\tName() string',
        '}',
        '',
        'type SDConfig struct{}',
        '',
        'type KumaSDConfig = SDConfig',
        '',
        'func (*KumaSDConfig) Name() string { return "kuma" }',
        '',
      ].join('\n'),
      'watcher/watcher.go': [
        'package watcher',
        '',
        'import "go.etcd.io/etcd/client/v3"',
        '',
        '// The package is clientv3, though the index knows the import as v3 or client.',
        'type Event = clientv3.Event',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `kind file:qualifiedName` of each non-contains edge out of `name` in `file`, sorted. */
  const linksFrom = (file: string, name: string) => {
    const sources = cg.getNodesInFile(file).filter((n) => n.name === name && n.kind !== 'import');
    expect(sources, `${name} in ${file}`).toHaveLength(1);
    const links = cg.getOutgoingEdgesFrom(sources.map((n) => n.id))
      .filter((e) => e.kind !== 'contains')
      .map((e) => ({ kind: e.kind, target: cg.getNode(e.target)! }))
      .map(({ kind, target }) => `${kind} ${target.filePath}:${target.qualifiedName}`);
    return [...new Set(links)].sort();
  };

  it('an alias references the type it names, in the package it is written through', () => {
    expect(linksFrom('client/v3/watch.go', 'Event')).toEqual(['references api/v3/mvccpb/kv.go:Event']);
    expect(linksFrom('client/v3/watch.go', 'Local')).toEqual(['references client/v3/watch.go:WatchResponse']);
    expect(linksFrom('client/v3/watch.go', 'Ptr')).toEqual(['references client/v3/watch.go:Local']);
    expect(linksFrom('client/v3/list.go', 'Items')).toEqual(['references client/v3/list.go:List']);
  });

  it('a bare name in the alias package is the alias', () => {
    expect(linksFrom('client/v3/watch.go', 'newEvent')).toEqual([
      'instantiates client/v3/watch.go:Event',
      'references client/v3/watch.go:Event',
    ]);
  });

  it('a method called on an alias is the aliased type’s', () => {
    expect(linksFrom('client/v3/watch.go', 'isCreate')).toEqual([
      'calls api/v3/mvccpb/kv.go:Event::IsCreate',
      'references client/v3/watch.go:Event',
    ]);
    // Through two aliases, one of a pointer.
    expect(linksFrom('client/v3/watch.go', 'check')).toEqual([
      'calls client/v3/watch.go:WatchResponse::Err',
      'references client/v3/watch.go:Ptr',
    ]);
    expect(linksFrom('client/v3/list.go', 'count')).toEqual([
      'calls client/v3/list.go:List::Len',
      'references client/v3/list.go:Items',
    ]);
  });

  it('an alias owning methods written on it implements what they satisfy', () => {
    expect(linksFrom('discovery/kuma.go', 'KumaSDConfig')).toEqual([
      'implements discovery/kuma.go:Config',
      'references discovery/kuma.go:SDConfig',
    ]);
    // A call through Config.Name reaches the method written on the alias.
    const config = cg.getNodesInFile('discovery/kuma.go').find((n) => n.name === 'Config')!;
    const name = cg.getOutgoingEdgesFrom([config.id], ['contains']).map((e) => cg.getNode(e.target)!).find((n) => n.name === 'Name')!;
    expect(cg.getOutgoingEdgesFrom([name.id], ['calls']).map((e) => cg.getNode(e.target)?.qualifiedName)).toEqual(['KumaSDConfig::Name']);
  });

  it('an alias written through a package the index does not know links to nothing', () => {
    // Not to itself, nor to client/v3's, mvccpb's or alpha's `Event`.
    expect(linksFrom('watcher/watcher.go', 'Event')).toEqual([]);
    const event = cg.getNodesInFile('watcher/watcher.go').find((n) => n.name === 'Event')!;
    expect(cg.getUnresolvedReferencesFrom(event.id).map((r) => `${r.referenceKind} ${r.referenceName}`)).toEqual(['references Event']);
  });
});
