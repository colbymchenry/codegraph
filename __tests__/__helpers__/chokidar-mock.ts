/**
 * Deterministic chokidar mock for FileWatcher tests.
 *
 * The real chokidar binding goes through FSEvents (macOS) / inotify (Linux) /
 * ReadDirectoryChangesW (Windows). Under parallel vitest execution, those
 * OS-level subsystems serve multiple test files simultaneously and event
 * delivery latency grows non-deterministically — `should expose edited paths
 * via getPendingFiles before sync fires` and the `mcp-staleness-banner` tests
 * have observably raced for that reason (consistent ~30% failure rate when
 * running the full suite, 0/N when run in isolation).
 *
 * This mock replaces chokidar with a controllable in-process EventEmitter:
 *
 *   - `chokidar.watch(root, opts)` returns an instance keyed by `root`.
 *   - The instance fires `ready` on the next microtask, matching the
 *     real chokidar shape (tests' `waitUntilReady()` resolves promptly).
 *   - Tests synthesize file events via `triggerFileEvent(root, 'add', rel)`
 *     instead of `fs.writeFileSync(...)` — no OS-level watcher in the loop,
 *     no waitFor polling against unpredictable delivery latency.
 *   - The actual debounce timer in FileWatcher is left untouched (real
 *     setTimeout). That's the unit under test; deterministic timing
 *     would change what the test asserts.
 *
 * Install with `vi.mock('chokidar', () => chokidarMockModule)` at the
 * top of each test file (must be hoisted, hence the static export).
 *
 * All instances live in module scope — clear them in `afterEach` if a
 * test creates watchers and needs hard isolation, but in practice the
 * `close()` plumbing handles it.
 */
import { EventEmitter } from 'node:events';

/** One mock watcher per `chokidar.watch(root, ...)` call. */
class MockChokidarWatcher extends EventEmitter {
  private closed = false;
  private readyFired = false;

  constructor(public readonly root: string) {
    super();
    // Mirror chokidar: `ready` fires asynchronously after the initial scan.
    // We use queueMicrotask so it's deterministic and as fast as possible —
    // tests' `await watcher.waitUntilReady()` resolves immediately.
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyFired = true;
      this.emit('ready');
    });
  }

  /** chokidar.FSWatcher#close shape. */
  close(): Promise<void> {
    this.closed = true;
    this.removeAllListeners();
    instancesByRoot.delete(this.root);
    return Promise.resolve();
  }

  /** Test-only helper to synthesize a file event. */
  triggerEvent(event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir', absPath: string): void {
    if (this.closed) return;
    // Real chokidar emits both the typed event AND the catch-all 'all'.
    // FileWatcher only listens on 'all'.
    this.emit('all', event, absPath);
  }

  /** True once the initial-scan `ready` event has been emitted. */
  isReady(): boolean {
    return this.readyFired;
  }
}

const instancesByRoot = new Map<string, MockChokidarWatcher>();

/**
 * The mock module — pass this to `vi.mock('chokidar', () => chokidarMockModule)`.
 * The factory must NOT close over outer-scope state because vi.mock hoists.
 */
export const chokidarMockModule = {
  default: {
    watch: (root: string, _opts?: unknown) => {
      const inst = new MockChokidarWatcher(root);
      instancesByRoot.set(root, inst);
      return inst;
    },
  },
};

/**
 * Test-side helper: synthesize a chokidar event on the watcher created for
 * `root`. Use after the watcher's `waitUntilReady()` has resolved, since
 * FileWatcher only adds events to its pending set when `chokidarReady` is
 * true.
 *
 * `relPath` is path.join'd with `root` before emission, matching how
 * chokidar delivers absolute paths to the `all` handler.
 */
export function triggerFileEvent(
  root: string,
  event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
  relPath: string,
): void {
  const inst = instancesByRoot.get(root);
  if (!inst) {
    throw new Error(
      `triggerFileEvent: no mock chokidar watcher registered for root '${root}' — did chokidar.watch() get called?`,
    );
  }
  // FileWatcher uses path.relative(root, eventPath) to compute the
  // normalized path it stores. We supply the absolute path here so that
  // operation produces the relPath the test wrote.
  const absPath = require('node:path').join(root, relPath);
  inst.triggerEvent(event, absPath);
}

/** Reset all in-memory mock watchers — call in afterEach when needed. */
export function resetChokidarMock(): void {
  for (const inst of instancesByRoot.values()) {
    inst.removeAllListeners();
  }
  instancesByRoot.clear();
}
