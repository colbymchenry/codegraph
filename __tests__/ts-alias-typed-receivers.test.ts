/**
 * A receiver typed by a type alias of a class has that class's methods.
 *
 * `bridge: BackendBridge`, where `type BackendBridge = Bridge<A, B>`, is a typed
 * receiver whose type no class is named: the typed lookup found no method, and
 * the type being no class of the project's made the call past guessing, so
 * react's four `bridge.send(…)` calls linked to nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-alias-receiver-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

function callees(cg: CodeGraph, qualifiedName: string): string[] {
  const node = cg.getNodesByQualifiedName(qualifiedName)[0];
  expect(node, qualifiedName).toBeDefined();
  return cg.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

const BRIDGE = `export class Bridge<A, B> {
  send(event: string) { return event; }
}
class Base { shutdown() {} }
export class Derived extends Base {}
export type BackendBridge = Bridge<string, number>;
export type Maybe = Bridge<string, number> | null; // the second is the receiver's
export type Chained = BackendBridge;
export type WithDefault<T = string> = Bridge<T, number>;
export type Inherited = Derived;
`;

describe('a receiver typed by a type alias', () => {
  it.each([
    ['a generic class', 'BackendBridge'],
    ['a nullable one', 'Maybe'],
    ['an alias of an alias', 'Chained'],
    ['a type parameter with a default', 'WithDefault<number>'],
  ])('calls the method of the class of %s', async (_shape, type) => {
    const cg = await indexProject({
      'bridge.ts': BRIDGE,
      'use.ts': `import type { ${type.split('<')[0]} } from './bridge';\nexport function run(link: ${type}) { link.send('a'); }\n`,
    });
    expect(callees(cg, 'run')).toEqual(['Bridge::send']);
  });

  it('reaches a method the class inherits', async () => {
    const cg = await indexProject({
      'bridge.ts': BRIDGE,
      'use.ts': "import type { Inherited } from './bridge';\nexport function run(link: Inherited) { link.shutdown(); }\n",
    });
    expect(callees(cg, 'run')).toEqual(['Base::shutdown']);
  });

  it('types an outer function\'s parameter, a local and a field the same way', async () => {
    const cg = await indexProject({
      'bridge.ts': BRIDGE,
      'use.ts': `import type { BackendBridge } from './bridge';
declare function make(): BackendBridge;
export function outer(bridge: BackendBridge) {
  function nested() { bridge.send('a'); }
  return nested;
}
export function local() {
  const link: BackendBridge = make();
  link.send('b');
}
export class Holder {
  private readonly port: BackendBridge;
  constructor(port: BackendBridge) { this.port = port; }
  go() { this.port.send('c'); }
}
`,
    });
    expect(callees(cg, 'outer::nested')).toEqual(['Bridge::send']);
    expect(callees(cg, 'local')).toContain('Bridge::send');
    expect(callees(cg, 'Holder::go')).toEqual(['Bridge::send']);
  });

  it('reads the alias the way its own file names the class', async () => {
    const cg = await indexProject({
      'one/bridge.ts': 'export class Bridge { send() {} }\n',
      'two/bridge.ts': 'export class Bridge { send() {} }\n',
      'two/types.ts': "import { Bridge } from './bridge';\nexport type Link = Bridge;\n",
      'use.ts': "import type { Link } from './two/types';\nexport function run(link: Link) { link.send(); }\n",
    });
    const target = cg.getOutgoingEdges(cg.getNodesByName('run')[0]!.id).find((e) => e.kind === 'calls');
    expect(cg.getNode(target!.target)!.filePath).toBe('two/bridge.ts');
  });

  it('names nothing for a union, a function type or an array', async () => {
    const cg = await indexProject({
      'types.ts': `export class One { run() {} }
export class Two { run() {} }
export type Either = One | Two;
export type Fn = (a: One) => One;
export type Many = One[];
`,
      'use.ts': `import type { Either, Fn, Many } from './types';
export function a(x: Either) { x.run(); }
export function b(x: Fn) { x.run(); }
export function c(x: Many) { x.run(); }
`,
    });
    for (const fn of ['a', 'b', 'c']) expect(callees(cg, fn), fn).toEqual([]);
  });
});
