/**
 * Go modules whose `go.mod` is not at the project root (#2322).
 *
 * A Go backend kept next to a frontend (`server/go.mod`, `web/package.json`),
 * or several modules side by side — etcd's root module beside `server/go.mod`
 * and `client/v3/go.mod`: each module's import paths start with its own
 * module path, and name a directory under that module's root. Only the
 * project-root `go.mod` used to be read, so with the module in `svc/` both
 * `store.New()` and `s.db.CreateItem()` lost their callers. An import path
 * belongs to the module declaring the longest prefix of it, and a name
 * written through a package is that package's — never a same-named symbol of
 * another package. A root-level `go.mod` resolves exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const STORE = `package store

type Manager struct{}

func New() *Manager { return &Manager{} }

func (m *Manager) CreateItem(name string) error { return nil }
`;

const CLOCK = `package clock

func Now() int { return 0 }
`;

// The issue's service, plus a call into a package outside `internal/`.
const service = (mod: string) => `package domain

import (
	"${mod}/internal/store"
	"${mod}/pkg/clock"
)

type Service struct {
	db *store.Manager
}

func NewService() *Service {
	return &Service{db: store.New()}
}

func (s *Service) AddItem(name string) error {
	return s.db.CreateItem(name)
}

func Stamp() int {
	return clock.Now()
}
`;

const projects: Array<{ root: string; cg: CodeGraph }> = [];

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-nested-mod-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  projects.push({ root, cg });
  return cg;
}

afterAll(() => {
  for (const { root, cg } of projects) {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** `file::qualifiedName` of every `kind` target of the symbol `name` in `file`. */
function targets(cg: CodeGraph, file: string, name: string, kind = 'calls'): string[] {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name);
  expect(fn, `${name} in ${file}`).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.filePath.replace(/\\/g, '/')}::${n.qualifiedName}`)
    .sort();
}

describe('Go module in a subdirectory (#2322)', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    cg = await indexProject({
      'svc/go.mod': 'module example.com/app/svc\n\ngo 1.22\n',
      'svc/internal/store/store.go': STORE,
      'svc/pkg/clock/clock.go': CLOCK,
      'svc/internal/domain/service.go': service('example.com/app/svc'),
      'web/package.json': '{ "name": "web" }\n',
    });
  });

  it('resolves a package-qualified call into the module', () => {
    expect(targets(cg, 'svc/internal/domain/service.go', 'NewService')).toEqual([
      'svc/internal/store/store.go::New',
    ]);
    expect(targets(cg, 'svc/internal/domain/service.go', 'Stamp')).toEqual([
      'svc/pkg/clock/clock.go::Now',
    ]);
  });

  it('resolves a call through a struct field typed with a package of the module', () => {
    expect(targets(cg, 'svc/internal/domain/service.go', 'AddItem')).toEqual([
      'svc/internal/store/store.go::Manager::CreateItem',
    ]);
  });
});

describe('Go modules side by side (#2322)', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    cg = await indexProject({
      // etcd's shape: a root module, and a sibling whose path is not under it.
      'go.mod': 'module example.com/etcd/v3\n\ngo 1.22\n',
      'etcdutl/main.go': `package main

import "example.com/etcd/server/v3/storage/wal"

func main() {
	wal.OpenForRead("dir")
}
`,
      'server/go.mod': 'module example.com/etcd/server/v3\n\ngo 1.22\n',
      'server/storage/wal/wal.go': 'package wal\n\nfunc OpenForRead(dir string) error { return nil }\n',
      'server/api/api.go': 'package api\n\nfunc Start() int { return 1 }\n',
      'server/cmd/main.go': `package main

import (
	"example.com/etcd/server/v3/api"
	"example.com/tools/lint"
)

type App struct {
	linter *lint.Linter
}

func main() {
	api.Start()
	lint.Run()
}

func (a *App) check() {
	a.linter.Check()
}
`,
      'server/cmd/ext.go': `package main

import (
	"example.com/toolsx/api"
)

func external() {
	api.Start()
}
`,
      'tools/go.mod': 'module example.com/tools\n\ngo 1.22\n',
      'tools/api/api.go': 'package api\n\nfunc Start() int { return 2 }\n',
      'tools/lint/lint.go': `package lint

type Linter struct{}

func Run() {}

func (l *Linter) Check() {}
`,
      'tools/gen/gen.go': `package main

import "example.com/tools/api"

