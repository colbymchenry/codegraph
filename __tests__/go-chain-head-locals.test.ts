/**
 * A Go local given a chain that starts with `new(T)` or a composite literal
 * has the type the chain's last call returns, not T (#3447). `sub :=
 * new(Route).Host("x").Subrouter()` is a `*Router`, but the local was typed
 * by the start of its value alone, `new(Route)`, so `sub.Path("/a")` reached
 * `Route`'s `Path`: gorilla/mux's subrouter tests are written this way. Only
 * a value that is the `new(T)` or the literal and nothing more types the
 * local by what it writes; a chain is read like any other call's result.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/p\n\ngo 1.22\n',
  'a_router.go': `package p

type Router struct{}

func (r *Router) Path(p string) *Route { return &Route{} }
`,
  'b_route.go': `package p

type Route struct{}

func (r *Route) Path(p string) *Route { return r }

func (r *Route) Host(h string) *Route { return r }

func (r *Route) Subrouter() *Router { return &Router{} }

func NewRoute() *Route { return &Route{} }

type Plain struct{ Name string }

func (p Plain) Path(s string) Plain { return p }

func (p Plain) Router() *Router { return &Router{} }

type Set map[string]struct{}

func (s Set) Path(k string) Set { return s }

func (s Set) Router() *Router { return &Router{} }
`,
  'use.go': `package p

func fromNew() {
	sub := new(Route).Host("x").Subrouter()
	sub.Path("/a")
}

func fromNewShort() {
	sub := new(Route).Subrouter()
	sub.Path("/a")
}

func fromNewBroken() {
	sub := new(Route).
		Host("x").
		Subrouter()
	sub.Path("/a")
}

func fromFuncBroken() {
	sub := NewRoute().
		Host("x").
		Subrouter()
	sub.Path("/a")
}

func fromNewSpaced() {
	sub := new(Route) .Subrouter()
	sub.Path("/a")
}

func fromMake() {
	sub := make(Set).Router()
	sub.Path("/a")
}

func fromValueLiteral() {
	sub := Plain{}.Router()
	sub.Path("/a")
}

func fromFilledLiteral() {
	sub := Plain{
		Name: "x",
	}.Router()
	sub.Path("/a")
}

func fromLiteral() {
	sub := (&Route{}).Host("x").Subrouter()
	sub.Path("/a")
}

func fromFunc() {
	sub := NewRoute().Host("x").Subrouter()
	sub.Path("/a")
}

func fromLocal() {
	rt := new(Route)
	sub := rt.Subrouter()
	sub.Path("/a")
}

func plainNew() {
	x := new(Route)
	x.Path("/a")
}

func plainPointerLiteral() {
	x := &Route{}
	x.Path("/a")
}

func plainValueLiteral() {
	x := Plain{}
	x.Path("/a")
}

func plainFilledLiteral() {
	x := Plain{
		Name: "x",
	}
	x.Path("/a")
}
`,
};

describe.each(['default', 'wasm'])('a Go local given a chain is typed by what the chain returns (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-chain-head-'));
    for (const [rel, content] of Object.entries(FILES)) {
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

  /** The `Path` methods the function `name` in use.go calls, as `<file>::<qualified name>`. */
  function pathCalls(name: string): string[] {
    const fn = cg!.getNodesInFile('use.go').find((n) => n.name === name && n.kind === 'function');
    expect(fn, name).toBeDefined();
    return cg!
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!)
      .filter((n) => n.name === 'Path')
      .map((n) => `${n.filePath}::${n.qualifiedName}`)
      .sort();
  }

  const ROUTER = ['a_router.go::Router::Path'];

  it("types the issue's `new(Route)…Subrouter()` locals as the Router the chain returns", () => {
    expect(pathCalls('fromNew')).toEqual(ROUTER);
    expect(pathCalls('fromNewShort')).toEqual(ROUTER);
  });

  it('reads a chain written with a space before its `.`', () => {
    expect(pathCalls('fromNewSpaced')).toEqual(ROUTER);
  });

  it("gives a chain broken after a `.` no type of its start's: it is read as a function's broken chain is", () => {
    expect(pathCalls('fromNewBroken')).not.toContain('b_route.go::Route::Path');
    expect(pathCalls('fromNewBroken')).toEqual(pathCalls('fromFuncBroken'));
  });

  it('reads a chain that starts with `make(T)` the same way', () => {
    expect(pathCalls('fromMake')).toEqual(ROUTER);
  });

  it('reads a chain that starts with a composite literal, on one line or several', () => {
    expect(pathCalls('fromValueLiteral')).toEqual(ROUTER);
    expect(pathCalls('fromFilledLiteral')).toEqual(ROUTER);
  });

  it('leaves the chains that already resolved as they were', () => {
    expect(pathCalls('fromLiteral')).toEqual(ROUTER);
    expect(pathCalls('fromFunc')).toEqual(ROUTER);
    expect(pathCalls('fromLocal')).toEqual(ROUTER);
  });

  it('still types a local by the `new(T)` or the literal that is its whole value', () => {
    expect(pathCalls('plainNew')).toEqual(['b_route.go::Route::Path']);
    expect(pathCalls('plainPointerLiteral')).toEqual(['b_route.go::Route::Path']);
    expect(pathCalls('plainValueLiteral')).toEqual(['b_route.go::Plain::Path']);
    expect(pathCalls('plainFilledLiteral')).toEqual(['b_route.go::Plain::Path']);
  });
});
