import type { Node as SyntaxNode } from 'web-tree-sitter';
import * as posix from 'node:path/posix';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

interface CwdState {
  cwdChanged: boolean;
  pathPrepends: string[];
}

const cwdStates = new WeakMap<object, CwdState>();

function stateFor(ctx: ExtractorContext): CwdState {
  // ctx itself is rebuilt per visited node; the live nodes array is the
  // identity that persists across one file's whole extraction.
  const fileKey = ctx.nodes as unknown as object;
  let st = cwdStates.get(fileKey);
  if (!st) {
    st = { cwdChanged: false, pathPrepends: [] };
    cwdStates.set(fileKey, st);
  }
  return st;
}

function commandWord(node: SyntaxNode, source: string): string | null {
  const nameNode = node.childForFieldName('name');
  const word = nameNode?.child(0);
  return word ? getNodeText(word, source).trim() : null;
}

function declarationBuiltin(node: SyntaxNode, source: string): string | null {
  const keyword = node.child(0);
  if (!keyword) return null;
  const text = getNodeText(keyword, source);
  return text === 'export' || text === 'readonly' || text === 'declare' || text === 'typeset' || text === 'local'
    ? text
    : null;
}

/** `declare -g` / `typeset -g` assigns in the global scope even inside a function. */
function carriesGlobalFlag(node: SyntaxNode, source: string): boolean {
  for (let i = 1; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) break;
    if (child.type === 'word' && /^-[a-zA-Z]*g/.test(getNodeText(child, source))) return true;
    if (child.type === 'variable_assignment') break;
  }
  return false;
}

function carriesReadonlyFlag(node: SyntaxNode, source: string): boolean {
  for (let i = 1; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) break;
    if (child.type === 'word' && /^-[a-zA-Z]*r/.test(getNodeText(child, source))) return true;
    if (child.type === 'variable_assignment') break;
  }
  return false;
}

function hasFunctionAncestor(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'function_definition') return true;
    current = current.parent;
  }
  return false;
}

export interface BashVariable {
  name: string;
  kind: 'variable' | 'constant';
  valueNode: SyntaxNode | null;
  positionNode: SyntaxNode;
}

/** Variables and constants from an assignment or declaration command; empty when suppressed. */
export function extractBashVariables(node: SyntaxNode, source: string): BashVariable[] {
  if (node.type === 'variable_assignment') {
    if (hasFunctionAncestor(node)) return [];
    const parent = node.parent?.type === 'command' ? node.parent : null;
    const nameNode = node.childForFieldName('name');
    if (!nameNode || parent) return [];
    return [{
      name: getNodeText(nameNode, source),
      kind: 'variable',
      valueNode: node.childForFieldName('value'),
      positionNode: nameNode,
    }];
  }

  const builtin = declarationBuiltin(node, source);
  if (!builtin || builtin === 'local') return [];

  // Inside a function, `declare` without `-g` creates a FUNCTION-LOCAL variable
  // — verified by execution: `f() { declare X=1; }; f` leaves X unset, exactly
  // like `local`. So it is suppressed for the same reason `local` is, and for
  // the reason no other language in the index emits function-local variables at
  // all (TypeScript, Python and Go each emit only top-level ones). `readonly`
  // and `export` are NOT suppressed: both assign in the global scope even when
  // written inside a function, as does `declare -g`.
  if (hasFunctionAncestor(node) && (builtin === 'declare' || builtin === 'typeset') && !carriesGlobalFlag(node, source)) {
    return [];
  }

  const kind: 'variable' | 'constant' =
    builtin === 'readonly' || carriesReadonlyFlag(node, source) ? 'constant' : 'variable';

  return node.namedChildren
    .filter((c) => c.type === 'variable_assignment')
    .map((assignment) => {
      const nameNode = assignment.childForFieldName('name');
      return nameNode
        ? {
            name: getNodeText(nameNode, source),
            kind,
            valueNode: assignment.childForFieldName('value'),
            positionNode: nameNode,
          }
        : null;
    })
    .filter((v): v is BashVariable => v !== null);
}

// --- script path resolution -------------------------------------------------

const OWN_PROCESS_TYPES = new Set(['command_substitution', 'subshell', 'pipeline']);
const SUPPRESSED_ASSIGNMENT_ANCESTORS = new Set([
  ...OWN_PROCESS_TYPES,
  'if_statement',
  'while_statement',
  'until_statement',
  'for_statement',
  'case_statement',
  'function_definition',
]);
const MAX_TRACE_DEPTH = 8;
const ROOT_ANCHOR_NAMES = new Set(['REPO_ROOT', 'PROJECT_ROOT', 'WORKSPACE_ROOT', 'CODEGRAPH_ROOT']);

