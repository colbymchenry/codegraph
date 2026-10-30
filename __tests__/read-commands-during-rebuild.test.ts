/**
 * The CLI's read commands and the prompt hook while another process writes
 * the index (#2913). #2930 fixed `codegraph status`; these are the rest.
 *
 * Opened read-write, a command ran the writer's open-time repairs: during a
 * bulk load they recreated the secondary edge indexes the writer had dropped,
 * and the writer's next edge write failed with SQLITE_BUSY_SNAPSHOT
 * ("database is locked"). Every command that only reads now opens the index
 * read-only. A read-only open migrates nothing, so the same commands must also
 * answer from an index an older release built.
 *
 * The CLI runs against the built binary, as the issue's reproduction did.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCli(cwd: string, args: string[], stdin?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input: stdin,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
      CODEGRAPH_NO_RELAUNCH: '1', CODEGRAPH_WASM_RELAUNCHED: '1',
      CODEGRAPH_NO_PROMPT_HOOK: '0', CODEGRAPH_PROMPT_HOOK: '1',
      NO_COLOR: '1',
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface ReadCommand {
  name: string;
  args: string[];
  /** The prompt the hook is handed, for `prompt-hook`. */
  prompt?: string;
  answer: RegExp;
}

const READ_COMMANDS: ReadCommand[] = [
  { name: 'query', args: ['query', 'loadOrderState'], answer: /function\s+loadOrderState/ },
  { name: 'files', args: ['files', '--json'], answer: /"path": "src\/order\.ts"/ },
  { name: 'node', args: ['node', 'loadOrderState'], answer: /\*\*loadOrderState\*\* \(function\)/ },
  { name: 'callers', args: ['callers', 'loadOrderState'], answer: /getUserProfile/ },
  { name: 'callees', args: ['callees', 'getUserProfile'], answer: /loadOrderState/ },
  { name: 'impact', args: ['impact', 'loadOrderState'], answer: /getUserProfile/ },
  { name: 'context', args: ['context', 'getUserProfile', 'loadOrderState'], answer: /loadOrderState/ },
  { name: 'explore', args: ['explore', 'getUserProfile', 'loadOrderState'], answer: /src\/order\.ts/ },
  { name: 'affected', args: ['affected', 'src/order.ts'], answer: /src\/user\.test\.ts/ },
  { name: 'cycles', args: ['cycles'], answer: /No circular imports found/ },
  { name: 'prompt-hook', args: ['prompt-hook'], prompt: 'how does getUserProfile reach loadOrderState?', answer: /<codegraph_context[\s\S]*loadOrderState/ },
  { name: 'prompt-hook, segment tier', args: ['prompt-hook'], prompt: 'the order state machine keeps resetting', answer: /<codegraph_context[\s\S]*OrderStateMachine/ },
];

function run(dir: string, command: ReadCommand): { status: number | null; stdout: string; stderr: string } {
  const stdin = command.prompt === undefined ? undefined : JSON.stringify({ prompt: command.prompt, cwd: dir });
  return runCli(dir, command.args, stdin);
}

function writeProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'order.ts'), [
    'export class OrderStateMachine {',
    '  advance(next: string): string { return next; }',
    '}',
    'export function loadOrderState(id: string): OrderStateMachine {',
    '  const machine = new OrderStateMachine();',
    '  machine.advance(id);',
    '  return machine;',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'user.ts'), [
    "import { loadOrderState } from './order';",
    'export function getUserProfile(id: string) { return { id, order: loadOrderState(id) }; }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src', 'user.test.ts'), [
    "import { getUserProfile } from './user';",
    "export function profileTest() { return getUserProfile('1'); }",
    '',
  ].join('\n'));
}

const dbOf = (dir: string): string => path.join(dir, '.codegraph', 'codegraph.db');

/** The secondary indexes on `edges`, the ones a bulk load drops. */
function edgeIndexes(conn: DatabaseConnection): string[] {
  return (conn.getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'edges' AND sql IS NOT NULL"
  ).all() as Array<{ name: string }>).map((r) => r.name).sort();
}

