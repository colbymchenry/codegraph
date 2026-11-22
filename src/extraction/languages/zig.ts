import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import { BUILTIN_TYPE_NAMES, getChildByField, getNodeText, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const ZIG_BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'bool', 'void', 'noreturn', 'type', 'anyerror', 'anyopaque', 'anyframe', 'anytype',
  'comptime_int', 'comptime_float', 'usize', 'isize',
  'f16', 'f32', 'f64', 'f80', 'f128',
  'c_char', 'c_short', 'c_ushort', 'c_int', 'c_uint',
  'c_long', 'c_ulong', 'c_longlong', 'c_ulonglong', 'c_longdouble',
]);

const ZIG_ARB_INT_RE = /^[iu][1-9]\d*$/;

const ZIG_TYPE_EXPR_NODES: ReadonlySet<string> = new Set([
  'builtin_type',
  'pointer_type',
  'nullable_type',
  'slice_type',
  'array_type',
  'error_union_type',
  'function_type',
  'anyframe_type',
]);

const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set(['struct', 'enum', 'union']);

const LITERAL_RECEIVERS: ReadonlySet<string> = new Set([
  'string', 'multiline_string', 'character', 'integer', 'float', 'boolean', 'null', 'undefined',
]);

function isZigBuiltinTypeName(name: string): boolean {
  return ZIG_BUILTIN_TYPES.has(name) || ZIG_ARB_INT_RE.test(name) || BUILTIN_TYPE_NAMES.has(name);
}

function hasKeywordToken(node: SyntaxNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.type === keyword) return true;
    // Stop scanning once we hit the declaration body / initializer / name
    if (child.type === '=' || child.type === 'fn' || child.type === 'block') {
      if (child.type === keyword) return true;
      if (child.type === '=' || child.type === 'block') break;
    }
  }
  return false;
}

function isPublicDecl(node: SyntaxNode): boolean {
  return hasKeywordToken(node, 'pub') || hasKeywordToken(node, 'export');
}

function findEnclosingNode(ctx: ExtractorContext): Node | undefined {
  const topId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!topId) return undefined;
  for (let i = ctx.nodes.length - 1; i >= 0; i--) {
    if (ctx.nodes[i]!.id === topId) return ctx.nodes[i];
  }
  return undefined;
}

function findEnclosingContainerName(ctx: ExtractorContext): string | undefined {
  for (let s = ctx.nodeStack.length - 1; s >= 0; s--) {
    const id = ctx.nodeStack[s];
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i]!;
      if (n.id === id) {
        if (CONTAINER_KINDS.has(n.kind)) return n.name;
        break;
      }
    }
  }
  return undefined;
}

function getStringLiteralContent(node: SyntaxNode, source: string): string | null {
  if (node.type === 'string_content') {
    const text = getNodeText(node, source);
    return text.length > 0 ? text : null;
  }
  if (node.type === 'string') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'string_content') {
        const text = getNodeText(child, source);
        return text.length > 0 ? text : null;
      }
    }
    const raw = getNodeText(node, source).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1) || null;
    }
  }
  return null;
}

function getZigImportPath(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'builtin_function') return null;
  const ident = node.namedChildren.find((c) => c.type === 'builtin_identifier');
  if (!ident || getNodeText(ident, source) !== '@import') return null;
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  if (!args) return null;
  const firstArg = args.namedChild(0);
  if (!firstArg) return null;
  return getStringLiteralContent(firstArg, source);
}

function unwrapImportFieldChain(
  node: SyntaxNode,
  source: string
): { importPath: string; members: string[]; importNode: SyntaxNode } | null {
  const members: string[] = [];
  let cur: SyntaxNode | null = node;
  while (cur && cur.type === 'field_expression') {
    const member = getChildByField(cur, 'member');
    const obj = getChildByField(cur, 'object');
    if (!member || !obj) return null;
    members.unshift(getNodeText(member, source));
    cur = obj;
  }
  if (!cur) return null;
  const importPath = getZigImportPath(cur, source);
  if (!importPath) return null;
  return { importPath, members, importNode: cur };
}

