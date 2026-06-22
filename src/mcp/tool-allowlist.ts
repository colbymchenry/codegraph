/**
 * MCP tool allowlist parsing.
 *
 * CODEGRAPH_MCP_TOOLS accepts comma-separated short tool names. Presets expand
 * to short names too, so the rest of the MCP layer handles one simple Set.
 */

export const DEFAULT_MCP_TOOL_NAMES = Object.freeze([
  'explore',
]);

export const COMPACT_MCP_TOOL_NAMES = Object.freeze([
  'explore',
  'node',
  'search',
]);

export const CORE_MCP_TOOL_NAMES = Object.freeze([
  'explore',
  'node',
  'search',
  'callers',
]);

export function normalizeMcpToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^codegraph_/, '');
}

export function parseMcpToolAllowlist(
  raw: string | undefined,
  allToolNames: Iterable<string>,
): Set<string> | null {
  if (!raw || !raw.trim()) return null;

  const all = [...allToolNames].map(normalizeMcpToolName);
  const out = new Set<string>();

  for (const token of raw.split(',').map(normalizeMcpToolName).filter(Boolean)) {
    if (token === 'default') {
      DEFAULT_MCP_TOOL_NAMES.forEach((name) => out.add(name));
    } else if (token === 'compact') {
      COMPACT_MCP_TOOL_NAMES.forEach((name) => out.add(name));
    } else if (token === 'core') {
      CORE_MCP_TOOL_NAMES.forEach((name) => out.add(name));
    } else if (token === 'full') {
      all.forEach((name) => out.add(name));
    } else {
      out.add(token);
    }
  }

  return out.size > 0 ? out : null;
}
