/** Minimal fetch helpers the dashboard store depends on. */

export interface RequestOptions {
  retries: number;
  timeoutMs: number;
}

export const defaultRequestOptions: RequestOptions = { retries: 2, timeoutMs: 5_000 };

/** Build a query string from a plain record, skipping empty values. */
export function toQueryString(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Join a base path and a resource path without doubling the separator. */
export function joinPath(base: string, resource: string): string {
  if (base.endsWith('/') && resource.startsWith('/')) return base + resource.slice(1);
  if (!base.endsWith('/') && !resource.startsWith('/')) return `${base}/${resource}`;
  return base + resource;
}
