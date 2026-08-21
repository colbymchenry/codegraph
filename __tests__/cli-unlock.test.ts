import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getDaemonPidPath, getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { CodeGraphPackageVersion } from '../src/mcp/version';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCodegraph(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCodegraphAsync(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

describe('codegraph unlock — daemon artifact recovery (#1553)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-unlock-'));
    const cg = CodeGraph.initSync(tempDir);
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes indexing and phantom-daemon artifacts, then permits indexing', () => {
    const graphDir = path.join(tempDir, '.codegraph');
    const pidPath = getDaemonPidPath(tempDir);
    const socketPath = getDaemonSocketPath(tempDir);
    fs.writeFileSync(path.join(graphDir, 'codegraph.lock'), 'stale\n');
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath,
      startedAt: Date.now() - 60_000,
    }));
    if (process.platform !== 'win32') fs.writeFileSync(socketPath, 'stale\n');

    const output = runCodegraph(['unlock', tempDir], tempDir);

    expect(output).toContain('Removed stale lock artifacts');
    expect(fs.existsSync(path.join(graphDir, 'codegraph.lock'))).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
    if (process.platform !== 'win32') expect(fs.existsSync(socketPath)).toBe(false);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(() => runCodegraph(['index', '--quiet', tempDir], tempDir)).not.toThrow();
  });

  it('preserves artifacts when the recorded live daemon answers the socket hello', async () => {
    const pidPath = getDaemonPidPath(tempDir);
    const socketPath = getDaemonSocketPath(tempDir);
    const server = net.createServer((socket) => {
      socket.end(JSON.stringify({
        codegraph: CodeGraphPackageVersion,
        pid: process.pid,
        socketPath,
        protocol: 1,
      }) + '\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath,
      startedAt: Date.now(),
    }));

    try {
      const output = await runCodegraphAsync(['unlock', tempDir], tempDir);
      expect(output).toContain('No stale lock files found');
      expect(fs.existsSync(pidPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
