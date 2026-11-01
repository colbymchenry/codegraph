/**
 * `codegraph orphans`' text-mention batches under each platform's argument
 * limit. Windows caps a whole process command line at 32,767 UTF-16
 * characters. The text-mention search passes its pattern beside a path batch of
 * up to 8 KiB (`batchPaths` in src/search/grep.ts), so a batch's pattern on
 * Windows must leave room for both. Elsewhere the pattern keeps its 64 KiB
 * budget.
 *
 * Pure: no index is built here. The orphans suites that index a repo spend most
 * of their time in beforeAll, and these checks need none of it.
 */
import { describe, expect, it } from 'vitest';
import * as orphans from '../src/graph/orphans';

/** 1,500 names of 96 bytes each: the same name shape the completeness suite indexes for its batch check. */
const MANY = 1500;
const manyName = (i: number): string => `m${'x'.repeat(91)}${String(i).padStart(4, '0')}`;
const names = Array.from({ length: MANY }, (_, i) => manyName(i));

/** Runs `run` with `process.platform` reading as `platform`, then restores the real value, also when `run` throws. */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return run();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}

describe('orphans mention batches on Windows', () => {
  it('on win32, each default batch pattern leaves room for the path batch, and every name lands in exactly one batch', () => {
    const batches = onPlatform('win32', () => orphans.mentionBatches(names));
    // 32,767 characters for the whole command line, less the 8,192-character path batch and 4,096 for the rest of it.
    const budget = 32_767 - 8_192 - 4_096;
    const longest = Math.max(...batches.map((b) => orphans.mentionPattern(b).length));
    expect(longest).toBeLessThanOrEqual(budget);
    expect(batches.flat()).toEqual(names);
  });
});

describe('orphans mention batches elsewhere', () => {
  it.each(['darwin', 'linux'] as const)('on %s, the default batches are the 64 KiB batches they were', (platform) => {
    const batches = onPlatform(platform, () => orphans.mentionBatches(names));
    expect(batches).toEqual(orphans.mentionBatches(names, 64 * 1024));
  });
});
