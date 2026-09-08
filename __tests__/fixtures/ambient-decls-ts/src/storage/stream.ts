import { openBucket } from '../lib/bucket.js';
import type { StorageFailure, UploadTelemetry } from './types.js';

export interface StoredObject {
  key: string;
  bytes: number;
  contentType: string;
}

/**
 * Stream a request body into object storage without buffering it in memory.
 * The body is piped through a counting transform so the byte total is known
 * by the time the put resolves.
 */
export async function streamBodyToStorage(
  body: ReadableStream<Uint8Array>,
  key: string,
  contentType: string,
): Promise<StoredObject> {
  const bucket = openBucket();
  const counter = createByteCounter();
  const piped = body.pipeThrough(counter.transform, { preventClose: false });

  await bucket.put(key, piped, { httpMetadata: { contentType } });

  return { key, bytes: counter.total(), contentType };
}

/**
 * A transform stream that counts the bytes flowing through it. Separated from
 * the pipe above so the byte total can be read after the stream settles.
 */
export function createByteCounter() {
  let total = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { transform, total: () => total };
}

/**
 * Read a stored object back out of the bucket as a stream, for the download
 * path. Mirrors the upload side so both directions live in one module.
 */
export async function readObjectStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
  const bucket = openBucket();
  const object = await bucket.get(key);
  if (!object) return null;
  return object.body;
}

/** Timing/retry record for one stored object, handed to the metrics sink. */
export function telemetryFor(stored: StoredObject, durationMs: number): UploadTelemetry {
  return { key: stored.key, bytes: stored.bytes, durationMs, retries: 0 };
}

/** Describe a failed stage so the caller can report it without re-deriving it. */
export function storageFailure(
  key: string,
  stage: StorageFailure['stage'],
  message: string,
): StorageFailure {
  return { key, stage, message };
}

/** Cap a stream at `limit` bytes, erroring out rather than storing an overrun. */
export function limitStream(
  source: ReadableStream<Uint8Array>,
  limit: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`upload exceeded ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return source.pipeThrough(guard);
}
