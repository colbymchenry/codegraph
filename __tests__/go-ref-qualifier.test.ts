/**
 * A Go name written through an outside package is none of the project's
 * symbols (#2322), so which package a call is written through decides what
 * it may reach. Two misreadings of that qualifier, both seen on real trees:
 *
 * - A dotted call reference (`klog.Infof`) is recorded at its receiver, and
 *   the reader looked for the line's only `X.Infof` instead of taking the
 *   receiver the reference names. A second spelling of the name on the line
 *   left it with no qualifier — `Digest:` beside `digest.Digest(dig)`
 *   (harbor), `"Log using Infof"` (kubernetes) — so the call kept a project
 *   namesake's method, and another selector before it made `perr.Error` in
 *   `klog.Error(perr.Error())` a call through `klog`. Only the first segment
 *   can be a package: `s.cache.Get` is no call through a `cache` import.
 * - A parameter or local can take an import's name: etcd's
 *   `jwt, err := newTokenProviderJWT(…)` beside `import ".../jwt/v5"`. A
 *   call through it is a method call on the variable, which the
 *   outside-package rule rejected along with the package's own calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const files: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // Project methods named like the outside packages' functions.
  'logging/wrapper.go': `package logging

// An adapter with klog's method names, like kubernetes' etcd3 logger.
type klogWrapper struct{}

func (klogWrapper) Infof(format string, args ...interface{})  {}
func (klogWrapper) Errorf(format string, args ...interface{}) {}
`,
  'registry/suite.go': `package registry

type Suite struct{}

func (s *Suite) Digest(v string) string { return v }
`,
  'diff/differ.go': `package diff

type Differ struct{}

func (d *Differ) Diff(a, b string) string { return a + b }
`,
  'example/example.go': `package example

import (
	"errors"
	"testing"

	"github.com/distribution/distribution/v3"
	"github.com/google/go-cmp/cmp"
	"github.com/opencontainers/go-digest"
	"github.com/patrickmn/go-cache"
	"k8s.io/klog/v2"
)

type parseError struct{}

func (e *parseError) Error() string { return "parse" }

type lru struct{}

func (l *lru) Get(key string) string { return key }

type Server struct {
	cache *lru
}

func (s *Server) Lookup(key string) string {
	return s.cache.Get(key)
}

func NewServer() *Server {
	_ = cache.New(0, 0)
	return &Server{cache: &lru{}}
}

func Run(dig string) {
	klog.Infof("Log using Infof, key: %s", "value")
	err := errors.New("fail")
	klog.Errorf("Log using Errorf, err: %v", err)
	desc := &distribution.Descriptor{Digest: digest.Digest(dig)}
	_ = desc
	perr := &parseError{}
	klog.Error(perr.Error())
}

func TestParser(t *testing.T) {
	t.Errorf("Unexpected policy! Diff:\\n%s", cmp.Diff("a", "b"))
}
`,
  'auth/jwt.go': `package auth

import "github.com/golang-jwt/jwt/v5"

type tokenJWT struct{ key string }

func newTokenProviderJWT(key string) (*tokenJWT, error) { return &tokenJWT{key: key}, nil }

func (t *tokenJWT) assign(user string) (string, error) { return user, nil }

func (t *tokenJWT) info(token string) (string, bool) { return token, true }

// Named like the package's Parse.
type jwtOptions struct{}

func (o *jwtOptions) Parse(token string) error { return nil }

func parse(token string) {
	_, _ = jwt.Parse(token, nil)
}
`,
  'auth/jwt_test.go': `package auth

import (
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestJWTInfo(t *testing.T) {
	jwt, err := newTokenProviderJWT("key")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := jwt.assign("abc")
	_, ok := jwt.info(token)
	_ = ok
}

func TestJWTParse(t *testing.T) {
	jwt, err := jwt.Parse("x", nil)
	_, _ = jwt, err
}

func TestJWTClosure(t *testing.T) {
	check := func(jwt *tokenJWT) {
		jwt.info("t")
	}
	check(nil)
	_, _ = jwt.Parse("y", nil)
}
`,
  'compare/compare.go': `package compare

import "github.com/google/go-cmp/cmp"

type Comparer interface {
	Compare(a, b int) int
}

func comparers() []Comparer { return nil }

func Check(cmp Comparer) int {
	return cmp.Compare(1, 2)
}

func Report(a, b string) string {
	for _, cmp := range comparers() {
		_ = cmp.Compare(3, 4)
	}
	return cmp.Diff(a, b)
}

func Report2(a, b string) string {
	cmp := cmp.Diff(a, b)
	return cmp
}
`,
  // A variable's declared type says whose methods it has: kubernetes'
  // `clock clock.PassiveClock` parameter, `cache := &atomic.Bool{}`, and
  // harbor's `logger logger.Interface`.
  'clock/clock.go': `package clock

import "time"

// Named like k8s.io/utils/clock's interface.
type Clock interface {
	Now() time.Time
}
`,
  'cache/store.go': `package cache

type Store interface {
	Add(obj interface{}) error
}
`,
  'jobs/logger/logger.go': `package logger

type Interface interface {
	Error(v ...interface{})
	String() string
}

func Error(v ...interface{}) {}
`,
  'jobs/transfer/transfer.go': `package transfer

type Logger struct{}

func (l *Logger) Error(v ...interface{}) {}
`,
  'jobs/job.go': `package jobs

import (
	"sync/atomic"

	"example.com/app/cache"
	"example.com/app/jobs/logger"
	"k8s.io/utils/clock"
)

func logError(logger logger.Interface, err error) {
	logger.Error(err)
}

func nextCheck(clock clock.PassiveClock) int64 {
	return clock.Now().Unix()
}

func cachedHasSynced(store cache.Store) func() bool {
	cache := &atomic.Bool{}
	cache.Store(false)
	return cache.Load
}

func describe(logger logger.Interface) string {
	return logger.Kind.String()
}
`,
  // harbor's controller/robot.Robot embeds model.Robot, whose method a
  // local named like the import calls.
  'robot/model/model.go': `package model

type Robot struct{ Name string }

func (r *Robot) ToJSON() (string, error) { return r.Name, nil }
`,
  'robot/robot.go': `package robot

import "example.com/app/robot/model"

type Robot struct {
	model.Robot
	Level string
}
`,
  'scan/job_test.go': `package scan

import (
	"testing"

	"example.com/app/robot"
)

func TestJob(t *testing.T) {
	robot := &robot.Robot{Level: "system"}
	data, _ := robot.ToJSON()
	_ = data
}
`,
  'store/store.go': `package store

import "github.com/patrickmn/go-cache"

type store struct{}

func (cache *store) Refresh() {
	cache.load()
}

func (s *store) load() {}

func New() *cache.Cache {
	return cache.New(0, 0)
}
`,
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-ref-qualifier-'));
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

/** The line of `file` that holds `snippet` (its nth occurrence, from 1). */
const lineOf = (file: string, snippet: string, nth = 1): number => {
  const lines = files[file]!.split('\n');
  let seen = 0;
  const at = lines.findIndex((l) => l.includes(snippet) && ++seen === nth);
  if (at < 0) throw new Error(`no ${snippet} in ${file}`);
  return at + 1;
};

