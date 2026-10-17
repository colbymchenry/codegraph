/**
 * The Go framework resolver's name heuristics ("a `…Handler` is a handler
 * function", "a PascalCase name is a model struct") outrank name matching on a
 * tie, so where they guess wrong nothing corrects them. Go reads a name from
 * one package only — one written bare from the reference's own, `pkg.Name`
 * from that import's, `x[i].Name()` from whatever type `x[i]` has — so they
 * guess only for a bare name, and only in its own package. Before, they took
 * a struct of that name from any package: prometheus's promql/parser `Node`
 * parameters went to discovery/kubernetes's struct `Node` instead of the
 * package's own `Node` interface, and every `.String()` called through an
 * expression became an instantiation of the struct `promql.String`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-own-pkg-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'promql/parser/ast.go': `package parser

type Node interface {
	String() string
}

type Visitor interface {
	Visit(node Node, path []Node) (Visitor, error)
}

func Walk(v Visitor, node Node, path []Node) error {
	return nil
}
`,
    'discovery/kubernetes/node.go': `package kubernetes

import apiv1 "k8s.io/api/core/v1"

type Node struct {
	name string
}

func nodeSource(n *apiv1.Node) string {
	return n.Name
}
`,
    'storage/interface.go': `package storage

type Appender interface {
	Append(ref uint64) error
}

type Filter interface {
	Accept(value string) bool
}
`,
    'storage/fanout.go': `package storage

type fanout struct{}

func (f *fanout) Appender() Appender {
	return nil
}
`,
    'discovery/aws/aws.go': `package aws

type Filter struct {
	Name string
}
`,
    'web/api/v1/search.go': `package v1

import "example.com/app/storage"

type ChainFilter struct{}

func NewChainFilter(filters ...storage.Filter) *ChainFilter {
	return &ChainFilter{}
}
`,
    'errors.go': `package gin

type Error struct {
	Err error
}

func (msg *Error) Error() string {
	return msg.Err.Error()
}

var _ error = (*Error)(nil)

func newError(err error) *Error {
	return &Error{Err: err}
}
`,
    'binding/validator.go': `package binding

import "strings"

type SliceValidationError []error

func (err SliceValidationError) Error() string {
	var b strings.Builder
	for i := range err {
		b.WriteString(err[i].Error())
	}
	return b.String()
}
`,
    'handler/handler.go': `package handler

type Handler struct{}

func (h *Handler) Follow(c Context) error {
	return nil
}

type Context interface{}
`,
    'handler/routes.go': `package handler

type Group interface {
	POST(path string, h func(Context) error)
}

func (h *Handler) Register(g Group) {
	g.POST("/:username/follow", h.Follow)
}
`,
    'model/user.go': `package model

type Follow struct {
	FollowerID uint
}
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

/**
 * `kind file:qualifiedName` of each edge out of `file`'s nodes (of one kind,
 * or named `from`) whose target is named `name`, deduplicated and sorted.
 */
const linksFrom = (file: string, name: string, from?: { kind?: string; name?: string }) => {
  const sources = cg.getNodesInFile(file).filter((n) => (!from?.kind || n.kind === from.kind) && (!from?.name || n.name === from.name));
  const links = cg.getOutgoingEdgesFrom(sources.map((n) => n.id))
    .filter((e) => e.kind !== 'contains')
    .map((e) => ({ kind: e.kind, target: cg.getNode(e.target)! }))
    .filter(({ target }) => target.name === name)
    .map(({ kind, target }) => `${kind} ${target.filePath}:${target.qualifiedName}`);
  return [...new Set(links)].sort();
};

describe('Go framework heuristics pick only in the package Go reads the name from', () => {
  it('a bare type is its own package’s interface, not another package’s struct', () => {
    expect(linksFrom('promql/parser/ast.go', 'Node')).toEqual(['references promql/parser/ast.go:Node']);
  });

  it('a type written through an outside import is not the same-named struct of its own file', () => {
    expect(linksFrom('discovery/kubernetes/node.go', 'Node')).toEqual([]);
  });

  it('a method called through an expression is not an instantiation of a same-named struct', () => {
    const links = linksFrom('binding/validator.go', 'Error');
    expect(links.filter((l) => l.startsWith('instantiates'))).toEqual([]);
    expect(links).not.toContain('calls errors.go:Error');
  });

  it('a result type is its own package’s type, not the method the line declares', () => {
    expect(linksFrom('storage/fanout.go', 'Appender')).toEqual(['references storage/interface.go:Appender']);
  });

  it('a variadic `...pkg.T` is that import’s type', () => {
    expect(linksFrom('web/api/v1/search.go', 'Filter')).toEqual(['references storage/interface.go:Filter']);
  });

  it('a conversion and a composite literal still reach their own package’s struct', () => {
    expect(linksFrom('errors.go', 'Error', { name: '_' })).toEqual(['instantiates errors.go:Error']);
    expect(linksFrom('errors.go', 'Error', { name: 'newError' })).toEqual([
      'instantiates errors.go:Error',
      'references errors.go:Error',
    ]);
  });

  it('a route’s handler written through a value is that value’s method, not a model struct', () => {
    expect(linksFrom('handler/routes.go', 'Follow', { kind: 'route' })).toEqual(['references handler/handler.go:Handler::Follow']);
  });
});
