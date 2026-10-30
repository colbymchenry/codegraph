import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('Kotlin extension receiver import aliases', () => {
  it('retains an aliased library extension without accepting the same alias for another type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-import-alias-'));
    let cg: CodeGraph | undefined;
    try {
      for (const [file, source] of Object.entries({
        'p/Foreign.kt': `package p
import javax.lang.model.element.Modifier as LayoutModifier
import androidx.compose.ui.Modifier as UnusedCompose
fun LayoutModifier.keyword() {}`,
        'q/Calls.kt': `package q
import androidx.compose.ui.Modifier as LayoutModifier
import p.keyword
fun LayoutModifier.pad() {}
fun caller() {
    LayoutModifier.pad()
    LayoutModifier.keyword()
}`,
      })) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
      }
      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const caller = cg.searchNodes('caller').map(r => r.node).find(n => n.name === 'caller')!;
      expect(cg.getCallees(caller.id).filter(c => c.edge.kind === 'calls').map(c => c.node.qualifiedName))
        .toEqual(['LayoutModifier::pad']);
    } finally {
      cg?.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['Modifier', 'CallAlias'],
    ['DeclAlias', 'Modifier'],
    ['DeclAlias', 'CallAlias'],
    ['SameAlias', 'SameAlias'],
  ])('links a receiver declared as %s and called as %s', async (declared, called) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-alias-'));
    let cg: CodeGraph | undefined;
    const typeImport = (alias: string) => 'import androidx.compose.ui.Modifier' + (alias === 'Modifier' ? '' : ` as ${alias}`);
    try {
      const files = {
        'extensions/Extensions.kt': `package extensions\n${typeImport(declared)}\nfun ${declared}.pad() {}`,
        'decoy/Extensions.kt': `package decoy\nimport javax.lang.model.element.Modifier as ${declared}\nfun ${declared}.pad() {}`,
        'caller/Calls.kt': `package caller\n${typeImport(called)}\nimport extensions.pad\nfun caller() { ${called}.pad() }`,
        'unimported/Calls.kt': `package unimported\n${typeImport(called)}\nfun hidden() { ${called}.pad() }`,
      };
      for (const [file, source] of Object.entries(files)) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
      }
      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const calls = (name: string) => {
        const caller = cg!.getNodesByName(name).find(n => n.kind === 'function')!;
        return cg!.getCallees(caller.id).filter(c => c.edge.kind === 'calls').map(c => c.node.filePath);
      };
      expect(calls('caller')).toEqual(['extensions/Extensions.kt']);
      expect(calls('hidden')).toEqual([]);
    } finally {
      cg?.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
