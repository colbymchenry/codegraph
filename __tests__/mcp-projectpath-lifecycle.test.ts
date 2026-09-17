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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { MCPEngine } from '../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../src/mcp/tools';

const opened: CodeGraph[] = [];
/** CodeGraph that records every instance the ToolHandler opens. */
class RecordingCodeGraph extends CodeGraph {
  static openSync(projectRoot: string): CodeGraph {
    const cg = CodeGraph.openSync(projectRoot);
    opened.push(cg);
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

describe('MCP explicit projectPath lifecycle (#1835)', () => {
  let workspace: string;
  let serviceA: string;
  let serviceB: string;
  let engine: MCPEngine;
  const prevDebounce = process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;

  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1835-')));
    serviceA = path.join(workspace, 'service-a');
    serviceB = path.join(workspace, 'service-b');
    await makeProject(serviceA, 'alphaOriginal');
    await makeProject(serviceB, 'betaOriginal');
    process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = '100';
    opened.length = 0;
    __setLoadCodeGraphForTests(RecordingCodeGraph as unknown as typeof CodeGraph);
    engine = new MCPEngine({ watch: true });
    // Two indexed children, none at the root: no default project (#1607).
    await engine.ensureInitialized(workspace);
  });

  afterEach(() => {
    engine.stop();
    __setLoadCodeGraphForTests(null);
    if (prevDebounce === undefined) delete process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;
    else process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = prevDebounce;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function search(projectPath: string, symbol: string): Promise<string> {
    const res = await engine.getToolHandler().execute('codegraph_search', { query: symbol, projectPath });
    expect(res.isError).toBeFalsy();
    return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  it('catches up an edit made before the first call and watches later edits', async () => {
    // Edited while no server owned the index — the catch-up path.
    fs.writeFileSync(path.join(serviceA, 'src', 'sample.ts'), 'export function alphaRenamed() { return 1; }\n');
    const first = await search(serviceA, 'alphaRenamed');
    expect(first).toContain('alphaRenamed');
    expect(first).not.toContain('alphaOriginal');
    expect(opened).toHaveLength(1);
    expect(opened[0].isWatching()).toBe(true);
    await opened[0].waitUntilWatcherReady(5000);

    // Edited while the project stays cached — the watcher path.
    fs.writeFileSync(path.join(serviceA, 'src', 'sample.ts'), 'export function alphaWatched() { return 1; }\n');
    const seen = await waitFor(async () => (await search(serviceA, 'alphaWatched')).includes('alphaWatched'), 10000);
    expect(seen).toBe(true);
  });

  it('keeps one watched instance per canonical root and closes it on stop()', async () => {
    const link = path.join(workspace, 'link-to-b');
    fs.symlinkSync(serviceB, link, 'dir');
    expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(link, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(path.join(serviceB, 'src'), 'betaOriginal')).toContain('betaOriginal');
    expect(opened).toHaveLength(1);
    expect(opened[0].isWatching()).toBe(true);
    expect(fs.existsSync(path.join(serviceB, '.codegraph', 'writer.pid'))).toBe(true);

    engine.stop();
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
    engine.stop();
    // Not ours — left in place.
    expect(fs.readFileSync(path.join(serviceB, '.codegraph', 'writer.pid'), 'utf8')).toContain(String(process.ppid));
    fs.unlinkSync(path.join(serviceB, '.codegraph', 'writer.pid'));
  });
});
