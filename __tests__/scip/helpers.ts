/** What the SCIP suites share: a fixture project indexed by codegraph, its prebuilt index imported, edges looked up by name. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import type { SqliteDatabase } from '../../src/db/sqlite-adapter';
import { importScipFile, runScipPass } from '../../src/scip';
import type { ScipLanguage } from '../../src/scip/store';

export const FIXTURES = path.join(__dirname, '..', 'fixtures');

export interface FixtureProject {
  dir: string;
  cg: CodeGraph;
  close(): void;
}

/** `__tests__/fixtures/<fixture>/project` copied to a temp dir (or into `into`, below a temp root) and indexed by codegraph alone. */
export async function indexedFixture(fixture: string, into = ''): Promise<FixtureProject> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-${fixture}-`));
  fs.cpSync(path.join(FIXTURES, fixture, 'project'), path.join(root, into), { recursive: true });
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  return {
    dir: root,
    cg,
    close() {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** `scip import` of the fixture's prebuilt index, "built" now — after the sources were copied in. */
export function importFixtureIndex(dir: string, fixture: string, index = 'index.scip', lang?: ScipLanguage): ReturnType<typeof importScipFile> {
  const copy = path.join(dir, `built-${index}`);
  fs.copyFileSync(path.join(FIXTURES, fixture, index), copy);
  return importScipFile(dir, copy, lang);
}

/** The full merge, as the index hooks run it. */
export function merge(p: FixtureProject): Promise<ReturnType<typeof runScipPass>> {
  return p.cg.scipWrite(db => runScipPass(db, p.dir));
}

export interface EdgeRow { kind: string; line: number; provenance: string | null }

/** Edges `src` → `tgt` by qualified name, of `kinds` (any kind when omitted). */
export function edgesBetween(db: SqliteDatabase, src: string, tgt: string, kinds?: string[]): EdgeRow[] {
  return db.prepare(`SELECT e.kind, e.line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE s.qualified_name = ? AND t.qualified_name = ?${kinds ? ` AND e.kind IN (${kinds.map(() => '?').join(',')})` : ''}`)
    .all(src, tgt, ...(kinds ?? [])) as EdgeRow[];
}

/** A project's `codegraph.json` with this `scip` section. */
export function writeConfig(dir: string, scip: unknown): void {
  fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip }));
}

/** A fake TypeScript indexer: copies the TS fixture's `index` to `{out}` after `delayMs`, and counts its runs (`fakeRuns`). */
export function fakeIndexer(dir: string, index: string, delayMs = 0): void {
  writeConfig(dir, {
    typescript: {
      cmd: process.execPath,
      args: ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${delayMs});const fs=require("fs");fs.appendFileSync(process.argv[3],"x");fs.copyFileSync(process.argv[1],process.argv[2])`,
        path.join(FIXTURES, 'scip-ts', index), '{out}', path.join(dir, 'runs.log')],
    },
  });
}

export function fakeRuns(dir: string): number {
  const log = path.join(dir, 'runs.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
}

export function nodeId(db: SqliteDatabase, qualifiedName: string): string {
  return (db.prepare('SELECT id FROM nodes WHERE qualified_name = ?').get(qualifiedName) as { id: string }).id;
}
