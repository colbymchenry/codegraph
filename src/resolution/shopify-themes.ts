/**
 * A Shopify theme's section and snippet references → that theme's own files.
 *
 * `{% render 'price' %}` renders the `snippets/price.liquid` of the theme the
 * file belongs to; `{% section 'header' %}` and a JSON template's section
 * `"type"` name a file in that theme's `sections/`. Shopify never looks in
 * another theme. The Liquid extractor records these as `snippets/<name>.liquid`
 * and `sections/<name>.liquid`, and the path matcher took any file whose path
 * ends with that, so in a repository holding several themes (a theme tool's
 * examples, a store's seasonal themes) a theme missing a section linked to
 * another theme's copy of it.
 *
 * From a file inside a theme (see `shopifyThemeRoot`), these references
 * resolve to the theme's own file or to nothing, and never fall through to the
 * generic name strategies. A reference from a file in no theme resolves as
 * before.
 */
import { shopifyThemeRoot } from '../extraction/grammars';
import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';

/**
 * The file a section or snippet reference made inside a Shopify theme names:
 * the theme's own `sections/<name>.liquid` or `snippets/<name>.liquid`.
 * undefined means the reference is not one, or is made outside any theme;
 * null means the theme has no such file, so no other strategy may guess one.
 */
export function matchShopifyThemeFile(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.language !== 'liquid' || !/^(sections|snippets)\//.test(ref.referenceName)) return undefined;
  const theme = shopifyThemeRoot(ref.filePath, (relativePath) => context.fileExists(relativePath));
  if (theme === undefined) return undefined;
  const target = theme === '' ? ref.referenceName : `${theme}/${ref.referenceName}`;
  const file = context
    .getNodesByName(target.slice(target.lastIndexOf('/') + 1))
    .find((n) => n.kind === 'file' && n.filePath === target);
  if (!file) return null;
  // The confidence the path matcher gives the same link: an exact path for a
  // theme at the project root, a path tail for one in a folder.
  return { original: ref, targetNodeId: file.id, confidence: theme === '' ? 0.95 : 0.85, resolvedBy: 'file-path' };
}
