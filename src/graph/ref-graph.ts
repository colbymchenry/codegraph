/**
 * The code graph of a git commit that is not checked out. The commit's tree is
 * exported with `git archive` into a cache directory and indexed there with the
 * normal pipeline, so extraction, resolution and framework detection behave
 * exactly as they do for a real project. Cached by commit sha: a second
 * comparison involving the same commit skips the index.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../index';
import { archiveCommit } from '../sync/git-refs';
import { buildSnapshot, type GraphSnapshot, type SnapshotNodeInput } from './graph-diff';

const DONE_MARKER = '.codegraph-ref-done';

export function refCacheRoot(): string {
  return process.env.CODEGRAPH_REF_CACHE || path.join(os.tmpdir(), 'codegraph-ref-cache');
}

function cacheDirFor(repoRoot: string, sha: string): string {
  const repoKey = crypto.createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 12);
  return path.join(refCacheRoot(), repoKey, sha.slice(0, 20));
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** Index `sha` (once) and return a snapshot of its graph. */
export async function snapshotOfCommit(
  repoRoot: string,
  sha: string,
  onProgress?: (message: string) => void,
): Promise<GraphSnapshot> {
  const dir = cacheDirFor(repoRoot, sha);
  const done = path.join(dir, DONE_MARKER);

  if (!fs.existsSync(done)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    onProgress?.(`exporting ${sha.slice(0, 8)}`);
    archiveCommit(repoRoot, sha, dir);
    onProgress?.(`indexing ${sha.slice(0, 8)}`);
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
    } finally {
      cg.destroy();
    }
    fs.writeFileSync(done, sha);
  } else {
    onProgress?.(`using cached index for ${sha.slice(0, 8)}`);
  }

  const cg = CodeGraph.openSync(dir, { readOnly: true });
  try {
    const { nodes, edges } = cg.getGraphContents();
    const lineCache = new Map<string, string[] | null>();
    const linesOf = (file: string): string[] | null => {
      if (lineCache.has(file)) return lineCache.get(file) ?? null;
      let lines: string[] | null = null;
      try {
        lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
      } catch {
        lines = null;
      }
      lineCache.set(file, lines);
      return lines;
    };
    const inputs: SnapshotNodeInput[] = nodes.map((n) => {
      const lines = linesOf(n.filePath);
      const bodyHash = lines ? sha1(lines.slice(n.startLine - 1, n.endLine).join('\n')) : undefined;
      return {
        id: n.id,
        kind: n.kind,
        name: n.name,
        qualifiedName: n.qualifiedName,
        filePath: n.filePath,
        startLine: n.startLine,
        signature: n.signature,
        returnType: n.returnType,
        visibility: n.visibility,
        isExported: n.isExported,
        isAsync: n.isAsync,
        isStatic: n.isStatic,
        isAbstract: n.isAbstract,
        decorators: n.decorators,
        bodyHash,
      };
    });
    return buildSnapshot(inputs, edges);
  } finally {
    cg.destroy();
  }
}
