/**
 * CLAUDE.md template for CodeGraph instructions
 *
 * This template is injected into ~/.claude/CLAUDE.md (global) or ./.claude/CLAUDE.md (local)
 * Keep this in sync with the README.md "Recommended: Add Global Instructions" section
 */

// Markers to identify CodeGraph section for updates
export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

export const CLAUDE_MD_TEMPLATE = `${CODEGRAPH_SECTION_START}
## CodeGraph

CodeGraph builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If \`.codegraph/\` exists in the project

**NEVER call \`codegraph_explore\` or \`codegraph_context\` directly in the main session.** These tools return large amounts of source code that fills up main session context. Instead, ALWAYS spawn an Explore agent for any exploration question (e.g., "how does X work?", "explain the Y system", "where is Z implemented?").

**When spawning Explore agents**, include this instruction in the prompt:

> This project has CodeGraph initialized (.codegraph/ exists). Use \`codegraph_explore\` as your PRIMARY tool — it returns full source code sections from all relevant files in one call.
>
> **Rules:**
> 1. Follow the explore call budget in the \`codegraph_explore\` tool description — it scales automatically based on project size.
> 2. Do NOT re-read files that codegraph_explore already returned source code for. The source sections are complete and authoritative.
> 3. Only fall back to grep/glob/read for files listed under "Additional relevant files" if you need more detail, or if codegraph returned no results.

**The main session may only use these lightweight tools directly** (for targeted lookups before making edits, not for exploration):

| Tool | Use For |
|------|---------|
| \`codegraph_search\` | Find symbols by name |
| \`codegraph_callers\` / \`codegraph_callees\` | Trace call flow |
| \`codegraph_impact\` | Check what's affected before editing |
| \`codegraph_node\` | Get a single symbol's details |

### If \`.codegraph/\` does NOT exist

At the start of a session, ask the user if they'd like to initialize CodeGraph:

"I notice this project doesn't have CodeGraph initialized. Would you like me to run \`codegraph init -i\` to build a code knowledge graph?"
${CODEGRAPH_SECTION_END}`;
