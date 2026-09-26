/** Exact CLI-parity change count, isolated from the MCP transport event loop. */
import { parentPort, workerData } from 'worker_threads';

if (parentPort) {
  const port = parentPort;
  let cg: import('../index').default | null = null;
  let counts: { added: number; modified: number; removed: number } | null = null;
  try {
    const CodeGraph = (require('../index') as typeof import('../index')).default;
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
  port.postMessage(counts);
}
