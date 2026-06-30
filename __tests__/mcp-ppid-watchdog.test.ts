/**
 * PPID watchdog regression test (#277).
 *
 * On Linux, when an MCP host (Claude Code, opencode, …) is SIGKILL'd by the
 * OOM killer / a force-quit / a container teardown, the kernel does NOT
 * propagate the death to its `codegraph serve --mcp` child. The child gets
 * reparented to init/systemd, its stdin stays half-open in some
 * configurations, and the existing `stdin.on('end' | 'close')` handlers
 * never fire — the server lingers indefinitely, holding inotify watches,
 * file descriptors, and the SQLite WAL.
 *
 * `src/mcp/index.ts` polls `process.ppid` and shuts down the moment it
 * diverges from the value observed at startup. This test stands up a
 * four-tier process tree (vitest → wrapper → {stdin-holder, codegraph}) and
 * SIGKILL's the wrapper. The stdin-holder is a long-lived sibling whose
 * `stdout` pipe is dup'd into codegraph's `stdin`. After the wrapper dies
 * the pipe stays open (stdin-holder still owns the write-end), so the
 * existing stdin close handlers do **not** fire — the only thing that can
 * terminate codegraph then is the PPID watchdog.
 *
 * Windows is excluded — `process.kill(pid, 'SIGKILL')` does not actually
 * deliver SIGKILL there, and the per-OS reparenting semantics the watchdog
 * relies on are POSIX-specific.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

describe.skipIf(process.platform === 'win32')('MCP PPID watchdog (#277)', () => {
  let wrapper: ChildProcessWithoutNullStreams | null = null;
  let childPid: number | null = null;
  let stdinHolderPid: number | null = null;

  afterEach(() => {
    if (wrapper && !wrapper.killed) {
      try { wrapper.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // Belt and suspenders — don't leak processes if an assertion failed.
    for (const pid of [childPid, stdinHolderPid]) {
      if (pid !== null && isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    wrapper = null;
    childPid = null;
    stdinHolderPid = null;
  });

  it("shuts down when its parent is SIGKILL'd and stdin stays open", async () => {
    // The wrapper:
    //   1. Spawns a "stdin-holder" — a tiny long-lived node process whose
    //      `stdout` pipe is dup'd into codegraph's `stdin`. As long as the
    //      stdin-holder is alive (it is — it's an orphan after the wrapper
    //      dies), codegraph's stdin never sees EOF.
    //   2. Spawns codegraph with that pipe as fd 0 and its stderr redirected
    //      to a tmp file that survives the wrapper, then reports both PIDs.
    //   3. Idles until SIGKILL'd from the test.
    //
    // CODEGRAPH_PPID_POLL_MS=200 keeps the watchdog responsive in test; the
    // production default is 5000ms.
    const stderrLog = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ppid-watchdog-')),
      'codegraph.stderr.log',
    );
    // The wrapper waits 800ms before reporting the PIDs so the codegraph
    // child has time to finish its async start() (dynamic import + transport
    // setup + watchdog registration). Otherwise the test races: it
    // SIGKILL's the wrapper before the watchdog interval is installed, and
    // nothing terminates codegraph.
    const wrapperSrc = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const stderrFd = fs.openSync(${JSON.stringify(stderrLog)}, 'a');
      const stdinHolder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
      stdinHolder.unref();
      const child = spawn(process.execPath, [${JSON.stringify(BIN)}, 'serve', '--mcp'], {
        stdio: [stdinHolder.stdout, 'ignore', stderrFd],
        // Pin to direct (in-process) mode: this test targets the in-process
        // server's PPID watchdog (#277). The detached-daemon/proxy watchdog is
        // covered separately in mcp-daemon.test.ts ("daemon survives the first
        // client dying"). Without this the spawned process becomes a proxy and
        // also spawns a detached daemon that would outlive the test.
        env: { ...process.env, CODEGRAPH_PPID_POLL_MS: '200', CODEGRAPH_NO_DAEMON: '1' },
        detached: true,
      });
      child.unref();
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ pid: child.pid, stdinHolderPid: stdinHolder.pid }) + '\\n');
      }, 800);
      setInterval(() => {}, 60000);
    `;
    wrapper = spawn(process.execPath, ['-e', wrapperSrc], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const pids = await new Promise<{ pid: number; stdinHolderPid: number }>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error('wrapper did not report PIDs in time')),
        10000,
      );
      wrapper!.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/\{"pid":(\d+),"stdinHolderPid":(\d+)\}/);
        if (m) {
          clearTimeout(timer);
          resolve({ pid: parseInt(m[1], 10), stdinHolderPid: parseInt(m[2], 10) });
        }
      });
      wrapper!.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('wrapper exited before reporting PIDs'));
      });
    });
    childPid = pids.pid;
    stdinHolderPid = pids.stdinHolderPid;

    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(stdinHolderPid)).toBe(true);

    // SIGKILL the wrapper — no cleanup runs, just like a real OOM kill.
    // codegraph and the stdin-holder both get reparented to init/systemd.
    // Crucially, the pipe between them stays open, so codegraph's stdin
    // doesn't close: only the watchdog can take it down.
    wrapper.kill('SIGKILL');

    // Watchdog runs every 200ms in this test → 5s gives ~25 polls of headroom.
    const exited = await waitForExit(childPid, 5000);
    const stderrContent = fs.existsSync(stderrLog) ? fs.readFileSync(stderrLog, 'utf-8') : '<no stderr captured>';
    expect(
      exited,
      `codegraph child (pid=${childPid}) did not exit within 5s after wrapper was SIGKILL'd.\nstderr:\n${stderrContent}`,
    ).toBe(true);
    // The watchdog announces itself before tearing down — assert that the
    // shutdown came from the parent-death path, not from any other signal.
    expect(stderrContent).toMatch(/Parent process exited.*shutting down/);

    // The stdin-holder is now an orphan — kill it explicitly so it doesn't
    // outlive the test. It's still tracked in `stdinHolderPid` for the
    // afterEach safety net, but we tidy up proactively here too.
    if (isAlive(stdinHolderPid)) {
      try { process.kill(stdinHolderPid, 'SIGKILL'); } catch { /* race */ }
    }
  }, 20000);
});
