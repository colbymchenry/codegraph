/**
 * Explicit-`projectPath` project lifecycle (#1835).
 *
 * A server whose root has no index of its own (a workspace whose indexed
 * children are gitignored) serves each child through `projectPath`. Before
 * this fix those projects were opened read-only: no catch-up sync on open and
 * no file watcher, so their answers went stale until someone ran
 * `codegraph sync` by hand. Now the engine gives an explicit project the same
 * lifecycle the default project gets — a catch-up sync the first call waits
 * for, a watcher while it stays cached — bounded (LRU) and released on stop().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { MCPEngine } from '../src/mcp/engine';
import { MAX_CACHED_PROJECTS, __setLoadCodeGraphForTests } from '../src/mcp/tools';

// Default and read-only opens use the engine's lazy CommonJS loader.
const { MCPEngine: BuiltMCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');

const opened: CodeGraph[] = [];
let onOpen: ((cg: CodeGraph) => void) | undefined;
/** CodeGraph that records every instance the ToolHandler opens. */
class RecordingCodeGraph extends CodeGraph {
  static openSync(projectRoot: string): CodeGraph {
    const cg = CodeGraph.openSync(projectRoot);
    opened.push(cg);
    onOpen?.(cg);
    return cg;
  }
}

async function makeProject(dir: string, symbol: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sample.ts'), `export function ${symbol}() { return 1; }\n`);
  const cg = await CodeGraph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });
  await cg.indexAll();
  cg.close();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

