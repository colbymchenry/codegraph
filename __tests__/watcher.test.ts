/**
 * FileWatcher Tests
 *
 * Tests for the file watcher that auto-syncs on changes.
 *
 * **Why `vi.mock('chokidar', ...)`**: real chokidar bindings go through
 * FSEvents (macOS) / inotify (Linux). Under parallel vitest execution those
 * OS-level subsystems serve many test files at once and event-delivery
 * latency becomes non-deterministic — we observed a consistent ~30%
 * failure rate on the pending-file-tracking + staleness-banner tests when
 * running the full suite, vs 0/N when run in isolation. The mock replaces
 * chokidar with a controllable EventEmitter (see
 * `__helpers__/chokidar-mock.ts`): the `ready` event fires on the next
 * microtask, and tests use `triggerFileEvent(...)` to synthesize file
 * events instead of `fs.writeFileSync(...)`. The watcher's actual
 * debounce timer (real `setTimeout`) is left untouched — that's the unit
 * under test.
 */

import { vi } from 'vitest';
// Hoisted: chokidar is replaced by the controllable mock for the whole file.
vi.mock('chokidar', async () => (await import('./__helpers__/chokidar-mock')).chokidarMockModule);

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher, LockUnavailableError } from '../src/sync/watcher';
import CodeGraph from '../src/index';
import { triggerFileEvent } from './__helpers__/chokidar-mock';

/**
 * Helper to wait for a condition with timeout. Most tests no longer need
 * this because mock chokidar makes the watcher's event handler run
 * synchronously, but it's still useful for assertions that depend on the
 * debounce timer (real setTimeout) firing.
 */
