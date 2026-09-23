import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { oversizeStamp, hashContent } from '../src/extraction';

/**
 * A file over the size limit is stored as skipped without ever being read
 * (#1910): committed video/blob fixtures used to be decoded in full — and
 * hashed — only to be discarded, costing their size in RSS per file.
 */
describe('oversize files are stat-gated, never read (#1910)', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const big = (bytes: number, fill = 0x41) => Buffer.alloc(bytes, fill);

  it('indexes the neighbours, records the oversize file as skipped with a size-stamp hash, and does not decode it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oversize-'));
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n');
    // 1 MB + 1: over the limit; invalid UTF-8 (0xFF) so any decode would be visible as replacement chars.
    fs.writeFileSync(path.join(dir, 'blob.ts'), big(1024 * 1024 + 1, 0xff));
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getNodesByKind('function').map(n => n.name).sort()).toEqual(['alpha', 'beta']);
      const rec = cg.getFiles().find(f => f.path === 'blob.ts');
      expect(rec).toBeDefined();
      expect(rec!.contentHash).toBe(hashContent(oversizeStamp(1024 * 1024 + 1)));
      // Nothing from the blob reached the graph.
      expect(cg.getNodesInFile('blob.ts').filter(n => n.kind !== 'file')).toEqual([]);
      // Change detection agrees with what was stored: nothing pending.
      expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
      // A same-size rewrite is not a change (nothing about it is indexed)...
      fs.writeFileSync(path.join(dir, 'blob.ts'), big(1024 * 1024 + 1, 0xfe));
      expect(cg.getChangedFiles().modified).toEqual([]);
      // ...crossing the limit is: the file becomes ordinary source.
      fs.writeFileSync(path.join(dir, 'blob.ts'), 'export const gamma = 3;\n');
      expect(cg.getChangedFiles().modified).toEqual(['blob.ts']);
      await cg.sync();
      expect(cg.getNodesInFile('blob.ts').some(n => n.name === 'gamma')).toBe(true);
      // ...and growing back over it is a change too, stored as the stamp again.
      fs.writeFileSync(path.join(dir, 'blob.ts'), big(2 * 1024 * 1024, 0xff));
      expect(cg.getChangedFiles().modified).toEqual(['blob.ts']);
      await cg.sync();
      expect(cg.getFiles().find(f => f.path === 'blob.ts')!.contentHash).toBe(hashContent(oversizeStamp(2 * 1024 * 1024)));
      expect(cg.getNodesInFile('blob.ts').some(n => n.name === 'gamma')).toBe(false);
    } finally {
      cg.close();
    }
  });

});
