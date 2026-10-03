import type { CodeGraph } from '../../index';
import { intParam } from './respond';
import { MAX_EVENT_FILES, type EventProbeResult } from './events';

/** SSE 所需的有界索引状态，在工作区查询 Worker 中执行。 */
export function buildIndexRevision(cg: CodeGraph, query: URLSearchParams): EventProbeResult {
  const since = query.has('since') ? intParam(query, 'since', { min: 0, max: Number.MAX_SAFE_INTEGER }) : null;
  const revision = cg.getIndexRevision();
  const changed = since === null ? { paths: [], total: 0 } : cg.getFilesIndexedSince(since, MAX_EVENT_FILES);
  return { index: { lastIndexedAt: revision.lastIndexedAt, files: revision.fileCount }, files: changed.paths, total: changed.total };
}
