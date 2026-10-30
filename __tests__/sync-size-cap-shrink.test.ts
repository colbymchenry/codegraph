/**
 * A file that shrinks back under the source-size limit links its importers as
 * a fresh index does.
 *
 * Over the limit, a file is tracked with no nodes and a `size_exceeded` error,
 * so `import { f1 } from './big'` has no file to land on and its refs fail.
 * When an edit brings it under the limit, sync indexes it — but as a modified
 * file, and only an ADDED file is looked up by what it can be imported as, so
 * the failed `./big` import of an unchanged importer stayed failed: the call
 * and the named import bound (they wait by name), the file-level import edge
 * a full index makes did not.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';

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

const BIG = (padding: number) =>
  `export function f1(): number { return 1; }\n// ${'x'.repeat(padding)}\n`;

describe('sync links the importers of a file that shrinks under the size limit', () => {
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);
  const importsOfUser = (): string[] => {
    const ids = cg.getNodesInFile('user.ts').map((n) => n.id);
    return cg.getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'imports')
      .map((e) => `${cg.getNode(e.target)?.kind}:${cg.getNode(e.target)?.name}`)
      .sort();
  };
  const matchesFullIndex = async () => {
    const synced = graphOf(cg);
    cg.close();
    cg = await CodeGraph.recreate(dir);
    await cg.indexAll();
    expect(synced).toEqual(graphOf(cg));
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sizecap-'));
    write('big.ts', BIG(MAX_SOURCE_FILE_SIZE_BYTES + 1000));
    write('user.ts', "import { f1 } from './big';\nexport const x = f1();\n");
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    // Over the limit: nothing in big.ts to import.
    expect(importsOfUser()).toEqual([]);
  });

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('including the import of the file itself', async () => {
    write('big.ts', BIG(10));
    await cg.sync();
    expect(importsOfUser()).toEqual(['file:big.ts', 'function:f1']);
    await matchesFullIndex();
  }, 60_000);

  it('and again after it grows over the limit and back', async () => {
    write('big.ts', BIG(10));
    await cg.sync();
    write('big.ts', BIG(MAX_SOURCE_FILE_SIZE_BYTES + 2000));
    await cg.sync();
    expect(importsOfUser()).toEqual([]);
    write('big.ts', BIG(20));
    await cg.sync();
    expect(importsOfUser()).toEqual(['file:big.ts', 'function:f1']);
    await matchesFullIndex();
  }, 60_000);

  it('and the same for a file stored after its parse failed', async () => {
    // Recorded as a parse failure instead of an oversize skip: still no
    // nodes, so the same importers wait on it.
    cg.close();
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, '.codegraph', 'codegraph.db'));
    db.prepare(`UPDATE files SET errors = ? WHERE path = 'big.ts'`)
      .run(JSON.stringify([{ message: 'parse failed', filePath: 'big.ts', severity: 'error', code: 'parse_error' }]));
    db.close();
    cg = await CodeGraph.open(dir);
    write('big.ts', BIG(10));
    const result = await cg.sync();
    expect(result.addedFilePaths).toEqual(['big.ts']);
    expect(importsOfUser()).toEqual(['file:big.ts', 'function:f1']);
    await matchesFullIndex();
  }, 60_000);

  it('and a change that keeps it over the limit is not taken for an added file', async () => {
    write('big.ts', BIG(MAX_SOURCE_FILE_SIZE_BYTES + 5000));
    const result = await cg.sync();
    expect(result.filesModified).toBe(1);
    expect(result.addedFilePaths).toBeUndefined();
    expect(importsOfUser()).toEqual([]);
    await matchesFullIndex();
  }, 60_000);
});

describe('sync links what a barrel passes on from a file that shrinks under the size limit', () => {
  // `user.ts` imports through `lib/index.ts`, which re-exports `lib/big.ts`:
  // while big.ts was over the limit, the barrel's `export *` of it failed and
  // so did the names user.ts reads through the barrel.
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };

  afterEach(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the barrel and the files importing through it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sizecap-barrel-'));
    write('lib/index.ts', "export * from './big';\nexport * from './small';\n");
    write('lib/big.ts', BIG(MAX_SOURCE_FILE_SIZE_BYTES + 1000));
    write('lib/small.ts', 'export function s1(): number { return 2; }\n');
    write('user.ts', "import { f1, s1 } from './lib';\nexport const x = f1() + s1();\n");
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    write('lib/big.ts', BIG(10));
    await cg.sync();
    const synced = graphOf(cg);
    cg.close();
    cg = await CodeGraph.recreate(dir);
    await cg.indexAll();
    expect(synced).toEqual(graphOf(cg));
  }, 60_000);
});
