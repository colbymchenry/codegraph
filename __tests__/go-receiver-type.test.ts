/**
 * Go method calls through a typed receiver resolve on the receiver's declared
 * type: an unexported (`ring *ringLog`) or package-qualified (`s *store.Store`)
 * parameter, a constructor's result (`r := newRing()`, `s := store.NewStore()`),
 * a field of such a receiver, and a receiver named like a standard-library
 * package the file does not import (`ring`, `token`). A receiver typed outside
 * the project (`buf *bytes.Buffer`, `conn net.Conn`, `err error`) gets no edge
 * rather than a same-named project method.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const MAIN = `package main

import (
	"bytes"
	"net"

	"example.com/app/store"
)

type ringLog struct{ buf []byte }

func (r *ringLog) Write(b []byte) {}
func (r *ringLog) Reset()         {}

type Engine struct{}

func (e *Engine) Run()  {}
func (e *Engine) Stop() {}

func newRing() *ringLog               { return &ringLog{} }
func NewEngine() (*Engine, error)     { return &Engine{}, nil }
func dial() (net.Conn, error)         { return nil, nil }

type holder struct {
	ring *ringLog
	eng  Engine
}

type outer struct {
	*Engine
}

type tariff interface{ Rates() }

type Combined struct{ tariffs []tariff }

func lowerParam(ring *ringLog, b []byte) { ring.Write(b) }
func lowerValueParam(ring ringLog)       { ring.Reset() }
func groupedParam(a, ring *ringLog)      { ring.Reset() }
func (r *ringLog) ownReceiver()          { r.Reset() }
func lowerCtor()                         { r := newRing(); r.Reset() }
func exportedCtor()                      { e, _ := NewEngine(); e.Stop() }
func fieldOfParam(h *holder)             { h.ring.Reset() }
func (h *holder) fieldOfReceiver()       { h.ring.Reset(); h.eng.Run() }
func qualifiedParam(s *store.Store)      { s.Put("a") }
func qualifiedCtor()                     { s := store.NewStore(); s.Put("b") }
func promoted(o *outer)                  { o.Stop() }

func (t *Combined) Rates() {
	for _, t := range t.tariffs {
		t.Rates()
	}
}

func stdlibParam(buf *bytes.Buffer, b []byte) { buf.Write(b) }
func stdlibCtor()                             { c, _ := net.Dial("tcp", ""); c.Write(nil) }
func projectFuncReturningStdlib()             { c, _ := dial(); c.Write(nil) }
func builtinParam(err error)                  { _ = err.Error() }
func netParam(conn net.Conn)                  { conn.LocalAddr() }
func untyped(get func() *ringLog)             { token := get(); token.Reset() }

func main() {}
`;

const STORE = `package store

type Store struct{}

func NewStore() *Store { return &Store{} }

func (s *Store) Put(k string) {}
`;

// Same-named methods elsewhere, so a name-only guess has somewhere wrong to go.
const DECOY = `package decoy

type Decoy struct{}

func (d *Decoy) Write(b []byte) {}
func (d *Decoy) Reset()         {}
func (d *Decoy) Run()           {}
func (d *Decoy) Stop()          {}
func (d *Decoy) Put(k string)   {}
func (d *Decoy) Rates()         {}
func (d *Decoy) Error() string  { return "" }
func (d *Decoy) LocalAddr()     {}

type Buffer struct{}

func (b *Buffer) Write(p []byte) {}

type Store struct{}

func (s *Store) Put(k string) {}
`;

describe('Go receiver typing', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-go-recv-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
    fs.writeFileSync(path.join(dir, 'main.go'), MAIN);
    fs.mkdirSync(path.join(dir, 'store'));
    fs.writeFileSync(path.join(dir, 'store', 'store.go'), STORE);
    fs.mkdirSync(path.join(dir, 'decoy'));
    fs.writeFileSync(path.join(dir, 'decoy', 'decoy.go'), DECOY);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `file::Qualified::name` of every method `caller` (a name or `Type::name`) calls. */
  async function methodCallees(caller: string): Promise<string[]> {
    const node = (await cg.searchNodes(caller.split('::').pop()!, { limit: 20 })).find(
      (r) =>
        (r.node.name === caller || r.node.qualifiedName === caller) &&
        (r.node.kind === 'function' || r.node.kind === 'method'),
    );
    expect(node, caller).toBeDefined();
    return (await cg.getCallees(node!.node.id))
      .filter((c) => c.node.kind === 'method')
      .map((c) => `${c.node.filePath}::${c.node.qualifiedName}`);
  }

  it.each([
    ['lowerParam', ['main.go::ringLog::Write']],
    ['lowerValueParam', ['main.go::ringLog::Reset']],
    ['groupedParam', ['main.go::ringLog::Reset']],
    ['ownReceiver', ['main.go::ringLog::Reset']],
    ['lowerCtor', ['main.go::ringLog::Reset']],
    ['exportedCtor', ['main.go::Engine::Stop']],
    ['fieldOfParam', ['main.go::ringLog::Reset']],
    ['fieldOfReceiver', ['main.go::ringLog::Reset', 'main.go::Engine::Run']],
    ['qualifiedParam', ['store/store.go::Store::Put']],
    ['qualifiedCtor', ['store/store.go::Store::Put']],
    ['promoted', ['main.go::Engine::Stop']],
  ])('%s resolves on the receiver type', async (caller, expected) => {
    expect((await methodCallees(caller)).sort()).toEqual([...expected].sort());
  });

  it('a range variable shadows the method receiver of the same name', async () => {
    // `t` in the loop is a `tariff`, not the `*Combined` receiver: no self-edge.
    expect(await methodCallees('Combined::Rates')).not.toContain('main.go::Combined::Rates');
  });

  it.each([
    'stdlibParam',
    'stdlibCtor',
    'projectFuncReturningStdlib',
    'builtinParam',
    'netParam',
    'untyped',
  ])('%s: a receiver typed outside the project, or untyped, gets no edge', async (caller) => {
    expect(await methodCallees(caller)).toEqual([]);
  });

  it('a package-level function call still resolves', async () => {
    const node = (await cg.searchNodes('qualifiedCtor', { limit: 5 })).find((r) => r.node.name === 'qualifiedCtor');
    const callees = (await cg.getCallees(node!.node.id)).map((c) => `${c.node.filePath}::${c.node.qualifiedName}`);
    expect(callees).toContain('store/store.go::NewStore');
  });
});

