import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// ── Constants ─────────────────────────────────────────────────────────

const ZIG_TYPE_DECL_TYPES = new Set([
  'struct_declaration',
  'enum_declaration',
  'union_declaration',
  'opaque_declaration',
  'error_set_declaration',
]);

const INSTANTIATION_KINDS = new Set(['struct_initializer']);

/** Type-expression node types that indicate a type alias (not a struct/enum/opaque). */
const TYPE_ALIAS_NODE_TYPES = new Set([
  'pointer_type', 'fn', 'function_signature', 'builtin_type',
  'slice_type', 'array_type', 'optional_type', 'error_union_type',
  'field_expression', 'identifier', 'type_expression', 'primary_type_expression',
  'nullable_type',
]);

/** Value-literal node types (not type annotations). */
const VALUE_LITERAL_TYPES = new Set([
  'integer', 'string', 'float', 'boolean',
  'call_expression', 'struct_initializer', 'anonymous_struct_initializer',
]);

/** Value-expression node types used when walking variable type annotations. */
const VALUE_EXPR_TYPES = new Set([
  'integer', 'string', 'float', 'boolean',
  'call_expression', 'struct_initializer', 'anonymous_struct_initializer',
  'builtin_function', 'field_expression',
]);

/** Built-in Zig types that should NOT be treated as user-defined type references. */
const ZIG_BUILTIN_TYPES = new Set([
  'void', 'bool', 'isize', 'usize', 'noreturn', 'type', 'anyerror', 'comptime_int', 'comptime_float',
  'i8', 'i16', 'i32', 'i64', 'i128',
  'u8', 'u16', 'u32', 'u64', 'u128',
  'f16', 'f32', 'f64', 'f80', 'f128',
  'u0', 'i0', 'c_char', 'c_short', 'c_ushort', 'c_int', 'c_uint', 'c_long', 'c_ulong',
  'c_longlong', 'c_ulonglong', 'c_longdouble',
  'anyopaque', 'anyframe', 'anytype',
  'true', 'false', 'undefined', 'null',
]);

/** Receivers to strip from method calls (self.method → method). */
const SKIP_RECEIVERS = new Set(['self', 'this', 'super']);

// ── Generic AST helpers ───────────────────────────────────────────────

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

function buildFieldChain(node: SyntaxNode, source: string): string {
  const object = getChildByField(node, 'object');
  const member = getChildByField(node, 'member');
  const memberName = member ? getNodeText(member, source) : '';
  if (object && object.type === 'field_expression') {
    return buildFieldChain(object, source) + '.' + memberName;
  }
  const objectName = object ? getNodeText(object, source) : '';
  if (objectName && memberName) {
    if (SKIP_RECEIVERS.has(objectName)) return memberName;
    return objectName + '.' + memberName;
  }
  return objectName || memberName;
}

function findImportBuiltin(node: SyntaxNode, source: string): SyntaxNode | null {
  if (node.type === 'builtin_function') {
    const text = source.substring(node.startIndex, node.endIndex);
    if (/@import\s*\(\s*"([^"]+)"\s*\)/.test(text)) return node;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = findImportBuiltin(child, source);
    if (found) return found;
  }
  return null;
}

// ── Zig-specific type reference extraction ────────────────────────────

/** Walk a Zig type subtree to find custom type identifiers, emitting `references`. */
function extractZigTypeRefs(node: SyntaxNode, fromNodeId: string, ctx: ExtractorContext): void {
  if (node.type === 'builtin_type') return;
  if (node.type === 'parameter') {
    let isFirst = true;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (isFirst && child.type === 'identifier') { isFirst = false; continue; }
      isFirst = false;
      extractZigTypeRefs(child, fromNodeId, ctx);
    }
    return;
  }
  if (node.type === 'field_expression') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'field_expression' || child.type === 'identifier') {
        if (node.fieldNameForNamedChild(i) === 'object') continue;
        extractZigTypeRefs(child, fromNodeId, ctx);
      } else {
        extractZigTypeRefs(child, fromNodeId, ctx);
      }
    }
    return;
  }
  if (node.type === 'identifier') {
    if (ZIG_BUILTIN_TYPES.has(getNodeText(node, ctx.source))) return;
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: getNodeText(node, ctx.source),
      referenceKind: 'references',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
    return;
  }
  if (node.type === 'anonymous_struct_initializer' || node.type === 'struct_initializer') return;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) extractZigTypeRefs(child, fromNodeId, ctx);
  }
}

