/**
 * Go method calls through a receiver whose type is written somewhere other
 * than a plain parameter of the caller's own package:
 *
 * - a variable named like a standard-library package the file does not
 *   import (`ring *ringLog`, `token := get()`), which used to be skipped as
 *   a call into that package;
 * - a package-qualified parameter (`s *store.Store`);
 * - the result of a function or a conversion (`r := newRing()`, `s :=
 *   store.NewStore()`, `list := web.Users(names)`).
 *
 * A receiver typed outside the project (`conn net.Conn`, `ctx
 * context.Context`, `c, _ := net.Dial(…)`, an alias `type Ctx =
 * context.Context`) gets no edge rather than a project method that happens
 * to share the name. A project function's result
 * declared as an outside type by value (`http.RoundTripper`) is left as it
 * was: that is usually an interface a project type implements.
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

// \`r\` is what Reader returns, which is not read: not a ringLog.
func chainedCtor() { r := newRing().Reader(); r.Reset() }

// On the binding's own line \`e\` is still the parameter.
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
func untyped(get func() net.Conn)       { token := get(); token.LocalAddr() }

func main() {}
`,
      'store/store.go': `package store

type Store struct{}

func NewStore() *Store { return &Store{} }

func (s *Store) Put(k string) {}
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

  it('a binding is not typed by the head of a call chain, nor on its own line', async () => {
    expect(await methodCallees(cg, 'chainedCtor')).not.toContain('main.go::ringLog::Reset');
    expect(await methodCallees(cg, 'selfArg')).toEqual(['main.go::Engine::Run']);
  });

  it.each(['stdlibParam', 'stdlibCtor', 'projectFuncReturningStdlib', 'netParam', 'untyped'])(
    '%s: a receiver typed outside the project, or untyped, gets no edge',
    async (caller) => {
      expect(await methodCallees(cg, caller)).toEqual([]);
    },
  );

  it('an outside interface a project function returns still reaches its implementation', async () => {
    expect(await methodCallees(cg, 'interfaceResult')).toEqual(['main.go::limiter::RoundTrip']);
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
