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

/**
 * A string literal's text when it is written out in full, or null when a
 * `#…#` expression builds it at runtime (`"#dir#/x.cfm"`): such a path names
 * no file the index can link.
 */
function literalString(node: SyntaxNode | null | undefined, source: string): string | null {
  if (node?.type !== 'string' || node.namedChildren.some((c: SyntaxNode) => c.type !== 'string_fragment')) return null;
  return getNodeText(node, source).replace(/^["']|["']$/g, '').trim() || null;
}

/** The value of a `template=…` argument or attribute, when it is a literal string. */
function templateArgument(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'assignment_expression') return null;
  const left = getChildByField(node, 'left');
  if (left?.type !== 'identifier' || getNodeText(left, source).toLowerCase() !== 'template') return null;
  return literalString(getChildByField(node, 'right'), source);
}

/**
 * Whether a call is `cfinclude(…)` — the function form of `include` and of
 * `<cfinclude>` (ACF 11+, Lucee): an include of a template, not a call (#2651).
 */
export function isCfIncludeCall(node: SyntaxNode, source: string): boolean {
  const fn = getChildByField(node, 'function');
  return fn?.type === 'identifier' && getNodeText(fn, source).toLowerCase() === 'cfinclude';
}

/** The literal template `cfinclude(template="x.cfm")` or `cfinclude("x.cfm")` names. */
function cfIncludeCallTemplate(node: SyntaxNode, source: string): string | null {
  const args = getChildByField(node, 'arguments');
  if (!args) return null;
  for (const arg of args.namedChildren) {
    const named = templateArgument(arg, source);
    if (named) return named;
  }
  return literalString(args.namedChildren[0], source);
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
      // `include "path/to/file.cfm";` — the included template path — or the
      // attribute form, `include template="path/to/file.cfm";` (#2651). A
      // path built at runtime (`include "#view#";`) is no import.
      const expr = node.namedChildren.find((c: SyntaxNode) => c.type === 'string');
      const attr = expr ? undefined : node.namedChildren.find((c: SyntaxNode) => c.type === 'assignment_expression');
      const moduleName = expr ? literalString(expr, source) : attr ? templateArgument(attr, source) : null;
      return moduleName ? { moduleName, signature: importText } : null;
    }

    if (node.type === 'call_expression') {
      // `cfinclude(template="path/to/file.cfm");` (#2651).
      const moduleName = isCfIncludeCall(node, source) ? cfIncludeCallTemplate(node, source) : null;
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
