/**
 * Function-as-value capture (#756) — registration-linking for callbacks.
 *
 * A function name used as a VALUE — passed as a call argument
 * (`register_handler(target_cb)`, `signal(SIGINT, handler)`), assigned to a
 * field or function pointer (`o->cb = target_cb`, `OnFire := TargetCb`),
 * placed in a struct/object initializer (`{ .recv_cb = my_cb }`,
 * `{ recv: targetCb }`, `Ops{Cb: targetCb}`), or listed in a function table
 * (`static cb_t table[] = { cb_a, cb_b }`) — is a real dependency that static
 * call extraction misses entirely: `callers(target_cb)` showed nothing but
 * direct calls, so every callback looked dead and its registration sites were
 * invisible to impact analysis.
 *
 * This module captures those value positions during the AST walk as
 * `function_ref` candidates. Capture is table-driven per language (the value
 * positions and wrapper forms differ per grammar — `&fn` in C, `Main::fn` in
 * Java, `::fn` in Kotlin, `#selector(fn)` in Swift, `@TargetCb` in Pascal,
 * `method(:fn)` in Ruby). Candidates are GATED at end-of-file extraction
 * (see `TreeSitterExtractor.flushFnRefCandidates`): only names matching a
 * same-file function/method or an imported binding survive, which bounds
 * volume and keeps precision high. Resolution then matches survivors against
 * function/method nodes ONLY (`matchFunctionRef` in
 * `src/resolution/name-matcher.ts`) and persists them as `references` edges,
 * which `callers`/`impact` already traverse.
 *
 * Deliberately NOT covered (resolving the *dispatch* — `o->cb(x)` → the
 * registered function — needs data-flow through struct fields; a wrong edge
 * is worse than none): indirect-call resolution, PHP string callables,
 * Ruby bare symbols outside `method(:sym)`, and `obj.method` member values
 * where `obj` isn't `this`/`self`.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from './tree-sitter-helpers';

export interface FnRefCandidate {
  name: string;
  line: number;
  column: number;
  /** Which capture position produced this candidate (gate policy keys on it). */
  mode: CaptureMode;
  /**
   * True when the value was an explicit reference form (`&fn`, `&Cls::m`,
   * `::fn`, `#selector`, `method(:sym)`) rather than a bare identifier —
   * C++'s flush policy keys on it.
   */
  explicitRef: boolean;
}

/** How to pull candidate value nodes out of a dispatched container node. */
type CaptureMode =
  | 'args' // every named child is a potential value (call argument lists)
  | 'rhs' // the assignment right-hand side (named field, else last named child)
  | 'value' // the `value` field of a keyed pair (object/struct/table initializers)
  | 'list' // every named child (array / initializer-list / table positional elements)
  | 'varinit'; // a variable declarator's initializer value

interface CaptureRule {
  mode: CaptureMode;
  /** Field holding the value for rhs/value/varinit (defaults per mode). */
  field?: string;
}

