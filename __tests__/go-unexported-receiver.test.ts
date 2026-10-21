/**
 * Go calls through a method receiver of an unexported type (#2323).
 *
 * `func (s *server) Create()` is the idiomatic shape of gRPC and HTTP
 * handlers, but only a PascalCase typed parameter used to give a receiver its
 * type, so `s.service.AddItem()` — and every other call through `s` — lost its
 * edge. Unexported names repeat across packages (each package may have its
 * own `server`), so a receiver's type is its own package's: a same-named type
 * elsewhere, with the same method or the same field, is never the target.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-unexported-recv-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'internal/domain/service.go': `package domain

type Service struct{}

func (s *Service) AddItem(name string) error { return nil }

func (s *Service) Count() int { return 0 }
`,
    // The issue's handler, plus calls on the receiver itself, through a type
    // it embeds and through a field of an unexported type.
    'internal/handlers/server.go': `package handlers

import "example.com/app/internal/domain"

type server struct {
	BaseAPI
	service *domain.Service
	store   *store
}

func (s *server) Create(name string) error {
	s.store.Put(name)
	s.Close()
	s.SendError()
	return s.service.AddItem(name)
}

type cache[T any] struct {
	service *domain.Service
}

func (c *cache[T]) Size() int {
	return c.service.Count()
}
`,
    'internal/handlers/store.go': `package handlers

type store struct{}

func (st *store) Put(name string) {}

func (s *server) Close() {}
`,
    'internal/handlers/base.go': `package handlers

type BaseAPI struct{}

func (b *BaseAPI) SendError() {}
`,
    // Another package declaring the same unexported names: never a target.
    'internal/admin/server.go': `package admin

type server struct {
	BaseAPI
	store *store
}

type store struct{}

func (st *store) Put(name string) {}

func (s *server) Close() {}

type BaseAPI struct{}

func (b *BaseAPI) SendError() {}
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

/** `file::qualifiedName` of every symbol the function `name` in `file` calls. */
function callTargets(file: string, name: string): string[] {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name);
  expect(fn, `${name} in ${file}`).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.filePath.replace(/\\/g, '/')}::${n.qualifiedName}`)
    .sort();
}

describe('Go calls through an unexported method receiver (#2323)', () => {
  it('resolves a call through a field of the receiver', () => {
    expect(callTargets('internal/handlers/server.go', 'Create')).toContain(
      'internal/domain/service.go::Service::AddItem'
    );
  });

  it('resolves a generic receiver past its type parameters', () => {
    expect(callTargets('internal/handlers/server.go', 'Size')).toEqual([
      'internal/domain/service.go::Service::Count',
    ]);
  });

  it("resolves every call within the receiver's own package, never a same-named type's in another", () => {
    expect(callTargets('internal/handlers/server.go', 'Create')).toEqual([
      'internal/domain/service.go::Service::AddItem',
      'internal/handlers/base.go::BaseAPI::SendError',
      'internal/handlers/store.go::server::Close',
      'internal/handlers/store.go::store::Put',
    ]);
    for (const decoy of cg.getNodesInFile('internal/admin/server.go').filter((n) => n.kind === 'method')) {
      expect(cg.getIncomingEdges(decoy.id).filter((e) => e.kind === 'calls'), decoy.qualifiedName).toEqual([]);
    }
  });
});
