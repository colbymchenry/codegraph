import type { PipelineRecord } from './types';

const sink = new Map<string, PipelineRecord[]>();

/** Hand a finished batch to the downstream sink. */
export function writeBatch(batchId: string, records: PipelineRecord[]): void {
  sink.set(batchId, records);
}

/** Read a batch back out of the sink. */
export function readBatch(batchId: string): PipelineRecord[] {
  return sink.get(batchId) ?? [];
}

/** Forget a batch. */
export function dropBatch(batchId: string): void {
  sink.delete(batchId);
}