function flattenDottedChain(node: SyntaxNode, source: string): string | null {
  if (node.type === 'identifier') {
    return getNodeText(node, source);
  }
  if (node.type === 'field_expression') {
    const obj = getChildByField(node, 'object');
    const member = getChildByField(node, 'member');
    if (!obj || !member) return null;
    const prefix = flattenDottedChain(obj, source);
    if (!prefix) return null;
    return `${prefix}.${getNodeText(member, source)}`;
  }
  return null;
}

function getVariableNameNode(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && (child.type === ':' || child.type === '=')) break;
    if (child.isNamed && child.type === 'identifier') return child;
  }
  return null;
}

function getVariableInitializer(node: SyntaxNode): SyntaxNode | null {
  let seenEq = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.type === '=') {
      seenEq = true;
      continue;
    }
    if (seenEq && child.isNamed && child.type !== 'comment') {
      return child;
    }
  }
  return null;
}

function extractZigReturnType(node: SyntaxNode, source: string): string | undefined {
  let rt = getChildByField(node, 'type');
  if (!rt) return undefined;

  for (let depth = 0; depth < 6 && rt; depth++) {
    if (rt.type === 'error_union_type') {
      // `Err!Payload` or `!Payload`: payload is the last named child
      rt = rt.namedChild(rt.namedChildCount - 1);
    } else if (rt.type === 'nullable_type' || rt.type === 'pointer_type') {
      rt = rt.namedChild(rt.namedChildCount - 1);
    } else {
      break;
    }
  }
  if (!rt || rt.type === 'builtin_type') return undefined;

  const chain = flattenDottedChain(rt, source);
  if (!chain) return undefined;
  const tail = chain.split('.').pop();
  if (!tail || isZigBuiltinTypeName(tail) || !/^[A-Z]\w*$/.test(tail)) return undefined;
  return tail;
}

function getFunctionSignature(node: SyntaxNode, source: string): string | undefined {
  const params = node.namedChildren.find((c) => c.type === 'parameters');
  const returnType = getChildByField(node, 'type');
  if (!params) return undefined;
  let sig = getNodeText(params, source);
  if (returnType) {
    sig += ' ' + getNodeText(returnType, source);
  }
  return sig;
}

function isStaticMethod(node: SyntaxNode, containerName: string, source: string): boolean {
  const params = node.namedChildren.find((c) => c.type === 'parameters');
  const firstParam = params?.namedChildren.find((c) => c.type === 'parameter');
  if (!firstParam) return true;

  const paramName = getChildByField(firstParam, 'name');
  if (paramName && getNodeText(paramName, source) === 'self') return false;

  const paramType = getChildByField(firstParam, 'type');
  if (paramType) {
    const typeText = getNodeText(paramType, source);
    if (typeText.includes('@This()')) return false;
    const stripped = typeText.replace(/^[?*[\]\s]+/, '').replace(/^const\s+/, '');
    if (stripped === containerName) return false;
  }
  return true;
}

function emitImportRef(
  ctx: ExtractorContext,
  importPath: string,
  anchorNode: SyntaxNode,
  source: string,
  isExported: boolean
): void {
  const impNode = ctx.createNode('import', importPath, anchorNode, {
    signature: getNodeText(anchorNode, source).trim().slice(0, 120),
    isExported,
  });

  if (impNode && ctx.nodeStack.length > 0) {
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (fromNodeId) {
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: importPath,
        referenceKind: 'imports',
        line: anchorNode.startPosition.row + 1,
        column: anchorNode.startPosition.column,
      });
    }
  }
}

function emitTypeRefs(
  typeNode: SyntaxNode,
  fromNodeId: string,
  ctx: ExtractorContext,
  skipSelfName?: string
): void {
  const { source } = ctx;
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'builtin_type') return;
    if (n.type === 'field_expression') {
      const chain = flattenDottedChain(n, source);
      if (chain) {
        const tail = chain.split('.').pop()!;
        if (!isZigBuiltinTypeName(tail) && tail !== skipSelfName) {
          ctx.addUnresolvedReference({
            fromNodeId,
            referenceName: chain,
            referenceKind: 'references',
            line: n.startPosition.row + 1,
            column: n.startPosition.column,
          });
        }
        return;
      }
    }
    if (n.type === 'identifier') {
      const text = getNodeText(n, source);
      if (text && text !== '_' && text !== skipSelfName && !isZigBuiltinTypeName(text) && /^[A-Z]/.test(text)) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: text,
          referenceKind: 'references',
          line: n.startPosition.row + 1,
          column: n.startPosition.column,
        });
      }
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(typeNode);
}

