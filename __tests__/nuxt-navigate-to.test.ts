/**
 * Nuxt's `navigateTo('/x')` navigates to the page at `/x`, as `router.push`
 * does (#2634).
 *
 * `navigateTo` was in the Vue resolver's list of Nuxt auto-imports, which
 * answers each one with a sink, an edge from the calling node to itself. The
 * Vue resolver runs before Vue Router's, so the navigation was never read:
 * every `navigateTo` became a self-pointing `calls` edge, in pages and in
 * route middleware alike, and no `navigates` edge was drawn.
 *
 * Now Vue Router reads the destination, and Nuxt owns what it can't read: a
 * computed destination, a path no page serves or an external URL calls Nuxt's
 * `navigateTo` all the same, so it is left unresolved rather than linked to a
 * project function that only shares the name (elk declares one inside a
 * plugin). A file that declares or imports its own `navigateTo` calls that one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Edge, Node } from '../src/types';

const NUXT_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'site', private: true, dependencies: { nuxt: '^4.0.0', vue: '^3.5.0' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['./*'] } } }),
  // The issue's pages.
  'pages/index.vue': "<script setup lang=\"ts\">\nawait navigateTo('/target');\n</script>\n<template><div /></template>\n",
  'pages/push.vue':
    '<script setup lang="ts">\nconst router = useRouter();\nfunction go() { router.push(\'/target\'); }\n</script>\n' +
    '<template><button @click="go" /></template>\n',
  'pages/target.vue': '<template><div /></template>\n',
  'pages/login.vue': '<template><div>login</div></template>\n',
  'middleware/auth.global.ts':
    "export default defineNuxtRouteMiddleware((to) => {\n  if (to.path !== '/login') {\n    return navigateTo('/login');\n  }\n});\n",
  'pages/account.vue':
    '<script setup lang="ts">\n' +
    'const props = defineProps<{ next: string }>();\n' +
    "function goLogin() { return navigateTo({ path: '/login', query: { from: 'account' } }); }\n" +
    'function goNext() { return navigateTo(props.next); }\n' +
    "function goMissing() { return navigateTo('/nowhere'); }\n" +
    "function goDocs() { return navigateTo('https://nuxt.com/docs', { external: true }); }\n" +
    '</script>\n' +
    '<template>\n  <button @click="goLogin" />\n  <a @click="navigateTo(\'/target\')">Back</a>\n</template>\n',
  'composables/useNav.ts': 'export function useNav() {\n  return { go: (to: string) => navigateTo(to) };\n}\n',
  // Two project functions named navigateTo: a plugin's own, and a helper's.
  'plugins/keys.client.ts':
    'export default defineNuxtPlugin(() => {\n' +
    '  const navigateTo = (to: string) => {\n    console.log(to);\n  };\n' +
    "  window.addEventListener('keydown', () => navigateTo('/target'));\n" +
    '});\n',
  'lib/open.ts': 'export function navigateTo(url: string) {\n  return window.open(url);\n}\n',
  'pages/docs.vue':
    "<script setup lang=\"ts\">\nimport { navigateTo } from '~/lib/open';\nfunction openDocs(url: string) { return navigateTo(url); }\n</script>\n" +
    '<template><button @click="openDocs" /></template>\n',
};

const roots: string[] = [];
function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nuxt-nav-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return CodeGraph.init(root, { index: true });
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('Nuxt navigateTo', () => {
  let cg: CodeGraph;
  beforeAll(async () => {
    cg = await indexProject(NUXT_APP);
  });
  afterAll(() => cg?.close());

  const route = (name: string): Node => cg.getNodesByKind('route').find((r) => r.name === name)!;
  const sym = (name: string, file: string): Node => cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'import')!;
  /** The edges a node makes from its `navigateTo` calls. */
  const navigateToEdges = (from: Node): Edge[] =>
    cg.getOutgoingEdges(from.id).filter((e) => (e.metadata as Record<string, unknown> | undefined)?.refName === 'navigateTo');
  const destinations = (from: Node) =>
    navigateToEdges(from).map((e) => `${e.kind} ${(e.metadata as Record<string, unknown>).href} -> ${cg.getNode(e.target)?.name}`);

  it('navigates from a page to the page it names, with no edge from the page to itself', () => {
    expect(destinations(sym('index', 'pages/index.vue'))).toEqual(['navigates /target -> /target']);
    expect(navigateToEdges(sym('index', 'pages/index.vue'))[0]!.target).toBe(route('/target').id);
    // router.push in the same app, unchanged.
    expect(cg.getOutgoingEdges(sym('go', 'pages/push.vue').id).filter((e) => e.kind === 'navigates').map((e) => e.target)).toEqual([
      route('/target').id,
    ]);
  });

  it('navigates from route middleware', () => {
    const file = cg.getNodesInFile('middleware/auth.global.ts').find((n) => n.kind === 'file')!;
    expect(destinations(file)).toEqual(['navigates /login -> /login']);
  });

  it('reads an object destination and a call written in the template', () => {
    expect(destinations(sym('goLogin', 'pages/account.vue'))).toEqual(['navigates /login -> /login']);
    expect(destinations(sym('account', 'pages/account.vue'))).toEqual(['navigates /target -> /target']);
  });

  it('leaves a computed destination, a path no page serves and an external URL unresolved', () => {
    for (const [name, file] of [
      ['goNext', 'pages/account.vue'],
      ['goMissing', 'pages/account.vue'],
      ['goDocs', 'pages/account.vue'],
      ['useNav', 'composables/useNav.ts'],
    ] as const) {
      expect(navigateToEdges(sym(name, file)), name).toEqual([]);
    }
    // Neither project function named navigateTo is called by any of them, nor
    // does any navigateTo call point at its own caller.
    const namesakes = cg.getNodesByName('navigateTo').map((n) => n.id);
    expect(namesakes).toHaveLength(2);
    const intoNamesakes = cg.getIncomingEdgesTo(namesakes, ['calls']);
    expect(intoNamesakes.map((e) => `${cg.getNode(e.source)?.name} -> ${cg.getNode(e.target)?.filePath}`)).toEqual([
      'openDocs -> lib/open.ts',
    ]);
  });

  it('calls the navigateTo a file imports, and navigates through the one a file declares', () => {
    const docs = cg.getOutgoingEdges(sym('openDocs', 'pages/docs.vue').id).filter((e) => e.kind === 'calls');
    expect(docs.map((e) => cg.getNode(e.target)).map((n) => `${n?.name} ${n?.filePath}`)).toEqual(['navigateTo lib/open.ts']);
    // The plugin's wrapper is called with a page's path: where it goes, as before.
    const plugin = cg.getNodesInFile('plugins/keys.client.ts').find((n) => n.kind === 'file')!;
    expect(destinations(plugin)).toEqual(['navigates /target -> /target']);
  });
});

describe('navigateTo outside Nuxt', () => {
  it('is the project function a plain Vue app imports', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3.5.0', 'vue-router': '^4.4.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/router/index.ts':
        "import { createRouter, createWebHistory } from 'vue-router';\n" +
        "export default createRouter({ history: createWebHistory(), routes: [{ path: '/login', component: () => import('@/views/Login.vue') }] });\n",
      'src/views/Login.vue': '<template><div>login</div></template>\n',
      'src/utils/nav.ts': 'export function navigateTo(path: string) {\n  window.location.assign(path);\n}\n',
      'src/views/Home.vue':
        "<script setup lang=\"ts\">\nimport { navigateTo } from '@/utils/nav';\nfunction go(path: string) { navigateTo(path); }\n</script>\n" +
        '<template><button @click="go(\'/login\')" /></template>\n',
    });
    try {
      const go = cg.getNodesInFile('src/views/Home.vue').find((n) => n.name === 'go')!;
      const calls = cg.getOutgoingEdges(go.id).filter((e) => e.kind === 'calls');
      expect(calls.map((e) => cg.getNode(e.target)?.filePath)).toEqual(['src/utils/nav.ts']);
    } finally {
      cg.close();
    }
  });
});
