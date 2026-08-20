import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * The vendored VB.NET grammar has no true end-of-file token (its `_eof` rule is
 * a literal-`$` placeholder that never matches real input), so a file whose
 * last line lacks a trailing newline ends every parse with a MISSING-newline
 * error on the final statement. Appending a newline is offset-preserving for
 * all existing content.
 */
export function ensureTrailingNewline(source: string): string {
  return source.endsWith('\n') ? source : source + '\n';
}

/** Case-insensitive member-modifier scan (VB keywords are case-insensitive). */
function hasModifier(node: SyntaxNode, re: RegExp): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'member_modifier' && re.test(child.text)) return true;
  }
  return false;
}

/**
 * A VB.NET method's declared return type (`Function Foo(...) As Bar`),
 * normalized to the bare class name a chained `Foo.Create().Bar()` could be
 * called on (the #645/#608 mechanism). The type lives in the method's
 * `as_clause` child; predefined types (Integer/String/…) and arrays yield
 * undefined, generics `List(Of Foo)` unwrap to the base type, and a dotted
 * `Ns.Foo` reduces to the simple name. Subs have no as_clause → undefined.
 */
function extractVbnetReturnType(node: SyntaxNode, source: string): string | undefined {
  const asClause = node.namedChildren.find((c: SyntaxNode) => c.type === 'as_clause');
  if (!asClause) return undefined;
  const typeNode = asClause.childForFieldName('declared_type');
  if (!typeNode || typeNode.type === 'predefined_type' || typeNode.type === 'array_type') return undefined;
  let t = getNodeText(typeNode, source).trim();
  t = t.replace(/\?+$/, ''); // nullable `Foo?`
  t = t.replace(/\(\s*Of\b[^)]*\)/gi, ''); // generics `List(Of Foo)` → `List`
  const last = t.split('.').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

export const vbnetExtractor: LanguageExtractor = {
  preParse: ensureTrailingNewline,
  functionTypes: [],
  // VB Modules are static containers (Shared members, no instantiation) —
  // indexed as classes so their members get normal containment/qualification.
  classTypes: ['class_declaration', 'module_declaration'],
  methodTypes: [
    'method_declaration',
    'constructor_declaration',
    // `Declare Function GetWindowLong Lib "user32" ...` (P/Invoke)
    'external_method_declaration',
    // Interface members are distinct node types in this grammar (unlike C#).
    'interface_method_declaration',
    // `MustOverride Sub/Function ...` — body-less abstract members.
    'abstract_method_declaration',
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['structure_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: ['delegate_declaration'],
  packageTypes: ['namespace_declaration'],
  extractPackage: (node: SyntaxNode, source: string) => {
    const name = node.childForFieldName('name');
    return name ? getNodeText(name, source) : null;
  },
  importTypes: ['imports_statement'],
  // VB uses parentheses for BOTH calls and indexing, so the grammar can only
  // split them heuristically (empty parens → invocation, args → array access;
  // even Roslyn parses both as InvocationExpression and disambiguates during
  // binding). Both are treated as call sites — extractCall has a vbnet branch
  // — and name matching simply never resolves an index read on a collection.
  callTypes: ['invocation_expression', 'array_access_expression', 'generic_invocation_expression'],
  variableTypes: ['declaration_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration', 'interface_property_declaration', 'abstract_property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  // Method/property statements are direct children of the declaration node
  // (this grammar has no body wrapper), so the node is its own body — without
  // this, calls inside every Sub/Function would be skipped.
  resolveBody: (node: SyntaxNode) => node,
  getReturnType: extractVbnetReturnType,
  getVisibility: (node) => {
    if (hasModifier(node, /^private$/i)) return 'private';
    if (hasModifier(node, /^protected(\s+friend)?$/i)) return 'protected';
    if (hasModifier(node, /^friend$/i)) return 'internal';
    return 'public'; // VB members default to Public in practice
  },
  isStatic: (node) => hasModifier(node, /^shared$/i),
  isConst: (node) => hasModifier(node, /^const$/i) || (hasModifier(node, /^shared$/i) && hasModifier(node, /^readonly$/i)),
  isAsync: (node) => hasModifier(node, /^async$/i),
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // `Imports System.Collections.Generic` / `Imports Alias = Some.Namespace` /
    // `Imports Global.Company.Product`. The name reference is the last
    // qualified/simple/global name child (skips the alias identifier).
    const nameNode = [...node.namedChildren]
      .reverse()
      .find((c: SyntaxNode) =>
        c.type === 'qualified_name' || c.type === 'simple_name' || c.type === 'global_qualified_name' || c.type === 'identifier'
      );
    if (nameNode) {
      return { moduleName: getNodeText(nameNode, source), signature: importText };
    }
    return null;
  },
  visitNode: (node, ctx) => {
    // Events are indexed so `RaiseEvent X` / `Handles obj.X` flows have a
    // findable declaration (WinForms/WPF code is built around them).
    if (node.type === 'event_declaration' || node.type === 'custom_event_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        ctx.createNode('field', getNodeText(nameNode, ctx.source), node);
      }
      return true;
    }
    // `Sub New(...)` lexes as one token with no name field — without this,
    // constructors index as `<anonymous>`.
    if (node.type === 'constructor_declaration') {
      const ctor = ctx.createNode('method', 'New', node);
      if (ctor) {
        ctx.pushScope(ctor.id);
        ctx.visitFunctionBody(node, ctor.id);
        ctx.popScope();
      }
      return true;
    }
    return false;
  },
};
