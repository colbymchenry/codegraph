import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { hasFlowPragma } from '../grammars';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * A TS/JS class field (`public_field_definition` / `field_definition`) is a
 * METHOD only when its value is callable — an arrow function, a function
 * expression, or a HOF call wrapping one (`onScroll = throttle(() => {…})`),
 * exactly mirroring what `resolveBody` below knows how to walk. Everything
 * else (`public fonts: Fonts;`, `count = 0`, `static defaults = {…}`) is a
 * PROPERTY. Previously every field extracted as method-kind (#808), which
 * misrepresented class shape and defeated kind-based filtering — the reason
 * #756's function-ref resolution had to restrict TS/JS bare identifiers to
 * function targets.
 */
export function classifyTsClassMember(node: SyntaxNode): 'method' | 'property' {
  if (node.type !== 'public_field_definition' && node.type !== 'field_definition') {
    return 'method'; // method_definition, getters/setters — untouched
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'arrow_function' || child.type === 'function_expression') {
      return 'method';
    }
    if (child.type === 'call_expression') {
      const args = getChildByField(child, 'arguments');
      if (args) {
        for (let j = 0; j < args.namedChildCount; j++) {
          const arg = args.namedChild(j);
          if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
            return 'method';
          }
        }
      }
    }
  }
  return 'property';
}

/**
 * Flow's own syntax, blanked to spaces (offsets survive) so a Flow file reads
 * as TSX: exact object types `{| a: T |}`, a maybe type's `?` (`x: ?string`,
 * `Array<?T>`), an inexact object's `...`, `import typeof`, `opaque type`. Only files with the `@flow`
 * pragma — the ones `detectLanguage` sends here from `.js`.
 */
export function blankFlowSyntax(source: string, filePath?: string): string {
  if (!filePath || !/\.(?:jsx?|mjs|cjs)$/.test(filePath) || !hasFlowPragma(source)) return source;
  return source
    .replace(/\{\|/g, '{ ')
    .replace(/\|\}/g, ' }')
    .replace(/([:<,]\s*)\?(?=[\w$({[])/g, '$1 ')
    .replace(/\bimport\s+typeof\b/g, (m) => 'import' + ' '.repeat(m.length - 'import'.length))
    .replace(/\bopaque(?=\s+type\b)/g, '      ')
    // An inexact object type's bare `...` (`{a: T, ...}`) — never a value spread.
    .replace(/\.\.\.(?=\s*[},])/g, '   ');
}

/**
 * `export type * from './types'` and `export type * as ns from './types'`
 * (TypeScript 5.0) are not in the grammar: `type` is an error there, and a
 * barrel made only of such lines parses to nothing. With `type` blanked to
 * spaces (offsets survive) each reads as the `export *` it is to the graph.
 */
export function blankExportTypeStar(source: string): string {
  return source.replace(/^([ \t]*export[ \t]+)type(?=[ \t]*\*)/gm, '$1    ');
}

/**
 * Whether `node` is declared in a `declare module 'x' { … }` or `declare
 * global { … }` body, which exports it without an `export` keyword.
 *
 * This is TypeScript's own rule: the binder makes an ambient module body an
 * export context unless the body holds an export declaration (`export {…}`,
 * `export * from`, `export =`, `export default x`), and a namespace nested in
 * one is ambient too. What such a body declares belongs to that module or to
 * the global scope, not to this file (`interface Window`, chart.js's
 * `PluginOptionsByType`): other files reach it through them, and so does the
 * library whose type it extends. `declare namespace X` is not one: in a module
 * file, X belongs to that file. Mirrored in the kernel (tsjs/mod.rs
 * `is_ambient_export`).
 */
export function isAmbientExport(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'statement_block' && hasExportDeclaration(current)) return false;
    if (current.type !== 'ambient_declaration') continue;
    // `declare global` is the keyword and a bare block, with no field names.
    for (let i = 0; i < current.childCount; i++) {
      if (current.child(i)?.type === 'global') return true;
    }
    const declared = current.namedChild(0);
    if (declared?.type === 'module' && getChildByField(declared, 'name')?.type === 'string') return true;
  }
  return false;
}

/** A statement in `block` that exports by name or by assignment, not by declaring. */
function hasExportDeclaration(block: SyntaxNode): boolean {
  for (let i = 0; i < block.namedChildCount; i++) {
    const statement = block.namedChild(i);
    if (statement?.type === 'export_statement' && !getChildByField(statement, 'declaration')) return true;
  }
  return false;
}

export const typescriptExtractor: LanguageExtractor = {
  preParse: (source, filePath) => blankExportTypeStar(blankFlowSyntax(source, filePath)),
  functionTypes: ['function_declaration', 'generator_function_declaration', 'arrow_function', 'function_expression', 'generator_function'],
  classTypes: ['class_declaration', 'abstract_class_declaration'],
  // `method_signature` is the interface/type-literal form of a method; without it
  // an interface's members never enter the graph, so a `.d.ts` platform API has
  // no declaration node for call sites to attach to (#1638). Java/C# don't need
  // an equivalent — their grammars reuse `method_declaration`.
  methodTypes: ['method_definition', 'public_field_definition', 'method_signature'],
  classifyMethodNode: classifyTsClassMember,
  // The interface counterpart of `public_field_definition`. It carries no value,
  // so it is always a property and never needs classifyMethodNode.
  propertyTypes: ['property_signature'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['property_identifier', 'enum_assignment'],
  typeAliasTypes: ['type_alias_declaration'],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // public_field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   public_field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = withBatchedUpdates((e) => { ... })
    //   public_field_definition → call_expression → arguments → arrow_function → body
    if (node.type === 'public_field_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        // Check inside call_expression arguments (HOF wrappers like throttle, debounce)
        if (child.type === 'call_expression') {
          const args = getChildByField(child, 'arguments');
          if (args) {
            for (let j = 0; j < args.namedChildCount; j++) {
              const arg = args.namedChild(j);
              if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
                return getChildByField(arg, bodyField);
              }
            }
          }
        }
      }
    }
    return null;
  },
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
    }
    return sig;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return undefined;
  },
  isExported: (node, _source) => {
    // Walk the parent chain to find an export_statement ancestor.
    // This correctly handles deeply nested nodes like arrow functions
    // inside variable declarations: `export const X = () => { ... }`
    // where the arrow_function is 3 levels deep under export_statement.
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      current = current.parent;
    }
    return isAmbientExport(node);
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static') return true;
    }
    return false;
  },
  isConst: (node) => {
    // For lexical_declaration, check if it's 'const' or 'let'
    // For variable_declaration, it's always 'var'
    if (node.type === 'lexical_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'const') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replace(/['"]/g, '');
      if (moduleName) {
        return { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() };
      }
    }
    return null;
  },
};
