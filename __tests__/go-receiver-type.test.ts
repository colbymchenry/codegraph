/**
 * Go method calls through a receiver whose type is written somewhere other
 * than a plain parameter of the caller's own package:
 *
 * - a package-qualified parameter (`s *store.Store`);
 * - the result of a function or a conversion (`r := newRing()`, `s :=
 *   store.NewStore()`, `list := web.Users(names)`).
 *
 * A receiver typed outside the project (`conn net.Conn`, `ctx
 * context.Context`, `c, _ := net.Dial(…)`, an alias `type Ctx =
 * context.Context`) gets no edge rather than a project method that happens
 * to share the name, and so does a project function's result declared as an
 * outside type (`*os.File`, `http.RoundTripper`).
 *
 * Cases first written for PR #1954 by @danusha2345.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

async function indexProject(files: Record<string, string>): Promise<{ dir: string; cg: CodeGraph }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-go-recv-'));
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

/** `file::Qualified::name` of every method `caller` (a function name) calls. */
async function methodCallees(cg: CodeGraph, caller: string): Promise<string[]> {
  const node = (await cg.searchNodes(caller, { limit: 20 })).find(
    (r) => r.node.name === caller && r.node.kind === 'function',
  );
  expect(node, caller).toBeDefined();
  return (await cg.getCallees(node!.node.id))
    .filter((c) => c.node.kind === 'method')
    .map((c) => `${c.node.filePath}::${c.node.qualifiedName}`)
    .sort();
}

