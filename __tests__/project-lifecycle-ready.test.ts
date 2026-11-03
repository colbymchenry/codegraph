/**
 * A project owner whose readiness publication failed publishes again on the
 * next access: the failed publication must not count as the catch-up being
 * done, or `writer.pid` stays at `ready: false` until the project is released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { acquireProject } from '../src/mcp/project-lifecycle';
import * as writer from '../src/mcp/writer-lock';

vi.mock('../src/mcp/writer-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/writer-lock')>();
  return { ...actual, markWriterReady: vi.fn(actual.markWriterReady) };
});

describe('project readiness publication', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-ready-'));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export function hello() { return 1; }\n');
    CodeGraph.initSync(root).close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retries publication on the next ready() after the barrier timed out', async () => {
    const markWriterReady = vi.mocked(writer.markWriterReady);
    markWriterReady.mockImplementationOnce(() => {
      throw new Error('Timed out publishing writer readiness');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lease = acquireProject(root, () => CodeGraph.openSync(root), {});
    try {
      await lease.ready();
      expect(markWriterReady).toHaveBeenCalledTimes(1);
      expect(writer.readWriterLock(root)).toMatchObject({ pid: process.pid, ready: false });
      expect(stderr.mock.calls.some(([line]) => String(line).includes('Timed out publishing writer readiness'))).toBe(true);

      await lease.ready();
      expect(markWriterReady).toHaveBeenCalledTimes(2);
      expect(writer.readWriterLock(root)).toMatchObject({ pid: process.pid, ready: true });

      // Published: later accesses do not publish again.
      await lease.ready();
      expect(markWriterReady).toHaveBeenCalledTimes(2);
    } finally {
      await lease.release();
    }
  });
});
