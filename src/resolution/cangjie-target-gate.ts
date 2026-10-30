/**
 * Where a Cangjie reference may land — two shapes that bound it to the
 * wrong node, gated at resolveOne's seam so every strategy obeys them.
 *
 * 1. Extension nodes. An `extend T { … }` whose `T` is declared in another
 *    file, or is a builtin (`extend Int64 <: Countable`), is extracted as an
 *    extension node named `T` and marked `extend` (see languages/cangjie.ts):
 *    it holds the extension's members and conformances so interface dispatch
 *    reaches them, but it is not the type. `Int64(x)` converts a builtin and
 *    `Point(1, 2)` constructs the declared `struct Point` — a reference that
 *    lands on an extension node moves to the type's own declaration, or to
 *    nothing when the project only extends the type (the Swift extension
 *    trap; see ./swift-type-visibility).
 *
 * 2. Standard-library method names reached without a receiver type. A call
 *    on a value whose type extraction can't name (`foo().add(x)`,
 *    `a.b.c.isEmpty()`) is emitted by its bare method name; when that name is
 *    one of the standard library's (`add`, `toString`, `isEmpty`) and the
 *    only project method of that name belongs to another class, it is the
 *    library's — no edge.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { isStdMethodName } from './name-matcher';

/** Mirrors CANGJIE_EXTEND_MARKER in extraction/languages/cangjie.ts. */
const EXTEND_MARKER = 'extend';

const TYPE_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>(['class', 'struct', 'enum', 'interface', 'type_alias']);

function isExtension(node: Node): boolean {
  return node.language === 'cangjie' && (node.decorators ?? []).includes(EXTEND_MARKER);
}

/** `pkg::Owner::member` → `pkg::Owner`. */
function ownerOf(node: Node): string {
  const cut = node.qualifiedName.lastIndexOf('::');
  return cut > 0 ? node.qualifiedName.slice(0, cut) : '';
}

export function gateCangjieTarget(result: ResolvedRef | null, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!result || ref.language !== 'cangjie') return result;
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target) return result;

  if (isExtension(target)) {
    const declarations = context
      .getNodesByName(target.name)
      .filter((n) => n.language === 'cangjie' && TYPE_KINDS.has(n.kind) && !isExtension(n));
    if (declarations.length === 0) return null;
    const sameFile = declarations.filter((n) => n.filePath === ref.filePath);
    const chosen = sameFile.length > 0 ? sameFile : declarations;
    if (chosen.length !== 1) return null;
    return { ...result, targetNodeId: chosen[0]!.id };
  }

  const bare = !ref.referenceName.includes('.');
  if (!bare || (ref.referenceKind !== 'calls' && ref.referenceKind !== 'instantiates')) return result;

  if (target.kind === 'method' && isStdMethodName('cangjie', target.name)) {
    const from = context.getNodeById?.(ref.fromNodeId);
    if (!from || !(ownerOf(from) === ownerOf(target) || ownerOf(from).startsWith(`${ownerOf(target)}::`))) return null;
  }
  return result;
}
