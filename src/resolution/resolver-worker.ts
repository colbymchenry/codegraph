/**
 * Resolver worker — one member of the parallel-resolution pool.
 *
 * Opens the project database READ-ONLY on its own connection and hosts a full
 * ReferenceResolver over it. The main thread partitions each resolution batch
 * into ordered chunks, fans them across the pool, and ADMITS the results
 * sequentially in chunk order — so edge insertion order (and every cleanup /
 * parking side effect) is identical to the single-threaded loop. Workers only
 * ever read; all writes stay on the main thread.
 *
 * Visibility note: the sequential baseline resolves every ref of a batch
 * against the DB state committed BEFORE that batch (edges persist after the
 * whole batch resolves). Workers read exactly that same committed state, so
 * per-ref inputs match the baseline ref-for-ref.
 */

// Compile cache FIRST — same worker-boot rationale as parse-worker.ts.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch { /* cache is best-effort */ }

import { parentPort, threadId } from 'worker_threads';
import { createDatabase, SqliteDatabase } from '../db/sqlite-adapter';
import { QueryBuilder } from '../db/queries';
import { ReferenceResolver } from './index';
import { SYNTH_PASSES } from './callback-synthesizer';
import { createYielder } from './cooperative-yield';
import type { UnresolvedReference } from '../types';

if (!parentPort) {
  throw new Error('resolver-worker must be run as a worker thread');
}
const port = parentPort;

let db: SqliteDatabase | null = null;
let queries: QueryBuilder | null = null;
let resolver: ReferenceResolver | null = null;

type InMessage =
  | { type: 'open'; dbPath: string; projectRoot: string }
  | { type: 'resolve'; id: number; refs: UnresolvedReference[] }
  | { type: 'synth'; id: number; pass: string }
  | { type: 'close' };

port.on('message', (msg: InMessage) => {
  try {
    switch (msg.type) {
      case 'open': {
        const tOpen = Date.now();
        const created = createDatabase(msg.dbPath, { readOnly: true });
        db = created.db;
        db.pragma('busy_timeout = 5000');
        db.pragma('cache_size = -32000');
        const tDb = Date.now();
        queries = new QueryBuilder(db);
        resolver = new ReferenceResolver(msg.projectRoot, queries);
        resolver.initialize();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] worker open: db=${tDb - tOpen}ms init=${Date.now() - tDb}ms`);
        port.postMessage({ type: 'ready' });
        break;
      }
      case 'resolve': {
        if (!resolver) throw new Error('resolver-worker: resolve before open');
        const tRes = Date.now();
        const out = resolver.resolveListForAdmission(msg.refs);
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] worker resolve: ${msg.refs.length} refs in ${Date.now() - tRes}ms`);
        port.postMessage({ type: 'result', id: msg.id, ...out });
        break;
      }
      case 'synth': {
        // Run one synthesis pass against this worker's read-only connection.
        // Passes only READ (graph + source via the resolver's context); their
        // edges are returned for the main thread's ordered merge. Async, with
        // its own error propagation — a throwing pass reports {type:'error'}
        // and the main thread retries it sequentially.
        if (!resolver || !queries) throw new Error('resolver-worker: synth before open');
        const pass = SYNTH_PASSES.find((p) => p.name === msg.pass);
        if (!pass) throw new Error(`resolver-worker: unknown synth pass '${msg.pass}'`);
        const q = queries;
        const r = resolver;
        void (async () => {
          const t0 = Date.now();
          try {
            const edges = await pass.run(q, r.getResolutionContext(), createYielder());
            port.postMessage({ type: 'synth-result', id: msg.id, edges, ms: Date.now() - t0 });
          } catch (err) {
            port.postMessage({
              type: 'error',
              id: msg.id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        break;
      }
      case 'close': {
        try {
          resolver?.dumpResolveProfile(`worker#${threadId}`);
        } catch { /* diagnostics never block shutdown */ }
        try {
          db?.close();
        } catch {
          /* already closed */
        }
        process.exit(0);
        break;
      }
    }
  } catch (err) {
    port.postMessage({
      type: 'error',
      id: (msg as { id?: number }).id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
