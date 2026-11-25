/**
 * Idle release of explicit projects keeps each project's own deadline (#2087).
 *
 * The idle timer is armed for the oldest project a trim can release, and a
 * project whose catch-up is still running is skipped. When that catch-up
 * settles after a newer project armed the timer, the older project must be
 * released on its own deadline, not held (with its writer lock) until the
 * newer one's. Fake timers make the ordering exact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolHandler, type ProjectLifecycle } from '../src/mcp/tools';
import CodeGraph from '../src';

const IDLE_MS = 3000;
// Long enough to fail validation after the project gate, so a call opens and
// gates its project without running a query.
const OVERSIZED_PATH = 'x'.repeat(100_000);

describe('idle release order (#2087)', () => {
  let workspace: string;
  const prevIdle = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
  const prevGate = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-idle-order-')));
    // Real (empty) indexes, so the roots resolve; the lifecycle below hands
    // out stand-ins and never opens them.
    for (const name of ['a', 'b']) CodeGraph.initSync(path.join(workspace, name)).close();
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = String(IDLE_MS);
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '10';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevIdle === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = prevIdle;
    if (prevGate === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prevGate;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('releases an older project on its own deadline after its catch-up settles', async () => {
    const released: string[] = [];
    let settleA!: () => void;
    const catchUpA = new Promise<void>((resolve) => { settleA = resolve; });
    const lifecycle: ProjectLifecycle = {
      open: (root) => ({
        getProjectRoot: () => root,
        reopenIfReplaced: () => false,
        close: () => {},
      }) as unknown as CodeGraph,
      activate: (cg) => (path.basename(cg.getProjectRoot()) === 'a' ? catchUpA : Promise.resolve()),
      release: (cg) => { released.push(path.basename(cg.getProjectRoot())); },
    };
    const handler = new ToolHandler(null);
    handler.setProjectLifecycle(lifecycle);
    const call = async (name: string): Promise<void> => {
      const done = handler.execute('codegraph_files', { projectPath: path.join(workspace, name), path: OVERSIZED_PATH });
      await vi.advanceTimersByTimeAsync(10); // the catch-up gate's serve-anyway deadline
      expect((await done).content[0]!.text).toContain('path exceeds maximum length');
    };

    await call('a'); // A used at t=0, its catch-up still running
    await vi.advanceTimersByTimeAsync(1490);
    await call('b'); // B used at t=1500: the timer is armed for B, due at 4500
    await vi.advanceTimersByTimeAsync(990);
    settleA(); // t=2500: A is due at 3000, which the 1 s floor moves to 3500
    await vi.advanceTimersByTimeAsync(1100);
    expect(released).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(released).toEqual(['a', 'b']);
    await handler.closeAll();
  });
});
