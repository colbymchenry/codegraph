/**
 * pi agent target.
 *
 * pi (https://pi.dev) is a minimal terminal coding harness that reads
 * `AGENTS.md` (or `CLAUDE.md`) from `~/.pi/agent/AGENTS.md` (global)
 * and from parent directories / current directory (local). It does NOT
 * natively support MCP servers — the "No MCP" design philosophy means
 * there is no MCP-server config to write.
 *
 * What we DO write:
 *
 *   - Instructions block with codegraph CLI usage guidance to
 *     `~/.pi/agent/AGENTS.md` (global) or `./AGENTS.md` (local).
 *     These instructions tell the pi agent to invoke codegraph via
 *     the CLI (`codegraph search`, `codegraph trace`, etc.) inline
 *     with pi's tool-use model.
 *   - No permissions / auto-allow concept — pi has none.
 *   - No MCP server config — pi doesn't support it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  removeMarkedSection,
  replaceOrAppendMarkedSection,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

/**
 * pi-specific instructions template.
 *
 * Since pi does not support MCP, codegraph tools are not available as
 * typed tool calls. Instead, the agent invokes codegraph via its CLI
 * using pi's `bash` tool. The guidance below mirrors
 * `src/installer/instructions-template.ts` but adapted for CLI usage,
 * and includes a note about the MCP-gap extension workaround.
 */
export const PI_INSTRUCTIONS_TEMPLATE = `${CODEGRAPH_SECTION_START}
## CodeGraph

This project has a CodeGraph knowledge graph index (\`.codegraph/\`). CodeGraph is a tree-sitter-parsed database of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

> **Note:** pi does not natively support MCP servers, so codegraph's tools are not available as built-in tool calls. Use the \`codegraph\` CLI via \`bash\` as shown below. If you want MCP-backed tool access, install a pi extension that adds MCP support.

### CLI usage reference

| Question | Command |
|---|---|
| "Find a symbol by name" | \`codegraph search <name>\` |
| "Find callers of a function" | \`codegraph callers <symbol>\` |
| "Find callees a function calls" | \`codegraph callees <symbol>\` |
| "Trace flow from X to Y" | \`codegraph trace <from> <to>\` |
| "Impact analysis for symbol Z" | \`codegraph affected <symbol>\` |
| "Show a symbol's source location" | \`codegraph query 'select ...'\` or callers/callees |
| "What files exist under path/" | \`codegraph files <path>\` |
| "Full-text search in indexed code" | \`codegraph search --fts <query>\` |
| "Build context for a task" | \`codegraph context <topic>\` |
| "Is the index healthy?" | \`codegraph status\` |

### Rules of thumb

- **Use codegraph first** for structural questions (definitions, callers, callees, trace flows). It's faster and more accurate than grep.
- **Trust codegraph results** — they come from a full AST parse. Do NOT re-verify with grep.
- **When tracing a flow**, use \`codegraph trace <from> <to>\` — one call returns the whole path with dynamic hops bridged (callbacks, React re-render, JSX).
- **Index lag**: the file watcher debounces ~500ms behind writes. If you get stale results, run \`codegraph sync\` first, or check \`codegraph status\` for pending files.

### If \`.codegraph/\` doesn't exist

Run \`codegraph init -i\` to build the index.
${CODEGRAPH_SECTION_END}`;

function piAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir && envDir.trim().length > 0) {
    return path.resolve(envDir.trim());
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? piAgentDir() : process.cwd();
}

function agentsMdPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'pi';
  readonly docsUrl = 'https://pi.dev';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = agentsMdPath(loc);
    // "Installed" means pi's agent directory exists (for global) or
    // pi is available on the system (local). The existence of
    // `~/.pi/agent/` is the signal for pi being present globally;
    // for local we also check the pi binary to avoid false positives
    // in `--target=auto` on systems without pi installed.
    const piOnSystem = fs.existsSync(path.join(os.homedir(), '.pi'));
    const installed = loc === 'global'
      ? fs.existsSync(piAgentDir())
      : piOnSystem;
    const alreadyConfigured = hasCodeGraphSection(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeInstructionsEntry(loc));
    return {
      files,
      notes: ['Start a new pi session for instructions to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const instr = agentsMdPath(loc);
    const action = removeMarkedSection(
      instr,
      CODEGRAPH_SECTION_START,
      CODEGRAPH_SECTION_END,
    );
    files.push({ path: instr, action });
    return { files };
  }

  printConfig(loc: Location): string {
    const target = agentsMdPath(loc);
    return `# Add to ${target}\n\n${PI_INSTRUCTIONS_TEMPLATE}`;
  }

  describePaths(loc: Location): string[] {
    return [agentsMdPath(loc)];
  }
}

/**
 * Check whether the AGENTS.md file already contains our codegraph
 * section (by marker presence).
 */
function hasCodeGraphSection(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const content = fs.readFileSync(file, 'utf-8');
    return content.includes(CODEGRAPH_SECTION_START);
  } catch {
    return false;
  }
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = agentsMdPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Migrate an unmarked `## CodeGraph` section (e.g. from a manual
  // paste before markers existed) into the marker-delimited format.
  // Without this, a bare heading would cause detection to miss
  // alreadyConfigured and install would append a duplicate section.
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes(CODEGRAPH_SECTION_START)) {
      const headerMatch = content.match(/\n## CodeGraph\n/);
      if (headerMatch && headerMatch.index !== undefined) {
        const sectionStart = headerMatch.index;
        const after = content.substring(sectionStart + 1);
        const nextHeader = after.match(/\n## (?!#)/);
        const sectionEnd = nextHeader && nextHeader.index !== undefined
          ? sectionStart + 1 + nextHeader.index
          : content.length;
        const merged =
          content.substring(0, sectionStart) +
          '\n' + PI_INSTRUCTIONS_TEMPLATE +
          content.substring(sectionEnd);
        fs.writeFileSync(file, merged, 'utf-8');
        return { path: file, action: 'updated' };
      }
    }
  }

  const action = replaceOrAppendMarkedSection(
    file,
    PI_INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );

  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

export const piTarget: AgentTarget = new PiTarget();