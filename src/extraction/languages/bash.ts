import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow the vendored ABI-15 grammar (tree-sitter-bash 0.25.1), NOT
// the tree-sitter-wasms build — see the VENDORED_WASM_LANGS note in grammars.ts.
//
// Shell has no declaration syntax beyond functions, so the graph shape is:
//   function_definition      -> function symbols
//   command                  -> call edges (the callee is the command word)
//   `source x` / `. x`       -> import symbols + file dependency edges
//   variable_assignment      -> constants/variables at file scope
// There are no classes, structs, interfaces, enums or type aliases.

/** The two spellings of shell's only import form. */
const SOURCE_COMMANDS = new Set(['source', '.']);

/**
 * Builtins, keywords and coreutils that can never resolve to a shell function.
 *
 * Every command word becomes a `calls` reference, which is what makes
 * `codegraph callers <fn>` work across sourced files. Without this filter the
 * dominant edge in any script is `echo`/`printf`/`local` — thousands of
 * permanently unresolvable references per repo that bury the real ones. An
 * EXTERNAL tool (`git`, `jq`, `curl`) is deliberately NOT filtered: it stays an
 * unresolved reference, which is how "which scripts shell out to jq" is
 * answerable at all. Only names a `function` definition can never legally take
 * belong here.
 */
