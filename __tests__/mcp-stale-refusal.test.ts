import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { ToolHandler } from '../src/mcp/tools';
import { __setFsWatchForTests } from '../src/sync/watcher';

describe('a degraded index refuses answers from changed files (#1959)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-refusal-'));
    fs.writeFileSync(path.join(root, 'alpha.ts'), 'export function alphaOnly() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'beta.ts'), 'export function betaOnly() { return 2; }\n');
    fs.writeFileSync(
      path.join(root, 'gamma.ts'),
      "import { alphaOnly } from './alpha';\nexport function gammaUses() { return alphaOnly(); }\n"
    );
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);

    __setFsWatchForTests(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    expect(cg.watch()).toBe(false);
    expect(cg.isWatcherDegraded()).toBe(true);
    __setFsWatchForTests(null);
  });

  afterEach(() => {
    __setFsWatchForTests(null);
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names a changed file without serving its result, but keeps unaffected source available', async () => {
    const alphaPath = path.join(root, 'alpha.ts');
    const primed = await handler.execute('codegraph_explore', { query: 'alphaOnly' });
    expect(primed.content[0].text).toContain('export function alphaOnly');
    const before = fs.statSync(alphaPath);
    fs.writeFileSync(alphaPath, 'export function alphaOnly() { return 9; }\n');
    // Identical size and indexed mtime: the last-mile guard must hash bytes,
    // not trust metadata or a prior two-second drift-cache verdict.
    fs.utimesSync(alphaPath, before.atime, before.mtime);

    const session = new ExploreSessionState();
    const refused = await handler.execute('codegraph_explore', { query: 'alphaOnly' }, session);
    expect(refused.isError).toBeFalsy();
    expect(refused.content[0].text).toContain('alpha.ts');
    expect(refused.content[0].text).toContain('cannot answer from this index');
    expect(refused.content[0].text).not.toContain('export function alphaOnly');
    expect(session.view().projects).toEqual([]);

    const unaffected = await handler.execute('codegraph_explore', { query: 'betaOnly' }, session);
    expect(unaffected.content[0].text).toContain('export function betaOnly');
    expect(unaffected.content[0].text).toContain('auto-sync is DISABLED');

    // Let the ordinary sync see a definite metadata change, then ensure the
    // same session receives the source it was not shown before.
    fs.utimesSync(alphaPath, before.atime, new Date(before.mtimeMs + 2000));
    await cg.sync();
    const refreshed = await handler.execute('codegraph_explore', { query: 'alphaOnly' }, session);
    expect(refreshed.content[0].text).toContain('export function alphaOnly');
    expect(refreshed.content[0].text).toContain('return 9');
    expect(refreshed.content[0].text).not.toContain('cannot answer from this index');
  });

  it('refuses a graph answer that names a changed file, and serves one that does not', async () => {
    const callers = await handler.execute('codegraph_callers', { symbol: 'alphaOnly' });
    expect(callers.content[0].text).toContain('gammaUses');

    fs.writeFileSync(
      path.join(root, 'gamma.ts'),
      "import { alphaOnly } from './alpha';\nexport function gammaUses() { return 0; }\n"
    );

    const refused = await handler.execute('codegraph_callers', { symbol: 'alphaOnly' });
    expect(refused.isError).toBeFalsy();
    expect(refused.content[0].text).toContain('cannot answer from this index');
    expect(refused.content[0].text).toContain('- gamma.ts');
    expect(refused.content[0].text).not.toContain('gammaUses');

    const search = await handler.execute('codegraph_search', { query: 'gammaUses' });
    expect(search.content[0].text).toContain('cannot answer from this index');

    const unaffected = await handler.execute('codegraph_search', { query: 'betaOnly' });
    expect(unaffected.content[0].text).toContain('beta.ts');
    expect(unaffected.content[0].text).not.toContain('cannot answer from this index');
  });
});
