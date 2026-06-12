import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Blank C# conditional-compilation directive lines (`#if` / `#elif` / `#else` /
 * `#endif`) before parsing. The vendored tree-sitter-c-sharp grammar mis-parses
 * a `#if` that appears *inside an enum member list* — the canonical
 * multi-targeting shape:
 *
 *   enum ReadType {
 *   #if HAVE_DATE_TIME_OFFSET
 *       ReadAsDateTimeOffset,
 *   #endif
 *       ReadAsDouble,
 *   }
 *
 * It emits an ERROR that, for a nested enum, detaches the *enclosing class's*
 * member list, so most of the class's methods drop out of the index. Removing
 * the directive lines (keeping the guarded code) sidesteps it. Both branches of
 * an `#if/#else` are kept — the same behaviour the previous grammar produced,
 * and the right default for a code graph (index every symbol regardless of
 * build flags). Replacement preserves byte offsets (directive text → spaces,
 * newlines kept) so every symbol's line/column stays exact. (#237)
 */
export function blankCsharpPreprocessorDirectives(source: string): string {
  if (source.indexOf('#') === -1) return source;
  // Conditional-compilation directives only. `#region`/`#pragma`/`#nullable`
  // parse fine and are left alone. A directive must be the first non-space token
  // on its line (C# requirement), so anchor to line start.
  const re = /^([ \t]*)#[ \t]*(if|elif|else|endif)\b[^\n]*/gm;
  return source.replace(re, (m, indent) => indent + ' '.repeat(m.length - indent.length));
}

/**
 * A C# method's declared return type, normalized to the bare class name a chained
 * `Foo.Create().Bar()` could be called on (the #645/#608 mechanism). The return
 * type lives in the `returns` field (`static Foo Create()` → `Foo`); built-in
 * `predefined_type` (void/int/string/…) and arrays yield undefined, generics are
 * unwrapped to the base type, nullable `Foo?` is stripped, and a dotted namespace
 * is reduced to the simple name. Constructors have no `returns` field → undefined.
 */
function extractCsharpReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = node.childForFieldName('returns');
  if (!typeNode) return undefined;
  if (typeNode.type === 'predefined_type' || typeNode.type === 'array_type') return undefined;
  let t = getNodeText(typeNode, source).trim();
  t = t.replace(/\?+$/, ''); // nullable `Foo?`
  t = t.replace(/<[^>]*>/g, ''); // generics `List<Foo>` → `List`
  const last = t.split('.').pop()?.trim(); // namespace `Ns.Foo` → `Foo`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

export const csharpExtractor: LanguageExtractor = {
  preParse: blankCsharpPreprocessorDirectives,
  functionTypes: [],
  // Records are first-class type declarations in modern C# (DTOs, value objects,
  // MediatR/CQRS messages). Without these, references to a record never resolve
  // (#237). The shipped grammar parses EVERY record form as record_declaration —
  // `record struct` / `readonly record struct` included (it has no
  // record_struct_declaration node; that structTypes entry is forward-compat
  // only) — so classifyClassNode tells the value-type form apart by its
  // `struct` keyword child. (#831 follow-up)
  classTypes: ['class_declaration', 'record_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration', 'record_struct_declaration'],
  classifyClassNode: (node) => {
    if (node.type === 'record_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === 'struct') return 'struct';
      }
    }
    return 'class';
  },
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: [],
  // Namespaces qualify type names so same-named types in different namespaces are
  // distinguishable (e.g. `ApplicationCore.Entities.CatalogBrand` vs
  // `BlazorShared.Models.CatalogBrand`). Both block (`namespace Foo { … }`, which
  // nests its types) and file-scoped (`namespace Foo;`) forms — extractFilePackage
  // pushes the namespace onto the scope so nested/top-level types pick it up.
  packageTypes: ['namespace_declaration', 'file_scoped_namespace_declaration'],
  extractPackage: (node: SyntaxNode, source: string) => {
    const name =
      node.childForFieldName('name') ??
      node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name' || c.type === 'identifier');
    return name ? getNodeText(name, source) : null;
  },
  importTypes: ['using_directive'],
  callTypes: ['invocation_expression'],
  variableTypes: ['local_declaration_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getReturnType: extractCsharpReturnType,
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
        if (text === 'internal') return 'internal';
      }
    }
    return 'private'; // C# defaults to private
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier' && child.text === 'static') {
        return true;
      }
    }
    return false;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier' && child.text === 'async') {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C# using directives: using System, using System.Collections.Generic, using static X, using Alias = X
    const qualifiedName = node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
    if (qualifiedName) {
      return { moduleName: getNodeText(qualifiedName, source), signature: importText };
    }
    // Simple namespace like "using System;" - get the first identifier
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: getNodeText(identifier, source), signature: importText };
    }
    return null;
  },
};
