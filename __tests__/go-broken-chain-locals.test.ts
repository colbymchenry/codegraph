/**
 * gofmt breaks a long Go chain after its `.`s:
 *
 *   sub := NewRoute().
 *       Host("x").
 *       Subrouter()
 *
 * A local's value was read to the end of its declaration's line, so it got
 * no type from such a chain, or the type of a `new(T)` or literal it starts
 * with, and `sub.Path("/a")` linked nothing or the wrong `Path` (#3455). A
 * line that ends at a `.` now carries the value on, in a `:=`, a `var` and an
 * `if` header, whatever the chain starts from.
 *
 * The fixture is the issue's own: each function calls `Path` on a local the
 * way it names, and the table is where that call should link.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const SOURCE = `package repro

type Router struct{}
type Route struct{}
type Plain struct{ Name string }

func (r *Router) Path(p string) *Route { return &Route{} }
func (r *Route) Path(p string) *Route  { return r }
func (r *Route) Host(h string) *Route  { return r }
func (r *Route) Subrouter() *Router    { return &Router{} }
func (p Plain) Path(s string) *Route   { return &Route{} }
func (p Plain) Router() *Router        { return &Router{} }

func NewRoute() *Route { return &Route{} }

func funcOneLine() {
    sub := NewRoute().Host("x").Subrouter()
    sub.Path("/a")
}

func funcBroken() {
    sub := NewRoute().
        Host("x").
        Subrouter()
    sub.Path("/a")
}

func funcBrokenOnce() {
    sub := NewRoute().Host("x").
        Subrouter()
    sub.Path("/a")
}

func funcBrokenInParens() {
    sub := NewRoute().Host(
        "x",
    ).Subrouter()
    sub.Path("/a")
}

func localOneLine() {
    rt := NewRoute()
    sub := rt.Host("x").Subrouter()
    sub.Path("/a")
}

func localBroken() {
    rt := NewRoute()
    sub := rt.
        Host("x").
        Subrouter()
    sub.Path("/a")
}

func varBroken() {
    var sub = NewRoute().
        Host("x").
        Subrouter()
    sub.Path("/a")
}

func ifBroken() {
    if sub := NewRoute().
        Host("x").
        Subrouter(); sub != nil {
        sub.Path("/a")
    }
}

func ptrLiteralOneLine() {
    sub := (&Route{}).Host("x").Subrouter()
    sub.Path("/a")
}

func ptrLiteralBroken() {
    sub := (&Route{}).
        Host("x").
        Subrouter()
    sub.Path("/a")
}

func literalOneLine() {
    sub := Plain{}.Router()
    sub.Path("/a")
}

func literalBroken() {
    sub := Plain{}.
        Router()
    sub.Path("/a")
}

func literalFieldsBroken() {
    sub := Plain{
        Name: "x",
    }.
        Router()
    sub.Path("/a")
}

func newOneLine() {
    sub := new(Route).Subrouter()
    sub.Path("/a")
}

func newBroken() {
    sub := new(Route).
        Subrouter()
    sub.Path("/a")
}

func newBuilderBroken() {
    b := new(Route).
        Host("x")
    b.Path("/a")
}

func directBroken() {
    NewRoute().
        Host("x").
        Subrouter().
        Path("/a")
}

func returnBroken() *Route {
    return NewRoute().
        Host("x").
        Subrouter().
        Path("/a")
}
`;

/** Where each function's `Path` call links, from the issue's "Expected". */
const EXPECTED: Record<string, string> = {
  funcOneLine: 'Router::Path',
  funcBroken: 'Router::Path',
  funcBrokenOnce: 'Router::Path',
  funcBrokenInParens: 'Router::Path',
  localOneLine: 'Router::Path',
  localBroken: 'Router::Path',
  varBroken: 'Router::Path',
  ifBroken: 'Router::Path',
  ptrLiteralOneLine: 'Router::Path',
  ptrLiteralBroken: 'Router::Path',
  literalOneLine: 'Router::Path',
  literalBroken: 'Router::Path',
  literalFieldsBroken: 'Router::Path',
  newOneLine: 'Router::Path',
  newBroken: 'Router::Path',
  // The chain returns the type it starts from.
  newBuilderBroken: 'Route::Path',
  directBroken: 'Router::Path',
  returnBroken: 'Router::Path',
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-broken-chain-'));
  fs.writeFileSync(path.join(root, 'go.mod'), 'module repro\n\ngo 1.21\n');
  fs.writeFileSync(path.join(root, 'm.go'), SOURCE);
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The `Path` methods the function `name` calls, by qualified name. */
function pathCalls(name: string): string[] {
  const fn = cg.getNodesByName(name).find((n) => n.kind === 'function');
  expect(fn, name).toBeDefined();
  return cg.getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target))
    .filter((n) => n?.name === 'Path')
    .map((n) => n!.qualifiedName)
    .sort();
}

describe('a Go local given a chain broken after its `.`s (#3455)', () => {
  it.each(Object.entries(EXPECTED))('%s calls %s', (name, target) => {
    expect(pathCalls(name)).toEqual([target]);
  });
});
