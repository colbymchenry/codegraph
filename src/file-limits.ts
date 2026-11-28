import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * Largest source file CodeGraph will parse or read during resolution. Generated
 * bundles, minified sources, and dependency archives above this limit provide no
 * useful symbols.
 *
 * It was 1 MB, on the reasoning that 1 MB covers essentially all hand-written
 * source. It does not: this repository's own src/resolution/name-matcher.ts is
 * 1.9 MB and 37,000 lines, and at 1 MB the graph held none of it. At 4 MB that
 * file is indexed and the generated parsers beside it (7 to 35 MB) still are
 * not. Files between the two, such as a 1.7 MB generated protobuf file, are now
 * indexed as well.
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = 4 * 1024 * 1024;

/**
 * What stands in for the content of a file over MAX_SOURCE_FILE_SIZE_BYTES. Such a file is
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
 * within the limit, the size stamp over it. Anything that checks a file on disk
 * against its stored `contentHash` has to hash this, or every unchanged file
 * over the limit reads as drifted. `content` is only read within the limit.
 */
export function indexedHashInput(size: number, content: () => string): string {
  return size > MAX_SOURCE_FILE_SIZE_BYTES ? oversizeStamp(size) : content();
}

/**
 * A source file's text, or null for what extraction wouldn't take: anything but
 * a regular file, or a file over the limit, which decoding could multiply into
 * gigabytes of heap. Checked on the open file: looking the path up twice is a
 * quarter of the read. O_NONBLOCK keeps a FIFO with no writer from parking the
 * open itself. Throws what a failed open or read throws.
 */
export function readSourceText(file: string, encoding: BufferEncoding = 'utf-8'): string | null {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return null;
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The longest run of name characters a pattern is given as written. No name,
 * path, number or chain of members is this long; a longer one is data: an
 * embedded asset, a key, a table of hex.
 */
export const LONGEST_NAME_RUN = 1024;

/** What a longer run reads as: no part of a name, no blank, no bracket and no quote. */
const RUN_FILL = '\u0001';

/** Whether a character code is a name's, or what joins names into one run: `A-Z a-z 0-9 _ $ . : / + = -`. */
const IN_NAME_RUN = (() => {
  const set = new Uint8Array(128);
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$.:/+=-') set[c.charCodeAt(0)] = 1;
  return set;
})();

/**
 * `text` with every run of name characters longer than LONGEST_NAME_RUN
 * blanked, at the same length: what the patterns that read a file for names
 * are given. Such a pattern starts a name at each character of a run and
 * reads to the run's end, so its time grows with the square of the run: one
 * 30 KB string of hex cost a second, and a megabyte of it eighteen minutes.
 * Returns `text` itself when it has no such run.
 */
export function withoutLongRuns(text: string): string {
  let parts: string[] | null = null;
  let copied = 0;
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 0;
    if (code < 128 && IN_NAME_RUN[code] === 1) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      if (i - start > LONGEST_NAME_RUN) {
        (parts ??= []).push(text.slice(copied, start), RUN_FILL.repeat(i - start));
        copied = i;
      }
      start = -1;
    }
  }
  if (!parts) return text;
  parts.push(text.slice(copied));
  return parts.join('');
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
export async function readBoundedSource(file: string): Promise<BoundedSource> {
  const initial = await fsp.stat(file);
  assertRegularFile(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat();
    assertRegularFile(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = await handle.stat();
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readBoundedSource}. */
export function readBoundedSourceSync(file: string): BoundedSource {
  const initial = fs.statSync(file);
  assertRegularFile(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd);
    assertRegularFile(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = fs.fstatSync(fd);
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    fs.closeSync(fd);
  }
}
