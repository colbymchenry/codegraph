/**
 * A JS/TS call is never bound to a class member picked by name alone when the
 * code rules the member out.
 *
 * - A namespace import (`import * as z from "zod/v4"`) is the module object:
 *   `z.string()` calls one of the module's exports. It used to bind to the one
 *   class in the project with a `string` member — on zod, 3,207 calls to a test
 *   helper's getter.
 * - A binding from a package outside the repository (`import { z } from 'zod'`)
 *   names nothing in it.
 * - A bare call (`it(…)`, `describe(…)`) resolves lexically: it cannot reach an
 *   interface's `it` property or a class's `describe` field.
 *
 * A default import of a local module's instance still resolves by method.
 *
 * Vue, Svelte and Astro files follow the same rules (halo's 562 `t(…)` calls
 * went to an interface's `t`). "Outside the repository" means a package the
 * file's package.json declares, a Node built-in or a framework's virtual
 * module: an alias the resolver doesn't know (SvelteKit's `$lib/…`, a nested
 * Nuxt app's `~/…`) is still the project's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { zod: '^4.0.0', mocha: '^10.0.0', react: '^19.0.0', '@tanstack/react-query': '^5.0.0' } }),
  'src/test/Mocker.ts': `export class Mocker {
  get string(): string { return 'x'; }
  record(): number { return 1; }
}
`,
  'src/test/xfail.ts': `export interface XFailFunction {
  it: (title: string) => void;
}
`,
  'src/commands/CacheClear.ts': `export class CacheClearCommand {
  describe = "Clears all data stored in query runner cache.";
  run() { return 1; }
}
`,
  'src/utils.ts': `export function helper() { return 1; }
`,
  'src/api.ts': `class ApiClient {
  fetchUsers() { return []; }
}
export default new ApiClient();
`,
  'src/schemas.ts': `import * as z from 'zod';
import { z as zz } from 'zod';
import * as utils from './utils';
import api from './api';

export function schemas() {
  const a = z.string();
  const b = zz.record();
  const c = utils.helper();
  const d = api.fetchUsers();
  return [a, b, c, d];
}
`,
  'src/schemas.test.ts': `import { useQuery } from '@tanstack/react-query';
describe('schemas', () => {
  it('works', () => { useQuery({}); });
});
`,
  'src/hooks.ts': `export function useQuery(key: string) { return key; }
`,
  'src/factory.ts': `export function createRootHooks() {
  function useQuery(input: unknown) { return input; }
  return { useQuery };
}
`,
  'src/useAuth.ts': `export function useAuth() { return { user: null }; }
`,
  'src/App.tsx': `import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
export function App() {
  const q = useQuery({ queryKey: ['a'] });
  const auth = useAuth();
  return <div>{String(q)}{String(auth)}</div>;
}
`,
};

describe('JS/TS: a member picked by name alone', () => {
  it('is not what a namespace import, an outside package or a bare call reaches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-member-guess-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const callsFrom = (file: string): string[] => {
        const ids = cg.getNodesInFile(file).map((n) => n.id);
        return cg
          .getOutgoingEdgesFrom(ids, ['calls'])
          .map((e) => cg.getNode(e.target)?.qualifiedName ?? '?')
          .sort();
      };
      const fromSchemas = callsFrom('src/schemas.ts');
      expect(fromSchemas).not.toContain('Mocker::string');
      expect(fromSchemas).not.toContain('Mocker::record');
      expect(fromSchemas).toContain('helper');
      expect(fromSchemas).toContain('ApiClient::fetchUsers');
      const fromTest = callsFrom('src/schemas.test.ts');
      expect(fromTest).not.toContain('XFailFunction::it');
      expect(fromTest).not.toContain('CacheClearCommand::describe');
      // Imported from a package: not the project's own `useQuery`.
      expect(fromTest).not.toContain('useQuery');
      // The same in a React file, where hooks resolve by framework rules — and a
      // hook imported from the project still resolves.
      const fromApp = callsFrom('src/App.tsx');
      expect(fromApp.filter((q) => q.endsWith('useQuery'))).toEqual([]);
      expect(fromApp).toContain('useAuth');
    } finally {
      cg.close();
    }
  });

  it('applies to Vue and Svelte files, and an unknown alias is still the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-sfc-guess-'));
    roots.push(root);
    const files: Record<string, string> = {
      'frontend/package.json': JSON.stringify({ name: 'frontend', dependencies: { 'vue-i18n': '*', dayjs: '*', '@app/shared': 'workspace:*' } }),
      'shared/index.ts': `export function formatUrl(u: string) { return u; }
`,
      'frontend/types/context.ts': `export interface ProvidersContext {
  t: (key: string) => string;
}
`,
      'frontend/test/mocks.ts': `export function dayjs() { return 0; }
`,
      'frontend/composables/store.ts': `export function useLabelStore() { return {}; }
`,
      'frontend/composables/use-labels.ts': `import { useLabelStore } from '~/composables/store';
export function useLabels() { return useLabelStore(); }
`,
      'frontend/pages/labels.vue': `<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import dayjs from 'dayjs';
import { useLabelStore } from '~/composables/store';
import { formatUrl } from '@app/shared';
const { t } = useI18n();
const url = formatUrl('/labels');
const title = t('labels.title');
const today = dayjs();
const store = useLabelStore();
</script>
<template><h1>{{ title }}</h1></template>
`,
      'docs/package.json': JSON.stringify({ name: 'docs', devDependencies: { '@sveltejs/kit': '*' } }),
      'docs/src/lib/design.ts': `export function useDesignSystem() { return 1; }
`,
      'docs/src/lib/router.ts': `export function goto(path: string) { return path; }
`,
      'docs/src/lib/use.ts': `import { useDesignSystem } from '$lib/design';
export const current = () => useDesignSystem();
`,
      'docs/src/lib/instance.js': `export const DEV = true;
if (DEV) {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (info) => fetch(info);
}
`,
      'docs/src/lib/Map.svelte': `<div>map</div>
`,
      'docs/src/routes/+page.svelte': `<script lang="ts">
  import Map from '../lib/Map.svelte';
  import { useDesignSystem } from '$lib/design';
  import { goto } from '$app/navigation';
  const ds = useDesignSystem();
  function go() { goto('/'); fetch('/api'); }
</script>
<button on:click={go}>{ds}</button>
`,
      // Deno: the import map says `@std/assert` comes from JSR.
      'deno/deno.json': JSON.stringify({ imports: { '@std/assert': 'jsr:@std/assert@^1', 'app/': '../src/' } }),
      'deno/test/assert.ts': `export function assertEquals(a: unknown, b: unknown) { return a === b; }
`,
      'deno/app.test.ts': `import { assertEquals } from '@std/assert';
assertEquals(1, 1);
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const callsFrom = (file: string): string[] => {
        const ids = cg.getNodesInFile(file).map((n) => n.id);
        return cg
          .getOutgoingEdgesFrom(ids, ['calls'])
          .map((e) => cg.getNode(e.target)?.qualifiedName ?? '?')
          .sort();
      };
      const fromVue = callsFrom('frontend/pages/labels.vue');
      expect(fromVue).not.toContain('ProvidersContext::t');
      expect(fromVue).not.toContain('dayjs');
      expect(fromVue).toContain('useLabelStore');
      // A `workspace:*` dependency is in the repository.
      expect(fromVue).toContain('formatUrl');
      expect(callsFrom('frontend/composables/use-labels.ts')).toContain('useLabelStore');
      const fromSvelte = callsFrom('docs/src/routes/+page.svelte');
      expect(fromSvelte).toContain('useDesignSystem');
      expect(fromSvelte).not.toContain('goto');
      expect(fromSvelte).not.toContain('fetch');
      expect(callsFrom('deno/app.test.ts')).not.toContain('assertEquals');
      // A built-in's name imported from the project is the import.
      const svelteIds = cg.getNodesInFile('docs/src/routes/+page.svelte').map((n) => n.id);
      const imported = cg.getOutgoingEdgesFrom(svelteIds, ['imports']).map((e) => cg.getNode(e.target)!.filePath);
      expect(imported).toContain('docs/src/lib/Map.svelte');
      expect(callsFrom('docs/src/lib/use.ts')).toContain('useDesignSystem');
    } finally {
      cg.close();
    }
  });
});
