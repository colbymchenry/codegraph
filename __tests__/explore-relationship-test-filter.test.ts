/**
 * codegraph_explore — test edges in the Relationships section.
 *
 * Test files are already cut from the source section. The edge list was not
 * filtered with them, so on a well-covered symbol the per-kind cap filled with
 * `TestX -> X` lines and the production caller the agent asked about never
 * rendered. Relationships now follows the same rule, with an `includeTests`
 * escape hatch in both directions and the same "unless the query is about
 * tests" waiver the source-file filter uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore — test edges in Relationships', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reltests-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // One production caller of `reserveSlot`, buried under many test callers —
    // the real shape: a covered symbol's edge list is mostly its suite.
    fs.writeFileSync(
      path.join(src, 'store.ts'),
      `export function reserveSlot() { return 1; }\n`,
    );
    fs.writeFileSync(
      path.join(src, 'warm.ts'),
      `import { reserveSlot } from './store';\n` +
      `export function warmIfIdle() { return reserveSlot(); }\n`,
    );
    const testCallers = Array.from({ length: 8 }, (_, i) =>
      `export function checkReserveSlot${i}() { return reserveSlot(); }\n`,
    ).join('');
    fs.writeFileSync(
      path.join(src, 'store.test.ts'),
      `import { reserveSlot } from './store';\n` + testCallers,
    );

    // The Relationships section is gated on repo size (off below 500 files), so
    // the fixture has to clear that bar for this filter to render at all.
    const filler = path.join(src, 'filler');
    fs.mkdirSync(filler, { recursive: true });
    for (let i = 0; i < 520; i++) {
      fs.writeFileSync(path.join(filler, `mod${i}.ts`), `export function filler${i}() { return ${i}; }\n`);
    }

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const relationships = (text: string): string => {
    const start = text.indexOf('**Relationships**');
    if (start === -1) return '';
    const rest = text.slice(start);
    const end = rest.indexOf('**Source Code**');
    return end === -1 ? rest : rest.slice(0, end);
  };

  it('keeps the production caller and drops the suite by default', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'reserveSlot' });
    const rel = relationships(res.content[0].text);

    expect(rel).toContain('warmIfIdle');
    expect(rel).not.toMatch(/checkReserveSlot/);
  });

  it('includeTests: true puts the suite back', async () => {
    const res = await handler.execute('codegraph_explore', {
      query: 'reserveSlot',
      includeTests: true,
    });
    const rel = relationships(res.content[0].text);

    expect(rel).toMatch(/checkReserveSlot/);
  });

  it('shows the suite unasked when the query is itself about tests', async () => {
    const res = await handler.execute('codegraph_explore', {
      query: 'which tests cover reserveSlot',
    });
    const rel = relationships(res.content[0].text);

    expect(rel).toMatch(/checkReserveSlot/);
  });

  it('includeTests: false overrides that waiver', async () => {
    const res = await handler.execute('codegraph_explore', {
      query: 'which tests cover reserveSlot',
      includeTests: false,
    });
    const rel = relationships(res.content[0].text);

    expect(rel).not.toMatch(/checkReserveSlot/);
  });

  it('leaves the blast radius section naming the covering test file', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'reserveSlot' });
    const text = res.content[0].text;

    expect(text).toContain('**Blast radius');
    expect(text).toMatch(/tests:.*store\.test\.ts/);
  });
});
