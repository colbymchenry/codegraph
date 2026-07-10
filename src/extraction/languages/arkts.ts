import type { LanguageExtractor } from '../tree-sitter-types';
import { typescriptExtractor } from './typescript';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * ArkTS (HarmonyOS / OpenHarmony, `.ets`) — a TypeScript superset whose
 * headline feature is declarative UI: an `@Component struct` with a `build()`
 * method describing the view tree, `@State`/`@Prop`/`@Link` reactive
 * properties, and global `@Builder`/`@Extend`/`@Styles` functions.
 *
 * The vendored grammar (harmony-contrib/tree-sitter-arkts) extends
 * tree-sitter-javascript exactly the way tree-sitter-typescript does, so every
 * TS node type — and therefore the whole typescriptExtractor — applies
 * verbatim. ArkTS-specific shapes it adds:
 *
 *   - `struct_declaration` / `struct_body` — the `@Component struct`. Same
 *     `name:`/`body:` fields as class_declaration; members are ordinary
 *     `method_definition` / `public_field_definition` nodes, so struct members
 *     extract through the standard class-member paths.
 *   - `arkui_component_expression` — a build()-DSL component instantiation
 *     (`Column() { … }`). Carries a `function:` field (the component), an
 *     optional `children:` block, and — unlike TS — the CHAINED ATTRIBUTES as
 *     repeated `property:`/`arguments:` field pairs on the SAME node
 *     (`Text(x).fontSize(16).opacity(0.6)` is ONE node, not nested calls).
 *     Handled by the arkts branch in extractCall (tree-sitter.ts).
 *   - Decorators on functions (`@Builder function F() {}`) — invalid in TS,
 *     first-class here (a `decorator:` field on function_declaration), so the
 *     core's existing extractDecoratorsFor path captures them.
 */

/** Reactive/state decorators that make a member worth flagging (searchable). */
const DECORATED_MEMBER_TYPES = new Set([
  'struct_declaration',
  'public_field_definition',
  'method_definition',
  'function_declaration',
]);

/**
 * Collect decorator names for a declaration from BOTH positions the grammar
 * produces: direct `decorator` children (`@Entry @Component struct X`,
 * `@State count` on a field) and preceding `decorator` siblings (`@Builder`
 * before a method_definition inside struct_body; `@Component` on the
 * export_statement wrapping `export struct X`). The backwards sibling walk
 * stops at the first non-decorator so an earlier declaration's decorators
 * never leak in (mirrors extractDecoratorsFor's sibling pass).
 */
function collectDecoratorNames(node: SyntaxNode): string[] | undefined {
  const names: string[] = [];
  const nameOf = (dec: SyntaxNode): string | undefined => {
    for (let i = 0; i < dec.namedChildCount; i++) {
      const child = dec.namedChild(i);
      if (!child) continue;
      if (child.type === 'identifier') return child.text;
      if (child.type === 'call_expression') {
        // `@StorageLink('theme')` / `@Extend(Text)` — the decorator name is
        // the callee.
        const fn = child.childForFieldName('function');
        if (fn?.type === 'identifier') return fn.text;
      }
    }
    return undefined;
  };

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'decorator') {
      const n = nameOf(child);
      if (n) names.push(n);
    }
  }

  const parent = node.parent;
  if (parent) {
    // Find this node among the parent's named children by start offset
    // (wrapper identity is not stable across navigation), then walk backwards.
    const start = node.startIndex;
    let idx = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const sib = parent.namedChild(i);
      if (sib && sib.startIndex === start) {
        idx = i;
        break;
      }
    }
    for (let i = idx - 1; i >= 0; i--) {
      const sib = parent.namedChild(i);
      if (!sib || sib.type !== 'decorator') break;
      const n = nameOf(sib);
      if (n) names.unshift(n);
    }
  }

  return names.length > 0 ? names : undefined;
}

export const arktsExtractor: LanguageExtractor = {
  ...typescriptExtractor,

  // `@Component struct X { … }` — extractStruct handles it (kind `struct`,
  // members extracted like class members, `this.m()` resolution and the
  // class/struct containment gates in the name-matcher all apply as-is). The
  // component-ness is preserved on the node's decorators (`Component`,
  // `Entry`, `CustomDialog`, `Reusable`), captured by extractModifiers below.
  structTypes: ['struct_declaration'],

  // build()-DSL component instantiations are call sites: `TodoRow({...})`
  // inside a parent's build() is the parent→child component edge, resolved by
  // the ordinary call pipeline against the child's struct node. The arkts
  // branch in extractCall also lifts each chained `.attr(...)` (emitted
  // dot-prefixed so it can ONLY resolve to `@Extend`/`@Styles`/`@Builder`
  // attribute helpers — see matchReference) and `.onXxx(this.handler)`
  // method-reference bindings. `leading_dot_expression` is the detached-chain
  // shape the grammar produces when a nested component's chain starts on the
  // line after its closing `}` inside arkui_children.
  callTypes: ['call_expression', 'arkui_component_expression', 'leading_dot_expression'],

  // Surface ArkTS decorators on the node's `decorators` list (searchable, and
  // the hook a future ArkUI state→build synthesizer keys off). Core paths
  // already emit `decorates` REFERENCES for classes/methods/properties/
  // functions; this hook is what puts the names on struct nodes too —
  // extractStruct has no extractDecoratorsFor call, and node.decorators is
  // only populated via extractModifiers (see createNode).
  extractModifiers: (node) => {
    if (!DECORATED_MEMBER_TYPES.has(node.type)) return undefined;
    return collectDecoratorNames(node);
  },
};
