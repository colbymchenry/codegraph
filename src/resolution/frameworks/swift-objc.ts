/**
 * Swift ↔ Objective-C bridge resolver.
 *
 * Closes the cross-language flow gap in mixed iOS codebases. The pure
 * bridging name math lives in `../swift-objc-bridge.ts`; this file wires
 * it into the resolution pipeline.
 *
 * **Two directions to close:**
 *
 * 1. **Swift call → ObjC method** — A Swift caller writes
 *    `imageDownloader.download(url:completion:)`. Tree-sitter-swift parses
 *    this as a call_expression whose callee identifier is `download`
 *    (parameter labels live in the argument list, not the callee). The
 *    name-matcher tries to find any node named `download` and fails (no
 *    Swift method by that name in this project; the ObjC implementation is
 *    `-downloadURL:completion:`). We catch it here: from the bare Swift
 *    name `download`, look up ObjC methods whose bridged Swift base name
 *    would be `download` (using `swiftBaseNamesForObjcSelector`'s reverse
 *    map, precomputed once per session).
 *
 * 2. **ObjC call → Swift method** — An ObjC caller writes
 *    `[swiftThing fooWithBar:42]`. Tree-sitter-objc parses this as a
 *    message_expression with selector `fooWithBar:` (after the multi-
 *    keyword fix in this branch). The name-matcher tries to find a node
 *    named `fooWithBar:` — no Swift node has colons in its name, so it
 *    fails. We catch it: from the ObjC selector, derive candidate Swift
 *    base names (`['fooWithBar', 'foo']`), and look up Swift methods
 *    named those.
 *
 * **Provenance:** every edge produced here is recorded as a framework-
 * resolved reference (`resolvedBy: 'framework'`) with `confidence: 0.7`
 * (matches the django ORM dynamic-dispatch precedent — not exact, but
 * deterministic from the bridging rule).
 */
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import type { Node } from '../../types';
import {
  swiftBaseNamesForObjcSelector,
  isObjcExposed,
} from '../swift-objc-bridge';

/**
 * Memoized "Swift base name → ObjC method nodes" map.
 *
 * Built lazily on first `resolve()` per resolver instance — the resolver is
 * recreated when the index is rebuilt, so this naturally invalidates with
 * the graph. Keyed by ResolutionContext identity so multiple projects sharing
 * a process (the daemon) don't bleed maps between them.
 */
const objcByCandidateSwiftBase: WeakMap<
  ResolutionContext,
  Map<string, Node[]>
> = new WeakMap();

/**
 * Build the reverse-bridge map: for every ObjC method node in the graph,
 * compute the Swift base names that would auto-bridge to its selector and
 * record the node under each.
 *
 * Runs once per resolver lifetime; the cost scales linearly with the count
 * of ObjC method nodes. On Wikipedia-iOS (~2500 files, ~25k ObjC methods)
 * this is a few hundred ms — much cheaper than re-parsing source on each
 * unresolved ref.
 */
/**
 * Names that are too generic to bridge with any precision. These are common
 * Cocoa / NSObject conventions that almost every ObjC class implements; if a
 * Swift caller writes `init()` or `description`, mapping it to an arbitrary
 * project-local ObjC method of the same name produces noise, not signal.
 *
 * Critically, refs of these names virtually always resolve via the regular
 * name-matcher (every project has many `init` nodes) — skipping them here
 * just keeps the bridge from competing with name-match on already-handled
 * refs.
 */
const GENERIC_NAMES = new Set([
  'init',
  'description',
  'debugDescription',
  'hash',
  'isEqual',
  'isEqualTo',
  'copy',
  'mutableCopy',
  'class',
  'self',
  'count',
  'length',
  'value',
  'name',
  'data',
  'string',
  'object',
  'add',
  'remove',
  'update',
  'load',
  'save',
  'reload',
  'cancel',
  'start',
  'stop',
  'pause',
  'resume',
  'close',
  'open',
  'show',
  'hide',
  'toString',
  'dealloc',
  'release',
  'retain',
  'autorelease',
]);

function buildObjcMap(context: ResolutionContext): Map<string, Node[]> {
  const cached = objcByCandidateSwiftBase.get(context);
  if (cached) return cached;

  const map = new Map<string, Node[]>();
  const objcMethods = context
    .getNodesByKind('method')
    .filter((n) => n.language === 'objc');
  for (const node of objcMethods) {
    const candidates = swiftBaseNamesForObjcSelector(node.name);
    for (const c of candidates) {
      // Skip the trivial case where the Swift base name equals the ObjC
      // method name verbatim (no colons) — the regular name-matcher
      // already handles that and our map would just duplicate the work.
      if (c === node.name && !node.name.includes(':')) continue;
      // Skip generic Cocoa names (init, description, etc.) — they would
      // false-positive against any project-local ObjC method of the same
      // name. The regular name-matcher handles them.
      if (GENERIC_NAMES.has(c)) continue;
      const arr = map.get(c);
      if (arr) arr.push(node);
      else map.set(c, [node]);
    }
  }
  objcByCandidateSwiftBase.set(context, map);
  return map;
}

