import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dir: string;
let cg: CodeGraph | undefined;
afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const families = {
  array: ['map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every', 'push', 'pop', 'slice', 'splice', 'sort', 'flatMap', 'includes', 'join'],
  collection: ['get', 'set', 'has', 'add', 'delete', 'clear', 'keys', 'values', 'entries'],
  string: ['trim', 'split', 'replace', 'replaceAll', 'match', 'matchAll', 'search', 'startsWith', 'endsWith', 'substring', 'toLowerCase', 'toUpperCase'],
  promise: ['then', 'catch', 'finally'],
  function: ['call', 'apply', 'bind'],
  event: ['on', 'once', 'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners', 'addEventListener', 'removeEventListener', 'dispatchEvent'],
  iterator: ['next', 'return', 'throw'],
};

describe.each(['ts', 'tsx', 'js', 'jsx'])('built-in method calls in %s (#1987)', (ext) => {
  it('does not guess project methods for unknown receivers, including class-name overlap', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1987-'));
    const declarations: string[] = [];
    const calls: string[] = [];
    for (const [family, methods] of Object.entries(families)) {
      // Receiver and class share a word; this is still no evidence of its type.
      declarations.push(`export class ${family}Wrapper {\n${methods.map(m => `  ${m}() {}\n`).join('')}}\n`);
      methods.forEach(m => calls.push(`export function ${family}_${m}(${family}) { ${family}.${m}(); }\n`));
    }
    fs.writeFileSync(path.join(dir, `decoys.${ext}`), declarations.join(''));
    fs.writeFileSync(path.join(dir, `calls.${ext}`), calls.join(''));
    cg = await CodeGraph.init(dir, { index: true });
    for (const caller of cg.getNodesByKind('function').filter(n => n.filePath === `calls.${ext}`)) {
      expect(cg.getCallees(caller.id).map(c => c.node.qualifiedName), caller.name).toEqual([]);
    }
    expect(cg.getNodesByKind('function').filter(n => n.filePath === `calls.${ext}`)).toHaveLength(calls.length);
  });

  it('retains every method family on a constructed or typed project receiver', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1987-'));
    const methods = [...new Set(Object.values(families).flat())];
    const typed = ext === 'ts' || ext === 'tsx';
    fs.writeFileSync(path.join(dir, `project.${ext}`), `
export class Project {
${methods.map(m => `  ${m}() {}\n`).join('')}
}
export function useConstructed() {
  const receiver = new Project();
${methods.map(m => `  receiver.${m}();\n`).join('')}
}
${typed ? `export function useTyped(receiver: Project) {
${methods.map(m => `  receiver.${m}();\n`).join('')}
}` : ''}
`);
    cg = await CodeGraph.init(dir, { index: true });
    for (const name of typed ? ['useConstructed', 'useTyped'] : ['useConstructed']) {
      const caller = cg.getNodesByKind('function').find(n => n.name === name)!;
      expect(cg.getCallees(caller.id).filter(c => c.node.kind === 'method').map(c => c.node.name).sort())
        .toEqual([...methods].sort());
    }
  });

  it('rejects built-in values but retains constructed, imported, literal and class receivers', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1987-'));
    const typed = ext === 'ts' || ext === 'tsx';
    fs.writeFileSync(path.join(dir, `cart.${ext}`), `
export class Cart {
  map() {}
  add() {}
  get() {}
  static bind() {}
  self() { this.add(); }
}
export const api = { map() {} };
export class LRUCache { get() {} }
`);
    fs.writeFileSync(path.join(dir, `calls.${ext}`), `
import { Cart, api } from './cart';
export function tidy(list${typed ? ': string[]' : ''}) { list.map(); }
export function cached() {
  const cache = new Map();
  cache.get('x');
}
export function unknownCache(cache) { cache.get('x'); }
export function literalArray() { const cart = []; cart.map(); }
export function literalString() { const cart = 'x'; cart.trim(); }
export function constructed() {
  const cart = new Cart();
  cart.add();
}
export function imported() { Cart.bind(); }
export function objectLiteral() { api.map(); }
export const local = { map() {} };
export function localLiteral() { local.map(); }
${typed ? 'export function typed(cart: Cart) { cart.map(); }' : ''}
`);
    cg = await CodeGraph.init(dir, { index: true });
    const callees = (name: string) => {
      const fn = cg!.getNodesByKind('function').find(n => n.name === name)!;
      expect(fn, name).toBeDefined();
      return cg!.getCallees(fn.id).filter(({ edge }) => edge.kind === 'calls').map(c => c.node.qualifiedName);
    };
    for (const name of ['tidy', 'cached', 'unknownCache', 'literalArray', 'literalString']) expect(callees(name), name).toEqual([]);
    expect(callees('constructed')).toContain('Cart::add');
    expect(callees('imported')).toContain('Cart::bind');
    expect(callees('objectLiteral')).toEqual(['api::map']);
    expect(callees('localLiteral')).toEqual(['local::map']);
    if (typed) expect(callees('typed')).toEqual(['Cart::map']);
    const self = cg.getNodesByKind('method').find(n => n.qualifiedName === 'Cart::self')!;
    expect(cg.getCallees(self.id).map(c => c.node.qualifiedName)).toEqual(['Cart::add']);
  });
});
