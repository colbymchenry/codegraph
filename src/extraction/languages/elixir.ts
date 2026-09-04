import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { UnresolvedReference } from '../../types';

// Node names follow the vendored elixir-lang/tree-sitter-elixir grammar (0.3.5,
// ABI 14). Elixir has no dedicated def/module AST nodes — `defmodule`, `def`,
// `alias`, `if`, and ordinary calls are all `call` nodes whose `target` is an
// identifier (or a `dot` for `Mod.fun`). Three of those shapes don't fit the
// generic extractor, so definitions, directives, and attributes are dispatched
// through the visitNode hook; real calls (and `|> ident`, `&fun/arity`) go
// through extractCall via callTypes, reading the per-file alias/import maps
// populated below.

const DEF_FUN = new Set([
  'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp',
  'defdelegate', 'defn', 'defnp',
]);
const PRIVATE_FUN = new Set(['defp', 'defmacrop', 'defguardp', 'defnp']);
const DEF_MOD = new Set(['defmodule', 'defprotocol']);
const IMPORT_DIRECTIVES = new Set(['alias', 'import', 'require', 'use']);

/** Kernel special forms / definition macros — never call edges (tags.scm). */
const SPECIAL_FORMS = new Set([
  'def', 'defp', 'defdelegate', 'defguard', 'defguardp', 'defmacro', 'defmacrop',
  'defn', 'defnp', 'defmodule', 'defprotocol', 'defimpl', 'defstruct',
  'defexception', 'defoverridable', 'alias', 'case', 'cond', 'else', 'for',
  'if', 'import', 'quote', 'receive', 'require', 'super', 'try', 'unless',
  'unquote', 'unquote_splicing', 'use', 'with',
]);

const MFA_CALLEES = new Set([
  'apply', 'spawn', 'spawn_link', 'spawn_monitor',
]);

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function operatorOf(node: SyntaxNode, source: string): string {
  const op = getChildByField(node, 'operator');
  return op ? getNodeText(op, source) : '';
}

function atomText(node: SyntaxNode, source: string): string {
  const raw = getNodeText(node, source);
  if (raw.startsWith(':')) {
    const rest = raw.slice(1);
    return rest.replace(/^["']([\s\S]*)["']$/, '$1');
  }
  return raw.replace(/^['"]([\s\S]*)['"]$/, '$1');
}

function keywordName(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).replace(/:\s*$/, '').trim();
}

function stringContent(node: SyntaxNode, source: string): string {
  const parts = node.namedChildren
    .filter((c) => c.type === 'quoted_content')
    .map((c) => getNodeText(c, source));
  if (parts.length > 0) return parts.join('');
  return getNodeText(node, source).replace(/^["']+|["']+$/g, '');
}

function argumentsNode(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c) => c.type === 'arguments') ?? null;
}

function doBlock(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c) => c.type === 'do_block') ?? null;
}

function keywordsNode(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c) => c.type === 'keywords')
    ?? argumentsNode(node)?.namedChildren.find((c) => c.type === 'keywords')
    ?? null;
}

function pairKey(pair: SyntaxNode): SyntaxNode | null {
  return getChildByField(pair, 'key') ?? pair.namedChild(0);
}

function pairValue(pair: SyntaxNode): SyntaxNode | null {
  return getChildByField(pair, 'value') ?? pair.namedChild(1);
}

function keywordValue(keywords: SyntaxNode | null, key: string, source: string): SyntaxNode | null {
  if (!keywords) return null;
  for (const pair of keywords.namedChildren) {
    if (pair.type !== 'pair') continue;
    const k = pairKey(pair);
    const v = pairValue(pair);
    if (k && v && keywordName(k, source) === key) return v;
  }
  return null;
}

function targetNode(call: SyntaxNode): SyntaxNode | null {
  return getChildByField(call, 'target');
}

