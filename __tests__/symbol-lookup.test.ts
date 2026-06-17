/**
 * Module-qualified symbol lookup (`stage_apply::run`, `Session.request`,
 * `configurator/stage_apply`).
 *
 * Pinned because the lookup vocabulary is what makes codegraph useful
 * in workspaces with same-named symbols across modules — Rust
 * sub-pipelines, Python `__init__.py` packages, Java packages, etc.
 * See #173 for the original report: a `run` function in
 * `src/configurator/stage_apply.rs` was indexed but `stage_apply::run`
 * returned "not found" because (a) FTS strips colons to nothing,
 * leaving a useless query, and (b) `matchesSymbol` only understood
 * `.`-style qualifiers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-symbol-lookup-'));
}

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function buildRustWorkspace(): Promise<string> {
  const root = tmpRoot();
  const cfgDir = path.join(root, 'src', 'configurator');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Cargo.toml'),
    `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n`
  );
  fs.writeFileSync(path.join(root, 'src', 'lib.rs'), `pub mod configurator;\npub mod scheduler;\n`);
  fs.writeFileSync(
    path.join(cfgDir, 'mod.rs'),
    `pub mod stage_apply;\npub mod stage_detect;\n`
  );
  fs.writeFileSync(
    path.join(cfgDir, 'stage_apply.rs'),
    `pub async fn run() -> Result<(), ()> {\n    render_and_write();\n    Ok(())\n}\n\nfn render_and_write() {}\n`
  );
  fs.writeFileSync(
    path.join(cfgDir, 'stage_detect.rs'),
    `pub async fn run() -> Result<(), ()> { Ok(()) }\n`
  );
  fs.writeFileSync(
    path.join(root, 'src', 'scheduler.rs'),
    `pub fn run_due_tasks() -> Result<(), ()> { Ok(()) }\n`
  );
  return root;
}

describe.skipIf(!HAS_SQLITE)('matchesSymbol — module-qualified lookups (#173)', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;
  // findSymbolMatches returns ALL ranked matches; [0] is the resolved/picked one.
  let findSymbolMatches: (cg: any, s: string) => any[];
  let findAllSymbols: (cg: any, s: string) => { nodes: any[]; note: string };

  beforeEach(async () => {
    projectRoot = await buildRustWorkspace();
    const CodeGraph = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = CodeGraph.initSync(projectRoot, {
      config: { include: ['**/*.rs'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
    findSymbolMatches = (handler as any).findSymbolMatches.bind(handler);
    findAllSymbols = (handler as any).findAllSymbols.bind(handler);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('resolves `stage_apply::run` to the run in stage_apply.rs (not stage_detect.rs)', () => {
    const matches = findSymbolMatches(cg, 'stage_apply::run');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.name).toBe('run');
    // Every match must be in stage_apply.rs — never stage_detect.rs.
    for (const n of matches) expect(n.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('rejects `stage_apply::run` for the same-named function in a different module', () => {
    const all = findAllSymbols(cg, 'stage_apply::run');
    // All returned nodes must be in stage_apply.rs — never in stage_detect.rs
    for (const node of all.nodes) {
      expect(node.filePath).toMatch(/stage_apply\.rs$/);
    }
    expect(all.nodes.length).toBeGreaterThan(0);
  });

  it('resolves `configurator::stage_apply::run` (multi-level qualifier)', () => {
    const matches = findSymbolMatches(cg, 'configurator::stage_apply::run');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.name).toBe('run');
    expect(matches[0]!.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('resolves `crate::configurator::stage_apply::run` (Rust path prefix stripped)', () => {
    const matches = findSymbolMatches(cg, 'crate::configurator::stage_apply::run');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('resolves `configurator/stage_apply` (slash qualifier)', () => {
    const matches = findSymbolMatches(cg, 'configurator/stage_apply/run');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.filePath).toMatch(/configurator\/stage_apply\.rs$/);
  });

  it('does not silently collide bare `run` with `run_due_tasks`', () => {
    const matches = findSymbolMatches(cg, 'run');
    expect(matches.length).toBeGreaterThan(0);
    // Whatever it picks, every match must be an exact-name match, not a partial.
    for (const n of matches) expect(n.name).toBe('run');
  });

  it('aggregates all bare-name `run` matches across modules', () => {
    const all = findAllSymbols(cg, 'run');
    const names = all.nodes.map((n: any) => n.name);
    expect(names.every((n: string) => n === 'run')).toBe(true);
    expect(all.nodes.length).toBeGreaterThanOrEqual(2); // stage_apply + stage_detect
    // The note should call out the ambiguity.
    expect(all.note).toMatch(/Aggregated|symbols named "run"/);
  });

  it('still returns nothing for genuinely unknown qualified lookups', () => {
    const matches = findSymbolMatches(cg, 'stage_apply::nonexistent_fn');
    expect(matches.length).toBe(0);
  });

  it('codegraph_node with a `file` hint pins an overloaded name to that file', async () => {
    // `run` is defined in BOTH stage_apply.rs and stage_detect.rs. A bare lookup
    // returns both; the `file` hint narrows to the one the caller saw in a trail.
    const res = await handler.execute('codegraph_node', {
      symbol: 'run',
      includeCode: true,
      file: 'stage_detect.rs',
    });
    const text = res.content?.[0]?.text ?? '';
    expect(text).toMatch(/stage_detect\.rs/);
    expect(text).not.toMatch(/stage_apply\.rs/);
  });
});

describe.skipIf(!HAS_SQLITE)('matchesSymbol — dotted lookups (regression for #173 fix)', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;
  let findSymbolMatches: (cg: any, s: string) => any[];

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const src = path.join(projectRoot, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'session.ts'),
      `export class Session {\n  request(): void { fetch('x'); }\n}\nexport function request(): void {}\n`
    );

    const CodeGraph = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = CodeGraph.initSync(projectRoot, {
      config: { include: ['src/**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
    findSymbolMatches = (handler as any).findSymbolMatches.bind(handler);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('`Session.request` resolves to the method, not the bare function', () => {
    const matches = findSymbolMatches(cg, 'Session.request');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.kind).toBe('method');
    expect(matches[0]!.qualifiedName).toContain('Session::request');
  });

  it('codegraph_node on an ambiguous bare name returns ALL overloads with bodies (no guess)', async () => {
    // `request` is BOTH a method (Session.request) and a free function. The old
    // behavior returned one + a dead-end "Others:" note, forcing a Read to get
    // the other overload; now both bodies come back in one call.
    const res = await handler.execute('codegraph_node', { symbol: 'request', includeCode: true });
    const text = res.content?.[0]?.text ?? '';
    expect(text).toContain('2 definitions named "request"');
    // Both definitions are rendered (method + function), each with a Location.
    expect(text).toMatch(/\(method\)/);
    expect(text).toMatch(/\(function\)/);
    expect((text.match(/\*\*Location:\*\*/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