function isLikelyTypeAlias(name: string, typeAnnotation: SyntaxNode | null, init: SyntaxNode, source: string): boolean {
  if (ZIG_TYPE_EXPR_NODES.has(init.type)) return true;
  if (typeAnnotation) {
    return getNodeText(typeAnnotation, source).trim() === 'type';
  }
  if (!/^[A-Z]/.test(name)) return false;
  if (init.type === 'identifier' || init.type === 'field_expression') {
    const chain = flattenDottedChain(init, source);
    if (chain) {
      const tail = chain.split('.').pop()!;
      return /^[A-Z]/.test(tail) || isZigBuiltinTypeName(tail);
    }
  }
  return false;
}

function visitContainerBody(containerNode: SyntaxNode, kind: NodeKind, ctx: ExtractorContext): void {
  const { source } = ctx;
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const ownerName = findEnclosingNode(ctx)?.name;

  for (let i = 0; i < containerNode.namedChildCount; i++) {
    const child = containerNode.namedChild(i);
    if (!child) continue;

    if (child.type === 'container_field') {
      const fieldNameNode = getChildByField(child, 'name');
      const fieldName = fieldNameNode ? getNodeText(fieldNameNode, source) : '';
      if (fieldName) {
        const fieldKind: NodeKind = kind === 'enum' ? 'enum_member' : 'field';
        const fieldType = getChildByField(child, 'type');
        const sig = fieldType ? `: ${getNodeText(fieldType, source).trim()}` : undefined;
        const fieldNode = ctx.createNode(fieldKind, fieldName, child, {
          signature: sig,
          docstring: getPrecedingDocstring(child, source, [], true, true),
        });
        if (fieldType && ownerId) {
          emitTypeRefs(fieldType, fieldNode?.id ?? ownerId, ctx, ownerName);
        }
      }
      // Walk any default-value initializer expression on the field for calls/@import
      const fieldType = getChildByField(child, 'type');
      const fieldNameNodeRef = getChildByField(child, 'name');
      for (let j = 0; j < child.namedChildCount; j++) {
        const sub = child.namedChild(j);
        if (!sub || sub.type === 'comment') continue;
        if (fieldNameNodeRef && sub.equals(fieldNameNodeRef)) continue;
        if (fieldType && sub.equals(fieldType)) continue;
        walkZigExpression(sub, ctx);
      }
      continue;
    }

    if (child.type === 'function_declaration') {
      visitZigFunction(child, ctx);
      continue;
    }

    if (child.type === 'variable_declaration') {
      visitZigVariable(child, ctx, false);
      continue;
    }

    if (child.type === 'test_declaration') {
      visitZigTest(child, ctx);
      continue;
    }

    if (child.type === 'comptime_declaration') {
      walkZigExpression(child, ctx);
      continue;
    }
  }
}

function visitZigFunction(node: SyntaxNode, ctx: ExtractorContext): void {
  const { source } = ctx;
  const nameNode = getChildByField(node, 'name');
  const name = nameNode ? getNodeText(nameNode, source) : '';
  if (!name) return;

  const enclosing = findEnclosingNode(ctx);
  const inContainer = enclosing ? CONTAINER_KINDS.has(enclosing.kind) : false;
  const isPub = isPublicDecl(node);
  const kind: NodeKind = inContainer ? 'method' : 'function';

  const funcNode = ctx.createNode(kind, name, node, {
    signature: getFunctionSignature(node, source),
    visibility: isPub ? 'public' : 'private',
    isExported: isPub,
    isStatic: inContainer && enclosing ? isStaticMethod(node, enclosing.name, source) : undefined,
    returnType: extractZigReturnType(node, source),
    docstring: getPrecedingDocstring(node, source, [], true, true),
  });

  if (!funcNode) return;

  ctx.pushScope(funcNode.id);

  const params = node.namedChildren.find((c) => c.type === 'parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type !== 'parameter') continue;
      const paramType = getChildByField(param, 'type');
      if (paramType) emitTypeRefs(paramType, funcNode.id, ctx);
    }
  }

  const returnType = getChildByField(node, 'type');
  if (returnType) {
    emitTypeRefs(returnType, funcNode.id, ctx);
  }

  const body = getChildByField(node, 'body');
  if (body) {
    walkZigExpression(body, ctx);
  }

  ctx.popScope();
}

