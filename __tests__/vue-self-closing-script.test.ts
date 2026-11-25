/**
 * A self-closing `<script ... />` in a Vue single-file component, such as a
 * `<script src="./legacy.js" />` block, has no body. Vue, Svelte and Astro
 * shared one script pattern that read it as an opening tag running on to the
 * next `</script>`: the `<script setup>` after it was parsed with whatever lay
 * in between, failed, and contributed no symbols, and a template in between
 * lost its calls and components too (#2989, #2995 and #2997 for Astro and
 * Svelte). The three extractors now share one pattern pair, and a
 * self-closing tag covers nothing a template scan should skip.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const calls = (result: ReturnType<typeof extractFromSource>, name: string, line: number) =>
  result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === name && ref.line === line);
const renders = (result: ReturnType<typeof extractFromSource>, name: string, line: number) =>
  result.unresolvedReferences.some((ref) => ref.referenceKind === 'references' && ref.referenceName === name && ref.line === line);

describe('Vue self-closing <script />', () => {
  it('does not swallow the <script setup> that follows it', () => {
    const code = `<template>
  <p>{{ formatDate(date) }}</p>
  <Header />
</template>
<script src="./legacy.js" />
<script setup>
const ready = true;
function go() { return helper(); }
</script>
`;
    const result = extractFromSource('src/components/Page.vue', code);

    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.name === 'ready')?.startLine).toBe(7);
    expect(result.nodes.find((n) => n.name === 'go')?.startLine).toBe(8);
    expect(calls(result, 'helper', 8)).toBe(true);
    expect(calls(result, 'formatDate', 2)).toBe(true);
    expect(renders(result, 'Header', 3)).toBe(true);
  });

  it('keeps the template it comes before', () => {
    const code = `<script src="./legacy.js" />
<template>
  <p>{{ formatDate(date) }}</p>
  <Header />
</template>
<script setup>
const ready = true;
</script>
`;
    const result = extractFromSource('src/components/First.vue', code);

    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.name === 'ready')?.startLine).toBe(7);
    expect(calls(result, 'formatDate', 3)).toBe(true);
    expect(renders(result, 'Header', 4)).toBe(true);
  });

  it("still reads a call in a self-closing <script />'s attributes", () => {
    const code = `<template>
  <article>
    <script type="application/ld+json" :innerHTML="toJsonLd(post)" />
    <p>{{ formatDate(post.date) }}</p>
    <Header />
  </article>
</template>
<script setup>
const ready = true;
</script>
`;
    const result = extractFromSource('src/components/Post.vue', code);

    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.name === 'ready')?.startLine).toBe(9);
    expect(calls(result, 'toJsonLd', 3)).toBe(true);
    expect(calls(result, 'formatDate', 4)).toBe(true);
    expect(renders(result, 'Header', 5)).toBe(true);
  });

  // The template-call scan always took `</script >` as a closing tag; with one
  // pattern for every site, the script reader does too.
  it('ends a block at a closing tag written with a space, `</script >`', () => {
    const code = `<template>
  <p>{{ formatDate(date) }}</p>
</template>
<script setup>
const ready = true;
</script >
`;
    const result = extractFromSource('src/components/Spaced.vue', code);

    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.name === 'ready')?.startLine).toBe(5);
    expect(calls(result, 'formatDate', 2)).toBe(true);
  });
});
