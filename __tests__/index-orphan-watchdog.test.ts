/**
 * `index` / `init` command supervision regression test (#999, secondary issues).
 *
 * `codegraph index` runs in a child re-exec'd with `--liftoff-only` whose parent
 * blocks in `spawnSync` and so cannot forward a signal — when the parent shim is
 * killed the indexer used to keep running, orphaned, pinning a CPU core. The
 * `#850` liveness watchdog and `#277` ppid watchdog were also wired only into
 * `serve`, never `index`/`init`. `installCommandSupervision` (src/bin/
 * command-supervision.ts) closes both gaps; this proves the orphan half end to
 * end: a process running it self-terminates once its parent dies.
 *
 * Windows is excluded — `process.kill(pid, 'SIGKILL')` doesn't deliver SIGKILL
 * there and the reparenting semantics the ppid watchdog relies on are POSIX-only
 * (same exclusion as mcp-ppid-watchdog.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SUPERVISION = path.resolve(__dirname, '../dist/bin/command-supervision.js');

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!isAlive(pid)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe.skipIf(process.platform === 'win32')('index/init orphan supervision (#999)', () => {
  let wrapper: ChildProcessWithoutNullStreams | null = null;
  let childPid: number | null = null;

  afterEach(() => {
    if (wrapper && !wrapper.killed) {
      try { wrapper.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (childPid !== null && isAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    wrapper = null;
    childPid = null;
  });

  it("self-terminates when its parent is SIGKILL'd mid-index", async () => {
    const stderrLog = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-orphan-')),
      'child.stderr.log',
    );
    // The child stands in for a running indexer: it installs the SAME command
    // supervision `index`/`init` install, then idles on a ref'd timer so it
    // stays alive until the watchdog (not the timer) takes it down.
    // CODEGRAPH_NO_WATCHDOG=1 isolates the ppid (orphan) path from the liveness
    // child; CODEGRAPH_PPID_POLL_MS=200 keeps it responsive in test.
    const childSrc = `
      const { installCommandSupervision } = require(${JSON.stringify(SUPERVISION)});
      installCommandSupervision('index');
      process.stdout.write('UP ' + process.pid + '\\n');
      setInterval(() => {}, 60000);
    `;
    // The wrapper spawns the child detached (so it's reparented to init when the
    // wrapper dies, not killed with it), waits for it to report its pid + install
    // the watchdog, relays the pid, then idles until SIGKILL'd.
    const wrapperSrc = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const errFd = fs.openSync(${JSON.stringify(stderrLog)}, 'a');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSrc)}], {
        stdio: ['ignore', 'pipe', errFd],
        env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '200', CODEGRAPH_WASM_RELAUNCHED: '1' },
        detached: true,
      });
      child.unref();
      child.stdout.on('data', (d) => {
        const m = /UP (\\d+)/.exec(d.toString());
        if (m) process.stdout.write(JSON.stringify({ pid: Number(m[1]) }) + '\\n');
      });
      setInterval(() => {}, 60000);
    `;
    wrapper = spawn(process.execPath, ['-e', wrapperSrc], {
      stdio: ['pipe', 'pipe', 'inherit'],
    }) as ChildProcessWithoutNullStreams;

    const { pid } = await new Promise<{ pid: number }>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('child did not report its pid in time')), 10000);
      wrapper!.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/\{"pid":(\d+)\}/);
        if (m) { clearTimeout(timer); resolve({ pid: parseInt(m[1], 10) }); }
      });
      wrapper!.on('exit', () => { clearTimeout(timer); reject(new Error('wrapper exited before reporting pid')); });
    });
    childPid = pid;
    expect(isAlive(childPid)).toBe(true);

    // SIGKILL the wrapper — no cleanup runs, just like killing the parent shim.
    // The child is reparented to init; only its ppid watchdog can take it down.
    wrapper.kill('SIGKILL');

    const exited = await waitForExit(childPid, 5000);
    const stderr = fs.existsSync(stderrLog) ? fs.readFileSync(stderrLog, 'utf-8') : '<none>';
    expect(
      exited,
      `child (pid=${childPid}) did not self-terminate within 5s after parent SIGKILL.\nstderr:\n${stderr}`,
    ).toBe(true);
    // Confirm it died from the parent-death path, not some other cause.
    expect(stderr).toMatch(/Parent process exited.*aborting/);
  }, 20000);
});
