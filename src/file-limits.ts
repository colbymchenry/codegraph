/**
 * Largest source file CodeGraph will parse or read during resolution. Generated
 * bundles, minified sources, and dependency archives above this limit provide no
 * useful symbols; 1 MB covers essentially all hand-written source.
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

export interface BoundedSource { stats: fs.Stats; bytes: Buffer | null }
const CHUNK = 64 * 1024;
function regular(stats: fs.Stats): void {
  if (!stats.isFile()) throw new Error('Source path is not a regular file');
}

/** Bound the read itself, including growth after stat. Null bytes mean oversized. */
export async function readBoundedSource(file: string): Promise<BoundedSource> {
  const initial = await fsp.stat(file); regular(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat(); regular(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = []; let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); size += bytesRead;
    }
    stats = await handle.stat();
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size); return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally { await handle.close(); }
}

export function readBoundedSourceSync(file: string): BoundedSource {
  const initial = fs.statSync(file); regular(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd); regular(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = []; let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const n = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!n) break;
      chunks.push(chunk.subarray(0, n)); size += n;
    }
    stats = fs.fstatSync(fd);
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size); return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally { fs.closeSync(fd); }
}