function targetIdent(call: SyntaxNode, source: string): string | null {
  const t = targetNode(call);
  if (!t) return null;
  if (t.type === 'identifier') return getNodeText(t, source);
  return null;
}

function isAttr(node: SyntaxNode, source: string): boolean {
  return node.type === 'unary_operator' && operatorOf(node, source) === '@';
}

function attrName(node: SyntaxNode, source: string): string | null {
  if (!isAttr(node, source)) return null;
  const operand = getChildByField(node, 'operand');
  if (!operand) return null;
  if (operand.type === 'identifier') return getNodeText(operand, source);
  if (operand.type === 'call') return targetIdent(operand, source);
  return null;
}

function attrCall(node: SyntaxNode): SyntaxNode | null {
  const operand = getChildByField(node, 'operand');
  return operand?.type === 'call' ? operand : null;
}

// --- Per-file memos. Extraction is file-sequential within a worker. ---

let stateFile = '';
let aliasStack: Map<string, string>[] = [new Map()];
let importOnlyStack: Map<string, string>[] = [new Map()]; // "map/2" → "Enum"
let moduleStack: string[] = [];
let lastFnName = '';
let lastFnArity = -1;
let lastFnId = '';

function resetState(filePath: string): void {
  if (filePath === stateFile) return;
  stateFile = filePath;
  aliasStack = [new Map()];
  importOnlyStack = [new Map()];
  moduleStack = [];
  lastFnName = '';
  lastFnArity = -1;
  lastFnId = '';
}

function aliases(): Map<string, string> {
  return aliasStack[aliasStack.length - 1]!;
}

function importOnly(): Map<string, string> {
  return importOnlyStack[importOnlyStack.length - 1]!;
}

/** Copy of the current maps — function-local alias/import must not leak. */
function pushCopiedDirectives(): void {
  aliasStack.push(new Map(aliases()));
  importOnlyStack.push(new Map(importOnly()));
}

function popDirectives(): void {
  aliasStack.pop();
  importOnlyStack.pop();
}

function currentModule(): string | null {
  return moduleStack[moduleStack.length - 1] ?? null;
}

function expandAlias(mod: string): string {
  const dot = mod.indexOf('.');
  const first = dot < 0 ? mod : mod.slice(0, dot);
  const rest = dot < 0 ? '' : mod.slice(dot);
  const mapped = aliases().get(first);
  return mapped ? mapped + rest : mod;
}

function nestModule(name: string): string {
  const parent = currentModule();
  return parent ? `${parent}.${name}` : name;
}

function qualifyCall(mod: string | null, fun: string, arity: number): string {
  if (!mod || mod === currentModule()) return `${fun}/${arity}`;
  return `${mod}::${fun}/${arity}`;
}

/** Call-site arity, plus 1 per enclosing `|>` that this node is the right of. */
function callArity(node: SyntaxNode, source: string): number {
  const args = argumentsNode(node);
  let arity = args ? args.namedChildCount : 0;
  let cur: SyntaxNode = node;
  for (;;) {
    const parent = cur.parent;
    if (!parent) break;
    if (parent.type === 'binary_operator' && operatorOf(parent, source) === '|>') {
      const right = getChildByField(parent, 'right');
      if (right && right.startIndex === cur.startIndex && right.endIndex === cur.endIndex) {
        arity += 1;
        cur = parent;
        continue;
      }
    }
    break;
  }
  return arity;
}

interface FunHead {
  name: string;
  arity: number;
  header: SyntaxNode;
}

function unwrapWhen(node: SyntaxNode, source: string): SyntaxNode {
  let cur = node;
  while (cur.type === 'binary_operator' && operatorOf(cur, source) === 'when') {
    const left = getChildByField(cur, 'left');
    if (!left) break;
    cur = left;
  }
  return cur;
}

