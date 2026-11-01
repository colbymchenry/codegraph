/** Writer and daemon PID records share one mutation barrier, including handover. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tryAcquireWriterLock, swapWriterLock, getWriterPidPath, markWriterReady, releaseWriterLock } from '../src/mcp/writer-lock';
import { clearStaleDaemonLock, tryAcquireDaemonLock, refreshDaemonLock } from '../src/mcp/daemon';

const DIST = path.resolve(__dirname, '../dist');
const FIXTURE = path.resolve(__dirname, 'fixtures/pid-lock-contender.cjs');
const DEAD_PID = 99999999;

describe('PID lock mutation races', () => {
  let root: string;
  let markers: string;
  let child: ChildProcess | undefined;
  let exited: Promise<number | null>;
  let stderr: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pid-race-'));
    markers = path.join(root, 'markers');
    fs.mkdirSync(markers);
    fs.mkdirSync(path.join(root, '.codegraph'));
    stderr = '';
  });
  afterEach(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function marker(name: string): Promise<string> {
    const file = path.join(markers, name);
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file)) {
      if (child?.exitCode !== null || child?.signalCode !== null || Date.now() > deadline) {
        throw new Error(`Missing ${name}; child exit ${child?.exitCode}: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return fs.readFileSync(file, 'utf8');
  }

  // These process/barrier tests can exceed five seconds on a loaded machine:
  // each loads the real built lock modules, never a server, then pauses exactly
  // at unlink/rename. The timeout is a failure bound, not a sleep-based schedule.
  it.each(['writer', 'rebuild', 'swap', 'ready', 'release', 'daemon', 'daemon-refresh', 'daemon-cleanup'])(
    'does not let a competing %s mutation discard or overwrite a successor', async (operation) => {
      child = spawn(process.execPath, [FIXTURE, DIST, root, operation, markers], {
        cwd: os.tmpdir(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      exited = new Promise((resolve) => child!.once('exit', resolve));
      const slowPid = Number(await marker('paused'));
      let fast: boolean;
      const isDaemon = operation.startsWith('daemon');
      const pidPath = path.join(root, '.codegraph', isDaemon ? 'daemon.pid' : operation === 'rebuild' ? 'rebuild.pid' : 'writer.pid');
      if (operation === 'ready' || operation === 'release') {
        fast = swapWriterLock(root, slowPid, { pid: process.pid, mode: 'fast', startedAt: 3 });
      } else if (isDaemon) {
        clearStaleDaemonLock(pidPath, operation === 'daemon-refresh' ? slowPid : DEAD_PID, {
          allowLivePid: operation === 'daemon-refresh',
        });
        fast = tryAcquireDaemonLock(root).kind === 'acquired';
      } else {
        fast = tryAcquireWriterLock(root, 'fast', operation === 'rebuild' ? 'rebuild.pid' : 'writer.pid').kind === 'acquired';
      }
      fs.writeFileSync(path.join(markers, 'go'), '');
      const slow = JSON.parse(await marker('result')) as { acquired: boolean };
      expect(typeof slow.acquired).toBe('boolean');
      // The fast process remains alive throughout. If it acquired, neither the
      // slow cleanup nor the slow rename may remove its current ownership.
      if (fast) {
        expect(fs.existsSync(pidPath), 'cleanup removed the live successor').toBe(true);
        expect(JSON.parse(fs.readFileSync(pidPath, 'utf8')).pid).toBe(process.pid);
      }
      if (operation === 'release' || operation === 'daemon-cleanup') {
        if (!fast) expect(fs.existsSync(pidPath)).toBe(false);
      } else {
        expect(Number(fast) + Number(slow.acquired), 'both contenders reported ownership').toBe(1);
        expect(JSON.parse(fs.readFileSync(pidPath, 'utf8')).pid).toBe(fast ? process.pid : slowPid);
      }
    }, 30000,
  );

  // Real shutdown and built-module startup can exceed five seconds under load.
  it.runIf(process.platform !== 'win32')('keeps ownership until shutdown finishes removing its socket', async () => {
    child = spawn(process.execPath, [FIXTURE, DIST, root, 'daemon-exit', markers], {
      cwd: os.tmpdir(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    exited = new Promise((resolve) => child!.once('exit', resolve));
    await marker('paused');
    const successor = tryAcquireWriterLock(root, 'successor').kind === 'acquired';
    const socketPath = path.join(root, 'shutdown.sock');
    if (successor) {
      expect(tryAcquireDaemonLock(root).kind).toBe('acquired');
      fs.writeFileSync(socketPath, 'successor daemon');
    }
    fs.writeFileSync(path.join(markers, 'go'), '');
    await marker('result');
    if (successor) {
      expect(fs.existsSync(socketPath), 'shutdown removed its successor socket').toBe(true);
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('successor daemon');
    } else {
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
      expect(fs.existsSync(path.join(root, '.codegraph', 'daemon.pid'))).toBe(false);
    }
  }, 30000);

  // Built-module process startup can exceed five seconds on a loaded machine.
  // The holder releases independently, so the owner must wait rather than skip.
  it.each(['release', 'ready', 'swap', 'refresh'])('waits for a briefly held barrier before %s', async (operation) => {
    const name = operation === 'refresh' ? 'daemon.pid' : 'writer.pid';
    const pidPath = path.join(root, '.codegraph', name);
    const initial = operation === 'refresh'
      ? { pid: process.pid, version: '1.0.0', socketPath: 'initial.sock', startedAt: 1 }
      : { pid: process.pid, mode: 'direct', startedAt: 1, ready: false };
    fs.writeFileSync(pidPath, JSON.stringify(initial) + '\n');
    fs.writeFileSync(path.join(markers, 'name'), name);
    child = spawn(process.execPath, [FIXTURE, DIST, root, 'hold-barrier', markers], {
      cwd: os.tmpdir(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    exited = new Promise((resolve) => child!.once('exit', resolve));
    await marker('paused');
    fs.writeFileSync(path.join(markers, 'invoke'), '');
    let swapped = false;
    let reacquired = false;
    let error: unknown;
    try {
      if (operation === 'release') releaseWriterLock(root);
      if (operation === 'ready') {
        // Reentrant engine activation must not become a proxy to its own daemon
        // merely because another process is briefly mutating the writer record.
        reacquired = tryAcquireWriterLock(root, 'fallback').kind === 'acquired';
        markWriterReady(root);
      }
      if (operation === 'swap') swapped = swapWriterLock(root, process.pid, { pid: DEAD_PID, mode: 'next', startedAt: 2 });
      if (operation === 'refresh') refreshDaemonLock(pidPath, JSON.stringify(initial) + '\n', {
        pid: process.pid, version: '1.0.0', socketPath: 'refreshed.sock', startedAt: 2,
      });
    } catch (err) { error = err; }
    const held = JSON.parse(await marker('result')) as { unchanged: boolean };
    expect(held.unchanged, 'owner mutated the record while another process held the barrier').toBe(true);
    expect(error).toBeUndefined();
    if (operation === 'release') expect(fs.existsSync(pidPath)).toBe(false);
    if (operation === 'ready') {
      expect(reacquired, 'the owner must retain same-process acquisition semantics').toBe(true);
      expect(JSON.parse(fs.readFileSync(pidPath, 'utf8')).ready).toBe(true);
    }
    if (operation === 'swap') expect(swapped).toBe(true);
    if (operation === 'refresh') expect(JSON.parse(fs.readFileSync(pidPath, 'utf8')).socketPath).toBe('refreshed.sock');
  }, 30000);

  it.each(['writer.pid', 'rebuild.pid'] as const)('preserves a fresh empty %s during exclusive-create publication', (name) => {
    const file = getWriterPidPath(root, name);
    fs.writeFileSync(file, '');
    expect(tryAcquireWriterLock(root, 'direct', name).kind).toBe('taken');
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('preserves a fresh empty daemon claim during exclusive-create publication', () => {
    const file = path.join(root, '.codegraph', 'daemon.pid');
    fs.writeFileSync(file, '');
    expect(clearStaleDaemonLock(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });
});