export interface FnRefSpec {
  /** Bare identifier node types that can act as a function value. */
  idTypes: Set<string>;
  /** Container node type → how to extract candidate values from it. */
  dispatch: Map<string, CaptureRule>;
  /**
   * Transparent wrapper layers between a container and its values
   * (`argument`, `value_argument`, `literal_element`, `expression_list`…).
   * Value: the field to descend into, or null for "named children".
   * `expression_list` fans out to ALL named children (Go multi-assign).
   */
  layers?: Map<string, string | null>;
  /**
   * Unary wrappers whose operand is the function value — C/C++ `&fn`
   * (pointer_expression), Pascal `@Fn` (exprUnary), Scala eta `fn _`
   * (postfix_expression). Value: operand field, or null for first named child.
   */
  unwrap?: Map<string, string | null>;
  /**
   * Whole-node reference forms needing bespoke name extraction —
   * `method_reference` (Java), `callable_reference` / `navigation_expression`
   * (Kotlin), `selector_expression` (Swift `#selector` / ObjC `@selector`),
   * Ruby `method(:sym)` calls, and `this.method` member forms.
   */
  special?: Set<string>;
  /**
   * Capture modes whose candidates skip the same-file/import gate and rely on
   * resolution's unique-or-drop rule instead. C-family only: an initializer
   * value, function-pointer assignment RHS, or table element is a
   * function-pointer position by construction, and C has no symbol imports —
   * the dominant repo-scale pattern (`server.c`'s command table naming
   * handlers defined across files) would otherwise be invisible. Call
   * arguments stay gated everywhere (locals passed as args dwarf callbacks).
   */
  ungatedModes?: Set<CaptureMode>;
  /**
   * C++ only: in args/rhs/varinit positions, accept ONLY explicit reference
   * forms (`&fn`, `&Cls::method`) — never bare identifiers. C++ codebases are
   * dense with generic free-function/accessor names (`begin`, `end`, `out`,
   * `size`, `data`) that collide with parameters and locals, and out-of-line
   * member definitions extract as function-kind nodes — bare-id matching on
   * fmt was mostly wrong edges. File-scope initializer tables (value/list)
   * still accept bare identifiers, same as C.
   */
  addressOfOnly?: boolean;
}

/** Names that are never function references even when grammars call them identifiers. */
const NAME_STOPLIST = new Set([
  'this',
  'self',
  'super',
  'null',
  'nil',
  'true',
  'false',
  'undefined',
  'new',
  'NULL',
  'nullptr',
  'None',
]);

// ---------------------------------------------------------------------------
// Per-language specs. Node types verified against each grammar (probe fixtures
// in the #756 investigation; see docs/design/function-ref-capture.md).
// ---------------------------------------------------------------------------

/** C / C++ / Objective-C share the C-family initializer & assignment shapes. */
function cFamilySpec(extra?: { special?: string[]; addressOfOnly?: boolean }): FnRefSpec {
  return {
    idTypes: new Set(['identifier']),
    dispatch: new Map<string, CaptureRule>([
      ['argument_list', { mode: 'args' }],
      ['assignment_expression', { mode: 'rhs', field: 'right' }],
      ['init_declarator', { mode: 'varinit', field: 'value' }],
      ['initializer_list', { mode: 'list' }],
      ['initializer_pair', { mode: 'value', field: 'value' }],
    ]),
    unwrap: new Map([['pointer_expression', 'argument']]),
    special: new Set(extra?.special ?? []),
    // C has no symbol imports, and callbacks are registered cross-file at repo
    // scale (redis: server.c's command table names handlers from t_*.c) — so
    // initializer positions bypass the gate and lean on resolution's
    // unique-or-drop rule. ONLY 'value'/'list' (struct/array initializers),
    // and the flush additionally requires FILE scope: a C file-scope
    // initializer is a constant-expression context, so a bare identifier
    // there can only be a function address (or enum/macro, which the
    // function-kind filter drops) — never a variable. 'rhs'/'varinit' were
    // tried and produced false edges (`prev = next`, `*str = field` — data
    // assignments matching a unique same-named function elsewhere), so
    // assignments stay gated to same-file/import.
    ungatedModes: new Set<CaptureMode>(['value', 'list']),
    addressOfOnly: extra?.addressOfOnly,
  };
}

// NOTE: deliberately NO `member_expression` (`this.handleClick`) capture for
// TS/JS. Class fields with type annotations are extracted as method-kind
// nodes (pre-existing extractor behavior), so `this.X` value positions —
// which in real code are mostly DATA reads (`setCursor(this.canvas)`) —
// resolved to those field nodes and produced wrong "registration" edges
// (excalidraw A/B finding). Revisit if/when TS field classification is fixed.
const TS_JS_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['variable_declarator', { mode: 'varinit', field: 'value' }],
    ['pair', { mode: 'value', field: 'value' }],
    ['array', { mode: 'list' }],
  ]),
};

