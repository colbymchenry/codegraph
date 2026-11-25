/** Messages from main thread to worker */
export type ShimmerWorkerMessage =
  | { type: 'update'; phase: string; phaseName: string; percent: number; count: number }
  | { type: 'stop' };

/** Messages from worker to main thread */
export type ShimmerMainMessage =
  | { type: 'stopped' };