describe('Go receiver typing', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ dir, cg } = await indexProject({
      'main.go': `package main

import (
	"bytes"
	"net"
	"net/http"
	"os"

	"example.com/app/other"
	"example.com/app/store"
)

type ringLog struct{ buf []byte }

func (r *ringLog) Write(b []byte)  {}
func (r *ringLog) Reset()          {}
func (r *ringLog) Reader() *reader { return &reader{} }

type reader struct{}

func (r *reader) Reset() {}

type Engine struct{}

func (e *Engine) Run() *Engine { return e }
func (e *Engine) Stop()        {}

func newRing() *ringLog              { return &ringLog{} }
func NewEngine(n int) (*Engine, error) { return &Engine{}, nil }
func open() (*os.File, error)        { return nil, nil }
func wrap(e *Engine) *ringLog        { return nil }

type limiter struct{}

func (l *limiter) RoundTrip(r *http.Request) (*http.Response, error) { return nil, nil }

func transport() http.RoundTripper { return &limiter{} }

func lowerParam(ring *ringLog, b []byte) { ring.Write(b) }
func lowerValueParam(ring ringLog)       { ring.Reset() }
func groupedParam(a, ring *ringLog)      { ring.Reset() }
func lowerCtor()                         { r := newRing(); r.Reset() }
func exportedCtor()                      { e, _ := NewEngine(1); e.Stop() }
func qualifiedParam(s *store.Store)      { s.Put("a") }
func qualifiedCtor()                     { s := store.NewStore(); s.Put("b") }

func multiLineCtor() {
	e, err := NewEngine(
		1,
	)
	_ = err
	e.Stop()
}

func ifCtor() {
	if r := newRing(); r != nil {
		r.Write(nil)
	}
}

// \`r\` is what Reader returns: a reader, not a ringLog.
func chainedCtor() { r := newRing().Reader(); r.Reset() }

// On the binding's own line \`e\` is still the parameter; inside the
// \`if\`, \`e\` is what wrap returns.
func selfArg(e *Engine) {
	if e := wrap(e.Run()); e != nil {
		e.Write(nil)
	}
}

func stdlibParam(buf *bytes.Buffer)     { buf.Truncate(0) }
func stdlibCtor()                       { c, _ := net.Dial("tcp", ""); c.RemoteAddr() }
func projectFuncReturningStdlib()       { f, _ := open(); f.Truncate(0) }
func interfaceResult()                  { rt := transport(); rt.RoundTrip(nil) }
func netParam(conn net.Conn)            { conn.LocalAddr() }

// The \`r\` of the block, or of the function literal, is gone by the call.
func blockShadow() {
	r := newRing()
	if true {
		r := other.New()
		_ = r
	}
	r.Write(nil)
}

func closureShadow() {
	r := newRing()
	go func() { r := other.New(); _ = r }()
	r.Write(nil)
}

type Holder struct{}

func (h *Holder) New() *Item { return &Item{} }

type Item struct{}

func (i *Item) Save() {}

// \`store\` is the parameter, not the imported package.
func shadowPkg(store *Holder) { x := store.New(); x.Save() }

func main() {}
`,
      'store/store.go': `package store

type Store struct{}

func NewStore() *Store { return &Store{} }

func (s *Store) Put(k string) {}

type Thing struct{}

func New() *Thing { return &Thing{} }

func (t *Thing) Save() {}
`,
      'other/other.go': `package other

type Other struct{}

func New() *Other { return &Other{} }

func (o *Other) Write(b []byte) {}
`,
      // Same-named methods elsewhere, so a guess by name has somewhere wrong to go.
      'decoy/decoy.go': `package decoy

type Decoy struct{}

func (d *Decoy) Write(b []byte) {}
func (d *Decoy) Reset()         {}
func (d *Decoy) Run()           {}
func (d *Decoy) Stop()          {}
func (d *Decoy) Put(k string)   {}
func (d *Decoy) Truncate(n int) {}
func (d *Decoy) RemoteAddr()    {}
func (d *Decoy) LocalAddr()     {}

type Store struct{}

func (s *Store) Put(k string) {}
`,
    }));
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['lowerParam', ['main.go::ringLog::Write']],
    ['lowerValueParam', ['main.go::ringLog::Reset']],
    ['groupedParam', ['main.go::ringLog::Reset']],
  ])('%s: a receiver named like a standard-library package resolves on its type', async (caller, expected) => {
    expect(await methodCallees(cg, caller)).toEqual(expected);
  });

  it.each([
    ['lowerCtor', ['main.go::ringLog::Reset']],
    ['exportedCtor', ['main.go::Engine::Stop']],
    ['multiLineCtor', ['main.go::Engine::Stop']],
    ['ifCtor', ['main.go::ringLog::Write']],
    ['qualifiedCtor', ['store/store.go::Store::Put']],
  ])('%s: a receiver bound to a call resolves on what the callee returns', async (caller, expected) => {
    expect(await methodCallees(cg, caller)).toEqual(expected);
  });

  it('a package-qualified parameter resolves in that package', async () => {
    expect(await methodCallees(cg, 'qualifiedParam')).toEqual(['store/store.go::Store::Put']);
  });

  it('a binding is typed by the whole chain, and from the end of its own line', async () => {
    expect(await methodCallees(cg, 'chainedCtor')).toEqual(['main.go::reader::Reset', 'main.go::ringLog::Reader']);
    expect(await methodCallees(cg, 'selfArg')).toEqual(['main.go::Engine::Run', 'main.go::ringLog::Write']);
  });

  it.each(['stdlibParam', 'stdlibCtor', 'projectFuncReturningStdlib', 'netParam'])(
    '%s: a receiver typed outside the project gets no edge',
    async (caller) => {
      expect(await methodCallees(cg, caller)).toEqual([]);
    },
  );

  // Real code's by-name guesses here mostly took a namesake: prometheus's
  // `handler := NewWriteHandler(…)` went to `readHandler::ServeHTTP`.
  it('an outside interface a project function returns links nothing', async () => {
    expect(await methodCallees(cg, 'interfaceResult')).toEqual([]);
  });

  it.each(['blockShadow', 'closureShadow'])(
    '%s: a `:=` in a block that closed before the call is another variable',
    async (caller) => {
      expect(await methodCallees(cg, caller)).toEqual(['main.go::ringLog::Write']);
    },
  );

  it('a parameter named like an imported package is the parameter, and types what its method returns', async () => {
    expect(await methodCallees(cg, 'shadowPkg')).toEqual(['main.go::Holder::New', 'main.go::Item::Save']);
  });
});