const PYTHON_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment', { mode: 'rhs', field: 'right' }],
    ['keyword_argument', { mode: 'value', field: 'value' }], // Thread(target=worker)
    ['pair', { mode: 'value', field: 'value' }],
    ['list', { mode: 'list' }],
  ]),
  special: new Set(['attribute']),
};

const GO_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment_statement', { mode: 'rhs', field: 'right' }],
    ['short_var_declaration', { mode: 'rhs', field: 'right' }],
    ['var_spec', { mode: 'varinit', field: 'value' }],
    ['keyed_element', { mode: 'value' }], // value = last literal_element child
    ['literal_value', { mode: 'list' }], // positional composite literals
  ]),
  layers: new Map<string, string | null>([
    ['literal_element', null],
    ['expression_list', null],
  ]),
};

const RUST_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['field_initializer', { mode: 'value', field: 'value' }],
    ['array_expression', { mode: 'list' }],
    ['static_item', { mode: 'varinit', field: 'value' }],
    ['let_declaration', { mode: 'varinit', field: 'value' }],
  ]),
};

const JAVA_SPEC: FnRefSpec = {
  // No bare-identifier function values in Java — only method references.
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['variable_declarator', { mode: 'varinit', field: 'value' }],
  ]),
  special: new Set(['method_reference']),
};

const KOTLIN_SPEC: FnRefSpec = {
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['value_arguments', { mode: 'args' }],
    ['assignment', { mode: 'rhs' }], // RHS = last named child (no field in grammar)
  ]),
  layers: new Map<string, string | null>([['value_argument', null]]),
  special: new Set(['callable_reference', 'navigation_expression']),
};

const CSHARP_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }], // covers `+=` event subscription
    ['initializer_expression', { mode: 'list' }],
    ['variable_declarator', { mode: 'varinit' }],
  ]),
  layers: new Map<string, string | null>([['argument', null]]),
  special: new Set(['member_access_expression']),
};

const RUBY_SPEC: FnRefSpec = {
  // Bare identifiers in Ruby args are method CALLS or locals, never function
  // values — only the `method(:name)` idiom (and `&method(:name)`) qualifies.
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['pair', { mode: 'value', field: 'value' }],
  ]),
  layers: new Map<string, string | null>([['block_argument', null]]),
  special: new Set(['call']),
};

const SWIFT_SPEC: FnRefSpec = {
  idTypes: new Set(['simple_identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['value_arguments', { mode: 'args' }],
    ['assignment', { mode: 'rhs', field: 'result' }],
    ['array_literal', { mode: 'list' }],
    ['property_declaration', { mode: 'varinit', field: 'value' }],
  ]),
  layers: new Map<string, string | null>([['value_argument', 'value']]),
  special: new Set(['selector_expression']),
};

const SCALA_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['val_definition', { mode: 'varinit', field: 'value' }],
  ]),
  unwrap: new Map<string, string | null>([['postfix_expression', null]]), // eta-expansion `fn _`
};

const DART_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['pair', { mode: 'value', field: 'value' }],
    ['list_literal', { mode: 'list' }],
    ['static_final_declaration', { mode: 'varinit' }],
  ]),
  layers: new Map<string, string | null>([['argument', null]]),
};

const LUA_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_statement', { mode: 'rhs' }], // RHS expression_list children carry `value` fields
    ['field', { mode: 'value', field: 'value' }], // table fields, keyed AND positional
  ]),
  layers: new Map<string, string | null>([['expression_list', null]]),
};

const PASCAL_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['exprArgs', { mode: 'args' }],
    ['assignment', { mode: 'rhs', field: 'rhs' }], // OnClick := Handler
  ]),
  unwrap: new Map<string, string | null>([['exprUnary', 'operand']]), // @Handler
};

