import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// VB.NET keywords that appear as `field_declaration` misparsed nodes when the
// grammar encounters `Inherits X` / `Implements Y` inside a class body.
const VB_INHERIT_KEYWORDS = new Set([
  'Inherits', 'Implements', 'MustInherit', 'NotInheritable',
  'MustOverride', 'NotOverridable', 'WithEvents',
]);

function getModifierText(node: SyntaxNode): string[] {
  const mods: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'modifiers') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const mod = child.namedChild(j);
        if (mod?.type === 'modifier') mods.push(mod.text);
      }
    }
  }
  return mods;
}

function resolveVisibility(mods: string[]): 'public' | 'private' | 'protected' | 'internal' | undefined {
  if (mods.includes('Public')) return 'public';
  if (mods.includes('Private')) return 'private';
  if (mods.includes('Protected')) return 'protected';
  if (mods.includes('Friend')) return 'internal';
  return undefined;
}

export const vbnetExtractor: LanguageExtractor = {
  functionTypes: [],
  // module_block and structure_block are handled in visitNode below so they get
  // the correct 'module' and 'struct' kinds respectively; only class_block here.
  classTypes: ['class_block'],
  // constructor_declaration handles `Sub New(...)`
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_block'],
  structTypes: [],
  enumTypes: ['enum_block'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: [],
  importTypes: ['imports_statement'],
  callTypes: ['invocation'],
  variableTypes: [],
  propertyTypes: ['property_declaration'],
  fieldTypes: ['field_declaration'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  // VB.NET block nodes are their own body (no separate child named 'body').
  resolveBody: (node) => node,

  getVisibility: (node) => resolveVisibility(getModifierText(node)),

  isStatic: (node) => getModifierText(node).includes('Shared'),

  isAsync: (node) => getModifierText(node).includes('Async'),

  resolveName: (node) => {
    // constructor_declaration has no name field; canonical VB.NET name is "New"
    if (node.type === 'constructor_declaration') return 'New';
    return undefined;
  },

  isExported: (node) => getModifierText(node).includes('Public'),

  // Produce a signature like `(x As Double, y As Double) As Double` for functions,
  // or just `(x As Double, y As Double)` for subs (no return type).
  getSignature: (node, source) => {
    let params: SyntaxNode | null = null;
    let returnType: SyntaxNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'parameter_list') params = child;
      if (child.type === 'type') returnType = child;
    }
    if (!params && !returnType) return undefined;
    const paramStr = params ? source.substring(params.startIndex, params.endIndex) : '()';
    return returnType
      ? `${paramStr} As ${source.substring(returnType.startIndex, returnType.endIndex)}`
      : paramStr;
  },

  extractImport: (node, source) => {
    // imports_statement → namespace: namespace_name → identifier+
    const nsNode = node.childForFieldName('namespace');
    if (!nsNode) return null;
    const moduleName = source.substring(nsNode.startIndex, nsNode.endIndex).trim();
    return {
      moduleName,
      signature: source.substring(node.startIndex, node.endIndex).trim(),
    };
  },

  visitNode: (node, ctx) => {
    // namespace_block — create namespace scope and recurse
    if (node.type === 'namespace_block') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);
      const nsNode = ctx.createNode('namespace', name, node);
      if (nsNode) {
        ctx.pushScope(nsNode.id);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        ctx.popScope();
      }
      return true;
    }

    // module_block — VB.NET Module is a static sealed type; extract as 'module'
    if (node.type === 'module_block') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);
      const mods = getModifierText(node);
      const moduleNode = ctx.createNode('module', name, node, {
        visibility: resolveVisibility(mods),
        isExported: mods.includes('Public'),
        isStatic: true,
      });
      if (moduleNode) {
        ctx.pushScope(moduleNode.id);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        ctx.popScope();
      }
      return true;
    }

    // structure_block — VB.NET Structure is a value type; extract as 'struct'
    if (node.type === 'structure_block') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);
      const mods = getModifierText(node);
      const structNode = ctx.createNode('struct', name, node, {
        visibility: resolveVisibility(mods),
        isExported: mods.includes('Public'),
      });
      if (structNode) {
        ctx.pushScope(structNode.id);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        ctx.popScope();
      }
      return true;
    }

    // const_declaration — extract as constant node
    if (node.type === 'const_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = getNodeText(nameNode, ctx.source);
        const mods = getModifierText(node);
        ctx.createNode('constant', name, node, {
          visibility: resolveVisibility(mods),
          isStatic: mods.includes('Shared'),
        });
      }
      return true;
    }

    // Filter out Inherits/Implements lines misparsed as field_declaration.
    // VB.NET grammar splits `Inherits BaseClass` into two adjacent field_declarations
    // on the same source line: one for the keyword and one for the base name.
    if (node.type === 'field_declaration') {
      const decls = node.namedChildren.filter(c => c.type === 'variable_declarator');
      const nameNode = decls[0]?.childForFieldName('name');
      const name = nameNode ? getNodeText(nameNode, ctx.source) : '';

      // Skip the keyword node itself
      if (VB_INHERIT_KEYWORDS.has(name)) return true;

      // Skip the value node that follows a keyword on the same source line
      const prev = node.previousNamedSibling;
      if (prev?.type === 'field_declaration') {
        const prevDecls = prev.namedChildren.filter(c => c.type === 'variable_declarator');
        const prevNameNode = prevDecls[0]?.childForFieldName('name');
        const prevName = prevNameNode ? getNodeText(prevNameNode, ctx.source) : '';
        if (VB_INHERIT_KEYWORDS.has(prevName) &&
            prev.startPosition.row === node.startPosition.row) {
          return true;
        }
      }
    }

    return false;
  },
};
