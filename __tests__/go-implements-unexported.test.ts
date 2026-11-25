/**
 * In Go an unexported method name belongs to the package that declares it.
 * prometheus has a `refresher` interface in each of several discovery
 * packages:
 *
 *   type refresher interface {                  // discovery/hetzner
 *     refresh(context.Context) ([]*targetgroup.Group, error)
 *   }
 *
 * Only a type of package hetzner can have that `refresh`: aws's EC2Discovery
 * declares a `refresh` of its own, but it is package aws's method, and Go does
 * not let it satisfy hetzner's interface. goImplementsEdges matched method
 * names only, so it linked each refresher to every provider in every package.
 *
 * Where the method is declared is what counts, not where the type is. etcd's
 * gRPC servers live outside api/etcdserverpb, yet they satisfy its
 * `KVServer { …; mustEmbedUnimplementedKVServer() }`: they embed the
 * generated `UnsafeKVServer` interface or `UnimplementedKVServer` struct, and
 * the method those bring is declared in the interface's package.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import type { Edge, Node } from '../src/types';

// Base and 39 units: exactly the cap.
const POOL_UNITS = 39;
const unit = (i: number) => `unit${String(i).padStart(2, '0')}`;

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // prometheus's discovery/refresh: every provider embeds its Discovery.
  'discovery/refresh/refresh.go': `package refresh

type Discovery struct {
	refreshf func() ([]string, error)
}

func (d *Discovery) Run() {}

func (d *Discovery) refresh() ([]string, error) { return d.refreshf() }
`,
  'discovery/hetzner/hetzner.go': `package hetzner

import "example.com/app/discovery/refresh"

type refresher interface {
	refresh() ([]string, error)
}

// A refresh of its own, declared in package hetzner: a refresher.
type hcloudDiscovery struct {
	*refresh.Discovery
}

func (d *hcloudDiscovery) refresh() ([]string, error) { return nil, nil }

// A defined type of the package is one too.
type robotTargets []string

func (r robotTargets) refresh() ([]string, error) { return r, nil }

// Its only refresh is the one package refresh declares on the Discovery it
// embeds: no refresher, for all that it sits in this package.
type Discovery struct {
	*refresh.Discovery
}
`,
  'discovery/aws/ec2.go': `package aws

import "example.com/app/discovery/refresh"

// A refresh of its own, but package aws's: no hetzner refresher.
type EC2Discovery struct {
	*refresh.Discovery
}

func (d *EC2Discovery) refresh() ([]string, error) { return nil, nil }

// Nor is a defined type of package aws.
type staticTargets []string

func (s staticTargets) refresh() ([]string, error) { return s, nil }
`,
  // etcd's api/etcdserverpb, as protoc-gen-go-grpc writes it.
  'api/pb/rpc_grpc.pb.go': `package pb

type KVServer interface {
	Range(key string) (string, error)
	Put(key string) (string, error)
	mustEmbedUnimplementedKVServer()
}

type UnimplementedKVServer struct{}

func (UnimplementedKVServer) Range(key string) (string, error) { return "", nil }
func (UnimplementedKVServer) Put(key string) (string, error)   { return "", nil }
func (UnimplementedKVServer) mustEmbedUnimplementedKVServer()  {}

type UnsafeKVServer interface {
	mustEmbedUnimplementedKVServer()
}
`,
  'server/v3rpc/key.go': `package v3rpc

import pb "example.com/app/api/pb"

// etcd's kvServer: the stub interface brings pb's mustEmbedUnimplementedKVServer.
type kvServer struct {
	pb.UnsafeKVServer
}

func (s *kvServer) Range(key string) (string, error) { return "", nil }
func (s *kvServer) Put(key string) (string, error)   { return "", nil }

// The stub struct brings it, and Put.
type kvProxy struct {
	pb.UnimplementedKVServer
}

func (p *kvProxy) Range(key string) (string, error) { return "", nil }

// Its mustEmbedUnimplementedKVServer is package v3rpc's: no KVServer.
type fakeKV struct{}

func (fakeKV) Range(key string) (string, error) { return "", nil }
func (fakeKV) Put(key string) (string, error)   { return "", nil }
func (fakeKV) mustEmbedUnimplementedKVServer()  {}
`,
  // An interface of package v3rpc asks for pb's method through the interface
  // it embeds.
  'server/v3rpc/closable.go': `package v3rpc

import pb "example.com/app/api/pb"

type closableKV interface {
	pb.KVServer
	Close() error
}

func (s *kvServer) Close() error { return nil }

func (fakeKV) Close() error { return nil }
`,
  'lease/lease.go': `package lease

type checkpointer interface {
	checkpoint() error
	Expired() bool
}

// A checkpoint and no Expired: neither is a checkpointer itself.
type Lessor struct{}

func (l *Lessor) checkpoint() error { return nil }

type Store struct{}

func (s *Store) checkpoint() error { return nil }
`,
  'lease/proxy/proxy.go': `package proxy

import "example.com/app/lease"

// Its own checkpoint is package proxy's. A call through a checkpointer runs
// the one the Lessor it embeds declares in package lease.
type leaseProxy struct {
	*lease.Lessor
}

func (p *leaseProxy) checkpoint() error { return nil }
func (p *leaseProxy) Expired() bool     { return false }

// local's checkpoint, one level down, is package proxy's too. It hides
// nothing: Store's, two levels down, is the checkpointer's.
type local struct{}

func (local) checkpoint() error { return nil }

type wrapped struct{ *lease.Store }

type layered struct {
	local
	wrapped
}

func (layered) Expired() bool { return false }
`,
  // More pingers than the cap. early comes first in file order, but its own
  // ping is package a's and pool's comes from the Base it embeds, so it waits
  // behind the 40 types that declare pool's ping.
  'a/early.go': 'package a\n\nimport "example.com/app/pool"\n\ntype early struct{ pool.Base }\n\nfunc (early) ping() {}\n',
  'pool/pool.go': [
    'package pool',
    '',
    'type pinger interface{ ping() }',
    '',
    'type Base struct{}',
    '',
    'func (Base) ping() {}',
    '',
    ...Array.from({ length: POOL_UNITS }, (_, i) => `type ${unit(i)} struct{}\n\nfunc (${unit(i)}) ping() {}\n`),
  ].join('\n'),
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-unexported-'));
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

/** The synthesized edges into an interface, as `pkg.Type`. */
function implementers(iface: Node): string[] {
  return cg
    .getIncomingEdgesTo([iface.id], ['implements'])
    .filter((e) => meta(e).synthesizedBy === 'go-implements')
    .map((e) => pkg(cg.getNode(e.source)))
    .sort();
}

