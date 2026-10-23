/**
 * A Go receiver's declared type decides which method a call on it reaches.
 * The line patterns that read it take a parameter's type only when it is a
 * lowercase name of the caller's own package (`s *server`) or starts with a
 * capital (`lg Logger`), so a parameter declared through a package — `c
 * clock.PassiveClock`, `pod *v1.Pod`, `client kubernetes.Interface` — had
 * no type, and a call on it went to whatever project method a guess by name
 * found: kubernetes' `c.Now()` reached apimachinery's unrelated `Clock::Now`,
 * `client.Patch()` a `RESTClient` instead of the `rest.Interface` declared.
 * Only a call of a standard method name (`String`, `Error`, `Header`) was
 * read through the scope reader. Now every call is: a parameter, a result,
 * a name sharing its type with the next (`a, b rest.Interface`), a `var (…)`
 * spec, a function literal's parameter. The patterns scan back without
 * block scope, so the scope reader's declaration wins where both find one.
 *
 * A type from a package outside the project has none of the project's
 * methods, and neither has an alias of one. gin declares its own
 * `ResponseWriter`, which `w http.ResponseWriter` is not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const files: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'rest/rest.go': `package rest

type Request struct{}

// Interface is what a client of the API server offers.
type Interface interface {
	Patch(pt string) *Request
	Get() *Request
}

// RESTClient is one implementation of it: a call through Interface is not a call on it.
type RESTClient struct{}

func (c *RESTClient) Patch(pt string) *Request { return &Request{} }
func (c *RESTClient) Get() *Request            { return &Request{} }
`,
  'store/store.go': `package store

type Store struct{}

func (s *Store) Put(k string)        {}
func (s *Store) Get(k string) string { return k }

// Cached gets Put and Get from the Store it embeds.
type Cached struct {
	*Store
}
`,
  'api/api.go': `package api

import "example.com/app/store"

// Alias is store.Store under another name.
type Alias = store.Store
`,
  'config/config.go': `package config

import "example.com/app/store"

type Config struct {
	Store *store.Store
}
`,
  // Methods named like the ones the calls below make, for a guess by name to find.
  'decoy/decoy.go': `package decoy

import "net/http"

type Decoy struct{}

func New() *Decoy { return &Decoy{} }

func (d *Decoy) Put(k string)        {}
func (d *Decoy) Get(k string) string { return k }

// Like gin's own ResponseWriter.
type ResponseWriter interface {
	Header() http.Header
	Write(b []byte) (int, error)
}

type responseWriter struct{}

func (w *responseWriter) Header() http.Header         { return nil }
func (w *responseWriter) Write(b []byte) (int, error) { return len(b), nil }

// Like harbor's jobservice worker.
type Worker struct{}

func (w *Worker) WithContext(ctx interface{}) *Worker { return w }

// Like apimachinery's clock.
type Clock struct{}

func (c *Clock) Now() int64 { return 0 }

// A struct named like the handlers package's alias of context.Context.
type Ctx struct{}

func (c *Ctx) Done() <-chan struct{} { return nil }

// An HTTP client of the project's own.
type Client struct{}

func (c *Client) Do(req *http.Request) error { return nil }

// A request of the project's own, whose URL has a Query.
type Request struct {
	URL *Location
}

type Location struct{}

func (l *Location) Query() string { return "" }
`,
  'handlers/handlers.go': `package handlers

import (
	"context"
	"net/http"

	"example.com/app/api"
	"example.com/app/config"
	"example.com/app/decoy"
	"example.com/app/rest"
	"example.com/app/store"
	"k8s.io/utils/clock"
)

// Ctx is context.Context under another name.
type Ctx = context.Context

// Local is the type of a test table's field below.
type Local struct{}

func (l *Local) Put(k string) {}

func update(client rest.Interface) {
	client.Patch("json")
}

func pair(a, b rest.Interface) {
	a.Get()
	b.Patch("merge")
}

func multiLine(
	ctx context.Context,
	s *store.Store,
) {
	s.Put("multi")
}

func open() (s *store.Store) {
	s.Put("result")
	return s
}

func block() {
	var (
		s   *store.Store
		err error
	)
	s.Put("block")
	_ = err
}

func closure() {
	put := func(s *store.Store) {
		s.Put("closure")
	}
	_ = put
}

func table(s *store.Store) {
	cases := []struct {
		s *Local
	}{}
	_ = cases
	s.Put("table")
}

func flushAll(c *store.Cached) {
	c.Put("embedded")
}

func viaAlias(a api.Alias) {
	a.Get("alias")
}

func value(s *store.Store) {
	put := s.Put
	_ = put
}

func chain(cfg *config.Config) {
	cfg.Store.Put("chain")
}

func shadow(s *store.Store) {
	if s != nil {
		s := decoy.New()
		s.Put("shadow")
	}
}

func serve(w http.ResponseWriter, writer http.ResponseWriter, req *http.Request) {
	w.Header()
	writer.Header()
	req.WithContext(context.Background())
	req.URL.Query()
}

func tick(c clock.PassiveClock) {
	c.Now()
}

func wait(ctx context.Context, c Ctx) {
	ctx.Done()
	c.Done()
}

func send() {
	var rw http.ResponseWriter
	rw.Write(nil)
	cl := &http.Client{}
	cl.Do(nil)
}

func now(realClock clock.PassiveClock) {
	tick := realClock.Now
	_ = tick
}
`,
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-declared-receiver-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const FILE = 'handlers/handlers.go';

/** The line of the handlers file holding `snippet`. */
const lineOf = (snippet: string): number => {
  const at = files[FILE]!.split('\n').findIndex((l) => l.includes(snippet));
  if (at < 0) throw new Error(`no ${snippet} in ${FILE}`);
  return at + 1;
};

