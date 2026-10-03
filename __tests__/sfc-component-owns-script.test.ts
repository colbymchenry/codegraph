/**
 * A Vue / Svelte / Astro file is one file node holding the component it is,
 * and the component holds its script: each symbol has one parent, and a
 * component never contains its own file. What a per-instance script does at
 * its top level — `<script setup>`, a Svelte instance script, Astro's
 * frontmatter — is the component's doing (a Nuxt page's `useAsyncData(…)`, a
 * Svelte page's `onMount(…)`); a module-level script's, and every import,
 * stays with the file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { ExtractionResult } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const componentOf = (r: ExtractionResult) => r.nodes.find((n) => n.kind === 'component')!;
const from = (r: ExtractionResult, name: string) =>
  r.unresolvedReferences.filter((ref) => ref.referenceName === name && ref.referenceKind === 'calls').map((ref) => ref.fromNodeId);
const parents = (r: ExtractionResult) => {
  const out = new Map<string, string[]>();
  for (const e of r.edges) if (e.kind === 'contains') out.set(e.target, [...(out.get(e.target) ?? []), e.source]);
  return out;
};

describe('a single-file component’s structure', () => {
  it('is a file holding the component holding the script, one parent each', () => {
    const r = extractFromSource('pages/index.vue', `<template><button @click="load">Load</button></template>
<script setup lang="ts">
import { useFetch } from '#app';
const data = useFetch('/api/items');
function load() {
  return data;
}
</script>
`);
    const file = r.nodes.find((n) => n.kind === 'file')!;
    const component = componentOf(r);
    expect(file).toMatchObject({ id: 'file:pages/index.vue', startLine: 1, endLine: 9 });
    const p = parents(r);
    expect(p.get(component.id)).toEqual([file.id]);
    expect(p.get(file.id)).toBeUndefined();
    const load = r.nodes.find((n) => n.name === 'load')!;
    expect(p.get(load.id)).toEqual([component.id]);
    for (const [, list] of p) expect(list).toHaveLength(1);
  });

  it('gives a <script setup>’s top-level calls to the component, and its imports to the file', () => {
    const r = extractFromSource('pages/index.vue', `<template><div /></template>
<script setup lang="ts">
import { useFetch } from '#app';
const data = useFetch('/api/items');
</script>
`);
    expect(from(r, 'useFetch').filter((id) => id.startsWith('component:'))).toHaveLength(1);
    expect(r.unresolvedReferences.filter((ref) => ref.referenceKind === 'imports').every((ref) => ref.fromNodeId === 'file:pages/index.vue')).toBe(true);
  });

  it('leaves a plain <script>’s module-level calls with the file', () => {
    const r = extractFromSource('src/Widget.vue', `<template><div /></template>
<script>
registerWidget('widget');
export default { name: 'Widget' };
</script>
`);
    expect(from(r, 'registerWidget')).toEqual(['file:src/Widget.vue']);
  });

  it('gives a Svelte instance script to the component, and a module script to the file', () => {
    const r = extractFromSource('src/routes/+page.svelte', `<script context="module">
  preload();
</script>
<script module>
  register();
</script>
<script>
  import { onMount } from 'svelte';
  onMount(() => fetchItems());
</script>
<p>items</p>
`);
    const component = componentOf(r).id;
    expect(from(r, 'onMount')).toEqual([component]);
    expect(from(r, 'preload')).toEqual(['file:src/routes/+page.svelte']);
    expect(from(r, 'register')).toEqual(['file:src/routes/+page.svelte']);
  });

  it('gives Astro frontmatter to the component, and makes a file node for a file without one', () => {
    const r = extractFromSource('src/pages/blog.astro', `---
const posts = await getCollection('blog');
---
<ul>{posts.map((p) => <li>{p.title}</li>)}</ul>
`);
    expect(from(r, 'getCollection')).toEqual([componentOf(r).id]);
    const bare = extractFromSource('src/pages/about.astro', `<p>about</p>\n`);
    expect(bare.nodes.map((n) => n.kind).sort()).toEqual(['component', 'file']);
  });
});
