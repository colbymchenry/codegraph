export interface BucketObject {
  key: string;
  body: ReadableStream<Uint8Array>;
  size: number;
}

export interface Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void>;
  get(key: string): Promise<BucketObject | null>;
}

export interface MetadataStore {
  put(id: string, value: string): Promise<void>;
  get(id: string): Promise<string | null>;
}

const objects = new Map<string, BucketObject>();
const rows = new Map<string, string>();

/** The object-storage binding. */
export function openBucket(): Bucket {
  return {
    async put(key, value) {
      objects.set(key, { key, body: value, size: 0 });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
  };
}

/** The metadata key-value binding. */
export function openMetadataStore(): MetadataStore {
  return {
    async put(id, value) {
      rows.set(id, value);
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
  };
}
