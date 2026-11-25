/**
 * Issue #2455: a Jest (or Vitest) manual mock under `__mocks__/` stands in for
 * a module only while a test runs. Production code never means it: when
 * `import { formatLabel } from 'acme-shared'` could not be followed, the
 * production call fell back to name matching and bound to
 * `__mocks__/acme-shared.ts`, the nearer namesake, so the real function lost
 * its caller. The same happened to the import's names, type references,
 * constructions, `extends`, and a rendered `<Chart />`.
 *
 * Test code may still reach a mock (that is when Jest substitutes it), and so
 * may a file that imports the mock by its own path, like a `jest.setup.ts`.
 * Jest's `moduleNameMapper` and automock only act while Jest runs, so a
 * config that maps the package to the mock changes nothing for production
 * code.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const MOCK = 'packages/api/__mocks__/acme-shared.tsx';
const REAL = 'packages/common/utils.tsx';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'acme-monorepo', private: true, workspaces: ['packages/*'] }),
  'jest.config.js': `module.exports = { moduleNameMapper: { '^acme-shared$': '<rootDir>/packages/api/__mocks__/acme-shared.tsx' }, automock: true };
`,
  'packages/common/package.json': JSON.stringify({ name: 'acme-shared', version: '1.0.0' }),
  [REAL]: `export function formatLabel(name: string): string { return name.trim(); }
export function isAdmin(role: string): boolean { return role === 'admin'; }
export interface Label { text: string }
export class Client { send(): number { return 1; } }
export class BaseStore { load(): number { return 1; } }
export function Chart() { return null; }
`,
  'packages/api/package.json': JSON.stringify({ name: 'acme-api', dependencies: { 'acme-shared': 'workspace:*', react: '^18.0.0' } }),
  [MOCK]: `export function formatLabel(name: string): string { return 'mock'; }
export function isAdmin(role: string): boolean { return true; }
export interface Label { text: string; mocked: true }
export class Client { send(): number { return 0; } }
export class BaseStore { load(): number { return 0; } }
export function Chart() { return null; }
export function resetMocks(): void {}
`,
  'packages/api/__mocks__/helpers.ts': `export function mockHelper() { return resetMocks(); }
`,
  'packages/api/src/handler.tsx': `import { formatLabel, isAdmin, Client, BaseStore, Chart } from 'acme-shared';
import type { Label } from 'acme-shared';

export function handleRequest(name: string, role: string): string {
  if (!isAdmin(role)) return 'forbidden';
  return formatLabel(name);
}
export function label(l: Label): string { return l.text; }
export function send() { return new Client().send(); }
export class Store extends BaseStore {}
export function View() { return <Chart />; }
`,
  'packages/api/src/handler.test.ts': `export function setUp(): void { resetMocks(); }
`,
  'packages/api/jest.setup.ts': `import { resetMocks } from './__mocks__/acme-shared';
resetMocks();
`,
  // An event bus: production code emits; production code registers `handleReady`, which a mock
  // declares too, and a test registers the mock's `onSavedMock`.
  'packages/api/src/bus.ts': `export function start(bus: { emit(e: string): void }) {
  bus.emit('ready');
  bus.emit('saved');
}
`,
  'packages/api/src/wire.ts': `export function wire(bus: { on(e: string, f: () => void): void }) {
  bus.on('ready', handleReady);
}
`,
  'packages/api/src/handlers.ts': `export function handleReady(): void {}
`,
  'packages/api/__mocks__/handlers.ts': `export function handleReady(): void {}
export function onSavedMock(): void {}
`,
  'packages/api/src/bus.test.ts': `export function listen(bus: { on(e: string, f: () => void): void }) {
  bus.on('saved', onSavedMock);
}
`,
  // A mock beside one of the app's own modules: an unimported call never means the mock.
  'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: { vue: '^3.0.0' } }),
  'packages/web/src/api.ts': `export function fetchUser(id: string) { return id; }
`,
  'packages/web/src/__mocks__/api.ts': `export function fetchUser(id: string) { return 'mock-' + id; }
export function onlyMock() { return 2; }
`,
  'packages/web/src/page.ts': `import { fetchUser } from './api';
export function page() { return fetchUser('1'); }
export function guess() { return onlyMock(); }
`,
  'packages/web/src/components/Badge.vue': `<template><span /></template>
`,
  'packages/web/src/components/__mocks__/Badge.vue': `<template><i /></template>
`,
  // Only a mock declares `Pill`: the template's `<Pill />` is a component from elsewhere.
  'packages/web/src/components/__mocks__/Pill.vue': `<template><i /></template>
`,
  // `__mocks__/` sorts before `avatar/`: a pick by order alone would take the mock.
  'packages/web/src/components/__mocks__/Avatar.vue': `<template><i /></template>
`,
  'packages/web/src/components/avatar/Avatar.vue': `<template><img /></template>
`,
  'packages/web/src/components/Card.vue': `<template><div><Badge /><Pill /><Avatar /></div></template>
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jest-manual-mocks-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `kind name@file` of every edge but `contains` leaving the nodes of `file`. */
function edgesFrom(file: string): string[] {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const e of cg.getOutgoingEdges(node.id)) {
      if (e.kind === 'contains') continue;
      const target = cg.getNode(e.target)!;
      out.push(`${e.kind} ${target.name}@${target.filePath}`);
    }
  }
  return out;
}

