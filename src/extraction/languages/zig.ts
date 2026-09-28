import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Zig extractor.
 *
 * Config-first over the core dispatch (the rust.ts / go.ts shape): functions,
 * methods, fields, calls, and instantiations ride the base class's generic
 * paths. This file owns only what is genuinely Zig-shaped:
 *
 *   - `const` is a four-way declaration (container type / @import / type
 *     alias / value), decided in `visitNode` because the base's type-alias
 *     and variable paths cannot be combined for a single node type;
 *   - `@import` / `@embedFile` / `@cImport` builtins mint import nodes
 *     (`std`/`builtin` are external; `root` uses compilation context);
 *   - enum tags and tagged-union payloads use `container_field`, the same
 *     node kind as struct fields — split by parent in `visitNode`;
 *   - a generic type function `pub fn Container(comptime T: type) type`
 *     returns the container everyone uses — the returned declaration is
 *     indexed under the function's name;
 *   - parse-error recovery shapes must never mint invented declarations.
 */

// Zig 0.16.0 std.zig.Token.keywords. Quoting is significant for these names:
// @"export" is an identifier, while bare export cannot declare a symbol.
const ZIG_KEYWORDS = new Set([
  'addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'break',
  'callconv', 'catch', 'comptime', 'const', 'continue', 'defer', 'else', 'enum',
  'errdefer', 'error', 'export', 'extern', 'fn', 'for', 'if', 'inline', 'noalias',
  'noinline', 'nosuspend', 'opaque', 'or', 'orelse', 'packed', 'pub', 'resume',
  'return', 'linksection', 'struct', 'suspend', 'switch', 'test', 'threadlocal',
  'try', 'union', 'unreachable', 'var', 'volatile', 'while',
]);

/** Decode a Zig string literal without evaluating source. Invalid UTF-8 paths
 * and invalid escape sequences remain unresolved rather than being guessed. */
export function zigString(text: string): string | undefined {
  if (!text.startsWith('"') || !text.endsWith('"')) return undefined;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] !== '\\') {
      const point = body.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      i += point > 0xffff ? 2 : 1;
      continue;
    }
    const escape = body[++i];
    if (!escape) return undefined;
    const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
    if (simple[escape] !== undefined) { bytes.push(...Buffer.from(simple[escape])); i++; continue; }
    if (escape === 'x' && /^[a-fA-F0-9]{2}$/.test(body.slice(i + 1, i + 3))) {
      bytes.push(parseInt(body.slice(i + 1, i + 3), 16)); i += 3; continue;
    }
    const unicode = body.slice(i).match(/^u\{([a-fA-F0-9]{1,6})\}/);
    if (!unicode) return undefined;
    const point = parseInt(unicode[1]!, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return undefined;
    bytes.push(...Buffer.from(String.fromCodePoint(point))); i += unicode[0].length;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); }
  catch { return undefined; }
}

/** Keep punctuation inside quoted identifiers; equivalent spellings share a key. */
export function zigIdentifier(text: string): string {
  if (!text.startsWith('@"')) return text;
  const decoded = zigString(text.slice(1));
  if (decoded === undefined) return text;
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(decoded) && !ZIG_KEYWORDS.has(decoded) ? decoded : '@' + JSON.stringify(decoded);
}

/** Split a qualified name only outside string identifiers. */
export function zigSegments(text: string): string[] {
  return (text.match(/@"(?:\\.|[^"\\])*"|[^.]+/g) ?? []).map(zigIdentifier);
}

/** Reconstruct expressions from syntax tokens: discard trivia, preserve strings. */
export function zigExpressionName(node: SyntaxNode): string {
  if (node.type === 'identifier') return zigIdentifier(node.text);
  if (node.type === 'string') return node.text;
  if (node.type === 'comment') return '';
  if (!node.childCount) return node.text.trim();
  return node.children.map(zigExpressionName).join('');
}

// ── Constants ─────────────────────────────────────────────────────────

/** Node kinds that declare a container type in the zig grammar. */
export const ZIG_TYPE_DECL_TYPES = new Set([
  'struct_declaration',
  'enum_declaration',
  'union_declaration',
  'opaque_declaration',
  'error_set_declaration',
]);

