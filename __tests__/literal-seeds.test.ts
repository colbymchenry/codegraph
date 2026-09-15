import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { ToolHandler } from '../src/mcp/tools';

/**
 * The string-anchored explore path: a query that names a storage key or a CLI
 * flag reaches the symbols whose bodies hold it, through the `literals` side
 * table (written on the node write path, deleted with the file, cleared by a
 * full index), and those symbols lead the ranking.
 */
describe('literal seeds — index, query, and lifecycle', () => {
  let dir: string;
  let cg: CodeGraph;
  const queries = () => (cg as unknown as { queries: QueryBuilder }).queries;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-literals-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'writer.ts'),
      `export function persistRows(rows: unknown[]) {
  chrome.storage.local.set({ 'bompus_custom_ds_players': rows });
}
export function unrelatedHelper() { return 'ready'; }
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'reader.ts'),
      `export async function readRows() {
  const got = await chrome.storage.local.get('bompus_custom_ds_players');
  return got;
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'cli.ts'),
      `export function main(argv: string[]) {
  if (argv.includes('--start')) return start();
  return 0;
}
function start() { return 1; }
`,
    );
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });

  afterAll(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a storage key to every symbol whose body holds it', () => {
    const ids = queries().findNodeIdsByLiteral(['bompus_custom_ds_players']);
    const names = ids.map((id) => cg.getNode(id)?.name).sort();
    expect(names).toEqual(['persistRows', 'readRows']);
  });

  it('recommends rebuilding an index from before literal capture', () => {
    const current = queries().getMetadata('indexed_with_extraction_version');
    try {
      queries().setMetadata('indexed_with_extraction_version', '26');
      expect(cg.isIndexStale()).toBe(true);
    } finally {
      queries().setMetadata('indexed_with_extraction_version', current!);
    }
    expect(cg.isIndexStale()).toBe(false);
  });

  it('a quoted key in a prose query puts the writers at the top of the subgraph', async () => {
    const sub = await cg.findRelevantContext('which modules write "bompus_custom_ds_players" to storage');
    const rootNames = sub.roots.map((id) => sub.nodes.get(id)?.name);
    expect(rootNames.slice(0, 2).sort()).toEqual(['persistRows', 'readRows']);
    expect(rootNames).not.toContain('unrelatedHelper');
  });

  it('a bare CLI flag seeds too', () => {
    const ids = queries().findNodeIdsByLiteral(['--start']);
    expect(ids.map((id) => cg.getNode(id)?.name)).toEqual(['main']);
  });

  it('CODEGRAPH_LITERAL_SEEDS=0 turns the seed off (the ablation switch)', async () => {
    process.env.CODEGRAPH_LITERAL_SEEDS = '0';
    try {
      const sub = await cg.findRelevantContext('bompus_custom_ds_players');
      const names = [...sub.nodes.values()].map((n) => n.name);
      expect(names).not.toContain('persistRows');
    } finally {
      delete process.env.CODEGRAPH_LITERAL_SEEDS;
    }
  });

  it("a file's rows leave with its nodes on re-index, and a full index clears the table", async () => {
    fs.writeFileSync(path.join(dir, 'src', 'reader.ts'), `export function readRows() { return null; }\n`);
    await cg.indexFiles(['src/reader.ts']);
    let names = queries().findNodeIdsByLiteral(['bompus_custom_ds_players']).map((id) => cg.getNode(id)?.name);
    expect(names).toEqual(['persistRows']);

    fs.rmSync(path.join(dir, 'src', 'writer.ts'));
    await cg.indexAll();
    expect(queries().findNodeIdsByLiteral(['bompus_custom_ds_players'])).toEqual([]);
  });
});

/**
 * A literal held through a constant lives in a small file with no callers. In explore's file
 * sort that file must take a source slot the way a file defining a named symbol does; on graph
 * centrality alone it loses the slot to a hub file that never mentions the literal.
 */
describe('literal seeds — explore renders the holder file', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-litrender-'));
    fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'callers'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'shared', 'bag.ts'),
      `const BAG_KEY = 'bompus_custom_ds_players';
export function persistBag(rows: unknown[]) {
  chrome.storage.local.set({ [BAG_KEY]: rows });
}
`,
    );
    // The hub: matches the query word "storage" by name and is called from many files.
    fs.writeFileSync(
      path.join(dir, 'shared', 'storage.ts'),
      `export function storageSet(key: string, value: unknown) {
  return chrome.storage.local.set({ [key]: value });
}
export function storageGet(key: string) {
  return chrome.storage.local.get(key);
}
`,
    );
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(dir, 'callers', `writer${i}.ts`),
        `import { storageSet, storageGet } from '../shared/storage';
export function storageWriter${i}() {
  storageGet('k${i}');
  return storageSet('k${i}', ${i});
}
`,
      );
    }
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the file holding the quoted key takes the first source slot', async () => {
    const res = await handler.execute('codegraph_explore', {
      query: 'which modules write "bompus_custom_ds_players" to storage',
      maxFiles: 1,
    });
    const text = res.content[0].text as string;
    const sourced = [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
    expect(sourced).toEqual(['shared/bag.ts']);
  });
});

/**
 * A key held in more files than the entry-point cap (`searchLimit`, 3 by default and 8 in
 * explore) must reach every holder: the cap is for text matches, and the literal lookup is
 * already bounded. Before this, holders competed for the cap by path order and `shared/`
 * lost to `scripts/`.
 */
describe('literal seeds — every holder reaches the subgraph past the entry cap', () => {
  let dir: string;
  let cg: CodeGraph;
  const N = 10;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-litcap-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `holder${i}.ts`),
        `export function write${i}(rows: unknown[]) {
  chrome.storage.local.set({ 'bompus_custom_ds_players': rows });
}
`,
      );
    }
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });

  afterAll(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('all holders are roots with the default searchLimit of 3', async () => {
    const sub = await cg.findRelevantContext('which modules write "bompus_custom_ds_players" to storage');
    const rootFiles = new Set(sub.roots.map((id) => sub.nodes.get(id)?.filePath));
    expect(rootFiles.size).toBe(N);
  });

  it('explore renders every holder with the default file cap', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'which modules write "bompus_custom_ds_players" to storage',
    });
    const text = res.content[0].text as string;
    const sourced = [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
    expect(sourced.length).toBe(N);
  });
});

describe('literals — v10 migration', () => {
  let dir: string;
  let db: SqliteDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeV9Db(): SqliteDatabase {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-litmigrate-'));
    const conn = createDatabase(path.join(dir, 'legacy.db')).db;
    conn.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions VALUES (9, 0, 'legacy');
    `);
    db = conn;
    return conn;
  }

  it('creates the empty table and is idempotent on replay', () => {
    const conn = makeV9Db();
    runMigrations(conn, 9);
    expect(getCurrentVersion(conn)).toBe(CURRENT_SCHEMA_VERSION);
    expect((conn.prepare('SELECT COUNT(*) AS n FROM literals').get() as { n: number }).n).toBe(0);
    conn.prepare('DELETE FROM schema_versions WHERE version >= 10').run();
    expect(() => runMigrations(conn, 9)).not.toThrow();
  });
});
