import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/** Check if a node matches the `fun interface` misparse pattern */
function isFunInterfaceNode(node: SyntaxNode): boolean {
  let hasFun = false;
  let hasInterfaceType = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'fun' && !child.isNamed) hasFun = true;
    if (child.type === 'user_type') {
      const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId && typeId.text === 'interface') hasInterfaceType = true;
    }
    // Pattern 2b: user_type("interface") is inside an ERROR child
    if (child.type === 'ERROR') {
      for (let j = 0; j < child.childCount; j++) {
        const gc = child.child(j);
        if (gc && gc.type === 'user_type') {
          const typeId = gc.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId && typeId.text === 'interface') hasInterfaceType = true;
        }
      }
    }
  }
  return hasFun && hasInterfaceType;
}

export const kotlinExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: [], // Handled via classifyClassNode
  structTypes: [], // Kotlin uses data classes
  enumTypes: [], // Handled via classifyClassNode
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_header'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration'],
  fieldTypes: ['property_declaration'],
  extraClassNodeTypes: ['object_declaration'],
  nameField: 'simple_identifier',
  bodyField: 'function_body',
  visitNode: (node, ctx) => {
    // Handle Kotlin `fun interface` declarations.
    // Tree-sitter-kotlin doesn't support `fun interface` syntax (Kotlin 1.4+).
    // It produces two different misparse patterns:
    //   Pattern 1 (simple): ERROR node + sibling lambda_literal for body
    //   Pattern 2 (complex): function_declaration misparse with ERROR child
    // Skip lambda_literal bodies that were already consumed by a fun interface ERROR node
    if (node.type === 'lambda_literal') {
      const prev = node.previousSibling;
      if (prev && prev.type === 'ERROR' && isFunInterfaceNode(prev)) return true;
      return false;
    }

    if (node.type !== 'ERROR' && node.type !== 'function_declaration') return false;

    // Skip ERROR nodes that are class bodies (start with `{`). These contain parent
    // methods + trailing `fun interface` tokens. The methods are extracted via
    // resolveBody; handling the ERROR here would consume the whole body.
    if (node.type === 'ERROR') {
      const firstChild = node.child(0);
      if (firstChild && firstChild.type === '{') return false;
    }

    if (!isFunInterfaceNode(node)) return false;

    // Extract the interface name.
    // For function_declaration misparses (patterns 2a/2b), the real name is inside
    // an ERROR child — direct simple_identifier children are the misparsed method name.
    let nameText: string | null = null;
    if (node.type === 'function_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'ERROR') {
          for (let j = 0; j < child.childCount; j++) {
            const gc = child.child(j);
            if (gc && gc.type === 'simple_identifier') {
              nameText = gc.text;
              break;
            }
          }
          if (nameText) break;
        }
      }
    }
    // Fallback: direct simple_identifier child (Pattern 1: ERROR node at top level)
    if (!nameText) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'simple_identifier') {
          nameText = child.text;
          break;
        }
      }
    }
    if (!nameText) return false;

    // Create the interface node
    const ifaceNode = ctx.createNode('interface', nameText, node);
    if (!ifaceNode) return false;

    ctx.pushScope(ifaceNode.id);

    if (node.type === 'ERROR') {
      // Pattern 1: body is in the next sibling lambda_literal
      const nextSibling = node.nextSibling;
      if (nextSibling && nextSibling.type === 'lambda_literal') {
        for (let i = 0; i < nextSibling.namedChildCount; i++) {
          const child = nextSibling.namedChild(i);
          if (child && child.type === 'statements') {
            for (let j = 0; j < child.namedChildCount; j++) {
              const stmt = child.namedChild(j);
              if (stmt) ctx.visitNode(stmt);
            }
          }
        }
      }
    }
    // Pattern 2 (function_declaration): nested classes are siblings at source_file level,
    // already visited by the normal traversal. The single abstract method is misparsed
    // and cannot be reliably recovered, but the interface node itself is the key value.

    ctx.popScope();
    return true;
  },
  paramsField: 'function_value_parameters',
  returnField: 'type',
  resolveBody: (node, _bodyField) => {
    // Kotlin's tree-sitter grammar doesn't use field names, so getChildByField fails.
    // Find body by type: function_body for functions/methods, class_body for classes,
    // enum_class_body for enums.
    //
    // Special case: when a class/interface contains a nested `fun interface`, tree-sitter
    // misparsed the parent's body as an ERROR node (starting with `{`) and creates
    // a class_body sibling for the nested interface's body. Prefer the ERROR body
    // so the parent's methods are extracted.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'ERROR') {
        const firstChild = child.child(0);
        if (firstChild && firstChild.type === '{') {
          return child;
        }
      }
      if (child && (child.type === 'function_body' || child.type === 'class_body' || child.type === 'enum_class_body')) {
        return child;
      }
    }
    return null;
  },
  classifyClassNode: (node) => {
    // Kotlin reuses class_declaration for classes, interfaces, and enums.
    // Detect by checking for keyword children:
    //   interface Foo { }       → has 'interface' keyword child
    //   enum class Level { }    → has 'enum' keyword child
    //   class / data class / abstract class → default 'class'
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'interface') return 'interface';
      if (child.type === 'enum') return 'enum';
    }
    return 'class';
  },
  getReceiverType: (node, source) => {
    // Kotlin extension functions: fun Type.method() { }
    // AST: function_declaration > user_type, ".", simple_identifier
    // The user_type before the dot is the receiver type.
    let foundUserType: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'user_type') {
        foundUserType = child;
      } else if (child.type === '.' && foundUserType) {
        // The user_type before the dot is the receiver type
        const typeId = foundUserType.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        return typeId ? getNodeText(typeId, source) : getNodeText(foundUserType, source);
      } else if (child.type === 'simple_identifier' || child.type === 'function_value_parameters') {
        // Past the function name — no receiver
        break;
      }
    }
    return undefined;
  },
  getSignature: (node, source) => {
    // Kotlin function signature: fun name(params): ReturnType
    const params = getChildByField(node, 'function_value_parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Kotlin
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
        if (text.includes('internal')) return 'internal';
      }
    }
    return 'public'; // Kotlin defaults to public
  },
  isStatic: (_node) => {
    // Kotlin doesn't have static, uses companion objects
    return false;
  },
  isAsync: (node) => {
    // Kotlin uses suspend keyword for coroutines
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('suspend')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};
