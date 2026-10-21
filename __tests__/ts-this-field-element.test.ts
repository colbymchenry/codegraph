/**
 * A TS/JS method called on an element of a field of the enclosing class —
 * `this.handlers[type].handle()`, `this.items[0].save()` — reaches the
 * element's type as the field's declaration writes it (`Item[]`,
 * `Array<Item>`, `Record<string, Handler>`), or nothing. It used to keep the
 * bare method name, which exact-matched any project method of that name:
 * `this.listeners[type].push(h)` reached a stack class's `push` in another
 * file. `this['svc'].start()` is the field `svc` itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dir: string;
let cg: CodeGraph;

const files: Record<string, string> = {
  'src/model.ts':
    'export class Item { save() { return 1; } }\n' +
    'export class Handler { handle(t: string) { return t; } start() { return 0; } }\n',
  // Same-named methods a bare-name match would reach.
  'src/decoy.ts':
    'export class UndoStack { push(entry: string) { return entry; } }\n' +
    'export class Other { save() { return 2; } handle(t: string) { return t; } }\n',
  'src/holder.ts':
    "import { Item, Handler } from './model';\n" +
    'export class Holder {\n' +
    '  private items: Item[] = [];\n' +
    '  private list: Array<Item> = [];\n' +
    '  private handlers: Record<string, Handler> = {};\n' +
    '  private listeners: Record<string, string[]> = {};\n' +
    '  private names: string[] = [];\n' +
    '  private svc: Handler = new Handler();\n' +
    '  #store: Item[] = [];\n' +
    '  first() { return this.items[0].save(); }\n' +
    '  fromList(i: number) { return this.list[i].save(); }\n' +
    '  fire(t: string) { return this.handlers[t].handle(t); }\n' +
    '  keyed() { return this.handlers["main"].handle("x"); }\n' +
    '  cast() { return (this.items[1] as Item).save(); }\n' +
    '  asserted() { return this.items![0]!.save(); }\n' +
    '  privately() { return this.#store[0].save(); }\n' +
    "  byKey() { return this['svc'].start(); }\n" +
    '  on(type: string, h: string) { this.listeners[type].push(h); }\n' +
    '  builtin(i: number) { return this.names[i].trim(); }\n' +
    '}\n',
  // `Item` here is the class's type parameter, not the project class.
  'src/store.ts':
    'export class Store<Item> {\n' +
    '  private items: Item[] = [];\n' +
    '  private byKey: Record<string, Item> = {};\n' +
    '  first() { return this.items[0].save(); }\n' +
    '  keyed(k: string) { return this.byKey[k].save(); }\n' +
    '}\n' +
    // A header over several lines, and a constraint holding braces.
    'export class Wide<\n' +
    '  A,\n' +
    '  B,\n' +
    '  Item\n' +
    '> {\n' +
    '  private items: Item[] = [];\n' +
    '  first() { return this.items[0].save(); }\n' +
    '}\n' +
    'export class Shaped<Item extends { id: string }> {\n' +
    '  private items: Item[] = [];\n' +
    '  first() { return this.items[0].save(); }\n' +
    '}\n',
  // Either array's element: no one type to resolve on.
  'src/mixed.ts':
    "import { Item } from './model';\n" +
    "import { Other } from './decoy';\n" +
    'export class Mixed {\n' +
    '  private entries: Item[] | Other[] = [];\n' +
    '  private maybe: Item[] | null = null;\n' +
    '  either() { return this.entries[0].save(); }\n' +
    '  nullable() { return this.maybe![0].save(); }\n' +
    '  private below: Array<Item>\n' +
    '    | Other = [];\n' +
    '  private joined: Item[] & Other[] = [];\n' +
    '  continued() { return this.below[0].save(); }\n' +
    '  both() { return this.joined[0].save(); }\n' +
    '}\n',
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-this-element-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const calleesOf = (name: string, file = 'holder.ts') => {
  const caller = cg.getNodesByName(name).find((n) => n.filePath.endsWith(file) && n.kind === 'method')!;
  return cg.getCallees(caller.id)
    .filter(({ edge }) => edge.kind === 'calls')
    .map(({ node: n }) => `${path.basename(n.filePath)}:${n.qualifiedName}`)
    .sort();
};

describe('a call on an element of a this-field', () => {
  it.each([
    ['first', 'model.ts:Item::save'],
    ['fromList', 'model.ts:Item::save'],
    ['fire', 'model.ts:Handler::handle'],
    ['keyed', 'model.ts:Handler::handle'],
    ['cast', 'model.ts:Item::save'],
    ['asserted', 'model.ts:Item::save'],
    ['privately', 'model.ts:Item::save'],
    ['byKey', 'model.ts:Handler::start'],
  ])('%s reaches the element type', (caller, target) => {
    expect(calleesOf(caller)).toEqual([target]);
  });

  it('an element of a builtin type reaches no project method', () => {
    expect(calleesOf('on')).toEqual([]);
    expect(calleesOf('builtin')).toEqual([]);
  });

  it("a class's type parameter is not the project class of that name", () => {
    expect(calleesOf('first', 'store.ts')).toEqual([]);
    expect(calleesOf('keyed', 'store.ts')).toEqual([]);
    const caller = (cls: string) => cg.getNodesByName('first').find((n) => n.qualifiedName === `${cls}::first`)!;
    for (const cls of ['Wide', 'Shaped']) expect(cg.getCallees(caller(cls).id).filter(({ edge }) => edge.kind === 'calls')).toEqual([]);
  });

  it('a union of element types reaches none of them; `| null` keeps the one', () => {
    expect(calleesOf('either', 'mixed.ts')).toEqual([]);
    expect(calleesOf('nullable', 'mixed.ts')).toEqual(['model.ts:Item::save']);
    expect(calleesOf('continued', 'mixed.ts')).toEqual([]);
    expect(calleesOf('both', 'mixed.ts')).toEqual([]);
  });
});
