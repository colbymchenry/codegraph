import type { Node as SyntaxNode } from 'web-tree-sitter';
import {
  getNodeText,
  getChildByField,
  getPrecedingDocstring,
  namedArgCount,
} from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// Node names follow the vendored WhatsApp/tree-sitter-erlang grammar (0.19,
// ABI 14) — the grammar behind the Erlang Language Platform (ELP).
//
// Erlang is form-based, and three of its shapes don't fit the generic
// extractor, so every symbol-bearing top-level form is dispatched through the
// visitNode hook below instead:
//   - a function's name lives on its CLAUSE, not the fun_decl, and the grammar
//     emits one fun_decl PER CLAUSE — consecutive same-name same-ARITY
//     fun_decl forms (clauses of one function) are merged into a single
//     function node here. Arity is part of an Erlang function's identity
//     (`f/1` and `f/2` are unrelated definitions — #1610), so each arity gets
//     its own node, qualified `mod::f/1` / `mod::f/2`;
//   - type-position expressions (-spec/-type/-callback bodies, record field
//     types) parse as `call` nodes, so descending into them would mint bogus
//     call refs to type names (`pid()`, `term()`); the hook consumes those
//     subtrees;
//   - record_decl carries its fields as direct children (no body field), which
//     the generic extractStruct would skip as a forward declaration.
// Calls (local `f(X)`, remote `mod:f(X)`, `fun f/1` references, and record
// usages) are handled by the erlang branch in extractCall — remote calls are
// emitted as `mod::f/2` (arity counted at the call site), byte-identical to
// the qualifiedName above, so cross-module resolution rides the standard
// qualified-name matcher; local calls are emitted `f/2` and resolved by the
// erlang arity step in matchReference.

/** Text of an atom with quoted-atom quotes stripped (`'EXIT'` → `EXIT`). */
function atomText(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).replace(/^'([\s\S]*)'$/, '$1');
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// --- Per-file memos. Extraction is file-sequential within a worker, so a
// single-entry memo keyed by filePath is safe (and resets naturally). ---

/**
 * Exported `name/arity` keys for the current file ('all' for
 * -compile(export_all)). Keyed by arity because `-export([f/1])` exports
 * exactly f/1 — f/2 in the same module stays private (#1610). A malformed
 * `fa` with no arity node falls back to the bare name key.
 */
let exportsFile = '';
let exportsMemo: Set<string> | 'all' = new Set();

/**
 * Clause-merge state: the previous fun_decl's name, arity, and node id. A
 * fun_decl whose clause repeats that (name, arity) is a continuation clause of
 * the SAME function and attaches to the existing node instead of creating a
 * duplicate. A same-name DIFFERENT-arity fun_decl is an unrelated function
 * (Erlang identity is `name/arity`) and gets its own node (#1610). Keying on
 * adjacency stays safe: clauses of one function must be adjacent in Erlang —
 * a non-adjacent redefinition of the same name/arity is a compile error.
 */
let lastFnFile = '';
let lastFnName = '';
let lastFnArity = -1;
let lastFnId = '';

function moduleExports(node: SyntaxNode, source: string, filePath: string): Set<string> | 'all' {
  if (filePath === exportsFile) return exportsMemo;
  let root: SyntaxNode = node;
  while (root.parent) root = root.parent;
  let result: Set<string> | 'all' = new Set<string>();
  for (let i = 0; i < root.namedChildCount; i++) {
    const form = root.namedChild(i);
    if (!form) continue;
    if (
      form.type === 'compile_options_attribute' &&
      getNodeText(form, source).includes('export_all')
    ) {
      result = 'all';
      break;
    }
    if (form.type === 'export_attribute') {
      for (const fa of form.namedChildren) {
        if (fa.type !== 'fa') continue;
        const fun = getChildByField(fa, 'fun');
        if (!fun) continue;
        const name = atomText(fun, source);
        const arityNode = getChildByField(fa, 'arity');
        const arityValue = arityNode ? getChildByField(arityNode, 'value') : null;
        const arity = arityValue ? getNodeText(arityValue, source) : null;
        result.add(arity !== null ? `${name}/${arity}` : name);
      }
    }
  }
  exportsFile = filePath;
  exportsMemo = result;
  return result;
}

/** Argument count of a clause/sig: the `args` (expr_args) field's arguments. */
function nodeArity(withArgs: SyntaxNode): number {
  return namedArgCount(getChildByField(withArgs, 'args'));
}

/**
 * The -spec directly above a function (comments may sit between), if it names
 * it AND matches its arity — the spec for `header/3` sitting between the
 * `header/2` and `header/3` definitions must attach to /3 only (#1610). A
 * spec whose sigs can't be read (defensive) is accepted on the name alone.
 */
