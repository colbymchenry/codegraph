/**
 * The request the Claude Code prompt hook sends a running daemon instead of
 * running its own explore (#3284), in a module of its own so the hook can name
 * it without loading the MCP server (`./session` and `./proxy` pull in the
 * whole tool layer, a tenth of a second per prompt).
 *
 * Not an MCP method: the hook is no agent, so its explore claims no
 * once-per-client warning, joins no client's explore history and counts as no
 * tool call. See `./hook-client` and `MCPSession`.
 */
export const PROMPT_EXPLORE_METHOD = 'codegraph/promptExplore';

/**
 * The daemon's answer to {@link PROMPT_EXPLORE_METHOD} when it cannot start the
 * explore at once (see `ExecuteOptions.startNow`): the hook then runs its own.
 */
export const PROMPT_EXPLORE_BUSY = { busy: true } as const;
