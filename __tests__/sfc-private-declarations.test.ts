/**
 * What a Svelte component's instance `<script>` or a Vue SFC's `<script setup>`
 * declares is the component's own — no other file reaches it by name. Only a
 * Svelte `<script module>`, a Vue `<script>` that is not `setup`, or a type a
 * `<script setup>` exports can be imported. shadcn-svelte's `<Item.Root>` (a
 * namespace import) went to a `type Item` one example component declares,
 * and halo's `isActive` from `@/tiptap/core` to a tab's local `computed`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sfc-private-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'docs', private: true }),
    'src/lib/examples/attachment-group.svelte': `<script lang="ts">
	type Item = {
		name: string;
	};
	const items: Item[] = [];
</script>

<div>{items.length}</div>
`,
    'src/lib/examples/item-demo.svelte': `<script lang="ts">
	import * as Item from "$lib/ui/item/index.js";
	let label: Item = null;
</script>

<Item.Root>{label}</Item.Root>
`,
    'src/components/TabItem.vue': `<script lang="ts" setup>
import { computed } from "vue";
const isActive = computed(() => true);
</script>

<template><div v-if="isActive" /></template>
`,
    'src/extensions/code-block.ts': `import { isActive } from "@/tiptap/core";

export function active(state: unknown) {
  return isActive(state);
}
`,
    'src/components/CrudTable.vue': `<script setup lang="ts">
export interface TableConfig {
  hideColumns: boolean;
}
defineProps<{ config: TableConfig }>();
</script>

<template><table /></template>
`,
    'src/pages/GroupDataPage.vue': `<script setup lang="ts">
import type { TableConfig } from "~/components/CrudTable.vue";
const config: TableConfig = { hideColumns: false };
</script>

<template><div>{{ config }}</div></template>
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.name}`);
};

describe('single-file component declarations', () => {
  it('are private to the component', () => {
    expect(targetsFrom('src/lib/examples/item-demo.svelte')).not.toContain('src/lib/examples/attachment-group.svelte:Item');
    expect(targetsFrom('src/extensions/code-block.ts')).not.toContain('src/components/TabItem.vue:isActive');
  });

  it('except a type a Vue <script setup> exports', () => {
    expect(targetsFrom('src/pages/GroupDataPage.vue')).toContain('src/components/CrudTable.vue:TableConfig');
  });
});
