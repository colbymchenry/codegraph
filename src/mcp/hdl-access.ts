import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validatePathWithinRoot } from '../utils';

export const HDL_ACCESS_FILTERS = ['read', 'write', 'readwrite', 'control', 'event', 'all'] as const;
export type HdlAccessFilter = typeof HDL_ACCESS_FILTERS[number];
const ACCESS_KINDS = new Set<string>(['read', 'write', 'readwrite', 'control', 'event']);

export function hdlAccessKinds(edge: Edge): string[] {
  const value = edge.metadata?.hdlAccess;
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && ACCESS_KINDS.has(v)))].sort() : [];
}
function matches(kinds: string[], filter: HdlAccessFilter): boolean {
  if (filter === 'all') return kinds.length > 0;
  if (filter === 'read') return kinds.some(k => ['read', 'readwrite', 'control', 'event'].includes(k));
  if (filter === 'write') return kinds.some(k => k === 'write' || k === 'readwrite');
  if (filter === 'readwrite') return kinds.includes('readwrite') || (kinds.includes('read') && kinds.includes('write'));
  return kinds.includes(filter);
}

/** Exact HDL signal access sites, using raw edges rather than neighbour-deduped callers. */
export function formatHdlAccess(cg: CodeGraph, query: string, filter: HdlAccessFilter, maxFiles = 12): string {
  const name = query.trim();
  const exact = name.includes('::') ? cg.getNodesByQualifiedName(name) : cg.getNodesByName(name);
  const matchesByName = exact.length || !name.includes('.') || name.includes('\\')
    ? exact : cg.getNodesByQualifiedName(name.replace(/\./g, '::'));
  const targets = matchesByName
    .filter(n => n.language === 'verilog' && ['field', 'variable', 'constant'].includes(n.kind))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName));
  if (!targets.length) return `No exact HDL signal matches "${name}". Use one signal name or qualified name (for example top::data).`;
  const lines = [`**HDL access: ${name} — ${filter}**`,
    'Source occurrences only: read includes control/event uses; write follows a syntactic assignment/update or a known callable formal\'s argument direction, not an elaborated driver or timing result.'];
  const sourceCache = new Map<string, string[] | null>();
  let snippetBudget = 12000, shownSites = 0, totalSites = 0, unclassified = 0;
  const sourceLines = (file: string): string[] | null => {
    if (sourceCache.has(file)) return sourceCache.get(file)!;
    if (sourceCache.size >= maxFiles) return null;
    let source: string[] | null = null;
    try {
      const record = cg.getFile(file);
      const absolute = validatePathWithinRoot(cg.getProjectRoot(), file);
      if (record && absolute) {
        const before = statSync(absolute);
        if (before.size === record.size && Math.floor(before.mtimeMs) === Math.floor(record.modifiedAt)) {
          const text = readFileSync(absolute, 'utf8');
          const after = statSync(absolute);
          // Same SHA-256 over UTF-8 text as extraction's hashContent. Avoid
          // importing the heavy extraction module on the MCP tools/list path.
          const hash = createHash('sha256').update(text).digest('hex');
          if (before.size === after.size && before.mtimeMs === after.mtimeMs && hash === record.contentHash) source = text.split(/\r?\n/);
        }
      }
    } catch { /* A missing or changed file must never be presented as the indexed occurrence. */ }
    sourceCache.set(file, source);
    return source;
  };
  for (const target of targets) {
    const sites: { edge: Edge; owner: Node; kinds: string[] }[] = [];
    for (const edge of cg.getIncomingEdges(target.id)) {
      if (edge.kind !== 'references') continue;
      const owner = cg.getNode(edge.source);
      if (!owner || owner.language !== 'verilog') continue;
      const kinds = hdlAccessKinds(edge);
      if (!kinds.length) { unclassified++; continue; }
      if (matches(kinds, filter)) sites.push({ edge, owner, kinds });
    }
    sites.sort((a, b) => a.owner.filePath.localeCompare(b.owner.filePath) || (a.edge.line ?? 0) - (b.edge.line ?? 0) || (a.edge.column ?? 0) - (b.edge.column ?? 0) || a.owner.qualifiedName.localeCompare(b.owner.qualifiedName));
    totalSites += sites.length;
    const definitionVerified = sourceLines(target.filePath) !== null;
    lines.push('', `**${target.qualifiedName}** — ${target.filePath}:${target.startLine}`, `${sites.length} matching access site(s).`);
    if (!definitionVerified) lines.push('Definition location is from the index; current source is unverified (changed/unavailable or maxFiles reached).');
    for (const { edge, owner, kinds } of sites) {
      if (shownSites >= 60) continue;
      shownSites++;
      lines.push(`- [${kinds.join(', ')}] ${owner.qualifiedName} — ${owner.filePath}:${edge.line ?? owner.startLine}${typeof edge.column === 'number' ? `:${edge.column + 1}` : ''}`);
      const callableId = edge.metadata?.hdlCallTargetId, formalId = edge.metadata?.hdlFormalId;
      if (typeof callableId === 'string' && typeof formalId === 'string') {
        const callable = cg.getNode(callableId), formal = cg.getNode(formalId);
        const direction = formal?.decorators?.find(d => d.startsWith('hdl:direction:'))?.slice('hdl:direction:'.length);
        if (callable?.language === 'verilog' && formal?.language === 'verilog' && direction) {
          const status = sourceLines(callable.filePath) === null ? ' [indexed definition; source unverified]' : '';
          lines.push(`  Formal direction: ${callable.qualifiedName}(${direction} ${formal.name}).${status}`);
        }
      }
      const source = sourceLines(owner.filePath);
      if (!source) { lines.push('  Source omitted: changed/unavailable since indexing, or maxFiles reached.'); continue; }
      if (!edge.line || edge.line > source.length) { lines.push('  No verified source line for this occurrence.'); continue; }
      const start = Math.max(1, edge.line - 1), end = Math.min(source.length, edge.line + 1);
      const excerpt = source.slice(start - 1, end).map((s, i) => `${start + i}\t${s}`).join('\n');
      if (excerpt.length > snippetBudget || excerpt.length > 2000) { lines.push('  Source snippet omitted by output budget.'); continue; }
      snippetBudget -= excerpt.length;
      const fence = '`'.repeat(Math.max(3, ...(excerpt.match(/`+/g) ?? []).map(s => s.length + 1)));
      lines.push(`${fence}systemverilog`, excerpt, fence);
    }
  }
  if (shownSites < totalSites) lines.push('', `Showing ${shownSites} of ${totalSites} matching sites; narrow with a qualified signal name.`);
  if (unclassified) lines.push('', `${unclassified} unclassified reference(s) excluded. Connections and unknown uses do not imply reads or writes.`);
  lines.push('', 'An empty result is not proof of no access outside the supported source patterns.');
  return lines.join('\n');
}