function visitZigTest(node: SyntaxNode, ctx: ExtractorContext): void {
  const { source } = ctx;
  const stringChild = node.namedChildren.find((c) => c.type === 'string');
  const identChild = node.namedChildren.find((c) => c.type === 'identifier');
  const body = node.namedChildren.find((c) => c.type === 'block');

  let name: string;
  if (stringChild) {
    const label = getStringLiteralContent(stringChild, source);
    name = label ? `test "${label}"` : `test@L${node.startPosition.row + 1}`;
  } else if (identChild) {
    name = `test ${getNodeText(identChild, source)}`;
  } else {
    name = `test@L${node.startPosition.row + 1}`;
  }

  const testNode = ctx.createNode('function', name, node, {
    visibility: 'private',
    isExported: false,
    docstring: getPrecedingDocstring(node, source, [], true, true),
  });
  if (!testNode) return;

  ctx.pushScope(testNode.id);
  if (identChild) {
    const target = getNodeText(identChild, source);
    if (target && !isZigBuiltinTypeName(target)) {
      ctx.addUnresolvedReference({
        fromNodeId: testNode.id,
        referenceName: target,
        referenceKind: 'references',
        line: identChild.startPosition.row + 1,
        column: identChild.startPosition.column,
      });
    }
  }
  if (body) {
    walkZigExpression(body, ctx);
  }
  ctx.popScope();
}

function visitZigVariable(node: SyntaxNode, ctx: ExtractorContext, inFunctionBody: boolean): void {
  const { source } = ctx;
  const nameNode = getVariableNameNode(node);
  const name = nameNode ? getNodeText(nameNode, source) : '';
  const init = getVariableInitializer(node);
  const typeAnnotation = getChildByField(node, 'type');

  // Discard `_ = expr;` — never create a node, still walk RHS for calls/imports.
  if (!name || name === '_') {
    if (init) walkZigExpression(init, ctx);
    return;
  }

  const isPub = isPublicDecl(node);
  const isConst = hasKeywordToken(node, 'const');
  const docstring = getPrecedingDocstring(node, source, [], true, true);

  // @import("...") or @import("...").Member(.Sub)
  if (init) {
    const importChain = unwrapImportFieldChain(init, source);
    if (importChain) {
      emitImportRef(ctx, importChain.importPath, node, source, isPub);
      return;
    }

    // Named container types: struct, enum, union, opaque, error set
    if (
      init.type === 'struct_declaration' ||
      init.type === 'enum_declaration' ||
      init.type === 'union_declaration' ||
      init.type === 'opaque_declaration' ||
      init.type === 'error_set_declaration'
    ) {
      let kind: NodeKind;
      let signature: string | undefined;
      if (init.type === 'struct_declaration') {
        kind = 'struct';
      } else if (init.type === 'enum_declaration') {
        kind = 'enum';
      } else if (init.type === 'union_declaration') {
        kind = 'union';
      } else if (init.type === 'opaque_declaration') {
        kind = 'struct';
        signature = 'opaque';
      } else {
        kind = 'enum';
        signature = 'error';
      }

      const containerNode = ctx.createNode(kind, name, node, {
        visibility: isPub ? 'public' : 'private',
        isExported: isPub,
        signature,
        docstring,
      });

      if (containerNode) {
        ctx.pushScope(containerNode.id);
        if (init.type === 'error_set_declaration') {
          for (const errIdent of init.namedChildren) {
            if (errIdent.type === 'identifier') {
              ctx.createNode('enum_member', getNodeText(errIdent, source), errIdent, {
                docstring: getPrecedingDocstring(errIdent, source, [], true, true),
              });
            }
          }
        } else {
          visitContainerBody(init, kind, ctx);
        }
        ctx.popScope();
      }
      return;
    }
  }

  // Inside function/test bodies, skip creating nodes for local variables/constants,
  // but still capture type references and walk initializers for calls/imports.
  if (inFunctionBody) {
    const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (typeAnnotation && callerId) {
      emitTypeRefs(typeAnnotation, callerId, ctx);
    }
    if (init) walkZigExpression(init, ctx);
    return;
  }

  // File- or container-level const / var / type_alias
  const kind: NodeKind =
    isConst && init && isLikelyTypeAlias(name, typeAnnotation, init, source)
      ? 'type_alias'
      : isConst
        ? 'constant'
        : 'variable';

  const initSnippet = init ? getNodeText(init, source).trim().slice(0, 100) : '';
  const typeSnippet = typeAnnotation ? getNodeText(typeAnnotation, source).trim() : '';
  const signature = typeSnippet
    ? `: ${typeSnippet}${initSnippet ? ` = ${initSnippet}` : ''}`
    : initSnippet
      ? `= ${initSnippet}`
      : undefined;

  const declNode = ctx.createNode(kind, name, node, {
    visibility: isPub ? 'public' : 'private',
    isExported: isPub,
    signature,
    docstring,
  });

  const refSourceId = declNode?.id ?? ctx.nodeStack[ctx.nodeStack.length - 1];
  if (typeAnnotation && refSourceId) {
    emitTypeRefs(typeAnnotation, refSourceId, ctx, name);
  }

  if (init) {
    if (kind === 'type_alias' && refSourceId) {
      emitTypeRefs(init, refSourceId, ctx, name);
    }
    walkZigExpression(init, ctx);
  }
}

