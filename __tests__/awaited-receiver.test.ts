import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('awaited receiver return types (#1840)', () => {
  it.each(['string', 'PaneManager'])('resolves awaited %s without guessing unrelated methods', async (type) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-awaited-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root, 'source.ts'), `
export class PaneManager { split() { return 'pane'; } }
export async function make(): Promise<${type}> { return ${type === 'string' ? "'a,b'" : 'new PaneManager()'}; }
export async function snapshot() {
  const listed = await make();
  return listed.split(',');
}
export function actual() { const pane = new PaneManager(); return pane.split(); }
`);
      cg = CodeGraph.initSync(root);
      await cg.indexAll();
      const callees = (name: string) => {
        const node = cg!.getNodesByName(name).find(n => n.kind === 'function')!;
        return cg!.getCallees(node.id).filter(x => x.edge.kind === 'calls').map(x => x.node.name);
      };
      expect(callees('snapshot')).toContain('make');
      if (type === 'string') expect(callees('snapshot')).not.toContain('split');
      else expect(callees('snapshot')).toContain('split');
      expect(callees('actual')).toContain('split');
    } finally { cg?.close(); fs.rmSync(root, {recursive: true, force: true}); }
  });
});
