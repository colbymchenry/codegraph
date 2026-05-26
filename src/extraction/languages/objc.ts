/**
 * Objective-C language extractor for CodeGraph.
 *
 * Extracts classes (@interface / @implementation), methods (±method),
 * properties (@property), imports (#import / #include), call expressions
 * (message sends and C calls), and top-level variable declarations.
 *
 * Key design choices driven by tree-sitter-objc's AST:
 * - `message_expression` (e.g. `[receiver selector:arg]`) is NOT a `call_expression` —
 *   it must be handled via `visitNode` (class-level) and `extractBareCall` (method-body).
 * - `class_interface` and `class_implementation` both produce 'class' nodes;
 *   `class_implementation` pairs with its interface via name matching.
 * - Method names use ONLY the first keyword (no colons), matching how tree-sitter-objc
 *   names method symbols — this alignment is critical for `callers`/`callees` resolution.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import { getNodeText } from '../tree-sitter-helpers';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the method selector name from a selector_expression or method field node.
 *
 * tree-sitter-objc names method symbols using only the first keyword (no colon).
 * For resolution to work, call edges must use the same naming convention.
 *
 * Examples:
 *   No-arg: `compressionQueue` → "compressionQueue"
 *   Single-arg: `shouldUseReferenceCompressionFlowForScene:scene` → "shouldUseReferenceCompressionFlowForScene"
 *   Multi-arg: `buildMetaInfoWithImageData:asset:scene:completion:` → "buildMetaInfoWithImageData"
 */
function getSelectorName(selectorNode: SyntaxNode, source: string): string {
  // Return ONLY the first keyword (no colon) — matching tree-sitter-objc method naming.
  // ObjC selectors are composed of keyword_argument children;
  // the first keyword is the method's identity for callers/callees resolution.
  const first = selectorNode.namedChild(0);
  if (first) {
    return getNodeText(first, source);
  }
  return getNodeText(selectorNode, source).trim();
}

/**
 * Handle an ObjC property declaration (@property).
 * Extracts the property name and type, creates a 'property' node under the current class.
 */
function handlePropertyDeclaration(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return false;

  const name = getNodeText(nameNode, ctx.source);
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return false;

  let propType = 'unknown';
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'property_type') {
      propType = getNodeText(child, ctx.source);
      break;
    }
  }

  ctx.createNode('property', name, node, {
    signature: `@property ${propType} ${name}`,
  });
  return true; // handled
}

/**
 * Handle a top-level (class-body) ObjC message expression: `[receiver methodName]`.
 * Records an unresolved call reference from the current scope.
 *
 * NOTE: This hook only fires for class-level message expressions (e.g. in ivar
 * initializers or static blocks). Method-body message expressions are handled
 * by `extractBareCall` because `visitFunctionBody` uses a separate inner walker
 * that bypasses the main `visitNode` hook. Without `extractBareCall`, ObjC method
 * calls inside method bodies would never produce call edges.
 */
function handleMessageExpression(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!callerId) return false;

  const methodField = node.childForFieldName('method');
  if (!methodField) return false;

  const methodName = getSelectorName(methodField, ctx.source);
  if (!methodName) return false;

  ctx.addUnresolvedReference({
    fromNodeId: callerId,
    referenceName: methodName,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });

  return false; // let walker descend into children (for nested message expressions)
}

// ─── Extractor ──────────────────────────────────────────────────────────────

export const objcExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_interface', 'class_implementation'],
  methodTypes: ['method_definition', 'method_declaration'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'], // NOTE: message_expression handled by visitNode + extractBareCall
  variableTypes: ['declaration'],
  propertyTypes: ['property_declaration'],
  fieldTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  methodsAreTopLevel: false,

  /**
   * For `method_definition`, the body is a `compound_statement` named child,
   * not a named field. For `method_declaration` (@interface), no body exists.
   */
  resolveBody(node: SyntaxNode): SyntaxNode | null {
    if (node.type === 'method_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'compound_statement') {
          return child;
        }
      }
    }
    return null;
  },

  /**
   * CRITICAL FIX: Called by visitFunctionBody's inner walker for every
   * non-call_expression node inside method/function bodies. We handle
   * `message_expression` here because visitFunctionBody bypasses the
   * main visitNode dispatch hook.
   *
   * Without this, ObjC method calls inside method bodies never create `calls`
   * edges, and `callers`/`callees` return empty results.
   */
  extractBareCall(node: SyntaxNode, source: string): string | undefined {
    if (node.type !== 'message_expression') return undefined;

    const methodField = node.childForFieldName('method');
    if (!methodField) return undefined;

    return getSelectorName(methodField, source);
  },

  /**
   * ObjC class methods start with `+`, instance methods with `-`.
   */
  isStatic(node: SyntaxNode): boolean {
    if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
      return false;
    }
    const punctNode = node.child(0);
    return !(punctNode && punctNode.type === '-'); // '+' or unexpected → static
  },

  /**
   * Custom visitor for top-level nodes (class-body walking).
   * - property_declaration → creates property node under current class
   * - message_expression → creates unresolved call ref (class-level only;
   *   method-body message expressions use extractBareCall instead)
   */
  visitNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
    if (node.type === 'property_declaration') {
      return handlePropertyDeclaration(node, ctx);
    }
    if (node.type === 'message_expression') {
      return handleMessageExpression(node, ctx);
    }
    return false; // not handled, fall through to default walker
  },

  /**
   * Build a readable method signature for display.
   */
  getSignature(node: SyntaxNode, source: string): string | undefined {
    if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
      return undefined;
    }

    const declNode = node.childForFieldName('declaration');
    if (!declNode) return undefined;

    // Build parameter list
    const params: string[] = [];
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const child = declNode.namedChild(i);
      if (child && child.type === 'method_parameter') {
        const paramType = child.childForFieldName('type');
        const paramName = child.childForFieldName('name');
        const typeStr = paramType ? getNodeText(paramType, source) : '?';
        const nameStr = paramName ? getNodeText(paramName, source) : '?';
        params.push(`(${typeStr})${nameStr}`);
      }
    }

    const returnTypeNode = declNode.childForFieldName('return_type');
    let returnType = 'void';
    if (returnTypeNode) {
      returnType = getNodeText(returnTypeNode, source);
    }

    const selectorNode = declNode.childForFieldName('selector');
    let selector = '';
    if (selectorNode) {
      selector = getSelectorName(selectorNode, source);
    }

    if (params.length > 0) {
      return `(${returnType})${selector}:${params[0]}`;
    }
    return `(${returnType})${selector}`;
  },
};
