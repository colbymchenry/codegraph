import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let dir: string;
let cg: CodeGraph;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-release-regressions-'));
  const write = (name: string, source: string) => fs.writeFileSync(path.join(dir, name), source);
  write('scene.ts', `export class Scene {
    callbacks = new Set<() => void>();
    onUpdate(cb: () => void) { this.callbacks.add(cb); }
    triggerUpdate() { for (const cb of this.callbacks) { cb(); } }
  }`);
  write('app.tsx', `import { Scene } from './scene';
  export class App {
    scene: Scene = new Scene();
    componentDidMount() { this.scene.onUpdate(this.triggerRender); }
    triggerRender() { return 1; }
  }`);
  for (const [name, targetExt, callerExt] of [['Reverse', 'tsx', 'ts'], ['Legacy', 'js', 'jsx'], ['LegacyReverse', 'jsx', 'js']]) {
    write(`${name}.${targetExt}`, `export class ${name} { send() { return 1; } }`);
    write(`${name}Caller.${callerExt}`, `import { ${name} } from './${name}';
    export class ${name}Caller {
      service = new ${name}();
      send() { return this.service.send(); }
    }`);
  }
  write('store.ts', `import { create } from 'zustand';
  interface S { fetchUser(): Promise<void>; reset(): void }
  export const useStore = create<S>((set, get, api) => ({
    fetchUser: async () => { get().reset(); },
    reset: () => set({}),
  }));
  export const anotherStore = create((set, get) => ({
    reset: () => set({}),
  }));`);
  write('consumer.ts', `import { useStore as current, anotherStore } from './store';
  function fetchUser() { return 'local'; }
  export async function loginFlow() {
    const { fetchUser } = current.getState();
    await fetchUser();
  }
  export function hardReset() { current.getState().reset(); }
  export function multipleBindings() {
    const { fetchUser, reset } = current.getState();
    fetchUser(); reset();
  }
  export function otherReset() { anotherStore.getState().reset(); }
  export function shadowed() {
    const { fetchUser } = current.getState();
    { const fetchUser = () => 'shadow'; fetchUser(); }
  }
  export function siblingScope(flag: boolean) {
    if (flag) { const { fetchUser } = current.getState(); }
    return fetchUser();
  }
  export function unknownStore(unknown: any) { unknown.getState().reset(); }
  export function unknownFactory(db: any) { db.prepare().reset(); }
  `);
  write('not-a-store.ts', `export const fake = otherFactory(() => ({ reset() { return 1; } }));`);
  write('barrel.ts', `export { useStore as routedStore } from './store';`);
  write('barrel-consumer.ts', `import { routedStore as current } from './barrel';
  export function barrelReset() { current.getState().reset(); }
  export function barrelSelected() { const selected = current(s => s.reset); selected(); }
  `);
  write('selectors.ts', `import { useStore as current, anotherStore } from './store';
  import { fake } from './not-a-store';
  export function rootShadow(current: any) { const selected = current(s => s.reset); selected(); }
  export function rootBlockShadow() { const current = fake; const selected = current(s => s.reset); selected(); }
  export function fakeSelector() { const selected = fake(s => s.reset); selected(); }
  export function Screen() {
    const selected = current((s) => s.reset);
    const otherSelected = anotherStore(s => s.reset);
    function captured() { selected(); }
    function otherCaptured() { otherSelected(); }
    function parameterShadow(selected: () => void) { selected(); }
    const arrowShadow = (selected: () => void) => { selected(); };
    function localShadow() { const selected = () => 1; selected(); }
    return { captured, otherCaptured, parameterShadow, arrowShadow, localShadow };
  }
  export function sibling() { const selected = current(s => s.reset); }
  export function outside() { selected(); }
  export function wrongSelector(other: any) {
    const selected = current(s => other.reset);
    selected();
  }
  export function unknownSelector(unknown: any) {
    const selected = unknown(s => s.reset);
    selected();
  }
  `);
  write('effects.ts', `import { client } from './client';
  export function create() { return 1; }
  export function effects() {
    client.user.create({ data: {} });
    client?.user?.create({ data: {} });
  }
  `);
  write('client.ts', `export const client = {};`);
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 60000);
afterAll(() => {
  cg?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function node(name: string, file?: string, line?: number) {
  const nodes = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')];
  const found = nodes.find(n => n.qualifiedName === name && (!file || n.filePath === file) && (!line || n.startLine === line));
  expect(found, `${file ?? ''}:${name}`).toBeDefined();
  return found!;
}
const targets = (id: string) => cg.getOutgoingEdges(id).filter(e => e.kind === 'calls').map(e => e.target);

describe('release-to-main correctness regressions', () => {
  it('keeps the TSX → TS observer registration and resulting callback flow', () => {
    expect(targets(node('App::componentDidMount').id)).toContain(node('Scene::onUpdate').id);
    expect(targets(node('Scene::triggerUpdate').id)).toContain(node('App::triggerRender').id);
  });
  it.each(['Reverse', 'Legacy', 'LegacyReverse'])('resolves %s across sibling JS/TS extensions', (name) => {
    expect(targets(node(`${name}Caller::send`).id)).toEqual([node(`${name}::send`).id]);
  });
  it('traces a destructured imported store action ahead of a same-named local function', () => {
    expect(targets(node('loginFlow').id)).toContain(node('fetchUser', 'store.ts').id);
    expect(targets(node('loginFlow').id)).not.toContain(node('fetchUser', 'consumer.ts').id);
  });
  it('resolves both accessor forms to implementations even with interface signatures and a second store', () => {
    const reset = node('reset', 'store.ts', 5).id;
    const other = node('reset', 'store.ts', 8).id;
    expect(targets(node('fetchUser', 'store.ts').id)).toContain(reset);
    expect(targets(node('hardReset').id)).toContain(reset);
    expect(targets(node('hardReset').id)).not.toContain(other);
    expect(targets(node('otherReset').id)).toContain(other);
    expect(targets(node('otherReset').id)).not.toContain(reset);
  });
  it('traces each action in a declaration with multiple named bindings', () => {
    const calls = targets(node('multipleBindings').id);
    expect(calls).toContain(node('fetchUser', 'store.ts').id);
    expect(calls).toContain(node('reset', 'store.ts', 5).id);
  });
  it.each(['shadowed', 'siblingScope'])('does not leak a destructured action into %s', (name) => {
    expect(targets(node(name).id)).not.toContain(node('fetchUser', 'store.ts').id);
  });
  it('follows selectors captured by closures to their own store action', () => {
    expect(targets(node('Screen::captured').id)).toEqual([node('reset', 'store.ts', 5).id]);
    expect(targets(node('Screen::otherCaptured').id)).toEqual([node('reset', 'store.ts', 8).id]);
  });
  it.each(['barrelReset', 'barrelSelected'])('resolves %s through both a re-export and local import alias', (name) => {
    const store = cg.getNodesByKind('constant').find(n => n.name === 'useStore' && n.filePath === 'store.ts')!;
    // The imported store itself is also referenced by the accessor/hook call.
    // Pin the whole target set so the other store's same-named reset cannot leak in.
    expect(targets(node(name, 'barrel-consumer.ts').id).sort()).toEqual([node('reset', 'store.ts', 5).id, store.id].sort());
  });
  it.each(['Screen::parameterShadow', 'Screen::arrowShadow', 'Screen::localShadow', 'outside', 'wrongSelector', 'unknownSelector', 'rootShadow', 'rootBlockShadow'])('does not guess a selector action in %s', (name) => {
    const calls = targets(node(name, 'selectors.ts').id);
    expect(calls).not.toContain(node('reset', 'store.ts', 5).id);
    expect(calls).not.toContain(node('reset', 'store.ts', 8).id);
  });
  it('retains external call sites without binding them to an import or same-named function', () => {
    const caller = node('effects', 'effects.ts');
    expect(targets(caller.id)).toEqual([]);
    expect(targets(node('fakeSelector', 'selectors.ts').id)).not.toContain(node('reset', 'not-a-store.ts').id);
    const refs = cg.getUnresolvedReferencesFrom(caller.id).filter(r => r.referenceKind === 'calls');
    expect(refs.map(r => r.referenceName)).toEqual(['client.user.create', 'client.user.create']);
  });
  it.each(['unknownStore', 'unknownFactory'])('does not guess an action for %s', (name) => {
    for (const action of cg.getNodesByKind('function').filter(n => n.filePath === 'store.ts')) {
      expect(targets(node(name).id)).not.toContain(action.id);
    }
  });
});
