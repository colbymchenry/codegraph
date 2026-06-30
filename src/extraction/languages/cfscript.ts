import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/** CFML access modifiers (`public`/`private`/`package`/`remote`) on a function_declaration. */
function cfmlVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' | 'internal' | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'access_type') {
      const text = child.text;
      if (text === 'public') return 'public';
      if (text === 'private') return 'private';
      if (text === 'package') return 'internal';
      if (text === 'remote') return 'public';
    }
  }
  return undefined;
}

export const cfscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'function_expression', 'arrow_function'],
  classTypes: ['component'],
  // `component` is reused for both `component { ... }` and `interface { ... }` —
  // the only difference is the literal first token (verified via the grammar's
  // native binding: child(0).type is 'component' or 'interface', both unnamed).
  classifyClassNode: (node) => (node.child(0)?.type === 'interface' ? 'interface' : 'class'),
  methodTypes: ['function_declaration', 'method_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'include_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['variable_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  getVisibility: cfmlVisibility,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    if (node.type === 'include_statement') {
      // `include "path/to/file.cfm";` — the included template path.
      const expr = node.namedChildren.find((c: SyntaxNode) => c.type === 'string');
      if (!expr) return null;
      const moduleName = getNodeText(expr, source).replace(/^["']|["']$/g, '');
      return moduleName ? { moduleName, signature: importText } : null;
    }

    // `import com.foo.Bar;` (dotted path) or `import "java:java.util.ArrayList";` (string form)
    const sourceNode = getChildByField(node, 'source');
    if (!sourceNode) return null;

    let moduleName: string;
    if (sourceNode.type === 'import_path') {
      moduleName = sourceNode.namedChildren
        .map((c: SyntaxNode) => getNodeText(c, source))
        .join('.');
    } else {
      moduleName = getNodeText(sourceNode, source).replace(/^["']|["']$/g, '');
    }
    return moduleName ? { moduleName, signature: importText } : null;
  },
};
