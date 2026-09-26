import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
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
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
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

    const changed = (await handler.execute('codegraph_status', {})).content[0].text;
    expect(changed).toContain('**Changes since index:** 1 added, 1 modified, 1 removed');
  });

  it('returns unknown rather than a false zero when the measurement cannot open an index', async () => {
    expect(await measurePendingChanges(path.join(root, 'missing'))).toBeNull();
  });

  it('counts edits committed after the index even when the working tree is clean', async () => {
    fs.writeFileSync(path.join(root, 'modify.ts'), 'export const modify = 99;\n');
    execFileSync('git', ['add', 'modify.ts'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'changed'], { cwd: root, stdio: 'pipe' });

    const status = (await handler.execute('codegraph_status', {})).content[0].text;
    expect(status).toContain('**Changes since index:** 0 added, 1 modified, 0 removed');
  });
});
