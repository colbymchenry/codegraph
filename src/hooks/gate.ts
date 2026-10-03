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

const SHELL_KEYWORD = /^(do|then|else|elif|time|!|\{|\()$/;

/**
 * Words of each `&&` / `||` / `;` / newline segment, head basename-lowercased.
 * Leading shell keywords are dropped (`do grep` is a grep). Pipes stay in their segment.
 */
function commandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      while (words.length > 0 && SHELL_KEYWORD.test(words[0]!)) words.shift();
      return words;
    })
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

const unquote = (word: string) => word.replace(/^['"]|['"]$/g, '');

/** Resolves a shell path word against `dir`: expands `~`, and on Windows reads Git Bash's `/c/x` as `C:/x`. */
function localPath(word: string, dir: string): string {
  let p = unquote(word);
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (process.platform === 'win32') p = p.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');
  return path.resolve(dir, p);
}

/**
 * Paths one search command reads: its non-option operands up to a pipe or
 * redirection, skipping exclusion-option values. grep-likes and fd take the
 * pattern first; find takes paths first. No path operand means `dir`.
 */
function searchPaths([head, ...args]: string[], dir: string): string[] {
  const isFind = head!.replace(/\.exe$/, '') === 'find';
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '|' || /^\d*[<>]/.test(arg) || (isFind && /^[-(!]/.test(arg))) break;
    if (arg.startsWith('-') || EXCLUSION_OPTION.test(args[i - 1] ?? '')) continue;
    operands.push(arg);
  }
  const paths = (isFind ? operands : operands.slice(1)).filter((p) => !p.includes('$'));
  return paths.length > 0 ? paths.map((p) => localPath(p, dir)) : [dir];
}

/**
 * True when any path a search reads sits inside an indexed project. Paths in
 * node_modules don't count: the index does not cover vendored deps.
 */
function readsIndexedCode(paths: string[]): boolean {
  return paths.some((p) => !NODE_MODULES.test(p) && isIndexed(p));
}

/**
 * True when a Bash command text-searches an indexed project. `cd` is followed
 * across segments, so `cd /tmp && grep x log` or `grep -c FAIL /tmp/out.log`
 * run from an indexed repo are not gated: CodeGraph can't answer them.
 */
export function bashSearchIsGated(command: string, cwd: string): boolean {
  let dir = cwd;
  for (const words of commandSegments(command)) {
    if (words[0] === 'cd') dir = localPath(words[1] ?? '~', dir);
    else if (SEARCH_COMMAND.test(words[0]!) && readsIndexedCode(searchPaths(words, dir))) return true;
  }
  return false;
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
    // Only searches that read inside an indexed project are gated.
    const cwd = payload.cwd || process.cwd();
    const gated =
      tool === 'Grep' || tool === 'Glob'
        ? readsIndexedCode([localPath(typeof input.path === 'string' && input.path ? input.path : '.', cwd)])
        : tool === 'Bash' && bashSearchIsGated(command, cwd);
    if (!gated) return null;

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
