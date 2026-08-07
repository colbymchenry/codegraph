/**
 * Shared shapes for the storage layer. Declaration-only like the ambient files
 * under `types/` — but the modules that answer a flow question are typed BY it,
 * so it is part of that answer's structure rather than a global shim.
 */

export interface UploadTelemetry {
  key: string;
  bytes: number;
  durationMs: number;
  retries: number;
}

export interface StorageFailure {
  key: string;
  stage: 'parse' | 'stream' | 'metadata' | 'queue';
  message: string;
}
