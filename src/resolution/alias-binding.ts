/**
 * Alias bindings: a name bound to nothing but another symbol.
 *
 *   export const alias = realImpl;      // p1 — cross-file through an import
 *   const local = realImpl;             // p6 — same file
 *   export const api = { run: impl };   // p5 — property holding a function ref
 *   export { realImpl as alias };       // p2 — a local export clause
 *
 * Extraction records the binding itself as a `constant`/`variable` node and
 * stores its initializer in `signature` (`"= realImpl"`), so a call through the
 * alias resolves to the BINDING, not the function. `callers realImpl` then
 * omits every caller that went through the alias and reports a confident zero,
 * while `callers alias` finds them — the edge exists, it just terminates one
 * hop short. A local `export { X as Y }` clause is worse: the exported name
 * matches no declaration at all, so resolution fails outright.
 *
 * A call through an alias IS a call to the aliased function, so these hops are
 * only ever applied to `calls` refs. A `references` edge to the binding is
 * correct as-is — reading the alias as a value is a genuine use of the alias.
 */

import type { Node } from '../types';
import type { ResolutionContext } from './types';

/** Kinds that can be a pure alias for another symbol. */
const ALIAS_BINDING_KINDS = new Set<string>(['constant', 'variable', 'property']);

/** Kinds an alias may usefully forward a CALL to. */
const CALLABLE_KINDS = new Set<string>(['function', 'method', 'class', 'component']);

/** `= identifier`, optionally with a cast or trailing semicolon, and nothing else. */
const BARE_ALIAS_RE = /^=\s*([A-Za-z_$][\w$]*)\s*(?:as\s+[\w.<>[\]]+\s*)?;?$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The symbol name an alias binding forwards to, or null when the initializer is
 * anything else (a call, a literal, an expression — all genuine definitions).
 *
 * `memberName` targets a property of an object-literal initializer
 * (`= { run: impl }` for `api.run()`), including ES shorthand (`= { impl }`).
 */
export function aliasTargetName(
  signature: string | undefined | null,
  memberName: string | null
): string | null {
  if (!signature) return null;
  const initializer = signature.trim();

  if (memberName) {
    const key = escapeRegExp(memberName);
    const explicit = new RegExp(`[{,]\\s*${key}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}]`).exec(initializer);
    if (explicit) return explicit[1]!;
    // `{ impl }` — shorthand binds the property to the same-named symbol.
    const shorthand = new RegExp(`[{,]\\s*(${key})\\s*[,}]`).exec(initializer);
    if (shorthand) return shorthand[1]!;
    return null;
  }

  const bare = BARE_ALIAS_RE.exec(initializer);
  return bare ? bare[1]! : null;
}

/**
 * The callable an alias binding forwards to.
 *
 * Prefers a declaration in the alias's own file: an alias almost always names a
 * local symbol or one it imported, and a same-file hit needs no disambiguation.
 * Cross-file is accepted only when the name is unique in the project, so an
 * ambiguous name yields no hop rather than an invented edge — a wrong edge is
 * worse than a missing one.
 */
export function resolveAliasBinding(
  aliasNode: Node,
  memberName: string | null,
  context: ResolutionContext
): Node | null {
  if (!ALIAS_BINDING_KINDS.has(aliasNode.kind)) return null;

  const targetName = aliasTargetName(aliasNode.signature, memberName);
  if (!targetName || targetName === aliasNode.name) return null;

  const candidates = context.getNodesByName(targetName).filter((n) => CALLABLE_KINDS.has(n.kind));
  if (candidates.length === 0) return null;

  const sameFile = candidates.filter((n) => n.filePath === aliasNode.filePath);
  if (sameFile.length === 1) return sameFile[0]!;
  if (sameFile.length > 1) return null;
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Local export clauses: `export { realImpl as alias }` / `export { realImpl }`
 * with no `from` source.
 *
 * `extractReExports` only models the `export … from './other'` form, so a local
 * clause leaves the exported name bound to nothing the export index knows —
 * importing `alias` matches no declaration and resolution falls through to the
 * name-matcher, which cannot cross the rename (a false 0 callers).
 *
 * Type-only specifiers are skipped: they carry no runtime call.
 */
export function extractLocalExportAliases(content: string): Array<{ exportedName: string; localName: string }> {
  const out: Array<{ exportedName: string; localName: string }> = [];
  // `export { … }` NOT followed by `from` — the `from` form is a re-export.
  const clauseRe = /export\s*\{([^}]*)\}\s*(?!\s*from)[;\n]/g;
  let clause: RegExpExecArray | null;
  while ((clause = clauseRe.exec(content)) !== null) {
    for (const raw of clause[1]!.split(',')) {
      const specifier = raw.trim();
      if (!specifier || /^type\s/.test(specifier)) continue;
      const renamed = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(specifier);
      if (renamed) {
        out.push({ localName: renamed[1]!, exportedName: renamed[2]! });
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(specifier)) {
        out.push({ localName: specifier, exportedName: specifier });
      }
    }
  }
  return out;
}
