import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * ArkTS (HarmonyOS / OpenHarmony, `.ets`) — a TypeScript superset whose headline
 * feature is declarative UI: an `@Component struct` with a `build()` method that
 * describes the view tree, plus `@State`/`@Prop`/@Link… reactive props and global
 * `@Builder`/`@Extend`/`@Styles` functions.
 *
 * Grammar: vendored Million-mo/tree-sitter-arkts (see grammars.ts). Two traits of
 * this grammar shape the whole extractor:
 *   1. It exposes NO tree-sitter fields (every declaration's name/params/body is a
 *      positional named child), so we cannot use `getChildByField` — name falls
 *      back to the first `identifier` child (handled by the core's extractName),
 *      and bodies/params/signatures are resolved positionally by the hooks below.
 *   2. It models ArkTS-specific constructs as their own node types:
 *      `component_declaration`/`component_body` (the `@Component struct`),
 *      `build_method`/`build_body`, `decorated_function_declaration` (`@Builder`),
 *      `builder_function_body`, `extend_function_body`, `enum_member`, etc.
 */

/** Node types that hold a declaration's executable/structural body. The grammar
 *  has no `body` field, so resolveBody locates the body by type. */
const BODY_TYPES = new Set([
  'class_body',
  'component_body',
  'object_type', // interface body
  'enum_body',
  'block_statement', // plain function/method body
  'builder_function_body', // @Builder function / component method body
  'extend_function_body', // @Extend / @Styles function body
  'build_body', // the build() UI tree
]);

/** First direct named child of one of the given types, or null. */
function firstChildOfType(node: SyntaxNode, types: Set<string>): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.has(child.type)) return child;
  }
  return null;
}

/** First direct child (named or not) whose type matches, or null. */
function firstTokenOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

export const arktsExtractor: LanguageExtractor = {
  functionTypes: [
    'function_declaration',
    // A top-level `function foo(): T { … }` is ambiguous in this grammar and
    // often parses as a (named) `function_expression` statement rather than a
    // `function_declaration`. Include it so those still extract; an ANONYMOUS
    // function_expression (a callback) resolves to `<anonymous>` and is skipped
    // by the core, so this only adds the named declarations we want.
    'function_expression',
    // Global `@Builder` / `@Extend` / `@Styles` / `@Concurrent` functions.
    'decorated_function_declaration',
    'decorated_export_declaration',
  ],
  // `@Component struct` parses as component_declaration; classifyClassNode routes
  // it to the `component` NodeKind while a plain class stays a `class`.
  classTypes: ['class_declaration', 'component_declaration'],
  classifyClassNode: (node) => (node.type === 'component_declaration' ? 'component' : 'class'),
  methodTypes: ['method_declaration', 'build_method', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: ['type_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['variable_declaration'],
  // State/props/fields inside a class or @Component struct.
  propertyTypes: ['property_declaration'],
  // Field names are unused (the grammar exposes none) but the interface requires
  // them; the positional hooks below do the real work.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter_list',

  // `build_method` has no name node — its name is implicitly `build`. A named
  // `function_expression` (a top-level function the grammar mis-parsed as an
  // expression) must be named here too, because the core's extractName
  // hard-codes `<anonymous>` for function_expression before its identifier
  // fallback — returning undefined for a truly anonymous one lets the core skip
  // it. Every other declaration is named by its first identifier child.
  resolveName: (node, source) => {
    if (node.type === 'build_method') return 'build';
    if (node.type === 'function_expression') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'identifier') return getNodeText(c, source);
      }
    }
    return undefined;
  },

  // No `body` field — find the body child by type. Covers classes/components
  // (class_body/component_body), interfaces (object_type), enums (enum_body),
  // and every function/method body variant.
  resolveBody: (node) => firstChildOfType(node, BODY_TYPES),

  getSignature: (node, source) => {
    // Find the parameter list by INDEX — tree-sitter node wrappers are not
    // reference-stable across `.namedChild()` calls, so we can't compare nodes
    // by identity; track the index instead.
    let paramsIdx = -1;
    let params: SyntaxNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'parameter_list') {
        params = child;
        paramsIdx = i;
        break;
      }
    }
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    // The return type is the `type_annotation` sibling sitting between the
    // parameter list and the body (e.g. `doWork(x): number { … }`).
    for (let i = paramsIdx + 1; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'type_annotation') {
        const t = getNodeText(child, source).trim();
        sig += t.startsWith(':') ? ' ' + t : ': ' + t;
        break;
      }
      if (BODY_TYPES.has(child.type)) break;
    }
    return sig;
  },

  getVisibility: (node) => {
    if (firstTokenOfType(node, 'private')) return 'private';
    if (firstTokenOfType(node, 'protected')) return 'protected';
    if (firstTokenOfType(node, 'public')) return 'public';
    return undefined;
  },

  isStatic: (node) => firstTokenOfType(node, 'static') !== null,
  isAsync: (node) => firstTokenOfType(node, 'async') !== null,

  // Exported decls are wrapped in an `export_declaration` ancestor (ArkTS) — the
  // generic walker descends through it, so created nodes see it as a parent.
  isExported: (node) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'export_declaration' || current.type === 'export_statement') {
        return true;
      }
      current = current.parent;
    }
    return false;
  },

  // Surface ArkTS decorators (`@Component`, `@Entry`, `@State`, `@Builder`, …) on
  // the node's `decorators` list so they're searchable and a later dispatch
  // synthesizer can key off them. The decorator name is the leading `@Word`.
  extractModifiers: (node) => {
    const mods: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type !== 'decorator') continue;
      const m = child.text.match(/@\s*([A-Za-z_]\w*)/);
      if (m && m[1]) mods.push(m[1]);
    }
    return mods.length ? mods : undefined;
  },

  // `import { Foo } from '../x'` / `import d from '@ohos.router'` / `import 'x'`.
  // The module is the single `string_literal` child (the grammar exposes no
  // `source` field).
  extractImport: (node, source) => {
    const str = firstChildOfType(node, new Set(['string_literal']));
    if (!str) return null;
    const moduleName = getNodeText(str, source).replace(/^['"]|['"]$/g, '');
    if (!moduleName) return null;
    return { moduleName, signature: getNodeText(node, source).trim() };
  },
};