describe('a Jest manual mock under __mocks__/ (#2455)', () => {
  it("is never what production code means by name: the issue's calls and imports reach the package", () => {
    const edges = edgesFrom('packages/api/src/handler.tsx');
    expect(edges.filter((e) => e.endsWith(`@${MOCK}`))).toEqual([]);
    // What the name means without the mock: the workspace package's own function.
    expect(edges).toEqual(expect.arrayContaining([
      `calls formatLabel@${REAL}`, `calls isAdmin@${REAL}`, `imports formatLabel@${REAL}`, `imports isAdmin@${REAL}`,
    ]));
  });

  it('nor a type it names, a class it constructs or extends, or a component it renders', () => {
    const edges = edgesFrom('packages/api/src/handler.tsx');
    for (const kind of ['references Label', 'instantiates Client', 'extends BaseStore', 'calls Chart']) {
      expect(edges).not.toContain(`${kind}@${MOCK}`);
      expect(edges).toContain(`${kind}@${REAL}`);
    }
  });

  it("nor a mock beside the app's own module, from a call or a Vue template", () => {
    expect(edgesFrom('packages/web/src/page.ts')).not.toContain('calls onlyMock@packages/web/src/__mocks__/api.ts');
    expect(edgesFrom('packages/web/src/page.ts')).toContain('calls fetchUser@packages/web/src/api.ts');
    const card = edgesFrom('packages/web/src/components/Card.vue');
    expect(card).not.toContain('calls Badge@packages/web/src/components/__mocks__/Badge.vue');
    expect(card).not.toContain('calls Pill@packages/web/src/components/__mocks__/Pill.vue');
    expect(card).toContain('calls Badge@packages/web/src/components/Badge.vue');
    expect(card).toContain('calls Avatar@packages/web/src/components/avatar/Avatar.vue');
  });

  it('nor a handler an event bus pairs with what production code emits', () => {
    const edges = edgesFrom('packages/api/src/bus.ts');
    // Registered by production code: the handler it can mean.
    expect(edges).toContain('calls handleReady@packages/api/src/handlers.ts');
    expect(edges).not.toContain('calls handleReady@packages/api/__mocks__/handlers.ts');
    // Registered by a test: what the test hands the bus, never what production code calls.
    expect(edges).not.toContain('calls onSavedMock@packages/api/__mocks__/handlers.ts');
  });

  it('is still reached from test code, from another mock, and through an import of its own path', () => {
    expect(edgesFrom('packages/api/src/handler.test.ts')).toContain(`calls resetMocks@${MOCK}`);
    expect(edgesFrom('packages/api/__mocks__/helpers.ts')).toContain(`calls resetMocks@${MOCK}`);
    expect(edgesFrom('packages/api/jest.setup.ts')).toContain(`calls resetMocks@${MOCK}`);
  });
});

describe('sync: adding or deleting a manual mock leaves production code as it was (#2455)', () => {
  it('matches the graph before the mock came and after it went', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jest-manual-mocks-sync-'));
    const write = (files: Record<string, string>): void => {
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
    };
    write({
      'package.json': FILES['package.json']!,
      'packages/common/package.json': FILES['packages/common/package.json']!,
      [REAL]: FILES[REAL]!,
      'packages/api/package.json': FILES['packages/api/package.json']!,
      'packages/api/src/handler.tsx': FILES['packages/api/src/handler.tsx']!,
    });
    const graph = await CodeGraph.init(dir, { index: true });
    const production = (): string[] =>
      graph.getNodesInFile('packages/api/src/handler.tsx').flatMap((n) =>
        graph.getOutgoingEdges(n.id).filter((e) => e.kind !== 'contains').map((e) => `${e.kind} ${graph.getNode(e.target)!.name}@${graph.getNode(e.target)!.filePath}`)).sort();
    try {
      const before = production();
      expect(before).toContain(`calls formatLabel@${REAL}`);
      write({ [MOCK]: FILES[MOCK]! });
      await graph.sync();
      expect(production()).toEqual(before);
      fs.rmSync(path.join(dir, MOCK));
      await graph.sync();
      expect(production()).toEqual(before);
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