function precedingSpec(node: SyntaxNode, name: string, arity: number, source: string): SyntaxNode | null {
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'comment') prev = prev.previousNamedSibling;
  if (prev?.type === 'spec') {
    const specFun = getChildByField(prev, 'fun');
    if (specFun && atomText(specFun, source) === name) {
      const sigs = prev.namedChildren.filter((c) => c.type === 'type_sig');
      if (sigs.length === 0 || sigs.some((sig) => nodeArity(sig) === arity)) return prev;
    }
  }
  return null;
}

/** `name(Args) when Guard` — the clause text up to the `->`. */
function clauseHeader(clause: SyntaxNode, source: string): string | undefined {
  const body = getChildByField(clause, 'body');
  const end = body ? body.startIndex : clause.endIndex;
  return collapseWs(source.substring(clause.startIndex, end)) || undefined;
}

function handleFunDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const clauses = node.namedChildren.filter((c) => c.type === 'function_clause');
  const first = clauses[0];
  if (!first) return true; // macro-templated clause (`?M(...) -> ...`) — no static name
  const nameNode = getChildByField(first, 'name');
  if (!nameNode) return true;
  const name = atomText(nameNode, ctx.source);
  if (!name) return true;
  const arity = nodeArity(first);

  // Continuation clause of the SAME function (same name AND arity): extend the
  // existing node's span and attribute this clause's calls to it.
  if (ctx.filePath === lastFnFile && name === lastFnName && arity === lastFnArity && lastFnId) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastFnId) {
        if (node.endPosition.row + 1 > n.endLine) n.endLine = node.endPosition.row + 1;
        break;
      }
    }
    ctx.pushScope(lastFnId);
    for (const clause of clauses) ctx.visitFunctionBody(clause, lastFnId);
    ctx.popScope();
    return true;
  }

  const spec = precedingSpec(node, name, arity, ctx.source);
  const exports = moduleExports(node, ctx.source, ctx.filePath);
  const fn = ctx.createNode('function', name, node, {
    docstring: getPrecedingDocstring(spec ?? node, ctx.source),
    signature: spec
      ? collapseWs(getNodeText(spec, ctx.source)).slice(0, 300)
      : clauseHeader(first, ctx.source),
    isExported: exports === 'all' || exports.has(`${name}/${arity}`) || exports.has(name),
  });
  if (!fn) return true;
  // Arity is part of the function's identity — carry it on the qualified name
  // (`mod::f/2`), the canonical Erlang spelling and the only persisted slot.
  // The node NAME stays bare so name search and bare-name matching still work.
  fn.qualifiedName = `${fn.qualifiedName}/${arity}`;
  ctx.pushScope(fn.id);
  // The whole clause is walked (not just the body) so record patterns in the
  // arguments and guard calls contribute references too.
  for (const clause of clauses) ctx.visitFunctionBody(clause, fn.id);
  ctx.popScope();
  lastFnFile = ctx.filePath;
  lastFnName = name;
  lastFnArity = arity;
  lastFnId = fn.id;
  return true;
}

function handleRecordDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const rec = ctx.createNode('struct', atomText(nameNode, ctx.source), node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
  });
  if (rec) {
    ctx.pushScope(rec.id);
    for (const field of node.namedChildren) {
      if (field.type !== 'record_field') continue;
      const fieldName = getChildByField(field, 'name');
      if (fieldName) ctx.createNode('field', atomText(fieldName, ctx.source), field);
    }
    ctx.popScope();
  }
  return true; // field types/defaults are type-position exprs — don't descend
}

function handleTypeAlias(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const typeName = getChildByField(node, 'name'); // type_name wrapper
  const nameNode = typeName ? getChildByField(typeName, 'name') : null;
  if (nameNode) {
    ctx.createNode('type_alias', atomText(nameNode, ctx.source), node, {
      signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    });
  }
  return true;
}

function handlePpDefine(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const lhs = getChildByField(node, 'lhs');
  const nameNode = lhs ? getChildByField(lhs, 'name') : null;
  if (!nameNode) return true;
  const macro = ctx.createNode('constant', getNodeText(nameNode, ctx.source), node, {
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
  });
  // The replacement's calls execute at expansion sites, but attributing them
  // to the MACRO node keeps them true exactly once: `-define(LOG_AUDIT(E),
  // audit_logger:log(E))` gives the LOG_AUDIT constant a `calls` edge to the
  // logger, and each `?LOG_AUDIT(...)` use site links to the constant (see the
  // macro_call_expr case in extractCall) — so the chain
  // `caller → LOG_AUDIT → audit_logger:log` traverses without minting a
  // per-use duplicate of the body's calls.
  const replacement = getChildByField(node, 'replacement');
  if (macro && replacement) {
    ctx.pushScope(macro.id);
    ctx.visitFunctionBody(replacement, macro.id);
    ctx.popScope();
  }
  return true;
}

