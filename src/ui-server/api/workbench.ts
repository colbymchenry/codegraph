import { createHash } from 'node:crypto';
import type CodeGraph from '../../index';
import { badRequest, intParam, notFound } from './respond';
import { normalizeRoot } from './map';
import { toNodeRef, toWireEdge } from './wire';

export { workbenchRevision } from './revision';
import { workbenchRevision } from './revision';

interface Cursor { revision: string; query: string; after: string | number }
function decode(raw: string | null, revision: string, query: string): string | number | null {
  if (!raw) return null;
  let cursor: Cursor;
  try {
    if (raw.length > 4096) throw new Error();
    cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!cursor || typeof cursor !== 'object') throw new Error();
  } catch { throw badRequest('分页游标无效，请重新加载列表。'); }
  if (cursor.revision !== revision) throw badRequest('索引已经更新，请重新加载列表。');
  if (cursor.query !== query) throw badRequest('分页游标与当前查询不匹配。');
  return cursor.after;
}

/** null 表示不是新增工作台端点，让既有 API 继续分发。 */
export function dispatchWorkbench(cg: CodeGraph, root: string, route: string, query: URLSearchParams): unknown | null {
  if (route !== '/api/browse' && route !== '/api/neighbors') return null;
  const revision = workbenchRevision(root);
  const limit = intParam(query, 'limit', { min: 1, max: 200, default: 50 });
  const normalized = new URLSearchParams(query); normalized.delete('cursor'); normalized.delete('bounded'); normalized.sort();
  const signature = createHash('sha256').update(route).update(normalized.toString()).digest('hex');
  const after = decode(query.get('cursor'), revision, signature);
  let rows: Array<{ key: string | number; item: unknown }>;
  if (route === '/api/neighbors') {
    const id = query.get('id');
    const direction = query.get('direction') ?? 'out';
    if (!id || (direction !== 'in' && direction !== 'out')) throw badRequest('请选择节点及关系方向。');
    if (after !== null && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)) throw badRequest('关系游标无效。');
    if (!cg.getNode(id)) throw notFound('该节点已不在索引中，请重新选择。');
    rows = cg.getUiNeighborPage(id, direction, after as number ?? 0, limit + 1)
      .map(row => ({ key: row.key, item: { edge: toWireEdge(row.edge), node: toNodeRef(row.node) } }));
  } else {
    const rawRoot = query.get('root') ?? '';
    if (/^[\\/]|^[A-Za-z]:/.test(rawRoot) || rawRoot.replace(/\\/g, '/').split('/').includes('..')) throw badRequest('目录必须是项目内相对路径。');
    const directory = normalizeRoot(rawRoot);
    const kind = query.get('kind') ?? 'directories';
    if (after !== null && typeof after !== 'string') throw badRequest('目录游标无效。');
    if (kind === 'symbols') {
      rows = cg.getUiSymbolPage(directory, after as string ?? '', limit + 1)
        .map(node => ({ key: node.id, item: { kind: 'symbol', path: node.filePath, name: node.name, node: toNodeRef(node) } }));
    } else if (kind === 'directories' || kind === 'files') {
      rows = cg.getUiBrowsePage(directory, kind, after as string ?? '', limit + 1)
        .map(row => ({ key: row.path, item: row }));
    } else throw badRequest('列表类型必须为 directories、files 或 symbols。');
  }
  if (workbenchRevision(root) !== revision) throw badRequest('索引在查询期间更新，请重新加载列表。');
  const shown = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ revision, query: signature, after: shown.at(-1)!.key })).toString('base64url') : null;
  return { items: shown.map(row => row.item), nextCursor, revision };
}
