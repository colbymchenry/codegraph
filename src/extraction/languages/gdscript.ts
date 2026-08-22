import * as path from 'path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { Node, UnresolvedReference } from '../../types';

// Node names follow the vendored ABI-14 grammar (tree-sitter-gdscript 6.1.0,
// PrestonKnopp) — see grammars.ts. This extractor replaces the former
// line-regex GDScriptExtractor:
//   - symbols / scopes / signatures come from the AST (robust to nesting,
//     lambdas, match bodies, strings containing code-like text)
//   - the Godot-specific reference passes (node paths $/%, signal wiring,
//     Callable targets, const-string propagation) are ported line-scans kept
//     byte-compatible with the previous output contract — ~60 assertions in
//     __tests__/extraction.test.ts pin those shapes.

const KEYWORDS = new Set([
  'if', 'elif', 'for', 'while', 'match', 'return', 'await', 'assert',
  'print', 'push_error', 'push_warning', 'preload', 'load', 'super',
  'func', 'signal',
]);

const GODOT_BUILT_IN_CALLS = new Set([
  'AABB', 'Array', 'Basis', 'Callable', 'Color', 'Dictionary', 'NodePath',
  'PackedByteArray', 'PackedColorArray', 'PackedFloat32Array', 'PackedFloat64Array',
  'PackedInt32Array', 'PackedInt64Array', 'PackedScene', 'PackedStringArray',
  'PackedVector2Array', 'PackedVector3Array', 'Plane', 'Projection', 'Quaternion',
  'Rect2', 'Rect2i', 'RID', 'Signal', 'String', 'StringName', 'Transform2D',
  'Transform3D', 'Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Vector4',
  'Vector4i',
]);

/** Per-file extraction state threaded through the recursive walk. */
interface ExtractorState {
  filePath: string;
  /** PascalCase script class synthesized from `class_name X` or the filename. */
  scriptClass: Node | null;
  /** Fallback owner when no script class exists. */
  fileId: string;
  /** Const name → literal string value (`get_node(SOME_CONST)` propagation). */
  stringConstants: Map<string, string>;
  /** Owner id → (alias name → node path) for `var row := "A/%dB"` locals. */
  nodePathAliases: Map<string, Map<string, string>>;
  /** Helper function name → parameter index used in a get_node lookup. */
  helperArgIndex: Map<string, number>;
  /** variable/constant nodes by start line (same-line ref attribution). */
  declarationByLine: Map<number, Node>;
  /** function/method scopes for line-based owner resolution. */
  functionScopes: Array<{ id: string; indent: number; startLine: number }>;
  /** Dedup guard for dynamic scene-node components. */
  dynamicNodeNames: Set<string>;
  /** Statement anchors by line, for synthesizing nodes during line passes. */
  statementByLine: Map<number, SyntaxNode>;
}

function indentOf(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 4;
    else break;
  }
  return indent;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const prev = line[i - 1];
    if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
    if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
    if (char === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function findCallEnd(code: string, openingParenIndex: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openingParenIndex; i < code.length; i++) {
    const char = code[i];
    const prev = code[i - 1];
    if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
    if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
    if (inSingle || inDouble) continue;
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

function splitCallArguments(args: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    const prev = args[i - 1];
    if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
    if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
    if (inSingle || inDouble) continue;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      result.push(args.slice(start, i));
      start = i + 1;
    }
  }
  result.push(args.slice(start));
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
}

/** Last `/`-segment of a node path — receiver name inside member-call shapes. */
function nodePathReceiverName(nodePath: string): string {
  const cleaned = nodePath.replace(/^[$%]/, '');
  const lastSegment = cleaned.split('/').filter(Boolean).pop();
  return lastSegment || cleaned || nodePath;
}

function pascalCaseFromFileName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return pascal || path.basename(filePath);
}

function isSimpleNodeName(value: string): boolean {
  return /^[A-Z_][A-Za-z0-9_]*$/.test(value);
}

function isLikelyNodePath(value: string): boolean {
  return /^[A-Z_][A-Za-z0-9_]*(?:\/[A-Z_][A-Za-z0-9_]*)*$/.test(value);
}