const BASH_BUILTINS = new Set([
  '.', ':', '[', '[[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller',
  'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'declare',
  'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export',
  'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill',
  'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd',
  'read', 'readarray', 'readonly', 'return', 'set', 'shift', 'shopt',
  'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset',
  'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);

/** A command word we can link on: a plain identifier, not an expansion. */
const PLAIN_COMMAND_WORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Text of a `command` node's `name:` field, or null when it isn't a bare word. */
function commandWord(node: SyntaxNode, source: string): string | null {
  const name = getChildByField(node, 'name');
  if (!name || name.type !== 'command_name') return null;
  const text = getNodeText(name, source).trim();
  // `"$CMD" arg` / `${runner} arg` / `$(pick) arg` have no static callee.
  if (!text || text.includes('$')) return null;
  return text;
}

/**
 * Callee name for a `command` node, or null when there is nothing to link.
 * Exported for the `bash` branch of TreeSitterExtractor.extractCall.
 */
export function bashCallee(node: SyntaxNode, source: string): string | null {
  const word = commandWord(node, source);
  if (!word || BASH_BUILTINS.has(word)) return null;
  // `./scripts/build.sh` and `/usr/bin/env` are invocations of a FILE, not of a
  // function; the graph has no edge kind for them, so leave them out rather
  // than mint a reference that can never resolve.
  if (!PLAIN_COMMAND_WORD.test(word)) return null;
  return word;
}

/**
 * Path a `source` / `.` command loads, reduced to the literal tail.
 *
 * Sourcing is almost always written through a variable
 * (`source "$SCRIPT_DIR/lib/_log.sh"`), so the argument's leading expansion is
 * dropped and the literal remainder kept: `lib/_log.sh`. That tail is what
 * resolveBashSource matches against indexed file paths.
 */
export function bashSourcedPath(node: SyntaxNode, source: string): string | null {
  const word = commandWord(node, source);
  if (!word || !SOURCE_COMMANDS.has(word)) return null;

  const arg = getChildByField(node, 'argument');
  if (!arg) return null;
  let text = getNodeText(arg, source).trim();
  if (!text) return null;

  // Strip one layer of quoting, then drop the leading expansion so only the
  // literal tail is left. `"$(dirname "${BASH_SOURCE[0]}")/lib/_log.sh"` becomes
  // `lib/_log.sh`. Cutting at the LAST `)`/`}` (rather than matching the
  // expansion itself) is what survives the nested-quote form above, which no
  // flat regex parses.
  text = text.replace(/^["']/, '').replace(/["']$/, '');
  const lastClose = Math.max(text.lastIndexOf(')'), text.lastIndexOf('}'));
  if (lastClose >= 0) text = text.slice(lastClose + 1);
  else text = text.replace(/^\$[A-Za-z_][A-Za-z0-9_]*/, '');
  text = text.replace(/^["']/, '').replace(/["']$/, '');
  text = text.replace(/^\/+/, '').replace(/^\.\//, '');
  // Anything still carrying an expansion, or a bare filename with no literal
  // left, has no static target to resolve.
  if (!text || text.includes('$') || text.includes('"') || text.includes("'")) return null;
  return text;
}

/** Depth-first walk of every node in a subtree. */
function walk(node: SyntaxNode, visit: (n: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

/**
 * `readonly X=1` / `declare -r X=1` are the only constant forms shell has;
 * `local`, `export`, `declare` and a bare assignment are all mutable.
 */
/** True when no enclosing `function_definition` wraps this node. */
function isFileScope(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function_definition') return false;
  }
  return true;
}

function isConstantAssignment(assignment: SyntaxNode, source: string): boolean {
  const parent = assignment.parent;
  if (!parent || parent.type !== 'declaration_command') return false;
  const keyword = getNodeText(parent, source).trimStart().split(/\s+/, 3);
  if (keyword[0] === 'readonly') return true;
  return (keyword[0] === 'declare' || keyword[0] === 'typeset') && keyword[1] === '-r';
}

export const bashExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  // Shell has no aggregate types at all.
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  // `source` is a command, not a statement — emitted from the visitNode hook.
  importTypes: [],
  // Handled by the `bash` branch of extractCall so builtins can be filtered;
  // listing the type here is what routes command nodes to it in BOTH walkers
  // (the top-level walk and visitFunctionBody).
  callTypes: ['command'],
  // Assignments are emitted from the visitNode hook instead, so the hook can
  // drop function-local `local x=…` (see isFileScope): shell locals are not
  // addressable symbols, and in a real script they outnumber functions ~6:1.
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  // Shell functions take no declared parameters ($1, $2, … are positional).
  paramsField: 'parameters',

  // `foo() { … }` and `function foo { … }` are one node type; the signature is
  // just the name, so show the form the file actually uses.
  getSignature: (node, source) => {
    const name = getChildByField(node, 'name');
    if (!name) return undefined;
    const declared = getNodeText(node, source).slice(0, 200);
    return declared.startsWith('function') ? `function ${getNodeText(name, source)}` : `${getNodeText(name, source)}()`;
  },

  visitNode: (node, ctx) => {
    const source = ctx.source;

    // One whole-file scan for `source` / `.`, done when the walker reaches the
    // root. Sourcing inside a function body is the common idiom in hook
    // libraries, and function bodies are walked by visitFunctionBody (which
    // never calls this hook) — a per-node import branch would miss them.
    if (node.type === 'program') {
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const seen = new Set<string>();
      walk(node, (n) => {
        if (n.type !== 'command') return;
        const modulePath = bashSourcedPath(n, source);
        if (!modulePath || seen.has(modulePath)) return;
        seen.add(modulePath);
        ctx.createNode('import', modulePath, n, {
          signature: getNodeText(n, source).trim().slice(0, 100),
        });
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: modulePath,
            referenceKind: 'imports',
            line: n.startPosition.row + 1,
            column: n.startPosition.column,
          });
        }
      });
      return false;
    }

    // File-scope `X=1`, `export X=1`, `readonly X=1`.
    if (node.type === 'variable_assignment') {
      // A command prefix (`FOO=bar cmd`) is an argument to that command, and a
      // function-local is not a symbol anyone queries.
      if (node.parent?.type === 'command') return false;
      if (!isFileScope(node)) return false;
      const name = getChildByField(node, 'name');
      if (!name) return false;
      const varName = getNodeText(name, source).trim();
      if (!varName) return false;
      const kind = isConstantAssignment(node, source) ? 'constant' : 'variable';
      const declaration = node.parent?.type === 'declaration_command' ? node.parent : node;
      ctx.createNode(kind, varName, declaration, {
        signature: getNodeText(declaration, source).split('\n')[0]?.slice(0, 120),
      });
      return false;
    }

    return false;
  },
};
