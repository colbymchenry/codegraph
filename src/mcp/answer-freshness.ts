import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { MAX_SOURCE_FILE_SIZE_BYTES, oversizeStamp } from '../file-limits';
import { validatePathWithinRoot } from '../utils';

export interface AnswerFile {
  path: string;
  /** The indexed version used to build the answer, even across a worker hop. */
  contentHash: string | null;
}

/** Limits apply to the entire answer; exceeding any of them refuses it. */
const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MS = 250;

export async function validateAnswerFiles(root: string, files: AnswerFile[]): Promise<{
  stale: string[];
  unchecked: string[];
}> {
  const stale: string[] = [];
  const unchecked: string[] = [];
  const signal = AbortSignal.timeout(MAX_MS);
  let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (i >= MAX_FILES || bytes >= MAX_BYTES || signal.aborted) {
      unchecked.push(...files.slice(i).map(f => f.path));
      break;
    }
    if (!file.contentHash) {
      unchecked.push(file.path);
      continue;
    }
    try {
      const hash = createHash('sha256');
      const absolute = validatePathWithinRoot(root, file.path);
      if (!absolute) { stale.push(file.path); continue; }
      // A file over the index's size limit is stored as its size stamp
      // (#1910): when the stamp still matches, the file is current without
      // being read. Anything else falls through to the bounded read below.
      const { size } = await stat(absolute);
      if (size > MAX_SOURCE_FILE_SIZE_BYTES &&
          createHash('sha256').update(oversizeStamp(size)).digest('hex') === file.contentHash) {
        continue;
      }
      const stream = createReadStream(absolute, {
        encoding: 'utf8', highWaterMark: 64 * 1024, signal,
      });
      let complete = true;
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) { complete = false; break; }
        hash.update(chunk);
      }
      if (!complete) unchecked.push(file.path);
      else if (hash.digest('hex') !== file.contentHash) stale.push(file.path);
    } catch {
      // Timeout is unknown, never a clean bill of health. A missing or
      // unreadable contributing file cannot support the indexed answer.
      (signal.aborted ? unchecked : stale).push(file.path);
    }
  }
  return { stale, unchecked };
}
