import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { stopDaemonAt, isProcessAlive } from '../src/mcp/daemon-registry';
import { readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../src/mcp/writer-lock';

const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;
let children: ChildProcessWithoutNullStreams[];
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
  CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_NO_DAEMON: '', CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '60000' };

async function until<T>(fn: () => T, timeout = 20000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value as NonNullable<T>;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for process/response');
}
function start(args: string[]) {
  const child = spawn(process.execPath, ['--liftoff-only', bin, ...args], { cwd: root, env });
  children.push(child);
  let out = '', err = '';
  child.stdout.on('data', b => out += b);
  child.stderr.on('data', b => err += b);
  child.stdin.on('error', () => {});
  return { child, output: () => out, errors: () => err };
}
type Server = ReturnType<typeof start>;
function send(server: Server, id: number, method: string, params: unknown = {}) {
  server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}
async function response(server: Server, id: number) {
  return until(() => server.output().split('\n').map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).find(m => m?.id === id));
}
async function client() {
  const server = start(['serve', '--mcp', '--path', root]);
  send(server, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'rebuild-test', version: '1' } });
  await response(server, 1);
  send(server, 2, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'originalSymbol' } });
  expect((await response(server, 2)).result.isError).not.toBe(true);
  return server;
}
async function rebuild() {
  const cmd = start(['index', '--quiet']);
  await until(() => cmd.child.exitCode !== null || cmd.child.signalCode !== null, 60000);
  expect(cmd.errors()).not.toContain('Failed to index');
  expect(cmd.child.exitCode).toBe(0);
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rebuild-')));
  children = [];
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() {}\n');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
});
afterEach(async () => {
  releaseWriterLock(root, 'rebuild.pid');
  for (const child of children) {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await until(() => children.every(c => c.exitCode !== null || c.signalCode !== null));
  await stopDaemonAt(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

it.runIf(process.platform === 'win32')('rebuilds after the real MCP client closes with SQLite held by its daemon (#1325)', async () => {
  const server = await client();
  const pid = JSON.parse(fs.readFileSync(path.join(root, '.codegraph/daemon.pid'), 'utf8')).pid;
  server.child.stdin.end();
  await until(() => server.child.exitCode !== null);
  expect(isProcessAlive(pid)).toBe(true);
  await rebuild();
  expect(isProcessAlive(pid)).toBe(false);
  const cg = CodeGraph.openSync(root);
  try { expect(cg.searchNodes('originalSymbol').length).toBeGreaterThan(0); }
  finally { cg.close(); }
}, 90000);

it('keeps an active client from reopening SQLite during rebuild and serves the new graph afterward', async () => {
  const server = await client();
  // Hold the exact CLI rebuild fence to deterministically exercise a request
  // arriving between daemon termination and database recreation.
  expect(tryAcquireWriterLock(root, 'rebuild', 'rebuild.pid').kind).toBe('acquired');
  expect((await stopDaemonAt(root)).outcome).toMatch(/term|kill/);
  await until(() => server.errors().includes('connection lost'));
  send(server, 3, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'originalSymbol' } });
  expect((await response(server, 3)).error.message).toContain('rebuild is in progress');
  expect(readWriterLock(root)?.mode).not.toBe('fallback');
  releaseWriterLock(root, 'rebuild.pid');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function replacementSymbol() {}\n');
  await rebuild();
  send(server, 4, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'replacementSymbol' } });
  const reply = await response(server, 4);
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).not.toBe(true);
  expect(JSON.stringify(reply.result)).toContain('replacementSymbol');
}, 90000);

it('preserves a foreign writer and the existing database', async () => {
  expect(tryAcquireWriterLock(root, 'direct').kind).toBe('acquired');
  const before = fs.readFileSync(path.join(root, '.codegraph/codegraph.db'));
  try {
    const cmd = start(['index', '--quiet']);
    await until(() => cmd.child.exitCode !== null);
    expect(cmd.child.exitCode).toBe(1);
    expect(cmd.errors()).toContain('writer lock held');
    expect(readWriterLock(root)?.pid).toBe(process.pid);
    expect(fs.readFileSync(path.join(root, '.codegraph/codegraph.db'))).toEqual(before);
  } finally { releaseWriterLock(root); }
});
