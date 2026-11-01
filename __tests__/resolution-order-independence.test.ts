/**
 * What a walk answers can't depend on who asked first. These walks kept their
 * answers per name, and each stopped after a few steps or read what earlier
 * askers had left: asked from the top of a long chain, a walk stopped short and
 * kept a "nothing" for the middle of the chain, which a value of that type then
 * got too; asked from the middle, both reached the class. With a pool, who asks
 * first is which worker gets which chunk. These ask in both orders, each on a
 * fresh resolver.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import { cMacroRename } from '../src/resolution/c-macro-renames';
import type { UnresolvedRef } from '../src/resolution/types';

type Queries = ConstructorParameters<typeof ReferenceResolver>[1];
type Files = Record<string, string>;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.destroy();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface Project {
  root: string;
  cg: CodeGraph;
  /** A resolver with nothing in its memos. */
  fresh(): ReferenceResolver;
  /** The reference to `name` written in `file`, in the function `from`. */
  ref(file: string, from: string, name: string, kind?: UnresolvedRef['referenceKind'], written?: string): UnresolvedRef;
  /** What each reference resolves to when they're asked in this order and when asked in the other. */
  bothOrders(refs: UnresolvedRef[]): { forward: Array<string | undefined>; reverse: Array<string | undefined> };
  id(qualifiedName: string): string;
}

async function project(files: Files, language: UnresolvedRef['language']): Promise<Project> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-order-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  const queries = (cg as unknown as { queries: Queries }).queries;
  const fresh = (): ReferenceResolver => {
    const resolver = new ReferenceResolver(root, queries);
    resolver.initialize([]);
    return resolver;
  };
  const ref: Project['ref'] = (file, from, name, kind = 'calls', written = name.replace(/^\{[^}]*\}\./, '')) => {
    const lines = files[file]!.split('\n');
    const line = lines.findIndex((text) => text.includes(written));
    const node = cg.getNodesInFile(file).find((n) => n.qualifiedName === from || n.name === from)!;
    return { fromNodeId: node.id, referenceName: name, referenceKind: kind, line: line + 1, column: lines[line]!.indexOf(written), filePath: file, language };
  };
  return {
    root,
    cg,
    fresh,
    ref,
    bothOrders(refs) {
      const forward = fresh();
      const reverse = fresh();
      const answers = (resolver: ReferenceResolver, order: UnresolvedRef[]): Map<UnresolvedRef, string | undefined> =>
        new Map(order.map((r) => [r, resolver.resolveOne(r)?.targetNodeId]));
      const one = answers(forward, refs);
      const two = answers(reverse, [...refs].reverse());
      return { forward: refs.map((r) => one.get(r)), reverse: refs.map((r) => two.get(r)) };
    },
    id: (qualifiedName) => cg.getNodesByQualifiedName(qualifiedName)[0]!.id,
  };
}

describe('TypeScript type aliases', () => {
  const CLASSES = 'export class G { m() { return 2; } }\nexport class F { m() { return 1; } }\n';

  it('every alias on a long chain reaches the class, whichever is asked first', async () => {
    const p = await project({
      'types.ts': `${CLASSES}export type E = F;\nexport type D = E;\nexport type C = D;\nexport type B = C;\nexport type A = B;\n`,
      'use.ts': "import { A, E } from './types';\nexport function first(x: A) { return x.m(); }\nexport function second(y: E) { return y.m(); }\n",
    }, 'typescript');
    const refs = [p.ref('use.ts', 'first', 'x.m'), p.ref('use.ts', 'second', 'y.m')];
    const { forward, reverse } = p.bothOrders(refs);
    expect(forward).toEqual([p.id('F::m'), p.id('F::m')]);
    expect(reverse).toEqual(forward);
  }, 120_000);

  it('an alias chain that comes back to itself names nothing, whichever is asked first', async () => {
    const p = await project({
      'types.ts': `${CLASSES}export type A = B;\nexport type B = C;\nexport type C = A;\n`,
      'use.ts': "import { A, C } from './types';\nexport function first(x: A) { return x.m(); }\nexport function second(y: C) { return y.m(); }\n",
    }, 'typescript');
    const refs = [p.ref('use.ts', 'first', 'x.m'), p.ref('use.ts', 'second', 'y.m')];
    const { forward, reverse } = p.bothOrders(refs);
    expect(forward).toEqual([undefined, undefined]);
    expect(reverse).toEqual(forward);
  }, 120_000);
});

describe('Lua re-exports', () => {
  const REEXPORT = (next: string): string => `local ${next} = require("${next}")\nreturn { check = ${next}.check }\n`;
  const DEFINES = 'local function check() return 1 end\nreturn { check = check }\n';
  const OTHER = 'local function check() return 2 end\nreturn { check = check }\n';
  const USE = 'local m1 = require("m1")\nlocal m4 = require("m4")\nlocal a = m1.check\nlocal b = m4.check\nlocal function one() return a() end\nlocal function two() return b() end\nreturn { one = one, two = two }\n';

  it('a member re-exported down a long chain is the same function from anywhere on it', async () => {
    const p = await project({
      'm1.lua': REEXPORT('m2'), 'm2.lua': REEXPORT('m3'), 'm3.lua': REEXPORT('m4'), 'm4.lua': REEXPORT('m5'),
      'm5.lua': DEFINES, 'other.lua': OTHER, 'use.lua': USE,
    }, 'lua');
    const check = p.cg.getNodesInFile('m5.lua').find((n) => n.name === 'check' && n.kind === 'function')!.id;
    const { forward, reverse } = p.bothOrders([p.ref('use.lua', 'one', 'a', 'calls', 'a()'), p.ref('use.lua', 'two', 'b', 'calls', 'b()')]);
    expect(forward).toEqual([check, check]);
    expect(reverse).toEqual(forward);
  }, 120_000);

  it('a cycle of re-exports names nothing, whichever module is asked first', async () => {
    const p = await project({
      'm1.lua': REEXPORT('m2'), 'm2.lua': REEXPORT('m3'), 'm3.lua': REEXPORT('m4'), 'm4.lua': REEXPORT('m1'),
      'm5.lua': DEFINES, 'other.lua': OTHER, 'use.lua': USE,
    }, 'lua');
    const { forward, reverse } = p.bothOrders([p.ref('use.lua', 'one', 'a', 'calls', 'a()'), p.ref('use.lua', 'two', 'b', 'calls', 'b()')]);
    expect(forward).toEqual([undefined, undefined]);
    expect(reverse).toEqual(forward);
  }, 120_000);
});