function extractFnTypeRefs(node: SyntaxNode, nodeId: string, ctx: ExtractorContext): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'parameters') {
      extractZigTypeRefs(child, nodeId, ctx);
      break;
    }
  }
  const returnType = getChildByField(node, 'type');
  if (returnType) extractZigTypeRefs(returnType, nodeId, ctx);
}

function extractFieldTypeRefs(node: SyntaxNode, fieldNodeId: string, ctx: ExtractorContext): void {
  for (let i = 1; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'builtin_type') continue;
    if (child.type === 'container_field_initializer') continue;
    extractZigTypeRefs(child, fieldNodeId, ctx);
    break;
  }
}

/** Extract type references from a variable_declaration's type annotation. */
function extractVarTypeRefs(node: SyntaxNode, name: string, ctx: ExtractorContext): void {
  if (!name) return;
  let pastName = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier' && !pastName) { pastName = true; continue; }
    if (!pastName) continue;
    if (TYPE_ALIAS_NODE_TYPES.has(child.type) || child.type === 'identifier'
        || child.type === 'nullable_type' || child.type === 'error_union_type') {
      if (!VALUE_EXPR_TYPES.has(child.type) || child.type === 'nullable_type'
          || child.type === 'error_union_type' || child.type === 'pointer_type'
          || child.type === 'slice_type' || child.type === 'array_type'
          || child.type === 'optional_type') {
        extractZigTypeRefs(child, node.startIndex.toString(), ctx);
      }
    }
    break;
  }
}

// ── Function helpers ──────────────────────────────────────────────────

function extractFnName(node: SyntaxNode, source: string): string {
  const nameField = getChildByField(node, 'name');
  if (nameField) return getNodeText(nameField, source);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'identifier') return getNodeText(child, source);
  }
  return '';
}

function findFnBody(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'block') return child;
  }
  return null;
}

function hasComptimeParams(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'parameters') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const param = child.namedChild(j);
      if (param && hasKeyword(param, 'comptime')) return true;
    }
  }
  return false;
}

function extractFnSignature(node: SyntaxNode, source: string): string | undefined {
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
}

/** Check if a node ID on the stack belongs to a container type. */
function isInsideContainer(nodeStack: readonly string[], nodes: ReadonlyArray<{ id: string; kind: string }>): boolean {
  if (nodeStack.length === 0) return false;
  const parentId = nodeStack[nodeStack.length - 1];
  if (!parentId) return false;
  const parentNode = nodes.find((n) => n.id === parentId);
  if (!parentNode) return false;
  return parentNode.kind === 'struct' || parentNode.kind === 'enum' ||
    parentNode.kind === 'class' || parentNode.kind === 'interface' ||
    parentNode.kind === 'trait' || parentNode.kind === 'module';
}

// ── Call/reference extraction ─────────────────────────────────────────

