import * as fs from 'fs';
import * as fsp from 'fs/promises';
import type { ExtractionError } from './types';

/**
 * Largest source file CodeGraph parses or reads during resolution, unless the
 * project's `codegraph.json` sets `maxFileSize` (see `loadMaxFileSize` in
 * project-config.ts). Generated bundles, minified sources, and dependency
 * archives above this limit provide no useful symbols; 1 MB covers essentially
 * all hand-written source.
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;

/**
 * The highest `maxFileSize` a project can set. Indexing parses on threads and
 * in wasm memory sized for source, under a per-file parse budget; a limit far
 * past real source brings back the bundles and blobs the default keeps out.
 */
export const MAX_FILE_SIZE_CEILING_BYTES = 16 * 1024 * 1024;

/**
 * What stands in for the content of a file over the size limit. Such a file is
 * never parsed, so its bytes are never needed — reading them only to hash and
 * discard cost multi-GB RSS spikes on committed video/blob fixtures and could
 * fail outright with `Invalid string length` (#1910). The stamp is a function
 * of size alone: change detection compares it to the stored hash, so a
 * same-size rewrite of an oversize file is not a change (nothing about it is
 * indexed), while crossing the limit in either direction is.
 */
export function oversizeStamp(size: number): string {
  return `codegraph:oversize:${size}`;
}

/**
 * The text whose hash the index stores for a file of `size` bytes: its content
 * within `limit`, the size stamp over it. Anything that checks a file on disk
 * against its stored `contentHash` has to hash this, or every unchanged file
 * over the limit reads as drifted. `content` is only read within the limit.
 */
export function indexedHashInput(size: number, limit: number, content: () => string): string {
  return size > limit ? oversizeStamp(size) : content();
}

/**
 * Whether the index stored a file as over the size limit: such a row keeps its
 * `size_exceeded` reason. Compared with the limit in force now, it tells a sync
 * that a file crossed a changed `maxFileSize` even though its bytes did not change.
 */
export function storedOverSizeLimit(errors: readonly ExtractionError[] | undefined): boolean {
  return !!errors && errors.some((e) => e.code === 'size_exceeded');
}

/**
 * A source file's text, or null for what extraction wouldn't take: anything but
 * a regular file, or a file over the limit, which decoding could multiply into
 * gigabytes of heap. Checked on the open file: looking the path up twice is a
 * quarter of the read. O_NONBLOCK keeps a FIFO with no writer from parking the
 * open itself. Throws what a failed open or read throws.
 */
export function readSourceText(file: string, limit: number, encoding: BufferEncoding = 'utf-8'): string | null {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > limit) return null;
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

/** A source file's stats, and its bytes when they are within the limit (null = oversize). */
export interface BoundedSource {
  stats: fs.Stats;
  bytes: Buffer | null;
}

const READ_CHUNK_BYTES = 64 * 1024;

function assertRegularFile(stats: fs.Stats): void {
  if (!stats.isFile()) throw new Error('Source path is not a regular file');
}

/**
 * Read a source file without ever holding more than the limit plus one byte.
 * A stat before the read is not enough: the file can grow between the stat
 * and the read (a log, a download, a build output being written), so the
 * descriptor is re-checked after opening and the read itself stops one byte
 * past the limit. Returns `bytes: null` for an oversize file.
 */
export async function readBoundedSource(file: string, limit: number): Promise<BoundedSource> {
  const initial = await fsp.stat(file);
  assertRegularFile(initial);
  if (initial.size > limit) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat();
    assertRegularFile(stats);
    if (stats.size > limit) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = await handle.stat();
    if (size > limit || stats.size > limit) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readBoundedSource}. */
export function readBoundedSourceSync(file: string, limit: number): BoundedSource {
  const initial = fs.statSync(file);
  assertRegularFile(initial);
  if (initial.size > limit) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd);
    assertRegularFile(stats);
    if (stats.size > limit) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - size));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = fs.fstatSync(fd);
    if (size > limit || stats.size > limit) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    fs.closeSync(fd);
  }
}
