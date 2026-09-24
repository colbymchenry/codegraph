/**
 * A TS/JS member call with an untyped receiver whose method name is a common
 * built-in prototype method — `lines.map()`, `seen.has(k)`, `p.then()` — is
 * the built-in, not whichever project class happens to declare the only
 * `map`/`has`/`then`. The name-only method fallback used to bind it anyway.
 * Typed receivers and receivers whose name names the class keep their edge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-builtin-methods-'));
  const w = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);
  w(
    'adapter.ts',
    'export class GraphAdapter {\n' +
      '  async map(req?: string) { return req ?? ""; }\n' +
      '  async filter() { return 1; }\n' +
      '}\n'
  );
  w(
    'lru.ts',
    'export class LRUCache<K, V> {\n' +
      '  private m = new Map<K, V>();\n' +
      '  get(k: K): V | undefined { return this.m.get(k); }\n' +
      '  has(k: K): boolean { return this.m.has(k); }\n' +
      '  evictOldest(): void {}\n' +
      '}\n'
  );
  w(
    'use.ts',
    'export function names(items: { name: string }[]): string[] {\n' +
      "  const lines = 'a\\nb'.split('\\n');\n" +
      '  const upper = lines.map((l) => l.toUpperCase());\n' +
      '  return items.filter((i) => i.name).map((i) => i.name).concat(upper);\n' +
      '}\n'
  );
  // Plain JS: no annotations, so the receiver type is unknown to the resolver.
  w(
    'plain.js',
    'export class Registry { has(k) { return !!k; } }\n' +
      'export class Deferred { then(cb) { cb(); } }\n' +
      'export function dedupe(xs, seen) {\n' +
      '  const out = [];\n' +
      '  for (const x of xs) { if (seen.has(x)) continue; seen.add(x); out.push(x); }\n' +
      '  return out;\n' +
      '}\n' +
      'export function later(pending) {\n' +
      '  pending.then(() => undefined);\n' +
      '}\n'
  );
  w(
    'owner.ts',
    "import { LRUCache } from './lru';\n" +
      'export class Owner {\n' +
      '  private cache: LRUCache<string, number> = new LRUCache();\n' +
      '  lookup(k: string): number | undefined { return this.cache.get(k); }\n' +
      '}\n' +
      'export function local(k: string): boolean {\n' +
      '  const c = new LRUCache<string, number>();\n' +
      '  return c.has(k);\n' +
      '}\n' +
      'export function viaParam(c: LRUCache<string, number>, k: string): boolean {\n' +
      '  return c.has(k);\n' +
      '}\n' +
      'export function named(treeCache: any, k: string): unknown {\n' +
      '  return treeCache.get(k);\n' +
      '}\n' +
      'export function evict(store: any): void {\n' +
      '  store.evictOldest();\n' +
      '}\n'
  );
  cg = await CodeGraph.init(dir, { index: true });
  cg.resolveReferences();
});

afterAll(() => {
  cg.destroy();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
  }
});

const calleesOf = (name: string, kind: 'function' | 'method' = 'function') => {
  const caller = cg.getNodesByKind(kind).find((n) => n.name === name);
  expect(caller).toBeDefined();
  return cg
    .getCallees(caller!.id)
    .filter(({ edge }) => edge.kind === 'calls')
    .map(({ node }) => node.qualifiedName)
    .sort();
};

describe('TS/JS built-in method names on untyped receivers', () => {
  it('does not bind Array map/filter to a lone project method of that name', () => {
    const callees = calleesOf('names');
    expect(callees).not.toContain('GraphAdapter::map');
    expect(callees).not.toContain('GraphAdapter::filter');
  });

  it('does not bind Set.has to a project class has', () => {
    expect(calleesOf('dedupe')).not.toContain('Registry::has');
  });

  it('does not bind Promise.then to a project class then', () => {
    expect(calleesOf('later')).not.toContain('Deferred::then');
  });

  it('keeps a typed class field call (this.cache.get)', () => {
    expect(calleesOf('lookup', 'method')).toContain('LRUCache::get');
  });

  it('keeps a call on a local constructed from the project class', () => {
    expect(calleesOf('local')).toContain('LRUCache::has');
  });

  it('keeps a call on a parameter typed as the project class', () => {
    expect(calleesOf('viaParam')).toContain('LRUCache::has');
  });

  it('keeps a call whose receiver name names the class', () => {
    expect(calleesOf('named')).toContain('LRUCache::get');
  });

  it('keeps a lone project method whose name is not a built-in', () => {
    expect(calleesOf('evict')).toContain('LRUCache::evictOldest');
  });
});