func generate() {
	api.Start()
}
`,
    });
  });

  it('resolves an import of a sibling module whose path is not under the root module', () => {
    expect(targets(cg, 'etcdutl/main.go', 'main')).toEqual(['server/storage/wal/wal.go::OpenForRead']);
  });

  it("resolves each module's import into that module's own package", () => {
    expect(targets(cg, 'tools/gen/gen.go', 'generate')).toEqual(['tools/api/api.go::Start']);
    expect(targets(cg, 'server/cmd/main.go', 'main')).toEqual([
      'server/api/api.go::Start',
      'tools/lint/lint.go::Run',
    ]);
  });

  it("follows a struct field typed with the other module's package", () => {
    expect(targets(cg, 'server/cmd/main.go', 'check')).toEqual(['tools/lint/lint.go::Linter::Check']);
  });

  it('leaves an import that only shares a prefix with a module path unresolved', () => {
    expect(targets(cg, 'server/cmd/ext.go', 'external')).toEqual([]);
  });
});

describe('Names written through a package of a nested module (#2322)', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    cg = await indexProject({
      'src/go.mod': 'module example.com/harbor/src\n\ngo 1.22\n',
      'src/jobservice/job/op.go': 'package job\n\ntype OPCommand string\n',
      // A result type spelled like the method that returns it.
      'src/jobservice/impl/context.go': `package impl

import "example.com/harbor/src/jobservice/job"

type Context struct{}

func (c *Context) OPCommand() (job.OPCommand, bool) {
	return "", false
}
`,
      'src/pkg/artifact/manager.go': `package artifact

type Manager interface {
	Count() int64
}
`,
      // A caching wrapper delegating to the same-named type of another package.
      'src/pkg/cached/redis/manager.go': `package redis

import "example.com/harbor/src/pkg/artifact"

type Manager struct {
	delegator artifact.Manager
}

func (m *Manager) Count() int64 {
	return m.delegator.Count()
}
`,
      // A test fixture claiming the real module's path. The go tool ignores
      // testdata, so it never answers another module's import of that path.
      'internal/testdata/stub/go.mod': 'module example.com/harbor/src\n\ngo 1.22\n',
      'internal/testdata/stub/pkg/artifact/manager.go': `package artifact

type Manager interface {
	Count() int64
}
`,
      'tools/go.mod': 'module example.com/harbor/tools\n\ngo 1.22\n',
      'tools/report/report.go': `package report

import "example.com/harbor/src/pkg/artifact"

type Reporter struct {
	mgr artifact.Manager
}

func (r *Reporter) Total() int64 {
	return r.mgr.Count()
}
`,
    });
  });

  it('a type reference lands on the named package’s type, not a same-named method', () => {
    expect(targets(cg, 'src/jobservice/impl/context.go', 'OPCommand', 'references')).toEqual([
      'src/jobservice/job/op.go::OPCommand',
    ]);
  });

  it('a field typed with another package’s same-named type reaches that type, not the caller itself', () => {
    expect(targets(cg, 'src/pkg/cached/redis/manager.go', 'Count')).toEqual([
      'src/pkg/artifact/manager.go::Manager::Count',
    ]);
  });

  it('a module under testdata never answers for the module it imitates', () => {
    expect(targets(cg, 'tools/report/report.go', 'Total')).toEqual([
      'src/pkg/artifact/manager.go::Manager::Count',
    ]);
  });
});

describe('Two Go modules declaring the same path (#2322)', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    const files: Record<string, string> = {};
    for (const copy of ['v1', 'v2']) {
      files[`${copy}/go.mod`] = 'module example.com/app/svc\n\ngo 1.22\n';
      files[`${copy}/internal/store/store.go`] = STORE;
      files[`${copy}/pkg/clock/clock.go`] = CLOCK;
      files[`${copy}/internal/domain/service.go`] = service('example.com/app/svc');
    }
    cg = await indexProject(files);
  });

  it("resolves each copy's imports into its own module", () => {
    for (const copy of ['v1', 'v2']) {
      expect(targets(cg, `${copy}/internal/domain/service.go`, 'NewService')).toEqual([
        `${copy}/internal/store/store.go::New`,
      ]);
      expect(targets(cg, `${copy}/internal/domain/service.go`, 'Stamp')).toEqual([
        `${copy}/pkg/clock/clock.go::Now`,
      ]);
    }
  });
});

describe('Go module at the project root', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    cg = await indexProject({
      'go.mod': 'module example.com/app/svc\n\ngo 1.22\n',
      'internal/store/store.go': STORE,
      'pkg/clock/clock.go': CLOCK,
      'internal/domain/service.go': service('example.com/app/svc'),
    });
  });

  it('resolves exactly as before', () => {
    expect(targets(cg, 'internal/domain/service.go', 'NewService')).toEqual(['internal/store/store.go::New']);
    expect(targets(cg, 'internal/domain/service.go', 'Stamp')).toEqual(['pkg/clock/clock.go::Now']);
    expect(targets(cg, 'internal/domain/service.go', 'AddItem')).toEqual([
      'internal/store/store.go::Manager::CreateItem',
    ]);
  });
});
