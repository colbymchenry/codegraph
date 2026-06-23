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
    // Test coverage is surfaced (either the covering test file, or the warning).
    expect(text).toMatch(/tests:.*feature\.test\.ts|no covering tests/);
  });

  it('omits symbols that have no dependents from the blast radius', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'lonelyLeaf' });
    const text = res.content[0].text;
    // lonelyLeaf has zero callers — it must never appear under a blast-radius bullet.
    expect(text).not.toMatch(/Blast radius[\s\S]*`lonelyLeaf`/);
  });
});

describe('codegraph_explore — template-view callers in blast radius', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-blast-view-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // A shared helper depended on by MANY same-language code callers (> FILE_CAP)
    // plus a template view. Under a single flat cap the lone view would be
    // pushed into "+N more"; it must instead surface in its own dedicated slot.
    fs.writeFileSync(path.join(src, 'helper.ts'), `export function fmt(x: number) { return x + 1; }\n`);
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      fs.writeFileSync(
        path.join(src, `${n}.ts`),
        `import { fmt } from './helper';\nexport function use_${n}() { return fmt(1); }\n`,
      );
    }
    fs.writeFileSync(
      path.join(src, 'Widget.vue'),
      `<template><div /></template>\n<script>\nimport { fmt } from './helper';\nexport default { created() { fmt(2); } };\n</script>\n`,
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts', '**/*.vue'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('surfaces template-view callers in their own slot, not buried under the code "+N more" cap', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'fmt' });
    const text = res.content[0].text;
    expect(text).toContain('`fmt`');
    // The .vue view appears in a dedicated "view(s):" slot rather than being
    // hidden behind the >FILE_CAP code-caller "+N more".
    expect(text).toMatch(/views?:[^\n]*Widget\.vue/);
  });
});
