/**
 * Whether files changed on disk after they were last indexed — the one check
 * behind the MCP tools' stale-slice gate (#1474) and the warning the CLI's
 * `callers`, `callees` and `impact` print (#3260). Line numbers come from the
 * index; once a file's bytes move on, they can point at other code.
 *
 * Kept light: the CLI's read commands load it, so it reaches for nothing but
 * the files table and the file on disk (no extraction, no MCP tools).
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { indexedHashInput } from '../file-limits';
import { loadMaxFileSize } from '../project-config';
import { lexicalPathWithinRoot, validatePathWithinRoot } from '../utils';

/** What the check reads from an open index. */
export interface DriftIndex {
  getProjectRoot(): string;
  getFile(filePath: string): { size: number; modifiedAt: number; contentHash: string } | null;
}

/**
 * How `relPath` on disk compares with the version the index holds:
 * - `current`: the same bytes;
 * - `changed`: other bytes, so indexed line ranges may point at other code;
 * - `missing`: indexed, and gone from disk;
 * - `unknown`: not in the index, outside the project, or unreadable.
 *
 * One stat per file, the sync fast path's test (equal size and floored mtime
 * means unchanged). Only a mismatch reads and hashes the file, sha256 over its
 * UTF-8 text as extraction's `hashContent` does (mcp-stale-slice.test.ts pins
 * the parity), so a checkout that rewrote identical bytes is still `current`.
 * A file over the index's size limit is stored as its size stamp (#1910) and
 * compared as one, without a read. `content`, when the caller already holds
 * the file's text, saves that read.
 *
 * The stat goes by the lexical path, which reads no bytes. The link-following
 * check that keeps a read inside the project (#527) costs about a millisecond
 * a file on Windows, so only a file that has to be read pays it.
 */
export function fileDrift(index: DriftIndex, relPath: string, content?: string): 'current' | 'changed' | 'missing' | 'unknown' {
  try {
    const rec = index.getFile(relPath);
    if (!rec) return 'unknown';
    const root = index.getProjectRoot();
    const lexical = lexicalPathWithinRoot(root, relPath);
    if (!lexical) return 'unknown';
    if (!existsSync(lexical)) return 'missing';
    const st = statSync(lexical);
    if (st.size === rec.size && Math.floor(st.mtimeMs) === Math.floor(rec.modifiedAt)) return 'current';
    const absPath = validatePathWithinRoot(root, relPath);
    if (!absPath) return 'unknown';
    const data = indexedHashInput(st.size, loadMaxFileSize(root), () => content ?? readFileSync(absPath, 'utf-8'));
    return createHash('sha256').update(data).digest('hex') === rec.contentHash ? 'current' : 'changed';
  } catch {
    return 'unknown';
  }
}

/**
 * The files among `paths` whose indexed line numbers can no longer be trusted
 * (changed or gone since their last index), each once, in first-seen order.
 */
export function filesChangedSinceIndexed(index: DriftIndex, paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const filePath of paths) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const drift = fileDrift(index, filePath);
    if (drift === 'changed' || drift === 'missing') out.push(filePath);
  }
  return out;
}