/**
 * Capture specs by language. PHP is deliberately absent: its first-class
 * callable `fn(...)` already extracts as a `calls` edge, and string callables
 * (`'fn_name'`) are a precision risk left for a follow-up.
 */
export const FN_REF_SPECS: Record<string, FnRefSpec | undefined> = {
  c: cFamilySpec(),
  cpp: cFamilySpec({ addressOfOnly: true }),
  objc: cFamilySpec({ special: ['selector_expression'] }),
  typescript: TS_JS_SPEC,
  tsx: TS_JS_SPEC,
  javascript: TS_JS_SPEC,
  jsx: TS_JS_SPEC,
  python: PYTHON_SPEC,
  go: GO_SPEC,
  rust: RUST_SPEC,
  java: JAVA_SPEC,
  kotlin: KOTLIN_SPEC,
  csharp: CSHARP_SPEC,
  ruby: RUBY_SPEC,
  swift: SWIFT_SPEC,
  scala: SCALA_SPEC,
  dart: DART_SPEC,
  lua: LUA_SPEC,
  luau: LUA_SPEC,
  pascal: PASCAL_SPEC,
};

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Extract candidate names from a dispatched container node. Returns the
 * (name, position) pairs of every function-value-shaped expression found.
 */
export function captureFnRefCandidates(
  container: SyntaxNode,
  rule: CaptureRule,
  spec: FnRefSpec,
  source: string
): FnRefCandidate[] {
  const valueNodes: SyntaxNode[] = [];

  switch (rule.mode) {
    case 'args':
    case 'list': {
      for (let i = 0; i < container.namedChildCount; i++) {
        const child = container.namedChild(i);
        if (child) valueNodes.push(child);
      }
      break;
    }
    case 'rhs': {
      const rhs = rule.field
        ? getChildByField(container, rule.field)
        : container.namedChild(container.namedChildCount - 1);
      if (rhs) {
        // Param-storage skip: `this.status = status` / `o->cb = cb` — when
        // the assigned member's name EQUALS the RHS identifier, the RHS is a
        // local/parameter being stored, and the function it holds (if any)
        // is unknowable statically. A same-named function elsewhere would
        // resolve to the WRONG target (excalidraw A/B finding), so skip.
        const lhs =
          getChildByField(container, 'left') ??
          getChildByField(container, 'lhs') ??
          getChildByField(container, 'target') ??
          (container.namedChildCount >= 2 ? container.namedChild(0) : null);
        const lhsText = lhs ? getNodeText(lhs, source) : '';
        const lhsLastName = lhsText.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/)?.[1];
        const rhsText = getNodeText(rhs, source).trim();
        if (lhsLastName && lhsLastName === rhsText) break;
        valueNodes.push(rhs);
      }
      break;
    }
    case 'value': {
      let value = rule.field ? getChildByField(container, rule.field) : null;
      // Keyed containers without a value field (Go keyed_element): the value
      // is the LAST named child (the first is the key).
      if (!value && container.namedChildCount > 0) {
        value = container.namedChild(container.namedChildCount - 1);
      }
      if (value) valueNodes.push(value);
      break;
    }
    case 'varinit': {
      // Destructuring (`const { center } = ellipse`) extracts DATA from the
      // RHS — never a function alias. Without this skip, a parameter that
      // shadows a same-named imported function produced a wrong edge.
      const nameNode =
        getChildByField(container, 'name') ?? getChildByField(container, 'pattern');
      if (nameNode && (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern' ||
                       nameNode.type === 'tuple_pattern' || nameNode.type === 'struct_pattern')) {
        break;
      }
      if (rule.field) {
        const value = getChildByField(container, rule.field);
        if (value) valueNodes.push(value);
      } else {
        // No value field in this grammar (C# variable_declarator, Dart
        // static_final_declaration): the initializer is the last named child —
        // but a declarator WITHOUT an initializer has its NAME there instead.
        // Require ≥2 named children and never pick the name/pattern child.
        const value = container.namedChild(container.namedChildCount - 1);
        const nameChild =
          getChildByField(container, 'name') ?? getChildByField(container, 'pattern');
        if (
          value &&
          container.namedChildCount >= 2 &&
          (!nameChild || value.id !== nameChild.id)
        ) {
          valueNodes.push(value);
        }
      }
      break;
    }
  }

  const out: FnRefCandidate[] = [];
  for (const v of valueNodes) {
    // A bare identifier is one that normalizes without passing through an
    // unwrap/special reference form. C++'s addressOfOnly policy (applied at
    // flush, where file scope is known) drops bare ids outside file-scope
    // initializer tables.
    const explicitRef = !spec.idTypes.has(v.type);
    for (const { name, node } of normalizeValue(v, spec, source, 0)) {
      if (!name || NAME_STOPLIST.has(name)) continue;
      out.push({
        name,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        mode: rule.mode,
        explicitRef,
      });
    }
  }
  return out;
}

