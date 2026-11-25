/**
 * A Go call through a type assertion is a call of the asserted type's method:
 *
 *   func _KV_Range_Handler(srv interface{}, …) (interface{}, error) {
 *     return srv.(KVServer).Range(ctx, in)   // etcd's generated gRPC code
 *   }
 *
 * Both extractors record such a call by its bare member name (`Range`), at
 * the column where its receiver expression starts, as any call through an
 * expression. Resolution matched the name alone, so every handler etcd
 * generates went to `UnimplementedKVServer`'s stub instead of the `KVServer`
 * interface method. The asserted type is now read back from the source: its
 * own method, the method its interface declares, or one embedding promotes
 * into it — written bare (its own package's, or a dot import's), as a
 * pointer, or through a project package. A type from outside the project
 * (`http.Flusher`) or a type literal links nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

/** etcd's generated server handlers, a pointer assertion, and a chain continued on the next line. */
const HANDLERS = `package pb

import "context"

type KVServer interface {
	Range(context.Context, *RangeRequest) (*RangeResponse, error)
	Put(context.Context, *RangeRequest) (*RangeResponse, error)
}

type UnimplementedKVServer struct{}

func (UnimplementedKVServer) Range(context.Context, *RangeRequest) (*RangeResponse, error) {
	return nil, nil
}

func (UnimplementedKVServer) Put(context.Context, *RangeRequest) (*RangeResponse, error) {
	return nil, nil
}

type RangeRequest struct{}

type RangeResponse struct{}

func _KV_Range_Handler(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor func(context.Context, interface{}, func(context.Context, interface{}) (interface{}, error)) (interface{}, error)) (interface{}, error) {
	in := new(RangeRequest)
	if err := dec(in); err != nil {
		return nil, err
	}
	if interceptor == nil {
		return srv.(KVServer).Range(ctx, in)
	}
	handler := func(ctx context.Context, req interface{}) (interface{}, error) {
		return srv.(KVServer).Range(ctx, req.(*RangeRequest))
	}
	return interceptor(ctx, in, handler)
}

func _KV_Put_Handler(srv interface{}, ctx context.Context, in *RangeRequest) (interface{}, error) {
	return srv.(KVServer).
		Put(ctx, in)
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go calls through a type assertion are recorded at their receiver', () => {
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

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('pb/rpc_grpc.pb.go', source, 'go');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('pb/rpc_grpc.pb.go', source, 'go');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const source = crlf ? HANDLERS.replace(/\n/g, '\r\n') : HANDLERS;
    it.each(backends)(`by the bare member name, at the receiver's column: %s${crlf ? ' (CRLF)' : ''}`, (backend) => {
      const lines = source.split(/\r?\n/);
      const refs = extract(backend, source).unresolvedReferences
        .filter((r) => r.referenceKind === 'calls' && (r.referenceName.endsWith('Range') || r.referenceName.endsWith('Put')))
        .map((r) => `${r.referenceName} ${r.line}:${r.column}`)
        .sort();
      // `line:column` of the receiver `srv` on the line `pick` finds.
      const srvOn = (pick: (line: string) => boolean): string => {
        const line = lines.findIndex(pick);
        return `${line + 1}:${lines[line]!.indexOf('srv')}`;
      };
      expect(refs).toEqual([
        `Put ${srvOn((l) => l.endsWith('srv.(KVServer).'))}`,
        `Range ${srvOn((l) => l.includes('Range(ctx, in)'))}`,
        `Range ${srvOn((l) => l.includes('Range(ctx, req.('))}`,
      ].sort());
    });
  }
});

/**
 * The module the resolution tests index. Namesakes sit where name matching
 * looked first: a stub beside each interface, a same-file type with each
 * method name, and an `alpha` package that sorts ahead of `storage`.
 */
const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'pb/rpc_grpc.pb.go': HANDLERS.replace(/\n/g, '\r\n'),
  'internal/bufconn/bufconn.go': `package bufconn

import "io"

type pipe struct{}

func (p *pipe) Close() error { return nil }

func (p *pipe) closeWrite() error { return nil }

func (p *pipe) close() {}

type conn struct {
	io.Reader
	io.Writer
}

func (c *conn) Close() error {
	err1 := c.Reader.(*pipe).Close()
	err2 := c.Writer.(*pipe).closeWrite()
	c.Reader.(*pipe).close()
	if err1 != nil {
		return err1
	}
	return err2
}
`,
  'alpha/alpha.go': `package alpha

type Store interface {
	Fetch(key string) string
}

type sink struct{}

func (s *sink) Fetch(key string) string { return "" }

func (s *sink) Flush() error { return nil }

func (s *sink) Read(p []byte) (int, error) { return 0, nil }

type Ctx struct{}

func (c *Ctx) Done() <-chan struct{} { return nil }
`,
  'storage/storage.go': `package storage

type Store interface {
	Fetch(key string) string
}

type Base struct{}

func (b *Base) Flush() error { return nil }
`,
  'store/store.go': `package store

import (
	"context"

	"example.com/app/storage"
)

type Reader interface {
	Read(p []byte) (int, error)
}

type ReadCloser interface {
	Reader
	Close() error
}

type Wrapper struct {
	*storage.Base
	name string
}

type Job struct{}

func (j *Job) Start() {}

type Factory interface {
	New() *Job
}

type Builder struct{}

func (b *Builder) Add(n int) *Builder { return b }

type Ctx = context.Context

type Keeper = storage.Store
`,
  'store/use.go': `package store

import (
	"net/http"

	"example.com/app/storage"
)

type sink struct{}

func (s *sink) Flush() error { return nil }

func (s *sink) Read(p []byte) (int, error) { return 0, nil }

func (s *sink) Fetch(key string) string { return "" }

func Use(v any, w http.ResponseWriter, p []byte) string {
	v.(*Wrapper).Flush()
	v.(ReadCloser).Read(p)
	w.(http.Flusher).Flush()
	return v.(storage.Store).Fetch("k")
}

func Anon(v any) string {
	return v.(interface{ Fetch(key string) string }).Fetch("k")
}

func Run(v any) {
	v.(Factory).New().Start()
}

func lookup(key string) any { return nil }

func Quoted() string {
	return lookup(")").(storage.Store).Fetch("k")
}

func (s *sink) Add(n int) *sink { return s }

func Build(v any) {
	v.(*Builder).Add(1).Add(2)
}

func Wait(v any) {
	v.(Ctx).Done()
}

func Keep(v any) string {
	return v.(Keeper).Fetch("k")
}
`,
  'dot/dot.go': `package dot

import . "example.com/app/storage"

func Get(v any) string {
	return v.(Store).Fetch("k")
}
`,
};

