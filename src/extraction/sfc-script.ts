/**
 * How a single-file component's script joins the component — shared by the
 * Vue, Svelte and Astro extractors, which hand each `<script>` block (or
 * Astro's frontmatter) to the TypeScript extractor and fold its result back.
 *
 * The fold used to keep the block's own file node and make the component
 * contain it AND every node in the block, so the hierarchy ran file-inside-
 * component and every member had two parents: the Symbol view listed a
 * component's script twice, with the component and its file among its own
 * members. And everything the block did at its top level stayed on that file
 * node — but `<script setup>`, a Svelte instance script and Astro's
 * frontmatter run once per component instance, so their top-level calls ARE
 * the component's doing: a Nuxt page's `useAsyncData(…)`, a Svelte page's
 * `onMount(…)`. With them on the file, a walk from the component found
 * nothing, and the viewer's Steps tab drew a screen alone.
 *
 * Now: the SFC has one file node, the whole file, holding the component; what
 * the block holds at its top level the component holds, and a nested symbol
 * keeps its own parent; a per-instance block's top-level calls and references
 * — a top-level constant's initializer's included — are the component's,
 * while its imports, and everything a module-level block does, stay with the
 * file.
 */

import type { Edge, ExtractionError, ExtractionResult, Language, Node, UnresolvedReference } from '../types';
import * as path from 'path';

