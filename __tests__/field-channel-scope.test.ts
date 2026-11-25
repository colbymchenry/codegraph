import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

let dir: string;
let cg: CodeGraph | undefined;
afterEach(() => {
  cg?.close();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function index(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-field-scope-'));
  files['store.ts'] = `export class Store {
  handlers = new Set<Function>();
  subscribe(cb: Function) { this.handlers.add(cb); }
  emit() { this.handlers.forEach(h => h()); }
}`;
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), source);
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  await cg.resolveReferencesBatched();
  const emit = cg.getNodesByName('emit').find(n => n.qualifiedName === 'Store::emit')!;
  return cg.getOutgoingEdges(emit.id).filter(e => e.metadata?.synthesizedBy === 'callback');
}

const real = `import { Store } from './store';
export class Real {
  store = new Store();
  init() { this.store.subscribe(this.triggerRender); }
  triggerRender() { return 'real'; }
}`;
const decoy = `export class Decoy { triggerRender() { return 'decoy'; } }`;

describe('field-channel registration scope (#1355)', () => {
  it.each(['ts', 'tsx', 'js', 'jsx'])('uses the registered owner with a decoy first (%s)', async ext => {
    const file = `z_real.${ext}`;
    const edges = await index({ [`a_decoy.${ext}`]: decoy, [file]: real });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ qualifiedName: 'Real::triggerRender', filePath: file });
    expect(edges[0]).toMatchObject({ provenance: 'heuristic', metadata: { registeredAt: `${file}:4` } });
    const result = await new ToolHandler(cg!).execute('codegraph_explore', { query: 'Store.emit Real.triggerRender' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(`emit → triggerRender   [dynamic: callback via \`subscribe\` @${file}:4]`);
    expect(text).toContain(`${file}:4`);
  });

  it('keeps the target when file and insertion order are reversed', async () => {
    const edges = await index({ 'a_real.ts': real, 'z_decoy.ts': decoy });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)?.qualifiedName).toBe('Real::triggerRender');
  });

  it('distinguishes owners in the same file', async () => {
    const edges = await index({ 'real.ts': `${decoy}\n${real}` });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)?.qualifiedName).toBe('Real::triggerRender');
  });

  it('follows an inherited handler in another file', async () => {
    const edges = await index({
      'a_decoy.ts': decoy,
      'base.ts': 'export class Base { triggerRender() {} }',
      'real.ts': `import { Base } from './base';\n${real.replace('class Real {', 'class Real extends Base {').replace("  triggerRender() { return 'real'; }", '')}`,
    });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ qualifiedName: 'Base::triggerRender', filePath: 'base.ts' });
  });

  it('follows an imported alias instead of a globally matching name', async () => {
    const edges = await index({
      'a_decoy.ts': 'export function handler() {}',
      'handlers.ts': 'export function render() {}',
      'real.ts': `import { Store } from './store';
import { render as handler } from './handlers';
export function wire() { const store = new Store(); store.subscribe(handler); }`,
    });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ name: 'render', filePath: 'handlers.ts' });
  });

  it('uses a local bare function', async () => {
    const edges = await index({
      'a_decoy.ts': 'export function handler() {}',
      'real.ts': `import { Store } from './store';
function handler() {}
export function wire() { const store = new Store(); store.subscribe(handler); }`,
    });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)?.filePath).toBe('real.ts');
  });

  it.each(['this.triggerRender', 'triggerRender', 'other.triggerRender', 'this.triggerRender()'])('does not guess an unknown or non-value handler: %s', async arg => {
    const edges = await index({
      'a_decoy.ts': decoy,
      'real.ts': real.replace('this.triggerRender);', `${arg});`).replace("  triggerRender() { return 'real'; }", ''),
    });
    expect(edges).toEqual([]);
  });
});
