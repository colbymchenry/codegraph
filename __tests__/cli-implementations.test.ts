/**
 * `codegraph implementations <name>` and the type hierarchy's descendants (#2833).
 *
 * The issue's Cargo workspace: a trait in one crate, a real implementor in a
 * second, a mock in that crate's `#[cfg(test)]` module, and a third crate that
 * only depends on the trait. Plus a TypeScript chain for `--depth`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { inCfgTestModule } from '../src/graph/test-code';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let projectRoot: string;
let cg: CodeGraph;

function write(file: string, source: string) {
  const absolute = path.join(projectRoot, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

function run(args: string[]) {
  return spawnSync(process.execPath, [BIN, 'implementations', '-p', projectRoot, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
    timeout: 30_000,
  });
}

function json(args: string[]) {
  const result = run([...args, '--json']);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

beforeAll(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-impl-2833-'));
  write('Cargo.toml', '[workspace]\nmembers = ["api", "store-real", "app"]\n');
  write('api/Cargo.toml', '[package]\nname = "api"\nversion = "0.1.0"\n');
  write('api/src/lib.rs', 'pub trait Store {\n    fn put(&self, key: &str);\n}\n');
  write('store-real/Cargo.toml', '[package]\nname = "store-real"\nversion = "0.1.0"\n[dependencies]\napi = { path = "../api" }\n');
  write('store-real/src/lib.rs', [
    'use api::Store;',
    'pub struct RealStore { pub n: u8 }',
    'impl Store for RealStore { fn put(&self, key: &str) { let _ = key; } }',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use api::Store;',
    '    struct MockStore { n: u8 }',
    '    impl Store for MockStore { fn put(&self, _key: &str) {} }',
    '    #[test]',
    '    fn mock_puts() { MockStore { n: 0 }.put("k"); }',
    '}',
    '',
  ].join('\n'));
  write('app/Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\napi = { path = "../api" }\nstore-real = { path = "../store-real" }\n');
  write('app/src/lib.rs', [
    'use api::Store;',
    'pub fn save(store: &dyn Store) { store.put("a"); }',
    'pub fn build() -> store_real::RealStore { store_real::RealStore { n: 0 } }',
    '',
  ].join('\n'));
  write('ts/shapes.ts', [
    'export interface Shape { area(): number; }',
    'export class Square implements Shape { area() { return 1; } }',
    'export class Cube extends Square { volume() { return 1; } }',
    'export function measure(s: Shape) { return s.area(); }',
    '',
  ].join('\n'));
  write('ts/__tests__/mock-shape.ts', [
    "import { Shape } from '../shapes';",
    'export class MockShape implements Shape { area() { return 0; } }',
    '',
  ].join('\n'));
  cg = CodeGraph.initSync(projectRoot);
  await cg.indexAll();
}, 60_000);

afterAll(() => {
  cg.destroy();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('getTypeHierarchy()', () => {
  it('returns the implementors of a trait, not only its ancestors', () => {
    const store = cg.getNodesByName('Store').find((n) => n.kind === 'trait');
    expect(store).toBeDefined();
    const hierarchy = cg.getTypeHierarchy(store!.id);
    const implementors = hierarchy.edges
      .filter((e) => e.kind === 'implements' && e.target === store!.id)
      .map((e) => hierarchy.nodes.get(e.source)?.name)
      .sort();
    expect(implementors).toEqual(['MockStore', 'RealStore']);
  });

  it('still returns the ancestors of a subtype', () => {
    const cube = cg.getNodesByName('Cube').find((n) => n.kind === 'class');
    const hierarchy = cg.getTypeHierarchy(cube!.id);
    const names = [...hierarchy.nodes.values()].map((n) => n.name).sort();
    expect(names).toEqual(['Cube', 'Shape', 'Square']);
  });
});

describe('codegraph implementations', () => {
  it('lists a trait\'s implementors with the edge kind, and marks the #[cfg(test)] mock as test code', () => {
    const out = json(['Store']);
    expect(out.ambiguous).toBe(false);
    expect(out.definitions).toHaveLength(1);
    const def = out.definitions[0];
    expect(def.definition.kind).toBe('trait');
    expect(def.directSubtypes).toBe(2);
    // Order within a level is the hierarchy walk's, not this command's.
    const rows = def.implementations.map((r: { name: string; relation: string; test: boolean; filePath: string; startLine: number }) =>
      [r.name, r.relation, r.test, `${r.filePath}:${r.startLine}`]).sort();
    expect(rows).toEqual([
      ['MockStore', 'implements', true, 'store-real/src/lib.rs:8'],
      ['RealStore', 'implements', false, 'store-real/src/lib.rs:2'],
    ]);
    // Dependents and the trait's own method are not implementors.
    const names = def.implementations.map((r: { name: string }) => r.name);
    expect(names).not.toContain('save');
    expect(names).not.toContain('build');
    expect(names).not.toContain('put');
  });

  it('prints one line per implementor with its location and a [test] tag', () => {
    const result = run(['Store']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Implementations of trait Store (rust)');
    expect(result.stdout).toMatch(/struct\s+RealStore\s+implements\s+store-real\/src\/lib\.rs:2\n/);
    expect(result.stdout).toMatch(/struct\s+MockStore\s+implements\s+store-real\/src\/lib\.rs:8\s+\[test\]\n/);
    expect(result.stdout).not.toContain('save');
  });

  it('lists direct implementors by default and follows subclasses with --depth', () => {
    const direct = json(['Shape']);
    const directRows = direct.definitions[0].implementations.map((r: { name: string; depth: number }) => [r.name, r.depth]).sort();
    expect(directRows).toEqual([['MockShape', 1], ['Square', 1]]);
    expect(direct.definitions[0].implementations.find((r: { name: string }) => r.name === 'MockShape').test).toBe(true);

    const deep = json(['Shape', '--depth', '2']);
    const deepRows = deep.definitions[0].implementations.map((r: { name: string; depth: number; relation: string; via?: string }) =>
      [r.name, r.depth, r.relation, r.via]);
    // Breadth-first: depth 1 is complete before depth 2 begins.
    expect(deepRows.slice(0, 2).sort()).toEqual([
      ['MockShape', 1, 'implements', undefined],
      ['Square', 1, 'implements', undefined],
    ]);
    expect(deepRows.slice(2)).toEqual([['Cube', 2, 'extends', 'Square']]);
    const text = run(['Shape', '-d', '2']);
    expect(text.stdout).toMatch(/\n {4}class\s+Cube\s+extends Square\s+ts\/shapes\.ts:3\n/);
  });

  it('says so when the symbol is not a type', () => {
    const result = run(['measure']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('not a type something can implement or extend');
  });

  it('says so when the symbol is unknown', () => {
    const result = run(['NoSuchType']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('not found');
  });
});

describe('inCfgTestModule()', () => {
  const source = [
    'pub struct A;',
    '#[cfg(test)]',
    '#[allow(dead_code)]',
    'mod tests {',
    '    struct Mock { x: u8 }',
    '    fn braces() { let _ = "{"; }',
    '}',
    'pub struct B;',
    '#[cfg(not(test))]',
    'mod real { pub struct C; }',
  ].join('\n');
  it('is true inside the module and false before, after and in other modules', () => {
    expect(inCfgTestModule(source, 1)).toBe(false);
    expect(inCfgTestModule(source, 5)).toBe(true);
    expect(inCfgTestModule(source, 6)).toBe(true);
    expect(inCfgTestModule(source, 8)).toBe(false);
    expect(inCfgTestModule(source, 10)).toBe(false);
  });

  it('finds the end of the module past a brace in a character, a raw string or a block comment', () => {
    const tricky = [
      '#[cfg(test)]',
      'mod tests {',
      "    const OPEN: char = '{';",
      '    const RAW: &str = r#"{"#;',
      '    /* { */',
      '    struct Mock;',
      '}',
      'pub struct After;',
    ].join('\n');
    expect(inCfgTestModule(tricky, 6)).toBe(true);
    expect(inCfgTestModule(tricky, 8)).toBe(false);
  });

  it('reads test inside cfg(all(...)), and not a negated test', () => {
    const gated = [
      '#[cfg(all(test, not(loom)))]',
      'mod tests {',
      '    struct Mock;',
      '}',
      '#[cfg(all(feature = "sync", test))]',
      'mod sync_tests {',
      '    struct SyncMock;',
      '}',
      '#[cfg(all(unix, not(test)))]',
      'mod real {',
      '    struct Real;',
      '}',
    ].join('\n');
    expect(inCfgTestModule(gated, 3)).toBe(true);
    expect(inCfgTestModule(gated, 7)).toBe(true);
    expect(inCfgTestModule(gated, 11)).toBe(false);
  });
});