/** `"CardReward%d"` → `"CardReward"` (only PascalCase-ish scene-path shapes). */
function formattedNodePathBase(nodePath: string): string | null {
  if (!nodePath.includes('%d')) return null;
  const stripped = nodePath.replace(/%d/g, '');
  if (!/^[A-Z_][A-Za-z0-9_]*(?:\/[A-Z_][A-Za-z0-9_]*)*$/.test(stripped)) return null;
  return stripped;
}

function textOfField(node: SyntaxNode, field: string, source: string): string {
  const child = getChildByField(node, field);
  return child ? getNodeText(child, source) : '';
}

function firstIdentifierText(node: SyntaxNode, source: string): string {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'identifier') return getNodeText(child, source);
  }
  return '';
}

/** Annotation identifiers directly attached to a declaration ("onready", "export_range", …). */
function annotationNames(node: SyntaxNode, source: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'annotations') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const ann = child.namedChild(j);
      if (ann && ann.type === 'annotation') {
        const ident = firstIdentifierText(ann, source);
        if (ident) names.push(ident);
      }
    }
  }
  return names;
}

/** Inner literal of a GDScript string-ish node: `"X"`, `'X'`, `&"X"`. */
function stringLiteralText(valueNode: SyntaxNode, source: string): string {
  const raw = getNodeText(valueNode, source).trim();
  const match = raw.match(/^&?["'](.*)["']$/s);
  return match ? match[1]! : raw;
}

export const gdscriptExtractor: LanguageExtractor = {
  // Everything flows through the visitNode hook below: a GDScript script file
  // is a virtual class wrapping `source`, and its Godot-specific semantics
  // (node-path expressions, string-keyed signal/callable wiring) don't fit the
  // generic declaration dispatch ladder.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // preload/load are plain calls — handled by the reference passes
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node, ctx) => {
    if (node.type !== 'source' || node.parent !== null) return false;

    const state: ExtractorState = {
      filePath: ctx.filePath,
      scriptClass: null,
      fileId: ctx.nodeStack[ctx.nodeStack.length - 1]!,
      stringConstants: new Map(),
      nodePathAliases: new Map(),
      helperArgIndex: new Map(),
      declarationByLine: new Map(),
      functionScopes: [],
      dynamicNodeNames: new Set(),
      statementByLine: new Map(),
    };
    extractFile(node, ctx, state);
    return true;
  },
};

// ---------------------------------------------------------------------------
// AST walk — symbols
// ---------------------------------------------------------------------------

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

/**
 * Root handler. Synthesizes the script-class wrapper (explicit
 * `class_name X`, or an implicit PascalCase-of-filename class when the file
 * starts with `extends`), walks members under it, then runs the ported
 * reference passes over the raw source lines.
 */
function extractFile(root: SyntaxNode, ctx: ExtractorContext, state: ExtractorState): void {
  const source = ctx.source;
  const children = childrenOf(root);

  const classNameNode = children.find((c) => c.type === 'class_name_statement');
  const topLevelExtends = children.find((c) => c.type === 'extends_statement');
  const hasToolAnnotation = children.some(
    (c) => c.type === 'annotation' && firstIdentifierText(c, source) === 'tool'
  );

  let createdClass: Node | null = null;
  if (classNameNode) {
    const name = textOfField(classNameNode, 'name', source);
    createdClass = ctx.createNode('class', name, classNameNode);
  } else if (topLevelExtends) {
    const extendsTarget = textOfType(topLevelExtends, 'type', source);
    createdClass = ctx.createNode('class', pascalCaseFromFileName(ctx.filePath), topLevelExtends);
    if (createdClass) createdClass.signature = `implicit script class extends ${extendsTarget}`;
  }
  if (createdClass && hasToolAnnotation) createdClass.decorators = ['tool'];
  state.scriptClass = createdClass;

  // Inline `@tool class_name X extends Y`: the extends_statement nests INSIDE
  // class_name_statement — emit it here (the dispatch case swallows that node).
  if (classNameNode) {
    const inlineExtends = getChildByField(classNameNode, 'extends');
    if (inlineExtends && state.scriptClass) {
      const target = textOfType(inlineExtends, 'type', source);
      if (target) {
        emitRef(ctx, state.scriptClass.id, target, 'extends', inlineExtends.startPosition.row + 1, inlineExtends.startPosition.column, state);
      }
    }
  }

  ctx.pushScope(state.scriptClass?.id ?? state.fileId);
  for (const child of children) {
    dispatch(child, ctx, state);
  }
  runReferencePasses(ctx, state);
  ctx.popScope();
}

function textOfType(node: SyntaxNode, type: string, source: string): string {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === type) return getNodeText(child, source);
    const nested = textOfType(child, type, source);
    if (nested) return nested;
  }
  return '';
}

