import type { CachePolicy, URLRequest } from './types';

export function buildURLRequest(options: {
  url: string;
  method: string;
  body?: Uint8Array;
  headers: Record<string, string>;
  timeout: number;
  cachePolicy: CachePolicy;
}): URLRequest {
  const headers = { ...options.headers };
  if (options.body && !headers['content-length']) {
    headers['content-length'] = String(options.body.length);
  }
  return {
    url: normalize(options.url),
    method: options.method.toUpperCase(),
    headers,
    body: options.body,
    timeout: options.timeout,
    cachePolicy: options.cachePolicy,
  };
}

function normalize(url: string): string {
  return url.endsWith('/') && url.split('/').length > 4 ? url.slice(0, -1) : url;
}
