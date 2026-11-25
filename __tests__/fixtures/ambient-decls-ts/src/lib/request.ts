export interface ParsedUpload {
  ok: true;
  key: string;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  width: number;
  height: number;
  format: string;
}

export interface ParseFailure {
  ok: false;
  error: string;
}

/**
 * Pull the object key, declared dimensions and the raw body stream off an
 * upload request. Never buffers the body — the stream is handed straight to
 * the storage layer.
 */
export async function parseUploadRequest(
  request: Request,
): Promise<ParsedUpload | ParseFailure> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return { ok: false, error: 'missing key' };
  if (!request.body) return { ok: false, error: 'missing body' };

  return {
    ok: true,
    key,
    body: request.body as ReadableStream<Uint8Array>,
    contentType: request.headers.get('content-type') ?? 'application/octet-stream',
    width: numberParam(url, 'width'),
    height: numberParam(url, 'height'),
    format: url.searchParams.get('format') ?? 'jpeg',
  };
}

function numberParam(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
