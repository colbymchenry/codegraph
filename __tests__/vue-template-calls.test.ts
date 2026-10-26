/**
 * A call is a call wherever a Vue component writes it (#2340): in the
 * `<template>` (`{{ useBar(link) }}`, `:to="useBar(link.location)"`,
 * `@click="save(item)"`), and in a destructuring declaration at module or
 * `<script setup>` scope (`const { a } = useFoo(1)`). Neither used to record
 * one, so `callers` on a Nuxt composable missed most of the components using
 * it. (`src/extraction/vue-template-calls.ts`, wired in `vue-extractor.ts`;
 * the destructuring walk is in `tree-sitter.ts` extractVariable and the
 * kernel's `tsjs/extractors.rs`.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { vueTemplateCalls } from '../src/extraction/vue-template-calls';

const names = (source: string) => vueTemplateCalls(source).map((c) => c.name);

describe('vueTemplateCalls', () => {
  it('finds calls in interpolations, bindings, directives and handlers, at their offsets', () => {
    const source = `<template>
  <NuxtLink :to="useBar(link.location)" v-if="canShow(link)">{{ useBar(link) }}</NuxtLink>
  <li v-for="row in rowsFor(user)" v-show="visible()" v-my-dir="setup(1)">{{ label(row) }}</li>
  <button @click="save(item)" v-on:keyup.enter="submit()" @input="onInput">go</button>
  <Comp :style="{ color: tint() }" :title="\`#\${index(n)}\`" @change="(v) => update(v)" />
</template>
`;
    const calls = vueTemplateCalls(source);
    expect(calls.map((c) => c.name)).toEqual([
      'useBar', 'canShow', 'useBar',
      'rowsFor', 'visible', 'setup', 'label',
      'save', 'submit',
      'tint', 'index', 'update',
    ]);
    // Offsets point at the callee in the SFC source.
    for (const c of calls) expect(source.slice(c.offset, c.offset + c.name.length)).toBe(c.name);
  });

  it('names a member call by its path, as a script call is named', () => {
    expect(names(`<template>
  <p @click="store.fetchUsers()" :a="user?.profile?.load()" :b="fn?.(1)">{{ props.format(v) }}</p>
  <p :c="list[0].go()" :d="make().then(x => x.done())">{{ (a as B).run() }}</p>
</template>`)).toEqual(['store.fetchUsers', 'user.profile.load', 'fn', 'props.format', 'make']);
  });

  it('skips names the template binds: v-for aliases and slot props in their subtree, arrow and function parameters', () => {
    expect(names(`<template>
  <ul>
    <li v-for="(item, i) in items" :key="item.id" @click="item.select(i)">
      {{ item.label() }} {{ format(item) }}
      <Row #default="{ row, toggle }">{{ toggle(row) }} {{ rowLabel(row) }}</Row>
    </li>
  </ul>
  <Comp :cb="function (x) { return x.go() }" :keys="(k) => k.trim()" @done="cb => cb()" />
  <p>{{ toggle() }} {{ item() }}</p>
</template>`)).toEqual(['format', 'rowLabel', 'toggle', 'item']);
  });

  it('skips what is never project code: strings, Vue template globals, $-helpers, keywords, new, object methods', () => {
    expect(names(`<template>
  <p :title="$t('x')" :class="'a(b)'">{{ Math.max(a(), 1) }} {{ JSON.stringify(c) }} {{ $route.query.x }}</p>
  <p v-if="typeof x === 'function' && /f(o)/.test(s)">{{ new Date(stamp()).getTime() }} {{ "no()" }}</p>
  <Chart :options="{ formatter(v) { return fmt(v) } }" @click="$emit('close')" />
</template>`)).toEqual(['a', 'stamp', 'fmt']);
  });

  it('reads a CRLF file the same way', () => {
    const lf = '<template>\n  <p\n    :title="label(\n      item)"\n  >{{ useBar(x) }}</p>\n</template>\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(names(crlf)).toEqual(['label', 'useBar']);
    for (const c of vueTemplateCalls(crlf)) expect(crlf.slice(c.offset, c.offset + c.name.length)).toBe(c.name);
  });

  it('reads only the root template, and only what Vue compiles', () => {
    expect(names(`<template>
  <!-- {{ commented() }} -->
  <div v-pre>{{ raw() }} <span :x="raw()"></span></div>
  <template v-if="cond()"><span>{{ inner() }}</span></template>
  <p data-x="plain(1)">{{ after() }}</p>
</template>
<script setup>
const x = scriptCall()
</script>
<i18n>{ "en": { "a": "{{ notTemplate() }}" } }</i18n>`)).toEqual(['cond', 'inner', 'after']);
    expect(names('<template lang="pug">\ndiv {{ pug() }}\n</template>')).toEqual([]);
    expect(names('<script setup>\nconst a = b()\n</script>')).toEqual([]);
  });
});

describe('calls written in Vue components, indexed (#2340)', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function write(files: Record<string, string>): void {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-calls-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
  }

  function callersOf(name: string, file: string): string[] {
    const target = cg!.getNodesInFile(file).find((n) => n.name === name && (n.kind === 'function' || n.kind === 'method'));
    expect(target, `${name} in ${file}`).toBeDefined();
    return cg!.getCallers(target!.id).map(({ node }) => `${node.filePath}:${node.kind}`).sort();
  }

  it("finds every caller in the issue's repro", async () => {
    write({
      'package.json': JSON.stringify({ name: 'nuxt-app', dependencies: { nuxt: '^4.0.0' } }),
      'composables/useFoo.ts': 'export function useFoo(n: number) { return { a: n }; }\n',
      'composables/useBar.ts': 'export function useBar(x: unknown) { return String(x); }\n',
      'components/A.vue': '<script setup lang="ts">\nconst { a } = useFoo(1)\n</script>\n',
      'components/F.vue': '<script setup lang="ts">\nconst [b] = useFoo(1)\n</script>\n',
      'components/B.vue': '<script setup lang="ts">\nconst x = useFoo(1)\n</script>\n',
      'components/H.vue': '<template><div>{{ useBar(link) }}</div></template>\n',
      'components/I.vue': '<template><NuxtLink :to="useBar(link.location)">x</NuxtLink></template>\n',
      'G.ts': 'const { a } = useFoo(1)\nexport const g = a\n',
      'D.ts': 'export function probe() { const { a } = useFoo(1); return a }\n',
    });
    cg = await CodeGraph.init(root, { index: true });

    expect(callersOf('useFoo', 'composables/useFoo.ts')).toEqual([
      'D.ts:function', // inside a function: already found
      'G.ts:file', // module scope: the file is the caller
      'components/A.vue:component',
      'components/B.vue:component',
      'components/F.vue:component',
    ]);
    expect(callersOf('useBar', 'composables/useBar.ts')).toEqual([
      'components/H.vue:component',
      'components/I.vue:component',
    ]);
  });

  it('links a template call to an imported helper, a script-setup function and an Options API method', async () => {
    write({
      'utils/format.ts': 'export function formatPrice(n: number) { return `$${n}`; }\n',
      'other/format.ts': 'export function formatPrice(n: number) { return n; }\n',
      'components/Setup.vue': `<template>
  <p>{{ formatPrice(item.price) }}</p>
  <button @click="save(item)">save</button>
</template>

<script setup lang="ts">
import { formatPrice } from '../utils/format';
const props = defineProps<{ item: { price: number } }>();
function save(item: unknown) { return item; }
</script>
`,
      'components/Options.vue': `<template>
  <p>{{ total(items) }}</p>
  <button @click="submit(form)">send</button>
</template>

<script>
export default {
  methods: {
    total(items) { return items.length },
    submit(form) { return form }
  }
}
</script>
`,
    });
    cg = await CodeGraph.init(root, { index: true });

    const edgesFrom = (file: string) => {
      const comp = cg!.getNodesInFile(file).find((n) => n.kind === 'component')!;
      return cg!.getOutgoingEdges(comp.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => {
          const t = cg!.getNode(e.target)!;
          return `${t.name}@${t.filePath}:${e.line}`;
        })
        .sort();
    };
    // The import decides which `formatPrice`; each edge is on its template line.
    expect(edgesFrom('components/Setup.vue')).toEqual([
      'formatPrice@utils/format.ts:2',
      'save@components/Setup.vue:3',
    ]);
    // A template calls the component's own methods without `this.`.
    expect(edgesFrom('components/Options.vue')).toEqual([
      'submit@components/Options.vue:3',
      'total@components/Options.vue:2',
    ]);
  });

  it("calls a component's own function even where Nuxt auto-imports one of that name", async () => {
    write({
      'package.json': JSON.stringify({ name: 'nuxt-app', dependencies: { nuxt: '^4.0.0' } }),
      'pages/lists.vue': `<template>
  <button @click="clearError(true)">x</button>
</template>

<script setup lang="ts">
function clearError(focus: boolean) { return focus; }
onDeactivated(() => clearError(false));
</script>
`,
    });
    cg = await CodeGraph.init(root, { index: true });

    const nodes = cg.getNodesInFile('pages/lists.vue');
    const comp = nodes.find((n) => n.kind === 'component')!;
    const own = nodes.find((n) => n.kind === 'function' && n.name === 'clearError')!;
    const calls = cg.getOutgoingEdges(comp.id).filter((e) => e.kind === 'calls');
    // Both calls are the local function's — not Nuxt's `clearError`, which
    // the framework rule used to answer with an edge from the component to itself.
    expect(calls.filter((e) => e.target === own.id).map((e) => e.line).sort()).toEqual([2, 7]);
    expect(calls.filter((e) => e.target === comp.id)).toEqual([]);
  });

  it('keeps a bare handler linked, and binds a handler expression only through its own call', async () => {
    write({
      'lib/bus.ts': 'export class Bus {\n  emit(event: string) { return event; }\n}\n',
      'components/Dialog.vue': `<template>
  <button @click="close">x</button>
  <button @click="emit('cancel')">cancel</button>
  <button @click="open = !open">toggle</button>
</template>

<script setup lang="ts">
const emit = defineEmits(['cancel']);
let open = false;
function close() { open = false; }
</script>
`,
    });
    cg = await CodeGraph.init(root, { index: true });

    const comp = cg.getNodesInFile('components/Dialog.vue').find((n) => n.kind === 'component')!;
    const targets = cg.getOutgoingEdges(comp.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!)
      .map((n) => `${n.kind}:${n.name}`);
    // `@click="close"` is still the handler it names.
    expect(targets).toContain('function:close');
    // `emit('cancel')` is the component's `defineEmits` binding, and `open =
    // !open` calls nothing: neither reaches Bus.emit.
    expect(targets).not.toContain('method:emit');
  });
});
