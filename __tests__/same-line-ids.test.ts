import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

it('persists both same-line accessors and keeps their calls separate (#1349)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-accessor-ids-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'box.ts'), `function read() {} function write(v) {}\nexport class Box { get value() { return read(); } set value(v) { write(v); } }`);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const members = cg.getNodesByName('value').sort((a, b) => a.startColumn - b.startColumn);
    expect(members).toHaveLength(2);
    expect(new Set(members.map(n => n.id)).size).toBe(2);
    const callees = (id: string) => cg!.getCallees(id).filter(x => x.edge.kind === 'calls').map(x => x.node.name);
    expect(callees(members[0].id)).toEqual(['read']);
    expect(callees(members[1].id)).toEqual(['write']);
    await cg.indexAll();
    expect(cg.getNodesByName('value').map(n => n.id).sort()).toEqual(members.map(n => n.id).sort());
  } finally {
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
