/**
 * A Go method call whose receiver the extractor keeps no name for — a fluent
 * chain's later link (`model.WithContext(0).Where(1).First()`), a call on what
 * a function returns (`time.Now().UTC().Format(…)`), a composite literal
 * (`GitOracle{}.Worktree()`) — reaches the resolver by its bare method name.
 * Name matching then picked one of the project's methods of that name by
 * proximity: a GORM-style chain's `Where` and `First` went to another query
 * type's, a standard-library chain's `Format` to the only project `Format`,
 * and a composite literal's method to a namesake type's (#2543).
 *
 * The receiver is now typed: a call gives its function's or method's first
 * result (or the one a multi-value assignment takes), a conversion and a
 * composite literal their type, an embedded field its type. The method is the
 * one Go selects on that type, and nothing when the type comes from outside
 * the project or can't be read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';

let tempDir: string;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2543-'));
  for (const [rel, source] of Object.entries({ 'go.mod': GO_MOD, ...files })) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  return cg;
}

/** `<kind> <qualified name>` of every `calls` / `instantiates` edge out of the function `fromName`, sorted. */
function callees(graph: CodeGraph, fromName: string): string[] {
  const from = graph.getNodesByKind('function').find((n) => n.name === fromName);
  expect(from, fromName).toBeDefined();
  return graph
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => {
      const target = graph.getNode(e.target);
      return `${e.kind} ${target?.kind} ${target?.qualifiedName}`;
    })
    .sort();
}

