import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const AL_EXTENSION_TYPES = new Set([
  'tableextension_declaration',
  'pageextension_declaration',
  'enumextension_declaration',
  'reportextension_declaration',
  'permissionsetextension_declaration',
  'profileextension_declaration',
]);

const AL_CLASS_TYPES = [
  'codeunit_declaration', 'table_declaration', 'page_declaration',
  'report_declaration', 'xmlport_declaration', 'query_declaration',
  ...AL_EXTENSION_TYPES,
];

const AL_OBJECT_NAME_TYPES = new Set([
  ...AL_CLASS_TYPES,
  'enum_declaration',
  'interface_declaration',
]);

function fieldText(node: SyntaxNode, field: string): string | undefined {
  return node.childForFieldName(field)?.text.trim() || undefined;
}

/**
 * Extract an AL field and its field-scoped triggers as real nested symbols.
 * The generic variable path deliberately skips declarations inside classes,
 * while the generic field path does not walk the field body; AL needs both.
 */
function extractField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = fieldText(node, 'name');
  if (!name) return false;

  const type = fieldText(node, 'type');
  const fieldNode = ctx.createNode('field', name, node, {
    signature: type ? `${name}: ${type}` : name,
  });
  if (!fieldNode) return true;

  const body = node.childForFieldName('body');
  if (!body) return true;

  ctx.pushScope(fieldNode.id);
  try {
    for (const child of body.namedChildren) {
      if (child.type !== 'trigger_declaration' && child.type !== 'trigger') {
        ctx.visitNode(child);
        continue;
      }

      const triggerName = fieldText(child, 'name');
      if (!triggerName) {
        ctx.visitNode(child);
        continue;
      }
      const triggerNode = ctx.createNode('method', triggerName, child);
      const triggerBody = child.childForFieldName('body');
      if (!triggerNode || !triggerBody) continue;
      ctx.pushScope(triggerNode.id);
      try {
        ctx.visitFunctionBody(triggerBody, triggerNode.id);
      } finally {
        ctx.popScope();
      }
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

/** Extract an AL extension object and connect it to the object it extends. */
function extractExtension(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = fieldText(node, 'object_name');
  if (!name) return false;

  const extensionNode = ctx.createNode('class', name, node);
  if (!extensionNode) return true;

  const baseObject = node.childForFieldName('base_object');
  if (baseObject) {
    ctx.addUnresolvedReference({
      fromNodeId: extensionNode.id,
      referenceName: baseObject.text,
      referenceKind: 'extends',
      line: baseObject.startPosition.row + 1,
      column: baseObject.startPosition.column,
    });
  }

  const body = node.childForFieldName('body');
  if (!body) return true;
  ctx.pushScope(extensionNode.id);
  try {
    for (const child of body.namedChildren) ctx.visitNode(child);
  } finally {
    ctx.popScope();
  }
  return true;
}

export const alExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: AL_CLASS_TYPES,
  methodTypes: [
    'procedure',
    'procedure_declaration',
    'interface_procedure',
    'trigger',
    'trigger_declaration',
    'event_declaration',
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  typeAliasTypes: [],
  importTypes: ['using_statement'],
  callTypes: ['call_expression', 'call_statement'],
  variableTypes: ['variable_declaration'],
  methodsAreTopLevel: false,
  nameField: 'name',
  resolveName: (node) =>
    AL_OBJECT_NAME_TYPES.has(node.type)
      ? fieldText(node, 'object_name')
      : undefined,
  visitNode: (node, ctx) => {
    if (AL_EXTENSION_TYPES.has(node.type)) return extractExtension(node, ctx);
    if (node.type === 'field_declaration') return extractField(node, ctx);
    // Keep AL's value_name field handling local for both enums and their
    // class-shaped enumextension declarations.
    if (node.type === 'enum_value_declaration') {
      const name = fieldText(node, 'value_name');
      if (!name) return false;
      ctx.createNode('enum_member', name, node);
      return true;
    }
    return false;
  },
  packageTypes: ['namespace_declaration'],
  extractPackage: (node) => fieldText(node, 'name') ?? null,
  extractImport: (node) => {
    const namespace = fieldText(node, 'namespace');
    return namespace ? { moduleName: namespace, signature: node.text.trim() } : null;
  },
  bodyField: 'body',
  paramsField: 'parameters',
};