describe('Pascal type aliases', () => {
  const unit = (aliases: string): string => `unit U;

interface

type
  TF = class
    procedure Run;
  end;
  TG = class
    procedure Run;
  end;
${aliases}
  THolder = class
    FA: TA;
    FE: TE;
  end;
  TUser = class
    H: THolder;
    procedure One;
    procedure Two;
  end;

implementation

procedure TF.Run;
begin
end;

procedure TG.Run;
begin
end;

procedure TUser.One;
begin
  H.FA.Run;
end;

procedure TUser.Two;
begin
  H.FE.Run;
end;

end.
`;
  const refs = (p: Project): UnresolvedRef[] => [
    p.ref('u.pas', 'TUser::One', '{call@TUser}.H.FA.Run', 'references'),
    p.ref('u.pas', 'TUser::Two', '{call@TUser}.H.FE.Run', 'references'),
  ];

  it('every alias on a long chain is the class, whichever is asked first', async () => {
    const p = await project({ 'u.pas': unit('  TE = TF;\n  TD = TE;\n  TC = TD;\n  TB = TC;\n  TA = TB;') }, 'pascal');
    const { forward, reverse } = p.bothOrders(refs(p));
    expect(forward).toEqual([p.id('TF::Run'), p.id('TF::Run')]);
    expect(reverse).toEqual(forward);
  }, 120_000);

  it('a cycle of aliases names nothing, whichever is asked first', async () => {
    const p = await project({ 'u.pas': unit('  TE = TD;\n  TD = TC;\n  TC = TB;\n  TB = TA;\n  TA = TE;') }, 'pascal');
    const { forward, reverse } = p.bothOrders(refs(p));
    expect(forward).toEqual([undefined, undefined]);
    expect(reverse).toEqual(forward);
  }, 120_000);

  it('an alias declared twice over goes on to the second when the first leads nowhere', async () => {
    const p = await project({
      'u.pas': unit('  {$IFDEF ONE}\n  TE = TA;\n  {$ELSE}\n  TE = TF;\n  {$ENDIF}\n  TD = TE;\n  TC = TD;\n  TB = TC;\n  TA = TB;'),
    }, 'pascal');
    const { forward, reverse } = p.bothOrders(refs(p));
    expect(forward).toEqual([p.id('TF::Run'), p.id('TF::Run')]);
    expect(reverse).toEqual(forward);
  }, 120_000);
});

describe('C macro renames', () => {
  const FILES: Files = {
    'types.h': 'struct hisds { int len; };\nstruct sds { int other; };\n',
    'impl.c': '#define sds hisds\nstruct holder {\n  sds value;\n};\n',
    'main.c': '#include "types.h"\n#include "impl.c"\nstruct user {\n  sds name;\n};\n',
    'own.c': '#include "types.h"\n#define sds hisds\nstruct mine {\n  sds name;\n};\n',
    'plain.c': '#include "types.h"\nstruct theirs {\n  sds name;\n};\n',
  };

  const answers = (p: Project, order: Array<[string, number]>): Map<string, string | null> => {
    const context = p.fresh().getResolutionContext();
    return new Map(order.map(([file, line]) => [file, cMacroRename('sds', file, line, 'c', context)]));
  };

  it('a source file another includes renames for its includer too, whichever asks first', async () => {
    const p = await project(FILES, 'c');
    const asks: Array<[string, number]> = [['main.c', 4], ['impl.c', 3]];
    const forward = answers(p, asks);
    const reverse = answers(p, [...asks].reverse());
    expect(forward.get('main.c')).toBe('hisds');
    expect(forward.get('impl.c')).toBe('hisds');
    expect(reverse).toEqual(forward);
  }, 120_000);

  it('a source file nothing includes renames for itself alone, whichever asks first', async () => {
    const p = await project(FILES, 'c');
    const asks: Array<[string, number]> = [['own.c', 4], ['plain.c', 3]];
    const forward = answers(p, asks);
    const reverse = answers(p, [...asks].reverse());
    expect(forward.get('own.c')).toBe('hisds');
    expect(forward.get('plain.c')).toBeNull();
    expect(reverse).toEqual(forward);
  }, 120_000);

  it('the member\'s type follows the rename, and no reference order moves it', async () => {
    const p = await project(FILES, 'c');
    const refs = [p.ref('main.c', 'user', 'sds', 'references'), p.ref('impl.c', 'holder', 'sds', 'references')];
    const { forward, reverse } = p.bothOrders(refs);
    expect(forward).toEqual([p.id('hisds'), p.id('hisds')]);
    expect(reverse).toEqual(forward);
  }, 120_000);
});