function schemaVersion(dir: string): number | undefined {
  const conn = DatabaseConnection.open(dbOf(dir), { readOnly: true });
  try {
    return conn.getSchemaVersion()?.version;
  } finally {
    conn.close();
  }
}

/**
 * Take a current index back to the schema an older release wrote, undoing
 * what the later migrations added (src/db/migrations.ts). Schema 7 is 1.3.0 to
 * 1.4.x; schema 4 is 0.7.6 to 0.9.9, the oldest any release tag wrote.
 */
function downgradeTo(dir: string, version: 4 | 7): void {
  const conn = DatabaseConnection.open(dbOf(dir));
  try {
    const db = conn.getDb();
    const dropIndexesOn = (table: string, columns: RegExp): void => {
      const indexes = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
      ).all(table) as Array<{ name: string; sql: string }>;
      for (const { name, sql } of indexes) if (columns.test(sql)) db.exec(`DROP INDEX ${name}`);
    };
    db.exec('DROP TABLE synthesis_inputs; DROP INDEX idx_edges_synthesis_site'); // v10
    dropIndexesOn('files', /generated/);
    db.exec('ALTER TABLE files DROP COLUMN generated'); // v9
    dropIndexesOn('unresolved_refs', /status|name_tail/);
    // Before v8 a finished resolution pass deleted what it could not resolve.
    db.exec("DELETE FROM unresolved_refs WHERE status = 'failed'");
    db.exec('ALTER TABLE unresolved_refs DROP COLUMN status');
    db.exec('ALTER TABLE unresolved_refs DROP COLUMN name_tail'); // v8
    if (version < 7) {
      db.exec('DROP TABLE name_segment_vocab'); // v7
      db.exec('DROP INDEX idx_edges_identity'); // v6
      db.exec('ALTER TABLE nodes DROP COLUMN return_type'); // v5
    }
    db.exec(`DELETE FROM schema_versions; INSERT INTO schema_versions (version, applied_at, description) VALUES (${version}, 0, 'older release')`);
  } finally {
    conn.close();
  }
}

