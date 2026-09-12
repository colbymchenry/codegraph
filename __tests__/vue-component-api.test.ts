/**
 * Vue component API extraction (metadata.componentApi) — the props/emits/
 * slots/exposed contract an agent needs to USE a component without reading
 * its SFC. Covers the dominant declaration forms:
 *   - Script setup, type-driven: defineProps<Interface>() + withDefaults.
 *   - Script setup, runtime: defineProps({ foo: { type, required, default } }).
 *   - Options API: export default { props, emits }.
 *   - Slots from <slot> tags (named / default), exposed via defineExpose.
 * Plus the invariants the switch from regex to the official parser must not
 * regress: script-block symbol line offsets, template reference resolution
 * (parent→child `references` edges, incl. kebab-case), and metadata actually
 * persisting through SQLite (it rides the v10 nodes.metadata column).
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

describe('vue component api extraction', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-api-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('extracts type-driven props/emits/slots/exposed from <script setup lang="ts">', async () => {
    fs.writeFileSync(path.join(dir, 'Modal.vue'), `<template>
  <div class="modal">
    <header><slot name="header"/></header>
    <slot/>
    <footer><slot name="footer"/></footer>
  </div>
</template>

<script setup lang="ts">
interface Props {
  /** Controls dialog size */
  size?: 'sm' | 'md' | 'lg'
  title: string
  items: string[]
}