// Every case drives real catch-up syncs and waits for them (see the gate note
// below), so each gets room for a loaded Windows VM; cases that do more set
// their own (#1773). These bounds only catch a hang.
describe('MCP explicit projectPath lifecycle (#1835)', { timeout: 30_000 }, () => {
  let workspace: string;
  let serviceA: string;
  let serviceB: string;
  let engine: MCPEngine;
  const engines: MCPEngine[] = [];
  const children: ChildProcess[] = [];
  const prevDebounce = process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;
  const prevGate = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;

  // Both hooks build indexes or wait out a sync; a loaded Windows VM exceeds
  // the default 10s hook timeout, and has taken over 30s (#1773).
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1835-')));
    serviceA = path.join(workspace, 'service-a');
    serviceB = path.join(workspace, 'service-b');
    await makeProject(serviceA, 'alphaOriginal');
    await makeProject(serviceB, 'betaOriginal');
    process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = '100';
    // These cases assert what a call left behind, so wait for its catch-up
    // rather than the gate's 3s serve-anyway deadline, which a loaded machine
    // misses (#1773). That deadline has its own coverage in
    // mcp-catchup-gate.test.ts; the eviction case sets its own values.
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    opened.length = 0;
    onOpen = undefined;
    __setLoadCodeGraphForTests(RecordingCodeGraph as unknown as typeof CodeGraph);
    engine = new MCPEngine({ watch: true });
    engines.push(engine);
    // Two indexed children, none at the root: no default project (#1607).
    await engine.ensureInitialized(workspace);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.stop()));
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
    }
    vi.restoreAllMocks();
    __setLoadCodeGraphForTests(null);
    if (prevDebounce === undefined) delete process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;
    else process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = prevDebounce;
    if (prevGate === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prevGate;
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  function names(root: string): string[] {
    const reader = CodeGraph.openSync(root);
    try { return reader.getNodesByKind('function').map((n) => n.name); }
    finally { reader.close(); }
  }

  /**
   * A daemon owner starts with idle exit OFF. Armed at startup, its 500ms
   * timer raced this process's first connection and lost on a loaded machine,
   * so the daemon exited before any engine reached it (#1773). A test that
   * needs the idle exit enables it with {@link armIdleExit} once it holds a
   * session; the daemon reads the value each time its last client leaves.
   */
  async function startOwner(mode: 'direct' | 'daemon', slowCatchUp = false): Promise<ChildProcess> {
    const modulePath = path.resolve(__dirname, '../dist/mcp');
    const ownerScript = mode === 'daemon' ? `
      const { Daemon, tryAcquireDaemonLock } = require(process.argv[1] + '/daemon');
      const root = process.argv[2];
      tryAcquireDaemonLock(root);
      const daemon = new Daemon(root, { idleTimeoutMs: 0 });
      process.on('message', (message) => {
        if (message !== 'arm-idle') return;
        daemon.idleTimeoutMs = 500;
        process.send('idle-armed');
      });
      daemon.start().then(() => { if (!process.env.CG_TEST_HOLD_CATCHUP) process.send('ready'); });
    ` : `
      const { MCPEngine } = require(process.argv[1] + '/engine');
      const engine = new MCPEngine();
      process.on('SIGTERM', async () => { await engine.stop(); process.exit(0); });
      engine.ensureInitialized(process.argv[2]).then(async () => {
        await engine.getToolHandler().execute('codegraph_status', {});
        if (!process.env.CG_TEST_HOLD_CATCHUP) process.send('ready');
      });
    `;
    const script = `
      if (process.env.CG_TEST_HOLD_CATCHUP) {
        const CodeGraph = require(process.argv[1] + '/../index').default;
        const sync = CodeGraph.prototype.sync;
        CodeGraph.prototype.sync = async function (...args) {
          process.send('ready');
          await new Promise((resolve) => setTimeout(resolve, 300));
          return sync.apply(this, args);
        };
      }
    ` + ownerScript;
    const child = spawn(process.execPath, ['-e', script, modulePath, serviceA], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, CODEGRAPH_NO_DAEMON: mode === 'daemon' ? '0' : '1', CODEGRAPH_QUERY_POOL_SIZE: '0', CG_TEST_HOLD_CATCHUP: slowCatchUp ? '1' : '' },
    });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout!.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Owner did not start: ${stderr}`)), 10000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Owner exited: ${stderr}`)); });
    });
    return child;
  }

  async function armIdleExit(owner: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        if (message !== 'idle-armed') return;
        owner.off('exit', onExit);
        owner.off('message', onMessage);
        resolve();
      };
      const onExit = (): void => { owner.off('message', onMessage); reject(new Error('Owner exited before arming idle exit')); };
      owner.on('message', onMessage);
      owner.once('exit', onExit);
      owner.send('arm-idle');
    });
  }

  async function search(projectPath: string, symbol: string): Promise<string> {
    const res = await engine.getToolHandler().execute('codegraph_search', { query: symbol, projectPath });
    expect(res.isError).toBeFalsy();
    return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  for (const options of [{ watch: true }, { watch: false }, { readOnly: true }]) {
    it(`defers explicit project opens during a rebuild (${JSON.stringify(options)})`, async () => {
      await engine.stop();
      engine = new BuiltMCPEngine(options);
      engines.push(engine);
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(holder);
      if (!holder.pid) throw new Error('Failed to spawn rebuild holder');
      const fence = path.join(serviceA, '.codegraph/rebuild.pid');
      fs.writeFileSync(fence, JSON.stringify({ pid: holder.pid, mode: 'rebuild', startedAt: Date.now() }));
      const response = await engine.getToolHandler().execute('codegraph_search', {
        projectPath: serviceA, query: 'alphaOriginal',
      });
      expect(JSON.stringify(response)).toContain('rebuild is in progress');
      // Expected and temporary: guidance, never a tool error that teaches abandonment.
      expect(JSON.stringify(response)).not.toContain('"isError":true');
      expect(opened).toHaveLength(0);
      expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(false);
      fs.unlinkSync(fence);
      expect(await search(serviceA, 'alphaOriginal')).toContain('alphaOriginal');
    });

    it(`defers default project opens and synchronous retries during a rebuild (${JSON.stringify(options)})`, async () => {
      const reader = new BuiltMCPEngine(options);
      engines.push(reader);
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(holder);
      if (!holder.pid) throw new Error('Failed to spawn rebuild holder');
      const fence = path.join(serviceA, '.codegraph/rebuild.pid');
      fs.writeFileSync(fence, JSON.stringify({ pid: holder.pid, mode: 'rebuild', startedAt: Date.now() }));
      await reader.ensureInitialized(serviceA);
      expect(reader.hasDefaultCodeGraph()).toBe(false);
      reader.retryInitializeSync(serviceA);
      expect(reader.hasDefaultCodeGraph()).toBe(false);
      expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(false);
      fs.unlinkSync(fence);
      reader.retryInitializeSync(serviceA);
      expect(reader.hasDefaultCodeGraph()).toBe(true);
    });
  }

  it('catches up an edit made before the first call and watches later edits', async () => {
    // Edited while no server owned the index — the catch-up path.
    fs.writeFileSync(path.join(serviceA, 'src', 'sample.ts'), 'export function alphaRenamed() { return 1; }\n');
    const first = await search(serviceA, 'alphaRenamed');
    expect(first).toContain('alphaRenamed');
    expect(names(serviceA)).toContain('alphaRenamed');
    expect(names(serviceA)).not.toContain('alphaOriginal');
    expect(first).not.toContain('alphaOriginal');
    expect(opened).toHaveLength(1);
    expect(opened[0].isWatching()).toBe(true);
    await opened[0].waitUntilWatcherReady(5000);

    // Edited while the project stays cached — the watcher path.
    fs.writeFileSync(path.join(serviceA, 'src', 'sample.ts'), 'export function alphaWatched() { return 1; }\n');
    const seen = await waitFor(async () => names(serviceA).includes('alphaWatched'), 10000);
    expect(seen).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('keeps one watched instance per canonical root and closes it on stop()', async () => {
    const link = path.join(workspace, 'link-to-b');
    fs.symlinkSync(serviceB, link, 'dir');
    expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(link, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(path.join(serviceB, 'src'), 'betaOriginal')).toContain('betaOriginal');
    expect(opened).toHaveLength(1);
    expect(opened[0].isWatching()).toBe(true);
    expect(fs.existsSync(path.join(serviceB, '.codegraph', 'writer.pid'))).toBe(true);

    await engine.stop();
    expect(opened[0].isWatching()).toBe(false);
    expect(fs.existsSync(path.join(serviceB, '.codegraph', 'writer.pid'))).toBe(false);
    expect(() => opened[0].getStats()).toThrow();
  });

  it('does not take over a project another live process is already syncing', async () => {
    // Simulate a foreign writer (another daemon) holding the lock.
    fs.mkdirSync(path.join(serviceB, '.codegraph'), { recursive: true });
    const foreign = { pid: process.ppid, mode: 'daemon', startedAt: Date.now() };
    fs.writeFileSync(path.join(serviceB, '.codegraph', 'writer.pid'), JSON.stringify(foreign));
    expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
    expect(opened).toHaveLength(1);
    expect(opened[0].isWatching()).toBe(false);
    await engine.stop();
    // Not ours — left in place.
    expect(fs.readFileSync(path.join(serviceB, '.codegraph', 'writer.pid'), 'utf8')).toContain(String(process.ppid));
    fs.unlinkSync(path.join(serviceB, '.codegraph', 'writer.pid'));
  });

  it('catches up both children without selecting a default', async () => {
    for (const [root, symbol] of [[serviceA, 'alphaNew'], [serviceB, 'betaNew']]) {
      fs.writeFileSync(path.join(root!, 'src/sample.ts'), `export function ${symbol}() {}\n`);
      await search(root!, symbol!);
      expect(names(root!)).toEqual([symbol]);
    }
    expect(engine.hasDefaultCodeGraph()).toBe(false);
  });

  it('shares the catch-up gate across concurrent calls and engines', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    onOpen = (cg) => {
      const sync = cg.sync.bind(cg);
      vi.spyOn(cg, 'sync').mockImplementation(async (...args) => { await held; return sync(...args); });
    };
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function concurrentNew() {}\n');
    const second = new MCPEngine();
    engines.push(second);
    let completed = 0;
    const calls = [
      search(serviceA, 'concurrentNew'),
      search(path.join(serviceA, 'src'), 'concurrentNew'),
      second.getToolHandler().execute('codegraph_search', { projectPath: serviceA, query: 'concurrentNew' }),
    ].map((p) => p.then((r) => { completed++; return r; }));
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(completed).toBe(0);
      expect(opened).toHaveLength(1);
    } finally { release(); }
    await Promise.all(calls);
    expect(names(serviceA)).toEqual(['concurrentNew']);
    expect(opened[0]!.sync).toHaveBeenCalledTimes(1);
  });

  it('keeps watching after one of two engines releases its lease', async () => {
    const second = new MCPEngine();
    engines.push(second);
    await search(serviceA, 'alphaOriginal');
    await second.getToolHandler().execute('codegraph_search', { projectPath: serviceA, query: 'alphaOriginal' });
    await opened[0]!.waitUntilWatcherReady(5000);
    await engine.stop();
    expect(opened[0]!.isWatching()).toBe(true);
    expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(true);
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function survivingSession() {}\n');
    expect(await waitFor(async () => names(serviceA).includes('survivingSession'), 10000)).toBe(true);
    await second.stop();
    expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(false);
  });

  it('retries a foreign writer and catches up after its ownership ends', async () => {
    const lock = path.join(serviceA, '.codegraph/writer.pid');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, mode: 'direct', startedAt: Date.now() }));
    await search(serviceA, 'alphaOriginal');
    expect(opened[0]!.isWatching()).toBe(false);
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function afterOwnerExit() {}\n');
    fs.unlinkSync(lock);
    // No further query should be necessary to activate the surviving session.
    expect(await waitFor(async () => names(serviceA).includes('afterOwnerExit'), 10000)).toBe(true);
    expect(opened[0]!.isWatching()).toBe(true);
  });

  it('quietly retries catch-up after an indexing lock is released (#1361)', async () => {
    const lock = path.join(serviceA, '.codegraph/codegraph.lock');
    const writer = path.join(serviceA, '.codegraph/writer.pid');
    const prev = process.env.CODEGRAPH_NO_WATCH;
    // Ensure the lifecycle retry, not a watcher event, repairs the index.
    process.env.CODEGRAPH_NO_WATCH = '1';
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function afterIndexLock() {}\n');
      fs.writeFileSync(lock, String(process.pid));
      await search(serviceA, 'afterIndexLock');
      expect(names(serviceA)).toEqual(['alphaOriginal']);
      expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
      expect(JSON.parse(fs.readFileSync(writer, 'utf8')).ready).toBe(false);
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).not.toContain('Catch-up sync failed');

      fs.unlinkSync(lock);
      // No second query: the lifecycle's periodic retry must finish catch-up.
      // SQLite rows can be visible before sync's final maintenance finishes.
      expect(await waitFor(async () => JSON.parse(fs.readFileSync(writer, 'utf8')).ready === true, 10000)).toBe(true);
      expect(names(serviceA)).toEqual(['afterIndexLock']);
      expect(opened[0]!.isWatching()).toBe(false);
    } finally {
      fs.rmSync(lock, { force: true });
      stderr.mockRestore();
      if (prev === undefined) delete process.env.CODEGRAPH_NO_WATCH;
      else process.env.CODEGRAPH_NO_WATCH = prev;
    }
  });

  it('honors no-watch for explicit projects', async () => {
    await engine.stop();
    engine = new MCPEngine({ watch: false });
    engines.push(engine);
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function noWatchEdit() {}\n');
    await search(serviceA, 'noWatchEdit');
    expect(names(serviceA)).toEqual(['alphaOriginal']);
    expect(opened[0]!.isWatching()).toBe(false);
    expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(false);
  });

  it('honors the CLI no-watch policy while still catching up on access', async () => {
    const prev = process.env.CODEGRAPH_NO_WATCH;
    process.env.CODEGRAPH_NO_WATCH = '1';
    try {
      fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function policyCatchUp() {}\n');
      await search(serviceA, 'policyCatchUp');
      expect(names(serviceA)).toEqual(['policyCatchUp']);
      expect(opened[0]!.isWatching()).toBe(false);
      fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function policyUnwatched() {}\n');
      await search(serviceA, 'policyUnwatched');
      expect(names(serviceA)).toEqual(['policyCatchUp']);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_NO_WATCH;
      else process.env.CODEGRAPH_NO_WATCH = prev;
    }
  });

  // Builds and reconciles nine real indexes; a Windows VM exceeds the default
  // 5s, and a loaded one exceeded 15s (#1773).
  it('defers eviction and shutdown until an active catch-up finishes', async () => {
    const roots = [serviceA, serviceB];
    for (let i = roots.length; i <= MAX_CACHED_PROJECTS; i++) {
      const root = path.join(workspace, `extra-${i}`);
      await makeProject(root, `symbol${i}`);
      roots.push(root);
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    onOpen = (cg) => {
      if (cg.getProjectRoot() !== serviceA) return;
      const sync = cg.sync.bind(cg);
      vi.spyOn(cg, 'sync').mockImplementation(async (...args) => { await held; return sync(...args); });
    };
    const prev = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '10';
    try {
      fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function evictionCatchUp() {}\n');
      await search(serviceA, 'evictionCatchUp');
      // Only A should time out. Finish every other catch-up before expecting
      // B to be the oldest evictable entry; 10ms can expire on those too.
      process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
      for (const root of roots.slice(1)) await search(root, 'symbol');
      expect(() => opened[0]!.getStats()).not.toThrow();
      expect(() => opened[1]!.getStats()).toThrow();
      let stopped = false;
      const stop = engine.stop().then(() => { stopped = true; });
      await new Promise((r) => setTimeout(r, 50));
      expect(stopped).toBe(false);
      expect(() => opened[0]!.getStats()).not.toThrow();
      release();
      await stop;
      expect(names(serviceA)).toEqual(['evictionCatchUp']);
      expect(() => opened[0]!.getStats()).toThrow();
      expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(false);
    } finally {
      release();
      if (prev === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
      else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prev;
    }
  }, 60_000);


  // A daemon that answered one projectPath query for another project must not
  // keep that project's writer lock until it exits: the project's own daemon
  // and `codegraph index` there would stay locked out (#2087).
  it('releases an idle explicit project and its writer lock, and retakes it on the next call', async () => {
    const prev = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '200';
    const lock = path.join(serviceB, '.codegraph/writer.pid');
    try {
      expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
      expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      expect(opened[0]!.isWatching()).toBe(true);

      expect(await waitFor(async () => !fs.existsSync(lock), 10000)).toBe(true);
      expect(() => opened[0]!.getStats()).toThrow();

      // Still synchronized while in use: the next call reopens and catches up.
      fs.writeFileSync(path.join(serviceB, 'src/sample.ts'), 'export function afterIdleRelease() {}\n');
      expect(await search(serviceB, 'afterIdleRelease')).toContain('afterIdleRelease');
      expect(opened).toHaveLength(2);
      expect(opened[1]!.isWatching()).toBe(true);
      expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = prev;
    }
  });

  it('defers an idle release until an active catch-up finishes (#2087)', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    onOpen = (cg) => {
      const sync = cg.sync.bind(cg);
      vi.spyOn(cg, 'sync').mockImplementation(async (...args) => { await held; return sync(...args); });
    };
    const prevIdle = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '50';
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '10';
    const lock = path.join(serviceB, '.codegraph/writer.pid');
    try {
      fs.writeFileSync(path.join(serviceB, 'src/sample.ts'), 'export function idleCatchUp() {}\n');
      await search(serviceB, 'betaOriginal');
      await new Promise((r) => setTimeout(r, 300));
      expect(() => opened[0]!.getStats()).not.toThrow();
      expect(fs.existsSync(lock)).toBe(true);
      release();
      expect(await waitFor(async () => !fs.existsSync(lock), 10000)).toBe(true);
      expect(names(serviceB)).toEqual(['idleCatchUp']);
      expect(() => opened[0]!.getStats()).toThrow();
    } finally {
      release();
      if (prevIdle === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = prevIdle;
    }
  });

  it('drains a tool operation before closing its cached graph', async () => {
    await search(serviceA, 'alphaOriginal');
    const handler = engine.getToolHandler();
    const dispatch = handler.executeReadTool.bind(handler);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(handler, 'executeReadTool').mockImplementation(async (...args) => {
      await held;
      return dispatch(...args);
    });
    const call = search(serviceA, 'alphaOriginal');
    let stopped = false;
    const stop = engine.stop().then(() => { stopped = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopped).toBe(false);
      expect(opened[0]!.getStats().fileCount).toBe(1);
    } finally { release(); }
    await call;
    await stop;
    expect(() => opened[0]!.getStats()).toThrow();
  });

  it.each(['direct', 'daemon'] as const)('takes over when a real %s owner exits', async (mode) => {
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function ownerCatchUp() {}\n');
    const owner = await startOwner(mode, true);
    await search(serviceA, 'ownerCatchUp');
    expect(names(serviceA)).toEqual(['ownerCatchUp']);
    expect(opened[0]!.isWatching()).toBe(false);
    const lock = JSON.parse(fs.readFileSync(path.join(serviceA, '.codegraph/writer.pid'), 'utf8'));
    expect(lock.pid).toBe(owner.pid);
    const exited = new Promise((resolve) => owner.once('exit', resolve));
    owner.kill('SIGTERM');
    await exited;
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function realOwnerExit() {}\n');
    expect(await waitFor(async () => names(serviceA).includes('realOwnerExit'), 10000)).toBe(true);
    expect(opened[0]!.isWatching()).toBe(true);
  }, 60_000);

  it('retains a daemon while either accessing engine remains connected', async () => {
    const owner = await startOwner('daemon');
    await search(serviceA, 'alphaOriginal');
    const second = new MCPEngine();
    engines.push(second);
    await second.getToolHandler().execute('codegraph_search', { projectPath: serviceA, query: 'alphaOriginal' });
    // Both engines now share one daemon session; from here on the daemon may
    // idle out, and only losing that session should make it do so.
    await armIdleExit(owner);
    await engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(owner.exitCode).toBeNull();
    expect(owner.signalCode).toBeNull();
    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function retainedDaemon() {}\n');
    expect(await waitFor(async () => names(serviceA).includes('retainedDaemon'), 10000)).toBe(true);
    const exited = new Promise((resolve) => owner.once('exit', resolve));
    await second.stop();
    await exited;
    expect(owner.exitCode).toBe(0);
  }, 60_000);

});