/**
 * Compiler-provided modules (`@import("std")` etc.) — provided by the
 * toolchain, never an in-repo file. No import node/ref is minted for them:
 * the ref could only ever fail resolution, and the resolution layer
 * additionally filters the dotted uses (std.mem.eql) as external.
 */
const COMPILER_MODULES = new Set(['std', 'builtin']);

/**
 * Primitive / compiler-provided type names that are never user symbols.
 * Shared by the type-name collector below (and, via it, the core's zig
 * type-annotation branch).
 */
export const ZIG_PRIMITIVE_TYPES = new Set([
  'void', 'bool', 'isize', 'usize', 'noreturn', 'type', 'anyerror', 'comptime_int', 'comptime_float',
  'i8', 'i16', 'i32', 'i64', 'i128',
  'u8', 'u16', 'u32', 'u64', 'u128',
  'f16', 'f32', 'f64', 'f80', 'f128',
  'u0', 'i0', 'c_char', 'c_short', 'c_ushort', 'c_int', 'c_uint', 'c_long', 'c_ulong',
  'c_longlong', 'c_ulonglong', 'c_longdouble',
  'anyopaque', 'anyframe', 'anytype',
  'true', 'false', 'undefined', 'null',
]);

/** Value-literal node kinds — never type annotations. */
const VALUE_EXPR_TYPES = new Set([
  'integer', 'string', 'float', 'boolean',
  'call_expression', 'struct_initializer', 'anonymous_struct_initializer',
  'builtin_function', 'field_expression',
]);

/** Type-expression node kinds that still indicate a type alias (not a container). */
const TYPE_ALIAS_NODE_TYPES = new Set([
  'pointer_type', 'fn', 'function_signature', 'builtin_type',
  'slice_type', 'array_type', 'optional_type', 'error_union_type',
  'field_expression', 'identifier', 'type_expression', 'primary_type_expression',
  'nullable_type',
]);

// ── Type-name collection (shared with the core extractor) ─────────────

export interface ZigTypeNameRef {
  name: string;
  line: number;
  column: number;
  candidates?: string[];
}

/** Bind a use to the nearest literal @import in its AST scope. Candidate names
 * carry the module path plus its qualified member through the existing stored
 * unresolved-reference contract, including worker and incremental indexing.
 */
