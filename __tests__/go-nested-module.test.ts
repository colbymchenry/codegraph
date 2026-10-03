/**
 * Go modules whose `go.mod` is below the project root (#2322).
 *
 * A Go backend kept next to a frontend (`server/go.mod`, `web/package.json`)
 * or several modules side by side: each module's import paths start with its
 * own module path, and an in-module import names a directory under that
 * module's root. Only the project-root `go.mod` used to be read, so with the
 * module in `svc/` both `store.New()` and `s.db.CreateItem()` lost their
 * callers. A root-level `go.mod` resolves exactly as before.
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

// The issue's service, plus a call into a package outside \`internal/\`.
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

/** `file::qualifiedName` of every symbol the function `name` in `file` calls. */
function callTargets(cg: CodeGraph, file: string, name: string): string[] {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name);
  expect(fn, `${name} in ${file}`).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
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
    expect(callTargets(cg, 'svc/internal/domain/service.go', 'NewService')).toEqual([
      'svc/internal/store/store.go::New',
    ]);
    expect(callTargets(cg, 'svc/internal/domain/service.go', 'Stamp')).toEqual([
      'svc/pkg/clock/clock.go::Now',
    ]);
  });

  it('resolves a call through a struct field typed with a package of the module', () => {
    expect(callTargets(cg, 'svc/internal/domain/service.go', 'AddItem')).toEqual([
      'svc/internal/store/store.go::Manager::CreateItem',
    ]);
  });
});

describe('Go modules side by side (#2322)', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    cg = await indexProject({
      'server/go.mod': 'module example.com/server\n\ngo 1.22\n',
      'server/api/api.go': 'package api\n\nfunc Start() int { return 1 }\n',
      'server/cmd/main.go': `package main

import (
	"example.com/server/api"
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

  it("resolves each module's import into that module's own package", () => {
    expect(callTargets(cg, 'tools/gen/gen.go', 'generate')).toEqual(['tools/api/api.go::Start']);
    expect(callTargets(cg, 'server/cmd/main.go', 'main')).toEqual([
      'server/api/api.go::Start',
      'tools/lint/lint.go::Run',
    ]);
  });

  it('follows a struct field typed with the other module\'s package', () => {
    expect(callTargets(cg, 'server/cmd/main.go', 'check')).toEqual(['tools/lint/lint.go::Linter::Check']);
  });

  it('leaves an import that only shares a prefix with a module path unresolved', () => {
    expect(callTargets(cg, 'server/cmd/ext.go', 'external')).toEqual([]);
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
      expect(callTargets(cg, `${copy}/internal/domain/service.go`, 'NewService')).toEqual([
        `${copy}/internal/store/store.go::New`,
      ]);
      expect(callTargets(cg, `${copy}/internal/domain/service.go`, 'Stamp')).toEqual([
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
    expect(callTargets(cg, 'internal/domain/service.go', 'NewService')).toEqual(['internal/store/store.go::New']);
    expect(callTargets(cg, 'internal/domain/service.go', 'Stamp')).toEqual(['pkg/clock/clock.go::Now']);
    expect(callTargets(cg, 'internal/domain/service.go', 'AddItem')).toEqual([
      'internal/store/store.go::Manager::CreateItem',
    ]);
  });
});
