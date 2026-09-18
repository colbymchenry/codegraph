/** The zero-config grouping limit, retained for existing projects and adapters. */
export const DEFAULT_MAP_MAX_DEPTH = 4;

/** Highest grouping limit accepted from a project's `codegraph.json`. */
export const MAX_MAP_MAX_DEPTH = 32;

export interface MapScope {
  readonly label: string;
  readonly root: string;
}

export interface ViewerMapConfig {
  readonly maxDepth: number;
  readonly scopes: readonly MapScope[];
}

/** Normalize a map root without resolving it against the filesystem. */
export function normalizeMapRoot(raw: string | undefined): string {
  let root = (raw ?? '').trim().replace(/\\/g, '/');
  while (root.startsWith('./')) root = root.slice(2);
  while (root.endsWith('/')) root = root.slice(0, -1);
  return root === '.' || root === '/' ? '' : root;
}
