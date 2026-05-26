/**
 * Per-file staleness banner on MCP tool responses (issue #403).
 *
 * The watcher tracks every file event since the last successful sync; the
 * tool dispatcher intersects "files referenced in this response" with that
 * pending set and prepends a banner ("⚠️ Some files referenced below were
 * edited since the last index sync…") plus an optional footer ("(Note: N
 * file(s) elsewhere in this project are pending index sync…)").
 *
 * No auto-flush, no static wait — the response is instant and the agent
 * decides whether to Read the specific stale file. These tests exercise
 * the full real path: real watcher + real CodeGraph index + real
 * ToolHandler.execute().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('MCP staleness banner', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-banner-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    // Three isolated files with no cross-references — keeps each test's
    // "which path does the response mention?" assertion unambiguous. If the
    // files shared imports/calls, codegraph_search responses would surface
    // multiple file paths and the banner-vs-footer split would be racy.
    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'bravo-only.ts'),
      'export function bravoOnly() { return 2; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'charlie-only.ts'),
      'export function charlieOnly() { return 3; }\n',
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('prepends a stale banner when the response references a pending file', async () => {
    // Long debounce so the edit lingers in pendingFiles while we query.
    cg.watch({ debounceMs: 4000 });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 99; }\n',
    );
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/alpha-only.ts'), 8000);

    const res = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;

    // Banner shape: warning glyph + filename + actionable instruction.
    expect(text.startsWith('⚠️')).toBe(true);
    expect(text).toContain('src/alpha-only.ts');
    expect(text).toMatch(/edited \d+ms ago/);
    expect(text).toMatch(/Read them directly/);
    // The actual result must still follow the banner.
    expect(text).toMatch(/alphaOnly/);
  });

  it('uses the footer (not the banner) when pending files are not referenced', async () => {
    cg.watch({ debounceMs: 4000 });
    await cg.waitUntilWatcherReady();

    // Edit bravo-only.ts but search for the alphaOnly symbol, whose hit is
    // only in alpha-only.ts. The two files share no imports/calls so the
    // response text won't mention bravo-only.ts.
    fs.writeFileSync(
      path.join(testDir, 'src', 'bravo-only.ts'),
      'export function bravoOnly() { return 22; }\n',
    );
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/bravo-only.ts'), 8000);

    const res = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    const text = res.content[0].text;

    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/elsewhere in this project are pending index sync/);
    expect(text).toContain('src/bravo-only.ts');
  });

  it('drops the banner once the sync completes and clears the pending entry', async () => {
    cg.watch({ debounceMs: 200 });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 7; }\n',
    );
    await waitFor(() => cg.getPendingFiles().length === 0, 5000);

    const res = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    const text = res.content[0].text;
    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).not.toMatch(/elsewhere in this project are pending index sync/);
  });

  it('lists pending files under "Pending sync" in codegraph_status', async () => {
    cg.watch({ debounceMs: 4000 });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'charlie-only.ts'),
      'export function charlieOnly() { return 33; }\n',
    );
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/charlie-only.ts'), 8000);

    const res = await handler.execute('codegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('### Pending sync:');
    expect(text).toContain('src/charlie-only.ts');
    // Status embeds the info first-class, so the auto-banner is suppressed.
    expect(text.startsWith('⚠️')).toBe(false);
  });

  it('returns zero pending files when no watcher is active', () => {
    expect(cg.getPendingFiles()).toEqual([]);
  });
});