describe('read commands while another process writes the index (#2913)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-read-rebuild-'));
    writeProject(dir);
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
  }, 60_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The locks the writer holds: a rebuild's (`codegraph index`), or a sync's index lock. */
  function holdLocks(kind: 'rebuild' | 'sync'): () => void {
    const dataDir = path.join(dir, '.codegraph');
    const files = kind === 'rebuild' ? ['rebuild.pid', 'writer.pid'] : ['codegraph.lock'];
    const content = kind === 'rebuild'
      ? JSON.stringify({ pid: process.pid, mode: 'rebuild', startedAt: Date.now(), ready: false })
      : String(process.pid);
    for (const file of files) fs.writeFileSync(path.join(dataDir, file), content);
    return () => { for (const file of files) fs.rmSync(path.join(dataDir, file), { force: true }); };
  }

  /**
   * The issue's interleaving: the writer drops the edge indexes for a bulk
   * load, reads its endpoints inside the edge transaction, the command runs in
   * another process, then the writer inserts.
   */
  async function insideWritersEdgeTransaction(
    locks: 'rebuild' | 'sync',
    edgeLine: number,
    observe: () => void,
  ): Promise<{ dropped: string[]; afterInsert: string[] }> {
    const writer = DatabaseConnection.open(dbOf(dir));
    const release = holdLocks(locks);
    try {
      const complete = edgeIndexes(writer);
      writer.beginBulkEdgeLoad();
      const dropped = edgeIndexes(writer);
      expect(dropped.length).toBeLessThan(complete.length);

      const db = writer.getDb();
      const ids = (db.prepare("SELECT id FROM nodes WHERE kind = 'function' ORDER BY name").all() as Array<{ id: string }>).map((r) => r.id);
      const edgeCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;
      const before = edgeCount();
      const queries = new QueryBuilder(db);
      // The endpoint read is private; hook it as the issue's reproduction did.
      const hooked = queries as unknown as { getExistingNodeIds: (ids: readonly string[]) => Set<string> };
      const readEndpoints = hooked.getExistingNodeIds.bind(queries);
      hooked.getExistingNodeIds = (endpointIds) => {
        const existing = readEndpoints(endpointIds);
        observe();
        return existing;
      };
      // Read-write, the command recreated the dropped indexes in between, and
      // this insert failed with SQLITE_BUSY_SNAPSHOT (517).
      expect(() => queries.insertEdges([{ source: ids[0]!, target: ids[1]!, kind: 'references', line: edgeLine }])).not.toThrow();
      expect(edgeCount()).toBe(before + 1);
      const afterInsert = edgeIndexes(writer);
      await writer.endBulkEdgeLoad();
      expect(edgeIndexes(writer)).toEqual(complete);
      return { dropped, afterInsert };
    } finally {
      release();
      writer.close();
    }
  }

  it.each(READ_COMMANDS.map((command, i) => [command.name, command, i] as const))(
    '%s answers inside the writer\'s bulk load without failing its next write',
    async (_name, command, i) => {
      // The hook keeps out of a rebuild altogether (below), so it meets a
      // sync's bulk load here; the commands meet the issue's rebuild.
      const locks = command.args[0] === 'prompt-hook' ? 'sync' : 'rebuild';
      let result: ReturnType<typeof run> | undefined;
      const { dropped, afterInsert } = await insideWritersEdgeTransaction(locks, 1000 + i, () => {
        result = run(dir, command);
      });
      expect(result?.status, result?.stderr).toBe(0);
      expect(result?.stdout).toMatch(command.answer);
      // Mid-rebuild, the answer comes from a graph still being built.
      if (locks === 'rebuild') expect(result?.stderr).toContain('An index rebuild ("codegraph index") is running in another process');
      // The command repaired nothing: the bulk load's indexes are still down.
      expect(afterInsert).toEqual(dropped);
    },
    60_000,
  );

  it('the prompt hook leaves an index alone while `codegraph index` rebuilds it', async () => {
    let result: ReturnType<typeof run> | undefined;
    const hook = READ_COMMANDS.find((c) => c.name === 'prompt-hook')!;
    await insideWritersEdgeTransaction('rebuild', 2000, () => {
      result = run(dir, hook);
    });
    // Silent, as on every path it cannot serve: the index is half-built until
    // the rebuild ends. Once it has, the hook answers again.
    expect(result?.status, result?.stderr).toBe(0);
    expect(result?.stdout).toBe('');
    expect(run(dir, hook).stdout).toMatch(hook.answer);
  }, 60_000);
});

