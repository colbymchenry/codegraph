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
  const topMetadata = new Map<string, Edge['metadata']>();
  for (const edge of result.edges) {
    const object = edge.metadata?.jsObject;
    if (object && typeof object === 'object') {
      const info = object as { binding?: string; scope?: number[] };
      if (typeof info.binding === 'string') info.binding = info.binding.replace(/^binding:(\d+):/, (_, line: string) => `binding:${Number(line) + fold.lineOffset}:`);
      if (Array.isArray(info.scope) && info.scope.length === 4) info.scope = info.scope.map((value, i) => i === 0 || i === 2 ? value + fold.lineOffset : value);
    }
    if (edge.kind === 'contains' && edge.source === blockFile) topMetadata.set(edge.target, edge.metadata);
  }
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
    if (!parented.has(node.id)) sink.edges.push({ source: fold.componentNodeId, target: node.id, kind: 'contains',
      ...(topMetadata.get(node.id) !== undefined ? { metadata: topMetadata.get(node.id) } : {}) });
  }

  for (const edge of result.edges) {
    if (edge.kind === 'contains' && edge.source === blockFile) continue;
    if (edge.line) edge.line += fold.lineOffset;
    if (fold.perInstance && runsAsComponent(edge.source) && edge.kind !== 'imports' && edge.kind !== 'contains') edge.source = fold.componentNodeId;
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