function parseFunHead(defCall: SyntaxNode, source: string): FunHead | null {
  const args = argumentsNode(defCall);
  if (!args) return null;
  const positional = args.namedChildren.filter((c) => c.type !== 'keywords');
  const raw = positional[0];
  if (!raw) return null;
  const head = unwrapWhen(raw, source);
  if (head.type === 'identifier') {
    const name = getNodeText(head, source);
    if (!name || name === 'unquote') return null;
    return { name, arity: 0, header: head };
  }
  if (head.type === 'call') {
    const name = targetIdent(head, source);
    if (!name || name === 'unquote') return null;
    const headArgs = argumentsNode(head);
    return { name, arity: headArgs ? headArgs.namedChildCount : 0, header: head };
  }
  return null;
}

function precedingAttrs(node: SyntaxNode, source: string): { doc?: string; spec?: SyntaxNode } {
  const out: { doc?: string; spec?: SyntaxNode } = {};
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'comment') {
      prev = prev.previousNamedSibling;
      continue;
    }
    if (isAttr(prev, source)) {
      const name = attrName(prev, source);
      if (name === 'doc' && out.doc === undefined) {
        const call = attrCall(prev);
        const args = call ? argumentsNode(call) : null;
        const first = args?.namedChild(0);
        if (first && (first.type === 'string' || first.type === 'charlist')) {
          const text = stringContent(first, source).trim();
          if (text && text !== 'false') out.doc = text;
        } else if (first && getNodeText(first, source) === 'false') {
          out.doc = '';
        }
      } else if (name === 'spec' && !out.spec) {
        out.spec = prev;
      }
      prev = prev.previousNamedSibling;
      continue;
    }
    break;
  }
  return out;
}

function defSignature(defCall: SyntaxNode, spec: SyntaxNode | undefined, source: string): string | undefined {
  if (spec) return collapseWs(getNodeText(spec, source)).slice(0, 300);
  const body = doBlock(defCall) ?? keywordsNode(defCall);
  const end = body ? body.startIndex : defCall.endIndex;
  return collapseWs(source.substring(defCall.startIndex, end)) || undefined;
}

function isContinuation(node: SyntaxNode, name: string, arity: number, source: string): boolean {
  let prev = node.previousNamedSibling;
  while (prev && (prev.type === 'comment' || isAttr(prev, source))) {
    prev = prev.previousNamedSibling;
  }
  if (!prev || prev.type !== 'call') return false;
  const ident = targetIdent(prev, source);
  if (!ident || !DEF_FUN.has(ident)) return false;
  const head = parseFunHead(prev, source);
  return !!head && head.name === name && head.arity === arity;
}

function recordAlias(asName: string, fullName: string): void {
  if (asName && fullName) aliases().set(asName, fullName);
}

function collectAlias(call: SyntaxNode, source: string): void {
  const args = argumentsNode(call);
  if (!args) return;
  const as = keywordValue(keywordsNode(call), 'as', source);
  const positional = args.namedChildren.filter((c) => c.type !== 'keywords');
  const target = positional[0];
  if (!target) return;
  if (as && as.type === 'alias') {
    const full = getNodeText(target, source);
    recordAlias(getNodeText(as, source), full);
    return;
  }
  if (target.type === 'alias') {
    const full = getNodeText(target, source);
    const last = full.includes('.') ? full.slice(full.lastIndexOf('.') + 1) : full;
    recordAlias(last, full);
    return;
  }
  // alias Foo.{One, Two}
  if (target.type === 'dot') {
    const left = getChildByField(target, 'left');
    const right = getChildByField(target, 'right');
    if (left?.type === 'alias' && right?.type === 'tuple') {
      const prefix = getNodeText(left, source);
      for (const child of right.namedChildren) {
        if (child.type === 'alias') {
          const name = getNodeText(child, source);
          recordAlias(name, `${prefix}.${name}`);
        }
      }
    }
  }
}

