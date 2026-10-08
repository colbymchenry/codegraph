import { createDatabase, type SqliteDatabase } from './sqlite-adapter';
import { QueryBuilder } from './queries';
import { createYielder } from '../resolution/cooperative-yield';

// Ownership is independent of provenance: Go method containment is structural.
export const SYNTHESIZED_EDGE = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.synthesizedBy') END IS NOT NULL";

/** A private edge overlay: passes see base edges plus their new Go prerequisites. */
export class SynthesisStage {
  readonly db: SqliteDatabase;
  readonly queries: QueryBuilder;

  constructor(dbPath: string) {
    this.db = createDatabase(dbPath).db;
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('wal_autocheckpoint = 0');
      this.db.exec(`
        CREATE TEMP TABLE synthesis_inputs (file_path TEXT PRIMARY KEY);
        CREATE TEMP TABLE synthesis_edges (
          id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
          metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
        );
        CREATE UNIQUE INDEX temp.synthesis_identity ON synthesis_edges
          (source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
        CREATE INDEX temp.synthesis_source ON synthesis_edges(source, kind);
        CREATE INDEX temp.synthesis_target ON synthesis_edges(target, kind);
        CREATE TEMP VIEW edges AS
          SELECT * FROM main.edges WHERE NOT COALESCE((${SYNTHESIZED_EDGE}), 0)
          UNION ALL SELECT * FROM synthesis_edges;
        CREATE TEMP TRIGGER synthesis_insert INSTEAD OF INSERT ON edges BEGIN
          INSERT OR IGNORE INTO synthesis_edges
            (source, target, kind, metadata, line, col, provenance)
          SELECT NEW.source, NEW.target, NEW.kind, NEW.metadata, NEW.line, NEW.col, NEW.provenance
          WHERE NOT EXISTS (
            SELECT 1 FROM main.edges WHERE source = NEW.source AND target = NEW.target
              AND kind = NEW.kind AND IFNULL(line, -1) = IFNULL(NEW.line, -1)
              AND IFNULL(col, -1) = IFNULL(NEW.col, -1)
              AND NOT COALESCE((${SYNTHESIZED_EDGE}), 0)
          );
        END;
      `);
      this.queries = new QueryBuilder(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async publish(backpressure?: () => Promise<void> | null): Promise<void> {
    await backpressure?.();
    const yieldToLoop = createYielder();
    // Keep the replacement atomic for other connections. Yield between bounded
    // writes, but checkpoint only OUTSIDE this transaction (uncommitted frames
    // cannot be folded). Pass execution/staging above never writes the main WAL.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.db.prepare(`DELETE FROM main.edges WHERE id IN (
        SELECT id FROM main.edges WHERE ${SYNTHESIZED_EDGE} LIMIT 2000
      )`);
      while (remove.run().changes > 0) await yieldToLoop();
      const insert = this.db.prepare(`INSERT OR IGNORE INTO main.edges
        (source, target, kind, metadata, line, col, provenance)
        SELECT source, target, kind, metadata, line, col, provenance
        FROM synthesis_edges WHERE id > ? AND id <= ?`);
      const max = this.db.prepare('SELECT MAX(id) AS id FROM synthesis_edges').get()?.id ?? 0;
      for (let i = 0; i < max; i += 2000) {
        insert.run(i, i + 2000);
        await yieldToLoop();
      }
      this.db.exec(`DELETE FROM main.synthesis_inputs;
        INSERT INTO main.synthesis_inputs SELECT * FROM temp.synthesis_inputs`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    await backpressure?.();
  }

  close(): void {
    this.db.close();
  }
}
