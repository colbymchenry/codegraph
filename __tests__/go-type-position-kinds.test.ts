/**
 * A Go type position — a parameter or result type, a composite literal's
 * type — names a type: a struct, an interface or a defined type, of the
 * package Go reads the name from. Never a method or a function, which Go
 * reaches only through a value or a package. Name matching took whatever
 * declaration shared the name: etcd's
 * `func (ti *treeIndex) KeyIndex(keyi *keyIndex) *keyIndex` linked both
 * `keyIndex` types to the method `treeIndex.keyIndex` beside it, prometheus's
 * `(ec2Client, error)` result to the method `EC2Discovery.ec2Client` it
 * declares, every `samples{…}` literal to `sampleRing.samples`, and
 * `&config_util.URL{…}` (an outside package) to `Target.URL`. A generic
 * receiver's `[T]` declares `T` too: `func (p *Pool[T]) Get() T` returns the
 * pool's own element type, not the method `Sample.T` of another package.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-type-pos-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'mvcc/key_index.go': `package mvcc

type keyIndex struct {
	key []byte
}

type revisions []int64
`,
    'mvcc/index.go': `package mvcc

type treeIndex struct {
	tree map[string]*keyIndex
}

func (ti *treeIndex) KeyIndex(keyi *keyIndex) *keyIndex {
	return ti.keyIndex(keyi)
}

func (ti *treeIndex) keyIndex(keyi *keyIndex) *keyIndex {
	return &keyIndex{key: keyi.key}
}

func (ti *treeIndex) revisions() revisions {
	return revisions{1, 2}
}
`,
    'mvcc/watchable_store.go': `package mvcc

type contains interface {
	contains(rev int64) bool
}

func kvsToEvents(c contains, revs [][]byte) {}
`,
    'discovery/aws/ec2.go': `package aws

import "context"

type ec2Client interface {
	DescribeInstances(ctx context.Context) error
}

type EC2Discovery struct {
	client ec2Client
}

func (d *EC2Discovery) ec2Client(ctx context.Context) (ec2Client, error) {
	return d.client, nil
}
`,
    'util/zeropool/pool.go': `package zeropool

type Pool[T any] struct {
	items []T
}

func (p *Pool[T]) Get() T {
	var zero T
	return zero
}

func (p *Pool[T]) Put(item T) {}

type LazyLoader[K comparable, V any] struct{}

func (l *LazyLoader[K, V]) Load(key K) (V, error) {
	var v V
	return v, nil
}
`,
    'prompb/types.pb.go': `package prompb

type Histogram struct {
	Count isHistogram_Count
}

type isHistogram_Count interface {
	isHistogram_Count()
}

type Histogram_CountInt struct {
	CountInt uint64
}

func (*Histogram_CountInt) isHistogram_Count() {}

func (m *Histogram) GetCount() isHistogram_Count {
	return m.Count
}
`,
    'prompb/codec.go': `package prompb

func FromIntHistogram(count uint64) Histogram {
	return Histogram{
		Count: &Histogram_CountInt{CountInt: count},
	}
}
`,
    'prompb/io/prometheus/write/v2/types.pb.go': `package writev2

type Histogram_CountInt struct {
	CountInt uint64
}

type Sample struct {
	ts int64
}

func (s Sample) T() int64 { return s.ts }
`,
    'model/value/value.go': `package value

type T struct{}

type K struct{}
`,
    'storage/remote/client_test.go': `package remote

import (
	"testing"

	config_util "github.com/prometheus/common/config"
)

type ClientConfig struct {
	URL *config_util.URL
}

func TestStoreHTTPErrorHandling(t *testing.T) {
	conf := &ClientConfig{
		URL: &config_util.URL{URL: nil},
	}
	_ = conf
}
`,
    'scrape/target.go': `package scrape

type Target struct{}

func (t *Target) URL() string { return "" }
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The nodes of `file`, or the one named `from`. */
const sourcesIn = (file: string, from?: string) => cg.getNodesInFile(file).filter((n) => !from || n.name === from);

/**
 * `kind file:qualifiedName` of each type-position edge (a `references` or an
 * `instantiates`) out of `file`'s nodes whose target is named `name`,
 * deduplicated and sorted.
 */
const typeLinksFrom = (file: string, name: string, from?: string) => {
  const links = cg.getOutgoingEdgesFrom(sourcesIn(file, from).map((n) => n.id))
    .filter((e) => e.kind === 'references' || e.kind === 'instantiates')
    .map((e) => ({ kind: e.kind, target: cg.getNode(e.target)! }))
    .filter(({ target }) => target.name === name)
    .map(({ kind, target }) => `${kind} ${target.filePath}:${target.qualifiedName}`);
  return [...new Set(links)].sort();
};

describe('A Go type position resolves to a type', () => {
  it('an unexported parameter and result type is its package’s struct, not a method of that name', () => {
    expect(typeLinksFrom('mvcc/index.go', 'keyIndex', 'KeyIndex')).toEqual(['references mvcc/key_index.go:keyIndex']);
    expect(typeLinksFrom('mvcc/index.go', 'keyIndex', 'keyIndex')).toEqual([
      'instantiates mvcc/key_index.go:keyIndex',
      'references mvcc/key_index.go:keyIndex',
    ]);
  });

  it('the method a call names stays a method', () => {
    const calls = cg.getOutgoingEdgesFrom(sourcesIn('mvcc/index.go', 'KeyIndex').map((n) => n.id))
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(calls).toEqual(['treeIndex::keyIndex']);
  });

  it('a defined type in a result and a composite literal is that type', () => {
    expect(typeLinksFrom('mvcc/index.go', 'revisions', 'revisions')).toEqual([
      'instantiates mvcc/key_index.go:revisions',
      'references mvcc/key_index.go:revisions',
    ]);
  });

  it('an interface whose method shares its name is the interface', () => {
    expect(typeLinksFrom('mvcc/watchable_store.go', 'contains', 'kvsToEvents')).toEqual(['references mvcc/watchable_store.go:contains']);
    expect(typeLinksFrom('prompb/types.pb.go', 'isHistogram_Count', 'GetCount')).toEqual(['references prompb/types.pb.go:isHistogram_Count']);
  });

  it('a result type is the interface, not the method the line declares', () => {
    expect(typeLinksFrom('discovery/aws/ec2.go', 'ec2Client', 'ec2Client')).toEqual(['references discovery/aws/ec2.go:ec2Client']);
  });

  it('a bare composite literal is its own package’s struct, not a namesake in another package', () => {
    expect(typeLinksFrom('prompb/codec.go', 'Histogram_CountInt')).toEqual(['instantiates prompb/types.pb.go:Histogram_CountInt']);
  });

  it('a generic receiver’s type parameters are type parameters', () => {
    expect(typeLinksFrom('util/zeropool/pool.go', 'T', 'Get')).toEqual([]);
    expect(typeLinksFrom('util/zeropool/pool.go', 'T', 'Put')).toEqual([]);
    expect(typeLinksFrom('util/zeropool/pool.go', 'K', 'Load')).toEqual([]);
    expect(typeLinksFrom('util/zeropool/pool.go', 'V', 'Load')).toEqual([]);
  });

  it('a composite literal of an outside package’s type is no project method of that name', () => {
    expect(typeLinksFrom('storage/remote/client_test.go', 'URL')).toEqual([]);
  });
});
