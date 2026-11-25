/**
 * Go wants an implementer's methods identical to the interface's, and the
 * parameter and result counts alone let a type with the right number of the
 * wrong types through:
 *
 *   type RequestMatcher interface { Match(*http.Request) bool }       // caddyhttp
 *   func (m MatchServerName) Match(hello *tls.ClientHelloInfo) bool   // caddytls
 *
 * so caddy's TLS matchers "implemented" its HTTP one, and each false entry also
 * took a place under the per-interface cap. The pass now compares the types the
 * text can settle: each by its name, with the package left off, since the two
 * declarations may sit in different packages and write `Context` and
 * `caddy.Context`. A true alias, a type parameter and a type that holds a list
 * of its own say nothing, and a gRPC server still crosses to its client
 * interface at the server's counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // caddy's two matcher interfaces, and a matcher of each.
  'httpx/matcher.go': `package httpx

import "net/http"

type RequestMatcher interface {
	Match(*http.Request) bool
}

type MatchHost []string

func (m MatchHost) Match(r *http.Request) bool { return false }

type Encode struct{}

func (e *Encode) Match(rw *responseWriter) bool { return false }

type responseWriter struct{}
`,
  'tlsx/matcher.go': `package tlsx

import "crypto/tls"

type ConnectionMatcher interface {
	Match(*tls.ClientHelloInfo) bool
}

type MatchServerName []string

func (m MatchServerName) Match(hello *tls.ClientHelloInfo) bool { return false }
`,
  // A type its own package writes bare and another through its package.
  'core/modules.go': `package core

type Context struct{}

type Provisioner interface {
	Provision(Context) error
}

type Own struct{}

func (o *Own) Provision(ctx Context) error { return nil }
`,
  'plugin/plugin.go': `package plugin

import (
	"example.com/app/core"
	mod "example.com/app/core"
)

type Plugin struct{}

func (p *Plugin) Provision(ctx core.Context) error { return nil }

type Renamed struct{}

func (r *Renamed) Provision(ctx mod.Context) error { return nil }
`,
  // A grouped list on one side, none on the other; the results are named on one.
  'lists/lists.go': `package lists

type Copier interface {
	Copy(string, string) (int, error)
}

type Grouped struct{}

func (g *Grouped) Copy(from, to string) (n int, err error) { return 0, nil }

type Bytes struct{}

func (b *Bytes) Copy(from []byte, to string) (int, error) { return 0, nil }
`,
  // interface{} and any, uint8 and byte are one type.
  'spelled/spelled.go': `package spelled

type Sink interface {
	Put(v any, b []byte)
}

type Old struct{}

func (o *Old) Put(v interface{}, b []uint8) {}
`,
  // A true alias stands for another name; a defined type does not.
  'aliased/aliased.go': `package aliased

type Handle = uint64

type Store interface {
	Get(id uint64) string
}

type ByAlias struct{}

func (a *ByAlias) Get(id Handle) string { return "" }

type Other uint64

type ByDefined struct{}

func (d *ByDefined) Get(id Other) string { return "" }
`,
  // A generic declaration's parameters stand for any type, its other types don't.
  'generic/generic.go': `package generic

type Keyed interface {
	Key() string
	Value() int
}

type Pair[K comparable, V any] struct{}

func (p *Pair[K, V]) Key() K   { var k K; return k }
func (p *Pair[K, V]) Value() V { var v V; return v }

type Tagged[T any] struct{}

func (t *Tagged[T]) Key() T       { var k T; return k }
func (t *Tagged[T]) Value() int64 { return 0 }

type Getter[T any] interface {
	Get() T
}

type Text struct{}

func (t *Text) Get() string { return "" }
`,
  // What a generic base passes on is read with its parameters.
  'promoted/promoted.go': `package promoted

type Base[T any] struct{}

func (b *Base[T]) Load() T { var v T; return v }

type Loader interface {
	Load() string
}

type Holder struct {
	Base[string]
}
`,
  // A type that holds a list of its own isn't compared.
  'funcs/funcs.go': `package funcs

import "context"

type Runner interface {
	Run(fn func(context.Context) error)
}

type Job struct{}

func (j *Job) Run(fn func(ctx context.Context) error) {}
`,
  // A gRPC server and its generated client interface, at the server's counts.
  'pb/rpc_grpc.pb.go': `package pb

import (
	"context"

	"google.golang.org/grpc"
)

type RangeRequest struct{}
type RangeResponse struct{}

type KVClient interface {
	Range(ctx context.Context, in *RangeRequest, opts ...grpc.CallOption) (*RangeResponse, error)
}
`,
  'server/kv.go': `package server

import (
	"context"

	pb "example.com/app/pb"
)

type kvServer struct{}

func (s *kvServer) Range(ctx context.Context, r *pb.RangeRequest) (*pb.RangeResponse, error) {
	return nil, nil
}
`,
};

describe('go-implements compares what the signatures say of the types', () => {
  let dir: string;
  let cg: CodeGraph;
  const implementers = (iface: string): string[] => {
    const node = cg.getNodesByKind('interface').find((n: Node) => n.name === iface);
    expect(node, iface).toBeDefined();
    return cg.getIncomingEdges(node!.id).filter((e) => e.kind === 'implements')
      .map((e) => cg.getNode(e.source)!.name).sort();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-impl-types-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    cg = await CodeGraph.init(dir, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a matcher of another parameter type out', () => {
    expect(implementers('RequestMatcher')).toEqual(['MatchHost']);
    expect(implementers('ConnectionMatcher')).toEqual(['MatchServerName']);
  });

  it('reads a type by its name, however its package is written', () => {
    expect(implementers('Provisioner')).toEqual(['Own', 'Plugin', 'Renamed']);
  });

  it('reads a grouped list, a named result and an unnamed list alike', () => {
    expect(implementers('Copier')).toEqual(['Grouped']);
  });

  it('takes `interface{}` for `any` and `uint8` for `byte`', () => {
    expect(implementers('Sink')).toEqual(['Old']);
  });

  it('lets a true alias stand for its type, and no defined type', () => {
    expect(implementers('Store')).toEqual(['ByAlias']);
  });

  it('reads a declaration\'s type parameters as any type, and the rest as written', () => {
    expect(implementers('Keyed')).toEqual(['Pair']);
    expect(implementers('Getter')).toEqual(['Text']);
  });

  it('reads what a generic base promotes with its parameters', () => {
    expect(implementers('Loader')).toEqual(['Base', 'Holder']);
  });

  it('leaves a type with a list of its own uncompared', () => {
    expect(implementers('Runner')).toEqual(['Job']);
  });

  it('still crosses from a gRPC client interface to the server of its service', () => {
    expect(implementers('KVClient')).toEqual(['kvServer']);
  });
});
