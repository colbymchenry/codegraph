/**
 * Build the file-level graph payload for the visual HTML export.
 */

import type { QueryBuilder } from '../db/queries';
import { FILE_LINK_CAP, type VisualGraph, type VisualLink, type VisualNode, type VisualPayload } from './types';

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const i = normalized.lastIndexOf('/');
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

function buildFileGraph(queries: QueryBuilder, linkCap: number = FILE_LINK_CAP): VisualGraph {
  const files = queries.getAllFiles();
  const nodes: VisualNode[] = files.map((f) => ({
    id: f.path,
    name: basename(f.path),
    kind: 'file',
    path: f.path,
  }));
  const nodeIds = new Set(nodes.map((n) => n.id));

  const seen = new Set<string>();
  const links: VisualLink[] = [];
  for (const link of queries.getCrossFileLinks(linkCap)) {
    if (!nodeIds.has(link.source) || !nodeIds.has(link.target)) continue;
    const key = `${link.source}\0${link.target}\0${link.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: link.source, target: link.target, kind: link.kind });
  }

  return { nodes, links };
}

/**
 * Build the visual payload from an open QueryBuilder.
 */
export function buildVisualPayload(queries: QueryBuilder): VisualPayload {
  return buildFileGraph(queries);
}
