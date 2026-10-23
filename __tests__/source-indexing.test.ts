import { test, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Worker } from 'worker_threads';
import CodeGraph from '../src';
import * as limits from '../src/file-limits';
import { clearProjectConfigCache } from '../src/project-config';
import { ToolHandler } from '../src/mcp/tools';
import { hasDriftedOnDisk } from '../src/ui-server/api/source';
import { validateAnswerFiles } from '../src/mcp/answer-freshness';

const roots: string[] = [];
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-source-indexing-'));
  roots.push(root);
  return root;
}
function configure(root: string, maxSourceFileSizeBytes: unknown): void {
  fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ maxSourceFileSizeBytes }));
  clearProjectConfigCache();
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each([0, -1, 1.5, '2097152', null, true, Number.MAX_SAFE_INTEGER + 1])(
  'invalid source size %j retains the bounded default', value => {
    const root = project();
    configure(root, value);
    expect(limits.getMaxSourceFileSizeBytes(root)).toBe(limits.MAX_SOURCE_FILE_SIZE_BYTES);
  });

test('source limits are isolated by project and bound synchronous and async reads', async () => {
  const root = project(), other = project();
  const file = path.join(root, 'source.py');
  fs.writeFileSync(file, '#'.repeat(1048576) + '\ndef included(): return 42\n');
  configure(root, 3145728);
  expect(limits.getMaxSourceFileSizeBytes(root)).toBe(3145728);
  expect(limits.getMaxSourceFileSizeBytes(other)).toBe(limits.MAX_SOURCE_FILE_SIZE_BYTES);
  expect((await limits.readBoundedSource(file, limits.getMaxSourceFileSizeBytes(root))).bytes).not.toBeNull();
  expect(limits.readBoundedSourceSync(file, limits.getMaxSourceFileSizeBytes(root)).bytes).not.toBeNull();
  configure(root, 64);
  expect((await limits.readBoundedSource(file, limits.getMaxSourceFileSizeBytes(root))).bytes).toBeNull();
  expect(limits.readBoundedSourceSync(file, limits.getMaxSourceFileSizeBytes(root)).bytes).toBeNull();
  fs.unlinkSync(path.join(root, 'codegraph.json'));
  expect(limits.getMaxSourceFileSizeBytes(root)).toBe(limits.MAX_SOURCE_FILE_SIZE_BYTES);
});

test('committed limit changes recover unchanged skipped source and callers, then exclude it when lowered', async () => {
  const root = project();
  const source = path.join(root, 'source.py');
  fs.writeFileSync(source, '#'.repeat(2097252) + '\ndef included(): return 42\n');
  fs.writeFileSync(path.join(root, 'caller.py'), 'from source import included\ndef caller(): return included()\n');
  const oversized = path.join(root, 'oversized.py');
  const fd = fs.openSync(oversized, 'w');
  fs.ftruncateSync(fd, 4194305); fs.closeSync(fd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'CodeGraph Test');
  git('config', 'user.email', 'codegraph-test@example.invalid');
  git('add', '.'); git('commit', '-qm', 'source');
  const before = fs.statSync(source);
  configure(root, 1048576);
  const cg = await CodeGraph.init(root, { index: true });
  try {
    expect(cg.getFile('source.py')!.nodeCount).toBe(0);
    expect(cg.getSourceCoverage()).toEqual({ sizeExcludedFileCount: 2, maxSourceFileSizeBytes: 1048576 });
    configure(root, 4194304);
    git('add', 'codegraph.json'); git('commit', '-qm', 'raise limit');
    expect(cg.getChangedFiles().modified).toContain('source.py');
    // A background event scoped to an unrelated file must still reconcile the changed limit.
    await cg.sync({ paths: ['caller.py'] });
    expect(cg.getFile('source.py')!.nodeCount).toBeGreaterThan(0);
    expect(cg.getFile('oversized.py')!.nodeCount).toBe(0);
    const calls = cg.db.getDb().prepare(`SELECT count(*) AS count FROM edges e
      JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
      WHERE e.kind='calls' AND s.name='caller' AND t.name='included'`).get() as { count: number };
    expect(calls.count).toBeGreaterThan(0);
    expect(cg.getChangedFiles().modified).toEqual([]);
    // Touch-only changes must agree with the configured hash/read policy across surfaces.
    const record = cg.getFile('source.py')!;
    fs.utimesSync(source, new Date(), new Date(Date.now() + 5000));
    expect(hasDriftedOnDisk(root, 'source.py', record)).toBe(false);
    expect(await validateAnswerFiles(root, [{ path: 'source.py', contentHash: record.contentHash }])).toEqual({ stale: [], unchecked: [] });
    fs.utimesSync(source, before.atime, before.mtime);
    expect(fs.statSync(source).size).toBe(before.size);
    configure(root, 1048576);
    git('add', 'codegraph.json'); git('commit', '-qm', 'lower limit');
    expect(cg.getChangedFiles().modified).toContain('source.py');
    await cg.sync({ paths: ['caller.py'] });
    expect(cg.getFile('source.py')!.nodeCount).toBe(0);
    expect(cg.getNodesInFile('source.py')).toEqual([]);
    expect(cg.getSourceCoverage().sizeExcludedFileCount).toBe(2);
  } finally { cg.close(); }
}, 60000);