/**
 * Normalize one value expression to zero or more function names. Recursion is
 * bounded (wrapper layers only); anything that isn't a recognized
 * function-value shape yields [].
 */
function normalizeValue(
  node: SyntaxNode,
  spec: FnRefSpec,
  source: string,
  depth: number
): Array<{ name: string; node: SyntaxNode }> {
  if (depth > 4) return [];
  const type = node.type;

  // Bare identifier
  if (spec.idTypes.has(type)) {
    return [{ name: getNodeText(node, source), node }];
  }

  // Transparent layers (argument, value_argument, literal_element,
  // expression_list, block_argument). expression_list fans out (Go `a, b = f, g`).
  const layerField = spec.layers?.get(type);
  if (spec.layers?.has(type)) {
    // Labeled-argument param-forward skip (Swift/Kotlin): `value: value` /
    // `delay: delay` — when the label EQUALS the value identifier, the value
    // is a forwarded local/parameter, not a function reference (Alamofire
    // A/B finding; same rationale as the `this.x = x` assignment skip).
    if (type === 'value_argument') {
      const label = getChildByField(node, 'name');
      const value = getChildByField(node, 'value') ?? node.namedChild(node.namedChildCount - 1);
      if (
        label &&
        value &&
        getNodeText(label, source).trim() === getNodeText(value, source).trim()
      ) {
        return [];
      }
    }
    if (layerField) {
      const inner = getChildByField(node, layerField);
      return inner ? normalizeValue(inner, spec, source, depth + 1) : [];
    }
    const results: Array<{ name: string; node: SyntaxNode }> = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) results.push(...normalizeValue(child, spec, source, depth + 1));
    }
    return results;
  }

  // Unary wrappers: &fn / @Fn / `fn _`
  const unwrapField = spec.unwrap?.get(type);
  if (spec.unwrap?.has(type)) {
    // C-family `pointer_expression` covers BOTH `&x` (address-of — a function
    // value) and `*x` (dereference — a data read, never a function value).
    // Only `&` qualifies; without this, fmt's `*begin` reads resolved to its
    // free `begin()` functions.
    if (type === 'pointer_expression' && node.child(0)?.type !== '&') return [];
    const inner = unwrapField ? getChildByField(node, unwrapField) : node.namedChild(0);
    if (!inner) return [];
    // C++ `&Widget::on_click` — keep the QUALIFIED name. Resolution scopes the
    // method to that class (more precise than a bare-name match, and exempt
    // from the cpp bare-ids-are-free-functions rule since `&Cls::m` is an
    // explicit member-pointer).
    if (inner.type === 'qualified_identifier') {
      const text = getNodeText(inner, source).trim();
      return /^[A-Za-z_][\w:]*$/.test(text) ? [{ name: text, node: inner }] : [];
    }
    return normalizeValue(inner, spec, source, depth + 1);
  }

  // Special whole-node reference forms
  if (spec.special?.has(type)) {
    return normalizeSpecial(node, type, source);
  }

  return [];
}

