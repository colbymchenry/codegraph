/**
 * Our tool names the way OpenCode lists them (#1267).
 *
 * OpenCode registers a direct MCP tool as `<server key>_<tool name>`. With the
 * server under the key `codegraph`, which is what `codegraph install` writes,
 * its model sees `codegraph_explore` as `codegraph_codegraph_explore`. Our
 * `initialize` instructions, which OpenCode passes to the model, and the
 * instructions file the installer writes both said `codegraph_explore`: a tool
 * that doesn't exist there, so the model called it and got "unavailable tool".
 * Renaming the tools would break the names every other agent uses (#284), so
 * what we say to OpenCode names them its way instead.
 *
 * No imports: the installer builds OpenCode's instructions block with this,
 * and must not load the MCP server to do it.
 */

/** The key `codegraph install` registers the server under in OpenCode's config. */
export const OPENCODE_SERVER_KEY = 'codegraph';

/**
 * Whether an `initialize` request's `clientInfo.name` is OpenCode's. OpenCode
 * identifies itself as `opencode`; the match ignores case.
 */
export function isOpenCodeClient(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === 'opencode';
}

/** A tool's name as OpenCode lists it: `codegraph_explore` → `codegraph_codegraph_explore`. */
export function openCodeToolName(tool: string): string {
  return `${OPENCODE_SERVER_KEY}_${tool}`;
}

/**
 * `text` with each of `toolNames` written as OpenCode lists it. Only a whole
 * name is rewritten, never one inside a longer identifier: a name rewritten
 * already stays as it is, and `CODEGRAPH_*` variables and the
 * `codegraph explore` command never match.
 */
export function withOpenCodeToolNames(text: string, toolNames: readonly string[]): string {
  if (toolNames.length === 0) return text;
  const alternatives = [...toolNames]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const wholeName = new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`, 'g');
  return text.replace(wholeName, (name) => openCodeToolName(name));
}