function programRoot(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function runsInOwnProcess(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (OWN_PROCESS_TYPES.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

function isArgumentZeroExpansion(node: SyntaxNode, source: string): boolean {
  if (node.type === 'simple_expansion' || node.type === 'expansion') {
    const inner = expansionNameNode(node);
    if (!inner || inner.type !== 'variable_name') return false;
    const name = getNodeText(inner, source);
    return name === '0' || name === 'BASH_SOURCE';
  }
  return false;
}

/** The variable a simple_expansion/expansion reads: a variable_name, possibly under a subscript. */
function expansionNameNode(node: SyntaxNode): SyntaxNode | null {
  const first = node.namedChild(0);
  if (!first) return null;
  if (first.type === 'variable_name') return first;
  if (first.type === 'subscript') {
    return first.childForFieldName('name') ?? first.namedChild(0);
  }
  return null;
}

/** `${VAR%/*}`-style dirname-by-suffix-removal over an own-directory anchor. */
function isOwnDirectoryRemoval(node: SyntaxNode, source: string): boolean {
  if (node.type !== 'expansion') return false;
  if (!isArgumentZeroExpansion(node, source)) return false;
  const regex = node.namedChildren.find((c) => c.type === 'regex');
  if (!regex) return false;
  const text = getNodeText(regex, source);
  return text.endsWith('/*') && !text.includes('#');
}

function matchDirnameSubstitution(node: SyntaxNode, source: string): boolean {
  if (node.type !== 'command_substitution') return false;
  const body = node.namedChild(0);
  const cmd =
    body?.type === 'command'
      ? body
      : body?.type === 'list'
        ? (body.namedChildren.length === 1 && body.namedChild(0)?.type === 'command'
          ? body.namedChild(0)
          : null)
        : null;
  if (!cmd || commandWord(cmd, source) !== 'dirname') return false;

  let sawAnchor = false;
  for (let i = 0; i < cmd.namedChildCount; i++) {
    const child = cmd.namedChild(i)!;
    if (child.type === 'command_name') continue;
    if (child.type === 'word' && getNodeText(child, source) === '--') continue;
    if (isArgumentZeroExpansion(child, source) && !child.namedChildren.some((c) => c.type === 'regex')) {
      sawAnchor = true;
      continue;
    }
    if (child.type === 'string') {
      const exprs = child.namedChildren.filter((c) => c.type !== 'string_content');
      const content = child.namedChildren.filter((c) => c.type === 'string_content').map((c) => getNodeText(c, source)).join('');
      if (
        exprs.length === 1 &&
        isArgumentZeroExpansion(exprs[0]!, source) &&
        !exprs[0]!.namedChildren.some((c) => c.type === 'regex') &&
        content.trim() === ''
      ) {
        sawAnchor = true;
        continue;
      }
    }
    return false;
  }
  return sawAnchor;
}

/**
 * `$(cd <expr> && pwd)` resolves to whatever its inner expression resolves
 * to — usually an own-directory anchor, but anchored parent segments
 * (`$(cd "$(dirname "$0")/.." && pwd)`) climb deliberately.
 */
function resolveCdPrintSubstitution(
  node: SyntaxNode,
  source: string,
  rootDir: string,
  allowRelative: boolean,
  visited: Set<string>,
  depth: number
): string | null {
  if (node.type !== 'command_substitution') return null;
  const body = node.namedChild(0);
  const commands =
    body?.type === 'list'
      ? body.namedChildren.filter((c) => c.type === 'command')
      : body?.type === 'command'
        ? [body]
        : [];
  if (commands.length !== 2) return null;
  const [cd, pwd] = commands as [SyntaxNode, SyntaxNode];
  if (commandWord(cd, source) !== 'cd' || commandWord(pwd, source) !== 'pwd') return null;
  const args = cd.namedChildren.filter((c) => c.type !== 'command_name');
  if (args.length !== 1) return null;
  return composeDirectory([args[0]!], source, rootDir, allowRelative, new Set(visited), depth + 1, Number.MAX_SAFE_INTEGER);
}

function traceVariable(
  name: string,
  reference: SyntaxNode,
  source: string,
  containingDir: string,
  cutoff: number,
  visited: Set<string>,
  depth: number
): string | null {
  if (visited.has(name) || depth > MAX_TRACE_DEPTH) return null;
  visited.add(name);

  const root = programRoot(reference);
  const matches: SyntaxNode[] = [];

  const walk = (node: SyntaxNode): void => {
    if (node.type === 'variable_assignment') {
      const nameNode = node.childForFieldName('name');
      if (nameNode && getNodeText(nameNode, source) === name && node.startIndex < cutoff) {
        let suppressed = false;
        let parent = node.parent;
        while (parent && parent !== root) {
          if (SUPPRESSED_ASSIGNMENT_ANCESTORS.has(parent.type)) {
            suppressed = true;
            break;
          }
          parent = parent.parent;
        }
        if (!suppressed) matches.push(node);
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(root);

  if (matches.length === 0) return null;

  const resolveValueOf = (match: SyntaxNode): string | null => {
    const value = match.childForFieldName('value');
    // Resolving THIS assignment's value, a reference to the same name reads
    // the PREVIOUS value: cut the search off at this assignment's start.
    const innerVisited = new Set(visited);
    innerVisited.delete(name);
    return value
      ? composeDirectory([value], source, containingDir, true, innerVisited, depth + 1, match.startIndex)
      : null;
  };

  const valueRefsSelf = (match: SyntaxNode): boolean => {
    const value = match.childForFieldName('value');
    if (!value) return false;
    let found = false;
    const scan = (node: SyntaxNode): void => {
      if (found) return;
      if (node.type === 'simple_expansion' || node.type === 'expansion') {
        const n = expansionNameNode(node);
        if (n && getNodeText(n, source) === name) {
          found = true;
          return;
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) scan(child);
      }
    };
    scan(value);
    return found;
  };

  const last = matches[matches.length - 1]!;
  if (matches.length === 1 || valueRefsSelf(last)) {
    // A chained re-assignment threads the previous value deterministically.
    return resolveValueOf(last);
  }

  // Independent overwrites: every derivation must agree, or the forward
  // scan cannot tell which one ran.
  const results = new Set<string>();
  for (const match of matches) {
    const resolved = resolveValueOf(match);
    if (resolved === null) return null;
    results.add(resolved);
  }
  return results.size === 1 ? results.values().next().value! : null;
}

/**
 * Extend a partially-composed directory with literal path text ('/../lib',
 * './x', ...). Null current means no anchor yet; relative literals then
 * bottom out at rootDir when allowed, and stay unknowable otherwise.
 */
function appendLiteralText(
  current: string | null,
  text: string,
  rootDir: string,
  allowRelative: boolean
): string | null {
  if (text === '') return current;
  if (current === null && !allowRelative && !text.startsWith('/')) return null;
  let dir = current;
  if (dir === null) {
    dir = text.startsWith('/') ? '/' : rootDir;
  }
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      dir = posix.dirname(dir);
    } else {
      dir = posix.join(dir, part);
    }
  }
  return dir;
}

function isDirMaterialNode(node: SyntaxNode): boolean {
  const type = node.type;
  return (
    type === 'string_content' ||
    type === 'word' ||
    type === 'raw_string' ||
    type === 'string' ||
    type === 'concatenation' ||
    type === 'command_substitution' ||
    type === 'simple_expansion' ||
    type === 'expansion'
  );
}

/**
 * Compose a chain of expression and literal segments into an ABSOLUTE
 * directory path, or null the moment a step is not statically knowable.
 */
function composeDirectory(
  segments: SyntaxNode[],
  source: string,
  rootDir: string,
  allowRelative: boolean,
  visited: Set<string>,
  depth: number,
  cutoff: number
): string | null {
  let current: string | null = null;

  for (const segment of segments) {
    const type = segment.type;
    if (!isDirMaterialNode(segment)) continue;
    if (type === 'string_content' || type === 'word' || type === 'raw_string') {
      let text = getNodeText(segment, source);
      if (type === 'raw_string' && text.length >= 2) text = text.slice(1, -1);
      current = appendLiteralText(current, text, rootDir, allowRelative);
      if (current === null) return null;
      continue;
    }
    if (type === 'string' || type === 'concatenation') {
      const inner: SyntaxNode[] = [];
      for (let i = 0; i < segment.namedChildCount; i++) {
        const child = segment.namedChild(i);
        if (child) inner.push(child);
      }
      const composed = composeDirectory(inner, source, rootDir, current !== null || allowRelative, visited, depth, cutoff);
      if (composed === null) return null;
      current = composed;
      continue;
    }
    if (type === 'command_substitution') {
      const viaCdPrint = resolveCdPrintSubstitution(segment, source, rootDir, current !== null || allowRelative, visited, depth);
      if (viaCdPrint !== null) {
        current = viaCdPrint;
        continue;
      }
      if (matchDirnameSubstitution(segment, source) || isOwnDirectoryRemovalWrapped(segment, source)) {
        current = rootDir;
        continue;
      }
      return null;
    }
    // simple_expansion | expansion
    if (isOwnDirectoryRemoval(segment, source)) {
      current = rootDir;
      continue;
    }
    const nameNode = expansionNameNode(segment);
    if (!nameNode) return null;
    const name = getNodeText(nameNode, source);
    // These conventional repository-root variables are process/environment
    // anchors, not ordinary values we can trace from shell assignments.
    if (ROOT_ANCHOR_NAMES.has(name)) {
      // The extractor receives repository-relative paths. An empty POSIX path
      // is therefore the repository root; normalizeScriptPath later converts
      // the resulting target back relative to the referencing file.
      current = '';
      continue;
    }
    const resolved = traceVariable(name, segment, source, rootDir, cutoff, visited, depth + 1);
    if (resolved === null) return null;
    // traceVariable composes against its own rootDir already — never re-join.
    current = resolved;
  }

  return current;
}

function isOwnDirectoryRemovalWrapped(node: SyntaxNode, source: string): boolean {
  if (node.type !== 'command_substitution') return false;
  const body = node.namedChild(0);
  if (!body) return false;
  return isOwnDirectoryRemoval(body, source) ||
    (body.type === 'string' && body.namedChildren.some((c) => isOwnDirectoryRemoval(c, source)));
}

/**
 * Resolve a script path argument to a normalized relative path against the
 * referencing file, or null. `base` is the containing file's directory, or
 * null once a working-directory change makes relative literals unknowable.
 */
export function normalizeScriptPath(
  argNode: SyntaxNode,
  source: string,
  containingFileDir: string,
  base: string | null
): string | null {
  const segments: SyntaxNode[] =
    argNode.type === 'string' || argNode.type === 'concatenation'
      ? (argNode.namedChildren.filter((c) => c !== null) as SyntaxNode[])
      : [argNode];

  // Split the argument into directory material and the trailing literal
  // filename: the last '/'-bearing literal child carries it.
  let fileIdx = -1;
  let filename = '';
  let prefixText = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const child = segments[i]!;
    if (!isDirMaterialNode(child)) return null;
    if (
      fileIdx === -1 &&
      (child.type === 'string_content' || child.type === 'word' || child.type === 'raw_string')
    ) {
      let text = getNodeText(child, source);
      if (child.type === 'raw_string' && text.length >= 2) text = text.slice(1, -1);
      const slash = text.lastIndexOf('/');
      if (slash >= 0) {
        fileIdx = i;
        filename = text.slice(slash + 1);
        prefixText = text.slice(0, slash + 1);
        continue;
      }
      if (i === 0 || !segments.slice(0, i).some((c) => isDirMaterialNode(c))) {
        // No slash anywhere before this literal either: a bare name, which
        // bash resolves through PATH rather than the script's directory.
        return null;
      }
      // Literal tail after the last expression: it IS the filename.
      fileIdx = i;
      filename = text;
      prefixText = '';
      continue;
    }
  }
  if (fileIdx === -1 || !filename) return null;

  // A failed anchor composition is fatal when expressions precede the
  // filename; only a purely literal argument may root itself at BASE.
  const exprBefore = segments
    .slice(0, fileIdx)
    .some((c) => c.type === 'command_substitution' || c.type === 'simple_expansion' || c.type === 'expansion');

  let dir = composeDirectory(
    segments.slice(0, fileIdx),
    source,
    containingFileDir,
    base !== null,
    new Set(),
    0,
    argNode.startIndex
  );
  if (dir === null && exprBefore) return null;
  if (prefixText !== '') {
    dir = appendLiteralText(dir, prefixText, containingFileDir, base !== null);
  }
  if (dir === null) return null;

  const target = posix.join(dir, filename);
  const rel = posix.relative(containingFileDir, target);
  if (rel === '') return null;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

// --- interpreter wrappers ---------------------------------------------------

interface InterpreterInvocation {
  word: string;
  pathNode: SyntaxNode | null;
  startupPathNode: SyntaxNode | null;
  normalizedPath: string | null;
}

const WRAPPERS_NO_OPTS = new Set(['builtin', 'nohup']);
const ROOT_REMAP_WRAPPERS = new Set(['chroot', 'unshare', 'nsenter', 'bwrap']);

/**
 * Refusal register: ambient PATH words, remote/container arguments, dynamic
 * roots and interactive-only startup hooks are intentionally not guessed.
 */
const WRAPPERS_FLAGS_NO_ARG: Record<string, Set<string>> = {
  env: new Set(['-i']),
  command: new Set(['-p']),
  sudo: new Set(['-i', '-s', '-E']),
  timeout: new Set(['--preserve-status']),
  exec: new Set(['-cl']),
};
const WRAPPERS_FLAG_WITH_ARG: Record<string, Record<string, string>> = {
  env: { '-u': 'unset', '--unset': 'unset' },
  nice: { '-n': 'adjustment' },
  stdbuf: { '-i': 'mode', '-o': 'mode', '-e': 'mode' },
  sudo: { '-u': 'user', '-g': 'group' },
  timeout: { '-s': 'signal', '--signal': 'signal' },
  exec: { '-a': 'name' },
};
const INTERPRETER_WORDS = new Set(['sh', 'bash', 'ksh', 'zsh', 'dash']);
const SCRIPT_INTERPRETER_WORDS = new Set([
  ...INTERPRETER_WORDS,
  'python', 'python2', 'python3', 'node', 'nodejs', 'php', 'ruby', 'perl',
  'deno', 'bun',
]);
const INTERPRETER_CODE_FLAGS: Record<string, Set<string>> = {
  python: new Set(['c', '--command']), python2: new Set(['c', '--command']),
  python3: new Set(['c', '--command']),
  node: new Set(['e', 'p', '--eval', '--print']), nodejs: new Set(['e', 'p', '--eval', '--print']),
  php: new Set(['r']), ruby: new Set(['e']), perl: new Set(['e']),
  deno: new Set(['e', '--eval']), bun: new Set(['e', '--eval']),
};

function wordsOfCommand(node: SyntaxNode, source: string): { text: string; node: SyntaxNode }[] {
  const out: { text: string; node: SyntaxNode }[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === 'command_name') {
      const word = child.child(0);
      if (word) out.push({ text: getNodeText(word, source), node: word });
    } else if (child.type === 'word') {
      out.push({ text: getNodeText(child, source), node: child });
    } else if (child.type === 'variable_assignment') {
      out.push({ text: '=', node: child });
    } else if (child.type === 'number') {
      out.push({ text: getNodeText(child, source), node: child });
    } else {
      out.push({ text: '\0', node: child });
    }
  }
  return out;
}

function looksLikeAssignmentWord(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
}

export function resolveInterpreterInvocation(
  node: SyntaxNode,
  source: string,
  rootDir: string
): InterpreterInvocation | null {
  const words = wordsOfCommand(node, source);
  let i = 0;
  let startupPathNode: SyntaxNode | null = null;
  let rootRemap: string | null = null;
  let bindRemap: { source: string; destination: string } | null = null;

  while (i < words.length && (words[i]!.text === '=' || looksLikeAssignmentWord(words[i]!.text))) {
    const assignment = words[i]!.node;
    const name = assignment.type === 'variable_assignment'
      ? assignment.childForFieldName('name')
      : null;
    if (name && getNodeText(name, source) === 'BASH_ENV') {
      startupPathNode = assignment.childForFieldName('value');
    }
    i++;
  }

  let sawWrapper = false;
  while (i < words.length) {
    const { text } = words[i]!;
    if (!WRAPPERS_NO_OPTS.has(text) && !ROOT_REMAP_WRAPPERS.has(text) && !(text in WRAPPERS_FLAGS_NO_ARG) && !(text in WRAPPERS_FLAG_WITH_ARG)) break;

    // The query forms of `command` test a name: credit the tested word.
    const next = words[i + 1];
    if (text === 'command' && next && (next.text === '-v' || next.text === '-V')) {
      const queried = words[i + 2];
      if (!queried || queried.text === '\0') return null;
      return { word: queried.text, pathNode: null, startupPathNode: null, normalizedPath: null };
    }

    sawWrapper = true;
    i++;
    if (text === 'bwrap') {
      while (i < words.length && words[i]!.text !== '--') {
        const option = words[i]!.text;
        if (option === '--bind' || option === '--ro-bind') {
          const source = words[i + 1];
          const destination = words[i + 2];
          if (!source || !destination || source.text === '\0' || destination.text === '\0') return null;
          bindRemap = { source: source.text, destination: destination.text };
          i += 3;
          continue;
        }
        if (option === '--chdir') {
          if (!words[i + 1] || words[i + 1]!.text === '\0') return null;
          i += 2;
          continue;
        }
        return null;
      }
      if (words[i]?.text === '--') i++;
      continue;
    }
    if (text !== 'chroot' && ROOT_REMAP_WRAPPERS.has(text)) return null;
    if (text === 'chroot') {
      const newRoot = words[i];
      if (!newRoot || newRoot.text === '\0' || newRoot.text.startsWith('-') || !newRoot.text.includes('/')) return null;
      rootRemap = newRoot.text;
      i++;
      continue;
    }
    const flagsNoArg = WRAPPERS_FLAGS_NO_ARG[text];
    const flagsWithArg = WRAPPERS_FLAG_WITH_ARG[text];
    const noOpts = WRAPPERS_NO_OPTS.has(text);
    while (i < words.length) {
      const w = words[i]!;
      if (w.text === '\0') return null;
      if (looksLikeAssignmentWord(w.text)) { i++; continue; }
      if (!w.text.startsWith('-')) break;
      if (flagsWithArg && (w.text in flagsWithArg)) {
        const next = words[i + 1];
        if (!next || next.text === '\0' || next.text.startsWith('-')) return null;
        i += 2;
        continue;
      }
      if (text === 'timeout' && flagsNoArg && w.text === '--preserve-status') { i++; continue; }
      if (flagsNoArg && flagsNoArg.has(w.text)) { i++; continue; }
      if (w.text === '--') { i++; break; }
      return null;
    }
    if (noOpts) continue;
    if (text === 'timeout') {
      const duration = words[i];
      if (!duration || duration.text.startsWith('-') || duration.text === '\0') return null;
      i++;
    }
  }

  if (i >= words.length) return null;
  const candidate = words[i]!;
  if (candidate.text === '\0') return null;

  // An interpreter named through a shell-naming variable: resolve its traced
  // value and test the basename against the interpreter set.
  let effectiveWord = candidate.text.includes('/') ? posix.basename(candidate.text) : candidate.text;
  if (candidate.node.type === 'simple_expansion' || candidate.node.type === 'expansion') {
    const nameNode = expansionNameNode(candidate.node);
    if (!nameNode) return null;
    const resolved = traceVariable(
      getNodeText(nameNode, source),
      candidate.node,
      source,
      rootDir,
      node.startIndex,
      new Set(),
      0
    );
    if (resolved === null) return null;
    effectiveWord = posix.basename(resolved);
  }

  // A direct script path behind the wrappers is itself the invocation target.
  if (
    sawWrapper &&
    candidate.text.includes('/') &&
    !candidate.text.startsWith('-') &&
    !SCRIPT_INTERPRETER_WORDS.has(effectiveWord)
  ) {
    const remappedTarget = rootRemap && candidate.text.startsWith('/')
      ? posix.join(rootDir, rootRemap, candidate.text.slice(1))
      : bindRemap && candidate.text.startsWith(bindRemap.destination)
        ? posix.join(rootDir, bindRemap.source, candidate.text.slice(bindRemap.destination.length).replace(/^\//, ''))
        : null;
    const normalizedPath = remappedTarget ? posix.relative(rootDir, remappedTarget) : null;
    return {
      word: candidate.text,
      pathNode: candidate.node,
      startupPathNode,
      normalizedPath: normalizedPath ? (normalizedPath.startsWith('.') ? normalizedPath : `./${normalizedPath}`) : null,
    };
  }

  if (SCRIPT_INTERPRETER_WORDS.has(effectiveWord)) {
    i++;
    // Skip the interpreter's own options. `-c` (the next word is a command
    // string, not a script) and `-s` (read the script from stdin) mean there is
    // no script path to resolve at all; short options bundle, so `bash -ec ...`
    // has to count too.
    while (i < words.length) {
      const w = words[i]!;
      if (w.text === '--') { i++; break; }
      if (!w.text.startsWith('-') || w.text === '-') break;
      const codeFlags = INTERPRETER_CODE_FLAGS[effectiveWord] ?? new Set(['c', 's']);
      if (codeFlags.has(w.text)) return { word: effectiveWord, pathNode: null, startupPathNode, normalizedPath: null };
      if (effectiveWord === 'bash' && (w.text === '--rcfile' || w.text === '--init-file')) {
        if (!words[i + 1] || words[i + 1]!.text === '\0') return { word: effectiveWord, pathNode: null, startupPathNode, normalizedPath: null };
        i += 2;
        continue;
      }
      if (!w.text.startsWith('--') && [...codeFlags].some((flag) => w.text.slice(1).includes(flag))) {
        return { word: effectiveWord, pathNode: null, startupPathNode, normalizedPath: null };
      }
      i++;
    }
    const script = words[i];
    if (!script) return { word: effectiveWord, pathNode: null, startupPathNode, normalizedPath: null };
    // A quoted or expansion-bearing argument reaches us as wordsOfCommand's
    // '\0' sentinel but still carries its real node. normalizeScriptPath traces
    // such a node exactly as it does on the `source` path — the AST is identical
    // — so hand it over rather than discarding it, which is what made
    // `bash "$HERE/x.sh"` emit no relation at all while `source "$HERE/x.sh"`
    // resolved. A bare name still declines there, since bash resolves that
    // against the runtime cwd/PATH rather than the script's directory.
    const remappedTarget = rootRemap && script.text.startsWith('/')
      ? posix.join(rootDir, rootRemap, script.text.slice(1))
      : bindRemap && script.text.startsWith(bindRemap.destination)
        ? posix.join(rootDir, bindRemap.source, script.text.slice(bindRemap.destination.length).replace(/^\//, ''))
        : null;
    const normalizedPath = remappedTarget
      ? posix.relative(rootDir, remappedTarget)
      : null;
    return {
      word: effectiveWord,
      pathNode: script.node,
      startupPathNode,
      normalizedPath: normalizedPath ? (normalizedPath.startsWith('.') ? normalizedPath : `./${normalizedPath}`) : null,
    };
  }

  return { word: candidate.text, pathNode: null, startupPathNode, normalizedPath: null };
}

// --- function-named-as-argument forms ----------------------------------------

const SIGNAL_NAMES = new Set([
  'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1',
  'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP',
  'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFS', 'VTALRM', 'PROF', 'WINCH',
  'IO', 'PWR', 'SYS', 'EXIT', 'DEBUG', 'RETURN', 'ERR',
]);

function isSignalSpecification(text: string): boolean {
  if (/^\d+$/.test(text)) return true;
  const bare = text.replace(/^SIG/i, '');
  return SIGNAL_NAMES.has(bare.toUpperCase());
}

function stripQuotes(text: string): string {
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * A function named as an argument to trap/complete/export — the guarded set
 * that genuinely CALLS the function. Returns the function name, or null.
 */
export function functionRefArguments(
  node: SyntaxNode,
  source: string,
  filePath: string
): string | null {
  const word = commandWord(node, source);
  if (!word) return null;

  const operandTexts = (): { text: string; node: SyntaxNode }[] => {
    const out: { text: string; node: SyntaxNode }[] = [];
    let pastName = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)!;
      if (!pastName) {
        // Wrapper objects are re-created per access — never compare nodes
        // with ===; the single command_name child IS the name.
        if (child.type === 'command_name') pastName = true;
        continue;
      }
      if (child.type === 'variable_assignment') continue;
      const type = child.type;
      if (type === 'word' || type === 'raw_string' || type === 'string') {
        out.push({ text: getNodeText(child, source), node: child });
      } else {
        out.push({ text: '\0', node: child });
      }
    }
    return out;
  };

  if (word === 'trap') {
    const operands = operandTexts();
    let i = 0;
    while (i < operands.length) {
      const t = operands[i]!.text;
      if (t === '--') { i++; break; }
      if (t.startsWith('-')) { i++; continue; }
      break;
    }
    const rest = operands.slice(i);
    if (rest.length < 2) return null;
    const rawAction = rest[0]!.text;
    const action = stripQuotes(rawAction);
    if (action === '' || action.includes(' ') || action.startsWith('-')) return null;
    if (isSignalSpecification(action)) return null;
    return action;
  }

  if (word === 'complete') {
    const operands = operandTexts();
    for (let i = 0; i < operands.length - 1; i++) {
      if (operands[i]!.text === '-F' || operands[i]!.text === '--command') {
        const fn = stripQuotes(operands[i + 1]!.text);
        if (fn && !fn.startsWith('-')) return fn;
      }
    }
    return null;
  }

  if (word === 'export') {
    const operands = operandTexts();
    let sawFuncOpt = false;
    for (let i = 0; i < operands.length; i++) {
      const t = operands[i]!.text;
      if (t === '--') continue;
      if (/^-[a-zA-Z]*f/.test(t)) { sawFuncOpt = true; continue; }
      if (t.startsWith('-')) continue;
      if (sawFuncOpt) {
        const fn = stripQuotes(t).split('=').pop()!;
        return fn || null;
      }
    }
    return null;
  }

  // The bats runner: an ordinary word everywhere else, meaningful only in a
  // .bats file (an extension the grammar health check kept).
  if (word === 'run' && filePath.endsWith('.bats')) {
    const operands = operandTexts().filter((o) => o.text !== '\0');
    const first = operands[0];
    if (!first) return null;
    const fn = stripQuotes(first.text);
    if (!fn || fn.startsWith('-') || fn.startsWith('$')) return null;
    return fn;
  }

  return null;
}

// --- classification ---------------------------------------------------------

const SOURCING_WORDS = new Set(['source', '.']);
const DIRECTORY_CHANGE_WORDS = new Set(['cd', 'pushd', 'popd']);
const SHELL_SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.ksh', '.zsh', '.dash', '.bats']);

function isShellScriptReference(filePath: string): boolean {
  const basename = posix.basename(filePath).toLowerCase();
  const dot = basename.lastIndexOf('.');
  return dot < 0 || SHELL_SCRIPT_EXTENSIONS.has(basename.slice(dot));
}

function localRedirectPathNodes(node: SyntaxNode): SyntaxNode[] {
  const paths: SyntaxNode[] = [];
  const walk = (current: SyntaxNode): void => {
    if ((current.type === 'file_redirect' || current.type.endsWith('_redirect')) && current.type !== 'heredoc_redirect') {
      const candidate = current.namedChild(current.namedChildCount - 1);
      if (candidate && ['word', 'string', 'raw_string', 'concatenation'].includes(candidate.type)) {
        paths.push(candidate);
      }
      return;
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(node);
  return paths;
}

function emitLocalRedirectRelations(node: SyntaxNode, ctx: ExtractorContext, state: CwdState): void {
  const containingFileDir = posix.dirname(ctx.filePath);
  const base = state.cwdChanged ? null : containingFileDir;
  for (const redirectPath of localRedirectPathNodes(node)) {
    const normalized = normalizeScriptPath(redirectPath, ctx.source, containingFileDir, base);
    if (normalized && isShellScriptReference(normalized)) {
      emitScriptRelation(ctx, normalized, 'references', redirectPath);
    }
  }
}

function isInsideCommandSubstitution(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'command_substitution') return true;
    current = current.parent;
  }
  return false;
}

function recordPathPrepend(node: SyntaxNode, ctx: ExtractorContext, state: CwdState): void {
  const commandText = getNodeText(node, ctx.source);
  const pathMatch = commandText.match(/(?:^|\s)(?:export\s+)?PATH\s*=\s*([^\n;]+)/);
  if (!pathMatch) return;
  const value = pathMatch[1]!.replace(/^['"]|['"]$/g, '');
  const anchored = value.match(/^\$\(dirname\s+["']?\$0["']?\)([^:]+)(?::\$PATH)?$/)
    ?? commandText.match(/\$\(dirname\s+["']?\$0["']?\)([^:$\s"']+)/);
  const literal = value.match(/^(\.\.?\/[^:]+)(?::\$PATH)?$/);
  if (anchored) state.pathPrepends.push(posix.join(posix.dirname(ctx.filePath), anchored[1]!));
  else if (literal) state.pathPrepends.push(posix.normalize(posix.join(posix.dirname(ctx.filePath), literal[1]!)));
}

function emitScriptRelation(
  ctx: ExtractorContext,
  normalizedPath: string,
  kind: 'imports' | 'references',
  anchorNode: SyntaxNode
): void {
  if (kind === 'imports') {
    ctx.createNode('import', normalizedPath, anchorNode, {
      signature: getNodeText(anchorNode, ctx.source).trim().slice(0, 100),
    });
  }
  if (ctx.nodeStack.length === 0) return;
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: normalizedPath,
    referenceKind: kind,
    line: anchorNode.startPosition.row + 1,
    column: anchorNode.startPosition.column,
  });
}

function classifyShellCommand(node: SyntaxNode, ctx: ExtractorContext, state: CwdState): void {
  const source = ctx.source;
  const word = commandWord(node, source);
  if (!word) return;

  const containingFileDir = posix.dirname(ctx.filePath);
  const base = state.cwdChanged ? null : containingFileDir;

  // Redirections are performed by the local shell before a remote/container
  // command receives control. This keeps `ssh host 'bash -s' < ./x.sh` and
  // `docker run -i image bash -s < ./x.sh` visible without admitting the
  // remote command's own path arguments.
  emitLocalRedirectRelations(node, ctx, state);

  // A command substitution is evaluated by this shell even when its output
  // becomes an argument to a remote command (`ssh host "$(cat ./x.sh)"`).
  // Credit the local file operand, but only for the explicit file-reading
  // form and only when it names a shell script.
  if (word === 'cat' && isInsideCommandSubstitution(node)) {
    const operand = node.namedChildren.find((child) =>
      child.type !== 'command_name' && ['word', 'string', 'raw_string', 'concatenation'].includes(child.type));
    if (operand) {
      const normalized = normalizeScriptPath(operand, source, containingFileDir, base);
      if (normalized && isShellScriptReference(normalized)) {
        emitScriptRelation(ctx, normalized, 'references', operand);
      }
    }
  }

  if (SOURCING_WORDS.has(word)) {
    const args = node.namedChildren.filter((c) => c.type !== 'command_name');
    const first = args[0];
    if (!first) return;
    const text = getNodeText(first, source).replace(/^['"]|['"]$/g, '');
    if (!text.includes('/')) return;
    const normalized = normalizeScriptPath(first, source, containingFileDir, base);
    if (normalized && isShellScriptReference(normalized)) emitScriptRelation(ctx, normalized, 'imports', first);
    return;
  }

  if (word.includes('/') && !SCRIPT_INTERPRETER_WORDS.has(posix.basename(word))) {
    const nameNode = node.childForFieldName('name');
    const nameWord = nameNode?.child(0);
    if (!nameWord) return;
    const normalized = normalizeScriptPath(nameWord, source, containingFileDir, base);
    if (normalized && isShellScriptReference(normalized)) emitScriptRelation(ctx, normalized, 'references', nameNode!);
    return;
  }

  const invocation = resolveInterpreterInvocation(node, source, containingFileDir);
  if (!invocation) return;

  if (invocation.startupPathNode) {
    const startupPath = normalizeScriptPath(invocation.startupPathNode, source, containingFileDir, base);
    if (startupPath && isShellScriptReference(startupPath)) {
      emitScriptRelation(ctx, startupPath, 'imports', invocation.startupPathNode);
    }
  }

  if (invocation.pathNode) {
    const normalized = invocation.normalizedPath ?? normalizeScriptPath(invocation.pathNode, source, containingFileDir, base);
    if (normalized) {
      emitScriptRelation(ctx, normalized, 'references', invocation.pathNode);
      return;
    }
    return;
  }

  // Resolve only directories explicitly prepended by this script. The
  // inherited PATH is intentionally outside the static-analysis boundary.
  if (state.pathPrepends.length > 0 && invocation.word && !invocation.word.includes('/')) {
    const targetDir = state.pathPrepends[state.pathPrepends.length - 1]!;
    const rel = posix.relative(containingFileDir, posix.join(targetDir, invocation.word));
    emitScriptRelation(ctx, rel.startsWith('.') ? rel : `./${rel}`, 'references', node.childForFieldName('name')!);
    return;
  }

  // A function named as an argument (trap action, export -f, complete -F,
  // the bats runner) credits the FUNCTION, not the builtin word.
  const fnArg = functionRefArguments(node, source, ctx.filePath);
  if (fnArg) {
    if (ctx.nodeStack.length > 0) {
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (fromNodeId) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: fnArg,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
    return;
  }

  if (ctx.nodeStack.length > 0) {
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (fromNodeId) {
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: invocation.word,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
}

export const bashExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: ['variable_assignment', 'declaration_command'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: '',

  visitNode: (node, ctx) => {
    const state = stateFor(ctx);
    if (node.type === 'redirected_statement') {
      emitLocalRedirectRelations(node, ctx, state);
      return false;
    }
    if (node.type === 'declaration_command') {
      recordPathPrepend(node, ctx, state);
      return false;
    }
    if (node.type !== 'command') return false;

    classifyShellCommand(node, ctx, state);

    const word = commandWord(node, ctx.source);
    if (word && DIRECTORY_CHANGE_WORDS.has(word) && !runsInOwnProcess(node)) {
      state.cwdChanged = true;
    }

    for (const child of node.namedChildren) {
      if (child.type === 'heredoc_redirect') continue;
      ctx.visitNode(child);
    }
    return true;
  },
};