/** What the references on the line holding `snippet` reach: `owner::method (resolvedBy confidence)`. */
const reachedAt = (snippet: string): string[] => {
  const line = lineOf(snippet);
  const ids = cg.getNodesInFile(FILE).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains' && e.line === line)
    .map((e) => `${cg.getNode(e.target)!.qualifiedName} (${e.metadata?.resolvedBy} ${e.metadata?.confidence})`);
};

describe('a Go receiver declared through a package', () => {
  it('reaches the method of the type it is declared as', () => {
    // Not RESTClient's `Patch`, which a word of the receiver's name picked.
    expect(reachedAt('client.Patch("json")')).toEqual(['Interface::Patch (instance-method 0.9)']);
    // Each name of a group, a line of a multi-line list, a named result, a
    // `var (…)` spec, a function literal's parameter.
    expect(reachedAt('a.Get()')).toEqual(['Interface::Get (instance-method 0.9)']);
    expect(reachedAt('b.Patch("merge")')).toEqual(['Interface::Patch (instance-method 0.9)']);
    expect(reachedAt('s.Put("multi")')).toEqual(['Store::Put (instance-method 0.9)']);
    expect(reachedAt('s.Put("result")')).toEqual(['Store::Put (instance-method 0.9)']);
    expect(reachedAt('s.Put("block")')).toEqual(['Store::Put (instance-method 0.9)']);
    expect(reachedAt('s.Put("closure")')).toEqual(['Store::Put (instance-method 0.9)']);
  });

  it('is the declaration in scope, not a test table field the patterns read above it', () => {
    expect(reachedAt('s.Put("table")')).toEqual(['Store::Put (instance-method 0.9)']);
  });

  it('follows embedding and aliases in the declaring package', () => {
    expect(reachedAt('c.Put("embedded")')).toEqual(['Store::Put (instance-method 0.9)']);
    expect(reachedAt('a.Get("alias")')).toEqual(['Store::Get (instance-method 0.9)']);
  });

  it('types a method value and a field chain through it too', () => {
    expect(reachedAt('put := s.Put')).toEqual(['Store::Put (function-ref 0.9)']);
    expect(reachedAt('cfg.Store.Put("chain")')).toEqual(['Store::Put (instance-method 0.85)']);
  });

  it('is not what a local of the same name declared without a type holds', () => {
    // `s := decoy.New()` shadows the parameter: its type is not *store.Store.
    expect(reachedAt('s.Put("shadow")').filter((r) => r.startsWith('Store::'))).toEqual([]);
  });
});

describe('a Go receiver of a type from outside the project', () => {
  it('reaches none of the project\'s methods', () => {
    // net/http's ResponseWriter is not the project's own, whose name it shares.
    expect(reachedAt('w.Header()')).toEqual([]);
    expect(reachedAt('writer.Header()')).toEqual([]);
    expect(reachedAt('req.WithContext(')).toEqual([]);
    expect(reachedAt('req.URL.Query()')).toEqual([]);
    expect(reachedAt('c.Now()')).toEqual([]);
    expect(reachedAt('ctx.Done()')).toEqual([]);
  });

  it('nor does an alias of one, or a local declared as one', () => {
    expect(reachedAt('c.Done()')).toEqual([]);
    expect(reachedAt('rw.Write(nil)')).toEqual([]);
    expect(reachedAt('cl.Do(nil)')).toEqual([]);
    // A method value of one, which a word of its name picked on main.
    expect(reachedAt('tick := realClock.Now')).toEqual([]);
  });
});