const props = withDefaults(defineProps<Props>(), { size: 'md' })
const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'close'): void
}>()
defineExpose({ open, close })
function open() {}
function close() {}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Modal');
    expect(api).toBeTruthy();

    expect(api.props).toEqual([
      { name: 'size', type: "'sm' | 'md' | 'lg'", required: false, default: "'md'", doc: 'Controls dialog size' },
      { name: 'title', type: 'string', required: true },
      { name: 'items', type: 'string[]', required: true },
    ]);
    expect(api.emits).toEqual([
      { name: 'change', type: '(value: string)' },
      { name: 'close', type: '()' },
    ]);
    expect(api.slots).toEqual(['header', 'default', 'footer']);
    expect(api.exposed).toEqual(['open', 'close']);

    // Script-block symbols keep their real file lines (interface on line 10,
    // open() on line 23) — the descriptor-based offset path must match the
    // old regex behavior exactly.
    const db = (cg as any).db.db;
    const iface = db.prepare(`SELECT start_line FROM nodes WHERE kind = 'interface' AND name = 'Props'`).get();
    expect(iface.start_line).toBe(10);
    const openFn = db.prepare(`SELECT start_line FROM nodes WHERE kind = 'function' AND name = 'open'`).get();
    expect(openFn.start_line).toBe(23);

    cg.close?.();
  });

  it('extracts runtime-form props and emits from <script setup>', async () => {
    fs.writeFileSync(path.join(dir, 'Pager.vue'), `<template><div/></template>
<script setup>
const props = defineProps({
  /** How many rows */
  count: { type: Number, required: true, default: 5 },
  label: String,
  options: Array,
})
const emit = defineEmits(['select', 'cancel'])
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Pager');
    expect(api.props).toEqual([
      { name: 'count', type: 'number', required: true, default: '5', doc: 'How many rows' },
      { name: 'label', type: 'string', required: false },
      { name: 'options', type: 'unknown[]', required: false },
    ]);
    expect(api.emits).toEqual([{ name: 'select' }, { name: 'cancel' }]);
    cg.close?.();
  });

  it('extracts Options API props/emits', async () => {
    fs.writeFileSync(path.join(dir, 'Banner.vue'), `<template><div/></template>
<script>
export default {
  props: {
    visible: Boolean
  },
  emits: ['confirm']
}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Banner');
    expect(api.props).toEqual([{ name: 'visible', type: 'boolean', required: false }]);
    expect(api.emits).toEqual([{ name: 'confirm' }]);
    cg.close?.();
  });

  it('resolves an EXPORTED props/emits type declared in the SFC, and unions slots', async () => {
    // The shared-types shape: a plain <script lang="ts"> block exporting the
    // interfaces, consumed by the setup block. The export wrapper must be
    // unwrapped exactly like a sibling file's `export interface` is.
    fs.writeFileSync(path.join(dir, 'Panel.vue'), `<template><div><slot name="extra"/></div></template>
<script lang="ts">
export interface PanelProps {
  /** Panel title */
  title: string
}
export type PanelEmits = { (e: 'toggle'): void }
</script>
<script setup lang="ts">
defineProps<PanelProps>()
defineEmits<PanelEmits>()
defineSlots<{ body: unknown }>()
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Panel');
    expect(api.props).toEqual([{ name: 'title', type: 'string', required: true, doc: 'Panel title' }]);
    expect(api.emits).toEqual([{ name: 'toggle', type: '()' }]);
    // defineSlots ∪ template <slot> — the type omits `extra`.
    expect(api.slots).toEqual(['body', 'extra']);
    cg.close?.();
  });

  it('attributes a doc to the member it annotates, never to the one below', async () => {
    fs.writeFileSync(path.join(dir, 'Row.vue'), `<template><div/></template>
<script setup lang="ts">
interface Props {
  /** Above a */
  a: string
  b: number // trailing note on b
  /** Before c */ c: string
}
defineProps<Props>()
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    expect(componentApi(cg, 'Row').props).toEqual([
      { name: 'a', type: 'string', required: true, doc: 'Above a' },
      // b's own trailing comment is NOT b's doc, and must not leak to c —
      // docs are what PRECEDES a member.
      { name: 'b', type: 'number', required: true },
      { name: 'c', type: 'string', required: true, doc: 'Before c' },
    ]);
    cg.close?.();
  });

  it('resolves template component references (incl. kebab-case) with AST line numbers', async () => {
    fs.writeFileSync(path.join(dir, 'Modal.vue'), '<template><div/></template>\n');
    fs.writeFileSync(path.join(dir, 'MyButton.vue'), '<template><button/></template>\n');
    fs.writeFileSync(path.join(dir, 'App.vue'), `<template>
  <Modal
    size="lg"
    @change="onChange">
    <my-button @click="onClick"/>
  </Modal>
</template>

<script setup lang="ts">
import Modal from './Modal.vue'
import MyButton from './MyButton.vue'
function onChange() {}
function onClick() {}
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // Parent→child component edges: App → Modal (line 2, the multi-line
    // opening tag) and App → MyButton (kebab tag, line 5). Filter to
    // component targets — App's component→handler binding edges are also
    // `references` (metadata.vueEvent) but target functions.
    const refs = db
      .prepare(
        `SELECT t.name AS target, e.line FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.kind = 'component' AND s.name = 'App' AND e.kind = 'references'
           AND t.kind = 'component'
         ORDER BY t.name`
      )
      .all();
    expect(refs).toEqual([
      { target: 'Modal', line: 2 },
      { target: 'MyButton', line: 5 },
    ]);

    // App.vue declares no API and no <slot> → no componentApi payload.
    expect(componentApi(cg, 'App')).toBeUndefined();
    cg.close?.();
  });

  it('records dynamic slots and keeps a native custom element out of component refs', async () => {
    fs.writeFileSync(path.join(dir, 'Widget.vue'), `<template>
  <my-lib-thing/>
  <slot :name="dynamicSlot"/>
</template>
<script setup lang="ts">
const dynamicSlot = 'x'
</script>
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const api = componentApi(cg, 'Widget');
    expect(api.slots).toEqual(['(dynamic)']);
    // <my-lib-thing/> is a hyphenated tag → still a component-shaped ref
    // (MyLibThing), even though no such node exists here.
    const refs = (cg as any).db.db
      .prepare(`SELECT reference_name FROM unresolved_refs WHERE reference_name = 'MyLibThing'`)
      .all();
    expect(refs.length).toBe(1);
    cg.close?.();
  });
});
