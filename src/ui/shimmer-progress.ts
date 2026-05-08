import { Worker } from 'worker_threads';
import * as path from 'path';

const PHASE_NAMES: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  storing: 'Storing data',
  resolving: 'Resolving refs',
};

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
}

export interface ShimmerProgress {
  onProgress: (progress: IndexProgress) => void;
  stop: () => Promise<void>;
}

export function createShimmerProgress(): ShimmerProgress {
  let lastPhase = '';

  const workerPath = path.join(__dirname, 'shimmer-worker.js');
  const worker = new Worker(workerPath, {
    workerData: { startTime: Date.now() },
  });

  return {
    onProgress(progress: IndexProgress) {
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;

      if (progress.phase !== lastPhase && lastPhase) {
        worker.postMessage({ type: 'finish-phase' });
      }
      lastPhase = progress.phase;

      let percent = -1;
      let count = 0;
      if (progress.total > 0) {
        percent = Math.round((progress.current / progress.total) * 100);
      } else if (progress.current > 0) {
        count = progress.current;
      }

      worker.postMessage({
        type: 'update',
        phase: progress.phase,
        phaseName,
        percent,
        count,
      });
    },

    stop() {
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate().then(() => resolve());
        }, 2000);

        worker.on('message', (msg: { type: string }) => {
          if (msg.type === 'stopped') {
            clearTimeout(timeout);
            worker.terminate().then(() => resolve());
          }
        });

        worker.postMessage({ type: 'stop' });
      });
    },
  };
}
