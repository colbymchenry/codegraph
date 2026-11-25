/** One raw record as it arrives from the upstream feed. */
export interface RawRecord {
  id: string;
  source: string;
  payload: Record<string, string | number | null>;
  receivedAt: number;
}

/** A record after the pipeline has cleaned and annotated it. */
export interface PipelineRecord {
  id: string;
  source: string;
  kind: string;
  value: number;
  tags: string[];
  warnings: string[];
}

/** Per-run knobs shared by every pipeline stage. */
export interface PipelineOptions {
  strict: boolean;
  dropEmpty: boolean;
  defaultKind: string;
  maxTags: number;
}
