import { openMetadataStore } from '../lib/bucket.js';

export interface ImageMetadataInput {
  width: number;
  height: number;
  format: string;
  bytes: number;
}

export interface ImageMetadataRecord extends ImageMetadataInput {
  id: string;
  key: string;
  recordedAt: number;
}

/**
 * Record the image metadata for a stored object. Writes go to the metadata
 * store keyed by object key; the returned record carries the id the queue
 * message references.
 */
export async function recordImageMetadata(
  key: string,
  input: ImageMetadataInput,
): Promise<ImageMetadataRecord> {
  const store = openMetadataStore();
  const record: ImageMetadataRecord = {
    ...input,
    id: metadataIdFor(key, input),
    key,
    recordedAt: 0,
  };
  await store.put(record.id, JSON.stringify(record));
  return record;
}

/** Deterministic id so a retried upload records the same metadata row. */
export function metadataIdFor(key: string, input: ImageMetadataInput): string {
  return `${key}:${input.format}:${input.width}x${input.height}`;
}

/** Read a metadata record back for the download and listing paths. */
export async function loadImageMetadata(id: string): Promise<ImageMetadataRecord | null> {
  const store = openMetadataStore();
  const raw = await store.get(id);
  return raw ? (JSON.parse(raw) as ImageMetadataRecord) : null;
}

/** Normalize a client-declared format string to the canonical set. */
export function normalizeFormat(format: string): string {
  const lowered = format.trim().toLowerCase();
  if (lowered === 'jpg') return 'jpeg';
  if (lowered === 'tif') return 'tiff';
  return lowered;
}
