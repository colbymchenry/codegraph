/** Exact CLI-parity change count, isolated from the MCP transport event loop. */
import { parentPort, workerData } from 'worker_threads';
import { collectBeforeExit } from '../worker-teardown';

if (parentPort) {
  const port = parentPort;
  let cg: import('../index').default | null = null;
  let counts: { added: number; modified: number; removed: number } | null = null;
  try {
    const CodeGraph = (require('../index') as typeof import('../index')).default;
    // Loaded: from here on the owner may terminate this worker. Ending it while
    // it loads those modules can crash the process on Windows (worker-teardown.ts).
    port.postMessage({ type: 'loaded' });
    cg = CodeGraph.openSync((workerData as { root: string }).root);
    const changes = cg.getChangedFiles();
    counts = {
      added: changes.added.length,
      modified: changes.modified.length,
      removed: changes.removed.length,
    };
  } catch {
    // A failed or timed-out measurement must never masquerade as zero changes.
  } finally {
    try { cg?.close(); } catch { /* the worker is exiting */ }
  }
  // The owner terminates this worker on the answer: no GC marking in flight then.
  collectBeforeExit();
  port.postMessage({ type: 'counts', counts });
}
