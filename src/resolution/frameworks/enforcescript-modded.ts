/**
 * Enforce Script `modded class` → original namesake resolver.
 *
 * A `modded class Foo` extractor node (src/extraction/languages/enforcescript.ts)
 * emits a self-referential reference named `__enforcescript_modded__:Foo`
 * instead of a real base-class name, because the compiler drops any
 * inheritance clause on a modded class outright (modded-classes.md #2) — `Foo`
 * stays a descendant of its OWN original, never whatever followed `:`/
 * `extends`. General name-matching is deliberately never given this ref: it
 * has no self-exclusion, and `getNodesByName('Foo')` would include the modded
 * node itself, risking a self-loop `references` edge when it's the only `Foo`
 * in the project. The sentinel prefix guarantees this resolver is the only
 * thing that ever claims it (claimsReference below), so self-exclusion and
 * the non-modded/earliest-declared preference can be enforced deliberately.
 */

import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { MODDED_LINK_PREFIX } from '../../extraction/languages/enforcescript';

export const enforcescriptModdedResolver: FrameworkResolver = {
  name: 'enforcescript-modded',
  languages: ['enforcescript'],

  detect(context: ResolutionContext): boolean {
    return context.getNodesByKind('class').some((n) => n.language === 'enforcescript');
  },

  claimsReference(name: string): boolean {
    return name.startsWith(MODDED_LINK_PREFIX);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!ref.referenceName.startsWith(MODDED_LINK_PREFIX)) return null;
    const name = ref.referenceName.slice(MODDED_LINK_PREFIX.length);

    const candidates = context
      .getNodesByName(name)
      .filter((n) => n.kind === 'class' && n.language === 'enforcescript' && n.id !== ref.fromNodeId);
    if (candidates.length === 0) return null;

    // Prefer the true original (not itself modded) — the one every `new Foo()`
    // ultimately bottoms out at. Otherwise fall back to the earliest-declared
    // modded version as a best-effort stand-in for "the previous link in the
    // modded chain" (modded-classes.md #3) — real load order isn't knowable
    // statically, so this is an approximation, not a guarantee.
    const original = candidates.find((n) => !n.decorators?.includes('modded'));
    const chosen = original ?? candidates.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)[0]!;

    return {
      original: ref,
      targetNodeId: chosen.id,
      confidence: 0.75,
      resolvedBy: 'framework',
    };
  },
};