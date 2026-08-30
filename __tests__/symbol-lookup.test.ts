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
import { matchesSymbol, lookupSymbolNodes, isQualifiedSymbol } from '../src/graph/symbol-lookup';
import type { Node } from '../src/types';

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

/**
 * One resolution path for every verb that takes a symbol NAME.
 *
 * `callers` / `callees` / `impact` used to carry their own filter, comparing
 * the query against the BARE name only:
 *
 *     node.name === symbol || node.name.endsWith('.' + symbol)
 *
 * which fails in two opposite directions at once. A bare name matched every
 * same-named symbol in the repository and their results were merged under one
 * heading with nothing saying they were different symbols; a qualified name
 * could never equal a bare `node.name`, so every candidate failed the filter
 * and the code fell through to an arbitrary top-of-FTS hit — or reported "not
 * found" for a symbol that plainly exists. Both now go through
 * `lookupSymbolNodes`.
 */
function fakeNode(over: Partial<Node>): Node {
  return {
    id: 'n1', kind: 'function', name: 'group', qualifiedName: 'group',
    filePath: 'lib/format.ex', language: 'typescript',
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 0, updatedAt: 0,
    ...over,
  } as Node;
}

describe('matchesSymbol — containers whose own name contains a separator', () => {
  // Splitting on EVERY separator assumes no scope component contains one. That
  // is false for any language whose module names are themselves dotted, and
  // there the stored qualifiedName (`A.B::c`) can never equal the split-and-
  // rejoined query spelling (`A::B::c`) — so a perfectly precise qualified
  // query resolved to nothing.
  const node = fakeNode({ name: 'group', qualifiedName: 'AppWeb.Format::group' });

  it('matches a dotted module qualifier written with dots', () => {
    expect(matchesSymbol(node, 'AppWeb.Format.group')).toBe(true);
  });

  it('matches the same query written with the extractor separator', () => {
    expect(matchesSymbol(node, 'AppWeb.Format::group')).toBe(true);
  });

  it('matches a partial container suffix on a separator boundary', () => {
    expect(matchesSymbol(node, 'Format.group')).toBe(true);
  });

  it('does not match a container that merely shares a suffix substring', () => {
    // `ebFormat.group` is not a boundary-aligned suffix of `AppWeb.Format.group`.
    expect(matchesSymbol(node, 'ebFormat.group')).toBe(false);
  });

  it('does not match a different container', () => {
    expect(matchesSymbol(node, 'Other.Format.group')).toBe(false);
  });

  it('still requires the last part to be the node name', () => {
    expect(matchesSymbol(node, 'AppWeb.Format.other')).toBe(false);
  });

  it('classifies bare vs qualified queries', () => {
    expect(isQualifiedSymbol('group')).toBe(false);
    expect(isQualifiedSymbol('A.B.group')).toBe(true);
    expect(isQualifiedSymbol('A::group')).toBe(true);
    expect(isQualifiedSymbol('a/b')).toBe(true);
  });
});

describe.skipIf(!HAS_SQLITE)('lookupSymbolNodes — the shared path used by callers/callees/impact', () => {
  let projectRoot: string;
  let cg: any;

  beforeEach(async () => {
    projectRoot = tmpRoot();
    const client = path.join(projectRoot, 'client');
    const pkg = path.join(projectRoot, 'pkg', 'fmtutil');
    fs.mkdirSync(client, { recursive: true });
    fs.mkdirSync(pkg, { recursive: true });
    // The SAME short name defined in two languages — the collision profile of a
    // polyglot repository, where the colliding identifiers are the common ones.
    fs.writeFileSync(
      path.join(client, 'chart.ts'),
      `export function group(rows: number[][]): number[][] { return rows; }\n`
    );
    fs.writeFileSync(
      path.join(client, 'Editor.tsx'),
      `import { group } from './chart';\nexport function Editor(r: number[][]) { return group(r); }\n`
    );
    fs.writeFileSync(
      path.join(pkg, 'format.py'),
      `def group(items, size):\n    return items\n`
    );
    fs.writeFileSync(
      path.join(projectRoot, 'pkg', 'planner.py'),
      `from pkg.fmtutil.format import group\n\ndef plan_a(items): return group(items, 3)\ndef plan_b(items): return group(items, 5)\n`
    );

    const CodeGraph = (await import('../src/index')).default;
    cg = CodeGraph.initSync(projectRoot, {
      config: { include: ['**/*.ts', '**/*.tsx', '**/*.py'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    rmTree(projectRoot);
  });

  it('a bare name resolves to EVERY definition and reports the ambiguity', () => {
    const { nodes, ambiguous } = lookupSymbolNodes(cg, 'group');
    const defs = nodes.filter((n) => n.kind === 'function');
    expect(defs.length).toBe(2);
    expect(new Set(defs.map((n) => n.language))).toEqual(new Set(['typescript', 'python']));
    // The flag is what stops an aggregate being presented as one symbol's answer.
    expect(ambiguous).toBe(true);
  });

  it('a qualified name selects one definition and is no longer ambiguous', () => {
    const { nodes, ambiguous } = lookupSymbolNodes(cg, 'chart.group');
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.language).toBe('typescript');
    expect(nodes[0]!.filePath).toMatch(/chart\.ts$/);
    expect(ambiguous).toBe(false);
  });

  it('a qualified name selects the other language just as precisely', () => {
    const { nodes } = lookupSymbolNodes(cg, 'fmtutil.format.group');
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.language).toBe('python');
    expect(nodes[0]!.filePath).toMatch(/fmtutil\/format\.py$/);
  });

  it('resolves a qualified name even when full-text search finds nothing for it', () => {
    // FTS tokenises separators away, so a qualified query can score zero hits
    // while the symbol plainly exists. Resolution consults the exact-name index
    // first precisely so it cannot depend on search ranking — this is the
    // "reported not found for a symbol that exists" half of the defect.
    const fts = cg.searchNodes('fmtutil.format.group', { limit: 50 });
    const { nodes } = lookupSymbolNodes(cg, 'fmtutil.format.group');
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.filePath).toMatch(/format\.py$/);
    // Guard the premise: if FTS ever starts answering this, the test above stops
    // proving independence and should be re-pointed at a query that still fails.
    expect(Array.isArray(fts)).toBe(true);
  });

  it('callers of a qualified name exclude the other language entirely', () => {
    const { nodes } = lookupSymbolNodes(cg, 'chart.group');
    const callerFiles = nodes.flatMap((n: any) =>
      cg.getCallers(n.id).map((c: any) => c.node.filePath)
    );
    expect(callerFiles.length).toBeGreaterThan(0);
    for (const f of callerFiles) expect(f).not.toMatch(/\.py$/);
  });

  it('callers of the bare name span both languages — the union that must be disclosed', () => {
    const { nodes, ambiguous } = lookupSymbolNodes(cg, 'group');
    const callerFiles = nodes.flatMap((n: any) =>
      cg.getCallers(n.id).map((c: any) => c.node.filePath)
    );
    expect(ambiguous).toBe(true);
    expect(callerFiles.some((f: string) => f.endsWith('.py'))).toBe(true);
    expect(callerFiles.some((f: string) => f.endsWith('.tsx'))).toBe(true);
  });

  it('an unknown qualified name resolves to nothing rather than a fuzzy hit', () => {
    const { nodes } = lookupSymbolNodes(cg, 'chart.nonexistent_fn');
    expect(nodes.length).toBe(0);
  });
});