export function zigImportCandidates(node: SyntaxNode, name: string): string[] | undefined {
  // An inline import is itself the receiver, not a lexical variable binding.
  const expression = node.type === 'call_expression' ? node.childForFieldName('function') : node;
  const direct = expression && zigAlias(expression);
  if (direct?.module) return [encodeZigTarget(direct)];
  const [binding, ...members] = zigSegments(name);
  if (!binding) return undefined;
  let scope: SyntaxNode | null = node.parent;
  while (scope) {
    if (scope.type === 'function_declaration') {
      const params = scope.namedChildren.find(c => c.type === 'parameters');
      if (params?.namedChildren.some(p => zigIdentifier(p.childForFieldName('name')?.text ?? '') === binding)) return undefined;
    }
    if (scope.type === 'source_file' || scope.type === 'block' || ZIG_TYPE_DECL_TYPES.has(scope.type)) {
      const declaration = scope.namedChildren.filter(c => c.type === 'variable_declaration' &&
        zigIdentifier(c.namedChild(0)?.text ?? '') === binding && (scope!.type !== 'block' || c.endIndex <= node.startIndex)).at(-1);
      if (declaration) {
        const value = declaration.namedChildren.filter(c => c.type !== 'comment').at(-1);
        const alias = value && zigAlias(value);
        if (alias?.module) return [encodeZigTarget({ ...alias, members: [...alias.members, ...members] })];
        // The resolver follows stored alias metadata through file/container scopes.
        return undefined;
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

export interface ZigTarget { module?: string; members: string[] }
export function encodeZigTarget(target: ZigTarget): string { return 'zig:' + JSON.stringify(target); }

/** Only literal imports and identifier/member expressions carry static alias evidence. */
export function zigAlias(node: SyntaxNode): ZigTarget | undefined {
  const children = node.namedChildren.filter(c => c.type !== 'comment');
  if (node.type === 'identifier') return { members: [zigIdentifier(node.text)] };
  if (node.type === 'field_expression') {
    const base = children[0] && zigAlias(children[0]);
    return base && children[1]?.type === 'identifier' ? { ...base, members: [...base.members, zigIdentifier(children[1].text)] } : undefined;
  }
  if (node.type === 'builtin_function' && children[0]?.text === '@import') {
    const arg = children.find(c => c.type === 'arguments')?.namedChildren.find(c => c.type !== 'comment');
    const module = arg?.type === 'string' ? zigString(arg.text) : undefined;
    return module ? { module, members: [] } : undefined;
  }
  return undefined;
}

/**
 * Collect the user-defined type names referenced by a zig type subtree
 * (a parameter list, a return type, a field's type). The grammar spells
 * type leaves as plain `identifier`s (not `type_identifier`s), so the core's
 * generic annotation walk finds nothing — its zig branch delegates here
 * (the `rustImplTypeName` import precedent in tree-sitter.ts).
 */
export function collectZigTypeNames(node: SyntaxNode, source: string): ZigTypeNameRef[] {
  const refs: ZigTypeNameRef[] = [];
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'builtin_type') return;
    if (n.type === 'field_expression') {
      const name = zigExpressionName(n);
      refs.push({ name, line: n.startPosition.row + 1, column: n.startPosition.column,
        candidates: zigImportCandidates(n, name) });
      return;
    }
    if (n.type === 'parameter') {
      const type = n.childForFieldName('type');
      if (type) walk(type);
      return;
    }
    if (n.type === 'identifier') {
      const text = zigIdentifier(getNodeText(n, source));
      if (text && !ZIG_PRIMITIVE_TYPES.has(text)) {
        refs.push({ name: text, line: n.startPosition.row + 1, column: n.startPosition.column,
          candidates: zigImportCandidates(n, text) });
      }
      return;
    }
    if (n.type === 'anonymous_struct_initializer' || n.type === 'struct_initializer') return;
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(node);
  return refs;
}

/** Emit `references` refs for every type name in `node`'s subtree. */
function addZigTypeRefs(node: SyntaxNode, fromNodeId: string, ctx: ExtractorContext): void {
  for (const ref of collectZigTypeNames(node, ctx.source)) {
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: ref.name,
      referenceKind: 'references',
      line: ref.line,
      column: ref.column,
      candidates: ref.candidates,
    });
  }
}

// ── Declaration helpers ───────────────────────────────────────────────

function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === keyword) return true;
  }
  return false;
}

function findTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  if (ZIG_TYPE_DECL_TYPES.has(node.type)) return node;
  if (
    node.type === 'type_expression' ||
    node.type === 'primary_type_expression' ||
    node.type === 'parenthesized_expression'
  ) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const found = findTypeDeclaration(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * A `fn ...(comptime T: type, ...) type` returns a container type — find the
 * first `return struct {...}` / enum / union / opaque / error-set declaration
 * in the body (the Zig convention: the returned type carries the function's
 * name, e.g. std's `HashMap(K, V)`).
 */
function findReturnedTypeDecl(body: SyntaxNode): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  const visit = (node: SyntaxNode): void => {
    if (found) return;
    if (ZIG_TYPE_DECL_TYPES.has(node.type) || node.type === 'function_declaration') return;
    if (node.type === 'return_expression') {
      const value = node.namedChild(0);
      if (value) found = findTypeDeclaration(value);
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  };
  visit(body);
  return found;
}

/**
 * Mint a container type node for `valueNode` and visit its members. Shared by
 * `const X = struct {...}` declarations and by the container a generic type
 * function returns — in Zig the anonymous returned container IS the type
 * callers use, so it takes the function's name.
 */
function emitTypeDeclaration(
  positionNode: SyntaxNode,
  valueNode: SyntaxNode,
  name: string,
  isPub: boolean,
  ctx: ExtractorContext,
  extraMeta?: Record<string, unknown>,
): boolean {
  const isEnum = valueNode.type === 'enum_declaration' || valueNode.type === 'error_set_declaration';
  const isTaggedUnion = valueNode.type === 'union_declaration' && hasKeyword(valueNode, 'enum');
  const kind = isEnum ? 'enum' : 'struct';

  const meta: Record<string, unknown> = {};
  if (isTaggedUnion) meta.taggedUnion = true;
  if (extraMeta) Object.assign(meta, extraMeta);

  const typeNode = ctx.createNode(kind, name, positionNode, {
    visibility: isPub ? 'public' : 'private',
    isExported: isPub,
    ...(Object.keys(meta).length > 0 && { metadata: meta }),
  });
  if (!typeNode) return true;

  ctx.pushScope(typeNode.id);
  for (let i = 0; i < valueNode.namedChildCount; i++) {
    const child = valueNode.namedChild(i);
    if (!child) continue;
    if (valueNode.type === 'error_set_declaration' && child.type === 'identifier') {
      // Error-set members are bare identifier children, unlike enum fields.
      if (!ZIG_KEYWORDS.has(child.text)) ctx.createNode('enum_member', zigIdentifier(child.text), child, { visibility: 'public' });
    } else if (child.type === 'container_field' && (isEnum || isTaggedUnion)) {
      const nameField = getChildByField(child, 'name');
      if (nameField && !ZIG_KEYWORDS.has(nameField.text)) {
        const memberName = zigIdentifier(getNodeText(nameField, ctx.source));
        if (memberName !== '_') {
          const member = ctx.createNode('enum_member', memberName, child, { visibility: 'public' });
          const payload = getChildByField(child, 'type');
          if (member && payload) addZigTypeRefs(payload, member.id, ctx);
        }
      }
    } else {
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

// ── `const` / `var` declarations (the four-way split) ─────────────────

function handleVariableDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  let name = '';
  let valueNode: SyntaxNode | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier' && !name) {
      name = zigIdentifier(getNodeText(child, ctx.source));
      continue;
    }
    if (name && !valueNode) valueNode = findTypeDeclaration(child);
  }

  // Named type: `const Foo = struct/enum/union/opaque { ... };`
  if (name && valueNode) {
    return emitTypeDeclaration(node, valueNode, name, hasKeyword(node, 'pub'), ctx);
  }

  // `const std = @import("std")` — direct or nested inside a field chain.
  if (handleImports(node, ctx)) return true;

  // Type alias: `const Name = <type expression>` (not a container declaration).
  if (name && handleTypeAlias(node, name, ctx)) return true;

  // Value declaration (`const sum = add(1, 2)`, `const inst = Point{...}`):
  // mint the constant/variable node here and walk the initializer so its
  // calls and struct instantiations enter the graph — including the
  // type-instantiating form `const IntContainer = Container(i32)` of a
  // generic type function.
  if (name) {
    let initializer: SyntaxNode | null = null;
    let pastName = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (!pastName && child.type === 'identifier') { pastName = true; continue; }
      if (node.fieldNameForNamedChild(i) === 'type') continue;
      initializer = child;
      break;
    }
    const isConst = hasKeyword(node, 'const');
    const isPub = hasKeyword(node, 'pub');
    const initText = initializer
      ? ctx.source.substring(initializer.startIndex, Math.min(initializer.endIndex, initializer.startIndex + 100))
      : '';
    const varNode = ctx.createNode(isConst ? 'constant' : 'variable', name, node, {
      visibility: isPub ? 'public' : 'private',
      isExported: isPub,
      ...(initText && { signature: initText }),
    });
    if (varNode) {
      // The declaration's own type annotation (`var x: ?MyType = ...`) is a
      // real dependency on that type — same rule the core applies to local
      // variable_declarator annotations.
      const typeAnnotation = Array.from({ length: node.namedChildCount }, (_, i) => i)
        .map((i) => node.namedChild(i))
        .find((c, i) => !!c && node.fieldNameForNamedChild(i) === 'type');
      if (typeAnnotation) addZigTypeRefs(typeAnnotation, varNode.id, ctx);
      if (initializer) {
        ctx.pushScope(varNode.id);
        ctx.visitFunctionBody(initializer, varNode.id);
        ctx.popScope();
      }
      return true;
    }
  }

  return false;
}

function handleTypeAlias(node: SyntaxNode, name: string, ctx: ExtractorContext): boolean {
  // The alias VALUE is the last named child that is neither the declared name
  // nor the `type`-field annotation (`const x: i32 = 42` — i32 is an
  // annotation on a value constant, not an alias value). A literal or missing
  // value means this is a value declaration, not a type alias.
  let value: SyntaxNode | null = null;
  let pastName = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (!pastName && child.type === 'identifier') { pastName = true; continue; }
    if (node.fieldNameForNamedChild(i) === 'type') continue;
    value = child;
  }
  if (!value) return false;
  const isTypeExpr = TYPE_ALIAS_NODE_TYPES.has(value.type) || value.type === 'identifier'
    || value.type === 'nullable_type' || value.type === 'error_union_type';
  if (!isTypeExpr || VALUE_EXPR_TYPES.has(value.type)) return false;

  const aliasNode = ctx.createNode('type_alias', name, node, {
    visibility: hasKeyword(node, 'pub') ? 'public' : 'private',
    isExported: hasKeyword(node, 'pub'),
  });
  if (aliasNode) {
    addZigTypeRefs(value, aliasNode.id, ctx);
    return true;
  }
  return false;
}