/** Rightmost descendant-or-self named child of one of the given types. */
function lastNamedOfType(node: SyntaxNode, types: Set<string>): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (types.has(child.type)) found = child;
    const deeper = lastNamedOfType(child, types);
    if (deeper) found = deeper;
  }
  return found;
}

function normalizeSpecial(
  node: SyntaxNode,
  type: string,
  source: string
): Array<{ name: string; node: SyntaxNode }> {
  switch (type) {
    // Java `Main::targetCb` / `this::run0` — last identifier child is the method.
    case 'method_reference': {
      let last: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'identifier') last = child;
      }
      return last ? [{ name: getNodeText(last, source), node: last }] : [];
    }

    // Kotlin `::targetCb` — the simple_identifier child.
    case 'callable_reference': {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'simple_identifier') {
          return [{ name: getNodeText(child, source), node: child }];
        }
      }
      return [];
    }

    // Kotlin `this::fire` parses as navigation_expression with a `::fire`
    // navigation_suffix. Ordinary `a.b` navigation MUST yield nothing.
    case 'navigation_expression': {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'navigation_suffix' && getNodeText(child, source).startsWith('::')) {
          const id = child.namedChild(child.namedChildCount - 1);
          if (id) return [{ name: getNodeText(id, source), node: id }];
        }
      }
      return [];
    }

    // Swift `#selector(Holder.fire)` → fire. ObjC `@selector(storeImage:)` →
    // `storeImage:` verbatim (ObjC method nodes keep their selector colons).
    case 'selector_expression': {
      const inner = node.namedChild(0);
      if (!inner) return [];
      if (inner.type === 'identifier' || inner.type === 'simple_identifier') {
        return [{ name: getNodeText(inner, source), node: inner }];
      }
      // Swift dotted form: rightmost simple_identifier. ObjC keyword selector:
      // text as-is.
      const last = lastNamedOfType(node, new Set(['simple_identifier']));
      if (last) return [{ name: getNodeText(last, source), node: last }];
      return [{ name: getNodeText(inner, source).trim(), node: inner }];
    }

    // Ruby `method(:target_cb)` — a `call` whose method is literally `method`
    // with a single symbol argument.
    case 'call': {
      const method = getChildByField(node, 'method');
      if (!method || getNodeText(method, source) !== 'method') return [];
      const args = getChildByField(node, 'arguments');
      if (!args || args.namedChildCount !== 1) return [];
      const sym = args.namedChild(0);
      if (!sym || sym.type !== 'simple_symbol') return [];
      const name = getNodeText(sym, source).replace(/^:/, '');
      return name ? [{ name, node: sym }] : [];
    }

    // `self.handle_click` (Python) — object must be EXACTLY `self`.
    case 'attribute': {
      const obj = getChildByField(node, 'object');
      const attr = getChildByField(node, 'attribute');
      if (obj && attr && obj.type === 'identifier' && getNodeText(obj, source) === 'self') {
        return [{ name: getNodeText(attr, source), node: attr }];
      }
      return [];
    }

    // `this.Run0` (C#) — receiver must be EXACTLY `this`. Two grammar shapes:
    // newer tree-sitter-c-sharp exposes an `expression` field holding a
    // `this_expression`; the vendored grammar keeps `this` as an anonymous
    // token (only the `name` field is a named child), so fall back to the
    // node text.
    case 'member_access_expression': {
      const name = getChildByField(node, 'name');
      if (!name) return [];
      const expr = getChildByField(node, 'expression');
      const isThisReceiver = expr
        ? expr.type === 'this_expression' || expr.type === 'this'
        : getNodeText(node, source).startsWith('this.');
      return isThisReceiver ? [{ name: getNodeText(name, source), node: name }] : [];
    }

    default:
      return [];
  }
}