describe('read commands on an index an older release built (#2913)', () => {
  let base: string;
  const copies: string[] = [];

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-read-legacy-'));
    writeProject(base);
    const cg = CodeGraph.initSync(base);
    await cg.indexAll();
    cg.close();
  }, 60_000);

  afterAll(() => {
    for (const copy of [base, ...copies]) fs.rmSync(copy, { recursive: true, force: true });
  });

  function legacyCopy(version: 4 | 7, prepare?: (db: DatabaseConnection) => void): string {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-read-v${version}-`));
    copies.push(copy);
    fs.cpSync(base, copy, { recursive: true });
    if (prepare) {
      const conn = DatabaseConnection.open(dbOf(copy));
      try {
        prepare(conn);
      } finally {
        conn.close();
      }
    }
    downgradeTo(copy, version);
    return copy;
  }

  // Schema 7 has no reference status (v8), generated-file flag (v9) or
  // synthesis inputs (v10); schema 4 has no segment vocabulary (v7) and no
  // return types (v5) either. The commands read each index as it is.
  it.each(READ_COMMANDS.flatMap((command) => ([7, 4] as const).map((version) => [command.name, version, command] as const)))(
    '%s answers from a schema-%i index',
    (_name, version, command) => {
      const copy = legacyCopy(version);
      const result = run(copy, command);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(command.answer);
      // The hook's segment tier needs the vocabulary that schema 4 predates.
      // It fills it under the index lock through a writer of its own, whose
      // open upgrades the index, as every read-write open used to.
      const upgraded = version === 4 && command.name === 'prompt-hook, segment tier';
      expect(schemaVersion(copy)).toBe(upgraded ? schemaVersion(base) : version);
    },
    60_000,
  );

  it.each([7, 4] as const)('every read of a later table or column answers from a schema-%i index read-only', (version) => {
    const copy = legacyCopy(version, (writer) => {
      // A reference an interrupted run left behind, pending as the v8 migration marks it.
      const from = (writer.getDb().prepare("SELECT id FROM nodes WHERE name = 'getUserProfile'").get() as { id: string }).id;
      writer.getDb().prepare(
        "INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?, 'missingSink', 'calls', 2, 0, 'src/user.ts', 'typescript')"
      ).run(from);
    });
    const conn = DatabaseConnection.open(dbOf(copy), { readOnly: true });
    try {
      const queries = new QueryBuilder(conn.getDb());
      expect(queries.getGeneratedPathsAmong(['src/order.ts', 'src/user.ts']).size).toBe(0);
      expect(queries.countGeneratedFiles()).toBe(0);
      const unreferenced = queries.getUnreferencedNodes(['function'], 50);
      expect(unreferenced.map((r) => r.node.name)).toContain('profileTest');
      expect(unreferenced.every((r) => !r.generated)).toBe(true);
      expect([...queries.getUnresolvedNamesAmong(['missingSink', 'other'])]).toEqual(['missingSink']);
      expect(queries.getUnresolvedReferencesCount()).toBe(1);
      const vocab = version >= 7;
      expect(queries.isNameSegmentVocabEmpty()).toBe(!vocab);
      expect(queries.getSegmentCoOccurrence([{ segment: 'order', word: 'order' }, { segment: 'state', word: 'state' }], 2, 5).map((r) => r.name))
        .toEqual(vocab ? expect.arrayContaining(['OrderStateMachine']) : []);
      expect((queries.getSegmentNameCounts(['order']).get('order') ?? 0) > 0).toBe(vocab);
      expect(queries.getNamesForSegment('machine', 5)).toEqual(vocab ? expect.arrayContaining(['OrderStateMachine']) : []);
      expect(queries.getExploreMissDiagnostics('order nothinglikethis').matched).toEqual(['order']);
    } finally {
      conn.close();
    }
    expect(schemaVersion(copy)).toBe(version);
  }, 60_000);
});

describe('the prompt hook fills an empty segment vocabulary under the index lock (#1142, #2913)', () => {
  let dir: string;
  const segmentTier = READ_COMMANDS.find((c) => c.name === 'prompt-hook, segment tier')!;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-read-vocab-'));
    writeProject(dir);
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
    const conn = DatabaseConnection.open(dbOf(dir));
    try {
      conn.getDb().exec('DELETE FROM name_segment_vocab');
    } finally {
      conn.close();
    }
  }, 60_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function vocabRows(): number {
    const conn = DatabaseConnection.open(dbOf(dir), { readOnly: true });
    try {
      return (conn.getDb().prepare('SELECT COUNT(*) AS n FROM name_segment_vocab').get() as { n: number }).n;
    } finally {
      conn.close();
    }
  }

  it('writes nothing while an index or sync holds the lock', () => {
    const lock = path.join(dir, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lock, String(process.pid));
    try {
      const result = run(dir, segmentTier);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(vocabRows()).toBe(0);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }, 60_000);

  it('fills it once the lock is free, and answers from it', () => {
    const result = run(dir, segmentTier);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(segmentTier.answer);
    expect(vocabRows()).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, '.codegraph', 'codegraph.lock'))).toBe(false);
  }, 60_000);
});