/** `@import("path")` / `@embedFile("path")` inside a `const` initializer. */
function handleImports(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // Only a direct builtin owns the declaration. Imports nested in ordinary
  // calls are dependencies of the value, not replacements for that value.
  const value = node.namedChildren.at(-1);
  return value?.type === 'builtin_function' ? emitZigBuiltinImport(value, ctx) : false;
}

/** Import nodes + refs for every `@cInclude("x.h")` inside a `@cImport` block. */
function emitCIncludes(node: SyntaxNode, ctx: ExtractorContext): void {
  const visit = (n: SyntaxNode): void => {
    if (n.type === 'builtin_function' && n.namedChild(0)?.text === '@cInclude') {
      const arg = n.namedChildren.find(c => c.type === 'arguments')?.namedChildren.find(c => c.type !== 'comment');
      if (arg?.type === 'string' && zigString(arg.text)) {
        const header = zigString(arg.text)!;
        const importId = ctx.createNode('import', header, n, { signature: n.text });
        if (importId) ctx.addUnresolvedReference({
          fromNodeId: importId.id, referenceName: header, referenceKind: 'imports',
          line: n.startPosition.row + 1, column: n.startPosition.column,
        });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) visit(child);
    }
  };
  visit(node);
}

/**
 * Import-shaped `@`-builtins as standalone expressions: `@import("x.zig")`
 * (compiler modules skipped), `@embedFile("x")`, `@cImport(...)`. Returns
 * true when claimed; false lets the core's callTypes path treat the builtin
 * as a compiler-intrinsic call reference.
 */
function emitZigBuiltinImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const builtin = node.namedChildren.find(c => c.type === 'builtin_identifier')?.text;
  if (builtin === '@cImport') { emitCIncludes(node, ctx); return true; }
  if (builtin !== '@import' && builtin !== '@embedFile') return false;
  const arg = node.namedChildren.find(c => c.type === 'arguments')?.namedChildren.find(c => c.type !== 'comment');
  if (arg?.type !== 'string') return true;
  const literal = zigString(arg.text);
  if (!literal) return true;
  if (builtin === '@import' && COMPILER_MODULES.has(literal)) return true;

  const importId = ctx.createNode('import', literal, node, { signature: node.text });
  if (importId) ctx.addUnresolvedReference({ fromNodeId: importId.id,
    referenceName: literal, referenceKind: 'imports',
    line: node.startPosition.row + 1, column: node.startPosition.column });
  return true;
}

// ── Extractor ─────────────────────────────────────────────────────────