function walkBodyForCalls(body: SyntaxNode, functionId: string, ctx: ExtractorContext): void {
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'call_expression') {
      const func = node.namedChild(0);
      if (!func) return;
      let calleeName: string;
      if (func.type === 'field_expression') {
        calleeName = buildFieldChain(func, ctx.source);
      } else if (func.type === 'identifier') {
        calleeName = getNodeText(func, ctx.source);
      } else {
        calleeName = ctx.source.substring(func.startIndex, func.endIndex);
      }
      if (calleeName) {
        ctx.addUnresolvedReference({
          fromNodeId: functionId,
          referenceName: calleeName,
          referenceKind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    } else if (node.type === 'builtin_function') {
      const text = ctx.source.substring(node.startIndex, Math.min(node.endIndex, node.startIndex + 40));
      if (!/@import\s*\(/.test(text)) {
        if (text.startsWith('@call(')) {
          const callee = extractCallBuiltin(node, ctx.source);
          if (callee) {
            ctx.addUnresolvedReference({
              fromNodeId: functionId,
              referenceName: callee,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
            return;
          }
        }
        if (text.startsWith('@embedFile(')) {
          const filePath = extractEmbedFile(node, ctx.source);
          if (filePath) {
            ctx.addUnresolvedReference({
              fromNodeId: functionId,
              referenceName: filePath,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
            return;
          }
        }
        const m = text.match(/^@[a-zA-Z_]\w*/);
        if (m) {
          ctx.addUnresolvedReference({
            fromNodeId: functionId,
            referenceName: m[0],
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
    } else if (INSTANTIATION_KINDS.has(node.type)) {
      const typeId = node.namedChild(0);
      if (typeId?.type === 'identifier') {
        const typeName = getNodeText(typeId, ctx.source);
        if (typeName) {
          ctx.addUnresolvedReference({
            fromNodeId: functionId,
            referenceName: typeName,
            referenceKind: 'instantiates',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
    } else if (node.type === 'anonymous_struct_initializer') {
      const typeNode = getChildByField(node, 'type') ?? getChildByField(node, 'constructor') ?? node.namedChild(0);
      if (typeNode) {
        let name = getNodeText(typeNode, ctx.source);
        const lt = name.indexOf('<');
        if (lt > 0) name = name.slice(0, lt);
        ctx.addUnresolvedReference({
          fromNodeId: functionId,
          referenceName: name,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  };
  visit(body);
}

function extractCallBuiltin(node: SyntaxNode, source: string): string | null {
  const text = source.substring(node.startIndex, node.endIndex);
  if (!text.startsWith('@call(')) return null;
  let args: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === 'arguments') { args = c; break; }
  }
  if (!args) return null;
  const callable = args.namedChild(1);
  if (!callable) return null;
  if (callable.type === 'identifier') return getNodeText(callable, source);
  if (callable.type === 'field_expression') return buildFieldChain(callable, source);
  return null;
}

function extractEmbedFile(node: SyntaxNode, source: string): string | null {
  const text = source.substring(node.startIndex, node.endIndex);
  const m = text.match(/@embedFile\s*\(\s*"([^"]+)"\s*\)/);
  return m ? m[1]! : null;
}

function findCIncludes(node: SyntaxNode, source: string): string[] {
  const headers: string[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === 'builtin_function') {
      const text = source.substring(n.startIndex, Math.min(n.endIndex, n.startIndex + 80));
      const m = text.match(/@cInclude\s*\(\s*"([^"]+)"\s*\)/);
      if (m) headers.push(m[1]!);
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) visit(child);
    }
  };
  visit(node);
  return headers;
}

// ── visitNode handlers (one per node type) ────────────────────────────

function handleFunctionDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = extractFnName(node, ctx.source);
  const body = findFnBody(node);
  if (!name || !body) return false;

  const isMethod = isInsideContainer(ctx.nodeStack, ctx.nodes);
  const kind = isMethod ? 'method' : 'function';
  const isPub = hasKeyword(node, 'pub');
  const isExport = hasKeyword(node, 'export');

  const returnType = getChildByField(node, 'type');
  const isFallible = returnType?.type === 'error_union_type';
  const isGeneric = hasComptimeParams(node);
  const isInline = hasKeyword(node, 'inline');
  const isNoinline = hasKeyword(node, 'noinline');

  const meta: Record<string, boolean> = {};
  if (isFallible) meta.fallible = true;
  if (isGeneric) meta.generic = true;
  if (isInline) meta.inline = true;
  if (isNoinline) meta.noinline = true;

  const fnNode = ctx.createNode(kind, name, node, {
    signature: extractFnSignature(node, ctx.source),
    visibility: (isPub || isExport) ? 'public' : 'private',
    isExported: isPub || isExport,
    ...(Object.keys(meta).length > 0 && { metadata: meta }),
  });
  if (!fnNode) return true;

  ctx.pushScope(fnNode.id);
  walkBodyForCalls(body, fnNode.id, ctx);
  extractFnTypeRefs(node, fnNode.id, ctx);
  ctx.popScope();
  return true;
}

function handleVariableDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  let name = '';
  let valueNode: SyntaxNode | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier' && !name) {
      name = getNodeText(child, ctx.source);
      continue;
    }
    if (name && !valueNode) valueNode = findTypeDeclaration(child);
  }

  // Named type: const Foo = struct/enum/union/opaque { ... };
  if (name && valueNode) {
    return handleTypeDeclaration(node, name, valueNode, ctx);
  }

  // @import — may be direct or nested inside field_expression.
  if (handleImports(node, ctx)) return true;

  // Emit type references from variable type annotations
  extractVarTypeRefs(node, name, ctx);

  // Type alias: const Name = type_expression (not a struct/enum/opaque).
  if (handleTypeAlias(node, name, ctx)) return true;

  return false;
}

function handleTypeDeclaration(
  node: SyntaxNode,
  name: string,
  valueNode: SyntaxNode,
  ctx: ExtractorContext,
): boolean {
  const isPub = hasKeyword(node, 'pub');
  const isEnum = valueNode.type === 'enum_declaration' || valueNode.type === 'error_set_declaration';
  const isTaggedUnion = valueNode.type === 'union_declaration' && hasKeyword(valueNode, 'enum');
  const kind = isEnum ? 'enum' : 'struct';

  const meta: Record<string, unknown> = {};
  if (isTaggedUnion) meta.taggedUnion = true;

  const typeNode = ctx.createNode(kind, name, node, {
    visibility: isPub ? 'public' : 'private',
    isExported: isPub,
    ...(Object.keys(meta).length > 0 && { metadata: meta }),
  });
  if (!typeNode) return true;

  ctx.pushScope(typeNode.id);
  for (let i = 0; i < valueNode.namedChildCount; i++) {
    const child = valueNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'container_field' && (isEnum || isTaggedUnion)) {
      const nameField = getChildByField(child, 'name');
      if (nameField) {
        const memberName = getNodeText(nameField, ctx.source);
        if (memberName !== '_') ctx.createNode('enum_member', memberName, child);
      }
    } else {
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

/**
 * Handle @import, @embedFile, and @cImport inside a variable_declaration.
 * Returns true if the node was fully handled.
 */
function handleImports(node: SyntaxNode, ctx: ExtractorContext): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    // @import("module")
    if (child.type === 'builtin_function' || child.type === 'call_expression') {
      const text = ctx.source.substring(child.startIndex, Math.min(child.endIndex, child.startIndex + 20));

      if (text.startsWith('@import(') || findImportBuiltin(child, ctx.source)) {
        const m = ctx.source.substring(child.startIndex, child.endIndex).match(/@import\s*\(\s*"([^"]+)"\s*\)/);
        if (m) {
          const moduleName = m[1]!;
          const sig = ctx.source.substring(node.startIndex, Math.min(node.endIndex, node.startIndex + 80)).trim();
          const importId = ctx.createNode('import', moduleName, node, { signature: sig });
          if (importId) {
            ctx.addUnresolvedReference({
              fromNodeId: importId.id,
              referenceName: moduleName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
          return true;
        }
      }

      // @embedFile("path")
      if (text.startsWith('@embedFile(')) {
        const filePath = extractEmbedFile(child, ctx.source);
        if (filePath) {
          const importId = ctx.createNode('import', filePath, node, { signature: `@embedFile("${filePath}")` });
          if (importId) {
            ctx.addUnresolvedReference({
              fromNodeId: importId.id,
              referenceName: filePath,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
          return true;
        }
      }

      // @cImport(@cInclude("header.h"))
      if (text.startsWith('@cImport(')) {
        const headers = findCIncludes(child, ctx.source);
        for (const header of headers) {
          const importId = ctx.createNode('import', header, node, { signature: `@cImport(@cInclude("${header}"))` });
          if (importId) {
            ctx.addUnresolvedReference({
              fromNodeId: importId.id,
              referenceName: header,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
        if (headers.length > 0) return true;
      }
    }

    // Nested @import inside field_expression (e.g. @import("std").testing)
    if (findImportBuiltin(child, ctx.source)) {
      const importNode = findImportBuiltin(child, ctx.source);
      if (importNode) {
        const text = ctx.source.substring(importNode.startIndex, importNode.endIndex);
        const m = text.match(/@import\s*\(\s*"([^"]+)"\s*\)/);
        if (m) {
          const moduleName = m[1]!;
          const sig = ctx.source.substring(node.startIndex, Math.min(node.endIndex, node.startIndex + 80)).trim();
          const importId = ctx.createNode('import', moduleName, node, { signature: sig });
          if (importId) {
            ctx.addUnresolvedReference({
              fromNodeId: importId.id,
              referenceName: moduleName,
              referenceKind: 'imports',
              line: importNode.startPosition.row + 1,
              column: importNode.startPosition.column,
            });
          }
        }
      }
      return true;
    }
  }
  return false;
}

function handleTypeAlias(node: SyntaxNode, name: string, ctx: ExtractorContext): boolean {
  if (!name || hasKeyword(node, 'var') || node.namedChildCount !== 2) return false;
  const second = node.namedChild(1);
  if (!second || !TYPE_ALIAS_NODE_TYPES.has(second.type) || VALUE_LITERAL_TYPES.has(second.type)) return false;
  const isPub = hasKeyword(node, 'pub');
  ctx.createNode('type_alias', name, node, {
    visibility: isPub ? 'public' : 'private',
    isExported: isPub,
    signature: ctx.source.substring(second.startIndex, Math.min(second.endIndex, second.startIndex + 60)).trim(),
  });
  return true;
}

function handleTestDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  let testName = '';
  let body: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (!testName && child.type === 'string') {
      testName = ctx.source.substring(child.startIndex + 1, child.endIndex - 1);
    } else if (!testName && child.type === 'identifier') {
      testName = getNodeText(child, ctx.source);
    }
    if (child.type === 'block') body = child;
  }
  if (testName && body) {
    const fnNode = ctx.createNode('function', testName, node, {
      visibility: 'private',
      isExported: false,
    });
    if (fnNode) {
      ctx.pushScope(fnNode.id);
      walkBodyForCalls(body, fnNode.id, ctx);
      ctx.popScope();
    }
  }
  return true;
}

function handleContainerField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameField = getChildByField(node, 'name');
  if (!nameField) return true;
  const fieldName = getNodeText(nameField, ctx.source);
  let typeText = '';
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type !== 'identifier' && child.type !== 'container_field_initializer') {
      typeText = ctx.source.substring(child.startIndex, Math.min(child.endIndex, child.startIndex + 60));
      break;
    }
  }
  const fieldNode = ctx.createNode('field', fieldName, node, {
    signature: typeText ? `${typeText} ${fieldName}` : fieldName,
    visibility: hasKeyword(node, 'pub') ? 'public' : 'private',
    isExported: hasKeyword(node, 'pub'),
  });
  if (fieldNode) {
    extractFieldTypeRefs(node, fieldNode.id, ctx);
  }
  return true;
}

function handleBuiltinImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const text = ctx.source.substring(node.startIndex, node.endIndex);

  const m = text.match(/@import\s*\(\s*"([^"]+)"\s*\)/);
  if (m) {
    const moduleName = m[1]!;
    const importId = ctx.createNode('import', moduleName, node, { signature: text.trim() });
    if (importId) {
      ctx.addUnresolvedReference({
        fromNodeId: importId.id,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return true;
  }

  if (text.startsWith('@embedFile(')) {
    const filePath = extractEmbedFile(node, ctx.source);
    if (filePath) {
      const importId = ctx.createNode('import', filePath, node, { signature: `@embedFile("${filePath}")` });
      if (importId) {
        ctx.addUnresolvedReference({
          fromNodeId: importId.id,
          referenceName: filePath,
          referenceKind: 'imports',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return true;
    }
  }

  return false;
}

// ── Extractor ─────────────────────────────────────────────────────────

export const zigExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: ['function_declaration'],
  interfaceTypes: [],
  structTypes: [
    'struct_declaration', 'enum_declaration', 'union_declaration',
    'opaque_declaration', 'error_set_declaration',
  ],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // Zig uses @import() builtins, not import_statement nodes — handled in visitNode
  callTypes: ['call_expression', 'builtin_function'],
  variableTypes: ['variable_declaration'],
  fieldTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',

  classifyClassNode: (node) => {
    if (hasKeyword(node, 'enum') || hasKeyword(node, 'error')) return 'enum';
    return 'struct';
  },

  getVisibility: (node) => {
    if (hasKeyword(node, 'pub') || hasKeyword(node, 'export')) return 'public';
    return 'private';
  },

  isExported: (node) => hasKeyword(node, 'pub') || hasKeyword(node, 'export'),

  isConst: (node) => hasKeyword(node, 'const'),

  extractImport: (node, source) => {
    // @import("module") — standalone builtin_function
    if (node.type === 'builtin_function') {
      const text = source.substring(node.startIndex, node.endIndex);
      const m = text.match(/@import\s*\(\s*"([^"]+)"\s*\)/);
      if (m) return { moduleName: m[1]!, signature: text.trim() };
    }
    // variable_declaration wrapping an @import: const std = @import("std");
    if (node.type === 'variable_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        const importNode = findImportBuiltin(child, source);
        if (importNode) {
          const text = source.substring(importNode.startIndex, importNode.endIndex);
          const m = text.match(/@import\s*\(\s*"([^"]+)"\s*\)/);
          if (m) return { moduleName: m[1]!, signature: text.trim() };
        }
      }
    }
    return null;
  },

  getReceiverType: (node, source) => {
    // Zig method convention: first param is `self: *Type` or `self: Type`
    // Extract the type name from the self parameter.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type !== 'parameters') continue;
      const firstParam = child.namedChild(0);
      if (!firstParam) break;
      // Check if first param name is self/this/super
      const paramName = firstParam.namedChild(0);
      if (!paramName || paramName.type !== 'identifier') break;
      const name = getNodeText(paramName, source);
      if (name !== 'self' && name !== 'this' && name !== 'super') break;
      // Extract the type from the param — could be pointer_type (*Type), identifier (Type)
      for (let j = 1; j < firstParam.namedChildCount; j++) {
        const typeChild = firstParam.namedChild(j);
        if (!typeChild) continue;
        if (typeChild.type === 'pointer_type' || typeChild.type === 'nullable_type') {
          // *Type or ?*Type — get the inner identifier
          const inner = typeChild.namedChild(0);
          if (inner?.type === 'pointer_type') {
            // ?*Type — nullable wrapping pointer
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

  getSignature: (node, source) => extractFnSignature(node, source),

  extractModifiers: (node) => {
    const mods: string[] = [];
    if (hasKeyword(node, 'inline')) mods.push('inline');
    if (hasKeyword(node, 'noinline')) mods.push('noinline');
    if (hasKeyword(node, 'comptime')) mods.push('comptime');
    return mods.length > 0 ? mods : undefined;
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'function_declaration':
        return handleFunctionDeclaration(node, ctx);
      case 'variable_declaration':
        return handleVariableDeclaration(node, ctx);
      case 'test_declaration':
        return handleTestDeclaration(node, ctx);
      case 'comptime_declaration':
      case 'using_namespace_declaration':
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        return true;
      case 'container_field':
        return handleContainerField(node, ctx);
      case 'call_expression':
      case 'builtin_function':
        return handleBuiltinImport(node, ctx);
      default:
        return false;
    }
  },
};
