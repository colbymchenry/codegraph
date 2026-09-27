/**
 * Issue #1740 — concurrent direct-mode serve --mcp must fail fast on the
 * second writer instead of silently degrading auto-sync.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getWriterPidPath } from '../src/mcp/writer-lock';
import { isProcessAlive, stopDaemonAt } from '../src/mcp/daemon-registry';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnMcp(
  cwd: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; getStderr: () => string } {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  child.stdout.on('data', () => {});
  return { child, getStderr: () => stderr };
}

function readWriterPid(root: string): number | undefined {
  try {
    const { pid } = JSON.parse(fs.readFileSync(getWriterPidPath(root), 'utf8')) as { pid?: number };
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid
      ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (exited()) return;
    child.kill(signal);
    const deadline = Date.now() + 3000;
    while (!exited() && Date.now() < deadline) await sleep(25);
  }
  expect(exited(), `Child ${child.pid} did not exit`).toBe(true);
}

describe('issue #1740 — direct-mode writer lock', () => {
  let tempDir: string;
  let realRoot: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg1740-mcp-'));
    realRoot = fs.realpathSync(tempDir);
    fs.mkdirSync(path.join(realRoot, 'src'));
    fs.writeFileSync(path.join(realRoot, 'src/a.ts'), 'export function a() { return 1; }\n');
    const cg = await CodeGraph.init(realRoot);
    await cg.indexAll();
    cg.close();
  });

  async function cleanup(): Promise<void> {
    // Capture the fixture writer before stopping its proxies (#1782). The
    // daemon stop helper verifies its socket identity before signaling it.
    const childPids = new Set(children.map((c) => c.pid));
    const writerPid = readWriterPid(realRoot);
    const results = await Promise.allSettled([
      ...children.map(stopChild),
      ...(writerPid !== undefined && !childPids.has(writerPid)
        ? [stopDaemonAt(realRoot).then((result) => {
          expect(result.pid).toBe(writerPid);
          expect(result.outcome).not.toBe('unverified');
        })]
        : []),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    if (writerPid !== undefined) {
      expect(isProcessAlive(writerPid), `Writer ${writerPid} did not exit`).toBe(false);
    }
    children.length = 0;
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10 });
    expect(fs.existsSync(tempDir)).toBe(false);
  }

  afterEach(cleanup, 15000);

  it('second CODEGRAPH_NO_DAEMON serve --mcp exits with writer-lock error', async () => {
    const env = {
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_MCP_DEBUG: '1',
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      // Avoid wasm --liftoff-only re-exec so lock.pid matches the spawned pid.
      CODEGRAPH_NO_RELAUNCH: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
    };
    const first = spawnMcp(realRoot, env);
    children.push(first.child);

    const lockPath = getWriterPidPath(realRoot);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !fs.existsSync(lockPath)) {
      await sleep(50);
    }
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(first.child.exitCode).toBeNull();

    const second = spawnMcp(realRoot, env);
    children.push(second.child);

    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(second.child.exitCode), 10000);
      second.child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    expect(code).toBe(1);
    expect(second.getStderr()).toMatch(/writer lock held/i);
    expect(second.getStderr()).toMatch(/CODEGRAPH_NO_DAEMON/);
    expect(first.child.exitCode).toBeNull();
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(lock.pid).toBe(first.child.pid);
  }, 20000);

  it('default daemon mode still allows two proxies to share one writer', async () => {
    const env = {
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_MCP_LOG_ATTACH: '1',
      CODEGRAPH_NO_WATCHDOG: '1',
      CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
      CODEGRAPH_NO_RELAUNCH: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
    };
    const a = spawnMcp(realRoot, env);
    const b = spawnMcp(realRoot, env);
    children.push(a.child, b.child);

    const lockPath = getWriterPidPath(realRoot);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(lockPath)) {
      await sleep(50);
    }
    expect(fs.existsSync(lockPath)).toBe(true);
    await sleep(1000);
    expect(a.child.exitCode).toBeNull();
    expect(b.child.exitCode).toBeNull();

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; mode: string };
    expect(lock.mode).toBe('daemon');
    expect(lock.pid).not.toBe(a.child.pid);
    expect(lock.pid).not.toBe(b.child.pid);

    // This must catch a live writer even on POSIX, where unlinking its open
    // database would otherwise hide the leak that blocks removal on Windows.
    await cleanup();
    expect(isProcessAlive(lock.pid)).toBe(false);
    expect(isProcessAlive(a.child.pid!)).toBe(false);
    expect(isProcessAlive(b.child.pid!)).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 25000);
});
