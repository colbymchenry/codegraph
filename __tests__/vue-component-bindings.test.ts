/**
 * Phase 2 — template event bindings as graph edges, and the
 * `codegraph_component` tool.
 *
 * `@event="handler"` on a component tag becomes a direct component→handler
 * `references` edge tagged metadata.vueEvent / .vueComponent (the handler is
 * extracted from the same SFC's script, so no resolver involvement). This is
 * the emit→handler pairing that answers "which parent handlers break if this
 * emit changes". Native-element handlers and inline arrows create nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

describe('vue template event bindings', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-bind-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates component→handler edges with vueEvent metadata, skipping native elements', async () => {
    fs.writeFileSync(path.join(dir, 'Modal.vue'), `<template><div><slot/></div></template>
<script setup lang="ts">
const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'close'): void
}>()
</script>
`);
    fs.writeFileSync(path.join(dir, 'App.vue'), `<template>
  <Modal @change="onChange" @close="onClose" @expand="() => expanded = true">
    <button @click="onClick">go</button>
  </Modal>
</template>

<script setup lang="ts">
import Modal from './Modal.vue'
import { ref } from 'vue'
const expanded = ref(false)
function onChange(value: string) {}
function onClose() {}
function onClick() {}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT t.name AS handler, e.metadata FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.kind = 'component' AND s.name = 'App' AND e.kind = 'references'
           AND e.metadata LIKE '%vueEvent%' ORDER BY t.name`
      )
      .all()
      .map((r: any) => {
        const meta = JSON.parse(r.metadata);
        return { handler: r.handler, event: meta.vueEvent, component: meta.vueComponent };
      });

    expect(rows).toEqual([
      { handler: 'onChange', event: 'change', component: 'Modal' },
      { handler: 'onClose', event: 'close', component: 'Modal' },
      // onClick is a NATIVE <button> handler — no component emit, no edge.
    ]);

    // The inline arrow @expand has no named handler — no third row above.
    cg.close?.();
  });

  it('does not bind Options-API methods upstream does not extract (known gap)', async () => {
    // Upstream's extractor pulls function-valued object members out of
    // EXPORTED CONSTS only (`export const actions = {…}`) — an anonymous
    // `export default { methods: {…} }` produces no method node at all, so
    // neither the vue-handler synthesizer nor the binding matcher has a
    // target to bind. Pinned here so a future upstream fix flips this test
    // (the binding machinery is ready the moment the node exists).
    fs.writeFileSync(path.join(dir, 'Form.vue'), `<template><form/></template>
<script setup lang="ts">
const emit = defineEmits(['submit'])
</script>
`);
    fs.writeFileSync(path.join(dir, 'Settings.vue'), `<template>
  <Form @submit="onSubmit"/>
</template>

<script>
import Form from './Form.vue'
export default {
  components: { Form },
  methods: {
    onSubmit() {}
  }
}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT t.name AS handler FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.kind = 'component' AND s.name = 'Settings' AND e.kind = 'references'
           AND e.metadata LIKE '%vueEvent%'`
      )
      .all();
    expect(rows).toEqual([]);
    cg.close?.();
  });

  it('collapses the same binding on two usages (v-if/v-else) into one edge', async () => {
    // Two identical <Modal> tags are a common shape; the graph carries the
    // binding once, so a parent's row in `codegraph_component` reads once.
    fs.writeFileSync(path.join(dir, 'Modal.vue'), `<template><div/></template>
<script setup lang="ts">
const emit = defineEmits(['change'])
</script>
`);
    fs.writeFileSync(path.join(dir, 'App.vue'), `<template>
  <Modal v-if="a" @change="onChange"/>
  <Modal v-else @change="onChange"/>
</template>

<script setup lang="ts">
import Modal from './Modal.vue'
const a = true
function onChange() {}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const rows = (cg as any).db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.name = 'App' AND t.name = 'onChange' AND e.metadata LIKE '%vueEvent%'`
      )
      .get();
    expect(rows.n).toBe(1);

    const handler = new ToolHandler(cg);
    const res = await handler.execute('codegraph_component', { component: 'Modal' });
    const text = res.content?.[0]?.text ?? '';
    expect(text.match(/`@change` → `onChange`/g)?.length).toBe(1);
    cg.close?.();
  });

  it('codegraph_component reports the contract, handlers, and parent bindings', async () => {
    fs.writeFileSync(path.join(dir, 'Modal.vue'), `<template><div><slot/></div></template>
<script setup lang="ts">
interface Props {
  /** Dialog size */
  size?: 'sm' | 'md'
  title: string
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'close'): void
}>()
</script>
`);
    fs.writeFileSync(path.join(dir, 'App.vue'), `<template>
  <Modal size="md" title="t" @change="onChange" @close="onClose"/>
