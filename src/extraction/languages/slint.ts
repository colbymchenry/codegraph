import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function slintSignature(node: SyntaxNode, source: string): string | undefined {
  const args: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && node.fieldNameForNamedChild(i) === 'arguments') {
      args.push(getNodeText(child, source));
    }
  }
  const returnType = getChildByField(node, 'return_type');
  const params = `(${args.join(', ')})`;
  return returnType ? `${params} -> ${getNodeText(returnType, source)}` : params;
}

function slintVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' | undefined {
  const visibility = getChildByField(node, 'visibility');
  if (!visibility) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'function_visibility') {
        const text = child.text;
        if (text === 'public' || text === 'private' || text === 'protected') return text;
      }
    }
    return undefined;
  }

  const text = visibility.text.replace('_', '-');
  if (text === 'private') return 'private';
  return 'public';
}

function slintIsExported(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'exported_definition') return true;
    if (current.type === 'rust_attr') {
      current = current.parent;
      continue;
    }
    current = current.parent;
  }
  return false;
}

function slintImportModule(node: SyntaxNode, source: string): string | null {
  const stringNode = node.namedChildren.find((c) => c.type === 'string_value');
  if (!stringNode) return null;
  return getNodeText(stringNode, source).replace(/^"|"$/g, '');
}

function slintReExportInfo(node: SyntaxNode, source: string): { moduleName: string; names: SyntaxNode[] } | null {
  const moduleName = slintImportModule(node, source);
  if (!moduleName) return null;
  const names = node.namedChildren
    .filter((c) => c.type === 'export_type')
    .map((c) => getChildByField(c, 'local_name') ?? c.namedChildren.find((n) => n.type === 'user_type_identifier'))
    .filter((c): c is SyntaxNode => !!c);
  return names.length > 0 ? { moduleName, names } : null;
}

export const slintExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'function_declaration'],
  classTypes: ['global_definition'],
  methodTypes: ['function_definition', 'function_declaration', 'callback'],
  interfaceTypes: ['interface_definition'],
  structTypes: ['struct_definition'],
  enumTypes: ['enum_definition'],
  enumMemberTypes: ['user_type_identifier'],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['function_call'],
  variableTypes: [],
  propertyTypes: ['property', 'binding_alias'],
  fieldTypes: ['struct_field_definition'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'arguments',
  returnField: 'return_type',
  visitNode: (node, ctx) => {
    if (node.type === 'export_statement') {
      const reExport = slintReExportInfo(node, ctx.source);
      if (!reExport) return false;

      const importNode = ctx.createNode('import', reExport.moduleName, node, {
        signature: getNodeText(node, ctx.source).trim(),
      });
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? importNode?.id;
      if (!fromNodeId) return true;

      for (const nameNode of reExport.names) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: getNodeText(nameNode, ctx.source),
          referenceKind: 'imports',
          line: nameNode.startPosition.row + 1,
          column: nameNode.startPosition.column,
        });
      }
      return true;
    }

    if (node.type === 'component_definition') {
      const nameNode = getChildByField(node, 'name');
      if (!nameNode) return false;

      const component = ctx.createNode('component', getNodeText(nameNode, ctx.source), node, {
        isExported: slintIsExported(node),
      });
      if (!component) return true;

      for (const modifier of node.namedChildren.filter((c) => c.type === 'component_modifier')) {
        const base = getChildByField(modifier, 'base_type');
        if (base) {
          ctx.addUnresolvedReference({
            fromNodeId: component.id,
            referenceName: getNodeText(base, ctx.source),
            referenceKind: 'extends',
            line: base.startPosition.row + 1,
            column: base.startPosition.column,
          });
        }
        const implementsClause = modifier.namedChildren.find((c) => c.type === 'implements_clause');
        if (implementsClause) {
          for (const iface of implementsClause.namedChildren.filter((c) => c.type === 'user_type_identifier')) {
            ctx.addUnresolvedReference({
              fromNodeId: component.id,
              referenceName: getNodeText(iface, ctx.source),
              referenceKind: 'implements',
              line: iface.startPosition.row + 1,
              column: iface.startPosition.column,
            });
          }
        }
      }

      ctx.pushScope(component.id);
      const body = getChildByField(node, 'body') ?? node.namedChildren.find((c) => c.type === 'block');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) ctx.visitNode(child);
        }
      }
      ctx.popScope();
      return true;
    }

    if (node.type === 'component') {
      const typeNode = getChildByField(node, 'type');
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (typeNode && fromNodeId) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: getNodeText(typeNode, ctx.source),
          referenceKind: 'references',
          line: typeNode.startPosition.row + 1,
          column: typeNode.startPosition.column,
        });
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type !== 'user_type_identifier') ctx.visitNode(child);
      }
      return true;
    }

    return false;
  },
  resolveName: (node, source) => {
    if (node.type === 'callback' || node.type === 'property' || node.type === 'binding_alias') {
      const name = getChildByField(node, 'name');
      return name ? getNodeText(name, source) : undefined;
    }
    return undefined;
  },
  resolveBody: (node, bodyField) => {
    const standard = getChildByField(node, bodyField);
    if (standard) return standard;
    if (node.type === 'global_definition') {
      return node.namedChildren.find((c) => c.type === 'global_block') ?? null;
    }
    if (node.type === 'interface_definition') {
      return node.namedChildren.find((c) => c.type === 'interface_block') ?? null;
    }
    if (node.type === 'struct_definition') {
      return node.namedChildren.find((c) => c.type === 'struct_block') ?? null;
    }
    if (node.type === 'enum_definition') {
      return node.namedChildren.find((c) => c.type === 'enum_block') ?? null;
    }
    if (node.type === 'function_definition') {
      return node.namedChildren.find((c) => c.type === 'imperative_block') ?? null;
    }
    return null;
  },
  getSignature: slintSignature,
  getVisibility: slintVisibility,
  isExported: slintIsExported,
  extractPropertyName: (node, source) => {
    const name = getChildByField(node, 'name');
    return name ? getNodeText(name, source) : null;
  },
  extractImport: (node, source) => {
    const moduleName = slintImportModule(node, source);
    if (!moduleName) return null;
    return {
      moduleName,
      signature: getNodeText(node, source).trim(),
    };
  },
};
