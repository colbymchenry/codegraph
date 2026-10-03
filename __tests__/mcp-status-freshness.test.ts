import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Worker } from 'worker_threads';
import CodeGraph from '../src/index';
import { measurePendingChanges } from '../src/mcp/index-freshness';
import { ToolHandler } from '../src/mcp/tools';

describe('MCP status freshness (#1959)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-freshness-'));
    fs.writeFileSync(path.join(root, 'modify.ts'), 'export const modify = 1;\n');
    fs.writeFileSync(path.join(root, 'remove.ts'), 'export const remove = 1;\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'CodeGraph Test');
    git('config', 'user.email', 'codegraph-test@example.invalid');
    git('add', 'modify.ts', 'remove.ts');
    git('commit', '-qm', 'baseline');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try { cg.close(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the latest indexed file and exact change counts', async () => {
    const initial = (await handler.execute('codegraph_status', {})).content[0].text;
    expect(initial).toMatch(/\*\*Latest file indexed:\*\* \d{4}-\d\d-\d\dT/);
    expect(initial).toContain('**Changes since index:** 0 added, 0 modified, 0 removed');

    fs.writeFileSync(path.join(root, 'modify.ts'), 'export const modify = 42;\n');
    fs.unlinkSync(path.join(root, 'remove.ts'));
    fs.writeFileSync(path.join(root, 'add.ts'), 'export const added = 1;\n');

    const result = await handler.execute('codegraph_status', {});
    // Claude Code would show structuredContent in place of this text (#2088).
    expect(result).not.toHaveProperty('structuredContent');
    const changed = result.content[0].text;
    expect(changed).toContain('**Changes since index:** 1 added, 1 modified, 1 removed');
  });

  it('returns unknown rather than a false zero when the measurement cannot open an index', async () => {
    expect(await measurePendingChanges(path.join(root, 'missing'))).toBeNull();
  });

  it('past its deadline, never terminates the worker before it has loaded its modules', async () => {
    // Terminating a worker while it loads its modules can crash the whole
    // process on Windows (0xC0000005). A 1 ms deadline passes while the real
    // worker is still loading: the answer is unknown at once, and the worker
    // is terminated only after it has posted 'loaded'.
    const posted = new WeakSet<object>();
    const loadedWhenEnded: boolean[] = [];
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      if (event === 'message') posted.add(this);
      return emit.call(this, event, ...args);
    });
    const terminate = Worker.prototype.terminate;
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      loadedWhenEnded.push(posted.has(this));
      return terminate.call(this);
    });
    try {
      expect(await measurePendingChanges(root, 1)).toBeNull();
      await vi.waitFor(() => expect(loadedWhenEnded).toHaveLength(1), { timeout: 20_000 });
      expect(loadedWhenEnded).toEqual([true]);
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('counts edits committed after the index even when the working tree is clean', async () => {
    fs.writeFileSync(path.join(root, 'modify.ts'), 'export const modify = 99;\n');
    execFileSync('git', ['add', 'modify.ts'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'changed'], { cwd: root, stdio: 'pipe' });

    const status = (await handler.execute('codegraph_status', {})).content[0].text;
    expect(status).toContain('**Changes since index:** 0 added, 1 modified, 0 removed');
  });
});
