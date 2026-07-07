/**
 * CICS Framework Resolver (COBOL)
 *
 * Resolves the pseudo-conversational transaction hop: a program ends with
 * `EXEC CICS RETURN TRANSID('CB00')` (or START), and CICS re-invokes the
 * program that OWNS transaction CB00 on the next attention key. The
 * transaction→program mapping lives in the CICS CSD, which is never in the
 * repo — but by near-universal convention each program declares its own
 * transaction id as a working-storage constant:
 *
 *     05 WS-TRANID    PIC X(04) VALUE 'CB00'.
 *
 * The COBOL extractor emits `cics-transid:CB00` call references for literal
 * (or same-file-dereferenced) TRANSID options; this resolver maps the id to
 * the program module whose TRAN*-named data item declares that VALUE. No
 * match (an id owned by a program outside the repo) stays unresolved.
 */

import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { Node } from '../../types';

const TRANSID_REF_PREFIX = 'cics-transid:';
/** Data items that name a transaction id by convention. */
const TRANID_NAME_RE = /TRAN/i;
const VALUE_LITERAL_RE = /\bVALUE\s+['"]([A-Za-z0-9$#@]{1,4})['"]/i;

/**
 * transaction id → owning program module, built once per resolution context.
 * A WeakMap so a per-ref scan of every data node can't go quadratic on
 * copybook-heavy repos.
 */
const transidIndexes = new WeakMap<ResolutionContext, Map<string, string>>();

function buildIndex(context: ResolutionContext): Map<string, string> {
  const index = new Map<string, string>();
  const dataNodes: Node[] = [
    ...context.getNodesByKind('variable'),
    ...context.getNodesByKind('field'),
    ...context.getNodesByKind('constant'),
  ];
  for (const node of dataNodes) {
    if (node.language !== 'cobol') continue;
    if (!TRANID_NAME_RE.test(node.name)) continue;
    const value = node.signature ? VALUE_LITERAL_RE.exec(node.signature) : null;
    if (!value?.[1]) continue;
    const tx = value[1].toUpperCase();
    if (index.has(tx)) continue; // first declaration wins; collisions are rare and ambiguous
    const moduleNode = context
      .getNodesInFile(node.filePath)
      .find((n) => n.kind === 'module' && n.language === 'cobol');
    if (moduleNode) index.set(tx, moduleNode.id);
  }
  return index;
}

export const cicsResolver: FrameworkResolver = {
  name: 'cics',
  languages: ['cobol'],

  detect(context: ResolutionContext): boolean {
    // Any indexed COBOL program qualifies — the resolver only ever acts on
    // cics-transid: references, which only the COBOL extractor emits.
    return context.getNodesByKind('module').some((n) => n.language === 'cobol');
  },

  // cics-transid:XXXX matches no symbol name — opt it past the
  // name-exists pre-filter so it reaches resolve().
  claimsReference(name: string): boolean {
    return name.startsWith(TRANSID_REF_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!ref.referenceName.startsWith(TRANSID_REF_PREFIX)) return null;
    const tx = ref.referenceName.slice(TRANSID_REF_PREFIX.length).toUpperCase();

    let index = transidIndexes.get(context);
    if (!index) {
      index = buildIndex(context);
      transidIndexes.set(context, index);
    }

    const targetNodeId = index.get(tx);
    if (!targetNodeId) return null;
    return {
      original: ref,
      targetNodeId,
      confidence: 0.85,
      resolvedBy: 'framework',
    };
  },
};
