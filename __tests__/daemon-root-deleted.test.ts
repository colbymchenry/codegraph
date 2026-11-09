/**
 * Test for issue #3245: daemon continues running after project root deletion.
 *
 * A codegraph daemon keeps running with its recursive fs.watch / FSEvents stream
 * open after its project root (a git worktree) is deleted. It only exits when
 * the last client disconnects and the 300s idle timeout has passed.
 *
 * Expected: when <root> or <root>/.codegraph disappears, the daemon should stop
 * watching, remove its registry entry and exit promptly, WITHOUT waiting for
 * client disconnect plus idle timeout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getDaemonSocketPath, getDaemonPidPath } from '../src/mcp/daemon-paths';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { CodeGraphPackageVersion } from '../src/mcp/version';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';
import { listDaemons } from '../src/mcp/daemon-registry';

/**
 * Wait for the daemon to have written its first "Listening on" log line.
 * The daemon logs to .codegraph/daemon.log (not our child.stderr) and this
 * is the accepted readiness probe across the suite.
 */
async function waitForDaemonReady(root: string, timeout = 10_000): Promise<void> {
  const start = Date.now();
  const logPath = path.join(root, '.codegraph', 'daemon.log');
  while (Date.now() - start < timeout) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      if (content.includes('[CodeGraph daemon] Listening on')) return;
    } catch {
      /* file not ready yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon not ready after ${timeout}ms (${logPath})`);
}

/**
 * Read the lockfile pid for a project root.
 */
function readLockPid(root: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8');
    const info = JSON.parse(raw);
    return typeof info.pid === 'number' ? info.pid : null;
  } catch { return null; }
}

/**
 * Test harness for spawning a daemon and cleaning it up.
 */
async function spawnDaemon(root: string, HOME: string): Promise<{ 
  daemon: ReturnType<typeof spawn>, 
  pidPath: string, 
  socketPath: string,
  cleanup: () => Promise<void>
}> {
  const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
  const recorder = recordSpawns(root);
  const daemon = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp', '--path', root], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME, USERPROFILE: HOME, CODEGRAPH_MCP_LOG_ATTACH: '1', CODEGRAPH_DAEMON_ROOT_CHECK_MS: '500', ...recorder.env },
  });
  
  const socketPath = getDaemonSocketPath(root);
  const pidPath = getDaemonPidPath(root);
  
  await waitForDaemonReady(root);
  
  function cleanup() {
    return new Promise<void>((resolve) => {
      if (daemon.killed) {
        return resolve();
      }
      
      daemon.kill('SIGTERM');
      const timeout = setTimeout(() => {
        daemon.kill('SIGKILL');
      }, 5000);
      
      daemon.once('exit', () => {
        clearTimeout(timeout);
        try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
        resolve();
      });
    });
  }
  
  return { daemon, pidPath, socketPath, cleanup };
}

describe('daemon-root-deleted', () => {
  let testHome: string;
  let daemonHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  
  beforeEach(async () => {
    daemonHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-home-'));
    const prev = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = daemonHome;
    process.env.USERPROFILE = daemonHome;
    prevHome = prev;
    prevUserProfile = prevUser;
    
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-root-deleted-test-'));
    const cg = await CodeGraph.init(testHome);
    try { await cg.indexAll(); } finally { cg.close(); }
  });
  
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(daemonHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  
  it('should exit promptly when project root is deleted (no clients)', async () => {
    const { daemon, socketPath, pidPath, cleanup } = await spawnDaemon(testHome, daemonHome);
    
    try {
      // Delete project root
      fs.rmSync(testHome, { recursive: true, force: true });
      
      // Wait for daemon process to exit (polling lockfile pid)
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (readLockPid(testHome) === null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      
      // Poll the daemon pid from the lockfile; daemon MUST have exited
      const holder = () => {
        try { return JSON.parse(fs.readFileSync(pidPath, 'utf8')).pid; } catch { return null; }
      };
      await settleLosingCandidates(testHome, holder);
      
      expect(fs.existsSync(pidPath)).toBe(false);
      if (process.platform !== 'win32') {
        expect(fs.existsSync(socketPath)).toBe(false);
      }
      expect(listDaemons({ prune: false }).length).toBe(0);
    } finally {
      await cleanup();
    }
  });
  
  it('should exit promptly when project root is deleted (with client connected)', async () => {
    const { daemon, socketPath, pidPath, cleanup } = await spawnDaemon(testHome, daemonHome);
    
    try {
      // Connect a client
      const client = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        client.connect(getDaemonSocketPath(testHome));
        client.once('connect', resolve);
        client.once('error', reject);
      });
      
      // Send daemon hello and wait for response
      client.write(JSON.stringify({
        codegraph: CodeGraphPackageVersion,
        pid: process.pid,
        socketPath: getDaemonSocketPath(testHome),
        protocol: 1,
      }) + '\n');
      
      await new Promise((r) => setTimeout(r, 100));
      
      // Attach an error handler to the socket so its close cannot fail the test
      client.on('error', () => {});
      
      // Delete project root while client is still connected
      fs.rmSync(testHome, { recursive: true, force: true });
      
      // Wait for daemon to exit on its own (root deletion detection)
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (readLockPid(testHome) === null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      
      // Verify daemon exited due to root deletion
      const holder = () => {
        try { return JSON.parse(fs.readFileSync(pidPath, 'utf8')).pid; } catch { return null; }
      };
      await settleLosingCandidates(testHome, holder);
      
      expect(fs.existsSync(pidPath)).toBe(false);
      if (process.platform !== 'win32') {
        expect(fs.existsSync(socketPath)).toBe(false);
      }
      expect(listDaemons({ prune: false }).length).toBe(0);
      
      client.destroy();
    } finally {
      await cleanup();
    }
  });
});
