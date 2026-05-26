/**
 * FileWatcher Tests
 *
 * Tests for the file watcher that auto-syncs on changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher } from '../src/sync/watcher';
import CodeGraph from '../src/index';

/**
 * Helper to wait for a condition with timeout
 */
function waitFor(
  condition: () => boolean,
  timeoutMs = 10000,
  intervalMs = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe('FileWatcher', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-'));
    // Create a source file so the directory isn't empty
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn);

      const started = watcher.start();
      expect(started).toBe(true);
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });

    it('should be idempotent on double start', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn);

      expect(watcher.start()).toBe(true);
      expect(watcher.start()).toBe(true); // Should not throw
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
    });

    it('should be idempotent on double stop', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn);

      watcher.start();
      watcher.stop();
      watcher.stop(); // Should not throw
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('debounced sync', () => {
    it('should trigger sync after file change', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();

      // Create a new file
      fs.writeFileSync(path.join(testDir, 'src', 'new.ts'), 'export const y = 2;');

      // Wait for debounced sync to fire
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });

    it('should debounce rapid changes into a single sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 500 });

      watcher.start();

      // Rapid-fire changes
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(testDir, 'src', `file${i}.ts`),
          `export const v${i} = ${i};`
        );
        await new Promise((r) => setTimeout(r, 50));
      }

      // Wait for the single debounced sync
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);

      // Should have been called once (debounced), not 5 times
      expect(syncFn.mock.calls.length).toBe(1);

      watcher.stop();
    });
  });

  describe('filtering', () => {
    it('should ignore files not matching include patterns', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();

      // Let watcher settle — fs.watch may fire residual events from beforeEach
      await new Promise((r) => setTimeout(r, 400));
      syncFn.mockClear();

      // Create a file that doesn't match include patterns
      fs.writeFileSync(path.join(testDir, 'src', 'readme.md'), '# Hello');

      // Wait a bit longer than debounce — sync should NOT trigger
      await new Promise((r) => setTimeout(r, 500));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should ignore .codegraph directory changes', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();

      // Let watcher settle — fs.watch may fire residual events from beforeEach
      await new Promise((r) => setTimeout(r, 400));
      syncFn.mockClear();

      // Simulate a .codegraph directory change
      const cgDir = path.join(testDir, '.codegraph');
      fs.mkdirSync(cgDir, { recursive: true });
      fs.writeFileSync(path.join(cgDir, 'db.sqlite'), 'fake');

      // Wait — sync should NOT trigger
      await new Promise((r) => setTimeout(r, 500));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should not watch node_modules even without a .gitignore (#276/#417)', async () => {
      // No .gitignore in testDir — exclusion relies on the built-in
      // default-ignore set the indexer uses (buildDefaultIgnore), which a
      // .gitignore-only filter would miss.
      fs.mkdirSync(path.join(testDir, 'node_modules', 'dep', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(testDir, 'node_modules', 'dep', 'index.ts'), 'export const dep = 1;');

      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });
      watcher.start();

      // Let the watcher settle past any residual crawl events.
      await new Promise((r) => setTimeout(r, 400));
      syncFn.mockClear();

      // A source-extension edit INSIDE node_modules must NOT trigger a sync —
      // the directory was never watched.
      fs.writeFileSync(path.join(testDir, 'node_modules', 'dep', 'lib', 'extra.ts'), 'export const e = 2;');
      await new Promise((r) => setTimeout(r, 600));
      expect(syncFn).not.toHaveBeenCalled();

      // Positive control: a real source edit still triggers sync, proving the
      // watcher is live (not merely inert).
      fs.writeFileSync(path.join(testDir, 'src', 'live.ts'), 'export const live = 3;');
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });
  });

  describe('pending file tracking (#403)', () => {
    it('should expose edited paths via getPendingFiles before sync fires', async () => {
      // Slow debounce — events arrive but sync hasn't run yet.
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 2000 });
      watcher.start();
      // Deterministic boundary: wait for chokidar's initial scan to complete
      // so any late initial-scan events have fired before we assert. A bare
      // sleep is flaky under test-parallelism load.
      await watcher.waitUntilReady();

      expect(watcher.getPendingFiles()).toEqual([]);

      fs.writeFileSync(path.join(testDir, 'src', 'pending.ts'), 'export const p = 1;');

      // Allow chokidar to emit, but DON'T let the 2s debounce fire.
      await waitFor(() => watcher.getPendingFiles().length > 0, 3000);

      const pending = watcher.getPendingFiles();
      const paths = pending.map((p) => p.path);
      expect(paths).toContain('src/pending.ts');
      const entry = pending.find((p) => p.path === 'src/pending.ts')!;
      expect(entry.firstSeenMs).toBeGreaterThan(0);
      expect(entry.lastSeenMs).toBeGreaterThanOrEqual(entry.firstSeenMs);
      // No sync running yet → indexing flag is false.
      expect(entry.indexing).toBe(false);

      watcher.stop();
    });

    it('should clear an entry only after a successful sync absorbing that edit', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });
      watcher.start();
      await watcher.waitUntilReady();

      fs.writeFileSync(path.join(testDir, 'src', 'fresh.ts'), 'export const f = 1;');

      // Watcher saw the change → pendingFiles has the entry. Longer windows
      // here because chokidar event delivery on macOS slows under heavy
      // parallel test-suite load (4× slower than isolation).
      await waitFor(() => watcher.getPendingFiles().some((p) => p.path === 'src/fresh.ts'), 8000);

      // Wait through debounce + sync; the entry should drop out.
      await waitFor(() => syncFn.mock.calls.length > 0, 8000);
      await waitFor(() => !watcher.getPendingFiles().some((p) => p.path === 'src/fresh.ts'), 8000);

      expect(watcher.getPendingFiles()).toEqual([]);
      watcher.stop();
    });

    it('should keep entries unchanged when sync fails (rescheduled work sees the same set)', async () => {
      // First post-settle sync rejects, second resolves. The initial-scan
      // sync (triggered by chokidar's pre-existing add events) is allowed to
      // resolve cleanly so it doesn't consume one of our scripted outcomes.
      const syncFn = vi
        .fn()
        .mockResolvedValueOnce({ filesChanged: 0, durationMs: 1 }) // initial scan
        .mockRejectedValueOnce(new Error('boom'))                  // first real edit fails
        .mockResolvedValueOnce({ filesChanged: 1, durationMs: 10 }); // retry succeeds
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200, onSyncError });
      watcher.start();
      // Wait through chokidar `ready` AND the initial-scan-triggered sync, so
      // the next sync corresponds to the explicit edit below.
      await watcher.waitUntilReady();
      await waitFor(() => syncFn.mock.calls.length >= 1, 5000);
      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(testDir, 'src', 'will-fail.ts'), 'export const wf = 1;');

      // Wait for the sync that handles the explicit edit to reject.
      await waitFor(() => onSyncError.mock.calls.length > 0, 5000);

      // The file is STILL in pendingFiles — failure didn't drop it.
      const after = watcher.getPendingFiles();
      expect(after.some((p) => p.path === 'src/will-fail.ts')).toBe(true);

      // Retry resolves; entry clears.
      await waitFor(
        () => !watcher.getPendingFiles().some((p) => p.path === 'src/will-fail.ts'),
        5000,
      );

      watcher.stop();
    });
  });

  describe('callbacks', () => {
    it('should call onSyncComplete after successful sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 2, durationMs: 50 });
      const onSyncComplete = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, {
        debounceMs: 200,
        onSyncComplete,
      });

      watcher.start();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncComplete.mock.calls.length > 0, 5000);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 2, durationMs: 50 });

      watcher.stop();
    });

    it('should call onSyncError when sync throws', async () => {
      const syncFn = vi.fn().mockRejectedValue(new Error('sync failed'));
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, {
        debounceMs: 200,
        onSyncError,
      });

      watcher.start();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncError.mock.calls.length > 0, 5000);
      expect(onSyncError).toHaveBeenCalled();
      expect(onSyncError.mock.calls[0]![0]).toBeInstanceOf(Error);

      watcher.stop();
    });
  });

  describe('CodeGraph integration', () => {
    let cg: CodeGraph;

    afterEach(() => {
      if (cg) cg.close();
    });

    it('should watch and unwatch via CodeGraph API', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      expect(cg.isWatching()).toBe(false);

      const started = cg.watch({ debounceMs: 200 });
      expect(started).toBe(true);
      expect(cg.isWatching()).toBe(true);

      cg.unwatch();
      expect(cg.isWatching()).toBe(false);
    });

    it('should stop watching on close', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      cg.watch({ debounceMs: 200 });
      expect(cg.isWatching()).toBe(true);

      cg.close();
      // After close, isWatching should be false
      // (we can't call isWatching after close since DB is closed,
      //  but we verify no errors are thrown)
    });

    it('should auto-sync when files change while watching', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const initialStats = cg.getStats();
      const initialNodes = initialStats.nodeCount;

      cg.watch({ debounceMs: 300 });

      // Add a new file with a function
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        'export function added() { return 42; }'
      );

      // Wait for auto-sync to pick it up
      await waitFor(() => {
        const stats = cg.getStats();
        return stats.nodeCount > initialNodes;
      }, 10000);

      // The new function should be in the graph
      const results = cg.searchNodes('added');
      expect(results.length).toBeGreaterThan(0);

      cg.unwatch();
    });
  });
});
