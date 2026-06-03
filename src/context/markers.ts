/**
 * Stable sentinel strings shared between the context builder (which emits them
 * into its markdown) and the MCP layer (which detects them to adjust framing).
 *
 * Intentionally a dependency-free leaf module: the MCP tool layer imports this
 * to recognise a low-confidence response, and routing that recognition through
 * the full context module would drag its dependencies onto the cold-start path.
 * Keep this file import-free.
 */

/**
 * Heading that leads the honest low-confidence handoff appended to a context
 * response when the query resolved only to weak/isolated matches. The MCP layer
 * checks for it to suppress the contradictory "this is comprehensive, don't call
 * explore" small-repo footer. Changing the text is a breaking sentinel change —
 * both the emitter (`ContextBuilder`) and the detector (`src/mcp/tools.ts`)
 * import this constant, so they stay in sync automatically.
 */
export const LOW_CONFIDENCE_MARKER = '### ⚠️ Low-confidence match';
