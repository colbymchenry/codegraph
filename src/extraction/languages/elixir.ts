import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// tree-sitter-elixir parses nearly every Elixir construct (`defmodule`,
// `def`, `if`, `case`, …) as a `call` whose first named child is an
// `identifier` naming the form. The extractor dispatches on that
// identifier text, not on `node.type`. Module attributes (`@doc`,
// `@behaviour`, `@spec`, …) surface as `unary_operator` over a `call`.

// `@doc` and `@spec` attach to the *next* def sibling. We walk attrs
// before their target, so stash by the upcoming def's tree-sitter
// startIndex (unique per tree). Cleared on every `source` visit.
let docBuffer = new Map<number, string>();
let specBuffer = new Map<number, string>();

// One alias map per defmodule/defimpl frame; innermost wins. Populated
// by `alias` directives, consulted by handleUserCall to expand
// short-name receivers (`Mod.foo/2` → `My.Deep.Module.foo/2`).
let aliasStack: Array<Map<string, string>> = [];

function callTarget(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'call') return null;
  const head = node.namedChild(0);
  if (!head || head.type !== 'identifier') return null;
  return getNodeText(head, source);
}

function findChild(node: SyntaxNode, wanted: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === wanted) return c;
  }
  return null;
}

function findChildren(node: SyntaxNode, wanted: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === wanted) out.push(c);
  }
  return out;
}

function readAliasText(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim();
}

// `@doc`/`@spec` may sit behind other module attrs before the target def
// (e.g. `@doc … @spec … def …`); hop past intermediate unary_operators.
function findNextDefSibling(attrNode: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = attrNode.nextNamedSibling;
  while (cur) {
    if (cur.type === 'call') {
      const head = cur.namedChild(0);
      if (head?.type === 'identifier') {
        const txt = head.text;
        if (txt === 'def' || txt === 'defp' || txt === 'defmacro' || txt === 'defmacrop') {
          return cur;
        }
      }
      return null;
    }
    if (cur.type !== 'unary_operator') return null;
    cur = cur.nextNamedSibling;
  }
  return null;
}

// Predict the qualifiedName TreeSitterExtractor.buildQualifiedName will
// assign to a node created right now — needed for multi-clause dedup
// since createNode has no find-or-create mode.
function expectedQualifiedName(name: string, ctx: ExtractorContext): string {
  const parts: string[] = [];
  for (const id of ctx.nodeStack) {
    const n = ctx.nodes.find((x) => x.id === id);
    if (n && n.kind !== 'file') parts.push(n.name);
  }
  parts.push(name);
  return parts.join('::');
}

function findExistingFunction(name: string, ctx: ExtractorContext): boolean {
  const qname = expectedQualifiedName(name, ctx);
  return ctx.nodes.some((n) => n.kind === 'function' && n.qualifiedName === qname);
}

function stripHeredoc(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"""') && s.endsWith('"""')) s = s.slice(3, -3);
  else if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.replace(/\\"/g, '"').trim();
}

// `def foo` → arity 0; `def foo(a, b)` → arity 2.
// Inline `def foo(a), do: …` puts the head call + keywords in arguments;
// block `def foo(a) do … end` puts the head call in arguments and the
// do_block as a sibling.
function parseDefHead(callNode: SyntaxNode, source: string): { name: string; arity: number } | null {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args || args.namedChildCount === 0) return null;
  const head = args.namedChild(0);
  if (!head) return null;
  if (head.type === 'identifier') {
    return { name: getNodeText(head, source), arity: 0 };
  }
  if (head.type === 'call') {
    const nameNode = head.namedChild(0);
    if (!nameNode || nameNode.type !== 'identifier') return null;
    const name = getNodeText(nameNode, source);
    const innerArgs = getChildByField(head, 'arguments') ?? findChild(head, 'arguments');
    return { name, arity: innerArgs ? innerArgs.namedChildCount : 0 };
  }
  // Operator-style def heads (`def a + b`) wrap in binary_operator; skip.
  return null;
}

function resolveDefBody(callNode: SyntaxNode): SyntaxNode | null {
  const doBlock = findChild(callNode, 'do_block');
  if (doBlock) return doBlock;
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args) return null;
  const keywords = findChild(args, 'keywords');
  if (!keywords) return null;
  // First pair's value is the body for the common `do: expr` shape.
  const firstPair = findChild(keywords, 'pair');
  if (!firstPair) return null;
  return getChildByField(firstPair, 'value') ?? firstPair.namedChild(1);
}

