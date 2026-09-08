/**
 * Which engine language a file's source is classified with (CG-57).
 *
 * There is no second grammar table any more. The viewer reads a file with the
 * grammar the *engine* parsed it with, so this is a question about coverage
 * rather than about mapping: a language the extractor has a tree-sitter grammar
 * for classifies; one it does not renders plain, with its identifiers still
 * split out so the graph's call-site links land exactly as they do everywhere
 * else. Highlighting is the part that degrades, never the linking.
 *
 * The three single-file-component formats are the exception worth naming. A
 * `.svelte`, `.vue` or `.astro` file has no grammar of its own here — the
 * extractors pull the `<script>` block out and hand it to TypeScript or
 * JavaScript — and the classifier does exactly the same thing, so a component's
 * code is read by the grammar its symbols came from while the surrounding
 * markup stays plain.
 */

import type { Language } from '../../types';
import { hasTreeSitterGrammar } from '../../extraction/grammars';

/**
 * Formats whose source is classified through their embedded script blocks.
 *
 * Kept beside `syntaxRegionsFor`, which decides where those blocks are — this
 * list only has to agree about *which* formats have them.
 */
export const COMPONENT_LANGUAGES: readonly Language[] = ['svelte', 'vue', 'astro'];

/**
 * The grammar a file of this language is read with, or null when it has none.
 *
 * Accepts the raw string off a `FileRecord` rather than a `Language`, because
 * an index written by an older engine can hold a language this build has since
 * renamed, and a viewer must not throw over that.
 */
export function grammarFor(language: string | undefined | null): string | null {
  if (!language) return null;
  const lang = language as Language;
  if (COMPONENT_LANGUAGES.includes(lang)) return 'typescript';
  return hasTreeSitterGrammar(lang) ? lang : null;
}

/** Whether a file of this language classifies at all. For tests and diagnostics. */
export function isHighlightable(language: string | undefined | null): boolean {
  return grammarFor(language) !== null;
}
