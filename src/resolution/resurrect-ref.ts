/**
 * The reference behind a resolution edge, for an edge whose target is going
 * away — shared by every path that removes nodes other files point at.
 */

import type { Edge, Language, ReferenceKind, UnresolvedReference } from '../types';

/**
 * Resurrect a resolution edge that is about to be dropped (its target symbol
 * was removed, renamed, or its whole file deleted) as the ORIGINAL unresolved
 * reference that created it, read from the refName/refKind stamp
 * `createEdges` writes into edge metadata. Inserted as status='pending', the
 * ref is consumed by the same sync's resolution sweep: it rebinds to an
 * alternative definition if one exists, or parks as status='failed' where the
 * #1240 retry finds it if the symbol later reappears.
 *
 * Returns null — drop silently, the pre-#1240 behavior — for edges without a
 * refName stamp (created before the stamp existed, or synthesized): rebuilding
 * a ref from the target's plain node name would strip the receiver/qualifier
 * context the original text carried (`h.greet` → `greet`) and could rebind
 * somewhere a full re-index never would. Silent beats wrong.
 */
export function resurrectRefFromDroppedEdge(
  e: Edge & { sourceFilePath: string; sourceLanguage: Language }
): UnresolvedReference | null {
  const refName = e.metadata?.refName;
  if (typeof refName !== 'string' || refName.length === 0) return null;
  const refKind = typeof e.metadata?.refKind === 'string' ? (e.metadata.refKind as ReferenceKind) : e.kind;
  return {
    fromNodeId: e.source,
    referenceName: refName,
    referenceKind: refKind,
    ...(e.sourceLanguage === 'verilog' && Array.isArray(e.metadata?.refCandidates)
      && e.metadata.refCandidates.every((c: unknown) => typeof c === 'string')
      ? { candidates: e.metadata.refCandidates as string[] } : {}),
    line: e.line ?? 0,
    column: e.column ?? 0,
    filePath: e.sourceFilePath,
    language: e.sourceLanguage,
  };
}
