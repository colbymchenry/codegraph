import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Shell (bash/zsh/sh) extraction. One grammar — tree-sitter-bash (vendored,
// ABI 15) — serves all three dialects; the AST node types are shared.
//
// Distinctive traits vs other languages:
//   - functions: `function_definition` with a bare `word` name (`greet()`) or
//     keyword form (`function greet { ... }`). No parameters field — args come
//     from `$1`, `$@`, etc.
//   - variables: plain assignments (`variable_assignment`) whose NAME is the
//     `name:` child of type `variable_name` (not `identifier`), so variable
//     extraction needs a shell branch in extractVariable (see tree-sitter.ts).
//   - imports: no import statement — scripts pull files with the `source foo.sh`
//     or `. foo.sh` commands, handled here as import nodes.
//   - calls: every bare word is a command (`command > name: command_name > word`),
//     including external tools and builtins that have no symbol in this project.
//     To avoid emitting thousands of dead call edges to `echo`, `ls`, etc.,
//     commands are NOT put in callTypes; instead visitNode emits a `calls` ref
//     only for command names that could plausibly be symbols defined here, and
//     skips known builtins/external utilities.

/** Command words that are bash/zsh builtins or standard external tools — never local symbols. */
const BUILTIN_OR_EXTERNAL: Record<string, true> = {
  // control-flow keywords (parsed as separate node types, but guard anyway)
  if: true, then: true, else: true, elif: true, fi: true, for: true,
  while: true, until: true, do: true, done: true, case: true, esac: true,
  function: true, in: true, select: true, time: true, coproc: true,
  // bash builtins
  '.': true, ':': true, '[': true, '[[': true, alias: true, bg: true,
  bind: true, break: true, builtin: true, caller: true, cd: true,
  command: true, compgen: true, complete: true, continue: true, declare: true,
  dirs: true, disown: true, echo: true, enable: true, eval: true, exec: true,
  exit: true, export: true, false: true, fc: true, fg: true, getopts: true,
  hash: true, help: true, history: true, jobs: true, kill: true, let: true,
  local: true, logout: true, mapfile: true, popd: true, printf: true,
  pushd: true, pwd: true, read: true, readarray: true, readonly: true,
  return: true, set: true, shift: true, shopt: true, source: true,
  suspend: true, test: true, times: true, trap: true, type: true,
  typeset: true, ulimit: true, umask: true, unalias: true, unset: true,
  wait: true,
  // POSIX/standard external utilities (no project-local symbol to link)
  awk: true, basename: true, cat: true, chmod: true, chown: true, cp: true,
  cut: true, date: true, dd: true, df: true, diff: true, dirname: true,
  du: true, env: true, expr: true, find: true, grep: true, head: true,
  hostname: true, id: true, install: true, ln: true, ls: true, make: true,
  mkdir: true, mktemp: true, mv: true, nice: true, nl: true, od: true,
  paste: true, ps: true, readlink: true, realpath: true, rm: true, rmdir: true,
  sed: true, seq: true, sleep: true, sort: true, stat: true, strings: true,
  tail: true, tar: true, tee: true, touch: true, tr: true, uname: true,
  uniq: true, wc: true, which: true, whoami: true, xargs: true, yes: true,
  zcat: true, zip: true,
};

/**
 * True if `word` is a plain command word (not an option like `-v` or flag) and
 * not a known builtin/external utility.
 */
function isCommandWord(node: SyntaxNode, source: string): boolean {
  const text = getNodeText(node, source);
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(text) && !text.startsWith('-');
}

/** The first word of a `command` node — its command name. */
export function shellCommandName(node: SyntaxNode, source: string): string | null {
  const cmd = getChildByField(node, 'name') ?? node.namedChildren[0];
  if (!cmd) return null;
  // `command > name: command_name > word` (or a bare `word` in some forms).
  let wordNode = cmd.type === 'command_name' ? getChildByField(cmd, 'name') ?? cmd.namedChildren[0] : cmd;
  if (!wordNode || wordNode.type !== 'word') return null;
  const name = isCommandWord(wordNode, source) ? getNodeText(wordNode, source).trim() : '';
  return name && !(name in BUILTIN_OR_EXTERNAL) ? name : null;
}

/** If `node` (a command) is a `source foo.sh` / `. foo.sh` import, the target path. */
export function shellImportTarget(node: SyntaxNode, source: string): string | null {
  const cmd = getChildByField(node, 'name') ?? node.namedChildren[0];
  if (!cmd) return null;
  let wordNode = cmd.type === 'command_name' ? getChildByField(cmd, 'name') ?? cmd.namedChildren[0] : cmd;
  if (!wordNode || wordNode.type !== 'word') return null;
  const name = getNodeText(wordNode, source).trim();
  if (name !== 'source' && name !== '.') return null;
  // First argument is the file to pull in. The grammar emits it as a direct
  // `word` child (`source ./lib/common.sh`) or wraps it in an `argument` node;
  // take the first non-command-name named child and read its word text.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child === cmd || child.type === 'command_name') continue;
    // Dig the target word out of a wrapping `argument`/redirect, else use the
    // child itself when it's already a bare `word`.
    let w = child.type === 'word' ? child : null;
    if (!w) {
      for (let j = 0; j < child.namedChildCount; j++) {
        const c2 = child.namedChild(j);
        if (c2 && c2.type === 'word') { w = c2; break; }
      }
    }
    if (!w) continue;
    const t = getNodeText(w, source).trim().replace(/^["']|["']$/g, '');
    if (t) return t;
  }
  return null;
}

export const shellExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [], // Shell has no classes/structs/interfaces/enums
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // `source`/`.` are commands — handled in visitNode below
  callTypes: [], // command calls filtered via visitNode (avoid external-tool noise)
  variableTypes: ['variable_assignment'], // name is the `name:` child, type variable_name
  nameField: 'name',
  bodyField: 'body',
  paramsField: '', // shell functions have no parameter list — args are $1/$@ etc.

  getSignature: (node, source) => {
    // e.g. `greet()` or `function install_pkg {` — just the callable form.
    return node.type === 'function_definition'
      ? getNodeText(node.namedChildren[0] ?? node, source).trim().slice(0, 100)
      : undefined;
  },

  // Emit imports for `source foo.sh` / `. foo.sh`, and filtered call refs for
  // commands that could be local symbols. Return false so the core walker still
  // descends into children (variables inside function bodies, nested calls).
  visitNode: (node, ctx) => {
    if (node.type !== 'command') return false;
    const source = ctx.source;

    // `source foo.sh` / `. foo.sh` → import edge to the pulled-in file.
    const impTarget = shellImportTarget(node, source);
    if (impTarget) {
      const sig = getNodeText(node, source).trim().slice(0, 100);
      const name = impTarget.split('/').pop() ?? impTarget;
      ctx.createNode('import', name, node, { signature: sig });
      // Reference the file by its basename so import resolution can link it.
      if (ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: impTarget.replace(/^.*\//, '').replace(/\.sh$/i, '') || name,
            referenceKind: 'imports',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
    }

    // A command whose first word could be a project-local symbol (function) —
    // emit a `calls` ref so codegraph_explore can trace function invocations.
    const callee = shellCommandName(node, source);
    if (callee && ctx.nodeStack.length > 0) {
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (parentId) {
        ctx.addUnresolvedReference({
          fromNodeId: parentId,
          referenceName: callee,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }

    return false;
  },
};
