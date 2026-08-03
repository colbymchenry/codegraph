/**
 * Store worker — dedicated writer thread for the bulk-index store phase.
 *
 * During a fresh full index the main thread's biggest serial cost is executing
 * the per-file INSERT batches. This worker owns that work on its own SQLite
 * connection: the orchestrator posts one message per file (in file order) and
 * the worker applies them in arrival order, which preserves the #1015
 * insertion-order determinism exactly as if the main thread had run the same
 * calls. The main thread performs NO database access while the writer is
 * active (fresh-DB path only), so there is no cross-connection contention.
 *
 * Protocol (main → worker):
 *   {type:'open', dbPath, fastInit}  → open connection, reply {type:'ready'}
 *   {type:'bundle', bundle}          → apply one file's store bundle
 *   {type:'drain', id}               → reply {type:'drained', id} (in-order ⇒ all prior bundles applied)
 *   {type:'close'}                   → close DB and exit
 * Worker → main: {type:'ready'} | {type:'drained', id} | {type:'error', message}
 *
 * A bundle failure does not kill the worker; the first error is reported and
 * the client surfaces it at drain(), matching the main-thread path where a
 * store exception propagates out of the ordered-flush chain.
 */

// Compile cache FIRST — same worker-boot rationale as parse-worker.ts.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch { /* cache is best-effort */ }

import { parentPort } from 'worker_threads';
import { QueryBuilder } from '../db/queries';
import { createDatabase, SqliteDatabase } from '../db/sqlite-adapter';
import { finalizeStoreBundle, type KernelStoreBundle, type StoreBundle } from './store-writer';
import { decodeExtractBuffers } from './kernel/decode';

if (!parentPort) {
  throw new Error('store-worker must be run as a worker thread');
}
const port = parentPort;

let db: SqliteDatabase | null = null;
let queries: QueryBuilder | null = null;

// CODEGRAPH_SYNTH_TIMINGS: split the writer lane's busy time into its two
// halves — kernel-buffer decode+finalize (JS-object materialization, the §4d
// buffer→bind candidate) vs the SQL bundle store — printed once at close.
const STORE_TIMINGS = !!process.env.CODEGRAPH_SYNTH_TIMINGS;
let decodeNs = 0n;
let storeNs = 0n;
let bundleCount = 0;
let kernelBundleCount = 0;

type InMessage =
  | { type: 'open'; dbPath: string; fastInit: boolean }
  | { type: 'bundle'; bundle: StoreBundle | KernelStoreBundle }
  | { type: 'drain'; id: number }
  | { type: 'close' };

/** Decode a kernel bundle's buffers into the standard pre-filtered StoreBundle. */
function decodeKernelBundle(bundle: KernelStoreBundle): StoreBundle {
  const asBuf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
  const decoded = decodeExtractBuffers(
    {
      meta: asBuf(bundle.buffers.meta),
      nodes: asBuf(bundle.buffers.nodes),
      edges: asBuf(bundle.buffers.edges),
      refs: asBuf(bundle.buffers.refs),
      arena: asBuf(bundle.buffers.arena),
    },
    bundle.filePath,
    bundle.language
  );
  return finalizeStoreBundle(decoded, bundle.filePath, bundle.language, bundle.file);
}

port.on('message', (msg: InMessage) => {
  try {
    switch (msg.type) {
      case 'open': {
        const created = createDatabase(msg.dbPath);
        db = created.db;
        // Mirrors db/index.ts configureConnection, with the same fast-init
        // durability trade the main connection applies for fresh builds.
        db.pragma('busy_timeout = 5000');
        db.pragma('foreign_keys = ON');
        if (msg.fastInit) {
          db.pragma('journal_mode = MEMORY');
          db.pragma('synchronous = OFF');
        } else {
          db.pragma('synchronous = NORMAL');
        }
        db.pragma('cache_size = -64000');
        db.pragma('temp_store = MEMORY');
        queries = new QueryBuilder(db);
        port.postMessage({ type: 'ready' });
        break;
      }
      case 'bundle': {
        if (!queries) throw new Error('store-worker: bundle before open');
        if (STORE_TIMINGS) {
          bundleCount++;
          const t0 = process.hrtime.bigint();
          let bundle: StoreBundle;
          if ('kernel' in msg.bundle) {
            kernelBundleCount++;
            bundle = decodeKernelBundle(msg.bundle);
          } else {
            bundle = msg.bundle;
          }
          const t1 = process.hrtime.bigint();
          queries.storeFileBundle(bundle);
          decodeNs += t1 - t0;
          storeNs += process.hrtime.bigint() - t1;
          port.postMessage({ type: 'ack' });
          break;
        }
        const bundle = 'kernel' in msg.bundle ? decodeKernelBundle(msg.bundle) : msg.bundle;
        queries.storeFileBundle(bundle);
        port.postMessage({ type: 'ack' });
        break;
      }
      case 'drain': {
        port.postMessage({ type: 'drained', id: msg.id });
        break;
      }
      case 'close': {
        if (STORE_TIMINGS && bundleCount > 0) {
          console.error(
            `[store-timing] bundles=${bundleCount} (kernel=${kernelBundleCount}) decode=${(Number(decodeNs / 1_000_000n) / 1000).toFixed(2)}s store=${(Number(storeNs / 1_000_000n) / 1000).toFixed(2)}s`
          );
        }
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
    // The error reply doubles as the bundle's ack so the client's outstanding
    // counter still drains after a failure.
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