function handleBehaviour(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (nameNode && parentId) {
    // `-behaviour(x)` implements x's callback contract. Resolves when the
    // behaviour module is in the repo; OTP behaviours (gen_server, …) simply
    // stay unresolved.
    ctx.addUnresolvedReference({
      fromNodeId: parentId,
      referenceName: atomText(nameNode, ctx.source),
      referenceKind: 'implements',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
  return true;
}

/**
 * OTP application resource file (`<app>.app.src` / `<app>.app`): a single
 * `{application, Name, Props}.` term the grammar parses as a top-level
 * expression. Two properties carry graph structure — `{mod, {Mod, _Args}}`
 * names the application-callback module (the app's entry point), and
 * `{applications, [...]}` / `{included_applications, [...]}` declare the apps
 * this one depends on. In an umbrella repo those resolve to the sibling app's
 * module of the same name (the OTP convention); kernel/stdlib and other
 * out-of-repo apps stay unresolved.
 */
function handleAppResourceTuple(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const props = node.namedChildren[2];
  if (!parentId || props?.type !== 'list') return true;
  const ref = (nameNode: SyntaxNode, kind: 'references' | 'imports'): void => {
    const name = atomText(nameNode, ctx.source);
    if (!name) return;
    ctx.addUnresolvedReference({
      fromNodeId: parentId,
      referenceName: name,
      referenceKind: kind,
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column,
    });
  };
  for (const prop of props.namedChildren) {
    if (prop.type !== 'tuple' || prop.namedChildren.length < 2) continue;
    const key = prop.namedChildren[0];
    const value = prop.namedChildren[1];
    if (!key || key.type !== 'atom' || !value) continue;
    const keyName = atomText(key, ctx.source);
    if (keyName === 'mod' && value.type === 'tuple') {
      const mod = value.namedChildren[0];
      if (mod?.type === 'atom') ref(mod, 'references');
    } else if (
      (keyName === 'applications' || keyName === 'included_applications') &&
      value.type === 'list'
    ) {
      for (const app of value.namedChildren) {
        if (app.type === 'atom') ref(app, 'imports');
      }
    }
  }
  return true; // nothing else in an app term carries graph structure
}

export const erlangExtractor: LanguageExtractor = {
  functionTypes: ['fun_decl'], // dispatched via visitNode (name lives on the clause)
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['record_decl'], // dispatched via visitNode (fields are direct children)
  enumTypes: [],
  typeAliasTypes: ['type_alias', 'opaque'], // dispatched via visitNode
  importTypes: ['import_attribute', 'pp_include', 'pp_include_lib'],
  callTypes: [
    'call',
    'internal_fun', // fun f/1
    'external_fun', // fun mod:f/1
    'record_expr', // #rec{...} construction
    'record_update_expr', // X#rec{...}
    'record_index_expr', // #rec.field
    'record_field_expr', // X#rec.field
    'macro_call_expr', // ?MACRO / ?MACRO(...) — links use sites to the -define constant
  ],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',

  // `-module(m)` wraps the file's declarations in a namespace so every
  // function's qualifiedName is `m::f` — which is exactly the reference shape
  // the extractCall erlang branch emits for remote calls, so `mod:f(...)`
  // resolves through matchByQualifiedName with no resolver changes.
  packageTypes: ['module_attribute'],
  extractPackage: (node, source) => {
    const name = getChildByField(node, 'name');
    return name ? atomText(name, source) : null;
  },

  extractImport: (node, source) => {
    if (node.type === 'import_attribute') {
      const mod = getChildByField(node, 'module');
      if (!mod) return null;
      return {
        moduleName: atomText(mod, source),
        signature: collapseWs(getNodeText(node, source)).slice(0, 200),
      };
    }
    // pp_include / pp_include_lib — a C-include-style file dependency on a .hrl.
    const file = getChildByField(node, 'file');
    if (!file) return null;
    const headerPath = getNodeText(file, source).replace(/^"/, '').replace(/"$/, '');
    if (!headerPath) return null;
    return { moduleName: headerPath, signature: getNodeText(node, source).trim() };
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'fun_decl':
        return handleFunDecl(node, ctx);
      case 'record_decl':
        return handleRecordDecl(node, ctx);
      case 'type_alias':
      case 'opaque':
        return handleTypeAlias(node, ctx);
      case 'pp_define':
        return handlePpDefine(node, ctx);
      case 'behaviour_attribute':
        return handleBehaviour(node, ctx);
      // -spec / -callback: their type expressions parse as `call` nodes;
      // consume the subtree so the walker doesn't mint bogus call refs.
      case 'spec':
      case 'callback':
        return true;
      // `{application, Name, Props}.` at the top of an .app/.app.src resource
      // file (never a valid form in a module, so the gate is file + position).
      case 'tuple':
        if (
          node.parent?.type === 'source_file' &&
          /\.app(?:\.src)?$/i.test(ctx.filePath) &&
          node.namedChildren[0]?.type === 'atom' &&
          atomText(node.namedChildren[0]!, ctx.source) === 'application'
        ) {
          return handleAppResourceTuple(node, ctx);
        }
        return false;
      default:
        return false;
    }
  },
};