function handleDefmodule(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = getChildByField(node, 'arguments') ?? findChild(node, 'arguments');
  const aliasNode = args ? findChild(args, 'alias') : null;
  if (!aliasNode) return true;
  const moduleName = readAliasText(aliasNode, ctx.source);

  const moduleNode = ctx.createNode('module', moduleName, node);
  if (!moduleNode) return true;

  ctx.pushScope(moduleNode.id);
  aliasStack.push(new Map());
  try {
    const body = findChild(node, 'do_block');
    if (body) ctx.visitNode(body);
  } finally {
    aliasStack.pop();
    ctx.popScope();
  }
  return true;
}

function handleDef(
  node: SyntaxNode,
  defKind: 'def' | 'defp' | 'defmacro' | 'defmacrop',
  ctx: ExtractorContext
): boolean {
  const head = parseDefHead(node, ctx.source);
  if (!head) return true;
  const name = `${head.name}/${head.arity}`;
  const isPrivate = defKind === 'defp' || defKind === 'defmacrop';

  if (findExistingFunction(name, ctx)) {
    // Multi-clause: walk the later clauses' bodies under the existing
    // function so nested calls anchor to the right caller.
    const existing = ctx.nodes.find(
      (n) => n.kind === 'function' && n.qualifiedName === expectedQualifiedName(name, ctx)
    );
    const body = resolveDefBody(node);
    if (body && existing) {
      ctx.pushScope(existing.id);
      try { ctx.visitNode(body); } finally { ctx.popScope(); }
    }
    return true;
  }

  const docstring = docBuffer.get(node.startIndex);
  const signature = specBuffer.get(node.startIndex);
  if (docstring !== undefined) docBuffer.delete(node.startIndex);
  if (signature !== undefined) specBuffer.delete(node.startIndex);

  const fnNode = ctx.createNode('function', name, node, {
    visibility: isPrivate ? 'private' : 'public',
    docstring,
    signature,
  });
  if (!fnNode) return true;

  ctx.pushScope(fnNode.id);
  try {
    const body = resolveDefBody(node);
    if (body) ctx.visitNode(body);
  } finally {
    ctx.popScope();
  }
  return true;
}

function nearestModuleId(ctx: ExtractorContext): string | null {
  for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
    const id = ctx.nodeStack[i]!;
    if (ctx.nodes.find((x) => x.id === id)?.kind === 'module') return id;
  }
  return null;
}

function handleAttribute(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'unary_operator') return false;
  const operand = getChildByField(node, 'operand') ?? node.namedChild(0);
  if (!operand || operand.type !== 'call') return false;
  const target = callTarget(operand, ctx.source);
  if (!target) return false;

  if (target === 'moduledoc') {
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    const str = args ? findChild(args, 'string') : null;
    if (str) {
      const doc = stripHeredoc(getNodeText(str, ctx.source));
      const modId = nearestModuleId(ctx);
      if (modId) {
        // Mutate the in-place node — createNode has no update mode and
        // the module was created before its @moduledoc was visited.
        const mod = ctx.nodes.find((n) => n.id === modId);
        if (mod) (mod as { docstring?: string }).docstring = doc;
      }
    }
    return true;
  }

  if (target === 'doc') {
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    const str = args ? findChild(args, 'string') : null;
    if (str) {
      const doc = stripHeredoc(getNodeText(str, ctx.source));
      const nextDef = findNextDefSibling(node);
      if (nextDef) docBuffer.set(nextDef.startIndex, doc);
    }
    return true;
  }

  if (target === 'spec') {
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    if (args) {
      const sig = getNodeText(args, ctx.source).trim();
      const nextDef = findNextDefSibling(node);
      if (nextDef) specBuffer.set(nextDef.startIndex, sig);
    }
    return true;
  }

  if (target === 'callback' || target === 'macrocallback') {
    // `@callback name(args) :: t` — operand.arguments wraps a
    // binary_operator whose left side is the head `call name(args)`.
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    if (args) {
      const binOp = findChild(args, 'binary_operator');
      const headCall = binOp
        ? (getChildByField(binOp, 'left') ?? binOp.namedChild(0))
        : args.namedChild(0);
      if (headCall && headCall.type === 'call') {
        const nameNode = headCall.namedChild(0);
        const innerArgs = getChildByField(headCall, 'arguments') ?? findChild(headCall, 'arguments');
        if (nameNode && nameNode.type === 'identifier') {
          const arity = innerArgs ? innerArgs.namedChildCount : 0;
          const fnName = `${getNodeText(nameNode, ctx.source)}/${arity}`;
          if (!findExistingFunction(fnName, ctx)) {
            ctx.createNode('function', fnName, node, {
              visibility: 'public',
              isAbstract: true,
              signature: getNodeText(args, ctx.source).trim(),
            });
          }
        }
      }
    }
    return true;
  }

  if (target === 'behaviour' || target === 'behavior') {
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    const protoNode = args ? findChild(args, 'alias') : null;
    if (protoNode) {
      const modId = nearestModuleId(ctx);
      if (modId) {
        ctx.addUnresolvedReference({
          fromNodeId: modId,
          referenceName: readAliasText(protoNode, ctx.source),
          referenceKind: 'implements',
          line: protoNode.startPosition.row + 1,
          column: protoNode.startPosition.column,
          filePath: ctx.filePath,
          language: 'elixir',
        });
      }
    }
    return true;
  }

  // Swallow other attributes so the default walker doesn't reinterpret
  // their operand call (e.g. `spec hello(...)`) as a user call site.
  return true;
}

