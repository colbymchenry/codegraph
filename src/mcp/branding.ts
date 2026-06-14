import { CodeGraphPackageVersion } from './version';

/**
 * Shared MCP branding metadata for server and tool-list surfaces.
 */
const SERVER_ICON_BASE64 =
  'PHN2ZyBmaWxsPSJub25lIiBzdHJva2U9IiMxNjE1MGYiIHN0cm9rZS13aWR0aD0iMiIgdmlld0JveD0iMCAwIDMyIDMyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxsaW5lIHgxPSIxNiIgeDI9IjgiIHkxPSI4IiB5Mj0iMjMiLz48bGluZSB4MT0iMTYiIHgyPSIyNCIgeTE9IjgiIHkyPSIyMyIvPjxsaW5lIHgxPSI4IiB4Mj0iMjQiIHkxPSIyMyIgeTI9IjIzIi8+PGNpcmNsZSBjeD0iMTYiIGN5PSI4IiByPSIzLjQiIGZpbGw9IiMxNjE1MGYiLz48Y2lyY2xlIGN4PSI4IiBjeT0iMjMiIHI9IjMuNCIgZmlsbD0iI2Y3ZjZmMiIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMjMiIHI9IjMuNCIgZmlsbD0iI2Y3ZjZmMiIvPjwvc3ZnPg==';

export const SERVER_ICON = {
  src: `data:image/svg+xml;base64,${SERVER_ICON_BASE64}`,
  mimeType: 'image/svg+xml',
  sizes: '32x32',
} as const;

export const SERVER_INFO = {
  name: 'codegraph',
  title: 'CodeGraph',
  version: CodeGraphPackageVersion,
  icons: [SERVER_ICON],
} as const;

export const SERVER_META = {
  icons: [SERVER_ICON],
} as const;