export const zigExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'test_declaration'],
  methodTypes: ['function_declaration'],
  classTypes: [],
  interfaceTypes: [],
  structTypes: [],
  unionTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [], // `const` is the four-way split — see visitNode
  importTypes: [],    // `@import` builtins, not import statements — see visitNode
  callTypes: ['call_expression', 'builtin_function'],
  variableTypes: [],  // `const`/`var` are the four-way split — see visitNode
  fieldTypes: ['container_field'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',

  resolveName: (node, source) => {
    // `test "descriptive name" { ... }` names the block with a string, not
    // an identifier — surface it as the function's name.
    if (node.type === 'test_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'string') {
          return source.substring(child.startIndex + 1, child.endIndex - 1);
        }
      }
    }
    const name = getChildByField(node, 'name');
    return name?.type === 'identifier' ? zigIdentifier(name.text) : undefined;
  },

  resolveBody: (node, bodyField) => {
    // function_declaration carries `body: block`; test_declaration's block
    // is a bare child without the field name.
    if (node.type === 'test_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'block') return child;
      }
      return null;
    }
    return getChildByField(node, bodyField) ?? null;
  },

  getSignature: (node, source) => {
    let paramsNode: SyntaxNode | null = null;
    let callconvNode: SyntaxNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'parameters') { paramsNode = child; }
      if (child?.type === 'calling_convention') { callconvNode = child; }
    }
    const returnType = getChildByField(node, 'type');
    let sig = paramsNode ? getNodeText(paramsNode, source) : '';
    if (callconvNode) sig += ' ' + getNodeText(callconvNode, source);
    if (returnType) sig += ' ' + getNodeText(returnType, source);
    return sig.trim() || undefined;
  },

  getVisibility: (node) =>
    (hasKeyword(node, 'pub') || hasKeyword(node, 'export')) ? 'public' : 'private',

  isExported: (node) => hasKeyword(node, 'pub') || hasKeyword(node, 'export'),

  isConst: (node) => hasKeyword(node, 'const'),

  /**
   * Zig method convention: the first parameter is `self: *Type` (or
   * `self: Type`). Its type names the owning container, exactly like Rust's
   * impl-block receiver — the core composes `Type::method` qualified names
   * and the owning container's `contains` edge from it (also for
   * vtable-style free functions declared outside their type).
   */
  getReceiverType: (node, source) => {
    // Nested container methods already have the correct lexical owner.
    if (node.parent && ZIG_TYPE_DECL_TYPES.has(node.parent.type)) return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type !== 'parameters') continue;
      const firstParam = child.namedChild(0);
      if (!firstParam) break;
      const paramName = firstParam.namedChild(0);
      if (!paramName || paramName.type !== 'identifier') break;
      const name = getNodeText(paramName, source);
      if (name !== 'self' && name !== 'this' && name !== 'super') break;
      for (let j = 1; j < firstParam.namedChildCount; j++) {
        const typeChild = firstParam.namedChild(j);
        if (!typeChild) continue;
        if (typeChild.type === 'pointer_type' || typeChild.type === 'nullable_type') {
          const inner = typeChild.namedChild(0);
          if (inner?.type === 'pointer_type') {
            const deepest = inner.namedChild(0);
            if (deepest?.type === 'identifier') return getNodeText(deepest, source);
          }
          if (inner?.type === 'identifier') return getNodeText(inner, source);
        }
        if (typeChild.type === 'identifier') return getNodeText(typeChild, source);
      }
      break;
    }
    return undefined;
  },

  /**
   * The declared return type, normalized to the bare type a chained
   * `.init(...).method()` call could resolve on (the rust.ts #645/#608
   * mechanism): `@This()` yields the marker `self` (resolved to the owning
   * container at resolution time); `*T` / `?*T` / `!T` unwrap to `T`;
   * primitives, `void`, and non-identifier types yield undefined.
   */
  getReturnType: (node, source) => {
    let rt = getChildByField(node, 'type');
    while (rt && (rt.type === 'pointer_type' || rt.type === 'nullable_type' || rt.type === 'error_union_type')) {
      rt = rt.type === 'error_union_type'
        ? getChildByField(rt, 'ok') ?? rt.namedChild(rt.namedChildCount - 1)
        : rt.namedChild(0) ?? null;
    }
    if (rt?.type === 'builtin_function' && /^@This\s*\(\s*\)$/.test(rt.text)) return 'self';
    if (!rt || rt.type !== 'identifier') return undefined;
    const text = getNodeText(rt, source).trim();
    if (!text || ZIG_PRIMITIVE_TYPES.has(text)) return undefined;
    return text === 'This' ? 'self' : text;
  },

  /** Symbol-level modifiers persisted on the node's decorators (Kotlin precedent). */
  extractModifiers: (node) => {
    if (node.type !== 'function_declaration') return undefined;
    const mods: string[] = [];
    if (hasKeyword(node, 'inline')) mods.push('inline');
    if (hasKeyword(node, 'noinline')) mods.push('noinline');
    return mods.length > 0 ? mods : undefined;
  },

  visitNode: (node, ctx) => {
    const declarationName = node.type === 'variable_declaration'
      ? node.namedChildren.find(c => c.type === 'identifier') : getChildByField(node, 'name');
    if (declarationName && ZIG_KEYWORDS.has(declarationName.text)) return true;
    switch (node.type) {
      // Recovery children can contain invented declaration names.
      case 'ERROR':
        return true;

      case 'variable_declaration':
        return handleVariableDeclaration(node, ctx);

      case 'container_field': {
        // The grammar reuses container_field for enum tags and tagged-union
        // payloads — the same kind struct fields use. Split by parent: enum
        // shapes mint enum_member, struct/union fields fall through to the
        // core's fieldTypes path (name, `Type name` signature, type refs).
        const owner = node.parent;
        if (
          owner &&
          (owner.type === 'enum_declaration' ||
            owner.type === 'error_set_declaration' ||
            (owner.type === 'union_declaration' && hasKeyword(owner, 'enum')))
        ) {
          const nameField = getChildByField(node, 'name');
          if (nameField) {
            const memberName = zigIdentifier(getNodeText(nameField, ctx.source));
            if (memberName && memberName !== '_') ctx.createNode('enum_member', memberName, node, { visibility: 'public' });
          }
          return true;
        }
        return false;
      }

      case 'builtin_function':
        // Import-shaped builtins mint import nodes here; every other
        // `@`-builtin is a compiler-intrinsic call — return false so the
        // core's callTypes path emits the `@name` reference.
        return emitZigBuiltinImport(node, ctx);

      case 'function_declaration': {
        // Generic type function: `pub fn Container(comptime T: type) type {
        // return struct {...} }` — handled here because the returned
        // container must take the function's name. Everything else falls
        // through to the core's function/method paths.
        const returnType = getChildByField(node, 'type');
        const returnsType = returnType?.type === 'builtin_type' &&
          getNodeText(returnType, ctx.source) === 'type';
        if (!returnsType) return false;

        let body: SyntaxNode | null = null;
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child?.type === 'block') { body = child; break; }
        }
        if (!body) return false;
        const typeDecl = findReturnedTypeDecl(body);
        if (!typeDecl) return false;

        const nameField = getChildByField(node, 'name');
        const name = nameField ? zigIdentifier(getNodeText(nameField, ctx.source)) : '';
        if (!name) return false;

        const isPub = hasKeyword(node, 'pub');
        const fnNode = ctx.createNode('function', name, node, {
          signature: zigExtractor.getSignature?.(node, ctx.source),
          visibility: (isPub || hasKeyword(node, 'export')) ? 'public' : 'private',
          isExported: isPub,
        });
        if (!fnNode) return true;
        ctx.pushScope(fnNode.id);
        const params = node.namedChildren.find(c => c.type === 'parameters');
        if (params) addZigTypeRefs(params, fnNode.id, ctx);
        // Walk statements outside the returned container once, preserving their
        // calls without attributing container methods to the factory function.
        const visit = (n: SyntaxNode): void => {
          if (n.id === typeDecl.id) {
            emitTypeDeclaration(n, n, name, isPub, ctx, { typeFunction: true });
          } else if (n.type === 'variable_declaration' || n.type === 'function_declaration') {
            ctx.visitNode(n);
          } else if (n.type === 'call_expression' || n.type === 'builtin_function') {
            ctx.visitFunctionBody(n, fnNode.id);
          } else {
            for (const child of n.namedChildren) visit(child);
          }
        };
        visit(body);
        ctx.popScope();
        return true;
      }

      case 'comptime_declaration':
      case 'using_namespace_declaration':
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        return true;

      default:
        return false;
    }
  },
};
