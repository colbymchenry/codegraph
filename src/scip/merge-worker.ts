/**
 * The SCIP merge on its own thread and connection (index.ts passOffThread):
 * the process that started it keeps answering from the committed graph (WAL)
 * until this commits. The caller holds the write locks for the whole run.
 *
 * workerData: { dbPath, projectRoot } → posts { report } or { error }.
 */

import { parentPort, workerData } from 'worker_threads';
import { createDatabase } from '../db/sqlite-adapter';
import { collectBeforeExit } from '../worker-teardown';
import { runScipPass } from './index';

const { dbPath, projectRoot } = workerData as { dbPath: string; projectRoot: string };
const { db } = createDatabase(dbPath);
try {
  // As codegraph's own connections are configured (db/index.ts configureConnection), less what only a reader needs.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  parentPort!.postMessage({ report: runScipPass(db, projectRoot) });
} catch (err) {
  parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
} finally {
  db.close();
  // No GC marking in flight when the thread ends (worker-teardown.ts).
  collectBeforeExit();
}