function dispatch(node: SyntaxNode, ctx: ExtractorContext, state: ExtractorState): boolean {
  recordStatementAnchor(node, state);

  switch (node.type) {
    case 'class_name_statement':
    case 'annotation':
      return true; // handled at root scan / contextual reads

    case 'extends_statement': {
      const target = textOfType(node, 'type', ctx.source);
      if (target) {
        emitRef(ctx, currentOwner(ctx), target, 'extends', node.startPosition.row + 1, node.startPosition.column);
      }
      return true;
    }

    case 'signal_statement': {
      const name = textOfField(node, 'name', ctx.source);
      ctx.createNode('signal', name, node, {
        signature: getNodeText(node, ctx.source).trim().replace(/\s+/g, ' '),
      });
      return true;
    }

    case 'enum_definition': {
      const name = textOfField(node, 'name', ctx.source) || '<anonymous_enum>';
      const enumNode = ctx.createNode('enum', name, node);
      if (enumNode) {
        ctx.pushScope(enumNode.id);
        const body = getChildByField(node, 'body');
        if (body) {
          for (const entry of childrenOf(body)) {
            if (entry.type !== 'enumerator') continue;
            ctx.createNode('enum_member', textOfField(entry, 'left', ctx.source), entry);
          }
        }
        ctx.popScope();
      }
      return true;
    }

    case 'const_statement':
      return extractVariableDeclaration(node, ctx, state, 'constant');

    case 'variable_statement':
      return extractVariableDeclaration(node, ctx, state, 'variable');

    case 'function_definition':
    case 'constructor_definition': // `func _init(...)` — Godot's constructor
      return extractFunctionDefinition(node, ctx, state);

    case 'lambda': {
      // Anonymous — no symbol node (parity with the old extractor); its body
      // still contributes references attributed to the enclosing scope.
      const body = getChildByField(node, 'body');
      if (body) dispatchChildren(body, ctx, state);
      return true;
    }

    case 'class_definition': {
      const innerClass = ctx.createNode('class', textOfField(node, 'name', ctx.source), node);
      if (!innerClass) return true;
      // `class Inner extends Control:` — attribute the extends target to the
      // PARENT scope (parity: the old extractor saw it as a plain line owned
      // above the class scope).
      const extendsChild = getChildByField(node, 'extends');
      if (extendsChild) {
        const target = textOfType(extendsChild, 'type', ctx.source);
        if (target) {
          emitRef(ctx, parentOwner(ctx), target, 'extends', extendsChild.startPosition.row + 1, extendsChild.startPosition.column);
        }
      }
      ctx.pushScope(innerClass.id);
      const body = getChildByField(node, 'body');
      if (body) dispatchChildren(body, ctx, state);
      ctx.popScope();
      return true;
    }

    default:
      // Unclaimed construct (expression wrappers, if/for/match bodies, …):
      // signal "not handled" so dispatchChildren keeps descending — symbols
      // can nest arbitrarily deep (locals inside control flow).
      return false;
  }
}

function dispatchChildren(parent: SyntaxNode, ctx: ExtractorContext, state: ExtractorState): void {
  for (const child of childrenOf(parent)) {
    const handled = dispatch(child, ctx, state);
    if (!handled) dispatchChildren(child, ctx, state);
  }
}

function recordStatementAnchor(node: SyntaxNode, state: ExtractorState): void {
  const line = node.startPosition.row + 1;
  if (!state.statementByLine.has(line)) state.statementByLine.set(line, node);
}

function currentOwner(ctx: ExtractorContext): string {
  return ctx.nodeStack[ctx.nodeStack.length - 1] ?? ctx.filePath;
}

function parentOwner(ctx: ExtractorContext): string {
  return ctx.nodeStack[ctx.nodeStack.length - 2] ?? currentOwner(ctx);
}

function emitRef(
  ctx: ExtractorContext,
  fromNodeId: string,
  referenceName: string,
  referenceKind: UnresolvedReference['referenceKind'],
  line: number,
  column: number,
  state?: ExtractorState
): void {
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line,
    column,
    ...(state ? { filePath: state.filePath, language: 'gdscript' as const } : {}),
  });
}

