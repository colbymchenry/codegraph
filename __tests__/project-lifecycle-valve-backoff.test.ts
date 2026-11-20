/**
 * A catch-up the WAL valve stopped waits before it starts again (#3273).
 *
 * The valve (#1539) stops a sync whose WAL can't be checkpointed past its cap
 * while a reader pins frames, which is what the query pool's tool calls do
 * during a big startup catch-up. The project's 1 s timer and every access then
 * started the catch-up again at once: each retry scanned the project again,
 * stored a file or so and was stopped again, for as long as the session kept
 * calling tools. Now each stop in a row doubles a wait (5 s, 10 s, ... up to
 * 5 min) before the next attempt; a catch-up that finishes clears it, and
 * calls meanwhile are served without waiting for one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { WalValveAbortError } from '../src/db/wal-valve';
import { acquireProject } from '../src/mcp/project-lifecycle';

/** The first wait after a stop (VALVE_RETRY_BASE_MS in project-lifecycle). */
const VALVE_RETRY_BASE_MS = 5_000;

/** The parts of a CodeGraph the lifecycle drives, with a sync that fails as told. */
function fakeGraph(fail: (call: number) => Error | null) {
  let calls = 0;
  const graph = {
    get syncCalls() { return calls; },
    watch: () => false,
    isWatching: () => false,
    isIndexing: () => false,
    hasPendingIndexRecovery: () => false,
    close: () => {},
    sync: async () => {
      calls++;
      const err = fail(calls);
      if (err) throw err;
      return { filesAdded: 0, filesModified: 0, filesRemoved: 0, durationMs: 1 };
    },
  };
  return graph;
}

const valveAbort = () => new WalValveAbortError(
  'WAL checkpoint cannot progress while a reader pins frames (test).',
  { walBytes: 5 << 20, fileCapBytes: 4 << 20, hardBytes: 2 << 20 },
);

describe('catch-up retries after the WAL valve stops it (#3273)', () => {
  let root: string;
  let stderr: string[];

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-valve-backoff-')));
    const cg = await CodeGraph.init(root);
    cg.close();
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('waits 5 s, then 10 s, before trying again, and stops once a catch-up finishes', async () => {
    const graph = fakeGraph((call) => (call <= 2 ? valveAbort() : null));
    const lease = acquireProject(root, () => graph as unknown as CodeGraph, {});
    try {
      await lease.ready();
      expect(graph.syncCalls).toBe(1);

      // The 1 s timer fires four times inside the wait: no new attempt.
      await vi.advanceTimersByTimeAsync(VALVE_RETRY_BASE_MS - 1000);
      expect(graph.syncCalls).toBe(1);
      // A tool call meanwhile doesn't start one or wait for one.
      await lease.ready();
      expect(graph.syncCalls).toBe(1);

      // Past the wait: one attempt, stopped again, and the wait doubles.
      await vi.advanceTimersByTimeAsync(1500);
      expect(graph.syncCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(2 * VALVE_RETRY_BASE_MS - 1500);
      expect(graph.syncCalls).toBe(2);

      // The third attempt finishes the catch-up, and nothing runs after it.
      await vi.advanceTimersByTimeAsync(2000);
      expect(graph.syncCalls).toBe(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(graph.syncCalls).toBe(3);

      // The log says when the next attempt comes.
      const log = stderr.join('');
      expect(log).toContain(`Trying again in ${VALVE_RETRY_BASE_MS / 1000}s`);
      expect(log).toContain(`Trying again in ${(2 * VALVE_RETRY_BASE_MS) / 1000}s`);
    } finally {
      await lease.release();
    }
  });

  it('still retries any other failure on the next tick, as before', async () => {
    const graph = fakeGraph((call) => (call === 1 ? new Error('disk I/O error') : null));
    const lease = acquireProject(root, () => graph as unknown as CodeGraph, {});
    try {
      await lease.ready();
      expect(graph.syncCalls).toBe(1);
      expect(stderr.join('')).not.toContain('Trying again in');
      await vi.advanceTimersByTimeAsync(1100);
      expect(graph.syncCalls).toBe(2);
    } finally {
      await lease.release();
    }
  });
});
