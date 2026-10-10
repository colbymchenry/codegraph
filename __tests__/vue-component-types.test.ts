/**
 * Phase 3 — cross-file type expansion for the Vue component API.
 *
 * `defineProps<Props>()` where Props is IMPORTED (`import type { Props } from
 * './types'`) is the dominant shape in codebases with a shared types/ dir; the
 * same-file resolver can't see it. VueExtractor resolves relative imports to
 * sibling files (cached by mtime), pulls the interface/type-alias out, and
 * follows `extends` chains across files. tsconfig `paths` aliases (`@/types/x`)
 * resolve through the same map the import resolver uses; a BARE package import
 * is skipped — no members rather than wrong members.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

function componentApi(cg: any, name: string): any {
  const row = (cg as any).db.db
    .prepare(`SELECT metadata FROM nodes WHERE kind = 'component' AND name = ?`)
    .get(name);
  return row?.metadata ? JSON.parse(row.metadata).componentApi : undefined;
}

describe('vue cross-file type expansion', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-types-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('expands props/emits imported from a sibling file, following extends', async () => {
    fs.writeFileSync(
      path.join(dir, 'types.ts'),
      `export interface BaseProps {
  /** Unique id */
  id: string
}

export interface ModalProps extends BaseProps {
  /** Dialog size */
  size?: 'sm' | 'lg'
  title: string
}

export type ModalEmits = {
  (e: 'ok'): void
  (e: 'cancel', reason: string): void
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'Modal.vue'),
      `<template><div/></template>
<script setup lang="ts">
import type { ModalProps, ModalEmits } from './types'
const props = defineProps<ModalProps>()
const emit = defineEmits<ModalEmits>()
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Modal');

    expect(api.props).toEqual([
      { name: 'id', type: 'string', required: true, doc: 'Unique id' },
      { name: 'size', type: "'sm' | 'lg'", required: false, doc: 'Dialog size' },
      { name: 'title', type: 'string', required: true },
    ]);
    expect(api.emits).toEqual([
      { name: 'ok', type: '()' },
      { name: 'cancel', type: '(reason: string)' },
    ]);
    cg.close?.();
  });

  it('resolves ../ imports from nested component directories', async () => {
    fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'types', 'card.ts'),
      `export interface CardProps { rows: number }\n`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'components', 'Card.vue'),
      `<template><div/></template>
<script setup lang="ts">
import type { CardProps } from '../types/card'
const props = defineProps<CardProps>()
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    expect(componentApi(cg, 'Card')?.props).toEqual([{ name: 'rows', type: 'number', required: true }]);
    cg.close?.();
  });

  it('skips a bare-package import instead of guessing', async () => {
    fs.writeFileSync(
      path.join(dir, 'Widget.vue'),
      `<template><div/></template>
<script setup lang="ts">
import type { StoreProps } from 'pinia-magic'
const props = defineProps<StoreProps>()
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    // No file on disk to read — no props, and crucially no half-resolved guess
    // from a same-name declaration elsewhere.
    expect(componentApi(cg, 'Widget')?.props).toBeUndefined();
    cg.close?.();
  });

  it('resolves a tsconfig `paths` alias exactly like a relative import', async () => {
    // `@/types/modal` is what a Vue project's tsconfig declares by default;
    // resolving it needs the same `paths` map the import resolver uses.
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })
    );
    fs.mkdirSync(path.join(dir, 'src', 'types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'types', 'modal.ts'),
      `export interface ModalProps {\n  /** Dialog size */\n  size?: 'sm' | 'lg'\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'Modal.vue'),
      `<template><div/></template>
<script setup lang="ts">
import type { ModalProps } from '@/types/modal'
const props = defineProps<ModalProps>()
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    expect(componentApi(cg, 'Modal')?.props).toEqual([
      { name: 'size', type: "'sm' | 'lg'", required: false, doc: 'Dialog size' },
    ]);
    cg.close?.();
  });

  it('resolves aliased imports at BOTH ends: the SFC binding and the sibling extends chain', async () => {
    // `ModalProps as LocalProps` in the SFC + `Base as B` inside the sibling's
    // own extends chain — the declaration is found by its EXPORTED name even
    // though every reference site uses a different local alias.
    fs.writeFileSync(
      path.join(dir, 'base.ts'),
      `export interface Base {\n  /** Unique id */\n  id: string\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, 'types.ts'),
      `import type { Base as B } from './base'\n\nexport interface ModalProps extends B {\n  size?: 'sm' | 'lg'\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, 'Modal.vue'),
      `<template><div/></template>
<script setup lang="ts">
import type { ModalProps as LocalProps } from './types'
const props = defineProps<LocalProps>()
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    expect(componentApi(cg, 'Modal')?.props).toEqual([
      { name: 'id', type: 'string', required: true, doc: 'Unique id' },
      { name: 'size', type: "'sm' | 'lg'", required: false },
    ]);
    cg.close?.();
  });

  it('deduplicates diamond extends — a shared base reached via two branches appears once', async () => {
    fs.writeFileSync(
      path.join(dir, 'Diamond.vue'),
      `<template><div/></template>
<script setup lang="ts">
interface Base { id: string }
interface Left extends Base { left: string }
interface Right extends Base { right: string }
interface Props extends Left, Right { title: string }
const props = defineProps<Props>()
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Diamond');
    // id (inherited through BOTH branches) must appear exactly once.
    expect(api.props.map((p: any) => p.name)).toEqual(['id', 'left', 'right', 'title']);
    cg.close?.();
  });
});