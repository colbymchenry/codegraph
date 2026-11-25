/**
 * A file-routed page is served by the component its file is: Nuxt's
 * `pages/admin.vue`, Astro's `src/pages/about.astro`. The route stood alone,
 * so the viewer's Steps tab drew nothing for a page and the routes list never
 * named what serves it — it did not list a component-served route at all,
 * Vue Router's included. The link goes to the page file's OWN component,
 * never a same-named one (every `index.vue` is a component named `index`),
 * and an Astro endpoint is served by the verbs it exports.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildRoutes } from '../src/ui-server/api/routes';

const projects: Record<string, Record<string, string>> = {
  nuxt: {
    'package.json': JSON.stringify({ name: 'shop', private: true, dependencies: { nuxt: '^3.0.0' } }),
    'pages/index.vue': `<template><button @click="load">Load</button></template>
<script setup lang="ts">
function load() { return 1; }
</script>
`,
    'pages/admin.vue': `<template><div>admin</div></template>
`,
    'pages/orders/index.vue': `<template><div>orders</div></template>
`,
    'components/index.vue': `<template><div>not a page</div></template>
`,
  },
  astro: {
    'package.json': JSON.stringify({ name: 'site', private: true, dependencies: { astro: '^4.0.0' } }),
    'src/pages/index.astro': `---
const title = 'Home';
---
<h1>{title}</h1>
`,
    'src/pages/about.astro': `<p>about</p>
`,
    'src/pages/blog/index.astro': `<p>blog</p>
`,
    'src/pages/api/hello.ts': `export const GET = async () => new Response('hi');
export async function POST() { return new Response('ok'); }
`,
  },
};

const graphs: Record<string, { root: string; cg: CodeGraph }> = {};

beforeAll(async () => {
  for (const [name, files] of Object.entries(projects)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-page-${name}-`));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    graphs[name] = { root, cg: await CodeGraph.init(root, { index: true }) };
  }
});

afterAll(() => {
  for (const { root, cg } of Object.values(graphs)) {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** route name → the files of what it calls or references. */
function served(cg: CodeGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const route of cg.getNodesByKind('route')) {
    out[route.name] = cg.getOutgoingEdgesFrom([route.id], ['calls', 'references'])
      .map((e) => cg.getNode(e.target)!)
      .map((n) => `${n.kind} ${n.filePath}`);
  }
  return out;
}

describe('a Nuxt page', () => {
  it('is served by its own file’s component', () => {
    const map = served(graphs.nuxt!.cg);
    expect(map['/']).toEqual(['component pages/index.vue']);
    expect(map['/admin']).toEqual(['component pages/admin.vue']);
    expect(map['/orders']).toEqual(['component pages/orders/index.vue']);
  });

  it('is listed with the component that serves it', () => {
    const { entries } = buildRoutes(graphs.nuxt!.cg, new URLSearchParams());
    expect(entries.map((e) => `${e.url} ${e.handler} ${e.file}`).sort()).toEqual([
      '/ index pages/index.vue',
      '/admin admin pages/admin.vue',
      '/orders index pages/orders/index.vue',
    ]);
  });
});

describe('an Astro page', () => {
  it('is served by its own file’s component, and an endpoint by the verbs it exports', () => {
    const map = served(graphs.astro!.cg);
    expect(map['/']).toEqual(['component src/pages/index.astro']);
    expect(map['/about']).toEqual(['component src/pages/about.astro']);
    expect(map['/blog']).toEqual(['component src/pages/blog/index.astro']);
    expect(map['/api/hello']).toEqual(['function src/pages/api/hello.ts', 'function src/pages/api/hello.ts']);
  });
});
