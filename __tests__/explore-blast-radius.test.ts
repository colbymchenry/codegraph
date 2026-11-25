/**
 * codegraph_explore blast-radius section.
 *
 * explore now appends a compact, always-on "Blast radius" for the entry
 * symbols: who depends on each (locations only — no source) and which test
 * files cover it, so the agent knows what to update/verify before editing
 * without a separate impact call. Symbols with no dependents are skipped, and
 * the section is omitted entirely when nothing qualifies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore — blast radius', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-blast-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // `target` is depended on by a sibling (caller) and a test file.
    fs.writeFileSync(
      path.join(src, 'feature.ts'),
      `export function target() { return 1; }\n` +
      `export function caller() { return target(); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'feature.test.ts'),
      `import { target } from './feature';\n` +
      `export function checkTarget() { return target(); }\n`,
    );
    // A leaf with no dependents — must NOT show up in the blast radius.
    fs.writeFileSync(
      path.join(src, 'leaf.ts'),
      `export function lonelyLeaf() { return 42; }\n`,
    );
    // `deepHelper` is only called by production code (`midCaller`), but the
    // test file exercises it transitively — 2 caller hops up (#1475).
    fs.writeFileSync(
      path.join(src, 'util.ts'),
      `export function deepHelper() { return 1; }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'mid.ts'),
      `import { deepHelper } from './util';\n` +
      `export function midCaller() { return deepHelper(); }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'mid.test.ts'),
      `import { midCaller } from './mid';\n` +
      `export function checkMid() { return midCaller(); }\n`,
    );
    // `untestedHelper` has a caller but no test anywhere up its caller chain.
    fs.writeFileSync(
      path.join(src, 'untested.ts'),
      `export function untestedHelper() { return 3; }\n` +
      `export function untestedCaller() { return untestedHelper(); }\n`,
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists dependents (locations only) and covering tests for an entry symbol', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'target' });
    const text = res.content[0].text;

    expect(text).toContain('**Blast radius');
    expect(text).toContain('`target`');
    expect(text).toMatch(/caller/); // a caller count is reported
    // It names WHERE (the caller file) — not the caller's source body.
    expect(text).toContain('feature.ts');
    // The direct covering test file is surfaced.
    expect(text).toMatch(/tests:.*feature\.test\.ts/);
  });

  it('surfaces tests that cover a symbol transitively through its callers (#1475)', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'deepHelper' });
    const text = res.content[0].text;

    // deepHelper's only direct caller is production code, but mid.test.ts sits
    // one more hop up — that must NOT read as "no tests".
    expect(text).toMatch(/`deepHelper`[^\n]*tested via callers:[^\n]*mid\.test\.ts/);
    const line = text.split('\n').find((l: string) => l.startsWith('- `deepHelper`'));
    expect(line).not.toMatch(/no tests found|no covering tests/);
  });

  it('states only what was measured when no test exists up the caller chain', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'untestedHelper' });
    const text = res.content[0].text;

    // Bounded claim, no warning glyph — the tool verified nothing beyond 3 hops.
    expect(text).toMatch(/`untestedHelper`[^\n]*no tests found within 3 caller hops/);
    expect(text).not.toContain('⚠️ no covering tests found');
  });

  it('omits symbols that have no dependents from the blast radius', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'lonelyLeaf' });
    const text = res.content[0].text;
    // lonelyLeaf has zero callers — it must never appear under a blast-radius bullet.
    expect(text).not.toMatch(/Blast radius[\s\S]*`lonelyLeaf`/);
  });
});
