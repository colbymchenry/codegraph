/**
 * A Vue Options API component's functions are symbols: `methods`, `computed`,
 * `watch` entries and the lifecycle hooks, each owning the calls written in it.
 * (`src/extraction/vue-options-api.ts`, wired in `vue-extractor.ts`.)
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { vueOptionsMembers } from '../src/extraction/vue-options-api';

describe('vueOptionsMembers', () => {
  it('names every function an options object declares', () => {
    const script = `
import { mapActions } from 'vuex'
export default {
  name: 'Login',
  props: { redirect: String },
  data() {
    return { loading: false }
  },
  computed: {
    title() { return 'Sign in' },
    fullName: {
      get() { return this.first },
      set(v) { this.first = v }
    },
    ...mapGetters(['user'])
  },
  watch: {
    $route: { handler(route) { this.redirect = route.query.redirect }, immediate: true },
    'form.email'(value) { this.check(value) },
    loading: 'onLoading'
  },
  created() { this.init() },
  mounted: function () { this.focus() },
  methods: {
    ...mapActions(['login']),
    async handleLogin() { await this.login() },
    validate: (value) => value.length > 0,
    reset: function () {},
    [DYNAMIC]() {}
  }
}
`;
    expect(vueOptionsMembers(script).map((m) => m.name)).toEqual([
      'data', 'title', 'fullName', '$route', 'form.email', 'created', 'mounted', 'handleLogin', 'validate', 'reset',
    ]);
  });

  it('reads defineComponent, Vue.extend and Vue.component, and nothing without an options object', () => {
    expect(vueOptionsMembers(`export default defineComponent({ setup() { return {} } })`).map((m) => m.name)).toEqual(['setup']);
    expect(vueOptionsMembers(`export default Vue.extend({ methods: { go() {} } })`).map((m) => m.name)).toEqual(['go']);
    expect(vueOptionsMembers(`export default Vue.component('x-btn', { methods: { tap() {} } })`).map((m) => m.name)).toEqual(['tap']);
    expect(vueOptionsMembers(`const x = { methods: { go() {} } }\nexport default x`)).toEqual([]);
  });
});

describe('a Vue Options API component, indexed', () => {
  let root = '';
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives each method its calls, and the template handler its method', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-options-'));
    fs.mkdirSync(path.join(root, 'src/views/login'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'admin', dependencies: { vue: '^2.6.0' } }));
    fs.writeFileSync(
      path.join(root, 'src/views/login/index.vue'),
      `<template>
  <form>
    <button @click="handleLogin">Sign in</button>
  </form>
</template>

<script>
export default {
  name: 'Login',
  data() {
    return { loading: false }
  },
  methods: {
    handleLogin() {
      if (this.validate()) {
        this.loading = true
      }
    },
    validate() {
      return true
    }
  }
}
</script>
`
    );
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const nodes = cg.getNodesInFile('src/views/login/index.vue');
      const method = (name: string) => nodes.find((n) => n.kind === 'method' && n.name === name)!;
      expect(nodes.filter((n) => n.kind === 'method').map((n) => n.name).sort()).toEqual(['data', 'handleLogin', 'validate']);
      expect(method('handleLogin').qualifiedName).toBe('index::handleLogin');
      // The call inside handleLogin is handleLogin's, not the file's.
      const calls = cg.getOutgoingEdges(method('handleLogin').id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.name);
      expect(calls).toContain('validate');
      // `@click="handleLogin"` in the template runs the method.
      const component = nodes.find((n) => n.kind === 'component')!;
      const handlers = cg.getOutgoingEdges(component.id).filter((e) => e.target === method('handleLogin').id);
      expect(handlers.length).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });
});
