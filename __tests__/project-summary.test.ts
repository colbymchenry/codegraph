/**
 * The shared project summary behind `codegraph_projects` and `codegraph
 * projects`. Both surfaces must open a project the same way and agree on what
 * "up to date" means, so the derivation is tested once here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { summarizeProject } from '../src/project-summary';

describe('summarizeProject', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-summary-'));
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
  });

  afterEach(() => {
    try {
      cg?.close();
    } catch {
      /* already closed */
    }
    cg = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports a freshly indexed project as up to date, with its stats and timestamp', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    const expected = cg.getStats();

    const summary = await summarizeProject(tempDir);

    expect(summary.projectPath).toBe(path.resolve(tempDir));
    expect(summary.indexPath).toBe(path.join(path.resolve(tempDir), '.codegraph'));
    expect(summary.status).toBe('up-to-date');
    expect(summary.pendingChanges).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(summary.stats).toEqual({
      fileCount: expected.fileCount,
      nodeCount: expected.nodeCount,
      edgeCount: expected.edgeCount,
    });
    expect(summary.stats!.fileCount).toBeGreaterThan(0);
    expect(summary.lastIndexedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(summary.lastIndexedAt!))).toBe(false);
  });

  it('reports pending working-tree changes as out of date', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.close();
    cg = null;

    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 10; }\n'
    );

    const summary = await summarizeProject(tempDir);
    expect(summary.status).toBe('out-of-date');
    expect(summary.pendingChanges).toEqual({ added: 0, modified: 1, removed: 0 });
  });

  it('reports a registered path whose index is gone as not indexed', async () => {
    const summary = await summarizeProject(tempDir);
    expect(summary.status).toBe('not-indexed');
    expect(summary.stats).toBeNull();
    expect(summary.lastIndexedAt).toBeNull();
  });

  it('passes registeredAt through', async () => {
    const summary = await summarizeProject(tempDir, { registeredAt: '2026-01-01T00:00:00.000Z' });
    expect(summary.registeredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a timed-out change measurement is unknown, never zero', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });

    const summary = await summarizeProject(tempDir, { measureChanges: async () => null });

    expect(summary.status).toBe('unknown');
    expect(summary.pendingChanges).toBeNull();
    // The stats still come from the index, so the project remains useful.
    expect(summary.stats!.fileCount).toBeGreaterThan(0);
  });

  it('uses the supplied measureChanges instead of the in-process scan', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });
    let calledWith: string | null = null;

    const summary = await summarizeProject(tempDir, {
      measureChanges: async (root) => {
        calledWith = root;
        return { added: 2, modified: 0, removed: 0 };
      },
    });

    expect(calledWith).toBe(path.resolve(tempDir));
    expect(summary.status).toBe('out-of-date');
    expect(summary.pendingChanges).toEqual({ added: 2, modified: 0, removed: 0 });
  });

  it('a failing change measurement becomes an error status, not a throw', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });

    const summary = await summarizeProject(tempDir, {
      measureChanges: async () => {
        throw new Error('worker exploded');
      },
    });

    expect(summary.status).toBe('error');
    expect(summary.error).toBe('worker exploded');
  });

  it('does not close a reused instance', async () => {
    cg = await CodeGraph.init(tempDir, { index: true });

    const summary = await summarizeProject(tempDir, { reuse: cg });
    expect(summary.status).toBe('up-to-date');

    // A closed instance would throw here; the caller still owns it.
    expect(() => cg!.getStats()).not.toThrow();
  });
});