</template>

<script setup lang="ts">
import Modal from './Modal.vue'
function onChange(value: string) {}
function onClose() {}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const handler = new ToolHandler(cg);
    const run = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      const res = await handler.execute(tool, args);
      return res.content?.[0]?.text ?? '';
    };

    // Child view: the API contract + who binds its events.
    const modal = await run('codegraph_component', { component: 'Modal' });
    expect(modal).toContain('**Vue component API:**');
    expect(modal).toContain('`size?: ');
    expect(modal).toContain('`title: string`');
    expect(modal).toContain('`change(value: string)`');
    expect(modal).toContain('**Bound by parents:**');
    expect(modal).toContain('- App (App.vue): `@change` → `onChange` (line 2) · `@close` → `onClose` (line 2)');

    // Parent view: its own template handlers.
    const app = await run('codegraph_component', { component: 'App' });
    expect(app).toContain('**Renders:** `Modal`');
    expect(app).toContain('**Template event handlers:**');
    expect(app).toContain('`@change` on `Modal` → `onChange`');
    expect(app).toContain('`@close` on `Modal` → `onClose`');

    // Ambiguity is surfaced, never silently guessed.
    cg.close?.();
  });

  it('never collapses DISTINCT bindings into one row', async () => {
    // Two shapes that must stay separate rows in `codegraph_component`:
    //   - one parent binding the same event to two handlers (a dropped row
    //     would hide a handler the emit change breaks), and
    //   - two children bound to the same handler (the child the binding sits
    //     on is the whole point of the row).
    fs.writeFileSync(path.join(dir, 'Modal.vue'), `<template><div/></template>
<script setup lang="ts">
const emit = defineEmits(['change'])
</script>
`);
    fs.copyFileSync(path.join(dir, 'Modal.vue'), path.join(dir, 'Dialog.vue'));
    fs.copyFileSync(path.join(dir, 'Modal.vue'), path.join(dir, 'Picker.vue'));
    fs.writeFileSync(path.join(dir, 'App.vue'), `<template>
  <Modal @change="onOne"/>
  <Modal @change="onTwo"/>
</template>

<script setup lang="ts">
import Modal from './Modal.vue'
function onOne() {}
function onTwo() {}
</script>
`);
    fs.writeFileSync(path.join(dir, 'Host.vue'), `<template>
  <Dialog @change="onSame"/>
  <Picker @change="onSame"/>
</template>

<script setup lang="ts">
import Dialog from './Dialog.vue'
import Picker from './Picker.vue'
function onSame() {}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const handler = new ToolHandler(cg);
    const run = async (component: string): Promise<string> =>
      (await handler.execute('codegraph_component', { component })).content?.[0]?.text ?? '';

    const modal = await run('Modal');
    expect(modal).toContain('- App (App.vue): `@change` → `onOne` (line 2) · `@change` → `onTwo` (line 3)');

    const host = await run('Host');
    expect(host).toContain(
      '`@change` on `Dialog` → `onSame` (line 2) · `@change` on `Picker` → `onSame` (line 3)'
    );
    cg.close?.();
  });

  it('names a non-Vue component instead of rendering a Vue-shaped empty answer', async () => {
    // `component` nodes come from svelte / astro / razor / liquid / dfm too,
    // but only a Vue SFC carries the componentApi payload. Say which it is —
    // a "no API extracted, re-run init" reply for a .svelte file is a lie.
    fs.writeFileSync(path.join(dir, 'Card.svelte'), `<script>let { title } = $props();</script>\n<p>{title}</p>\n`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const handler = new ToolHandler(cg);
    const text = (await handler.execute('codegraph_component', { component: 'Card' })).content?.[0]?.text ?? '';
    expect(text).toContain('not a Vue component');
    expect(text).toContain('svelte');
    expect(text).toContain('codegraph_explore');
    cg.close?.();
  });
});
