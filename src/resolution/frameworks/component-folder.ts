/**
 * The folder preference the component resolvers share (React, Svelte, Astro,
 * Vue): when a component name has several definitions, the ones in the folder
 * of the file that uses the name, or in a folder below it, come first.
 *
 * The folder is compared whole. A bare `startsWith('src/ui')` also held
 * `src/ui-kit/Widget.tsx`, so `src/ui/Card.tsx`'s `Widget` could land in the
 * sibling folder; and a file at the project root, whose folder is `''`, held
 * every definition in the project, so its pick skipped the "only one
 * definition may resolve" rule that keeps an ambiguous name unlinked (#764).
 */

/**
 * The candidates in `fromFile`'s folder or a folder below it, in their given
 * order. A file at the project root has no folder to prefer, so it gets none.
 */
export function inReferencingFolder<T>(
  fromFile: string,
  candidates: readonly T[],
  pathOf: (candidate: T) => string
): T[] {
  const cut = fromFile.lastIndexOf('/');
  if (cut < 0) return [];
  const folder = fromFile.slice(0, cut + 1);
  return candidates.filter((candidate) => pathOf(candidate).startsWith(folder));
}
