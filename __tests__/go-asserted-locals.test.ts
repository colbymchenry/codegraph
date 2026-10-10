/**
 * A Go local bound from a type assertion has the asserted type:
 *
 *   if f, ok := w.(http.Flusher); ok {
 *     f.Flush()                      // http.Flusher's, nothing in the project
 *   }
 *   wr := v.(*Wrapper)
 *   wr.Flush()                       // what *Wrapper has, promoted from *storage.Base
 *
 * Receiver inference read `v := T{}`, `var v T` and parameters, never
 * `v := x.(T)` or `v, ok := x.(T)`, so such a call went to whichever project
 * method name matching picked. The asserted type is now found where Go finds
 * it, as for a call made through the assertion itself (`x.(T).M()`): in the
 * file's own package or one it dot-imports for a bare name, in the imported
 * project package for `pkg.T`, an alias being the type it names. A type from
 * outside the project, a predeclared one or an alias of such a type links
 * nothing. A type literal, or a type declared inside a function, says nothing
 * the index can follow: the call goes to name matching, as before. The
 * binding is the one in scope at the call: an assertion in an `if` header
 * does not reach a later variable of that name, nor does a nearer
 * declaration in a block that has ended hide it. A local named like a
 * standard-library package (`parser`) is the local.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

/**
 * The module the tests index. Namesakes sit where name matching looked
 * first: an `alpha` package that sorts ahead of `storage`, and a same-file
 * `sink` with each method name.
 */
const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'alpha/alpha.go': `package alpha

type Store interface {
	Fetch(key string) string
}

type sink struct{}

func (s *sink) Fetch(key string) string { return "" }

func (s *sink) Flush() error { return nil }

func (s *sink) Read(p []byte) (int, error) { return 0, nil }

func (s *sink) Error() string { return "" }

func (s *sink) Len() int { return 0 }

func (s *sink) Start() {}

type Ctx struct{}

func (c *Ctx) Done() <-chan struct{} { return nil }

type BufFlusher struct{}

func (b *BufFlusher) Flush() error { return nil }
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

type Job struct{}

func (j *Job) Start() {}

type Wrapper struct {
	*storage.Base
	job *Job
}

type List[T any] struct{}

func (l *List[T]) Len() int { return 0 }

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

func (s *sink) Fetch(key string) string { return "" }

func (s *sink) Read(p []byte) (int, error) { return 0, nil }

func (s *sink) Error() string { return "" }

func (s *sink) Drain() {}

func register(fn any) {}

func lookup(key string) any { return nil }

func Flusher(w http.ResponseWriter) {
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func Promoted(v any) {
	wr := v.(*Wrapper)
	wr.Flush()
}

func Embedded(v any, p []byte) {
	rc, ok := v.(ReadCloser)
	if ok {
		rc.Read(p)
	}
}

func Qualified(v any) string {
	var st, _ = v.(storage.Store)
	return st.Fetch("k")
}

func Aliased(v any) string {
	k := v.(Keeper)
	return k.Fetch("k")
}

func Generic(v any) int {
	l := v.(*List[int])
	return l.Len()
}

func Quoted() string {
	s, _ := lookup(")").(storage.Store)
	return s.Fetch("k")
}

func Outside(v any) {
	c := v.(Ctx)
	c.Done()
	if err, ok := v.(error); ok {
		err.Error()
	}
}

func Unseen(v any) {
	d, _ := v.(interface{ Drain() })
	d.Drain()
	type drainer interface{ Drain() }
	if dr, ok := v.(drainer); ok {
		dr.Drain()
	}
}

func Named(v any) string {
	if parser, ok := v.(storage.Store); ok {
		return parser.Fetch("k")
	}
	return ""
}

func Chain(v any) {
	wr := v.(*Wrapper)
	wr.job.Start()
}

func Values(v any, w http.ResponseWriter) {
	st := v.(storage.Store)
	register(st.Fetch)
	f := w.(http.Flusher)
	register(f.Flush)
}

func Assigned(v any) string {
	var st storage.Store
	st = v.(*sink)
	return st.Fetch("k")
}

func Scoped(w http.ResponseWriter, sinks []*sink) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	for _, f := range sinks {
		f.Drain()
	}
}

func Shadowed(v any) string {
	s, ok := v.(storage.Store)
	if !ok {
		s := &sink{}
		return s.Fetch("fallback")
	}
	return s.Fetch("k")
}

func Commented(s *sink) {
	// s, ok := v.(http.Flusher)
	s.Drain()
}

func Switched(v any) {
	switch x := v.(type) {
	case *sink:
		x.Drain()
	}
}
`,
  'dot/dot.go': `package dot

import . "example.com/app/storage"

func Get(v any) string {
	s := v.(Store)
	return s.Fetch("k")
}
`,
};