function collectImportOnly(call: SyntaxNode, source: string): void {
  const args = argumentsNode(call);
  if (!args) return;
  const modNode = args.namedChildren.find((c) => c.type === 'alias');
  if (!modNode) return;
  const mod = getNodeText(modNode, source);
  const only = keywordValue(keywordsNode(call), 'only', source);
  if (!only || only.type !== 'list') return;
  const kws = only.namedChildren.find((c) => c.type === 'keywords') ?? only;
  for (const pair of kws.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = getChildByField(pair, 'key');
    const value = getChildByField(pair, 'value');
    if (!key || value?.type !== 'integer') continue;
    const fun = keywordName(key, source);
    const arity = getNodeText(value, source);
    importOnly().set(`${fun}/${arity}`, mod);
  }
}

function visitNamedChildren(body: SyntaxNode, ctx: ExtractorContext): void {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child) ctx.visitNode(child);
  }
}

function visitBody(node: SyntaxNode, ctx: ExtractorContext): void {
  const block = doBlock(node);
  if (block) ctx.visitFunctionBody(block, ctx.nodeStack[ctx.nodeStack.length - 1] ?? '');
  const doVal = keywordValue(keywordsNode(node), 'do', ctx.source);
  if (doVal) ctx.visitFunctionBody(doVal, ctx.nodeStack[ctx.nodeStack.length - 1] ?? '');
}

function handleDefmodule(node: SyntaxNode, ctx: ExtractorContext, kind: 'module' | 'interface'): boolean {
  const args = argumentsNode(node);
  const nameNode = args?.namedChildren.find((c) => c.type === 'alias');
  if (!nameNode) return true;
  const name = nestModule(getNodeText(nameNode, ctx.source));
  const attrs = precedingAttrs(node, ctx.source);
  const mod = ctx.createNode(kind, name, node, {
    docstring: attrs.doc || getPrecedingDocstring(node, ctx.source),
    signature: defSignature(node, undefined, ctx.source),
    isExported: true,
  });
  if (!mod) return true;
  // Elixir modules are dotted (`Foo.Bar`), not `::`-nested. Override the
  // generic `Parent::Foo.Bar` qualifiedName so functions inside become
  // `Foo.Bar::baz/1` rather than `Foo::Foo.Bar::baz/1`.
  mod.qualifiedName = name;
  const body = doBlock(node);
  aliasStack.push(new Map());
  importOnlyStack.push(new Map());
  moduleStack.push(name);
  ctx.pushScope(mod.id);
  // Visit in source order so alias/import bindings apply only after they
  // appear (Elixir aliases are lexical). Pre-collecting every directive
  // left the last binding active for the whole module.
  if (body) visitNamedChildren(body, ctx);
  ctx.popScope();
  moduleStack.pop();
  aliasStack.pop();
  importOnlyStack.pop();
  return true;
}

