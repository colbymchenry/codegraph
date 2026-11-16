/**
 * A walk along a chain of aliases follows it to its end, so it can't take a
 * stack frame per step: a generated or hostile chain thousands of aliases long
 * ran the stack out, and the whole index failed with it. TypeScript's and Lua's
 * walks have one place to go at each step, so they are loops. Pascal's can
 * branch, so it recurses within a bound, past any real chain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.destroy();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-chain-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

/** What the calls written in `from` (a function, or a file's own top level) reach, by qualified name. */
function calls(cg: CodeGraph, from: { file: string; name?: string }): string[] {
  const sources = cg.getNodesInFile(from.file).filter((n) => (from.name ? n.name === from.name : n.kind === 'file'));
  return sources
    .flatMap((n) => cg.getOutgoingEdges(n.id))
    .filter((e) => e.kind === 'calls')
    .map((e) => `${cg.getNode(e.target)!.filePath}::${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

describe('a very long chain of aliases', () => {
  it('TypeScript: 20,000 aliases index, and a value typed by either end reaches the class', async () => {
    let ts = 'export class G { m() {} }\nexport class F { m() {} }\nexport type T0 = F;\n';
    for (let i = 1; i < 20_000; i++) ts += `export type T${i} = T${i - 1};\n`;
    ts += 'export function first(x: T19999) { x.m(); }\nexport function second(y: T0) { y.m(); }\n';
    const started = Date.now();
    const cg = await indexed({ 'chain.ts': ts });
    expect(calls(cg, { file: 'chain.ts', name: 'first' })).toEqual(['chain.ts::F::m']);
    expect(calls(cg, { file: 'chain.ts', name: 'second' })).toEqual(['chain.ts::F::m']);
    expect(Date.now() - started).toBeLessThan(90_000);
  }, 120_000);

  it('Lua: a member re-exported through 2,500 modules reaches its function from either end', async () => {
    const files: Record<string, string> = {};
    const n = 2_500;
    for (let i = 1; i < n; i++) files[`m${i}.lua`] = `local m${i + 1} = require("m${i + 1}")\nreturn { check = m${i + 1}.check }\n`;
    files[`m${n}.lua`] = 'local M = {}\nfunction M.check() return true end\nreturn M\n';
    files['main.lua'] = `local a = require("m1").check\nlocal b = require("m${n - 1}").check\na()\nb()\n`;
    const cg = await indexed(files);
    expect(calls(cg, { file: 'main.lua' })).toEqual([`m${n}.lua::M::check`, `m${n}.lua::M::check`]);
  }, 120_000);

  const pascal = (n: number): string => {
    let pas = 'unit U;\n\ninterface\n\ntype\n  TF = class\n    procedure Run;\n  end;\n  TG = class\n    procedure Run;\n  end;\n  TA0 = TF;\n';
    for (let i = 1; i < n; i++) pas += `  TA${i} = TA${i - 1};\n`;
    pas += `  THolder = class\n    FA: TA${n - 1};\n    FE: TA0;\n  end;\n  TUser = class\n    H: THolder;\n    procedure One;\n    procedure Two;\n  end;\n\nimplementation\n\n`;
    return `${pas}procedure TF.Run;\nbegin\nend;\n\nprocedure TG.Run;\nbegin\nend;\n\nprocedure TUser.One;\nbegin\n  H.FA.Run;\nend;\n\nprocedure TUser.Two;\nbegin\n  H.FE.Run;\nend;\n\nend.\n`;
  };

  it('Pascal: 900 aliases, within the walk\'s bound, reach the class from either end', async () => {
    const cg = await indexed({ 'u.pas': pascal(900) });
    expect(calls(cg, { file: 'u.pas', name: 'One' })).toEqual(['u.pas::TF::Run']);
    expect(calls(cg, { file: 'u.pas', name: 'Two' })).toEqual(['u.pas::TF::Run']);
  }, 120_000);

  it('Pascal: 20,000 aliases index; the far end is past the walk\'s bound, the near one reaches the class', async () => {
    const cg = await indexed({ 'u.pas': pascal(20_000) });
    expect(calls(cg, { file: 'u.pas', name: 'One' })).toEqual([]);
    expect(calls(cg, { file: 'u.pas', name: 'Two' })).toEqual(['u.pas::TF::Run']);
  }, 120_000);
});
