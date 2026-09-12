import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

it('persists same-line C++ constructors with separate body calls and stable reindex IDs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-constructor-ids-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'widget.cpp'), `void zero() {} void one() {}\n/* 😀 */ struct Widget { Widget() { zero(); } Widget(int) { one(); } };\nvoid useDefault() { Widget w; }\nvoid useInt() { Widget w(1); }\n`);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const constructors = cg.getNodesByName('Widget').filter(n => n.kind === 'method').sort((a, b) => a.startColumn - b.startColumn);
    expect(constructors).toHaveLength(2);
    expect(new Set(constructors.map(n => n.id)).size).toBe(2);
    const callees = (id: string) => cg!.getCallees(id).filter(x => x.edge.kind === 'calls').map(x => x.node.name);
    expect(callees(constructors[0].id)).toEqual(['zero']);
    expect(callees(constructors[1].id)).toEqual(['one']);
    for (const [name, constructor] of [['useDefault', constructors[0]], ['useInt', constructors[1]]] as const) {
      const caller = cg.getNodesByName(name)[0];
      expect(cg.getCallees(caller.id).filter(x => x.edge.kind === 'calls').map(x => x.node.id)).toEqual([constructor.id]);
    }
    await cg.indexAll();
    expect(cg.getNodesByName('Widget').filter(n => n.kind === 'method').map(n => n.id).sort()).toEqual(constructors.map(n => n.id).sort());
  } finally {
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
