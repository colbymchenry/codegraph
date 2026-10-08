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
 * the full real path: real CodeGraph index + real ToolHandler.execute().
 *
 * **Event delivery uses a synthetic seam** (`__emitWatchEventForTests`): the
 * real native fs.watch (FSEvents/inotify) delivery is non-deterministic under
 * parallel vitest execution and produced a consistent ~30% failure rate on
 * these tests when run inside the full suite. The seam drives the watcher's
 * pending-set pipeline directly so the tests synthesize file events
 * deterministically. The watcher's actual debounce timer (real setTimeout) is
 * left untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { __emitWatchEventForTests, __setFsWatchForTests } from '../src/sync/watcher';

function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
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

/**
 * Keep the watcher's edits pending for the rest of the test. A long
 * `debounceMs` alone does not: a lone edit syncs after a 300ms quiet window
 * whatever the configured debounce (#1397), and under full-suite load a tool
 * call can outlast that (status spawns a worker to count changes), so the sync
 * cleared the entry before the response was built. A sync that never settles
 * leaves each entry pending (marked as indexing once it starts).
 */
function holdWatcherSync(cg: CodeGraph): void {
  vi.spyOn(cg, 'sync').mockReturnValue(new Promise<never>(() => {}));
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
    __setFsWatchForTests(null); // reset the injected fs.watch seam
    vi.restoreAllMocks();
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // Force watch-resource exhaustion at startup so the real watcher degrades
  // deterministically on any platform (recursive or per-directory strategy).
  const degradeWatcher = () => {
    __setFsWatchForTests(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    const started = cg.watch({ debounceMs: 1000 }); // real (non-inert) watcher
    expect(started).toBe(false);
    expect(cg.isWatcherDegraded()).toBe(true);
  };

  it('prepends a stale banner when the response references a pending file', async () => {
    holdWatcherSync(cg);
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();

    // Real disk write so a later sync (if it fires) sees the new content,
    // plus a synthesized chokidar event so the watcher's pendingFiles set
    // updates immediately without waiting on OS-level event delivery.
    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 99; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/alpha-only.ts');

    // With mocked chokidar this is synchronous — keep the wait just to
    // exercise the realistic shape (the watcher's `chokidarReady` gate
    // and the small window before the pending-file Map is populated).
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/alpha-only.ts'));

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
    holdWatcherSync(cg);
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();

    // Edit bravo-only.ts but search for the alphaOnly symbol, whose hit is
    // only in alpha-only.ts. The two files share no imports/calls so the
    // response text won't mention bravo-only.ts.
    fs.writeFileSync(
      path.join(testDir, 'src', 'bravo-only.ts'),
      'export function bravoOnly() { return 22; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/bravo-only.ts');
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/bravo-only.ts'));

    const res = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    const text = res.content[0].text;

    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/elsewhere in this project are pending index sync/);
    expect(text).toContain('src/bravo-only.ts');
  });

  it('drops the banner once the sync completes and clears the pending entry', async () => {
    cg.watch({ debounceMs: 200, inertForTests: true });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 7; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/alpha-only.ts');
    // Wait through debounce (200ms) + sync; pendingFiles drains back to empty.
    await waitFor(() => cg.getPendingFiles().length === 0, 3000);

    const res = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    const text = res.content[0].text;
    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).not.toMatch(/elsewhere in this project are pending index sync/);
  });

  it('lists pending files under "Pending sync" in codegraph_status', async () => {
    holdWatcherSync(cg);
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'charlie-only.ts'),
      'export function charlieOnly() { return 33; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/charlie-only.ts');
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/charlie-only.ts'));

    const res = await handler.execute('codegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('**Pending sync:');
    expect(text).toContain('src/charlie-only.ts');
    // Status embeds the info first-class, so the auto-banner is suppressed.
    expect(text.startsWith('⚠️')).toBe(false);
  });

  it('returns zero pending files when no watcher is active', () => {
    expect(cg.getPendingFiles()).toEqual([]);
  });

  it('prepends a whole-index degraded banner once live watching has permanently stopped (#876)', async () => {
    degradeWatcher();

    const res = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;

    expect(text.startsWith('⚠️')).toBe(true);
    expect(text).toMatch(/auto-sync is DISABLED/i);
    expect(text).toMatch(/Read files directly/i);
    expect(text).toContain('OS watch/file limit exhausted'); // the degrade reason
    expect(text).toMatch(/alphaOnly/); // the real result still follows the banner
  });

  it('surfaces the degraded state as its own section in codegraph_status (#876)', async () => {
    degradeWatcher();

    const res = await handler.execute('codegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('**Auto-sync disabled:');
    expect(text).toContain('OS watch/file limit exhausted');
    // status renders the notice inline, so the auto-banner is not also prepended.
    expect(text.startsWith('⚠️')).toBe(false);
  });

  it('distinguishes a re-armed but not-yet-caught-up watcher from a disabled one (#1959)', async () => {
    vi.spyOn(cg, 'isWatcherDegraded').mockReturnValue(true);
    vi.spyOn(cg, 'isWatcherRecovering').mockReturnValue(true);

    const search = await handler.execute('codegraph_search', { query: 'alphaOnly' });
    expect(search.content[0].text).toMatch(/auto-sync is RECOVERING/);
    expect(search.content[0].text).not.toMatch(/auto-sync is DISABLED/);

    const status = await handler.execute('codegraph_status', {});
    expect(status.content[0].text).toContain('**Auto-sync recovering:**');
    expect(status.content[0].text).not.toContain('**Auto-sync disabled:**');
  });

  it('asks the owned watcher to re-arm on the next MCP tool call (#1959)', async () => {
    const rearm = vi.spyOn(cg, 'rearmWatcherAfterLockContention').mockReturnValue(false);

    await handler.execute('codegraph_status', {});
    expect(rearm).toHaveBeenCalledTimes(1);
  });
});