describe.each(['default', 'wasm'])('Go calls through a type assertion resolve on the asserted type (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-assert-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `<line> <target file>::<target qualified name>` for every call the function or method `qualifiedName` in `file` makes. */
  function calls(file: string, qualifiedName: string): string[] {
    const fn = cg!.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName && (n.kind === 'function' || n.kind === 'method'));
    expect(fn, `${qualifiedName} in ${file}`).toBeDefined();
    return cg!
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${e.line} ${cg!.getNode(e.target)!.filePath}::${cg!.getNode(e.target)!.qualifiedName}`)
      .sort();
  }

  it("links etcd's gRPC handlers to the server interface's method, not the stub", () => {
    expect(calls('pb/rpc_grpc.pb.go', '_KV_Range_Handler')).toEqual([
      '30 pb/rpc_grpc.pb.go::KVServer::Range',
      '33 pb/rpc_grpc.pb.go::KVServer::Range',
    ]);
    // A chain continued on the next line.
    expect(calls('pb/rpc_grpc.pb.go', '_KV_Put_Handler')).toEqual(['39 pb/rpc_grpc.pb.go::KVServer::Put']);
  });

  it("links a pointer assertion to the type's own method, one named like a builtin too", () => {
    expect(calls('internal/bufconn/bufconn.go', 'conn::Close')).toEqual([
      '19 internal/bufconn/bufconn.go::pipe::Close',
      '20 internal/bufconn/bufconn.go::pipe::closeWrite',
      '21 internal/bufconn/bufconn.go::pipe::close',
    ]);
  });

  it('follows embedding, a package qualifier and a dot import to the method', () => {
    // *Wrapper's Flush is promoted from *storage.Base; ReadCloser's Read from Reader.
    expect(calls('store/use.go', 'Use')).toEqual([
      '18 storage/storage.go::Base::Flush',
      '19 store/store.go::Reader::Read',
      '21 storage/storage.go::Store::Fetch',
    ]);
    expect(calls('dot/dot.go', 'Get')).toEqual(['6 storage/storage.go::Store::Fetch']);
    // An alias is the type it names.
    expect(calls('store/use.go', 'Keep')).toEqual(['49 storage/storage.go::Store::Fetch']);
    // A string argument holding a parenthesis is not the end of the call.
    expect(calls('store/use.go', 'Quoted')).toEqual([
      '35 storage/storage.go::Store::Fetch',
      '35 store/use.go::lookup',
    ]);
  });

  it('links nothing for a type from outside the project or a type literal', () => {
    // http.Flusher's Flush, on line 20 of Use, has no edge (see above).
    expect(calls('store/use.go', 'Anon')).toEqual([]);
    // Ctx is an alias of context.Context.
    expect(calls('store/use.go', 'Wait')).toEqual([]);
    const flush = cg!.getNodesInFile('store/use.go').find((n) => n.qualifiedName === 'sink::Flush')!;
    expect(cg!.getIncomingEdges(flush.id).filter((e) => e.kind === 'calls')).toEqual([]);
  });

  it("leaves a later link of the chain to the type the call before it returns", () => {
    expect(calls('store/use.go', 'Run')).toEqual([
      '29 store/store.go::Factory::New',
      '29 store/store.go::Job::Start',
    ]);
  });

  it('takes two calls of one name in a chain for the one made through the assertion', () => {
    // Both `Add` calls start at `v`, so nothing tells them apart.
    expect([...new Set(calls('store/use.go', 'Build'))]).toEqual(['41 store/store.go::Builder::Add']);
  });

  it('never links a namesake in another package or a same-file type', () => {
    const decoys = [
      ...cg!.getNodesInFile('alpha/alpha.go'),
      ...cg!.getNodesInFile('store/use.go').filter((n) => n.qualifiedName.startsWith('sink::')),
      ...cg!.getNodesInFile('pb/rpc_grpc.pb.go').filter((n) => n.qualifiedName.startsWith('UnimplementedKVServer::')),
    ].filter((n) => n.kind === 'method');
    expect(decoys.length).toBe(11);
    for (const decoy of decoys) {
      expect(cg!.getIncomingEdges(decoy.id).filter((e) => e.kind === 'calls' && e.provenance !== 'heuristic'), decoy.qualifiedName).toEqual([]);
    }
  });
});