test('CLI and MCP status expose exclusions independently of a completed run', async () => {
  const root = project();
  configure(root, 128);
  fs.writeFileSync(path.join(root, 'small.py'), 'def visible(): return 42\n');
  fs.writeFileSync(path.join(root, 'large.py'), '#'.repeat(129));
  const cg = await CodeGraph.init(root, { index: true });
  try {
    const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
    const status = JSON.parse(execFileSync(process.execPath, ['--liftoff-only', bin, 'status', '--json', root], {
      encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, timeout: 60000,
    }));
    expect(status.index.state).toBe('complete');
    expect(status.fileCount).toBe(2);
    expect(status.coverage).toEqual({ sizeExcludedFileCount: 1, maxSourceFileSizeBytes: 128 });
    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_status', {});
    expect(result.content[0].text).toContain('**Files tracked:** 2');
    expect(result.content[0].text).toContain('**Files excluded by size:** 1');
    expect(result.content[0].text).toContain('**Source size limit:** 128 bytes');
    const explored = await handler.execute('codegraph_explore', { query: 'visible' });
    expect(explored.content[0].text).toContain('Coverage: 1 source file excluded by size');
    configure(root, 1024);
    await cg.sync();
    const recovered = await handler.execute('codegraph_explore', { query: 'visible' });
    expect(recovered.content[0].text).not.toContain('excluded by size');
  } finally { cg.close(); }
}, 60000);

test.each(['before', 'after'])('recovered source survives an oversized context line %s its definition', async position => {
  const root = project();
  const definition = 'def included(): return 42\n';
  const comment = '#'.repeat(30000) + '\n';
  configure(root, 128);
  fs.writeFileSync(path.join(root, 'source.py'), position === 'before' ? comment + definition : definition + comment);
  fs.writeFileSync(path.join(root, 'caller.py'), 'from source import included\ndef caller(): return included()\n');
  const cg = await CodeGraph.init(root, { index: true });
  try {
    const handler = new ToolHandler(cg);
    expect((await handler.execute('codegraph_explore', { query: 'included' })).content[0].text)
      .toContain('1 source file excluded by size');
    configure(root, 65536);
    await cg.sync();
    const text = (await handler.execute('codegraph_explore', { query: 'caller included' })).content[0].text;
    expect(text).toContain(definition.trim());
    expect(text).not.toContain('excluded by size');
    expect(text).not.toContain(comment.trim());
    expect(text.length).toBeLessThan(10000);
  } finally { cg.close(); }
}, 60000);

test('bulk indexing finishes while an independent reader retains its snapshot', async () => {
  const root = project();
  const state = new Int32Array(new SharedArrayBuffer(4));
  let worker: Worker | undefined;
  for (let n = 0; n < 4; n++) fs.writeFileSync(path.join(root, `source${n}.py`),
    Array.from({ length: 50 }, (_, i) => `def function_${n}_${i}(): return ${i}\n`).join(''));
  const cg = await CodeGraph.init(root);
  try {
    const result = await cg.indexAll({ onProgress: progress => {
      if (worker || progress.phase !== 'scanning') return;
      worker = new Worker(`
        const {workerData} = require('node:worker_threads');
        const {DatabaseSync} = require('node:sqlite');
        const state = new Int32Array(workerData.state);
        const db = new DatabaseSync(workerData.path, {readOnly:true});
        db.exec('BEGIN'); db.prepare('SELECT count(*) FROM nodes').get();
        Atomics.store(state,0,1); Atomics.notify(state,0);
        Atomics.wait(state,0,1,60000);
        db.exec('ROLLBACK'); db.close(); Atomics.store(state,0,3);
      `, { eval: true, workerData: { path: path.join(root, '.codegraph/codegraph.db'), state: state.buffer } });
      Atomics.wait(state, 0, 0, 10000);
      expect(Atomics.load(state, 0)).toBe(1);
      expect(cg.getJournalMode()).toBe('wal');
    }});
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.filesIndexed).toBe(4);
    expect(Atomics.load(state, 0)).toBe(1);
  } finally {
    Atomics.store(state, 0, 2); Atomics.notify(state, 0);
    if (worker) await worker.terminate();
    cg.close();
  }
}, 60000);