function extractFunctionDefinition(node: SyntaxNode, ctx: ExtractorContext, state: ExtractorState): boolean {
  const source = ctx.source;
  // constructor_definition has no name field — the name is implied `_init`.
  const name = node.type === 'constructor_definition' ? '_init' : textOfField(node, 'name', source);
  const params = textOfField(node, 'parameters', source);
  const returnType = textOfField(node, 'return_type', source);
  const isStatic = node.namedChildren.some((c) => c.type === 'static_keyword');

  // Parity with the old extractor: funcs in a script WITHOUT class_name or
  // extends (no script class at all) extract as plain 'function' kind.
  const parentId = currentOwner(ctx);
  const parentNode = ctx.nodes.find((n) => n.id === parentId);
  const kind: 'method' | 'function' = parentNode && parentNode.kind !== 'file' ? 'method' : 'function';

  const method = ctx.createNode(kind, name, node, {
    signature: `${params || '()'}${returnType ? ` -> ${returnType.trim()}` : ''}`,
    isStatic,
  });

  registerNodeLookupHelper(node, ctx, state, name);

  if (method) {
    ctx.pushScope(method.id);
    const body = getChildByField(node, 'body');
    if (body) dispatchChildren(body, ctx, state);
    ctx.popScope();
  }
  return true;
}

/**
 * If this function performs a node lookup directly on one of its parameters
 * (get_node(paramN)/find_child(paramN)/_find_node(x, paramN)), remember the
 * parameter index so later calls to this helper resolve their argument through
 * the same channel as literals (old `_find_node(root, "Name")` contract).
 */
function registerNodeLookupHelper(node: SyntaxNode, ctx: ExtractorContext, state: ExtractorState, functionName: string): void {
  const source = ctx.source;
  const paramsText = textOfField(node, 'parameters', source);
  const paramNames = splitCallArguments(paramsText.replace(/^\s*\(|\)\s*$/g, ''))
    .map((arg) => (arg.trim().match(/^([A-Za-z_]\w*)/) || [])[1])
    .filter((n): n is string => Boolean(n));
  if (paramNames.length === 0) return;

  const body = getChildByField(node, 'body');
  const bodyText = body ? getNodeText(body, source) : '';
  for (let paramIndex = 0; paramIndex < paramNames.length; paramIndex++) {
    const escaped = escapeRegExp(paramNames[paramIndex]!);
    const direct = new RegExp(`\\b(?:get_node|get_node_or_null|has_node|find_child)\\s*\\(\\s*${escaped}\\b`);
    const projectHelper = new RegExp(`\\b_find_node\\s*\\([^,\\n]+,\\s*${escaped}\\b`);
    if (direct.test(bodyText) || projectHelper.test(bodyText)) {
      state.helperArgIndex.set(functionName, paramIndex);
      break;
    }
  }
}

/**
 * Create a `variable`/`constant` symbol. Mirrors the old extractor:
 *   - signature = whitespace-collapsed statement text
 *   - first `@export*` annotation → decorators ['export'] / ['export_<suffix>']
 *   - constant string values populate the propagation table; `*_NAME`
 *     constants holding a simple scene-node name become dynamic `component`s
 *   - `@onready var x := $Path` emits a reference from the variable itself
 */