function walkZigExpression(node: SyntaxNode, ctx: ExtractorContext): void {
  const { source } = ctx;
  const nodeType = node.type;

  if (nodeType === 'variable_declaration') {
    visitZigVariable(node, ctx, true);
    return;
  }

  if (nodeType === 'function_declaration') {
    visitZigFunction(node, ctx);
    return;
  }

  if (nodeType === 'test_declaration') {
    visitZigTest(node, ctx);
    return;
  }

  // Anonymous container returned from a generic function (e.g. `return struct { pub fn len(...) ... };`)
  if (
    nodeType === 'struct_declaration' ||
    nodeType === 'enum_declaration' ||
    nodeType === 'union_declaration' ||
    nodeType === 'opaque_declaration'
  ) {
    const kind: NodeKind =
      nodeType === 'enum_declaration' ? 'enum' : nodeType === 'union_declaration' ? 'union' : 'struct';
    visitContainerBody(node, kind, ctx);
    return;
  }

  if (nodeType === 'call_expression') {
    const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const fnNode = getChildByField(node, 'function');
    let handledImportNode: SyntaxNode | null = null;

    if (callerId && fnNode) {
      if (fnNode.type === 'identifier') {
        const callee = getNodeText(fnNode, source);
        if (callee) {
          ctx.addUnresolvedReference({
            fromNodeId: callerId,
            referenceName: callee,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      } else if (fnNode.type === 'field_expression') {
        const importChain = unwrapImportFieldChain(fnNode, source);
        if (importChain && importChain.members.length > 0) {
          handledImportNode = importChain.importNode;
          emitImportRef(ctx, importChain.importPath, importChain.importNode, source, false);
          ctx.addUnresolvedReference({
            fromNodeId: callerId,
            referenceName: `@import("${importChain.importPath}").${importChain.members.join('.')}`,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        } else {
          const chain = flattenDottedChain(fnNode, source);
          if (chain) {
            let refName = chain;
            if (chain.startsWith('self.')) {
              const container = findEnclosingContainerName(ctx);
              refName = container ? `${container}.${chain.slice(5)}` : chain.slice(5);
            }
            ctx.addUnresolvedReference({
              fromNodeId: callerId,
              referenceName: refName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          } else {
            const obj = getChildByField(fnNode, 'object');
            const member = getChildByField(fnNode, 'member');
            if (member && (!obj || !LITERAL_RECEIVERS.has(obj.type))) {
              const memberName = getNodeText(member, source);
              if (memberName) {
                ctx.addUnresolvedReference({
                  fromNodeId: callerId,
                  referenceName: memberName,
                  referenceKind: 'calls',
                  line: node.startPosition.row + 1,
                  column: node.startPosition.column,
                });
              }
            }
          }
        }
      }
    }

    // Walk receiver sub-expressions (skipping the handled @import builtin) and all call arguments
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (fnNode && child.equals(fnNode)) {
        if (fnNode.type === 'field_expression') {
          const obj = getChildByField(fnNode, 'object');
          if (obj && (!handledImportNode || !obj.equals(handledImportNode))) {
            walkZigExpression(obj, ctx);
          }
        }
        continue;
      }
      walkZigExpression(child, ctx);
    }
    return;
  }

  if (nodeType === 'builtin_function') {
    const importPath = getZigImportPath(node, source);
    if (importPath) {
      emitImportRef(ctx, importPath, node, source, false);
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walkZigExpression(child, ctx);
    }
    return;
  }

  if (nodeType === 'struct_initializer') {
    const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const typeExpr = node.namedChild(0);
    if (callerId && typeExpr && typeExpr.type !== 'initializer_list') {
      const chain = flattenDottedChain(typeExpr, source);
      if (chain) {
        const tail = chain.split('.').pop()!;
        if (!isZigBuiltinTypeName(tail)) {
          ctx.addUnresolvedReference({
            fromNodeId: callerId,
            referenceName: chain,
            referenceKind: 'instantiates',
            line: typeExpr.startPosition.row + 1,
            column: typeExpr.startPosition.column,
          });
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && !(typeExpr && child.equals(typeExpr) && child.type !== 'initializer_list')) {
        walkZigExpression(child, ctx);
      }
    }
    return;
  }

  // Capitalized static member read (`Point.origin`, `Color.red`, `errors.Refused`)
  if (nodeType === 'field_expression') {
    const importChain = unwrapImportFieldChain(node, source);
    if (importChain) {
      emitImportRef(ctx, importChain.importPath, importChain.importNode, source, false);
      const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (callerId && importChain.members.length > 0) {
        ctx.addUnresolvedReference({
          fromNodeId: callerId,
          referenceName: `@import("${importChain.importPath}").${importChain.members.join('.')}`,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const chain = flattenDottedChain(node, source);
    if (callerId && chain) {
      const first = chain.split('.')[0]!;
      if (/^[A-Z]/.test(first) && !isZigBuiltinTypeName(first)) {
        ctx.addUnresolvedReference({
          fromNodeId: callerId,
          referenceName: chain,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
        return;
      }
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkZigExpression(child, ctx);
  }
}

export const zigExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_declaration'],
  unionTypes: ['union_declaration'],
  enumTypes: ['enum_declaration', 'error_set_declaration'],
  enumMemberTypes: ['container_field'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call_expression'],
  variableTypes: ['variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getSignature: getFunctionSignature,
  getVisibility: (node) => (isPublicDecl(node) ? 'public' : 'private'),
  isExported: (node) => isPublicDecl(node),
  getReturnType: extractZigReturnType,

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'function_declaration':
        visitZigFunction(node, ctx);
        return true;
      case 'variable_declaration':
        visitZigVariable(node, ctx, false);
        return true;
      case 'test_declaration':
        visitZigTest(node, ctx);
        return true;
      case 'comptime_declaration':
        walkZigExpression(node, ctx);
        return true;
      case 'container_field': {
        // File-level struct fields (Zig files are implicitly structs!)
        const { source } = ctx;
        const fieldNameNode = getChildByField(node, 'name');
        const fieldName = fieldNameNode ? getNodeText(fieldNameNode, source) : '';
        if (fieldName) {
          const fieldType = getChildByField(node, 'type');
          const sig = fieldType ? `: ${getNodeText(fieldType, source).trim()}` : undefined;
          const fieldNode = ctx.createNode('field', fieldName, node, {
            signature: sig,
            docstring: getPrecedingDocstring(node, source, [], true, true),
          });
          if (fieldType) {
            const ownerId = fieldNode?.id ?? ctx.nodeStack[ctx.nodeStack.length - 1];
            if (ownerId) emitTypeRefs(fieldType, ownerId, ctx);
          }
        }
        return true;
      }
      case 'builtin_function': {
        const importPath = getZigImportPath(node, ctx.source);
        if (importPath) {
          emitImportRef(ctx, importPath, node, ctx.source, false);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  },
};
