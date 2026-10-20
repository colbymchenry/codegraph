/**
 * Go calls of a standard method name — `Error`, `String`, `Err`, `Lock`,
 * `Header` — on a receiver nothing types.
 *
 * Every Go type may carry such a name, so the name alone says nothing of the
 * receiver. A guess by a word the receiver shares with a type's name bound
 * kubernetes' `err.Error()` to `notRegisteredErr::Error` and etcd's
 * `ctx.Err()` to a `valCtx`. The receiver's declaration decides when it can be
 * read — its declared type's own method, or nothing for a predeclared type
 * or a type from outside the project — and otherwise only a receiver named
 * after the owner type itself gets a guess.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-std-recv-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'types/id.go': `package types

type ID uint64

func (i ID) String() string { return "" }

type URLsMap map[string][]string

func NewURLsMap() URLsMap { return URLsMap{} }

func (m URLsMap) String() string { return "" }
`,
    'runtime/error.go': `package runtime

type notRegisteredErr struct{}

func (e *notRegisteredErr) Error() string { return "" }

type ParseErr struct{}

func (e *ParseErr) Error() string { return "" }
`,
    'etcdserver/request.go': `package etcdserver

type MoveLeaderRequest struct{}

func (m *MoveLeaderRequest) String() string { return "" }
`,
    'client/watch.go': `package client

import "context"

type valCtx struct{ context.Context }

func (c *valCtx) Err() error { return nil }
`,
    'concurrency/mutex.go': `package concurrency

type Mutex struct{}

func (m *Mutex) Lock() error { return nil }

func (m *Mutex) Unlock() error { return nil }
`,
    'chunks/iterator.go': `package chunks

type Iterator interface {
	Next() bool
	Err() error
}
`,
    'index/postings.go': `package index

type StringIter interface {
	Next() bool
	Err() error
}

type symbolsIter struct{}

func (s *symbolsIter) Next() bool { return false }

func (s *symbolsIter) Err() error { return nil }
`,
    'featuregate/fgtesting/tb.go': `package fgtesting

type TB interface {
	Error(args ...any)
}
`,
    'kubelet/runtime.go': `package kubelet

type Status struct{ Code int }

type RuntimeStatus struct{}

func (r *RuntimeStatus) String() string { return "" }
`,
    'httpx/recorder.go': `package httpx

import "net/http"

type ResponseRecorder struct{}

func (r *ResponseRecorder) Header() http.Header { return nil }
`,
    'boot/srv.go': `package boot

type Srv struct{}

func (s *Srv) Start() {}
`,
    'promql/engine.go': `package promql

type Query interface {
	Exec() string
	String() string
}

func NewQuery(q string) Query { return nil }
`,
    'server/version.go': `package server

type Version struct{}

func ParseVersion(s string) (*Version, error) { return &Version{}, nil }

func (v *Version) Major() string { return "" }

func (v *Version) String() string { return "" }
`,
    'server/server.go': `package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"example.com/app/boot"
	"example.com/app/chunks"
	"example.com/app/promql"
	"example.com/app/types"
)

type Server struct{}

func (s *Server) String() string { return "" }

func (s *Server) Describe() string { return s.String() }

func doWork() error { return nil }

func lookupLeader() fmt.Stringer { return nil }

func currentStatus() fmt.Stringer { return nil }

func newSrv() *boot.Srv { return nil }

func errorText(err error) string { return err.Error() }

func workText() string {
	err := doWork()
	return err.Error()
}

func leaderText() string {
	leaderID := lookupLeader()
	return leaderID.String()
}

func memberText(memberID types.ID) string { return memberID.String() }

func idsText(ids []types.ID) string {
	out := ""
	for _, id := range ids {
		out += id.String()
	}
	return out
}

func ctxErr(ctx context.Context) error { return ctx.Err() }

func timeoutErr() error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return ctx.Err()
}

func locked() {
	var mu sync.Mutex
	mu.Lock()
}

func iterErr(iter chunks.Iterator) error { return iter.Err() }

func report(tb testing.TB) { tb.Error("failed") }

func statusText() string {
	status := currentStatus()
	return status.String()
}

func headers() {
	recorder := httptest.NewRecorder()
	_ = recorder.Header()
}

func urls() string {
	urlsMap := types.NewURLsMap()
	return urlsMap.String()
}

func startSrv() {
	srv := newSrv()
	srv.Start()
}

func runQueries() {
	for _, tc := range []struct {
		query string
	}{{query: "up"}} {
		func() {
			var (
				query promql.Query
			)
			query = promql.NewQuery(tc.query)
			_ = query.Exec()
			_ = query.String()
		}()
	}
}

func versionText() string {
	tests := []struct {
		version string
	}{{version: "1.0"}}
	out := ""
	for _, test := range tests {
		version, _ := ParseVersion(test.version)
		out += version.Major() + version.String()
	}
	return out
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `file::qualifiedName resolvedBy@confidence` of every method the function `name` in server.go calls. */
function calls(name: string): string[] {
  const fn = cg.getNodesInFile('server/server.go').find((n) => n.name === name && n.kind !== 'method');
  expect(fn, name).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => ({ e, n: cg.getNode(e.target)! }))
    .filter(({ n }) => n.kind === 'method')
    .map(({ e, n }) => `${n.filePath.replace(/\\/g, '/')}::${n.qualifiedName} ${String(e.metadata?.resolvedBy)}@${String(e.metadata?.confidence)}`)
    .sort();
}

