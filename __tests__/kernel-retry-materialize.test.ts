/**
 * Kernel results must be DECODED before they are persisted (#1541).
 *
 * The bulk-index parse workers return kernel extractions as an undecoded
 * buffer transport: `nodes`/`edges`/`unresolvedReferences` are EMPTY and the
 * real tables ride in `kernelBuffers`. The main loop decodes (or hands the
 * buffers to the store worker), but indexAll's retry passes used to store the
 * transport as-is — the storage gate passed via `errors.length === 0`, zero
 * nodes were inserted, and the file was permanently recorded as
 * "(0 symbols)" with the retry counted as a success. Any worker
 * crash/timeout whose in-flight file was a kernel-routed language silently
 * wiped that file's symbols (issue #1541: v1.5.0 indexes a valid Python file
 * as 0 symbols; v1.4.1, pre-kernel, indexed it correctly).
 *
 * This pins the store boundary: storeExtractionResult must materialize a
 * buffer-transport result before persisting, so every caller — including the
 * retry passes — stores the real nodes.
 *
 * Skips when no kernel binary is staged (same gating as the parity suites).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtractRaw } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

describe.skipIf(!kernelBuilt)('kernel buffer-transport storage (#1541)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-retry-mat-'));
    cg = await CodeGraph.init(dir);
    await initGrammars();
    await loadGrammarsForLanguages(['python']);
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('storeExtractionResult persists the decoded nodes of a raw kernel result', async () => {
    const source =
      'def target_fn(root, mission_path):\n' +
      '    return (root, mission_path)\n' +
      '\n' +
      'class Adapter:\n' +
      '    def adapt(self):\n' +
      '        return target_fn(1, 2)\n';
    const filePath = 'adapter.py';
    fs.writeFileSync(path.join(dir, filePath), source);

    // A genuine undecoded transport, exactly as parse-worker builds it.
    const raw = tryKernelExtractRaw(filePath, source, 'python');
    expect(raw).not.toBeNull();
    expect(raw!.counts.nodes).toBeGreaterThan(0);
    const transport: ExtractionResult = {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: raw!.errors,
      durationMs: 0,
      kernelBuffers: raw!.buffers,
      kernelCounts: raw!.counts,
    };

    const stats = fs.statSync(path.join(dir, filePath));
    const orchestrator = (cg as unknown as { orchestrator: { storeExtractionResult(f: string, c: string, l: string, s: fs.Stats, r: ExtractionResult): Promise<void> } }).orchestrator;
    await orchestrator.storeExtractionResult(filePath, source, 'python', stats, transport);

    // The files row must carry the real symbol count, not the transport's
    // empty array — a 0 here is the #1541 "(python, 0 symbols)" wipe.
    const file = cg.getFile(filePath);
    expect(file).not.toBeNull();
    expect(file!.nodeCount).toBe(raw!.counts.nodes);

    // And the nodes themselves must be queryable.
    const nodes = cg.getNodesInFile(filePath);
    expect(nodes.length).toBe(raw!.counts.nodes);
    expect(nodes.map((n) => n.name)).toContain('target_fn');
    expect(nodes.map((n) => n.name)).toContain('Adapter');
  });
});

/**
 * Self-heal for rows the released bug already wiped: a files row recorded
 * with zero nodes on a symbol-bearing language can only be a #1541 casualty
 * (every real extraction stores at least the file node), and its content
 * hash matches the on-disk bytes, so hash-based reconciles skip it forever.
 * The full-reconcile sync and indexAll now drop such rows so the file
 * re-indexes. Kernel-independent — the wipe is simulated at the DB.
 */
describe('zero-node row self-heal (#1541)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-node-heal-'));
    fs.writeFileSync(
      path.join(dir, 'adapter.py'),
      'def target_fn(root, mission_path):\n' +
        '    return (root, mission_path)\n' +
        '\n' +
        'class Adapter:\n' +
        '    def adapt(self):\n' +
        '        return target_fn(1, 2)\n'
    );
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sync repairs a wiped row even though the content hash is unchanged', async () => {
    const before = cg.getFile('adapter.py');
    expect(before).not.toBeNull();
    expect(before!.nodeCount).toBeGreaterThan(0);

    // Simulate the released-v1.5.0 wipe: nodes gone, row says 0 symbols,
    // content hash still matching the file on disk.
    const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { run(...args: unknown[]): unknown } } } }).db.getDb();
    db.prepare('DELETE FROM nodes WHERE file_path = ?').run('adapter.py');
    db.prepare('UPDATE files SET node_count = 0 WHERE path = ?').run('adapter.py');
    expect(cg.getFile('adapter.py')!.nodeCount).toBe(0);

    await cg.sync();

    const after = cg.getFile('adapter.py');
    expect(after).not.toBeNull();
    expect(after!.nodeCount).toBe(before!.nodeCount);
    expect(cg.getNodesInFile('adapter.py').map((n) => n.name)).toContain('target_fn');
  });
});
