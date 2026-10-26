import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { LockUnavailableError } from '../src';
import type { ExtractionOrchestrator } from '../src/extraction';

/**
 * `CodeGraph.indexFiles` holds the cross-process write lock until its files
 * are stored, as `indexAll` and `sync` do: another process's sync or index of
 * the same project is refused while it runs, and admitted after. It used to
 * return the indexing promise from inside the `try` whose `finally` releases
 * the lock, so the lock was gone as soon as indexing started. A second handle
 * on the project stands in for the other process: the lock file names a live
 * PID, this one, so its acquire refuses as another process's would.
 */
describe('indexFiles holds the write lock while it indexes', () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const cg of graphs.splice(0)) cg.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /**
   * An indexed project whose one file was then edited, a gate its next
   * indexFiles waits at before indexing, and a second handle on it.
   */
  async function editedProjectWithGatedIndexing(fail = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-files-lock-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function before() { return 1; }\n');
    const cg = CodeGraph.initSync(dir);
    graphs.push(cg);
    await cg.indexAll();
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function after() { return 2; }\n');

    const orchestrator = (cg as unknown as { orchestrator: ExtractionOrchestrator }).orchestrator;
    const real = orchestrator.indexFiles.bind(orchestrator);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const indexing = vi.spyOn(orchestrator, 'indexFiles').mockImplementation(async (filePaths) => {
      await gate;
      if (fail) throw new Error('extraction failed');
      return real(filePaths);
    });
    const other = CodeGraph.openSync(dir);
    graphs.push(other);
    return { cg, other, indexing, open };
  }

  it('refuses another writer until the files are indexed', async () => {
    const { cg, other, indexing, open } = await editedProjectWithGatedIndexing();
    const run = cg.indexFiles(['src/a.ts']);
    await vi.waitFor(() => expect(indexing).toHaveBeenCalled());

    // Indexing is under way: another process's sync must wait its turn.
    await expect(other.sync()).rejects.toBeInstanceOf(LockUnavailableError);

    open();
    const result = await run;
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(cg.getNodesByName('after')).toHaveLength(1);
    // Done: the next writer gets in.
    await expect(other.sync()).resolves.toBeDefined();
  });

  it('lets the lock go when indexing fails', async () => {
    const { cg, other, open } = await editedProjectWithGatedIndexing(true);
    const run = cg.indexFiles(['src/a.ts']);
    open();
    await expect(run).rejects.toThrow('extraction failed');
    await expect(other.sync()).resolves.toBeDefined();
  });
});
