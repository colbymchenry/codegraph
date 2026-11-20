/**
 * The members of an object a module default-exports (#3393):
 *
 *   export default {
 *     defaultM() { return 1; },
 *     async defaultAsync() { return 2; },
 *   };
 *
 * #2300 made the function members of a named object literal nodes
 * (`export const x = { m() {} }` → `x::m`), but this object has no name, so
 * its members had none: a Vuex store module split into files (`actions.js`,
 * `getters.js`, `mutations.js` are each such an object) or an API module was
 * invisible to explore, node, query, callers and impact, and the calls in a
 * member were credited to the file. Now the object is owned by a constant
 * named for the export, `default`, its members read `default::defaultM`, a
 * call through the module's default import reaches them, and `this.m()`
 * between them is the object's own, as in a named literal. A Vue component's
 * script, whose default export is the component, keeps its shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel, resetKernelForTests } from '../src/extraction/kernel';

const kernelBuilt = fs.existsSync(path.join(__dirname, '../codegraph-kernel/prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));

describe.each(['native', 'wasm'].filter((backend) => backend === 'wasm' || kernelBuilt))(
  'default-exported object members (%s, #3393)', (backend) => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_KERNEL', backend === 'wasm' ? '0' : '1');
    vi.stubEnv('CODEGRAPH_KERNEL_LANGS', 'all');
    resetKernelForTests();
    if (backend === 'native') expect(getKernel()).not.toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-3393-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetKernelForTests();
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    cg = await CodeGraph.init(dir, { index: true });
    return cg;
  }

  /** The one node with this qualified name in `file`. */
  function node(g: CodeGraph, qualifiedName: string, file: string) {
    const found = g.getNodesByQualifiedName(qualifiedName).filter((n) => n.filePath === file);
    expect(found, `${qualifiedName}@${file}`).toHaveLength(1);
    return found[0]!;
  }
  /** `qualifiedName@file` at the other end of a node's `calls` edges. */
  const calls = (g: CodeGraph, id: string, direction: 'in' | 'out') =>
    (direction === 'in' ? g.getIncomingEdges(id) : g.getOutgoingEdges(id))
      .filter((e) => e.kind === 'calls')
      .map((e) => { const n = g.getNode(direction === 'in' ? e.source : e.target)!; return `${n.qualifiedName}@${n.filePath}`; })
      .sort();
  const callees = (g: CodeGraph, qn: string, file: string) => calls(g, node(g, qn, file).id, 'out');
  const callers = (g: CodeGraph, qn: string, file: string) => calls(g, node(g, qn, file).id, 'in');

  it("gives the issue's default-exported object its members, in JS, TS and TSX", async () => {
    const g = await index({
      'src/helper.js': 'export function helper() { return 1; }\n',
      // The issue's two files, as written there.
      'src/a_named.js': 'export const named = { namedM() { return 1; }, namedAsync: async () => 1 };\n',
      'src/b_default.js': [
        'import { helper } from "./helper";',
        'export default {',
        '  defaultM() { return helper(); },',
        '  async defaultAsync() { return 2; },',
        '  arrowM: () => helper(),',
        '  fnM: function () { return 3; },',
        '  value: 42,',
        '};',
        '',
      ].join('\n'),
      'src/c_default.ts': [
        'import { helper } from "./helper";',
        'export default {',
        '  tsM(): number { return helper(); },',
        '  tsArrow: (): number => 2,',
        '};',
        '',
      ].join('\n'),
      'src/d_default.tsx': [
        'import { helper } from "./helper";',
        'export default {',
        '  tsxM() { return helper(); },',
        '  render: () => <div>{helper()}</div>,',
        '};',
        '',
      ].join('\n'),
      'src/use.ts': [
        'import ts from "./c_default";',
        'import tsx from "./d_default";',
        'export function useTs() { return ts.tsM() + tsx.tsxM(); }',
        '',
      ].join('\n'),
    });

    for (const [qn, file] of [
      ['default::defaultM', 'src/b_default.js'], ['default::defaultAsync', 'src/b_default.js'],
      ['default::arrowM', 'src/b_default.js'], ['default::fnM', 'src/b_default.js'],
      ['default::tsM', 'src/c_default.ts'], ['default::tsArrow', 'src/c_default.ts'],
      ['default::tsxM', 'src/d_default.tsx'], ['default::render', 'src/d_default.tsx'],
      ['named::namedM', 'src/a_named.js'], ['named::namedAsync', 'src/a_named.js'],
    ] as const) {
      const member = node(g, qn, file);
      expect(member.kind, qn).toBe('function');
      // A member of the module's default export is exported with it.
      expect(member.isExported, qn).toBe(true);
    }
    expect(node(g, 'default::defaultAsync', 'src/b_default.js').isAsync).toBe(true);
    // `query defaultM` finds it.
    expect(g.getNodesByName('defaultM').map((n) => n.qualifiedName)).toEqual(['default::defaultM']);

    // The owner is the statement, a constant named for the export, and holds
    // the functions; a value member is no node of its own.
    const owner = node(g, 'default', 'src/b_default.js');
    expect(owner.kind).toBe('constant');
    expect(owner.isExported).toBe(true);
    expect(owner.startLine).toBe(2);
    expect(g.getOutgoingEdges(owner.id).filter((e) => e.kind === 'contains').map((e) => g.getNode(e.target)!.name).sort())
      .toEqual(['arrowM', 'defaultAsync', 'defaultM', 'fnM']);
    expect(g.getNodesByName('value')).toEqual([]);

    // The calls in a member are the member's, not the file's.
    expect(callees(g, 'default::defaultM', 'src/b_default.js')).toEqual(['helper@src/helper.js']);
    expect(callees(g, 'default::arrowM', 'src/b_default.js')).toEqual(['helper@src/helper.js']);
    expect(callees(g, 'default::render', 'src/d_default.tsx')).toEqual(['helper@src/helper.js']);
    for (const file of ['src/b_default.js', 'src/c_default.ts', 'src/d_default.tsx']) {
      expect(g.getOutgoingEdges(`file:${file}`).filter((e) => e.kind === 'calls'), file).toEqual([]);
    }
    // A TS module's default import reaches the members too.
    expect(callees(g, 'useTs', 'src/use.ts')).toEqual(['default::tsM@src/c_default.ts', 'default::tsxM@src/d_default.tsx']);
  });

  it('reaches the members through the default import, and this.m() between them', async () => {
    const g = await index({
      'store/actions.js': [
        'import api from "../api";',
        'export default {',
        '  async fetchUser({ commit }, id) {',
        '    const user = await api.getUser(id);',
        '    commit("SET_USER", user);',
        '    return user;',
        '  },',
        '  refresh(ctx) { return this.fetchUser(ctx, 0); },',
        '  bare(ctx) { return fetchUser(ctx, 1); },',
        '};',
        '',
      ].join('\n'),
      'api/index.js': 'export function helper() { return 0; }\nexport default {\n  getUser(id) { return fetch("/u/" + id); },\n};\n',
      'app.js': [
        'import actions from "./store/actions";',
        'export function load() { return actions.fetchUser({}, 1); }',
        'export function again() { return actions.refresh({}); }',
        '',
      ].join('\n'),
    });
    expect(callees(g, 'load', 'app.js')).toEqual(['default::fetchUser@store/actions.js']);
    expect(callees(g, 'again', 'app.js')).toEqual(['default::refresh@store/actions.js']);
    // `api.getUser()` through the default import of a module that also
    // exports a function of its own.
    expect(callees(g, 'default::fetchUser', 'store/actions.js')).toEqual(['default::getUser@api/index.js']);
    // A sibling's `this.fetchUser()` is the object's own; a bare call is not.
    expect(callees(g, 'default::refresh', 'store/actions.js')).toEqual(['default::fetchUser@store/actions.js']);
    expect(callees(g, 'default::bare', 'store/actions.js')).toEqual([]);
    expect(callers(g, 'default::fetchUser', 'store/actions.js')).toEqual([
      'default::refresh@store/actions.js', 'load@app.js',
    ]);
  });

  it('keeps a call through the default import in step with edits of the module', async () => {
    const g = await index({
      'store/actions.js': 'export default {\n  other() { return 1; },\n};\n',
      'app.js': 'import actions from "./store/actions";\nexport function load() { return actions.fetchUser(); }\n',
    });
    // A member the object lacks is a use of the object, as with a named literal.
    expect(callees(g, 'load', 'app.js')).toEqual(['default@store/actions.js']);
    fs.writeFileSync(path.join(dir, 'store/actions.js'), '// moved\nexport default {\n  other() { return 1; },\n  fetchUser() { return 2; },\n};\n');
    await g.sync();
    expect(callees(g, 'load', 'app.js')).toEqual(['default::fetchUser@store/actions.js']);
    fs.writeFileSync(path.join(dir, 'store/actions.js'), 'export default {\n  renamed() { return 3; },\n};\n');
    await g.sync();
    expect(g.getNodesByQualifiedName('default::fetchUser')).toEqual([]);
    expect(callees(g, 'load', 'app.js')).toEqual(['default@store/actions.js']);
  }, 30_000);

  it('reads a Vuex store module split into files, and keeps a whole module as it was', async () => {
    const g = await index({
      // A split module: each collection is its own default-exported object.
      'store/user/actions.js': 'export default {\n  login({ commit }, token) { commit("SET_TOKEN", token); },\n};\n',
      'store/user/mutations.js': 'export default {\n  SET_TOKEN(state, token) { state.token = token; },\n};\n',
      'store/user/index.js': [
        'import actions from "./actions";',
        'import mutations from "./mutations";',
        'export default {',
        '  namespaced: true,',
        '  state: () => ({ token: "" }),',
        '  actions,',
        '  mutations,',
        '};',
        '',
      ].join('\n'),
      // A store file whose actions file names its collections in a comment:
      // the Vuex vocabulary makes it a store file, but it has none.
      'store/cart/actions.js': '// cart actions, see getters\nexport default {\n  checkout({ commit }) { commit("CLEAR"); },\n};\n',
      // The whole module in one object, as the store-file reading has it.
      'store/app.js': [
        'export default {',
        '  namespaced: true,',
        '  state: () => ({ open: false }),',
        '  mutations: { TOGGLE(state) { state.open = !state.open; } },',
        '  actions: { toggle({ commit }) { commit("TOGGLE"); } },',
        '};',
        '',
      ].join('\n'),
    });
    expect(node(g, 'default::login', 'store/user/actions.js').kind).toBe('function');
    expect(node(g, 'default::SET_TOKEN', 'store/user/mutations.js').kind).toBe('function');
    expect(node(g, 'default::state', 'store/user/index.js').kind).toBe('function');
    expect(node(g, 'default::checkout', 'store/cart/actions.js').kind).toBe('function');
    // The whole module keeps its collections' functions, and no owner.
    expect(node(g, 'TOGGLE', 'store/app.js').kind).toBe('function');
    expect(node(g, 'toggle', 'store/app.js').kind).toBe('function');
    expect(g.getNodesByQualifiedName('default').filter((n) => n.filePath === 'store/app.js')).toEqual([]);
  });

  it("leaves a Vue component's options to the Vue extractor", async () => {
    const g = await index({
      'src/helper.js': 'export function helper() { return 1; }\n',
      'src/Panel.vue': [
        '<template><button @click="save">Save</button></template>',
        '<script>',
        'import { helper } from "./helper";',
        'export default {',
        '  name: "Panel",',
        '  data() { return { n: helper() }; },',
        '  mounted() { this.save(); },',
        '  methods: {',
        '    save() { return helper(); },',
        '  },',
        '};',
        '</script>',
        '',
      ].join('\n'),
    });
    for (const qn of ['Panel::data', 'Panel::mounted', 'Panel::save']) {
      expect(node(g, qn, 'src/Panel.vue').kind, qn).toBe('method');
    }
    expect(g.getNodesByQualifiedName('default')).toEqual([]);
    expect(g.getNodesInFile('src/Panel.vue').filter((n) => n.qualifiedName.startsWith('default::'))).toEqual([]);
    expect(callees(g, 'Panel::mounted', 'src/Panel.vue')).toEqual(['Panel::save@src/Panel.vue']);
  });

  it('leaves an object without a function member, a wrapped one, and a minified bundle as they were', async () => {
    const g = await index({
      'config.js': 'export default { name: "app", port: 8080, plugins: [] };\n',
      'computed.js': 'const KEY = "go";\nexport default { [KEY]() { return 1; } };\n',
      'as-const.ts': 'export default { asConst() { return 1; } } as const;\n',
      'satisfies.ts': 'type R = { check(): number };\nexport default { satisfiesM() { return 1; } } satisfies R;\n',
      'vendor/lib.min.js': 'export default{a:function(){return 1},b:function(){return 2}};\n',
    });
    expect(g.getNodesByQualifiedName('default')).toEqual([]);
    for (const name of ['asConst', 'satisfiesM', 'a', 'b']) expect(g.getNodesByName(name), name).toEqual([]);
  });
});