function extractVariableDeclaration(
  node: SyntaxNode,
  ctx: ExtractorContext,
  state: ExtractorState,
  kind: 'constant' | 'variable'
): boolean {
  const source = ctx.source;
  const name = textOfField(node, 'name', source);
  const stmtText = getNodeText(node, source).trim().replace(/\s+/g, ' ');

  const varNode = ctx.createNode(kind, name, node, { signature: stmtText });
  if (!varNode) return true;

  state.declarationByLine.set(node.startPosition.row + 1, varNode);

  const annotations = annotationNames(node, source);
  const exportAnn = annotations.find((a) => a.startsWith('export'));
  if (exportAnn) {
    varNode.decorators = [exportAnn];
  }

  if (kind === 'constant') {
    const value = getChildByField(node, 'value');
    if (value && (value.type === 'string' || value.type === 'string_name')) {
      const stringValue = stringLiteralText(value, source);
      if (stringValue) {
        state.stringConstants.set(name, stringValue);
        if (/_NAME$/.test(name) && isSimpleNodeName(stringValue)) {
          addDynamicNodeName(ctx, state, stringValue, node.startPosition.row + 1, stmtText, currentOwner(ctx));
        }
      }
    }
  }

  if (annotations.includes('onready')) {
    const onreadyPath = getNodeText(node, source).match(/[$]([A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*)/);
    if (onreadyPath) {
      emitRef(ctx, varNode.id, onreadyPath[1]!, 'references', node.startPosition.row + 1, node.startPosition.column, state);
    }
  }

  return true;
}

function addDynamicNodeName(
  ctx: ExtractorContext,
  state: ExtractorState,
  name: string,
  lineNumber: number,
  signature: string,
  ownerId: string
): void {
  if (state.dynamicNodeNames.has(name)) return;
  state.dynamicNodeNames.add(name);
  const anchor =
    state.statementByLine.get(lineNumber) ??
    state.statementByLine.get(1) ?? // fallback: file head
    undefined;
  if (!anchor) return;
  ctx.pushScope(ownerId);
  ctx.createNode('component', name, anchor, { signature });
  ctx.popScope();
}

// ---------------------------------------------------------------------------
// Reference passes — ported line scans over the raw source
// ---------------------------------------------------------------------------

function lookupAlias(state: ExtractorState, ownerId: string, name: string): string | undefined {
  return state.nodePathAliases.get(ownerId)?.get(name) ?? state.stringConstants.get(name);
}

function addNodePathAliasTo(state: ExtractorState, ownerId: string, alias: string, nodePath: string): void {
  let aliases = state.nodePathAliases.get(ownerId);
  if (!aliases) {
    aliases = new Map();
    state.nodePathAliases.set(ownerId, aliases);
  }
  if (!aliases.has(alias)) aliases.set(alias, nodePath);
}

function addNodePathReference(
  ctx: ExtractorContext,
  state: ExtractorState,
  owner: string,
  nodePath: string,
  lineNumber: number,
  column: number
): void {
  const cleaned = nodePath.replace(/^[$%]/, '');
  emitRef(ctx, owner, nodePathReceiverName(cleaned), 'references', lineNumber, column, state);
  if (cleaned.includes('/')) {
    emitRef(ctx, owner, cleaned, 'references', lineNumber, column, state);
  }
  if (state.scriptClass && cleaned) {
    emitRef(ctx, owner, `${state.scriptClass.name}/${cleaned}`, 'references', lineNumber, column, state);
  }
}

function addCallableTargetReferences(
  ctx: ExtractorContext,
  state: ExtractorState,
  owner: string,
  args: string,
  lineNumber: number,
  argsColumn: number
): void {
  const callableRegex = /\bCallable\s*\(\s*(?:self|this|[A-Za-z_]\w*)\s*,\s*["']([A-Za-z_]\w*)["']\s*\)/g;
  let callableMatch: RegExpExecArray | null;
  while ((callableMatch = callableRegex.exec(args)) !== null) {
    emitRef(ctx, owner, callableMatch[1]!, 'calls', lineNumber, argsColumn + callableMatch.index, state);
  }

  const directHandlerMatch = args.match(/^\s*([A-Za-z_]\w*)\b/);
  if (directHandlerMatch) {
    const name = directHandlerMatch[1]!;
    if (!KEYWORDS.has(name) && !GODOT_BUILT_IN_CALLS.has(name) && name !== 'func') {
      emitRef(ctx, owner, name, 'calls', lineNumber, argsColumn + args.indexOf(name), state);
    }
  }
}

function extractStringNodePathAlias(state: ExtractorState, ownerId: string, code: string): void {
  const stringAliasRegex = /\b(?:var|const)\s+([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_]\w*)?\s*:=?\s*&?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = stringAliasRegex.exec(code)) !== null) {
    const value = match[2]!;
    if (isLikelyNodePath(value)) addNodePathAliasTo(state, ownerId, match[1]!, value);
  }
}

function resolveStringArgument(state: ExtractorState, ownerId: string, argument: string | undefined): string | null {
  if (!argument) return null;
  const literal = argument.match(/^\s*&?["']([^"']+)["']\s*$/);
  if (literal) return literal[1]!;
  const identifier = argument.match(/^\s*([A-Za-z_]\w*)\s*$/);
  if (!identifier) return null;
  return lookupAlias(state, ownerId, identifier[1]!) ?? null;
}

function extractNodePathReferences(
  ctx: ExtractorContext,
  state: ExtractorState,
  owner: string,
  code: string,
  lineNumber: number,
  functionOwner: string
): void {
  extractStringNodePathAlias(state, functionOwner, code);

  let match: RegExpExecArray | null;

  const shorthandRegex = /[$%]([A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*)/g;
  while ((match = shorthandRegex.exec(code)) !== null) {
    addNodePathReference(ctx, state, owner, match[1]!, lineNumber, match.index);
  }

  const getNodeRegex = /\b(?:get_node|get_node_or_null|has_node)\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = getNodeRegex.exec(code)) !== null) {
    addNodePathReference(ctx, state, owner, match[1]!, lineNumber, match.index);
  }

  const findChildRegex = /\bfind_child\s*\(\s*["']([^"']+)["']/g;
  while ((match = findChildRegex.exec(code)) !== null) {
    addNodePathReference(ctx, state, owner, match[1]!, lineNumber, match.index);
  }

  const findChildAliasRegex = /\bfind_child\s*\(\s*([A-Za-z_]\w*)\b/g;
  while ((match = findChildAliasRegex.exec(code)) !== null) {
    const nodePath = lookupAlias(state, functionOwner, match[1]!);
    if (nodePath) addNodePathReference(ctx, state, owner, nodePath, lineNumber, match.index);
  }

  const projectFindNodeRegex = /\b_find_node\s*\(\s*[^,\n]+,\s*["']([^"']+)["']/g;
  while ((match = projectFindNodeRegex.exec(code)) !== null) {
    addNodePathReference(ctx, state, owner, match[1]!, lineNumber, match.index);
  }

  const projectFindNodeAliasRegex = /\b_find_node\s*\(\s*[^,\n]+,\s*([A-Za-z_]\w*)\b/g;
  while ((match = projectFindNodeAliasRegex.exec(code)) !== null) {
    const nodePath = lookupAlias(state, functionOwner, match[1]!);
    if (nodePath) addNodePathReference(ctx, state, owner, nodePath, lineNumber, match.index);
  }

  const getNodeFormattedRegex = /\b(?:get_node|get_node_or_null|has_node)\s*\(\s*["']([^"']*%d[^"']*)["']\s*%/g;
  while ((match = getNodeFormattedRegex.exec(code)) !== null) {
    const formattedNodePath = formattedNodePathBase(match[1]!);
    if (formattedNodePath) {
      addNodePathReference(ctx, state, owner, formattedNodePath, lineNumber, match.index);
    }
  }

  const formattedPathVariableRegex = /\b[A-Za-z_]\w*(?:_name|_path)\s*:=?\s*["']([^"']*%d[^"']*)["']\s*%/g;
  while ((match = formattedPathVariableRegex.exec(code)) !== null) {
    const formattedNodePath = formattedNodePathBase(match[1]!);
    if (formattedNodePath) {
      const rest = code.slice(match.index);
      const variableName = (rest.match(/\b([A-Za-z_]\w*(?:_name|_path))\s*:=?/) || [])[1];
      if (variableName) addNodePathAliasTo(state, functionOwner, variableName, formattedNodePath);
      addNodePathReference(ctx, state, owner, formattedNodePath, lineNumber, match.index);
    }
  }

  const getNodeConstantRegex = /\b(?:get_node|get_node_or_null|has_node)\s*\(\s*([A-Za-z_]\w*)\s*\)/g;
  while ((match = getNodeConstantRegex.exec(code)) !== null) {
    const nodePath = lookupAlias(state, functionOwner, match[1]!);
    if (nodePath) addNodePathReference(ctx, state, owner, nodePath, lineNumber, match.index);
  }

  const helperCallRegex = /\b([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  while ((match = helperCallRegex.exec(code)) !== null) {
    const argumentIndex = state.helperArgIndex.get(match[1]!);
    if (argumentIndex === undefined) continue;
    const args = splitCallArguments(match[2]!);
    const nodePath = resolveStringArgument(state, functionOwner, args[argumentIndex]);
    if (nodePath) addNodePathReference(ctx, state, owner, nodePath, lineNumber, match.index);
  }
}

function extractSignalReferences(
  ctx: ExtractorContext,
  state: ExtractorState,
  owner: string,
  code: string,
  lineNumber: number
): void {
  let match: RegExpExecArray | null;

  const memberConnectRegex = /\b(?:([A-Za-z_]\w*)|([$%][A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*))\s*\.\s*([A-Za-z_]\w*)\s*\.\s*connect\s*\(/g;
  while ((match = memberConnectRegex.exec(code)) !== null) {
    const receiver = match[1] ?? nodePathReceiverName(match[2]!);
    const signalName = match[3]!;
    emitRef(ctx, owner, signalName, 'references', lineNumber, match.index, state);
    emitRef(ctx, owner, `${receiver}.${signalName}`, 'references', lineNumber, match.index, state);

    const argsStart = memberConnectRegex.lastIndex;
    const argsEnd = findCallEnd(code, argsStart - 1);
    if (argsEnd > argsStart) {
      addCallableTargetReferences(ctx, state, owner, code.slice(argsStart, argsEnd), lineNumber, argsStart);
    }
  }

  const bareConnectRegex = /\b([A-Za-z_]\w*)\s*\.\s*connect\s*\(/g;
  while ((match = bareConnectRegex.exec(code)) !== null) {
    const signalName = match[1]!;
    if (signalName === 'node') continue;
    emitRef(ctx, owner, signalName, 'references', lineNumber, match.index, state);

    const argsStart = bareConnectRegex.lastIndex;
    const argsEnd = findCallEnd(code, argsStart - 1);
    if (argsEnd > argsStart) {
      addCallableTargetReferences(ctx, state, owner, code.slice(argsStart, argsEnd), lineNumber, argsStart);
    }
  }

  const legacyConnectRegex = /\bconnect\s*\(\s*(?:&)?["']([^"']+)["']\s*,/g;
  while ((match = legacyConnectRegex.exec(code)) !== null) {
    emitRef(ctx, owner, match[1]!, 'references', lineNumber, match.index, state);

    const argsStart = legacyConnectRegex.lastIndex;
    const argsEnd = findCallEnd(code, code.indexOf('(', match.index));
    if (argsEnd > argsStart) {
      addCallableTargetReferences(ctx, state, owner, code.slice(argsStart, argsEnd), lineNumber, argsStart);
    }
  }

  const memberEmitRegex = /\b([A-Za-z_]\w*)\s*\.\s*emit\s*\(/g;
  while ((match = memberEmitRegex.exec(code)) !== null) {
    emitRef(ctx, owner, match[1]!, 'calls', lineNumber, match.index, state);
  }

  const emitSignalRegex = /\bemit_signal\s*\(\s*(?:&)?["']([^"']+)["']/g;
  while ((match = emitSignalRegex.exec(code)) !== null) {
    emitRef(ctx, owner, match[1]!, 'calls', lineNumber, match.index, state);
  }

  const callableRegex = /\bCallable\s*\(\s*(?:self|this|[A-Za-z_]\w*)\s*,\s*["']([A-Za-z_]\w*)["']\s*\)/g;
  while ((match = callableRegex.exec(code)) !== null) {
    emitRef(ctx, owner, match[1]!, 'calls', lineNumber, match.index, state);
  }
}

function functionScopesFor(ctx: ExtractorContext, state: ExtractorState): Array<{ id: string; indent: number; startLine: number }> {
  if (state.functionScopes.length > 0) return state.functionScopes;
  const lines = ctx.source.split('\n');
  for (const node of ctx.nodes) {
    if ((node.kind === 'function' || node.kind === 'method') && node.language === 'gdscript' && node.filePath === state.filePath) {
      state.functionScopes.push({
        id: node.id,
        indent: indentOf(lines[node.startLine - 1] ?? ''),
        startLine: node.startLine,
      });
    }
  }
  state.functionScopes.sort((a, b) => a.startLine - b.startLine);
  return state.functionScopes;
}

function functionOwnerForLine(ctx: ExtractorContext, state: ExtractorState, line: number, indent: number): string {
  let owner = state.scriptClass?.id ?? state.fileId;
  for (const scope of functionScopesFor(ctx, state)) {
    if (scope.startLine < line && scope.indent < indent) {
      owner = scope.id;
    }
  }
  return owner;
}

function runReferencePasses(ctx: ExtractorContext, state: ExtractorState): void {
  const lines = ctx.source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i] ?? '';
    const code = stripComment(rawLine);
    if (!code.trim()) continue;

    const indent = indentOf(rawLine);
    const sameLineDecl = state.declarationByLine.get(lineNumber);
    const owner = sameLineDecl ? sameLineDecl.id : functionOwnerForLine(ctx, state, lineNumber, indent);

    let match: RegExpExecArray | null;

    // NOTE: extends targets are emitted from the AST walk (extends_statement /
    // class_definition children) — deliberately NOT matched here, or every
    // extends would double-count (beehave parity-diff finding).

    const resourceRegex = /\b(?:preload|load)\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((match = resourceRegex.exec(code)) !== null) {
      emitRef(ctx, owner, match[1]!, 'references', lineNumber, match.index, state);
    }

    const dynamicCallRegex = /\b(?:call|call_deferred)\s*\(\s*["']([A-Za-z_]\w*)["']/g;
    while ((match = dynamicCallRegex.exec(code)) !== null) {
      emitRef(ctx, owner, match[1]!, 'calls', lineNumber, match.index, state);
    }

    const groupRegex = /\b(?:add_to_group|remove_from_group)\s*\(\s*["']([^"']+)["']/g;
    while ((match = groupRegex.exec(code)) !== null) {
      emitRef(ctx, owner, match[1]!, 'references', lineNumber, match.index, state);
    }

    const tweenPathRegex = /\b(?:tween_property|tween_method|tween_value)\s*\(\s*[^,]+,\s*["']([^"']+)["']/g;
    while ((match = tweenPathRegex.exec(code)) !== null) {
      emitRef(ctx, owner, match[1]!, 'references', lineNumber, match.index, state);
    }

    const functionOwner = functionOwnerForLine(ctx, state, lineNumber, indent);
    extractNodePathReferences(ctx, state, owner, code, lineNumber, functionOwner);
    extractSignalReferences(ctx, state, owner, code, lineNumber);

    const memberCallRegex = /(?:\b([A-Za-z_]\w*)|([$%][A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*))\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
    while ((match = memberCallRegex.exec(code)) !== null) {
      const receiver = match[1] ?? nodePathReceiverName(match[2]!);
      const method = match[3]!;
      if (KEYWORDS.has(method)) continue;
      emitRef(ctx, owner, `${receiver}.${method}`, 'calls', lineNumber, match.index, state);
    }

    const callRegex = /\b([A-Za-z_]\w*)\s*\(/g;
    while ((match = callRegex.exec(code)) !== null) {
      const name = match[1]!;
      const prefix = code.slice(Math.max(0, match.index - 8), match.index);
      if (
        KEYWORDS.has(name) ||
        GODOT_BUILT_IN_CALLS.has(name) ||
        /\.\s*$/.test(prefix) ||
        /\bfunc\s+$/.test(prefix) ||
        /\bsignal\s+$/.test(prefix)
      ) continue;
      emitRef(ctx, owner, name, 'calls', lineNumber, match.index, state);
    }

    // Dynamic scene-node declarations (old extractor ran these per-line too):
    //   `reward_button.name = "LootCardRewardButton"` and %d-formatted bases.
    const dynamicNodeNameMatch = stripComment(rawLine).match(/\b[A-Za-z_]\w*\s*\.\s*name\s*=\s*["']([A-Za-z_]\w*)["']/);
    if (dynamicNodeNameMatch) {
      addDynamicNodeName(ctx, state, dynamicNodeNameMatch[1]!, lineNumber, code.trim(), functionOwnerForLine(ctx, state, lineNumber, indent));
    }
    const formattedBase = extractFormattedNodePathBase(code);
    if (formattedBase) {
      addDynamicNodeName(ctx, state, formattedBase, lineNumber, code.trim(), functionOwnerForLine(ctx, state, lineNumber, indent));
    }
  }
}

/** Does this line establish a `%d`-formatted node-path base? (`"A/%dB" % i`) */
function extractFormattedNodePathBase(code: string): string | null {
  if (!/\b(?:get_node|get_node_or_null|has_node)\s*\(/.test(code) && !/\b[A-Za-z_]\w*\s*:=?\s*["'][^"']*%d/.test(code)) {
    return null;
  }
  const formattedStringMatch = code.match(/["']([^"']*%d[^"']*)["']\s*%/);
  if (!formattedStringMatch) return null;
  return formattedNodePathBase(formattedStringMatch[1]!);
}