describe.each(['default', 'wasm'])('Go locals bound from a type assertion have the asserted type (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-asserted-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      // One file with a Windows checkout's line endings.
      fs.writeFileSync(path.join(root, rel), rel === 'store/use.go' ? content.replace(/\n/g, '\r\n') : content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /**
   * `<source line> -> <target file>::<target qualified name>` for every edge
   * of `kind` the function `name` in `file` has to a function or method.
   */
  function links(file: string, name: string, kind: 'calls' | 'references' = 'calls'): string[] {
    const fn = cg!.getNodesInFile(file).find((n) => n.qualifiedName === name && n.kind === 'function');
    expect(fn, `${name} in ${file}`).toBeDefined();
    const lines = FILES[file]!.split('\n');
    return cg!
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === kind)
      .map((e) => ({ e, target: cg!.getNode(e.target)! }))
      .filter(({ target }) => target.kind === 'method' || target.kind === 'function')
      .map(({ e, target }) => `${lines[e.line! - 1]!.trim()} -> ${target.filePath}::${target.qualifiedName}`)
      .sort();
  }

  it('links nothing through an asserted type from outside the project', () => {
    // Name matching took alpha's BufFlusher::Flush, whose owner shares the
    // receiver's name.
    expect(links('store/use.go', 'Flusher')).toEqual([]);
  });

  it("links the asserted project type's method: its own, an embedded type's, or one through a qualifier", () => {
    // *Wrapper's Flush is promoted from *storage.Base; ReadCloser's Read from Reader.
    expect(links('store/use.go', 'Promoted')).toEqual(['wr.Flush() -> storage/storage.go::Base::Flush']);
    expect(links('store/use.go', 'Embedded')).toEqual(['rc.Read(p) -> store/store.go::Reader::Read']);
    // `var v, _ = x.(T)` declares as `v, _ := x.(T)` does.
    expect(links('store/use.go', 'Qualified')).toEqual(['return st.Fetch("k") -> storage/storage.go::Store::Fetch']);
    expect(links('store/use.go', 'Generic')).toEqual(['return l.Len() -> store/store.go::List::Len']);
    // A string argument holding a parenthesis is not the end of the call.
    expect(links('store/use.go', 'Quoted')).toEqual([
      'return s.Fetch("k") -> storage/storage.go::Store::Fetch',
      's, _ := lookup(")").(storage.Store) -> store/use.go::lookup',
    ]);
  });

  it('follows an alias and a dot import to the type', () => {
    expect(links('store/use.go', 'Aliased')).toEqual(['return k.Fetch("k") -> storage/storage.go::Store::Fetch']);
    expect(links('dot/dot.go', 'Get')).toEqual(['return s.Fetch("k") -> storage/storage.go::Store::Fetch']);
  });

  it('links nothing through an alias of an outside type or a predeclared type', () => {
    expect(links('store/use.go', 'Outside')).toEqual([]);
  });

  it('leaves a call through a type literal or a type declared in a function to name matching', () => {
    // sink::Drain is the project's one Drain.
    expect(links('store/use.go', 'Unseen')).toEqual([
      'd.Drain() -> store/use.go::sink::Drain',
      'dr.Drain() -> store/use.go::sink::Drain',
    ]);
  });

  it('takes a local named like a standard-library package for the local', () => {
    expect(links('store/use.go', 'Named')).toEqual(['return parser.Fetch("k") -> storage/storage.go::Store::Fetch']);
  });

  it("reaches a field's method through an asserted local", () => {
    expect(links('store/use.go', 'Chain')).toEqual(['wr.job.Start() -> store/store.go::Job::Start']);
  });

  it("links a method value taken from an asserted local as the call would", () => {
    expect(links('store/use.go', 'Values', 'references')).toEqual([
      'register(st.Fetch) -> storage/storage.go::Store::Fetch',
    ]);
  });

  it("leaves an assertion assigned to a declared variable that variable's type", () => {
    // `st = v.(*sink)` declares nothing: st is still a storage.Store.
    expect(links('store/use.go', 'Assigned')).toEqual(['return st.Fetch("k") -> storage/storage.go::Store::Fetch']);
  });

  it('reads the binding in scope at the call', () => {
    // The `if` header's f ends with its block: the loop's f is a *sink.
    expect(links('store/use.go', 'Scoped')).toEqual(['f.Drain() -> store/use.go::sink::Drain']);
    // The block's s := &sink{} ends with the block; the asserted s is back.
    expect(links('store/use.go', 'Shadowed')).toEqual([
      'return s.Fetch("fallback") -> store/use.go::sink::Fetch',
      'return s.Fetch("k") -> storage/storage.go::Store::Fetch',
    ]);
    // A comment declares nothing.
    expect(links('store/use.go', 'Commented')).toEqual(['s.Drain() -> store/use.go::sink::Drain']);
    // A type switch's variable has its clause's type, which is not read: the
    // call resolves as it did before.
    expect(links('store/use.go', 'Switched')).toEqual(['x.Drain() -> store/use.go::sink::Drain']);
  });

  it('never links a namesake in another package or a same-file type', () => {
    const decoys = [
      ...cg!.getNodesInFile('alpha/alpha.go'),
      ...cg!.getNodesInFile('store/use.go').filter((n) => ['sink::Flush', 'sink::Read', 'sink::Error'].includes(n.qualifiedName)),
    ].filter((n) => n.kind === 'method');
    expect(decoys.length).toBe(12);
    for (const decoy of decoys) {
      expect(
        cg!.getIncomingEdges(decoy.id).filter((e) => (e.kind === 'calls' || e.kind === 'references') && e.provenance !== 'heuristic'),
        decoy.qualifiedName,
      ).toEqual([]);
    }
  });
});
