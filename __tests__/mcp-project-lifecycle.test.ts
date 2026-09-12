import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
// Exercise the shipped CommonJS path, including lazy project opens.
const { CodeGraph } = require('../dist') as typeof import('../src');
const { MCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');
type MCPEngine = import('../src/mcp/engine').MCPEngine;
import { getWriterPidPath } from '../src/mcp/writer-lock';

const roots: string[] = [];
const engines: MCPEngine[] = [];
async function project(): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-lifecycle-')));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'before.ts'), 'export function before() { return 1; }');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
  return root;
}
function engine(options = {}): MCPEngine {
  const result = new MCPEngine(options);
  engines.push(result);
  return result;
}
async function files(e: MCPEngine, root: string): Promise<string> {
  return JSON.stringify(await e.getToolHandler().execute('codegraph_files', { projectPath: root }));
}
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('explicit project MCP lifecycle (#1835)', () => {
  it('catches up each existing project once and shares concurrent opens', async () => {
    const a = await project();
    const b = await project();
    fs.unlinkSync(path.join(a, 'before.ts'));
    fs.unlinkSync(path.join(b, 'before.ts'));
    fs.writeFileSync(path.join(a, 'after.ts'), 'export function after() {}');
    fs.writeFileSync(path.join(b, 'after.ts'), 'export function after() {}');
    const sync = vi.spyOn(CodeGraph.prototype, 'sync');
    const e = engine();
    const results = await Promise.all([files(e, a), files(e, a), files(e, b)]);
    for (const result of results) {
      expect(result).toContain('after.ts');
      expect(result).not.toContain('before.ts');
    }
    expect(sync).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(getWriterPidPath(a))).toBe(true);
    expect(fs.existsSync(getWriterPidPath(b))).toBe(true);
    await e.stop();
    expect(fs.existsSync(getWriterPidPath(a))).toBe(false);
    expect(fs.existsSync(getWriterPidPath(b))).toBe(false);
  });

  it('auto-syncs subsequent edits in explicit projects', async () => {
    vi.stubEnv('CODEGRAPH_WATCH_DEBOUNCE_MS', '100');
    const root = await project();
    const e = engine();
    await files(e, root);
    fs.writeFileSync(path.join(root, 'live.ts'), 'export function live() {}');
    await vi.waitFor(async () => expect(await files(e, root)).toContain('live.ts'), { timeout: 10000, interval: 100 });
  }, 15000);

  it('reuses default project lifecycle for explicit requests', async () => {
    const root = await project();
    const sync = vi.spyOn(CodeGraph.prototype, 'sync');
    const e = engine();
    await e.ensureInitialized(root);
    await files(e, root);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it.each(['option', 'environment'])('respects no-watch %s without catch-up writes', async (mode) => {
    const root = await project();
    fs.unlinkSync(path.join(root, 'before.ts'));
    if (mode === 'environment') vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    const sync = vi.spyOn(CodeGraph.prototype, 'sync');
    const e = engine(mode === 'option' ? { watch: false } : {});
    expect(await files(e, root)).toContain('before.ts');
    expect(sync).not.toHaveBeenCalled();
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('does not catch up, steal or remove another live writer lock', async () => {
    const root = await project();
    const lock = JSON.stringify({ pid: process.ppid, mode: 'test', startedAt: Date.now() });
    fs.writeFileSync(getWriterPidPath(root), lock);
    const sync = vi.spyOn(CodeGraph.prototype, 'sync');
    const e = engine();
    await files(e, root);
    expect(sync).not.toHaveBeenCalled();
    await e.stop();
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(lock);
  });

  it('takes over an explicit project on the next request after another engine exits', async () => {
    vi.stubEnv('CODEGRAPH_WATCH_DEBOUNCE_MS', '100');
    const root = await project();
    const script = `
      const { MCPEngine } = require(process.argv[1]);
      const e = new MCPEngine();
      process.on('SIGTERM', async () => { await e.stop(); process.exit(0); });
      e.getToolHandler().execute('codegraph_status', { projectPath: process.argv[2] })
        .then(() => process.send('ready'));
    `;
    const child = spawn(process.execPath, ['--liftoff-only', '-e', script,
      path.resolve(__dirname, '../dist/mcp/engine.js'), root], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env,
    });
    child.stderr!.on('data', () => {});
    const closed = once(child, 'close');
    try {
      await once(child, 'message');
      const e = engine();
      const sync = vi.spyOn(CodeGraph.prototype, 'sync');
      await files(e, root);
      expect(sync).not.toHaveBeenCalled();
      child.kill('SIGTERM');
      await closed;
      fs.writeFileSync(path.join(root, 'takeover.ts'), 'export function takeover() {}');
      expect(await files(e, root)).toContain('takeover.ts');
      expect(sync).toHaveBeenCalledTimes(1);
      const lock = JSON.parse(fs.readFileSync(getWriterPidPath(root), 'utf8'));
      expect(lock.pid).toBe(process.pid);
      fs.writeFileSync(path.join(root, 'after-takeover.ts'), 'export function afterTakeover() {}');
      await vi.waitFor(async () => expect(await files(e, root)).toContain('after-takeover.ts'), { timeout: 10000, interval: 100 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 20000);

  it('drains an in-flight reconcile before closing its database or releasing ownership', async () => {
    const root = await project();
    fs.writeFileSync(path.join(root, 'added.ts'), 'export function added() {}');
    const { DatabaseConnection } = require('../dist/db') as typeof import('../src/db');
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const maintenance = DatabaseConnection.prototype.runMaintenance;
    vi.spyOn(DatabaseConnection.prototype, 'runMaintenance').mockImplementation(async function () {
      entered();
      await paused;
      return maintenance.call(this);
    });
    const close = vi.spyOn(DatabaseConnection.prototype, 'close');
    const open = vi.spyOn(CodeGraph, 'openSync');
    const e = engine();
    const query = files(e, root);
    await started;
    const stopped = e.stop();
    try {
      expect(e.stop()).toBe(stopped);
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      expect(fs.existsSync(getWriterPidPath(root))).toBe(true);
    } finally {
      release();
    }
    await stopped;
    await query;
    expect(close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
    const cg = CodeGraph.openSync(root);
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    cg.close();
  });

  it('never creates an index for an unindexed project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unindexed-lifecycle-'));
    roots.push(root);
    const e = engine();
    expect(await files(e, root)).toContain("isn't indexed");
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });
});
