/**
 * A call that only failed because a second candidate shared its name resolves
 * once a sync removes that candidate.
 *
 * `x.go()` on a value of unknown type, with `go` defined in two classes, is
 * ambiguous: a full index leaves it unresolved. Take one of the two away and a
 * full index links the call to the other. Sync didn't: its failed-reference
 * retry looked failed refs up by the names in the files it changed, so a
 * deleted file (no names left) or an edit that renames the competitor away
 * never brought the call up again, and a sync that only deleted files skipped
 * the retry altogether.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

/** Every node and edge by natural key, so two indexes of the same files compare directly. */
function graphOf(cg: CodeGraph): { nodes: string[]; edges: string[] } {
  const keys = new Map(
    cg.getFiles()
      .flatMap((file) => cg.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = cg.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target}`);
  return { nodes: [...keys.values()].sort(), edges: edges.sort() };
}

async function reindexFromScratch(cg: CodeGraph): Promise<CodeGraph> {
  const root = cg.getProjectRoot();
  cg.close();
  const rebuilt = await CodeGraph.recreate(root);
  await rebuilt.indexAll();
  return rebuilt;
}

const REINDEX_TIMEOUT = 60_000;

describe('sync re-resolves a call whose competing candidate went away', () => {
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);

  function callTargets(caller: string): string[] {
    const node = cg.searchNodes(caller).map((r) => r.node).find((n) => n.name === caller && n.kind === 'function');
    return node ? cg.getCallees(node.id).map((c) => c.node.qualifiedName).sort() : [];
  }

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('Python', () => {
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-competitor-py-'));
      write('a.py', 'class A:\n    def go(self):\n        return 1\n');
      write('b.py', 'class B:\n    def go(self):\n        return 2\n');
      write('t.py', 'from a import A\n\ndef make():\n    return A()\n\ndef use():\n    x = make()\n    x.go()\n');
      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      // Two candidates: the call stays unresolved.
      expect(callTargets('use')).toEqual(['make']);
    });

    it('after the file holding the other candidate is deleted', async () => {
      fs.unlinkSync(path.join(dir, 'b.py'));
      const result = await cg.sync();
      expect(result.filesRemoved).toBe(1);
      expect(callTargets('use')).toEqual(['A::go', 'make']);
      const synced = graphOf(cg);
      cg = await reindexFromScratch(cg);
      expect(synced).toEqual(graphOf(cg));
    }, REINDEX_TIMEOUT);

    it('after an edit renames the other candidate away', async () => {
      write('b.py', 'class B:\n    def stop(self):\n        return 2\n');
      await cg.sync();
      expect(callTargets('use')).toEqual(['A::go', 'make']);
      const synced = graphOf(cg);
      cg = await reindexFromScratch(cg);
      expect(synced).toEqual(graphOf(cg));
    }, REINDEX_TIMEOUT);

    it('a deletion that leaves the call ambiguous changes nothing', async () => {
      write('c.py', 'class C:\n    def go(self):\n        return 3\n');
      await cg.sync();
      fs.unlinkSync(path.join(dir, 'b.py'));
      await cg.sync();
      expect(callTargets('use')).toEqual(['make']);
      const synced = graphOf(cg);
      cg = await reindexFromScratch(cg);
      expect(synced).toEqual(graphOf(cg));
    }, REINDEX_TIMEOUT);
  });

  describe('TypeScript', () => {
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-competitor-ts-'));
      write('a.ts', 'export class A {\n  go(): number { return 1; }\n}\n');
      write('b.ts', 'export class B {\n  go(): number { return 2; }\n}\n');
      write('t.ts', 'export function use(x: any): void {\n  x.go();\n}\n');
      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      expect(callTargets('use')).toEqual([]);
    });

    it('after the file holding the other candidate is deleted', async () => {
      fs.unlinkSync(path.join(dir, 'b.ts'));
      await cg.sync();
      expect(callTargets('use')).toEqual(['A::go']);
      const synced = graphOf(cg);
      cg = await reindexFromScratch(cg);
      expect(synced).toEqual(graphOf(cg));
    }, REINDEX_TIMEOUT);

    it('after an edit renames the other candidate away', async () => {
      write('b.ts', 'export class B {\n  stop(): number { return 2; }\n}\n');
      await cg.sync();
      expect(callTargets('use')).toEqual(['A::go']);
      const synced = graphOf(cg);
      cg = await reindexFromScratch(cg);
      expect(synced).toEqual(graphOf(cg));
    }, REINDEX_TIMEOUT);

    it('a deletion that leaves the call ambiguous changes nothing', async () => {
      write('c.ts', 'export class C {\n  go(): number { return 3; }\n}\n');
      await cg.sync();
      fs.unlinkSync(path.join(dir, 'b.ts'));
      await cg.sync();
      expect(callTargets('use')).toEqual([]);
      const synced = graphOf(cg);
      cg = await reindexFromScratch(cg);
      expect(synced).toEqual(graphOf(cg));
    }, REINDEX_TIMEOUT);
  });
});