describe('Go receiver typing through conversions and aliases', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ dir, cg } = await indexProject({
      'web/context.go': `package web

type Context struct{}

func (c *Context) MakeAuditRecord() {}

type Users []string

func (u Users) Usernames() []string { return nil }
`,
      'api4/handlers.go': `package api4

import (
	"context"

	"example.com/app/web"
)

type Context = web.Context

type (
	Handler = *web.Context
	Ctx     = context.Context
)

type Defined web.Context

func projectAlias(h Handler)             { h.MakeAuditRecord() }
func conversion(names []string)          { list := web.Users(names); list.Usernames() }
func definedType(d *Defined)             { d.MakeAuditRecord() }
func stdlibReceiver(ctx context.Context) { ctx.Done() }
func aliasedStdlib(ctx Ctx)              { ctx.Done() }
`,
      // Same-named types and methods elsewhere, so neither a lookup by type
      // name nor a guess by method name has a single answer to fall back on.
      'decoy/decoy.go': `package decoy

type Context struct{}

func (c *Context) MakeAuditRecord() {}

// Named like the alias of an outside type in api4.
type Ctx struct{}

func (c *Ctx) Done() {}

type Decoy struct{}

func (d *Decoy) Done()      {}
func (d *Decoy) Usernames() {}
`,
    }));
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a receiver bound to a conversion resolves on the converted type', async () => {
    expect(await methodCallees(cg, 'conversion')).toEqual(['web/context.go::Users::Usernames']);
  });

  it('an alias of a project type still resolves on that type', async () => {
    expect(await methodCallees(cg, 'projectAlias')).toEqual(['web/context.go::Context::MakeAuditRecord']);
  });

  it.each(['definedType', 'stdlibReceiver', 'aliasedStdlib'])(
    '%s: a defined type, or a receiver typed outside the project, gets no edge',
    async (caller) => {
      expect(await methodCallees(cg, caller)).toEqual([]);
    },
  );
});

describe('Go receiver typing through what a call hands back', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ dir, cg } = await indexProject({
      'svc/svc.go': `package svc

import (
	"sync"

	"google.golang.org/grpc"
)

type Client struct{}

func (c *Client) Do() {}

type monitor struct {
	client func() (*Client, error)
}

func (m *monitor) run() {
	c, _ := m.client()
	c.Do()
}

type Result struct{}

func (r *Result) Done() {}

type Converter struct{}

func (c *Converter) Convert() (*Result, error) { return &Result{}, nil }

var pool sync.Pool

func pooled() {
	conv := pool.Get().(*Converter)
	out, _ := conv.Convert()
	out.Done()
}

type Resp struct{}

func (r *Resp) GetKind() string { return "" }

func stream(s grpc.ServerStreamingClient[Resp]) {
	chunk, _ := s.Recv()
	chunk.GetKind()
}
`,
      'watch/watch.go': `package watch

type Watcher struct{}

func NewWatcher() *Watcher { return &Watcher{} }

func (w *Watcher) Stop() {}
`,
      'watch/watch_test.go': `package watch_test

import (
	"testing"

	. "example.com/app/watch"
)

func TestStop(t *testing.T) {
	w := NewWatcher()
	w.Stop()
}
`,
      // Namesakes, so a guess by the method's name has somewhere wrong to go.
      'decoy/decoy.go': `package decoy

type Decoy struct{}

func (d *Decoy) Do()   {}
func (d *Decoy) Done() {}
func (d *Decoy) Stop() {}
`,
    }));
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const callees = async (caller: string, kind: 'function' | 'method' = 'function'): Promise<string[]> => {
    const node = (await cg.searchNodes(caller, { limit: 20 })).find((r) => r.node.name === caller && r.node.kind === kind);
    expect(node, caller).toBeDefined();
    return (await cg.getCallees(node!.node.id))
      .filter((c) => c.node.kind === 'method')
      .map((c) => `${c.node.filePath}::${c.node.qualifiedName}`)
      .sort();
  };

  it('a func-typed field is called for the result its type declares', async () => {
    expect(await callees('run', 'method')).toEqual(['svc/svc.go::Client::Do']);
  });

  it('an assertion types the value, whatever hands it out', async () => {
    expect(await callees('pooled')).toEqual(['svc/svc.go::Converter::Convert', 'svc/svc.go::Result::Done']);
  });

  it('a function a dot import brings in types its result', async () => {
    expect(await callees('TestStop')).toEqual(['watch/watch.go::Watcher::Stop']);
  });

  it('what an outside generic type hands back is left to name matching, as before', async () => {
    expect(await callees('stream')).toEqual(['svc/svc.go::Resp::GetKind']);
  });
});
