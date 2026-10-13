/**
 * Cross-process memo for query-independent whole-graph aggregates.
 *
 * `getDominantFile()` and `getStats()` scan every edge/node, and a fresh
 * process (the prompt hook) cannot reuse the in-memory memo. Values are kept
 * in a sidecar file next to the database, tagged with `project_metadata.graph_epoch`,
 * which `QueryBuilder.bumpGraphEpoch` replaces whenever an index or sync run
 * changes the graph. File mtimes are deliberately not used: WAL checkpoints
 * and no-op opens touch them without changing content. The sidecar is a
 * separate file so storing a value never changes the epoch and a read-only
 * connection can still use it.
 */

import * as fs from 'fs';
import * as path from 'path';

const SIDECAR_SUFFIX = '.memo.json';

type MemoEntries = Record<string, unknown>;

function readEntries(dbPath: string, stamp: string): MemoEntries {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath + SIDECAR_SUFFIX, 'utf8')) as {
      stamp?: unknown;
      entries?: MemoEntries;
    };
    if (parsed.stamp !== stamp || !parsed.entries) return {};
    return parsed.entries;
  } catch {
    return {};
  }
}

/** Look up `key` under `stamp`; undefined when absent, stale, or unreadable. */
export function readPersistedMemo<T>(dbPath: string, stamp: string, key: string): T | undefined {
  return readEntries(dbPath, stamp)[key] as T | undefined;
}

/** Store `value` under `stamp`; failures (read-only dir, races) are ignored. */
export function writePersistedMemo(dbPath: string, stamp: string, key: string, value: unknown): void {
  const target = dbPath + SIDECAR_SUFFIX;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    const entries = { ...readEntries(dbPath, stamp), [key]: value };
    fs.writeFileSync(tmp, JSON.stringify({ stamp, entries }));
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

export function memoDbPath(db: { prepare(sql: string): { all(): unknown[] } }): string | null {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const main = rows.find(r => r.name === 'main');
  return main?.file ? path.resolve(main.file) : null;
}