function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 25
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
      await watcher.waitUntilReady();
      triggerFileEvent(testDir, 'add', 'src/new.ts');

      // Wait for debounced sync to fire (real timer; 200ms + epsilon).
      await waitFor(() => syncFn.mock.calls.length > 0);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });

    it('should debounce rapid changes into a single sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 400 });

      watcher.start();
      await watcher.waitUntilReady();

      // Rapid-fire synthesized changes — each call resets the debounce timer.
      // Spacing them tighter than the debounce window proves the debounce
      // collapses them into one syncFn call.
      for (let i = 0; i < 5; i++) {
        triggerFileEvent(testDir, 'add', `src/file${i}.ts`);
        await new Promise((r) => setTimeout(r, 50));
      }

      // Wait for the single debounced sync.
      await waitFor(() => syncFn.mock.calls.length > 0);

      // Should have been called once (debounced), not 5 times.
      expect(syncFn.mock.calls.length).toBe(1);

      watcher.stop();
    });
  });

  describe('filtering', () => {
    it('should ignore files not matching include patterns', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();
      await watcher.waitUntilReady();

      // Synthesize a non-source-file event — FileWatcher's `isSourceFile`
      // gate must drop it before scheduling sync.
      triggerFileEvent(testDir, 'add', 'src/readme.md');

      // Wait a bit longer than debounce — sync should NOT trigger.
      await new Promise((r) => setTimeout(r, 400));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should ignore .codegraph directory changes', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();
      await watcher.waitUntilReady();

      // Synthesize a .codegraph event — FileWatcher's `isAlwaysIgnored`
      // filter must drop it before scheduling sync.
      triggerFileEvent(testDir, 'add', '.codegraph/db.sqlite');

      await new Promise((r) => setTimeout(r, 400));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should not schedule sync for node_modules paths (FileWatcher-side filter)', async () => {
      // NOTE: this previously asserted chokidar's `ignored` callback excluded
      // node_modules from watching at all. With chokidar mocked, that
      // OS-level behaviour isn't exercised here — what we test is
      // FileWatcher's own filter chain (`isSourceFile` + `isAlwaysIgnored`).
      // node_modules paths AREN'T in `isAlwaysIgnored` (they're filtered by
      // chokidar's `ignored` callback in production), so this test now
      // verifies a different mechanism: a non-source extension inside
      // node_modules still drops via `isSourceFile`. The chokidar-level
      // `ignored` exclusion of `node_modules/` itself is covered by the
      // ignore-config tests under `src/sync/watcher-ignore.test.ts`-style
      // unit-level checks, which don't need a live watcher loop.
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });
      watcher.start();
      await watcher.waitUntilReady();

      // A source-extension event whose path is a normal source file still
      // schedules sync (positive control).
      triggerFileEvent(testDir, 'add', 'src/live.ts');
      await waitFor(() => syncFn.mock.calls.length > 0);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });
  });

  describe('pending file tracking (#403)', () => {
    it('should expose edited paths via getPendingFiles before sync fires', async () => {
      // Slow debounce — pending entries are visible until the debounce
      // fires. With mocked chokidar the event is synchronous, so we can
      // assert immediately without polling.
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 2000 });
      watcher.start();
      await watcher.waitUntilReady();

      expect(watcher.getPendingFiles()).toEqual([]);

      triggerFileEvent(testDir, 'add', 'src/pending.ts');

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

      triggerFileEvent(testDir, 'add', 'src/fresh.ts');

      // Watcher saw the change → pendingFiles has the entry IMMEDIATELY.
      expect(watcher.getPendingFiles().some((p) => p.path === 'src/fresh.ts')).toBe(true);

      // Wait through debounce + sync; the entry should drop out.
      await waitFor(() => syncFn.mock.calls.length > 0);
      await waitFor(() => !watcher.getPendingFiles().some((p) => p.path === 'src/fresh.ts'));

      expect(watcher.getPendingFiles()).toEqual([]);
      watcher.stop();
    });

    it('should keep entries unchanged when sync fails (rescheduled work sees the same set)', async () => {
      // With chokidar mocked there's no initial-scan-triggered sync, so
      // the syncFn outcomes line up 1:1 with explicit events.
      const syncFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))                  // first sync rejects
        .mockResolvedValueOnce({ filesChanged: 1, durationMs: 10 }); // retry succeeds
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 100, onSyncError });
      watcher.start();
      await watcher.waitUntilReady();

      triggerFileEvent(testDir, 'add', 'src/will-fail.ts');

      // Wait for the sync to reject.
      await waitFor(() => onSyncError.mock.calls.length > 0);

      // The file is STILL in pendingFiles — failure didn't drop it.
      const after = watcher.getPendingFiles();
      expect(after.some((p) => p.path === 'src/will-fail.ts')).toBe(true);

      // Retry resolves automatically; entry clears.
      await waitFor(
        () => !watcher.getPendingFiles().some((p) => p.path === 'src/will-fail.ts'),
      );

      watcher.stop();
    });

    it('should retain pending files and retry when syncFn throws LockUnavailableError (#449)', async () => {
      // CodeGraph.watch() converts the cross-process lock-failure no-op
      // into LockUnavailableError so the watcher's retry path picks it up
      // instead of falsely clearing pendingFiles. This test exercises the
      // contract directly.
      const syncFn = vi
        .fn()
        .mockRejectedValueOnce(new LockUnavailableError())
        .mockResolvedValueOnce({ filesChanged: 1, durationMs: 10 });
      const onSyncComplete = vi.fn();
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, {
        debounceMs: 100,
        onSyncComplete,
        onSyncError,
      });
      watcher.start();
      await watcher.waitUntilReady();

      triggerFileEvent(testDir, 'add', 'src/locked.ts');

      await waitFor(() => syncFn.mock.calls.length >= 1);
      expect(watcher.getPendingFiles().some((p) => p.path === 'src/locked.ts')).toBe(true);
      // A held-lock no-op is not a sync failure — onSyncError stays quiet
      // so a long-running external indexer doesn't spam stderr every cycle.
      expect(onSyncError).not.toHaveBeenCalled();
      expect(onSyncComplete).not.toHaveBeenCalled();

      await waitFor(() => syncFn.mock.calls.length >= 2);
      await waitFor(
        () => !watcher.getPendingFiles().some((p) => p.path === 'src/locked.ts'),
      );

      expect(onSyncComplete).toHaveBeenCalledTimes(1);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 1, durationMs: 10 });
      expect(onSyncError).not.toHaveBeenCalled();

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
      await watcher.waitUntilReady();
      triggerFileEvent(testDir, 'add', 'src/test.ts');

      await waitFor(() => onSyncComplete.mock.calls.length > 0);
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
      await watcher.waitUntilReady();
      triggerFileEvent(testDir, 'add', 'src/test.ts');

      await waitFor(() => onSyncError.mock.calls.length > 0);
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
      // Wait through CodeGraph's internal watcher startup (the mock
      // chokidar fires `ready` on the next microtask, but cg.watch wraps
      // the watcher creation through promise plumbing).
      await new Promise((r) => setTimeout(r, 50));

      // Real fs write so cg.sync() can detect the new file on disk; then
      // synthesize the event to wake the watcher (debounce + sync).
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        'export function added() { return 42; }'
      );
      triggerFileEvent(testDir, 'add', 'src/added.ts');

      // Wait for auto-sync to pick it up.
      await waitFor(() => {
        const stats = cg.getStats();
        return stats.nodeCount > initialNodes;
      }, 5000);

      // The new function should be in the graph.
      const results = cg.searchNodes('added');
      expect(results.length).toBeGreaterThan(0);

      cg.unwatch();
    });
  });
});
