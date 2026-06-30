/**
 * FileWatcher Tests
 *
 * Tests for the file watcher that auto-syncs on changes.
 *
 * **Why inert mode + a synthetic event seam**: the watcher now uses Node's
 * native `fs.watch` (recursive on macOS/Windows, per-directory on Linux).
 * Under parallel vitest the OS watch subsystems (FSEvents / inotify) serve
 * many test files at once and event-delivery latency becomes non-deterministic
 * — a real fs change made in `beforeEach` can even leak into a later "should
 * NOT sync" assertion. So the unit tests construct the watcher with
 * `inertForTests: true` (no OS watcher installed) and drive its filter →
 * pendingFiles → debounce pipeline directly via
 * `__emitWatchEventForTests(root, relPath)` — deterministic, the same
 * convergence point a real event reaches. The debounce timer itself is the
 * real `setTimeout` (the unit under test). One end-to-end test ("auto-sync …
 * real fs.watch") runs the genuine native watcher against a real file write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  FileWatcher,
  LockUnavailableError,
  __emitWatchEventForTests,
  __setFsWatchForTests,
  type WatchOptions,
} from '../src/sync/watcher';
import CodeGraph from '../src/index';

type SyncFn = () => Promise<{ filesChanged: number; durationMs: number }>;

/**
 * Helper to wait for a condition with timeout. Used for assertions that depend
 * on the debounce timer (real setTimeout) firing, or on the real watcher's
 * event delivery in the end-to-end test.
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

  // Inert by default — unit tests drive events via __emitWatchEventForTests
  // and never depend on real OS watch delivery.
  const newWatcher = (syncFn: SyncFn, opts: WatchOptions = {}) =>
    new FileWatcher(testDir, syncFn, { inertForTests: true, ...opts });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-'));
    // Create a source file so the directory isn't empty
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
  });

  afterEach(() => {
    __setFsWatchForTests(null); // reset the injected fs.watch seam
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = newWatcher(syncFn);

      const started = watcher.start();
      expect(started).toBe(true);
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });

    it('should be idempotent on double start', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = newWatcher(syncFn);

      expect(watcher.start()).toBe(true);
      expect(watcher.start()).toBe(true); // Should not throw
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
    });

    it('should be idempotent on double stop', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = newWatcher(syncFn);

      watcher.start();
      watcher.stop();
      watcher.stop(); // Should not throw

      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('watch-resource exhaustion (#876)', () => {
    // These exercise the REAL fs.watch path (not inert) with an injected watch
    // that throws / emits EMFILE, covering whichever strategy the host platform
    // uses — recursive on macOS/Windows, per-directory on Linux. Each uses its
    // OWN EMPTY temp dir so exactly one watch is installed and the close-count
    // is deterministic across platforms.
    const mkEmptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exhaust-'));

    it('fails to start and degrades when fs.watch setup exhausts watch resources', () => {
      const dir = mkEmptyDir();
      const onDegraded = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      __setFsWatchForTests(() => {
        const err = new Error('too many open files') as NodeJS.ErrnoException;
        err.code = 'EMFILE';
        throw err;
      });
      const watcher = new FileWatcher(
        dir,
        vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 }),
        { debounceMs: 100, onDegraded }
      );

      try {
        // Both watch strategies must report startup exhaustion identically.
        expect(watcher.start()).toBe(false);
        expect(watcher.isActive()).toBe(false);
        expect(watcher.isDegraded()).toBe(true);
        expect(watcher.getDegradedReason()).toContain('auto-sync disabled');
        expect(onDegraded).toHaveBeenCalledTimes(1);
        expect(onDegraded).toHaveBeenCalledWith(expect.stringContaining('auto-sync disabled'));
        const disableWarnings = warnSpy.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('File watcher disabled')
        );
        expect(disableWarnings).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('degrades exactly once when the live watcher emits EMFILE at runtime', () => {
      const dir = mkEmptyDir();
      const onDegraded = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const emitter = new EventEmitter();
      let closed = 0;
      const fakeWatcher = {
        on: (event: string, handler: (...a: unknown[]) => void) => {
          emitter.on(event, handler);
          return fakeWatcher;
        },
        close: () => {
          closed += 1;
        },
      } as unknown as fs.FSWatcher;
      __setFsWatchForTests(() => fakeWatcher);
      const watcher = new FileWatcher(
        dir,
        vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 }),
        { debounceMs: 100, onDegraded }
      );

      try {
        expect(watcher.start()).toBe(true);
        expect(watcher.isActive()).toBe(true);

        const err = new Error('too many open files') as NodeJS.ErrnoException;
        err.code = 'EMFILE';
        emitter.emit('error', err);
        emitter.emit('error', err); // a second burst must NOT degrade / close again

        expect(watcher.isActive()).toBe(false);
        expect(watcher.isDegraded()).toBe(true);
        expect(onDegraded).toHaveBeenCalledTimes(1);
        expect(closed).toBe(1);
        const disableWarnings = warnSpy.mock.calls.filter(
          (c) => typeof c[0] === 'string' && c[0].includes('File watcher disabled')
        );
        expect(disableWarnings).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports isDegraded false / null reason while healthy', () => {
      const watcher = newWatcher(vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 }));
      watcher.start();
      expect(watcher.isDegraded()).toBe(false);
      expect(watcher.getDegradedReason()).toBeNull();
      watcher.stop();
    });

    it('warns once (NOT degrade) when Linux inotify watches are exhausted (ENOSPC)', () => {
      // ENOSPC only arises on the Linux per-directory path; force it so the test
      // runs the per-directory branch on any host. Synchronous test, restored in
      // finally — no await window for another test to observe the override.
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try {
        // Empty-but-for-one-subdir temp dir: the root watch succeeds, then the
        // child watch hits the (simulated) inotify budget — the realistic
        // "partial watch installed, then exhausted" shape.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-inotify-'));
        fs.mkdirSync(path.join(dir, 'sub'));
        const onDegraded = vi.fn();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const emitter = new EventEmitter();
        let calls = 0;
        const okWatcher = {
          on: (event: string, handler: (...a: unknown[]) => void) => {
            emitter.on(event, handler);
            return okWatcher;
          },
          close: () => {},
        } as unknown as fs.FSWatcher;
        __setFsWatchForTests(() => {
          calls += 1;
          if (calls === 1) return okWatcher; // root dir watch succeeds
          const err = new Error('ENOSPC: System limit for number of file watchers reached') as NodeJS.ErrnoException;
          err.code = 'ENOSPC';
          throw err; // every subsequent dir exhausts the inotify budget
        });
        const watcher = new FileWatcher(
          dir,
          vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 }),
          { debounceMs: 100, onDegraded }
        );

        try {
          // NON-fatal: the watcher starts (partial watch on the root), does NOT
          // degrade, and warns exactly once with the actionable sysctl remedy.
          expect(watcher.start()).toBe(true);
          expect(watcher.isActive()).toBe(true);
          expect(watcher.isDegraded()).toBe(false);
          expect(onDegraded).not.toHaveBeenCalled();
          const inotifyWarnings = warnSpy.mock.calls.filter(
            (c) => typeof c[0] === 'string' && c[0].includes('inotify watch limit')
          );
          expect(inotifyWarnings).toHaveLength(1);
          expect(String(inotifyWarnings[0]![0])).toContain('fs.inotify.max_user_watches');
        } finally {
          watcher.stop();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    });
  });

  describe('lock contention degradation (#876)', () => {
    it('disables auto-sync after prolonged lock contention, with bounded retries', async () => {
      const syncFn = vi.fn().mockRejectedValue(new LockUnavailableError());
      const onSyncComplete = vi.fn();
      const onSyncError = vi.fn();
      const onDegraded = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const watcher = newWatcher(syncFn, {
        debounceMs: 25,
        onSyncComplete,
        onSyncError,
        onDegraded,
      });
      watcher.start();
      await watcher.waitUntilReady();
      __emitWatchEventForTests(testDir, 'src/long-lock.ts');

      // 5 backoff retries (25·1,2,4,8,16 ms), then degrade on the 6th attempt.
      await waitFor(() => !watcher.isActive(), 8000, 20);

      expect(syncFn.mock.calls.length).toBeGreaterThanOrEqual(6); // MAX_LOCK_RETRIES + 1
      expect(watcher.isDegraded()).toBe(true);
      expect(onDegraded).toHaveBeenCalledTimes(1);
      expect(onDegraded).toHaveBeenCalledWith(expect.stringContaining('auto-sync disabled'));
      // A held lock is neither a sync error nor a completion.
      expect(onSyncError).not.toHaveBeenCalled();
      expect(onSyncComplete).not.toHaveBeenCalled();
      // Degrade stops the watcher, which clears pending state.
      expect(watcher.getPendingFiles()).toEqual([]);
      const disableWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('File watcher disabled')
      );
      expect(disableWarnings).toHaveLength(1);
    });

    it('does NOT degrade on brief contention — backoff resets after a clean sync', async () => {
      const syncFn = vi
        .fn()
        .mockRejectedValueOnce(new LockUnavailableError())
        .mockRejectedValueOnce(new LockUnavailableError())
        .mockRejectedValueOnce(new LockUnavailableError())
        .mockResolvedValue({ filesChanged: 1, durationMs: 5 });
      const onDegraded = vi.fn();
      const onSyncComplete = vi.fn();
      const watcher = newWatcher(syncFn, { debounceMs: 25, onDegraded, onSyncComplete });
      watcher.start();
      await watcher.waitUntilReady();
      __emitWatchEventForTests(testDir, 'src/brief-lock.ts');

      await waitFor(() => onSyncComplete.mock.calls.length > 0, 4000, 20);

      expect(onDegraded).not.toHaveBeenCalled();
      expect(watcher.isDegraded()).toBe(false);
      expect(watcher.isActive()).toBe(true);
      expect(watcher.getPendingFiles().some((p) => p.path === 'src/brief-lock.ts')).toBe(false);

      watcher.stop();
    });
  });

  describe('debounced sync', () => {
    it('should trigger sync after file change', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = newWatcher(syncFn, { debounceMs: 200 });

      watcher.start();
      await watcher.waitUntilReady();
      __emitWatchEventForTests(testDir, 'src/new.ts');

      // Wait for debounced sync to fire (real timer; 200ms + epsilon).
      await waitFor(() => syncFn.mock.calls.length > 0);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });

    it('should debounce rapid changes into a single sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = newWatcher(syncFn, { debounceMs: 400 });

      watcher.start();
      await watcher.waitUntilReady();

      // Rapid-fire synthesized changes — each call resets the debounce timer.
      // Spacing them tighter than the debounce window proves the debounce
      // collapses them into one syncFn call.
      for (let i = 0; i < 5; i++) {
        __emitWatchEventForTests(testDir, `src/file${i}.ts`);
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
      const watcher = newWatcher(syncFn, { debounceMs: 200 });

      watcher.start();
      await watcher.waitUntilReady();

      // A non-source-file event — FileWatcher's `isSourceFile` gate must drop
      // it before scheduling sync.
      __emitWatchEventForTests(testDir, 'src/readme.md');

      // Wait a bit longer than debounce — sync should NOT trigger.
      await new Promise((r) => setTimeout(r, 400));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should ignore .codegraph directory changes', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = newWatcher(syncFn, { debounceMs: 200 });

      watcher.start();
      await watcher.waitUntilReady();

      // A .codegraph event — FileWatcher's `isAlwaysIgnored` filter must drop
      // it before scheduling sync.
      __emitWatchEventForTests(testDir, '.codegraph/db.sqlite');

      await new Promise((r) => setTimeout(r, 400));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should drop ignored/non-source paths but sync real source edits', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = newWatcher(syncFn, { debounceMs: 200 });
      watcher.start();
      await watcher.waitUntilReady();

      // node_modules is in the default-ignore set (#407) → dropped by the
      // ignore matcher even without a .gitignore.
      __emitWatchEventForTests(testDir, 'node_modules/dep/index.js');
      // A normal source file still schedules sync (positive control).
      __emitWatchEventForTests(testDir, 'src/live.ts');
      await waitFor(() => syncFn.mock.calls.length > 0);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });
  });

  describe('pending file tracking (#403)', () => {
    it('should expose edited paths via getPendingFiles before sync fires', async () => {
      // Slow debounce — pending entries are visible until the debounce fires.
      // The synthetic event is synchronous, so we can assert immediately.
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = newWatcher(syncFn, { debounceMs: 2000 });
      watcher.start();
      await watcher.waitUntilReady();

      expect(watcher.getPendingFiles()).toEqual([]);

      __emitWatchEventForTests(testDir, 'src/pending.ts');

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
      const watcher = newWatcher(syncFn, { debounceMs: 200 });
      watcher.start();
      await watcher.waitUntilReady();

      __emitWatchEventForTests(testDir, 'src/fresh.ts');

      // Watcher saw the change → pendingFiles has the entry IMMEDIATELY.
      expect(watcher.getPendingFiles().some((p) => p.path === 'src/fresh.ts')).toBe(true);

      // Wait through debounce + sync; the entry should drop out.
      await waitFor(() => syncFn.mock.calls.length > 0);
      await waitFor(() => !watcher.getPendingFiles().some((p) => p.path === 'src/fresh.ts'));

      expect(watcher.getPendingFiles()).toEqual([]);
      watcher.stop();
    });

    it('should keep entries unchanged when sync fails (rescheduled work sees the same set)', async () => {
      // No initial-scan-triggered sync, so syncFn outcomes line up 1:1 with
      // explicit events.
      const syncFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))                  // first sync rejects
        .mockResolvedValueOnce({ filesChanged: 1, durationMs: 10 }); // retry succeeds
      const onSyncError = vi.fn();
      const watcher = newWatcher(syncFn, { debounceMs: 100, onSyncError });
      watcher.start();
      await watcher.waitUntilReady();

      __emitWatchEventForTests(testDir, 'src/will-fail.ts');

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
      const watcher = newWatcher(syncFn, {
        debounceMs: 100,
        onSyncComplete,
        onSyncError,
      });
      watcher.start();
      await watcher.waitUntilReady();

      __emitWatchEventForTests(testDir, 'src/locked.ts');

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
      const watcher = newWatcher(syncFn, {
        debounceMs: 200,
        onSyncComplete,
      });

      watcher.start();
      await watcher.waitUntilReady();
      __emitWatchEventForTests(testDir, 'src/test.ts');

      await waitFor(() => onSyncComplete.mock.calls.length > 0);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 2, durationMs: 50 });

      watcher.stop();
    });

    it('should call onSyncError when sync throws', async () => {
      const syncFn = vi.fn().mockRejectedValue(new Error('sync failed'));
      const onSyncError = vi.fn();
      const watcher = newWatcher(syncFn, {
        debounceMs: 200,
        onSyncError,
      });

      watcher.start();
      await watcher.waitUntilReady();
      __emitWatchEventForTests(testDir, 'src/test.ts');

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

      const started = cg.watch({ debounceMs: 200, inertForTests: true });
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

      cg.watch({ debounceMs: 200, inertForTests: true });
      expect(cg.isWatching()).toBe(true);

      cg.close();
      // After close, isWatching should be false
      // (we can't call isWatching after close since DB is closed,
      //  but we verify no errors are thrown)
    });

    it('should auto-sync when files change while watching (real fs.watch end-to-end)', async () => {
      // The one test that exercises the genuine native watcher: a real file
      // write must propagate through fs.watch → debounce → sync into the graph.
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const initialStats = cg.getStats();
      const initialNodes = initialStats.nodeCount;

      cg.watch({ debounceMs: 300 });
      // Let the watcher install before writing, so the event isn't missed.
      await new Promise((r) => setTimeout(r, 100));

      // Real fs write — no synthetic event. The live watcher must catch it.
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        'export function added() { return 42; }'
      );

      // Wait for auto-sync to pick it up (real OS event delivery + debounce).
      await waitFor(() => {
        const stats = cg.getStats();
        return stats.nodeCount > initialNodes;
      }, 8000);

      // The new function should be in the graph.
      const results = cg.searchNodes('added');
      expect(results.length).toBeGreaterThan(0);

      cg.unwatch();
    });
  });
});
