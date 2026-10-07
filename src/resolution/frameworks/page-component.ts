/**
 * A file-routed page — Nuxt's `pages/admin.vue`, Astro's `src/pages/about.astro`
 * — is served by the component its file IS: the single-file-component
 * extractor's one component per file, named after the file. Without the link a
 * page route stood alone, so the viewer's Steps tab drew nothing for a page and
 * the routes list never named what serves it.
 *
 * The route says so with a `calls` reference by that name, the way a Next.js
 * page names its default export, and {@link resolvePageComponent} lands it on
 * the SAME file's component — never on a same-named one elsewhere, since every
 * `index.vue` is a component named `index`.
 */

import type { Language, Node } from '../../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

/** The component name a single-file-component extractor gives a file: its basename, extension off. */
export function pageComponentName(filePath: string, extension: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  return base.endsWith(extension) ? base.slice(0, -extension.length) : base;
}

export function pageComponentRef(route: Node, extension: string, language: Language): UnresolvedRef {
  const name = pageComponentName(route.filePath, extension);
  return {
    fromNodeId: route.id,
    referenceName: name,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath: route.filePath,
    language,
    candidates: [name],
  };
}

/** A page route's reference to its file's own component, or null when this is not one. */
export function resolvePageComponent(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'calls' || !ref.fromNodeId.startsWith(`route:${ref.filePath}:`)) return null;
  const component = context
    .getNodesInFile(ref.filePath)
    .find((n) => n.kind === 'component' && n.name === ref.referenceName);
  return component ? { original: ref, targetNodeId: component.id, confidence: 0.95, resolvedBy: 'framework' } : null;
}
