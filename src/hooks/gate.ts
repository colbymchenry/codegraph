/**
 * "CodeGraph first" gate — the logic behind the hidden `codegraph gate-hook`
 * command, an opt-in Claude Code hook.
 *
 * In an indexed project, text search (Grep, Glob, or rg/grep/find/fd run via
 * Bash) is denied until the session has made one CodeGraph query; after that
 * it is allowed again for literals and non-code files. PostToolUse /
 * PostToolUseFailure events record that query as a per-session marker file.
 *
 * LOAD-BEARING: a hook must never break the session. `runGateHook` swallows
 * every error and returns null ("allow, no output").
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findNearestCodeGraphRoot } from '../directory';

const SEARCH_COMMAND = /^(rg|grep|egrep|fgrep|find|fd|ag|ack)(\.exe)?$/;
const CODEGRAPH_SUBCOMMAND = /^(explore|query|node|files|context|callers|callees|impact|affected|status)$/;

// Kept short: a deny reason lands in the model's context.
const DENY_REASON =
  'CodeGraph index present: call codegraph_explore (or `codegraph explore|query|node`) first; Grep/Glob unlock after, for literals and non-code files.';

interface GatePayload {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string; path?: string; pattern?: string };
}

/** First word of each `&&` / `||` / `;` segment, basename-lowercased. Pipes stay in their segment. */
function commandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0)
    .map(([head, ...rest]) => [head!.split(/[\\/]/).pop()!.toLowerCase(), ...rest]);
}

/** True when a Bash command's search head is rg/grep/find/fd (not a pipe target like `test | grep`). */
export function isSearchHead(command: string): boolean {
  return commandSegments(command).some(([head]) => SEARCH_COMMAND.test(head!));
}

const NODE_MODULES = /(^|[\\/])node_modules([\\/]|$)/;
// Options whose value names what to skip, not where to search (`--exclude-dir node_modules`, `-g '!node_modules'`).
const EXCLUSION_OPTION = /^(--?(exclude|ignore)[\w-]*|-g|--glob|--iglob)$/;

/** True when the search targets a path inside node_modules (the index does not cover vendored deps). */
function searchesNodeModules(command: string): boolean {
  return commandSegments(command).some(([head, ...args]) => {
    if (!SEARCH_COMMAND.test(head!)) return false;
    return args.some((arg, i) => {
      if (arg.startsWith('-') || EXCLUSION_OPTION.test(args[i - 1] ?? '')) return false;
      return NODE_MODULES.test(arg.replace(/^['"]|['"]$/g, ''));
    });
  });
}

/** True when a Bash command runs a `codegraph <query-ish subcommand>`. */
export function isCodegraphCommand(command: string): boolean {
  return commandSegments(command).some(
    ([head, sub]) => (head === 'codegraph' || head === 'codegraph.cmd') && CODEGRAPH_SUBCOMMAND.test(sub ?? ''),
  );
}

/** Whether `start` (a file or directory) sits inside an indexed CodeGraph project. */
export function isIndexed(start: string): boolean {
  return findNearestCodeGraphRoot(start) !== null;
}

function markerPath(payload: GatePayload, env: NodeJS.ProcessEnv): string {
  const dir = env.CODEGRAPH_GATE_DIR || path.join(os.tmpdir(), 'codegraph-gate');
  const key = `${payload.session_id ?? 'none'}-${payload.agent_id ?? 'main'}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(dir, key);
}

/**
 * Process one hook payload; returns the stdout to print (a PreToolUse deny
 * JSON) or null to allow silently.
 */
export function runGateHook(raw: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (env.CODEGRAPH_NO_GATE_HOOK === '1') return null;
    const payload = JSON.parse(raw) as GatePayload;
    const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
    if (!tool) return null;
    const input = payload.tool_input ?? {};
    const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : '';
    const isQuery = /codegraph/i.test(tool) || isCodegraphCommand(command);
    const marker = markerPath(payload, env);

    if (String(payload.hook_event_name ?? '').startsWith('PostToolUse')) {
      if (isQuery) {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.closeSync(fs.openSync(marker, 'w'));
      }
      return null;
    }

    if (isQuery || fs.existsSync(marker)) return null;
    const isSearch = tool === 'Grep' || tool === 'Glob' || (tool === 'Bash' && isSearchHead(command));
    if (!isSearch) return null;
    // Vendored dependency trees are not what the index is for: allow searches whose target is inside node_modules.
    if ((typeof input.path === 'string' && NODE_MODULES.test(input.path)) || searchesNodeModules(command)) {
      return null;
    }
    if (!isIndexed(input.path || payload.cwd || process.cwd())) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    });
  } catch {
    return null;
  }
}
