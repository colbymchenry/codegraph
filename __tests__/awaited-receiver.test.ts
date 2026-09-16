import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-awaited-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });
async function index(files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  cg = await CodeGraph.init(root, { index: true });
}
function calls(name: string, file = 'caller.ts') {
  const node = cg!.getNodesByKind('function').find(n => n.name === name && n.filePath === file);
  expect(node).toBeDefined();
  return cg!.getCallees(node!.id).filter(({ edge }) => edge.kind === 'calls')
    .map(({ node, edge }) => ({ target: `${node.filePath}:${node.qualifiedName}`, line: edge.line }));
}
const engine = 'export class Engine { run() {} }\nexport async function makeEngine(): Promise<Engine> { return new Engine(); }';

it('follows an imported factory alias rather than an unrelated namesake (#1840)', async () => {
  await index({
    'engine.ts': engine,
    'decoy.ts': 'export async function load(): Promise<string> { return ""; }',
    'caller.ts': 'import { makeEngine as load } from "./engine";\nexport async function drive() { const handle = await load(); handle.run(); }',
  });
  expect(calls('drive').map(c => c.target).sort()).toEqual(['engine.ts:Engine::run', 'engine.ts:makeEngine']);
});

it('resolves return-type aliases in the factory module, not a caller-local decoy (#1840)', async () => {
  await index({
    'engine.ts': engine,
    'factory.ts': 'import { Engine as Service } from "./engine";\nexport async function load(): Promise<Service> { return new Service(); }',
    'caller.ts': 'import { load } from "./factory";\nclass Service { run() {} }\nexport async function drive() { const handle = await load(); handle.run(); }',
  });
  expect(calls('drive').map(c => c.target).sort()).toEqual(['engine.ts:Engine::run', 'factory.ts:load']);
});

it('does not infer from a factory hidden by a parameter (#1840)', async () => {
  await index({
    'engine.ts': engine,
    'caller.ts': 'import { makeEngine } from "./engine";\nexport async function drive(makeEngine: () => Promise<string>) { const handle = await makeEngine(); handle.run(); }',
  });
  expect(calls('drive').map(c => c.target)).not.toContain('engine.ts:Engine::run');
});

it('distinguishes same-named awaited receivers in sibling blocks (#1840)', async () => {
  await index({ 'caller.ts': `class PaneManager { split() {} }
async function text(): Promise<string> { return ""; }
async function pane(): Promise<PaneManager> { return new PaneManager(); }
export async function drive() {
  { const value = await text(); value.split(); }
  { const value = await pane(); value.split(); }
}` });
  expect(calls('drive').filter(c => c.target.endsWith('PaneManager::split'))).toEqual([
    { target: 'caller.ts:PaneManager::split', line: 6 },
  ]);
});

it('keeps captured awaited bindings but rejects shadowing parameters (#1840)', async () => {
  await index({ 'caller.ts': `${engine}
export async function outer() {
  const handle = await makeEngine();
  function captured() { handle.run(); }
  function shadow(handle: any) { handle.run(); }
  return { captured, shadow };
}` });
  expect(calls('captured').map(c => c.target)).toContain('caller.ts:Engine::run');
  expect(calls('shadow').map(c => c.target)).not.toContain('caller.ts:Engine::run');
});

it('invalidates an awaited return type after edits in the callee file (#1840)', async () => {
  const caller = 'import { load } from "./factory";\nexport async function drive() { const value = await load(); value.split(); }';
  const primitive = 'export async function load(): Promise<string> { return ""; }';
  const project = 'export class Pane { split() {} }\nexport async function load(): Promise<Pane> { return new Pane(); }';
  await index({ 'caller.ts': caller, 'factory.ts': primitive, 'decoy.ts': 'export class Other { split() {} }' });
  expect(calls('drive').map(c => c.target)).toEqual(['factory.ts:load']);
  fs.writeFileSync(path.join(root, 'factory.ts'), project);
  await cg!.sync();
  expect(calls('drive').map(c => c.target).sort()).toEqual(['factory.ts:Pane::split', 'factory.ts:load']);
  fs.writeFileSync(path.join(root, 'factory.ts'), primitive);
  await cg!.sync();
  expect(calls('drive').map(c => c.target)).toEqual(['factory.ts:load']);
});

it('reads a multiline factory annotation and preserves ordinary typed receivers (#1840)', async () => {
  await index({ 'caller.ts': `class Engine { run() {} }
class Decoy { run() {} }
async function load(
  input: string
): Promise<Engine> { return new Engine(); }
export async function drive() { const value = await load(''); value.run(); }
export function ordinary() { const engine = new Engine(); engine.run(); }` });
  expect(calls('drive').map(c => c.target).sort()).toEqual(['caller.ts:Engine::run', 'caller.ts:load']);
  expect(calls('ordinary').map(c => c.target)).toContain('caller.ts:Engine::run');
});

it('supports newline-terminated awaited declarations without treating a chained result as the factory type (#1840)', async () => {
  await index({ 'caller.ts': `${engine}
export async function drive() {
  const value = await makeEngine()
  value.run()
}
export async function chained() {
  const value = await makeEngine().toString();
  value.run();
}` });
  expect(calls('drive').map(c => c.target)).toContain('caller.ts:Engine::run');
  expect(calls('chained').map(c => c.target)).not.toContain('caller.ts:Engine::run');
});

it('does not borrow a local factory annotation through a nearer variable binding (#1840)', async () => {
  await index({ 'caller.ts': `${engine}
export async function drive(other: () => Promise<string>) {
  const makeEngine = other;
  const value = await makeEngine();
  value.run();
}` });
  expect(calls('drive').map(c => c.target)).not.toContain('caller.ts:Engine::run');
});

it('preserves a real awaited member-factory call outside the bare-callee inference path (#1840)', async () => {
  await index({ 'caller.ts': `class Engine { run() {} }
class Factory { async create(): Promise<Engine> { return new Engine(); } }
export async function drive() {
  const handle = await new Factory().create();
  handle.run();
}` });
  expect(calls('drive').map(c => c.target)).toContain('caller.ts:Engine::run');
});

it('invalidates negative and positive file eligibility when caller edits add and remove await (#1840)', async () => {
  const plain = 'import { load } from "./factory";\nfunction opaque() { return null; }\nexport async function drive() { const value = opaque(); value.split(); }';
  const awaited = 'import { load } from "./factory";\nexport async function drive() { const value = await load(); value.split(); }';
  await index({
    'caller.ts': plain,
    'factory.ts': 'export class Pane { split() {} }\nexport class Other { split() {} }\nexport async function load(): Promise<Pane> { return new Pane(); }',
  });
  expect(calls('drive').filter(c => c.target.endsWith('Pane::split'))).toEqual([]);
  fs.writeFileSync(path.join(root, 'caller.ts'), awaited);
  await cg!.sync();
  expect(calls('drive').map(c => c.target)).toContain('factory.ts:Pane::split');
  fs.writeFileSync(path.join(root, 'caller.ts'), plain);
  await cg!.sync();
  expect(calls('drive').filter(c => c.target.endsWith('Pane::split'))).toEqual([]);
});
