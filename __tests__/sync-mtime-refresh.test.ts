/**
 * Sync stat pre-filter: a file whose mtime moved but whose content did not
 * (a fresh checkout, a copied index, `touch`) is read and hashed once, and
 * the sync records its new size and mtime so the next sync skips it unread.
 * Each of those stat-only writes commits on its own, so each one goes through
 * the WAL valve's writer-side check like a re-indexed file does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { WalCheckpointValve } from '../src/db/wal-valve';

// A plain-object copy of `fs` shared by this file and every module it loads,
// so vi.spyOn(fs, 'openSync') reaches the engine's reads (an ESM namespace
// cannot be spied on).
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

describe('sync refreshes the stat of an unchanged file', () => {
  let testDir: string;
  let cg: CodeGraph;
  let filePath: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-mtime-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    filePath = path.join(testDir, 'src', 'index.ts');
    fs.writeFileSync(filePath, `export function hello() { return 'world'; }`);
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reads a touched file on the first sync and not on the second', async () => {
    // Sync reads a file's bytes through fs.openSync (readBoundedSourceSync);
    // count the opens of this one file.
    const realOpen = fs.openSync;
    let opens = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.resolve(filePath)) opens++;
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);

    // A new mtime, the same bytes.
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(filePath, later, later);

    const first = await cg.sync();
    expect(first.filesModified).toBe(0);
    expect(opens).toBeGreaterThan(0);

    opens = 0;
    const second = await cg.sync();
    expect(second.filesModified).toBe(0);
    expect(opens).toBe(0);
  });

  it('checks the WAL valve after every stat-only refresh', async () => {
    const extra = ['a', 'b'].map((n) => path.join(testDir, 'src', `${n}.ts`));
    for (const f of extra) fs.writeFileSync(f, `export const v = 1;`);
    await cg.sync();

    const backpressure = vi
      .spyOn(WalCheckpointValve.prototype, 'backpressure')
      .mockReturnValue(null);

    // Three tracked files get a new mtime and keep their bytes.
    const later = new Date(Date.now() + 240_000);
    for (const f of [filePath, ...extra]) fs.utimesSync(f, later, later);

    const result = await cg.sync();
    expect(result.filesModified).toBe(0);
    expect(backpressure).toHaveBeenCalledTimes(3);

    // Nothing left to refresh: the next sync writes nothing and asks nothing.
    backpressure.mockClear();
    await cg.sync();
    expect(backpressure).not.toHaveBeenCalled();
  });
});