describe('MCP staleness banner — matching whole paths (#1968)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-paths-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'app.tsx'), 'export function appView() { return 1; }\n');
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
    holdWatcherSync(cg);
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();
  });

  afterEach(() => {
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function pend(rel: string): Promise<void> {
    fs.writeFileSync(path.join(testDir, rel), 'export const edited = 1;\n');
    __emitWatchEventForTests(testDir, rel);
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === rel));
  }

  it('does not name a pending file whose path only starts a path the response shows', async () => {
    await pend('src/app.ts'); // the response shows src/app.tsx
    const text = (await handler.execute('codegraph_search', { query: 'appView' })).content[0].text;
    expect(text).toContain('src/app.tsx');
    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/elsewhere in this project are pending index sync/);
  });

  it('does not name a pending file whose path only ends a path the response shows', async () => {
    await pend('app.tsx'); // the response shows src/app.tsx
    const text = (await handler.execute('codegraph_search', { query: 'appView' })).content[0].text;
    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/elsewhere in this project are pending index sync/);
  });

  it.each([
    'src/app.ts中文.ts',
    '目录src/app.ts',
    'src/app.ts@backup.ts',
    'src/app.ts+backup.ts',
    'src/app.ts%backup.ts',
    'src/app.ts,backup.ts',
    'src/app.ts#backup.ts',
    'src/app.ts.backup.ts',
    'src/app.ts/child.ts',
    '@src/app.ts',
    'src/app.ts🦀.ts',
  ])('keeps a pending prefix or suffix out of the banner for %s', async (shown) => {
    fs.mkdirSync(path.dirname(path.join(testDir, shown)), { recursive: true });
    fs.writeFileSync(path.join(testDir, shown), 'export function otherView() { return 2; }\n');
    await cg.indexAll();
    // A directory can also have a filename-like component; use a root suffix
    // for that case so the pending file and directory can coexist on disk.
    await pend(shown.includes('/child') ? 'child.ts' : 'src/app.ts');
    const text = (await handler.execute('codegraph_search', { query: 'otherView' })).content[0].text;
    expect(text).toContain(shown);
    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/elsewhere in this project are pending index sync/);
  });

  it.each([
    'src/app.ts',
    '**`src/app.ts`**',
    '**src/app.ts**',
    '(src/app.ts:12)',
    'src/app.ts:12:3',
    'src/app.ts:12-20',
    '"src/app.ts"',
    'File: src/app.ts\n',
    'See src/app.ts.',
    '`src/app.tsx` then `src/app.ts`',
    'src/app.ts, src/other.ts',
    'src/app.ts; src/other.ts',
  ])('preserves a truthful banner for the rendered reference %s', async (reference) => {
    await pend('src/app.ts');
    // Exercise renderer variants through the notice wrapper with the real
    // index and watcher pending set, without mocking the database.
    const result = (handler as any).withStalenessNotice({
      content: [{ type: 'text', text: reference }],
    });
    expect(result.content[0].text.startsWith('⚠️')).toBe(true);
    expect(result.content[0].text).not.toContain('elsewhere in this project');
  });

  it.each(['src/目录.ts', 'src/app@backup.ts', 'src/app+backup.ts'])(
    'still warns for an exact Unicode or punctuation path: %s', async (rel) => {
      fs.writeFileSync(path.join(testDir, rel), 'export function specialView() { return 3; }\n');
      await cg.indexAll();
      await pend(rel);
      const text = (await handler.execute('codegraph_search', { query: 'specialView' })).content[0].text;
      expect(text.startsWith('⚠️')).toBe(true);
      expect(text).toContain(rel);
    },
  );

  it('still names a pending file the response shows', async () => {
    await pend('src/app.tsx');
    const text = (await handler.execute('codegraph_search', { query: 'appView' })).content[0].text;
    expect(text.startsWith('⚠️')).toBe(true);
  });
});