const TS_LANG_ATTR = /lang\s*=\s*["'](ts|typescript)["']/;
const TSX_LANG_ATTR = /lang\s*=\s*["']tsx["']/;

/**
 * The grammar a `<script>` block is read with, from its opening tag's
 * attributes — by the Vue and Svelte extractors, and by the viewer's syntax
 * regions, so a component's code is highlighted with the grammar its symbols
 * came from.
 *
 * `ts` / `typescript` is TypeScript. A Vue block can also be `tsx` (#2570):
 * TypeScript with JSX, which only the TSX grammar reads — the TypeScript
 * grammar has no JSX, and the JavaScript one stops at the first type, so a
 * `defineProps<{…}>()` or an `interface` was lost. Svelte has no TSX scripts.
 * Anything else is JavaScript, whose grammar reads JSX (`lang="jsx"`) already.
 */
export function sfcScriptLanguage(attrs: string, host: Language): Language {
  if (TS_LANG_ATTR.test(attrs)) return 'typescript';
  if (host === 'vue' && TSX_LANG_ATTR.test(attrs)) return 'tsx';
  return 'javascript';
}

/**
 * A `<script>` element of a Vue, Svelte or Astro file: group 1 its opening
 * tag's attributes, `content` its body. A self-closing tag — Astro's
 * `<script is:inline set:html={code} />`, a third-party
 * `<script src="/analytics.js" />` — is matched on its own, with no
 * `content`: read as an opening tag it ran on to the next script's
 * `</script>`, and that script was parsed with the markup in between and
 * contributed nothing (#2989).
 *
 * Shared by the three extractors and the viewer's syntax regions. It carries
 * the `g` flag, so each loop runs on its own copy (`new RegExp(...)`).
 */
export const SFC_SCRIPT_ELEMENT = /<script(\s[^>]*?)?(?:\/>|>(?<content>[\s\S]*?)<\/script\s*>)/g;

/**
 * A `<script>` or `<style>` element, which the template scans skip: what it
 * holds is code or CSS, not markup. A self-closing one (see
 * {@link SFC_SCRIPT_ELEMENT}) has no body to skip, and its attributes, like
 * `set:html={serializeJsonLd(schema)}`, are template expressions like any
 * other's: {@link sfcElementHasBody} says which a match is.
 */
export const SFC_SCRIPT_OR_STYLE_ELEMENT = /<(script|style)(\s[^>]*?)?(?:\/>|>[\s\S]*?<\/\1\s*>)/g;

/** Whether a match of {@link SFC_SCRIPT_OR_STYLE_ELEMENT} has a body: false for a self-closing tag. */
export function sfcElementHasBody(element: string): boolean {
  return !element.endsWith('/>');
}

/**
 * The lines (0-indexed, inclusive) of each `<script>` and `<style>` element
 * with a body in `source`, which a template scan skips. A self-closing tag
 * covers nothing.
 */
export function sfcBlockLineRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const elements = new RegExp(SFC_SCRIPT_OR_STYLE_ELEMENT);
  let match: RegExpExecArray | null;
  while ((match = elements.exec(source)) !== null) {
    if (!sfcElementHasBody(match[0])) continue;
    const startLine = (source.substring(0, match.index).match(/\n/g) || []).length;
    ranges.push([startLine, startLine + (match[0].match(/\n/g) || []).length]);
  }
  return ranges;
}

/** The SFC's own file node — the whole file, as the tree-sitter extractor makes one. */
export function sfcFileNode(filePath: string, source: string, language: Language): Node {
  return {
    id: `file:${filePath}`,
    kind: 'file',
    name: path.basename(filePath),
    qualifiedName: filePath,
    filePath,
    language,
    startLine: 1,
    endLine: source.split('\n').length,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    updatedAt: Date.now(),
  };
}

export interface ScriptFold {
  filePath: string;
  componentNodeId: string;
  /** Lines before the block in the SFC file: the block's line 1 is `lineOffset + 1`. */
  lineOffset: number;
  language: Language;
  /** The block runs once per component instance — Vue `<script setup>`, a Svelte instance script, Astro frontmatter. */
  perInstance: boolean;
}

export interface ScriptSink {
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
}

/** What a per-instance block does at its top level, as opposed to what it imports. */
const INSTANCE_REF_KINDS: ReadonlySet<string> = new Set(['calls', 'references', 'instantiates', 'function_ref']);

export function foldScriptResult(result: ExtractionResult, fold: ScriptFold, sink: ScriptSink): void {
  const blockFile = `file:${fold.filePath}`;
  // What already has a parent inside the block — a method's class, a nested
  // function's function. The block's file holding something is not a parent:
  // the component is, now.
  const parented = new Set<string>();
  for (const edge of result.edges) {
    if (edge.kind === 'contains' && edge.source !== blockFile) parented.add(edge.target);
  }

  // A per-instance block's top-level `const data = useFetch(…)` is component
  // state: its initializer runs on every instance, as the component's doing.
  const instanceValues = new Set<string>();
  if (fold.perInstance) {
    for (const node of result.nodes) {
      if ((node.kind === 'constant' || node.kind === 'variable') && !parented.has(node.id)) instanceValues.add(node.id);
    }
  }
  const runsAsComponent = (id: string) => id === blockFile || instanceValues.has(id);

  for (const node of result.nodes) {
    if (node.kind === 'file') continue;
    node.startLine += fold.lineOffset;
    node.endLine += fold.lineOffset;
    node.language = fold.language;
    sink.nodes.push(node);
    if (!parented.has(node.id)) sink.edges.push({ source: fold.componentNodeId, target: node.id, kind: 'contains' });
  }

  for (const edge of result.edges) {
    if (edge.kind === 'contains' && edge.source === blockFile) continue;
    if (edge.line) edge.line += fold.lineOffset;
    // What a top-level value DOES is the component's; what it HOLDS stays its
    // own — `const api = { load() {…} }` keeps `api::load` (#2300).
    if (fold.perInstance && runsAsComponent(edge.source) && edge.kind !== 'imports' && edge.kind !== 'contains') {
      edge.source = fold.componentNodeId;
    }
    sink.edges.push(edge);
  }

  for (const ref of result.unresolvedReferences) {
    ref.line += fold.lineOffset;
    ref.filePath = fold.filePath;
    ref.language = fold.language;
    if (fold.perInstance && runsAsComponent(ref.fromNodeId) && INSTANCE_REF_KINDS.has(ref.referenceKind)) {
      ref.fromNodeId = fold.componentNodeId;
    }
    sink.unresolvedReferences.push(ref);
  }

  for (const error of result.errors) {
    if (error.line) error.line += fold.lineOffset;
    sink.errors.push(error);
  }
}
