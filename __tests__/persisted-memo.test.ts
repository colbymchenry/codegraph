/**
 * The dominant-file and stats aggregates are shared across processes through a
 * sidecar next to the database, valid only under the current `graph_epoch`.
 * A stale or unreadable sidecar must recompute; every graph writer must make a
 * fresh process see its changes; and a sync warms the sidecar after a delay.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { getDatabasePath } from '../src/db';

const WARM_DELAY_FLOOR_MS = 10_000;

function chain(prefix: string, n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? `${prefix}${i + 1}();` : '';
    lines.push(`export function ${prefix}${i}(): void { ${next} }`);
  }
  return lines.join('\n') + '\n';
}

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

describe('persisted aggregate memo', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-memo-'));
    fs.mkdirSync(path.join(dir, 'core'));
    fs.mkdirSync(path.join(dir, 'ext'));
    fs.writeFileSync(path.join(dir, 'core', 'engine.ts'), chain('engineStep', 40));
    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 5));
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  async function freshProcess(): Promise<CodeGraph> {
    const cg = await CodeGraph.open(dir);
    open.push(cg);
    return cg;
  }

  const sidecar = () => getDatabasePath(dir) + '.memo.json';

  it.each([
    ['a stale stamp', () => JSON.stringify({ stamp: 'old', entries: { dominantFile: { filePath: 'bogus.ts', edgeCount: 99, nextEdgeCount: 0 } } })],
    ['a corrupt sidecar', () => '{not json'],
  ])('recomputes and repairs %s', async (_name, contents) => {
    const writer = await setup();
    writer.close();
    open.splice(0);
    fs.writeFileSync(sidecar(), contents());

    const reader = await freshProcess();
    expect(reader.getStats().fileCount).toBe(2);
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('core/engine.ts');

    const repaired = JSON.parse(fs.readFileSync(sidecar(), 'utf8')) as { entries: { dominantFile: { filePath: string } } };
    expect(repaired.entries.dominantFile.filePath).toBe('core/engine.ts');
  });

  it('shows a fresh process the graph after indexFiles', async () => {
    const writer = await setup();
    expect(queriesOf(await freshProcess()).getDominantFile()?.filePath).toBe('core/engine.ts');

    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));
    await writer.indexFiles(['ext/plugin.ts']);

    const reader = await freshProcess();
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('ext/plugin.ts');
  });

  it('warms the sidecar after a sync once the delay elapses', async () => {
    const writer = await setup();
    fs.writeFileSync(path.join(dir, 'ext', 'plugin.ts'), chain('pluginStep', 120));

    const realSetTimeout = global.setTimeout;
    const warmTimers: Array<() => void> = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (typeof ms === 'number' && ms >= WARM_DELAY_FLOOR_MS) {
        warmTimers.push(fn);
        return { unref() {} } as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    await writer.sync();
    vi.restoreAllMocks();

    expect(warmTimers).toHaveLength(1);
    warmTimers[0]!();

    const reader = await freshProcess();
    const compute = vi.spyOn(queriesOf(reader) as unknown as { computeDominantFile: () => unknown }, 'computeDominantFile');
    expect(queriesOf(reader).getDominantFile()?.filePath).toBe('ext/plugin.ts');
    expect(compute).not.toHaveBeenCalled();
  });

  it('shows a fresh process an empty graph after clear', async () => {
    const writer = await setup();
    expect(writer.getStats().nodeCount).toBeGreaterThan(0);

    writer.clear();

    expect((await freshProcess()).getStats().nodeCount).toBe(0);
  });
});