describe('Go standard method names on a receiver nothing types', () => {
  it.each([
    // `func errorText(err error)`: the error interface's own method.
    ['errorText', 'a receiver of a predeclared type'],
    // `err := doWork()`: an `err` is no `notRegisteredErr`.
    ['workText', 'a receiver sharing only a word with the owner type'],
    // `leaderID := lookupLeader()`: no `MoveLeaderRequest`.
    ['leaderText', 'a receiver sharing only a word with the owner type'],
    ['ctxErr', 'a parameter of a type from outside the project'],
    // `ctx, cancel := context.WithTimeout(…)`
    ['timeoutErr', 'a value a package from outside the project hands out'],
    // `var mu sync.Mutex`: no project `Mutex`.
    ['locked', 'a variable of a type from outside the project'],
    // `tb testing.TB`, beside a project interface `TB`.
    ['report', 'a parameter of a type from outside the project'],
    // `recorder := httptest.NewRecorder()`
    ['headers', 'a value a package from outside the project hands out'],
    // `status := currentStatus()`, beside a `Status` type and a `RuntimeStatus::String`.
    ['statusText', 'a receiver named after a type that lacks the method'],
  ])('links nothing from %s: %s', (fn) => {
    expect(calls(fn)).toEqual([]);
  });

  it.each([
    ['memberText', 'types/id.go::ID::String instance-method@0.9'],
    // Not `StringIter::Err` or `symbolsIter::Err`, by the word "iter".
    ['iterErr', 'chunks/iterator.go::Iterator::Err instance-method@0.9'],
  ])('links %s through the type its parameter is declared as', (fn, target) => {
    expect(calls(fn)).toEqual([target]);
  });

  it.each([
    // `for _, id := range ids`
    ['idsText', 'types/id.go::ID::String instance-method@0.65'],
    // `urlsMap := types.NewURLsMap()`
    ['urls', 'types/id.go::URLsMap::String instance-method@0.65'],
  ])('still guesses for %s through a receiver named after the owner type', (fn, target) => {
    expect(calls(fn)).toEqual([target]);
  });

  it.each([
    // `var ( query promql.Query )`, read past the table's `query string`;
    // `Exec`, no standard name, is typed by that declaration too.
    ['runQueries', ['promql/engine.go::Query::Exec instance-method@0.9', 'promql/engine.go::Query::String instance-method@0.9']],
    // `version, _ := ParseVersion(…)` says no type, and the table's
    // `version string` is another declaration: nothing is ruled out.
    ['versionText', ['server/version.go::Version::Major instance-method@0.8', 'server/version.go::Version::String instance-method@0.8']],
  ])('reads %s by the declaration in scope, not a test table field of the name', (fn, targets) => {
    expect(calls(fn)).toEqual(targets);
  });

  it("leaves typed receivers and other method names as they were", () => {
    const describeFn = cg.getNodesInFile('server/server.go').find((n) => n.qualifiedName === 'Server::Describe');
    expect(describeFn).toBeDefined();
    const targets = cg.getOutgoingEdges(describeFn!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(targets).toEqual(['Server::String']);
    expect(calls('startSrv').filter((c) => c.includes('Srv::Start'))).toHaveLength(1);
  });
});
