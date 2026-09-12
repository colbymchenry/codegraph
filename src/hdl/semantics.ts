import { createHash } from 'node:crypto';
import { runSlangSemantics, type RunSlangOptions } from './semantic-runner';
import { importSlangSemantics, type HdlSemanticFact } from './semantic-import';
import { importMappedSemantics } from './source-map-import';
import type { HdlProfileStatus } from './status';
import type { Node, FileRecord } from '../types';

export interface HdlSemanticOptions extends RunSlangOptions {
  /** Exact fact name, instance path, or instance-qualified fact name. */
  query?: string;
  limit?: number;
}
export interface HdlSemanticResult {
  schemaVersion: 1;
  provenance: { frontend: 'slang' | 'pyslang'; exporterSha256?: string; librarySha256?: string; version: string; executableSha256: string;
    profile: string; configurationFingerprint: string; fingerprint: string; top: string;
    parameters: Record<string, string>; allowUseBeforeDeclare: boolean;
    languageStandard: string; compilationUnitMode: 'separate'; runnerVersion: string; compilerLimits: readonly string[] };
  sourceGraphProfileMatches: boolean;
  facts: Array<HdlSemanticFact & { sourceNodeId?: string }>;
  totalMatches: number;
  truncated: boolean;
  diagnostics: string[];
  limitations: string[];
}
export interface HdlSemanticSourceGraph {
  profile(): HdlProfileStatus | null;
  stale(): boolean;
  file(file: string): FileRecord | null | undefined;
  nodes(file: string): Node[];
}

/** On-demand semantic view; no graph writes or persistent compiler cache. */
export async function analyzeHdlSemantics(root: string, options: HdlSemanticOptions,
  graph: HdlSemanticSourceGraph): Promise<HdlSemanticResult> {
  const limit = options.limit ?? 100;
  const query = options.query;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('HDL semantic limit must be 1..1000');
  const result = await runSlangSemantics(root, options);
  const facts = result.frontend === 'pyslang' ? importMappedSemantics(result.ast, result.sources) : importSlangSemantics(result.ast, result.sourceRoot);
  const profile = graph.profile();
  const linked = !graph.stale() && profile?.state === 'matches' &&
    profile.indexed.configurationFingerprint === result.configurationFingerprint;
  const byFile = new Map<string, Node[]>();
  const matches = facts.filter(fact => !query || fact.name === query ||
    fact.instancePath === query || `${fact.instancePath}.${fact.name}` === query);
  const selected = matches.slice(0, limit).map(fact => {
    const source = fact.source;
    if (!source) return fact;
    const text = result.sources[source.file];
    const line = text?.split(/\r?\n/)[source.line - 1];
    // Column 0 / macro invocation remains line-only; never fabricate a source node link.
    if (text === undefined || line === undefined) { const { source: _source, ...rest } = fact; return rest; }
    if (fact.sourceOrigin === 'macro' || !linked || source.column === null || source.column < 1 || source.column > Buffer.byteLength(line) + 1 || !line.includes(fact.name)) return fact;
    if (!byFile.has(source.file)) {
      const hash = createHash('sha256').update(text).digest('hex');
      byFile.set(source.file, graph.file(source.file)?.contentHash === hash ? graph.nodes(source.file) : []);
    }
    const nodes = byFile.get(source.file)!.filter(node => node.name === fact.name && node.startLine === source.line &&
      (fact.kind === 'parameter' ? node.kind === 'constant' : fact.kind === 'type' ? node.kind === 'type_alias' : node.kind === 'field' && !!node.decorators?.includes('hdl:port')));
    return nodes.length === 1 ? { ...fact, sourceNodeId: nodes[0]!.id } : fact;
  });
  return { schemaVersion: 1, provenance: { frontend: result.frontend, exporterSha256: result.exporterSha256, librarySha256: result.librarySha256, version: result.version,
    executableSha256: result.executableSha256, profile: result.profileName,
    configurationFingerprint: result.configurationFingerprint, fingerprint: result.fingerprint,
    top: result.top, parameters: { ...result.parameters }, allowUseBeforeDeclare: result.allowUseBeforeDeclare,
    languageStandard: result.languageStandard, compilationUnitMode: result.compilationUnitMode,
    runnerVersion: result.runnerVersion, compilerLimits: result.compilerLimits },
  sourceGraphProfileMatches: !!linked, facts: selected, totalMatches: matches.length,
  truncated: matches.length > selected.length, diagnostics: result.diagnostics,
  limitations: ['Computed on demand from a source snapshot; no persistent semantic cache.',
    'Source columns retain frontend coordinates; null means unavailable, including macro-generated declarations.',
    'Macro provenance covers declaration-name locations, not every macro use in types or initializer expressions.',
    'Only supported parameter/port facts are returned; absent or unknown widths are not zero.',
    'Compiler semantics are not simulation, synthesis, timing or hardware validation.'] };
}
