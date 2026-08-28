import { ingestRecords } from './pipeline/ingest';
import { normalizeRecords } from './pipeline/normalize';
import { enrichRecords } from './pipeline/enrich';
import { publishRecords } from './pipeline/publish';
import type { PipelineOptions, PipelineRecord, RawRecord } from './pipeline/types';

/** Run one batch through every pipeline stage, in order. */
export function runPipeline(batch: RawRecord[], options: PipelineOptions): PipelineRecord[] {
  return publishRecords(enrichRecords(normalizeRecords(ingestRecords(batch, options), options), options), options);
}