/**
 * Window of source text around a Swift declaration used by `isObjcExposed`
 * to spot `@objc` / `@nonobjc` annotations. Read line above + the
 * declaration line — Swift attributes typically sit on the preceding line
 * (`@objc` on a line of its own) or inline.
 */
const SOURCE_PROBE_LINES = 3;

/**
 * Read a small window of source ending at `node.startLine`, used to
 * inspect Swift attribute annotations attached to a declaration. Returns
 * an empty string if the source can't be read.
 */
function declarationSourceWindow(node: Node, context: ResolutionContext): string {
  const content = context.readFile(node.filePath);
  if (!content) return '';
  const lines = content.split(/\r?\n/);
  const startIdx = Math.max(0, node.startLine - 1 - SOURCE_PROBE_LINES);
  const endIdx = Math.min(lines.length, node.startLine);
  return lines.slice(startIdx, endIdx).join('\n');
}

/**
 * Try to resolve a Swift caller's bare reference to an ObjC implementation.
 *
 * Strategy: look up the ObjC reverse-bridge map for nodes whose Swift base
 * name would match. Return the first match (matches the existing
 * single-target resolution contract).
 */
function resolveSwiftCallToObjc(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Swift call sites of `obj.foo(bar:)` reach the resolver as either bare
  // name `foo` (tree-sitter-swift) or qualified `obj.foo` — strip prefix.
  const rawName = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName;

  const map = buildObjcMap(context);
  const candidates = map.get(rawName);
  if (!candidates || candidates.length === 0) return null;

  // Prefer ObjC methods whose corresponding Swift declaration isn't itself
  // present (so we don't wrongly redirect a Swift call to ObjC when a Swift
  // method of the same name is the real target — that's the in-language case
  // and should already be resolved by the name-matcher). Since this resolver
  // runs AFTER exact-match, any matching Swift node would already have won;
  // so a candidate reaching us is a legitimate cross-language hit.
  const target = candidates[0];
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.6,
    resolvedBy: 'framework',
  };
}

/**
 * Try to resolve an ObjC caller's selector reference to a Swift `@objc`
 * implementation.
 *
 * Strategy: derive candidate Swift base names from the selector via
 * `swiftBaseNamesForObjcSelector`. For each, look up Swift methods named
 * that and verify with a source-window check that the declaration is
 * `@objc`-exposed (filters out false matches where a Swift function
 * happens to share the name but isn't bridged).
 */
function resolveObjcCallToSwift(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // ObjC call sites get receiver-prefixed when the receiver isn't self/super
  // (see tree-sitter.ts message_expression handling): `[obj foo:bar:]`
  // becomes `obj.foo:bar:`. Strip the receiver prefix to recover the raw
  // selector for the bridge math.
  const rawSelector = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName;

  // Bridge math only applies to selector-shape names (contain `:`).
  if (!rawSelector.includes(':')) return null;

  const candidates = swiftBaseNamesForObjcSelector(rawSelector);
  for (const candidate of candidates) {
    const matches = context
      .getNodesByName(candidate)
      .filter((n) => n.language === 'swift' && (n.kind === 'method' || n.kind === 'function'));
    for (const match of matches) {
      const window = declarationSourceWindow(match, context);
      if (isObjcExposed(window)) {
        return {
          original: ref,
          targetNodeId: match.id,
          confidence: 0.6,
          resolvedBy: 'framework',
        };
      }
    }
  }
  return null;
}

export const swiftObjcBridgeResolver: FrameworkResolver = {
  name: 'swift-objc-bridge',
  // Applies to both languages — bridging crosses the boundary.
  languages: ['swift', 'objc'],

  /**
   * Detect: this resolver is relevant when the project has both Swift and
   * Objective-C source. Either-side-only projects don't need bridging
   * (and the empty reverse-map would be a no-op anyway).
   */
  detect(context) {
    const files = context.getAllFiles();
    let hasSwift = false;
    let hasObjc = false;
    for (const f of files) {
      if (f.endsWith('.swift')) hasSwift = true;
      else if (f.endsWith('.m') || f.endsWith('.mm')) hasObjc = true;
      if (hasSwift && hasObjc) return true;
    }
    return false;
  },

  /**
   * Let selector-shape references (anything containing a `:`) through the
   * resolver's name-exists pre-filter — no Swift node has a colon in its
   * name, so without this opt-in those refs would be dropped before
   * `resolve()` sees them. Also opt-in `setX:`-style names that aren't
   * otherwise declared symbols, in case the Swift side is a property.
   */
  claimsReference(name) {
    if (name.includes(':')) return true;
    // Bare names without colons are handled by the regular name-exists
    // pre-filter — no need to opt them in here.
    return false;
  },

  /**
   * Route based on which language the caller is in. The two directions are
   * symmetric in shape but very different in implementation (forward
   * direction uses the precomputed reverse-bridge map; reverse direction
   * uses the deterministic name-derivation).
   */
  resolve(ref, context) {
    if (ref.language === 'swift') {
      return resolveSwiftCallToObjc(ref, context);
    }
    if (ref.language === 'objc') {
      return resolveObjcCallToSwift(ref, context);
    }
    return null;
  },
};