function handleDefun(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const ident = targetIdent(node, ctx.source);
  if (!ident) return true;
  const head = parseFunHead(node, ctx.source);
  if (!head) return true;
  const { name, arity } = head;

  if (isContinuation(node, name, arity, ctx.source) && lastFnId && lastFnName === name && lastFnArity === arity) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastFnId) {
        if (node.endPosition.row + 1 > n.endLine) n.endLine = node.endPosition.row + 1;
        break;
      }
    }
    ctx.pushScope(lastFnId);
    pushCopiedDirectives();
    visitBody(node, ctx);
    popDirectives();
    ctx.popScope();
    return true;
  }

  const attrs = precedingAttrs(node, ctx.source);
  const isPrivate = PRIVATE_FUN.has(ident);
  const fn = ctx.createNode('function', name, node, {
    docstring: attrs.doc || getPrecedingDocstring(node, ctx.source),
    signature: defSignature(node, attrs.spec, ctx.source),
    isExported: !isPrivate,
    visibility: isPrivate ? 'private' : 'public',
  });
  if (!fn) return true;
  const modName = currentModule();
  fn.qualifiedName = modName ? `${modName}::${name}/${arity}` : `${name}/${arity}`;
  ctx.pushScope(fn.id);
  pushCopiedDirectives();
  visitBody(node, ctx);
  if (ident === 'defdelegate') {
    const to = keywordValue(keywordsNode(node), 'to', ctx.source);
    const as = keywordValue(keywordsNode(node), 'as', ctx.source);
    if (to && (to.type === 'alias' || to.type === 'identifier')) {
      const destMod = to.type === 'alias' ? expandAlias(getNodeText(to, ctx.source)) : getNodeText(to, ctx.source);
      const destFun = as ? atomText(as, ctx.source) : name;
      ctx.addUnresolvedReference({
        fromNodeId: fn.id,
        referenceName: qualifyCall(destMod, destFun, arity),
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
  popDirectives();
  ctx.popScope();
  lastFnName = name;
  lastFnArity = arity;
  lastFnId = fn.id;
  return true;
}

function handleDefstruct(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return true;
  const args = argumentsNode(node);
  if (!args) return true;
  const addField = (name: string, fieldNode: SyntaxNode): void => {
    if (name) ctx.createNode('field', name, fieldNode);
  };
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'atom') addField(atomText(n, ctx.source), n);
    else if (n.type === 'keywords') {
      for (const pair of n.namedChildren) {
        if (pair.type !== 'pair') continue;
        const key = pairKey(pair);
        if (key) addField(keywordName(key, ctx.source), pair);
      }
    } else if (n.type === 'list') {
      for (const c of n.namedChildren) walk(c);
    }
  };
  for (const c of args.namedChildren) walk(c);
  return true;
}

function implTargetTypes(forType: SyntaxNode | null, source: string): string[] {
  const names: string[] = [];
  if (forType?.type === 'alias') names.push(expandAlias(getNodeText(forType, source)));
  else if (forType?.type === 'list') {
    for (const c of forType.namedChildren) {
      if (c.type === 'alias') names.push(expandAlias(getNodeText(c, source)));
    }
  }
  if (names.length === 0 && currentModule()) names.push(currentModule()!);
  return names;
}

function implModuleName(protocol: string, types: string[]): string {
  if (types.length === 0) return protocol;
  if (types.length === 1) return `${protocol}.${types[0]}`;
  return `${protocol}.{${types.join(', ')}}`;
}

function handleDefimpl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argumentsNode(node);
  const protocolNode = args?.namedChildren.find((c) => c.type === 'alias');
  const protocol = protocolNode ? expandAlias(getNodeText(protocolNode, ctx.source)) : null;
  const types = implTargetTypes(keywordValue(keywordsNode(node), 'for', ctx.source), ctx.source);
  const implName = protocol ? implModuleName(protocol, types) : null;
  const impl = implName
    ? ctx.createNode('module', implName, node, {
        signature: defSignature(node, undefined, ctx.source),
        isExported: true,
      })
    : null;
  if (impl && implName) impl.qualifiedName = implName;

  const fromId = impl?.id ?? ctx.nodeStack[ctx.nodeStack.length - 1];
  if (protocol && fromId) {
    ctx.addUnresolvedReference({
      fromNodeId: fromId,
      referenceName: protocol,
      referenceKind: 'implements',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  if (impl && implName) {
    aliasStack.push(new Map());
    importOnlyStack.push(new Map());
    moduleStack.push(implName);
    ctx.pushScope(impl.id);
  }
  const body = doBlock(node);
  if (body) visitNamedChildren(body, ctx);
  if (impl) {
    ctx.popScope();
    moduleStack.pop();
    aliasStack.pop();
    importOnlyStack.pop();
  }
  return true;
}

function handleImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const ident = targetIdent(node, ctx.source);
  const args = argumentsNode(node);
  if (!ident || !args) return true;
  const mods: string[] = [];
  const positional = args.namedChildren.filter((c) => c.type !== 'keywords');
  const first = positional[0];
  if (first?.type === 'alias') mods.push(getNodeText(first, ctx.source));
  else if (first?.type === 'dot') {
    const left = getChildByField(first, 'left');
    const right = getChildByField(first, 'right');
    if (left?.type === 'alias' && right?.type === 'tuple') {
      const prefix = getNodeText(left, ctx.source);
      for (const c of right.namedChildren) {
        if (c.type === 'alias') mods.push(`${prefix}.${getNodeText(c, ctx.source)}`);
      }
    }
  }
  const as = keywordValue(keywordsNode(node), 'as', ctx.source);
  for (const mod of mods) {
    const display = as && as.type === 'alias' && mods.length === 1 ? getNodeText(as, ctx.source) : mod;
    ctx.createNode('import', display, node, {
      signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    });
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: mod,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
  if (ident === 'alias') collectAlias(node, ctx.source);
  if (ident === 'import') collectImportOnly(node, ctx.source);
  return true;
}

function handleAttribute(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = attrName(node, ctx.source);
  const call = attrCall(node);
  if (name === 'moduledoc') {
    const args = call ? argumentsNode(call) : null;
    const first = args?.namedChild(0);
    const text = first && (first.type === 'string' || first.type === 'charlist')
      ? stringContent(first, ctx.source).trim()
      : '';
    if (text && text !== 'false') {
      const modId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const mod = modId ? ctx.nodes.find((n) => n.id === modId) : undefined;
      if (mod && (mod.kind === 'module' || mod.kind === 'interface') && !mod.docstring) {
        mod.docstring = text;
      }
    }
    return true;
  }
  if (name === 'behaviour' || name === 'behavior') {
    const args = call ? argumentsNode(call) : null;
    const alias = args?.namedChildren.find((c) => c.type === 'alias');
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (alias && parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: getNodeText(alias, ctx.source),
        referenceKind: 'implements',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return true;
  }
  if (name === 'type' || name === 'typep' || name === 'opaque') {
    const args = call ? argumentsNode(call) : null;
    const first = args?.namedChild(0);
    if (first) {
      let typeNameNode: SyntaxNode | null = null;
      if (first.type === 'binary_operator' && operatorOf(first, ctx.source) === '::') {
        const left = getChildByField(first, 'left');
        if (left?.type === 'identifier') typeNameNode = left;
        else if (left?.type === 'call') {
          const t = targetNode(left);
          if (t?.type === 'identifier') typeNameNode = t;
        }
      } else if (first.type === 'identifier') {
        typeNameNode = first;
      }
      if (typeNameNode) {
        ctx.createNode('type_alias', getNodeText(typeNameNode, ctx.source), node, {
          signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
        });
      }
    }
    return true;
  }
  // @doc / @spec attach to the next def via precedingAttrs; other attributes
  // are consumed so their operand `call` nodes don't become bogus call refs.
  return true;
}

type CallRef = Pick<UnresolvedReference, 'referenceName' | 'referenceKind' | 'line' | 'column'>;

/** True when an explicit `import Mod, only: [fun: N]` covers this call. */
function emitImported(fun: string, arity: number, node: SyntaxNode, out: CallRef[]): boolean {
  const mod = importOnly().get(`${fun}/${arity}`);
  if (!mod) return false;
  out.push({
    referenceName: `${expandAlias(mod)}::${fun}/${arity}`,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
  return true;
}

/**
 * Call / capture / pipe-identifier refs for the elixir extractCall branch.
 * Returns null when the node is a special form or definition (no call edge);
 * otherwise the refs to emit (possibly empty).
 */
export function elixirCallRefs(
  node: SyntaxNode,
  source: string,
  filePath: string,
): Array<Pick<UnresolvedReference, 'referenceName' | 'referenceKind' | 'line' | 'column'>> | null {
  resetState(filePath);
  const line = node.startPosition.row + 1;
  const column = node.startPosition.column;

  if (node.type === 'unary_operator') {
    if (operatorOf(node, source) !== '&') return null;
    const operand = getChildByField(node, 'operand');
    if (!operand || operand.type !== 'binary_operator' || operatorOf(operand, source) !== '/') return null;
    const left = getChildByField(operand, 'left');
    const right = getChildByField(operand, 'right');
    if (!left || right?.type !== 'integer') return null;
    const arity = getNodeText(right, source);
    if (left.type === 'identifier') {
      return [{ referenceName: `${getNodeText(left, source)}/${arity}`, referenceKind: 'references', line, column }];
    }
    if (left.type === 'call') {
      const t = targetNode(left);
      if (t?.type === 'dot') {
        const q = qualifyDot(t, source);
        if (q) {
          return [{
            referenceName: qualifyCall(q.mod, q.fun, Number(arity) || 0),
            referenceKind: 'references',
            line,
            column,
          }];
        }
      }
      const ident = targetIdent(left, source);
      if (ident) {
        return [{ referenceName: `${ident}/${arity}`, referenceKind: 'references', line, column }];
      }
    }
    if (left.type === 'dot') {
      const q = qualifyDot(left, source);
      if (q) {
        return [{
          referenceName: qualifyCall(q.mod, q.fun, Number(arity) || 0),
          referenceKind: 'references',
          line,
          column,
        }];
      }
    }
    return null;
  }

  if (node.type === 'binary_operator') {
    if (operatorOf(node, source) !== '|>') return [];
    const right = getChildByField(node, 'right');
    if (right?.type === 'identifier') {
      const fun = getNodeText(right, source);
      const refs: Array<Pick<UnresolvedReference, 'referenceName' | 'referenceKind' | 'line' | 'column'>> = [];
      if (!emitImported(fun, 1, right, refs)) {
        refs.push({
          referenceName: `${fun}/1`,
          referenceKind: 'calls',
          line: right.startPosition.row + 1,
          column: right.startPosition.column,
        });
      }
      return refs;
    }
    return [];
  }

  if (node.type !== 'call') return [];

  const ident = targetIdent(node, source);
  if (ident && (SPECIAL_FORMS.has(ident) || DEF_FUN.has(ident) || DEF_MOD.has(ident) || ident === 'defimpl' || ident === 'defstruct' || ident === 'defexception')) {
    // Function bodies are walked via extractCall, not visitNode, so alias/
    // import inside a def never hit handleImport. Record them here against
    // the function-scoped maps pushed around visitBody.
    if (ident === 'alias') collectAlias(node, source);
    else if (ident === 'import') collectImportOnly(node, source);
    return null;
  }

  const target = targetNode(node);
  const arity = callArity(node, source);
  const refs: Array<Pick<UnresolvedReference, 'referenceName' | 'referenceKind' | 'line' | 'column'>> = [];

  if (target?.type === 'identifier' && ident) {
    if (!emitImported(ident, arity, node, refs)) {
      refs.push({ referenceName: `${ident}/${arity}`, referenceKind: 'calls', line, column });
    }
    maybeMfa(node, source, ident, null, refs);
  } else if (target?.type === 'dot') {
    const q = qualifyDot(target, source);
    if (!q) return [];
    refs.push({
      referenceName: qualifyCall(q.mod, q.fun, arity),
      referenceKind: 'calls',
      line,
      column,
    });
    if (q.mod) {
      refs.push({
        referenceName: q.mod,
        referenceKind: 'references',
        line: target.startPosition.row + 1,
        column: target.startPosition.column,
      });
    }
    maybeGenServer(q.mod, q.fun, node, source, refs);
    maybeMfa(node, source, q.fun, q.mod, refs);
  }

  return refs;
}

function qualifyDot(dot: SyntaxNode, source: string): { mod: string | null; fun: string } | null {
  const left = getChildByField(dot, 'left');
  const right = getChildByField(dot, 'right');
  if (!right || (right.type !== 'identifier' && right.type !== 'atom')) return null;
  const fun = right.type === 'atom' ? atomText(right, source) : getNodeText(right, source);
  if (!left) return { mod: null, fun };
  if (left.type === 'alias') return { mod: expandAlias(getNodeText(left, source)), fun };
  if (left.type === 'identifier' && getNodeText(left, source) === '__MODULE__') {
    return { mod: currentModule(), fun };
  }
  return null; // variable receiver — dynamic
}

function maybeGenServer(
  mod: string | null,
  fun: string,
  node: SyntaxNode,
  source: string,
  refs: Array<Pick<UnresolvedReference, 'referenceName' | 'referenceKind' | 'line' | 'column'>>,
): void {
  if (mod !== 'GenServer' && mod !== 'Elixir.GenServer') return;
  if (fun !== 'call' && fun !== 'cast') return;
  const args = argumentsNode(node);
  const target = args?.namedChild(0);
  if (!target) return;
  let targetMod: string | null = null;
  if (target.type === 'identifier' && getNodeText(target, source) === '__MODULE__') {
    targetMod = currentModule();
  } else if (target.type === 'alias') {
    targetMod = expandAlias(getNodeText(target, source));
  }
  if (!targetMod) return;
  const handler = fun === 'cast' ? 'handle_cast' : 'handle_call';
  const arity = fun === 'cast' ? 2 : 3;
  refs.push({
    referenceName: qualifyCall(targetMod, handler, arity),
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function maybeMfa(
  node: SyntaxNode,
  source: string,
  fun: string,
  mod: string | null,
  refs: Array<Pick<UnresolvedReference, 'referenceName' | 'referenceKind' | 'line' | 'column'>>,
): void {
  if (!MFA_CALLEES.has(fun)) return;
  if (mod && mod !== 'Kernel' && mod !== 'Process' && mod !== ':erlang' && mod !== 'erlang') return;
  const args = argumentsNode(node);
  if (!args || args.namedChildCount < 3) return;
  const m = args.namedChild(0);
  const f = args.namedChild(1);
  const list = args.namedChild(2);
  if (!m || !f || list?.type !== 'list') return;
  let destMod: string | null = null;
  if (m.type === 'alias') destMod = expandAlias(getNodeText(m, source));
  else if (m.type === 'identifier' && getNodeText(m, source) === '__MODULE__') destMod = currentModule();
  else if (m.type === 'atom') destMod = atomText(m, source);
  else return;
  if (f.type !== 'atom') return;
  const destFun = atomText(f, source);
  refs.push({
    referenceName: qualifyCall(destMod, destFun, list.namedChildCount),
    referenceKind: 'calls',
    line: f.startPosition.row + 1,
    column: f.startPosition.column,
  });
}

export const elixirExtractor: LanguageExtractor = {
  // Definitions are `call` nodes dispatched via visitNode; real calls still
  // use callTypes so visitFunctionBody (which does not invoke visitNode) sees
  // them. unary_operator covers `&fun/arity`; binary_operator covers `|> ident`.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call', 'unary_operator', 'binary_operator'],
  variableTypes: [],
  nameField: 'target',
  bodyField: 'do_block',
  paramsField: 'arguments',

  visitNode: (node, ctx) => {
    resetState(ctx.filePath);
    if (node.type === 'unary_operator' && operatorOf(node, ctx.source) === '@') {
      return handleAttribute(node, ctx);
    }
    if (node.type !== 'call') return false;
    const ident = targetIdent(node, ctx.source);
    if (!ident) return false;
    if (ident === 'defmodule') return handleDefmodule(node, ctx, 'module');
    if (ident === 'defprotocol') return handleDefmodule(node, ctx, 'interface');
    if (ident === 'defimpl') return handleDefimpl(node, ctx);
    if (DEF_FUN.has(ident)) return handleDefun(node, ctx);
    if (ident === 'defstruct' || ident === 'defexception') return handleDefstruct(node, ctx);
    if (IMPORT_DIRECTIVES.has(ident)) return handleImport(node, ctx);
    if (ident === 'quote' || ident === 'unquote' || ident === 'unquote_splicing') return true;
    return false;
  },
};