describe('Go method calls on a receiver the extractor names no variable for (#2543)', () => {
  it("follows the issue's factory → field → fluent chain to the session query type", async () => {
    const graph = await index({
      'query/query.go': 'package query\n\ntype Query struct { Session Session }\n',
      'query/card.go':
        'package query\n\ntype CardDo struct{}\nfunc (c CardDo) Where(value int) CardDo { return c }\nfunc (c CardDo) First() int { return 1 }\n',
      'query/session.go':
        'package query\n\ntype Session struct{}\ntype SessionDo struct{}\n' +
        'func (s Session) WithContext(ctx int) SessionDo { return SessionDo{} }\n' +
        'func (s SessionDo) Where(value int) SessionDo { return s }\nfunc (s SessionDo) First() int { return 2 }\n',
      'mysql/conn.go': 'package mysql\n\nimport "example.com/app/query"\n\nfunc Query() *query.Query { return &query.Query{} }\n',
      'mysql/session.go':
        'package mysql\n\nfunc Find() int {\n    model := Query().Session\n    return model.WithContext(0).\n        Where(1).\n        First()\n}\n',
    });
    expect(callees(graph, 'Find')).toEqual([
      'calls function Query',
      'calls method Session::WithContext',
      'calls method SessionDo::First',
      'calls method SessionDo::Where',
    ]);
  });

  it("calls the composite literal's own type's method", async () => {
    const graph = await index({
      'main.go': `package main

type GitOracle struct{}

func (GitOracle) Worktree() string { return "" }

type FakeOracle struct{}

func (FakeOracle) Worktree() string { return "" }

func use() string { return GitOracle{}.Worktree() }

func useParen() string { return (&FakeOracle{}).Worktree() }

func main() { use(); useParen() }
`,
    });
    expect(callees(graph, 'use').filter((e) => e.startsWith('calls'))).toEqual(['calls method GitOracle::Worktree']);
    expect(callees(graph, 'useParen').filter((e) => e.startsWith('calls'))).toEqual(['calls method FakeOracle::Worktree']);
  });

  it('links nothing for a chain on a standard-library value', async () => {
    const graph = await index({
      'main.go': `package main

import (
	"net/http/httptest"
	"time"
)

type Report struct{}

func (r Report) Format() string { return "" }
func (r Report) Get(key string) string { return key }

func stamp() string { return time.Now().UTC().Format(time.RFC3339) }

func header() string {
	w := httptest.NewRecorder()
	return w.Header().Get("Content-Type")
}

func main() { stamp(); header() }
`,
    });
    expect(callees(graph, 'stamp')).toEqual([]);
    expect(callees(graph, 'header')).toEqual([]);
  });

  it('types a call result, a multi-value result, a conversion and an embedded field', async () => {
    const graph = await index({
      'store/store.go': `package store

type KV interface {
	Get(key string) string
}

type Client struct {
	KV
	name string
}

func (c *Client) Txn() *Txn { return &Txn{} }

type Txn struct{}

func (t *Txn) If(ok bool) *Txn { return t }
func (t *Txn) Commit() error   { return nil }

type Response struct{}

func (r *Response) Header() string { return "" }

func New(name string) (*Client, error) { return &Client{name: name}, nil }

func Begin() (int, *Txn) { return 0, &Txn{} }
`,
      'store/other.go': `package store

type Other struct{}

func (o *Other) If(ok bool) *Other { return o }
func (o *Other) Commit() error     { return nil }
func (o *Other) Get(key string) string { return key }
func (o *Other) Header() string    { return "" }
`,
      'app/app.go': `package app

import "example.com/app/store"

type holder struct{ cli *store.Client }

func run(h holder, raw any) error {
	cli, err := store.New("x")
	if err != nil {
		return err
	}
	_ = h.cli.KV.Get("a")
	_ = (*store.Response)(nil).Header()
	_, txn := store.Begin()
	_ = txn.If(true).Commit()
	return cli.Txn().If(true).Commit()
}
`,
    });
    expect(callees(graph, 'run').filter((e) => e.startsWith('calls'))).toEqual([
      'calls function Begin',
      'calls function New',
      'calls method Client::Txn',
      'calls method KV::Get',
      'calls method Response::Header',
      'calls method Txn::Commit',
      'calls method Txn::Commit',
      'calls method Txn::If',
      'calls method Txn::If',
    ]);
  });

  it('types a package-level variable from the call it is set to', async () => {
    const graph = await index({
      'scheme/scheme.go': `package scheme

type Scheme struct{}

func New() *Scheme { return &Scheme{} }

func (s *Scheme) Test(name string) *Tester { return &Tester{} }

type Tester struct{}

func (t *Tester) Value(v any) *Tester { return t }
func (t *Tester) ExpectValid()       {}
`,
      'scheme/decoy.go': `package scheme

type Decoy struct{}

func (d *Decoy) Value(v any) *Decoy { return d }
func (d *Decoy) ExpectValid()      {}
`,
      'pkg/doc.go': 'package pkg\n\nimport "example.com/app/scheme"\n\nvar localScheme = scheme.New()\n',
      'pkg/doc_test.go': `package pkg

func check() {
	localScheme.Test("x").Value(1).ExpectValid()
}
`,
    });
    expect(callees(graph, 'check')).toEqual([
      'calls method Scheme::Test',
      'calls method Tester::ExpectValid',
      'calls method Tester::Value',
    ]);
  });

  it('types a generic call and a generic literal given their type arguments', async () => {
    const graph = await index({
      'lib/lib.go': `package lib

type ErrorList []string

func (l ErrorList) MarkShortCircuit() ErrorList { return l }

func PtrNoNils[T any](v *T) ErrorList { return nil }

func Identity[T any](v T) T { return v }

type Validator interface{ Validate() error }

func Pick[V Validator](vs []V) V { return vs[0] }

type List[T any] struct{ items []T }

func (l List[T]) Len() int { return len(l.items) }
`,
      'lib/decoy.go': `package lib

type Other struct{}

func (Other) MarkShortCircuit() Other { return Other{} }
func (Other) Len() int               { return 0 }
func (Other) Validate() error        { return nil }

// Named like Identity's type parameter.
type T struct{}

func (T) Run() {}
`,
      'app/app.go': `package app

import "example.com/app/lib"

type A struct{}

func (A) Run() {}

type Report struct{}

func (Report) Mark() {}

type Box[T any] struct{ v T }

func (b Box[T]) Size() int { return 0 }

type Decoy struct{}

func (Decoy) Run()      {}
func (Decoy) Mark()     {}
func (Decoy) Size() int { return 0 }

type Probe struct{}

func (Probe) Validate() error { return nil }

func wrap[T any](v T) Report { return Report{} }

func Check(v *int, probes []Probe) int {
	lib.PtrNoNils[int](v).MarkShortCircuit()
	lib.Identity[A](A{}).Run()
	wrap[int](1).Mark()
	_ = lib.Pick(probes).Validate()
	return lib.List[int]{}.Len() + Box[int]{}.Size()
}
`,
    });
    // `Identity`'s result is its type parameter, not the type `lib` has of
    // that name; `Pick`'s has the methods of its constraint.
    expect(callees(graph, 'Check').filter((e) => e.startsWith('calls method'))).toEqual([
      'calls method Box::Size',
      'calls method ErrorList::MarkShortCircuit',
      'calls method List::Len',
      'calls method Report::Mark',
      'calls method Validator::Validate',
    ]);
  });

  it('reads a later call of a name the chain already called on another type', async () => {
    const graph = await index({
      'main.go': `package main

type A struct{}

func (a *A) Next() *B { return &B{} }

type B struct{}

func (b *B) Next() *C { return &C{} }

type C struct{}

func walk(a *A) *C { return a.Next().Next() }

func main() { walk(&A{}) }
`,
    });
    expect(callees(graph, 'walk')).toEqual(['calls method A::Next', 'calls method B::Next']);
  });

  it("links nothing when the receiver's type can't be read, rather than guess by name", async () => {
    const graph = await index({
      'main.go': `package main

type A struct{}

func (A) Run() {}

type B struct{}

func (B) Run() {}

type holder struct{ get func() A }

func use(h holder) {
	h.get().Run()
}

func useLiteral() {
	var cfg struct{ inner struct{ a A } }
	cfg.inner.a.Run()
}

func main() { use(holder{}); useLiteral() }
`,
    });
    expect(callees(graph, 'use')).toEqual([]);
    expect(callees(graph, 'useLiteral')).toEqual([]);
  });
});