/** Where a call through an interface method dispatches, as `Target::m` or `Target::m <- promotedInto @registeredAt`. */
function dispatch(iface: Node, name: string): string[] {
  const method = cg
    .getOutgoingEdgesFrom([iface.id], ['contains'])
    .map((e) => cg.getNode(e.target))
    .find((n) => n?.name === name);
  expect(method, `${iface.name}.${name}`).toBeTruthy();
  return cg
    .getOutgoingEdgesFrom([method!.id], ['calls'])
    .filter((e) => meta(e).synthesizedBy === 'interface-impl')
    .map((e) => {
      const target = cg.getNode(e.target)?.qualifiedName;
      const into = meta(e).promotedInto;
      return into === undefined ? `${target}` : `${target} <- ${into} @${meta(e).registeredAt}`;
    })
    .sort();
}

describe('an unexported interface method is satisfied only from its own package', () => {
  it('links no type of another package that declares a method of that name', () => {
    const refresher = one('refresher', 'discovery/hetzner/hetzner.go');
    // Not aws's EC2Discovery or staticTargets, nor refresh.Discovery, nor
    // hetzner's Discovery, whose refresh is package refresh's.
    expect(implementers(refresher)).toEqual(['discovery/hetzner.hcloudDiscovery', 'discovery/hetzner.robotTargets']);
    const hierarchy = (buildTypeHierarchy(cg, refresher)?.descendants ?? []).map((d) => pkg(d.node)).sort();
    expect(hierarchy).toEqual(['discovery/hetzner.hcloudDiscovery', 'discovery/hetzner.robotTargets']);
  });

  it('links a gRPC server through the stub it embeds from the interface\'s package', () => {
    // kvServer embeds the UnsafeKVServer interface, kvProxy the
    // UnimplementedKVServer struct. fakeKV declares the method itself, in
    // package v3rpc.
    expect(implementers(one('KVServer', 'api/pb/rpc_grpc.pb.go'))).toEqual([
      'api/pb.UnimplementedKVServer',
      'server/v3rpc.kvProxy',
      'server/v3rpc.kvServer',
    ]);
    // kvServer declares that one by embedding it.
    expect(implementers(one('UnsafeKVServer', 'api/pb/rpc_grpc.pb.go'))).toEqual([
      'api/pb.UnimplementedKVServer',
      'server/v3rpc.kvProxy',
    ]);
  });

  it('asks for an embedded interface\'s method in that interface\'s package', () => {
    expect(implementers(one('closableKV', 'server/v3rpc/closable.go'))).toEqual(['server/v3rpc.kvServer']);
  });

  it('dispatches a call through the interface to the method of its own package', () => {
    const checkpointer = one('checkpointer', 'lease/lease.go');
    expect(implementers(checkpointer)).toEqual(['lease/proxy.layered', 'lease/proxy.leaseProxy']);
    // Not leaseProxy's own checkpoint, nor local's at the shallower depth.
    expect(dispatch(checkpointer, 'checkpoint')).toEqual([
      `Lessor::checkpoint <- leaseProxy @${at('lease/proxy/proxy.go', '\t*lease.Lessor')}`,
      `Store::checkpoint <- layered @${at('lease/proxy/proxy.go', '\twrapped')}`,
    ]);
    expect(dispatch(checkpointer, 'Expired')).toEqual(['layered::Expired', 'leaseProxy::Expired']);
    // A gRPC server's own mustEmbedUnimplementedKVServer is no override.
    expect(dispatch(one('KVServer', 'api/pb/rpc_grpc.pb.go'), 'mustEmbedUnimplementedKVServer')).toEqual([
      'UnimplementedKVServer::mustEmbedUnimplementedKVServer',
    ]);
  });

  it('fills the cap with the types that declare the method in its package first', () => {
    const pinger = one('pinger', 'pool/pool.go');
    expect(implementers(pinger)).toEqual(
      ['pool.Base', ...Array.from({ length: POOL_UNITS }, (_, i) => `pool.${unit(i)}`)].sort()
    );
  });
});