function handleImportLike(
  callNode: SyntaxNode,
  mechanism: 'alias' | 'import' | 'require' | 'use',
  ctx: ExtractorContext
): boolean {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args || args.namedChildCount === 0) return true;
  const first = args.namedChild(0)!;
  const signature = getNodeText(callNode, ctx.source).trim();

  // `alias Foo.Bar, as: Short` — optional rename overrides the default
  // short name (last dotted segment).
  let asOverride: string | null = null;
  if (mechanism === 'alias' && args.namedChildCount > 1) {
    const kw = findChild(args, 'keywords');
    if (kw) {
      for (const pair of findChildren(kw, 'pair')) {
        const key = getChildByField(pair, 'key') ?? pair.namedChild(0);
        const value = getChildByField(pair, 'value') ?? pair.namedChild(1);
        if (key && value && getNodeText(key, ctx.source).trim().startsWith('as')) {
          asOverride = readAliasText(value, ctx.source);
          break;
        }
      }
    }
  }

  const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1]! : null;
  const aliasFrame = mechanism === 'alias' && aliasStack.length > 0
    ? aliasStack[aliasStack.length - 1]!
    : null;

  const emit = (moduleName: string, posNode: SyntaxNode, shortName: string): void => {
    const imp = ctx.createNode('import', moduleName, posNode, { signature });
    if (!imp) return;
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: posNode.startPosition.row + 1,
        column: posNode.startPosition.column,
        filePath: ctx.filePath,
        language: 'elixir',
      });
    }
    if (aliasFrame) aliasFrame.set(shortName, moduleName);
  };

  if (first.type === 'alias') {
    const full = readAliasText(first, ctx.source);
    const lastSeg = full.split('.').pop() ?? full;
    emit(full, first, asOverride ?? lastSeg);
  } else if (first.type === 'dot') {
    // `alias Foo.{Bar, Baz}` — left=prefix, right=tuple of suffix aliases.
    const left = getChildByField(first, 'left') ?? first.namedChild(0);
    const right = getChildByField(first, 'right') ?? first.namedChild(1);
    if (left && right && right.type === 'tuple') {
      const prefix = readAliasText(left, ctx.source);
      for (const suffix of findChildren(right, 'alias')) {
        const suf = readAliasText(suffix, ctx.source);
        const lastSeg = suf.split('.').pop() ?? suf;
        emit(`${prefix}.${suf}`, suffix, lastSeg);
      }
    } else if (left) {
      const full = readAliasText(first, ctx.source);
      const lastSeg = full.split('.').pop() ?? full;
      emit(full, first, asOverride ?? lastSeg);
    }
  }
  return true;
}

