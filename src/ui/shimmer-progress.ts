import { Worker } from 'worker_threads';
import * as path from 'path';
import { ansiColorsEnabled } from './color';

const PHASE_NAMES: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  storing: 'Storing data',
  resolving: 'Resolving refs',
  linking: 'Linking dynamic dispatch',
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
  // Piped/redirected stdout: `\r`-rewriting animation frames are garbage in a
  // log file — emit one plain line per phase instead (#1281).
  if (process.stdout.isTTY !== true) {
    return createPlainProgress();
  }

  let lastPhase = '';

  const workerPath = path.join(__dirname, 'shimmer-worker.js');
  const worker = new Worker(workerPath, {
    // colors:false keeps the animation (still an interactive TTY) but drops
    // the ANSI color codes, honoring NO_COLOR / --no-color (#1281).
    workerData: { startTime: Date.now(), colors: ansiColorsEnabled() },
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

/**
 * Non-TTY fallback: one plain line per phase, no rewrites, no ANSI.
 * Completion details (counts, timings) are printed by the caller's result
 * summary, so phase starts are all that's worth logging here.
 */
function createPlainProgress(): ShimmerProgress {
  let lastPhase = '';

  return {
    onProgress(progress: IndexProgress) {
      if (progress.phase === lastPhase) return;
      lastPhase = progress.phase;
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;
      process.stdout.write(`${phaseName}...\n`);
    },

    stop() {
      return Promise.resolve();
    },
  };
}