/** What the calls on the line of `file` holding `snippet` reach, as qualified names. */
const reachedAt = (file: string, snippet: string, nth = 1): string[] => {
  const line = lineOf(file, snippet, nth);
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains' && e.line === line)
    .map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('a dotted Go call is written through its own receiver', () => {
  it('whatever else on the line spells the name', () => {
    // `"Log using Infof"` and the `Digest:` key spell the name again.
    expect(reachedAt('example/example.go', 'klog.Infof(')).not.toContain('klogWrapper::Infof');
    expect(reachedAt('example/example.go', 'klog.Errorf(')).not.toContain('klogWrapper::Errorf');
    expect(reachedAt('example/example.go', 'digest.Digest(dig)')).not.toContain('Suite::Digest');
    expect(reachedAt('example/example.go', 'cmp.Diff("a", "b")')).not.toContain('Differ::Diff');
  });

  it('not through another selector on its line', () => {
    // `klog.Error(perr.Error())`: perr's own method, not a call through klog.
    expect(reachedAt('example/example.go', 'klog.Error(perr.Error())')).toContain('parseError::Error');
    // `s.cache.Get(key)`: the field's type, not the go-cache package the
    // middle segment is named like.
    expect(reachedAt('example/example.go', 's.cache.Get(key)')).toContain('lru::Get');
  });
});

describe('a Go parameter or local named like an import', () => {
  it('is the variable where it is in scope', () => {
    expect(reachedAt('auth/jwt_test.go', 'jwt.assign(')).toContain('tokenJWT::assign');
    expect(reachedAt('auth/jwt_test.go', 'jwt.info(token)')).toContain('tokenJWT::info');
    // A closure's parameter, a function's parameter, a range variable and a method receiver.
    expect(reachedAt('auth/jwt_test.go', 'jwt.info("t")')).toContain('tokenJWT::info');
    expect(reachedAt('compare/compare.go', 'cmp.Compare(1, 2)')).toContain('Comparer::Compare');
    expect(reachedAt('compare/compare.go', 'cmp.Compare(3, 4)')).toContain('Comparer::Compare');
    expect(reachedAt('store/store.go', 'cache.load()')).toContain('store::load');
  });

  it('leaves the package what the import names everywhere else', () => {
    // Another function, the declaration's own right-hand side, past a
    // closure or a loop that bound the name.
    expect(reachedAt('auth/jwt.go', 'jwt.Parse(token, nil)')).not.toContain('jwtOptions::Parse');
    expect(reachedAt('auth/jwt_test.go', 'jwt.Parse("x", nil)')).not.toContain('jwtOptions::Parse');
    expect(reachedAt('auth/jwt_test.go', 'jwt.Parse("y", nil)')).not.toContain('jwtOptions::Parse');
    expect(reachedAt('compare/compare.go', 'return cmp.Diff(a, b)')).not.toContain('Differ::Diff');
    expect(reachedAt('compare/compare.go', 'cmp := cmp.Diff(a, b)')).not.toContain('Differ::Diff');
  });

  it('has the methods of the type it is declared as', () => {
    // An outside package's type holds none of the project's methods…
    expect(reachedAt('jobs/job.go', 'clock.Now()')).not.toContain('Clock::Now');
    expect(reachedAt('jobs/job.go', 'cache.Store(false)')).toEqual([]);
    // …and a project package's type its own: not the function the import
    // names, nor another package's `Logger::Error`. A method an embedded
    // type brings in counts.
    expect(reachedAt('jobs/job.go', 'logger.Error(err)')).toEqual(['Interface::Error']);
    expect(reachedAt('scan/job_test.go', 'robot.ToJSON()')).toEqual(['Robot::ToJSON']);
    // The type is the variable's, not a field's read through it.
    expect(reachedAt('jobs/job.go', 'logger.Kind.String()')).not.toContain('Interface::String');
  });

  it('is read from the file as a sync leaves it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-ref-qualifier-sync-'));
    const write = (rel: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('go.mod', 'module example.com/app\n\ngo 1.22\n');
    write('auth/jwt.go', files['auth/jwt.go']!);
    // The same lines either way: a stale reading would still see the local.
    const use = (decl: string) => `package auth

import "github.com/golang-jwt/jwt/v5"

func use() {
	${decl}
	jwt.assign("user")
}
`;
    write('auth/use.go', use('jwt, _ := newTokenProviderJWT("key")'));
    const synced = await CodeGraph.init(dir, { index: true });
    try {
      const assigns = (): string[] => {
        const ids = synced.getNodesInFile('auth/use.go').map((n) => n.id);
        return synced.getOutgoingEdgesFrom(ids).filter((e) => e.line === 7).map((e) => synced.getNode(e.target)!.qualifiedName);
      };
      expect(assigns()).toEqual(['tokenJWT::assign']);
      write('auth/use.go', use('_, _ = jwt.Parse("key", nil)'));
      await synced.sync();
      expect(assigns()).toEqual([]);
    } finally {
      synced.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
