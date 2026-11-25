/**
 * A Vue `<script lang="tsx">` is TSX, and is read with the TSX grammar (#2570).
 *
 * The extractor knew only `ts` / `typescript`, so a `lang="tsx"` block went to
 * the JavaScript grammar, which stops at the first type. A script holding only
 * `withDefaults(defineProps<{…}>(), …)` came out as "parse produced no
 * symbols", and a script with any other declaration hid the same broken parse,
 * because that warning fires only when nothing survives: an `interface` the
 * script declared was simply missing.
 *
 * Reading the block as TSX also needs the TSX grammar loaded. A Vue project
 * loads the grammars its scripts delegate to, and that list had TypeScript and
 * JavaScript only; TSX came along only when some `.tsx` or `.js` file was in
 * the project. So the project below has nothing but `.vue` files, and this
 * file never loads every grammar: a test that did would hide that half.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { readGrammarWasmBytes } from '../src/extraction/grammars';
import { syntaxRegionsFor } from '../src/extraction/syntax-tokens';
import type { Node } from '../src/types';

const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.5.0' } }),
  // The issue's file: compiler macros only.
  'src/Title.vue': `<template><h1>{{ title }}</h1></template>
<script setup lang="tsx">
withDefaults(defineProps<{ title?: string }>(), { title: 'Hello' });
</script>
`,
  // Types and JSX together, which only the TSX grammar reads.
  'src/Card.vue': `<script lang="tsx">
import { defineComponent } from 'vue';
interface Props { label: string }
function renderLabel(p: Props) {
  return <span class="label">{p.label}</span>;
}
export default defineComponent({
  props: { label: String },
  setup(props) {
    const helper = (x: number): number => x * 2;
    return () => <div onClick={() => helper(1)}>{renderLabel(props as Props)}</div>;
  },
});
</script>
`,
  // Controls: TypeScript stays TypeScript, no lang stays JavaScript.
  'src/Plain.vue': `<template><p>{{ n }}</p></template>
<script setup lang="ts">
interface Count { n: number }
const count: Count = { n: 1 };
const n = count.n;
</script>
`,
  'src/Legacy.vue': `<template><p>{{ total }}</p></template>
<script>
export default { computed: { total() { return sum(1, 2); } } };
function sum(a, b) { return a + b; }
</script>
`,
};

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function indexProject(): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-tsx-'));
  roots.push(root);
  for (const [file, text] of Object.entries(PROJECT)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

const named = (nodes: Node[], kind: string, name: string) => nodes.find((n) => n.kind === kind && n.name === name);

/**
 * The file's extraction errors. The file must be stored: one whose grammar
 * was not loaded is never parsed, and nothing at all is stored for it.
 */
function errorsOf(graph: CodeGraph, file: string) {
  const record = graph.getFile(file);
  expect(record, `${file} is stored`).not.toBeNull();
  return record!.errors ?? [];
}

describe('Vue <script lang="tsx">', () => {
  it('indexes a macro-only script without a parse warning', async () => {
    const graph = await indexProject();
    expect(errorsOf(graph, 'src/Title.vue')).toEqual([]);
  });

  it('keeps the TypeScript declarations of a script with JSX, and the calls made inside the JSX', async () => {
    const graph = await indexProject();
    expect(errorsOf(graph, 'src/Card.vue')).toEqual([]);
    const nodes = graph.getNodesInFile('src/Card.vue');
    const props = named(nodes, 'interface', 'Props');
    expect(props).toBeDefined();
    expect(nodes.some((n) => n.kind === 'property' && n.qualifiedName === 'Props::label')).toBe(true);
    const renderLabel = named(nodes, 'function', 'renderLabel')!;
    const setup = named(nodes, 'method', 'setup')!;
    const helper = named(nodes, 'function', 'helper')!;
    // `p: Props` is a reference to the interface the script declares.
    expect(graph.getOutgoingEdgesFrom([renderLabel.id], ['references']).map((e) => e.target)).toContain(props!.id);
    // `<div onClick={() => helper(1)}>{renderLabel(…)}</div>` calls both.
    const called = graph.getOutgoingEdgesFrom([setup.id], ['calls']).map((e) => e.target);
    expect(called).toEqual(expect.arrayContaining([helper.id, renderLabel.id]));
  });

  it('still reads lang="ts" as TypeScript and a script without lang as JavaScript', async () => {
    const graph = await indexProject();
    expect(errorsOf(graph, 'src/Plain.vue')).toEqual([]);
    expect(named(graph.getNodesInFile('src/Plain.vue'), 'interface', 'Count')).toBeDefined();
    expect(errorsOf(graph, 'src/Legacy.vue')).toEqual([]);
    expect(named(graph.getNodesInFile('src/Legacy.vue'), 'function', 'sum')).toBeDefined();
  });

  it('loads the TSX grammar for a Vue project, and not for a Svelte one', async () => {
    expect(Object.keys(await readGrammarWasmBytes(['vue'])).sort()).toEqual(['javascript', 'tsx', 'typescript']);
    expect(Object.keys(await readGrammarWasmBytes(['svelte'])).sort()).toEqual(['javascript', 'typescript']);
  });

  it('is highlighted in the viewer with the grammar it was indexed with', () => {
    const regionLanguage = (source: string, host: 'vue' | 'svelte') => syntaxRegionsFor(source, host)?.map((r) => r.language);
    expect(regionLanguage(PROJECT['src/Card.vue']!, 'vue')).toEqual(['tsx']);
    expect(regionLanguage(PROJECT['src/Plain.vue']!, 'vue')).toEqual(['typescript']);
    expect(regionLanguage(PROJECT['src/Legacy.vue']!, 'vue')).toEqual(['javascript']);
    // Svelte has no TSX scripts: its extractor reads anything but ts as JavaScript.
    expect(regionLanguage('<script lang="tsx">\nlet x = 1;\n</script>\n', 'svelte')).toEqual(['javascript']);
  });
});
