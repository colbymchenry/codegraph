/**
 * Go has no inheritance. gin's Engine embeds RouterGroup and declares a Use
 * of its own:
 *
 *   type Engine struct {
 *     RouterGroup
 *     …
 *   }
 *
 *   func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes {
 *     engine.RouterGroup.Use(middleware...)
 *     …
 *   }
 *
 * The embedding is an `extends` edge (#2397), and the interface-dispatch
 * bridge read every `extends` edge as an override, so it linked
 * RouterGroup.Use → Engine.Use. But a call on a *RouterGroup only ever runs
 * RouterGroup's own Use; nothing dispatches it to the embedder's. A flow or
 * impact walk through RouterGroup.Use then went on into Engine.Use. Only an
 * interface dispatches: a call through IRoutes still reaches both, through
 * the implements edges go-implements adds, and so does a call through an
 * interface a struct embeds. Java and TypeScript subclasses keep their
 * overrides.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Edge, Node } from '../src/types';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'gin/gin.go': `package gin

type HandlerFunc func()

type HandlersChain []HandlerFunc

func (c HandlersChain) Last() HandlerFunc { return nil }

type IRoutes interface {
	Use(...HandlerFunc) IRoutes
}

type RouterGroup struct{ Handlers HandlersChain }

func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes {
	group.Handlers = append(group.Handlers, middleware...)
	return group
}

type Engine struct {
	RouterGroup
	trees []string
}

func (engine *Engine) Use(middleware ...HandlerFunc) IRoutes {
	engine.RouterGroup.Use(middleware...)
	engine.rebuild404Handlers()
	return engine
}

func (engine *Engine) rebuild404Handlers() {}

// A Last of its own over the defined type it embeds.
type routeInfo struct {
	HandlersChain
	path string
}

func (r routeInfo) Last() HandlerFunc { return nil }
`,
  // etcd's client/v3/concurrency: embedded through a pointer.
  'concurrency/mutex.go': `package concurrency

type Locker interface {
	Lock()
	Unlock()
}

type Mutex struct{ key string }

func (m *Mutex) Lock()   {}
func (m *Mutex) Unlock() {}

type lockerMutex struct{ *Mutex }

func (lm *lockerMutex) Lock()   { lm.Mutex.Lock() }
func (lm *lockerMutex) Unlock() { lm.Mutex.Unlock() }
`,
  // etcd's generated gRPC stub, and a test server that overrides one RPC.
  'api/auth.go': `package api

type AuthServer interface {
	Authenticate(name string) error
	UserAdd(name string) error
}

type UnimplementedAuthServer struct{}

func (UnimplementedAuthServer) Authenticate(name string) error { return nil }
func (UnimplementedAuthServer) UserAdd(name string) error      { return nil }
`,
  'client/mock.go': `package client

import "example.com/app/api"

type mockAuthServer struct {
	api.UnimplementedAuthServer
}

func (mockAuthServer) Authenticate(name string) error { return nil }
`,
  // A struct that embeds the interface it wraps does dispatch: a call
  // through Appender on a limitAppender runs limitAppender's Append.
  'storage/appender.go': `package storage

type Appender interface {
	Append(v float64) error
	Commit() error
}

type limitAppender struct {
	Appender
	limit int
}

func (a *limitAppender) Append(v float64) error { return a.Appender.Append(v) }
`,
  'java/src/main/java/app/Base.java': 'package app;\n\npublic class Base {\n    public void run() {}\n}\n',
  'java/src/main/java/app/Derived.java':
    'package app;\n\npublic class Derived extends Base {\n    @Override\n    public void run() {}\n}\n',
  'web/shapes.ts':
    'export class Shape {\n  area(): number { return 0; }\n}\n\nexport class Square extends Shape {\n  area(): number { return 1; }\n}\n',
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-embedding-override-'));
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

/** The one non-import node with this name in this file. */
function one(name: string, file: string): Node {
  const found = cg.getNodesByName(name).filter((n) => n.filePath === file && n.kind !== 'import');
  expect(found, `${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** The method `name` that the type `owner` in `file` contains. */
function method(owner: string, name: string, file: string): Node {
  const found = cg
    .getOutgoingEdgesFrom([one(owner, file).id], ['contains'])
    .map((e) => cg.getNode(e.target))
    .filter((n): n is Node => n?.kind === 'method' && n.name === name);
  expect(found, `${owner}.${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** Where the interface-dispatch bridge sends a call to this method. */
function dispatchesTo(m: Node): string[] {
  return cg
    .getOutgoingEdgesFrom([m.id], ['calls'])
    .filter((e) => meta(e).synthesizedBy === 'interface-impl')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

/** The type that contains a method. */
function ownerOf(id: string): Node | undefined {
  return cg
    .getIncomingEdgesTo([id], ['contains'])
    .map((e) => cg.getNode(e.source))
    .find((n): n is Node => !!n && n.kind !== 'file');
}

describe('a Go embedding is not an override', () => {
  it('embeds structs and a defined type through declared supertype edges', () => {
    // The shapes the bridge used to read as inheritance.
    const types = ['Engine', 'routeInfo', 'lockerMutex', 'mockAuthServer'].map((name) =>
      cg.getNodesByName(name).find((n) => n.language === 'go' && n.kind === 'struct')!
    );
    const embeds = cg
      .getOutgoingEdgesFrom(types.map((n) => n.id), ['extends'])
      .filter((e) => e.provenance !== 'heuristic')
      .map((e) => `${cg.getNode(e.source)!.name} -> ${cg.getNode(e.target)!.kind} ${cg.getNode(e.target)!.name}`)
      .sort();
    expect(embeds).toEqual([
      'Engine -> struct RouterGroup',
      'lockerMutex -> struct Mutex',
      'mockAuthServer -> struct UnimplementedAuthServer',
      'routeInfo -> type_alias HandlersChain',
    ]);
  });

  it('links no method of an embedded struct or defined type to the embedder\'s method of that name', () => {
    expect(dispatchesTo(method('RouterGroup', 'Use', 'gin/gin.go'))).toEqual([]);
    expect(dispatchesTo(method('HandlersChain', 'Last', 'gin/gin.go'))).toEqual([]);
    expect(dispatchesTo(method('Mutex', 'Lock', 'concurrency/mutex.go'))).toEqual([]);
    expect(dispatchesTo(method('UnimplementedAuthServer', 'Authenticate', 'api/auth.go'))).toEqual([]);
    // Nor anywhere else: every Go dispatch edge starts at an interface method.
    const goMethods = cg.getNodesByKind('method').filter((n) => n.language === 'go');
    const fromConcrete = cg
      .getOutgoingEdgesFrom(goMethods.map((n) => n.id), ['calls'])
      .filter((e) => meta(e).synthesizedBy === 'interface-impl' && ownerOf(e.source)?.kind !== 'interface')
      .map((e) => `${cg.getNode(e.source)!.qualifiedName} -> ${cg.getNode(e.target)!.qualifiedName}`);
    expect(fromConcrete).toEqual([]);
  });

  it('ends a walk through the embedded type\'s method at that method', () => {
    const groupUse = method('RouterGroup', 'Use', 'gin/gin.go');
    const engineUse = method('Engine', 'Use', 'gin/gin.go');
    expect(cg.getCallees(groupUse.id).map((c) => c.node.qualifiedName)).not.toContain('Engine::Use');
    expect(cg.getCallers(engineUse.id).map((c) => c.node.qualifiedName)).not.toContain('RouterGroup::Use');
    expect([...cg.getImpactRadius(engineUse.id).nodes.values()].map((n) => n.qualifiedName)).not.toContain(
      'RouterGroup::Use'
    );
  });

  it('still dispatches a call through an interface to each type that implements it', () => {
    expect(dispatchesTo(method('IRoutes', 'Use', 'gin/gin.go'))).toEqual(['Engine::Use', 'RouterGroup::Use']);
    expect(dispatchesTo(method('Locker', 'Lock', 'concurrency/mutex.go'))).toEqual([
      'Mutex::Lock',
      'lockerMutex::Lock',
    ]);
    // limitAppender embeds Appender: a declared edge, not a synthesized one.
    expect(dispatchesTo(method('Appender', 'Append', 'storage/appender.go'))).toEqual(['limitAppender::Append']);
  });

  it('keeps the overrides of languages with inheritance', () => {
    const run = method('Base', 'run', 'java/src/main/java/app/Base.java');
    expect(dispatchesTo(run).map((qn) => qn.replace(/^.*?(Derived)/, '$1'))).toEqual(['Derived::run']);
    const area = method('Shape', 'area', 'web/shapes.ts');
    expect(dispatchesTo(area).map((qn) => qn.replace(/^.*?(Square)/, '$1'))).toEqual(['Square::area']);
  });
});