/**
 * A receiver typed through an alias (`type Context = web.Context`) is the
 * aliased type, a conversion (`list := web.Users(names)`) is the type it
 * names, and a method promoted from an embedded struct — another
 * package's (`*cached.BaseManager`), or two levels down — is the embedded
 * type's. A defined type (`type Defined web.Context`, no `=`) does not
 * inherit its underlying type's methods.
 */
describe('Go receiver typing through aliases and embedded structs', () => {
  let dir: string;
  let cg: CodeGraph;

  const files: Record<string, string> = {
    'app/app.go': `package app

type App struct{}

func (a *App) GetUser() {}
`,
    'web/context.go': `package web

import "example.com/app/app"

type Context struct {
	App *app.App
}

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
)

type Defined web.Context

func getUser(c *Context) {
	c.App.GetUser()
	c.MakeAuditRecord()
}

func groupedPointerAlias(h Handler)  { h.MakeAuditRecord() }
func conversion(names []string)      { list := web.Users(names); list.Usernames() }
func definedType(d *Defined)         { d.MakeAuditRecord() }
func stdlibReceiver(ctx context.Context) { ctx.Done() }
`,
    'cached/base.go': `package cached

type BaseManager struct{}

func (b *BaseManager) CacheClient() {}
`,
    'mgr/manager.go': `package mgr

import "example.com/app/cached"

type Manager struct {
	*cached.BaseManager
	name string
}

type Middle struct {
	*cached.BaseManager
}

type Outer struct {
	Middle
}

func (m *Manager) Get()  { m.CacheClient() }
func (o *Outer) Twice()  { o.CacheClient() }
`,
    // Same-named types and methods elsewhere, so neither the package-blind
    // lookup nor a name-only guess has a single answer to fall back on.
    'decoy/decoy.go': `package decoy

type Context struct{}

func (c *Context) MakeAuditRecord() {}

type Manager struct{}
type Middle struct{}
type Outer struct{}

type Decoy struct{}

func (d *Decoy) CacheClient()     {}
func (d *Decoy) GetUser()         {}
func (d *Decoy) MakeAuditRecord() {}
func (d *Decoy) Done()            {}
func (d *Decoy) Usernames()       {}
`,
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-go-alias-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function methodCallees(caller: string): Promise<string[]> {
    const node = (await cg.searchNodes(caller.split('::').pop()!, { limit: 20 })).find(
      (r) =>
        (r.node.name === caller || r.node.qualifiedName === caller) &&
        (r.node.kind === 'function' || r.node.kind === 'method'),
    );
    expect(node, caller).toBeDefined();
    return (await cg.getCallees(node!.node.id))
      .filter((c) => c.node.kind === 'method')
      .map((c) => `${c.node.filePath}::${c.node.qualifiedName}`)
      .sort();
  }

  it.each([
    ['getUser', ['app/app.go::App::GetUser', 'web/context.go::Context::MakeAuditRecord']],
    ['groupedPointerAlias', ['web/context.go::Context::MakeAuditRecord']],
    ['conversion', ['web/context.go::Users::Usernames']],
    ['Manager::Get', ['cached/base.go::BaseManager::CacheClient']],
    ['Outer::Twice', ['cached/base.go::BaseManager::CacheClient']],
  ])('%s resolves through the alias, the conversion or the embedded struct', async (caller, expected) => {
    expect(await methodCallees(caller)).toEqual(expected);
  });

  it.each(['definedType', 'stdlibReceiver'])(
    '%s: a defined type or a receiver typed outside the project gets no edge',
    async (caller) => {
      expect(await methodCallees(caller)).toEqual([]);
    },
  );
});
