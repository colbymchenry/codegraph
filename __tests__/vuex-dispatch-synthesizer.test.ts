/**
 * Vuex string-keyed dispatch/commit bridge.
 *
 * Vuex dispatches actions/mutations by a runtime STRING key — `dispatch('user/login')`,
 * `commit('SET_TOKEN')` — with no static edge to the handler (an object-literal
 * method in a store module). This bridges the key to its function node: the last
 * `/` segment is the action/mutation name, the preceding segment is the namespace
 * (≈ the module file). It resolves to a node IN A STORE FILE (excluding a same-named
 * `api/` helper — a real collision), disambiguated by the namespace appearing in the
 * path, or the same file for a root `commit('M')` inside an action. Redux-style
 * `dispatch(actionCreator())` (no string key) produces nothing.
 *
 * Also exercises the canonical Vuex MODULE shape `export default { namespaced,
 * actions: {…}, mutations: {…} }` — whose methods only become nodes via the
 * store-collection extraction this bridge depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('vuex-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('bridges namespaced dispatch + local commit to the right store handler, excluding an api collision', async () => {
    fs.mkdirSync(path.join(dir, 'store', 'modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    // Canonical Vuex module: `export default { namespaced, actions, mutations }`.
    fs.writeFileSync(
      path.join(dir, 'store', 'modules', 'user.js'),
      `import { login as apiLogin } from '../../api/user';
export default {
  namespaced: true,
  state: { token: '' },
  mutations: {
    SET_TOKEN(state, t) { state.token = t; },
  },
  actions: {
    login({ commit }, info) {
      apiLogin(info);
      commit('SET_TOKEN', info.token);   // root/local key → SET_TOKEN in THIS module
    },
  },
};
`
    );
    // Collision: an api helper ALSO named `login` — must never be the dispatch target.
    fs.writeFileSync(
      path.join(dir, 'api', 'user.js'),
      `export function login(info) { return info; }
`
    );
    // Consumer dispatches by namespaced string key.
    fs.writeFileSync(
      path.join(dir, 'app.js'),
      `import store from './store';
export function bootstrap() {
  store.dispatch('user/login', { token: 'x' });
}
`
    );
    // Redux-style control: a non-string dispatch must produce no vuex edge.
    fs.writeFileSync(
      path.join(dir, 'reduxy.js'),
      `export function reduxy(dispatch) {
  dispatch(someAction());
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, t.file_path tf, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'vuex-dispatch'`
      )
      .all();

    // bootstrap → login, resolving to the STORE module (not api/user.js).
    const loginEdge = edges.find((r: any) => r.source === 'bootstrap' && r.target === 'login');
    expect(loginEdge).toBeTruthy();
    expect(loginEdge.tf).toMatch(/store[\\/]modules[\\/]user\.js$/);
    expect(loginEdge.via).toBe('user/login');
    // The api helper of the same name was never targeted.
    expect(edges.some((r: any) => /api[\\/]user\.js$/.test(r.tf))).toBe(false);
    // Local commit('SET_TOKEN') inside the action → the same module's mutation.
    expect(edges.some((r: any) => r.source === 'login' && r.target === 'SET_TOKEN')).toBe(true);
    // Redux-style non-string dispatch contributed nothing.
    expect(edges.some((r: any) => r.source === 'reduxy')).toBe(false);

    cg.close?.();
  });

  it('bridges a store split into files, whose collections only the store file names (#3393)', async () => {
    fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'views'), { recursive: true });
    // The store file assembles the collections; it imports an API module too.
    fs.writeFileSync(
      path.join(dir, 'store', 'index.js'),
      `import Vuex from 'vuex';
import actions from './actions';
import mutations from './mutations';
import getters from './getters';
import api from '../api';
export function createStore() {
  return new Vuex.Store({ state: { lists: {} }, actions, mutations, getters, plugins: [api.plugin] });
}
`
    );
    // No collection file says anything of Vuex. An action commits the
    // mutation of its own name, and a getter shares an action's name.
    fs.writeFileSync(
      path.join(dir, 'store', 'actions.js'),
      `export default {
  FETCH_LIST({ commit, dispatch }, type) {
    commit('SET_LIST', { type });
    return dispatch('ENSURE_ITEMS');
  },
  ENSURE_ITEMS() { return 1; },
  patchList({ commit }, patch) { commit('patchList', patch); },
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'store', 'mutations.js'),
      `export default {
  SET_LIST(state, { type }) { state.lists[type] = []; },
  patchList(state, patch) { Object.assign(state.lists, patch); },
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'store', 'getters.js'),
      `export default {
  ENSURE_ITEMS: (state) => state.lists,
};
`
    );
    // An API module with an action's name, imported by the store as no collection.
    fs.writeFileSync(
      path.join(dir, 'api', 'index.js'),
      `export default {
  FETCH_LIST(type) { return fetch('/' + type); },
  plugin() {},
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'views', 'List.vue'),
      `<template><div /></template>
<script>
export default {
  methods: {
    load() { return this.$store.dispatch('FETCH_LIST', 'top'); },
  },
};
</script>
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = db
      .prepare(
        `SELECT s.qualified_name source, t.qualified_name target, t.file_path tf
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'vuex-dispatch'`
      )
      .all()
      .map((r: any) => `${r.source} -> ${r.target} @${r.tf.replace(/\\/g, '/')}`)
      .sort();
    // `dispatch` runs an action and `commit` a mutation, whichever file is nearer.
    expect(edges).toEqual([
      'List::load -> default::FETCH_LIST @store/actions.js',
      'default::FETCH_LIST -> default::ENSURE_ITEMS @store/actions.js',
      'default::FETCH_LIST -> default::SET_LIST @store/mutations.js',
      'default::patchList -> default::patchList @store/mutations.js',
    ]);
    cg.close?.();
  });

  it('commits a mutation and dispatches an action, not a namesake in another collection', async () => {
    fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
    // One module file, whose action and mutation share a name, beside a getter.
    fs.writeFileSync(
      path.join(dir, 'store', 'user.js'),
      `const getters = { load: (state) => state.user };
const actions = {
  load({ commit }) { commit('load', 1); },
};
const mutations = {
  load(state, user) { state.user = user; },
};
export default { namespaced: true, state: { user: null }, getters, actions, mutations };
`
    );
    fs.writeFileSync(
      path.join(dir, 'app.js'),
      `import store from './store/user';
export function start() { return store.dispatch('user/load'); }
`
    );
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = db
      .prepare(
        `SELECT s.qualified_name source, t.qualified_name target
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'vuex-dispatch'`
      )
      .all()
      .map((r: any) => `${r.source} -> ${r.target}`)
      .sort();
    expect(edges).toEqual(['actions::load -> mutations::load', 'start -> actions::load']);
    cg.close?.();
  });
});
