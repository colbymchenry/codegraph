import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function getValVarName(node: SyntaxNode, source: string): string | null {
  const patternNode = node.childForFieldName('pattern');
  if (!patternNode) return null;
  if (patternNode.type === 'identifier') return getNodeText(patternNode, source);
  const identChild = patternNode.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  return identChild ? getNodeText(identChild, source) : null;
}

// Capitalized Scala primitives/ubiquitous aliases that shouldn't create refs.
const SCALA_BUILTIN_TYPES = new Set([
  'Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Char', 'Unit',
  'String', 'Any', 'AnyRef', 'AnyVal', 'Nothing', 'Null',
]);

/**
 * Emit `references` edges for every type identifier in a Scala type subtree
 * (a `val`/`var` type annotation), unwrapping `generic_type` etc. Mirrors the
 * generic type-annotation extraction the core extractor runs for method
 * parameter/return types, but Scala `val`s are created here in visitNode so
 * their type is walked here too. A trait used only as a field type (the common
 * `implicit val x: Monoid[Int]` instance pattern) thus gains a dependent.
 */
function emitScalaTypeRefs(typeNode: SyntaxNode, fromId: string, ctx: { addUnresolvedReference: (r: { fromNodeId: string; referenceName: string; referenceKind: 'references'; line: number; column: number }) => void }, source: string): void {
  if (typeNode.type === 'type_identifier') {
    const name = source.substring(typeNode.startIndex, typeNode.endIndex);
    if (name && !SCALA_BUILTIN_TYPES.has(name)) {
      ctx.addUnresolvedReference({
        fromNodeId: fromId,
        referenceName: name,
        referenceKind: 'references',
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }
    return;
  }
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child) emitScalaTypeRefs(child, fromId, ctx, source);
  }
}

function extractVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'modifiers' || child.type === 'access_modifier') {
      const text = child.text;
      if (text.includes('private')) return 'private';
      if (text.includes('protected')) return 'protected';
    }
  }
  return 'public';
}

export const scalaExtractor: LanguageExtractor = {
  // top-level function_definition is handled via methodTypes (same pattern as Kotlin)
  functionTypes: [],
  classTypes: ['class_definition', 'object_definition', 'trait_definition'],
  methodTypes: ['function_definition', 'function_declaration'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: [],        // handled in visitNode — enum_case_definitions wraps the cases
  typeAliasTypes: ['type_definition'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: [],          // val/var handled in visitNode (use `pattern` field, not `name`)
  fieldTypes: [],
  extraClassNodeTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  interfaceKind: 'trait',

  classifyClassNode: (node: SyntaxNode) => {
    if (node.type === 'trait_definition') return 'trait';
    return 'class';
  },

  getSignature: (node: SyntaxNode, source: string) => {
    const params = node.childForFieldName('parameters');
    const returnType = node.childForFieldName('return_type');
    if (!params && !returnType) return undefined;
    let sig = params ? getNodeText(params, source) : '';
    if (returnType) sig += ': ' + getNodeText(returnType, source);
    return sig || undefined;
  },

  getVisibility: (node: SyntaxNode) => extractVisibility(node),

  isAsync: () => false,

  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'modifiers' && child.text.includes('static')) return true;
    }
    return false;
  },

  visitNode: (node: SyntaxNode, ctx) => {
    const t = node.type;

    // val/var: name is in `pattern` field (identifier), not `name`
    if (t === 'val_definition' || t === 'var_definition') {
      const name = getValVarName(node, ctx.source);
      if (!name) return false;

      const isInClass = ctx.nodeStack.length > 0 &&
        (() => {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
          const parentNode = ctx.nodes.find((n) => n.id === parentId);
          return parentNode != null && (
            parentNode.kind === 'class' || parentNode.kind === 'trait' ||
            parentNode.kind === 'interface' || parentNode.kind === 'struct' ||
            parentNode.kind === 'enum' || parentNode.kind === 'module'
          );
        })();

      const kind = isInClass ? 'field' : (t === 'val_definition' ? 'constant' : 'variable');
      const typeNode = node.childForFieldName('type');
      const sig = typeNode
        ? `${t === 'val_definition' ? 'val' : 'var'} ${name}: ${getNodeText(typeNode, ctx.source)}`
        : undefined;

      const created = ctx.createNode(kind, name, node, { signature: sig, visibility: extractVisibility(node) });
      if (created && typeNode) emitScalaTypeRefs(typeNode, created.id, ctx, ctx.source);
      return true;
    }

    // enum_case_definitions wraps simple_enum_case / full_enum_case children
    if (t === 'enum_case_definitions') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'simple_enum_case' || child.type === 'full_enum_case') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) ctx.createNode('enum_member', getNodeText(nameNode, ctx.source), child);
        }
      }
      return true;
    }

    // extension_definition: visit body children directly, no container node
    if (t === 'extension_definition') {
      const body = node.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) ctx.visitNode(child);
        }
      }
      return true;
    }

    return false;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    const importText = getNodeText(node, source).trim();
    const pathNode = node.childForFieldName('path');
    if (pathNode) return { moduleName: getNodeText(pathNode, source), signature: importText };
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier' || child?.type === 'stable_identifier') {
        return { moduleName: getNodeText(child, source), signature: importText };
      }
    }
    return null;
  },
};
