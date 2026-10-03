import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow the tree-sitter-grammars/tree-sitter-tcl grammar
// (vendored ABI-15 wasm, built with tree-sitter-cli 0.25.10) — see grammars.ts.

/** Core Tcl builtins that are CLAIMED (visitNode returns true) rather than
 *  emitted as call edges — they would otherwise mint a phantom `calls` target
 *  in every script. Command dispatch to user procs, package extensions and
 *  framework commands (`hm_*`, `*createentity`, Tk widget paths, …) is NOT in
 *  this list, so those edges survive and resolve where the procs are indexed.
 *  Control flow has dedicated node types (if/while/foreach/namespace/set/…)
 *  and never reaches the `command` branch at all. */
const TCL_BUILTINS = new Set([
  'puts', 'set', 'unset', 'incr', 'return', 'expr', 'eval', 'uplevel', 'upvar',
  'global', 'variable', 'append', 'list', 'concat', 'lappend', 'lindex',
  'llength', 'linsert', 'lrange', 'lreplace', 'lsort', 'lsearch', 'join',
  'split', 'dict', 'string', 'format', 'scan', 'clock', 'file', 'open',
  'close', 'gets', 'read', 'flush', 'seek', 'tell', 'exec', 'rename', 'info',
  'error', 'throw', 'break', 'continue', 'after', 'update', 'vwait', 'array',
  'binary', 'chan', 'fconfigure', 'regsub', 'subst', 'trace', 'switch',
  'apply', 'tailcall', 'coroutine', 'yield',
  // 8.5+ / TclOO / Tk additions — seen as top unresolved noise on real
  // codebases (tcllib): for, lassign, pack, my, next, self, interp, …
  'for', 'lassign', 'lmap', 'pack', 'my', 'next', 'self', 'try', 'interp',
  'exit', 'cd', 'glob', 'time', 'load', 'unload', 'socket', 'fcopy',
  'fileevent', 'ttk::pack', 'grid', 'place', 'wm',
]);

/** If `commandNode` is `source <path>`, return the path text; otherwise null. */
function sourcePath(commandNode: SyntaxNode, source: string): string | null {
  const name = getChildByField(commandNode, 'name');
  if (!name || getNodeText(name, source) !== 'source') return null;
  const args = getChildByField(commandNode, 'arguments');
  if (!args) return null;
  const word = args.namedChildren.find((c) => c.type !== 'comment');
  if (!word) return null;
  const text = getNodeText(word, source).trim().replace(/^["'{]/, '').replace(/["'}]$/, '');
  return text || null;
}

/** If `commandNode` is `package require <name>`, return the package name. */
function packageName(commandNode: SyntaxNode, source: string): string | null {
  const name = getChildByField(commandNode, 'name');
  if (!name || getNodeText(name, source) !== 'package') return null;
  const args = getChildByField(commandNode, 'arguments');
  if (!args) return null;
  const words = args.namedChildren.filter((c) => c.type !== 'comment');
  if (!words.length || getNodeText(words[0]!, source) !== 'require') return null;
  const pkg = words[1] ? getNodeText(words[1]!, source).trim().replace(/^["'{]/, '').replace(/["'}]$/, '') : '';
  return pkg || null;
}

export const tclExtractor: LanguageExtractor = {
  // `proc name {args} {body}` — the only definition form in Tcl. Bare procs
  // inside `namespace eval ::ns { … }` qualify via getReceiverType below.
  functionTypes: ['procedure'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // `source` / `package require` are commands — handled in visitNode
  callTypes: ['command'],
  // `set name value` nodes — handled by the tcl branch in extractVariable
  // (the generic fallback looks for identifier children, which `set` lacks).
  variableTypes: ['set'],
  // Builtin commands (`puts`, `return`, …) are claimed by visitNode; without
  // this flag the function-body walker would still mint call refs for them.
  bodyWalkerUsesVisitNode: true,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'arguments',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'arguments');
    return params ? getNodeText(params, source) : undefined;
  },

  // `proc foo` inside `namespace eval ::utils { … }` is really `::utils::foo`:
  // walk up to the enclosing `namespace` node and return its eval name as the
  // receiver so the extraction qualifies the symbol (mirrors Lua's table
  // receiver handling). Procs already written as `proc ::utils::foo` keep
  // their full name and get no receiver.
  getReceiverType: (node, source) => {
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'namespace') {
        const wl = parent.namedChildren.find((c) => c.type === 'word_list');
        if (wl) {
          const words = wl.namedChildren.filter((c) => c.type !== 'comment');
          if (words.length >= 2 && getNodeText(words[0]!, source) === 'eval') {
            return getNodeText(words[1]!, source).trim();
          }
        }
        return undefined;
      }
      parent = parent.parent;
    }
    return undefined;
  },

  visitNode: (node, ctx) => {
    if (node.type !== 'command') return false;
    const source = ctx.source;

    const emitImport = (refName: string): void => {
      const imp = ctx.createNode('import', refName, node, {
        signature: getNodeText(node, source).trim().slice(0, 100),
      });
      if (imp && ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: refName,
            referenceKind: 'imports',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
    };

    // `source compat.tcl` → import edge (claimed so no call edge is minted).
    const src = sourcePath(node, source);
    if (src) {
      emitImport(src);
      return true;
    }

    // `package require Tk` → import edge for the package name.
    const pkg = packageName(node, source);
    if (pkg) {
      emitImport(pkg);
      return true;
    }

    // Core builtins are claimed so they don't mint phantom call targets.
    // Tcl allows absolute builtin invocation (`::set`, `::puts`) — strip the
    // leading namespace separator before consulting the table.
    const name = getChildByField(node, 'name');
    if (!name) return false;
    const nameText = getNodeText(name, source).trim();
    if (TCL_BUILTINS.has(nameText) || (nameText.startsWith('::') && TCL_BUILTINS.has(nameText.slice(2)))) {
      return true;
    }

    // Dynamic dispatch — the command word is a variable substitution
    // (`$self cmd`), a literal (numeric/stray), or a command substitution
    // (`[$obj method]`). No static tool can resolve these; claim them so no
    // phantom `calls` ref is minted (top noise source on tcllib).
    // Plain command words are node types `word` / `simple_word`.
    const plainWord = name.type === 'word' || name.type === 'simple_word';
    if (!plainWord || nameText.startsWith('$') || /^[0-9]/.test(nameText)) {
      return true;
    }

    return false;
  },
};
