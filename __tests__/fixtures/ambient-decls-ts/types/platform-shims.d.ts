// Hand-maintained ambient declarations for the parts of the platform our
// runtime exposes but the published typings do not cover yet. Edit freely —
// nothing regenerates this file. Kept alongside the app so module augmentation
// and the global shims live in one place.

declare global {
  interface UploadStorage {
    put(
      key: string,
      body: ReadableStream<Uint8Array>,
      options?: UploadPutOptions,
    ): Promise<StoredUploadObject>;
    get(key: string): Promise<StoredUploadObject | null>;
    head(key: string): Promise<StoredUploadHead | null>;
    delete(key: string | string[]): Promise<void>;
    list(options?: UploadListOptions): Promise<UploadListResult>;
  }

  interface StoredUploadObject {
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly uploaded: Date;
    readonly body: ReadableStream<Uint8Array>;
    readonly contentType: string;
    readonly metadata?: ImageMetadataShim;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    json<T>(): Promise<T>;
  }

  interface StoredUploadHead {
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly uploaded: Date;
    readonly contentType: string;
  }

  interface UploadPutOptions {
    contentType?: string;
    cacheControl?: string;
    customMetadata?: Record<string, string>;
    checksum?: string;
    storageClass?: 'standard' | 'infrequent';
  }

  interface UploadListOptions {
    prefix?: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
    include?: ('metadata' | 'contentType')[];
  }

  interface UploadListResult {
    objects: StoredUploadHead[];
    truncated: boolean;
    cursor?: string;
    prefixes: string[];
  }

  interface ImageMetadataShim {
    format: string;
    fileSize: number;
    width: number;
    height: number;
    orientation?: number;
    colorSpace?: string;
  }

  interface MetadataRowShim {
    id: string;
    key: string;
    recordedAt: number;
    format: string;
    bytes: number;
    width: number;
    height: number;
  }

  interface MetadataStoreShim {
    put(id: string, value: string, options?: MetadataPutOptions): Promise<void>;
    get(id: string): Promise<string | null>;
    getWithMetadata<T>(id: string): Promise<{ value: string | null; metadata: T | null }>;
    delete(id: string): Promise<void>;
    list(options?: MetadataListOptions): Promise<MetadataListResult>;
  }

  interface MetadataPutOptions {
    expiration?: number;
    expirationTtl?: number;
    metadata?: unknown;
  }

  interface MetadataListOptions {
    prefix?: string | null;
    cursor?: string | null;
    limit?: number;
  }

  interface MetadataListResult {
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }

  interface UploadQueueShim<Body = unknown> {
    send(body: Body, options?: UploadSendOptions): Promise<void>;
    sendBatch(bodies: Iterable<UploadSendRequest<Body>>): Promise<void>;
  }

  interface UploadSendOptions {
    contentType?: UploadContentType;
    delaySeconds?: number;
  }

  type UploadContentType = 'text' | 'bytes' | 'json' | 'v8';

  interface UploadSendRequest<Body = unknown> {
    body: Body;
    options?: UploadSendOptions;
  }

  interface UploadMessageShim<Body = unknown> {
    readonly id: string;
    readonly timestamp: Date;
    readonly body: Body;
    readonly attempts: number;
    retry(options?: UploadRetryOptions): void;
    ack(): void;
  }

  interface UploadRetryOptions {
    delaySeconds?: number;
  }

  interface UploadMessageBatch<Body = unknown> {
    readonly messages: readonly UploadMessageShim<Body>[];
    readonly queue: string;
    retryAll(options?: UploadRetryOptions): void;
    ackAll(): void;
  }

  interface StreamPipeOptionsShim {
    preventClose?: boolean;
    preventAbort?: boolean;
    preventCancel?: boolean;
    signal?: AbortSignal;
  }

  interface ByteCounterShim {
    readonly transform: TransformStream<Uint8Array, Uint8Array>;
    total(): number;
  }

  interface StreamLimitShim {
    readonly limit: number;
    readonly seen: number;
    exceeded(): boolean;
  }

  interface RequestBodyShim {
    readonly body: ReadableStream<Uint8Array> | null;
    readonly bodyUsed: boolean;
    readonly headers: Headers;
    readonly url: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    formData(): Promise<FormData>;
    blob(): Promise<Blob>;
  }

  interface ParsedUploadShim {
    key: string;
    contentType: string;
    width: number;
    height: number;
    format: string;
  }

  interface ImageTransformerShim {
    transform(transform: ImageTransformShim): ImageTransformerShim;
    output(options: ImageOutputShim): Promise<ImageResultShim>;
  }

  interface ImageTransformShim {
    width?: number;
    height?: number;
    fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
    rotate?: number;
  }

  interface ImageOutputShim {
    format?: string;
    quality?: number;
    background?: string;
  }

  interface ImageResultShim {
    contentType(): string;
    image(): ReadableStream<Uint8Array>;
    response(): Response;
  }

  interface UploadEnvShim {
    UPLOADS: UploadStorage;
    METADATA: MetadataStoreShim;
    UPLOAD_QUEUE: UploadQueueShim<unknown>;
  }
}

export {};