// `defstruct [:a, :b]` / `defexception` — the *module* IS the struct,
// so we name the struct node after the enclosing module.
function handleDefstruct(callNode: SyntaxNode, ctx: ExtractorContext): boolean {
  let moduleName: string | null = null;
  for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
    const n = ctx.nodes.find((x) => x.id === ctx.nodeStack[i]);
    if (n?.kind === 'module') { moduleName = n.name; break; }
  }
  if (!moduleName) return true;

  const structNode = ctx.createNode('struct', moduleName, callNode);
  if (!structNode) return true;

  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args) return true;
  // `defstruct [:a, :b]` → list of atoms; `defstruct a: nil, b: 0` → keywords.
  const listNode = findChild(args, 'list') ?? findChild(args, 'keywords');
  if (!listNode) return true;

  ctx.pushScope(structNode.id);
  try {
    for (let i = 0; i < listNode.namedChildCount; i++) {
      const child = listNode.namedChild(i);
      if (!child) continue;
      let fieldName: string | null = null;
      let posNode: SyntaxNode = child;
      if (child.type === 'atom') {
        fieldName = getNodeText(child, ctx.source).replace(/^:/, '');
      } else if (child.type === 'pair') {
        const key = getChildByField(child, 'key') ?? child.namedChild(0);
        if (key) {
          fieldName = getNodeText(key, ctx.source).replace(/[:\s]/g, '');
          posNode = key;
        }
      }
      if (fieldName) ctx.createNode('field', fieldName, posNode);
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

function handleDefprotocol(callNode: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  const aliasNode = args ? findChild(args, 'alias') : null;
  if (!aliasNode) return true;
  const name = readAliasText(aliasNode, ctx.source);

  const protoNode = ctx.createNode('protocol', name, callNode);
  if (!protoNode) return true;

  ctx.pushScope(protoNode.id);
  try {
    const body = findChild(callNode, 'do_block');
    if (!body) return true;
    for (let i = 0; i < body.namedChildCount; i++) {
      const stmt = body.namedChild(i);
      if (!stmt || stmt.type !== 'call') continue;
      if (callTarget(stmt, ctx.source) !== 'def') {
        ctx.visitNode(stmt);
        continue;
      }
      const head = parseDefHead(stmt, ctx.source);
      if (!head) continue;
      const fnName = `${head.name}/${head.arity}`;
      if (!findExistingFunction(fnName, ctx)) {
        ctx.createNode('function', fnName, stmt, { visibility: 'public', isAbstract: true });
      }
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

// `defimpl Proto, for: Type` creates a module conventionally named
// `Proto.Type` with an implements edge back to Proto.
function handleDefimpl(callNode: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args) return true;
  const protoNode = findChild(args, 'alias');
  if (!protoNode) return true;
  const protoName = readAliasText(protoNode, ctx.source);

  let forType = 'Any';
  const keywords = findChild(args, 'keywords');
  if (keywords) {
    for (const pair of findChildren(keywords, 'pair')) {
      const key = getChildByField(pair, 'key') ?? pair.namedChild(0);
      const value = getChildByField(pair, 'value') ?? pair.namedChild(1);
      if (key && value && getNodeText(key, ctx.source).trim().startsWith('for')) {
        forType = readAliasText(value, ctx.source);
        break;
      }
    }
  }

  const implModule = ctx.createNode('module', `${protoName}.${forType}`, callNode);
  if (!implModule) return true;

  ctx.addUnresolvedReference({
    fromNodeId: implModule.id,
    referenceName: protoName,
    referenceKind: 'implements',
    line: protoNode.startPosition.row + 1,
    column: protoNode.startPosition.column,
    filePath: ctx.filePath,
    language: 'elixir',
  });

  ctx.pushScope(implModule.id);
  aliasStack.push(new Map());
  try {
    const body = findChild(callNode, 'do_block');
    if (body) ctx.visitNode(body);
  } finally {
    aliasStack.pop();
    ctx.popScope();
  }
  return true;
}

// `helper(a, b)` → "helper/2"; `String.upcase(x)` → "String.upcase/1".
// Returns null for shapes we won't second-guess (operator-style calls,
// anonymous-fn `fun.()` invocation).
function resolveCallee(callNode: SyntaxNode, source: string): { name: string; argCount: number } | null {
  const target = callNode.namedChild(0);
  if (!target) return null;
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  const argCount = args ? args.namedChildCount : 0;

  if (target.type === 'identifier') {
    return { name: getNodeText(target, source), argCount };
  }
  if (target.type === 'dot') {
    const left = getChildByField(target, 'left') ?? target.namedChild(0);
    const right = getChildByField(target, 'right') ?? target.namedChild(1);
    if (!left || !right || right.type !== 'identifier') return null;
    return { name: `${getNodeText(left, source).trim()}.${getNodeText(right, source)}`, argCount };
  }
  return null;
}

// `|>` isn't exposed as a field — detect it by reading the source slice
// between the binary_operator's left and right children. A call on the
// pipe's RHS gets +1 effective arity (LHS is the implicit first arg).
function pipeAddsArg(callNode: SyntaxNode, source: string): boolean {
  const parent = callNode.parent;
  if (!parent || parent.type !== 'binary_operator') return false;
  const right = getChildByField(parent, 'right');
  if (right?.id !== callNode.id) return false;
  const left = getChildByField(parent, 'left');
  if (!left) return false;
  return source.substring(left.endIndex, callNode.startIndex).includes('|>');
}

function enclosingFunctionId(ctx: ExtractorContext): string | null {
  for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
    const id = ctx.nodeStack[i]!;
    const n = ctx.nodes.find((x) => x.id === id);
    if (n?.kind === 'function') return id;
    if (n?.kind === 'module') return null;
  }
  return null;
}

// Elixir control-flow and metaprogramming forms parse as `call` nodes
// (since `case foo do … end` IS a call to `case`) but aren't function
// references. Excluding them keeps the graph signal-heavy.
const NON_CALL_FORMS = new Set([
  'case', 'cond', 'if', 'unless', 'with', 'for', 'try', 'receive',
  'quote', 'unquote', 'unquote_splicing', 'fn',
  'raise', 'throw', 'reraise',
]);

function lookupAlias(shortName: string): string | null {
  for (let i = aliasStack.length - 1; i >= 0; i--) {
    const full = aliasStack[i]!.get(shortName);
    if (full) return full;
  }
  return null;
}

function handleUserCall(callNode: SyntaxNode, ctx: ExtractorContext): void {
  const fnId = enclosingFunctionId(ctx);
  if (!fnId) return;
  const callee = resolveCallee(callNode, ctx.source);
  if (!callee) return;
  if (NON_CALL_FORMS.has(callee.name)) return;
  const effectiveArity = callee.argCount + (pipeAddsArg(callNode, ctx.source) ? 1 : 0);

  // If the receiver's first segment is locally aliased, also emit the
  // fully-qualified expansion as a resolution candidate so the resolver
  // can find the real target across files.
  const candidates: string[] = [];
  const dotIdx = callee.name.indexOf('.');
  if (dotIdx > 0) {
    const expanded = lookupAlias(callee.name.substring(0, dotIdx));
    if (expanded) {
      candidates.push(`${expanded}${callee.name.substring(dotIdx)}/${effectiveArity}`);
    }
  }

  ctx.addUnresolvedReference({
    fromNodeId: fnId,
    referenceName: `${callee.name}/${effectiveArity}`,
    referenceKind: 'calls',
    line: callNode.startPosition.row + 1,
    column: callNode.startPosition.column,
    filePath: ctx.filePath,
    language: 'elixir',
    candidates: candidates.length > 0 ? candidates : undefined,
  });
}

export const elixirExtractor: LanguageExtractor = {
  // All node-type arrays are empty: the default dispatcher in
  // tree-sitter.ts doesn't fit Elixir's call-shaped AST. Everything
  // is driven by the visitNode hook below.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'arguments',

  visitNode(node, ctx) {
    if (node.type === 'source') {
      // New file — discard buffers and alias frames left over from a
      // prior file (the singleton extractor is reused across files).
      docBuffer = new Map();
      specBuffer = new Map();
      aliasStack = [];
      return false;
    }
    if (node.type === 'call') {
      const target = callTarget(node, ctx.source);
      switch (target) {
        case 'defmodule':    return handleDefmodule(node, ctx);
        case 'def':
        case 'defp':
        case 'defmacro':
        case 'defmacrop':    return handleDef(node, target, ctx);
        case 'alias':
        case 'import':
        case 'require':
        case 'use':          return handleImportLike(node, target, ctx);
        case 'defstruct':
        case 'defexception': return handleDefstruct(node, ctx);
        case 'defprotocol':  return handleDefprotocol(node, ctx);
        case 'defimpl':      return handleDefimpl(node, ctx);
      }
      // Generic user call — emit a `calls` ref if inside a function,
      // then let the default walker descend so nested calls in args
      // (`f(g(x))`) are also captured.
      handleUserCall(node, ctx);
      return false;
    }
    if (node.type === 'unary_operator') return handleAttribute(node, ctx);
    return false;
  },
};
