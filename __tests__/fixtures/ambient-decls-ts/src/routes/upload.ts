import { streamBodyToStorage } from '../storage/stream.js';
import { recordImageMetadata } from '../storage/metadata.js';
import { enqueueUploadMessage } from '../lib/queue.js';
import { parseUploadRequest } from '../lib/request.js';

export interface UploadResult {
  key: string;
  bytes: number;
  contentType: string;
}

/**
 * Entry point for an upload request: parse it, stream the body into object
 * storage, record the image metadata, then queue the follow-up work.
 */
export async function handleUploadRequest(request: Request): Promise<Response> {
  const parsed = await parseUploadRequest(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify({ error: parsed.error }), { status: 400 });
  }

  const stored = await streamBodyToStorage(parsed.body, parsed.key, parsed.contentType);
  const metadata = await recordImageMetadata(stored.key, {
    width: parsed.width,
    height: parsed.height,
    format: parsed.format,
    bytes: stored.bytes,
  });

  await enqueueUploadMessage({
    key: stored.key,
    metadataId: metadata.id,
    contentType: stored.contentType,
  });

  return new Response(JSON.stringify(summarizeUpload(stored, metadata.id)), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

/** Shape the client sees back after a successful upload. */
export function summarizeUpload(stored: UploadResult, metadataId: string) {
  return {
    key: stored.key,
    bytes: stored.bytes,
    contentType: stored.contentType,
    metadataId,
  };
}

/** Reject uploads whose declared size exceeds the per-account ceiling. */
export function isWithinUploadLimit(bytes: number, limit: number): boolean {
  if (!Number.isFinite(bytes) || bytes < 0) return false;
  return bytes <= limit;
}

/** Delete-side counterpart, kept here so the route module is not a one-liner. */
export async function handleDeleteRequest(request: Request, key: string): Promise<Response> {
  const parsed = await parseUploadRequest(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify({ error: parsed.error }), { status: 400 });
  }
  await enqueueUploadMessage({ key, metadataId: '', contentType: 'application/x-delete' });
  return new Response(null, { status: 204 });
}
