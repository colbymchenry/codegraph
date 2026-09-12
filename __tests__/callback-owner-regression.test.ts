import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

it.each([[false, false, false], [true, false, false], [false, true, false], [false, false, true]])('callback belongs to registering class, inherited=%s bound=%s oneLine=%s', async (inherited, bound, oneLine) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callback-owner-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'a_decoy.ts'), 'export class Decoy { triggerRender() {} }');
    fs.writeFileSync(path.join(root, 'store.ts'), `class OtherStore {
      private handlers = new Set<Function>();
      subscribe(cb: Function) { this.handlers.add(cb); }
      emit() { this.handlers.forEach(h => h()); }
    }
    export class Store {
      private handlers = new Set<Function>();
      subscribe(cb: Function) { this.handlers.add(cb); }
      emit() { this.handlers.forEach(h => h()); }
    }`);
    fs.writeFileSync(path.join(root, 'base.ts'), 'export class Base { triggerRender() {} }');
    fs.writeFileSync(path.join(root, 'real.ts'), `import { Store } from './store';
      import { Base } from './base';
      class SameFileDecoy { triggerRender() {} }
      export class Real ${inherited ? 'extends Base' : ''} {
        store = new Store();
        init() { this.store.subscribe(this.triggerRender${bound ? ".bind(this)" : ""}); }
        ${inherited ? '' : 'triggerRender() {}'}
      }`);
    if (oneLine) {
      const file = path.join(root, 'real.ts');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, ' '));
    }
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const emit = cg.getNodesByName('emit').find(n => n.qualifiedName === 'Store::emit')!;
    const other = cg.getNodesByName('emit').find(n => n.qualifiedName === 'OtherStore::emit')!;
    expect(cg.getCallees(other.id).filter(x => x.edge.metadata?.synthesizedBy === 'callback')).toEqual([]);
    const targets = cg.getCallees(emit.id).filter(x => x.edge.metadata?.synthesizedBy === 'callback').map(x => x.node.qualifiedName);
    expect(targets).toEqual([inherited ? 'Base::triggerRender' : 'Real::triggerRender']);
  } finally { cg?.close(); fs.rmSync(root, {recursive:true,force:true}); }
});
