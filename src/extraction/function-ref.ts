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
 * is worse than none): indirect-call resolution and `obj.method` member
 * values where `obj` isn't `this`/`self` (the receiver's type is statically
 * unknowable without local data-flow).
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
  /**
   * Skip the same-file/import name gate for this candidate. Set for PHP
   * string callables in known HOF positions: PHP global functions are
   * referenced cross-file WITHOUT imports (global namespace), so the gate
   * can't see them — the strong positional prior (a string argument to
   * `usort`/`array_map`/…) plus resolution's unique-or-drop rule carry the
   * precision instead.
   */
  skipGate?: boolean;
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

// `this.handleClick` capture (member_expression) emits a `this.`-PREFIXED
// candidate name: resolution scopes it to the enclosing symbol's class
// (qualified-name prefix), so `this.fonts` (a property, post-#808) and
// inherited/unknown members yield no edge, while same-class methods —
// `btn.on('click', this.handleClick)`, the observer-registration idiom —
// resolve precisely. Bare identifiers stay function-kind-only (a bare id can
// never be a method value in JS).
const TS_JS_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['variable_declarator', { mode: 'varinit', field: 'value' }],
    ['pair', { mode: 'value', field: 'value' }],
    ['array', { mode: 'list' }],
  ]),
  special: new Set(['member_expression']),
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
  // values — only the `method(:name)` idiom (and `&method(:name)`) plus
  // hook-DSL symbols (`before_action :authenticate`) qualify.
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['pair', { mode: 'value', field: 'value' }],
  ]),
  layers: new Map<string, string | null>([['block_argument', null]]),
  special: new Set(['call', 'simple_symbol']),
};

/**
 * Rails/ActiveSupport-style hook DSLs whose symbol arguments name a method of
 * the enclosing class: lifecycle callbacks (`before_action`, `after_save`,
 * `around_create`, `skip_before_action`…), `validate :method`, `set_callback`,
 * `helper_method`, and `rescue_from(..., with: :handler)`. NOT `validates`
 * (plural) — its symbols name ATTRIBUTES, not methods.
 */
const RUBY_HOOK_RE = /^(skip_)?(before|after|around)_[a-z_]+$/;
const RUBY_HOOK_NAMES = new Set(['validate', 'set_callback', 'helper_method', 'rescue_from']);
function isRubyHookCall(name: string): boolean {
  return RUBY_HOOK_RE.test(name) || RUBY_HOOK_NAMES.has(name);
}

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
 * PHP core functions whose string arguments are CALLABLES — the positional
 * prior that makes a bare string trustworthy as a function reference.
 * Deliberately core-PHP only; framework registries (WordPress `add_action`)
 * belong in a frameworks/ resolver if ever added.
 */
const PHP_CALLABLE_HOFS = new Set([
  'array_map', 'array_filter', 'array_walk', 'array_walk_recursive', 'array_reduce',
  'usort', 'uasort', 'uksort',
  'array_udiff', 'array_udiff_assoc', 'array_uintersect', 'array_uintersect_assoc',
  'call_user_func', 'call_user_func_array',
  'forward_static_call', 'forward_static_call_array',
  'preg_replace_callback', 'preg_replace_callback_array',
  'register_shutdown_function', 'register_tick_function',
  'set_error_handler', 'set_exception_handler', 'spl_autoload_register',
  'ob_start', 'iterator_apply', 'header_register_callback',
  'is_callable',
]);

const PHP_SPEC: FnRefSpec = {
  // PHP has no bare-identifier function values (the first-class callable
  // `fn(...)` already extracts as a `calls` edge). What qualifies:
  //  - a string argument to a known callable-taking core function
  //    (`usort($a, 'cmp_items')`) — see PHP_CALLABLE_HOFS
  //  - array callables: `[$this, 'method']` (class-scoped) and
  //    `[Foo::class, 'method']` (qualified), in any call's arguments
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([['arguments', { mode: 'args' }]]),
  layers: new Map<string, string | null>([['argument', null]]),
  special: new Set(['encapsed_string', 'string', 'array_creation_expression']),
};

/**
 * Capture specs by language.
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
  php: PHP_SPEC,
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
    for (const { name, node, skipGate } of normalizeValue(v, spec, source, 0)) {
      if (!name || NAME_STOPLIST.has(name)) continue;
      out.push({
        name,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        mode: rule.mode,
        explicitRef,
        skipGate,
      });
    }
  }
  return out;
}

/** One normalized function-value: its name, source node, and gate policy. */
interface NormalizedRef {
  name: string;
  node: SyntaxNode;
  skipGate?: boolean;
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
): NormalizedRef[] {
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
    const results: NormalizedRef[] = [];
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
): NormalizedRef[] {
  switch (type) {
    // Java method references. Receiver decides the resolution route (#808):
    //   `this::run0` / `super::close` → `this.<m>` (class-scoped resolver;
    //     super rides the inherited-member supertype pass)
    //   `Type::method` (capitalized) → qualified `Type::method` (suffix-
    //     matched against that type's members, cross-file capable)
    //   `variable::method` → nothing (receiver type unknown statically —
    //     the deferred obj.method class)
    case 'method_reference': {
      let last: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'identifier') last = child;
      }
      if (!last) return [];
      const m = getNodeText(last, source);
      const text = getNodeText(node, source);
      if (text.startsWith('this::') || text.startsWith('super::')) {
        return [{ name: `this.${m}`, node: last }];
      }
      const recv = text.match(/^([A-Z][A-Za-z0-9_]*)\s*::/);
      if (recv) {
        // `Type::method` — but `Type::new` (constructor ref) has no method
        // node to land on; let the stoplist drop it via the bare name.
        return m === 'new' ? [] : [{ name: `${recv[1]}::${m}`, node: last }];
      }
      return [];
    }

    // Kotlin `::targetCb` (one part) / `OtherClass::handle` (two parts —
    // receiver is a type_identifier; lowercase receivers are variables, the
    // deferred obj.method class).
    case 'callable_reference': {
      let receiver: SyntaxNode | null = null;
      let member: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'type_identifier') receiver = child;
        if (child.type === 'simple_identifier') member = child;
      }
      if (!member) return [];
      const m = getNodeText(member, source);
      if (!receiver) return [{ name: m, node: member }]; // ::topLevelFn
      const recvText = getNodeText(receiver, source);
      return /^[A-Z]/.test(recvText)
        ? [{ name: `${recvText}::${m}`, node: member }]
        : []; // variable::method — unknown receiver type
    }

    // Kotlin `this::fire` parses as navigation_expression with a `::fire`
    // navigation_suffix — route through the class-scoped `this.` resolver.
    // Ordinary `a.b` navigation (and any non-`this` receiver) MUST yield
    // nothing.
    case 'navigation_expression': {
      if (!getNodeText(node, source).startsWith('this::')) return [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'navigation_suffix' && getNodeText(child, source).startsWith('::')) {
          const id = child.namedChild(child.namedChildCount - 1);
          if (id) return [{ name: `this.${getNodeText(id, source)}`, node: id }];
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

    // `this.handleClick` (TS/JS) — object must be EXACTLY `this`. The name
    // keeps the `this.` prefix so resolution can scope it to the enclosing
    // class (see resolveThisMemberFnRef) instead of bare name-matching.
    case 'member_expression': {
      const obj = getChildByField(node, 'object');
      const prop = getChildByField(node, 'property');
      if (obj && prop && obj.type === 'this' && prop.type === 'property_identifier') {
        return [{ name: `this.${getNodeText(prop, source)}`, node: prop }];
      }
      return [];
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

    // PHP string callable — trustworthy ONLY as an argument to a known
    // callable-taking core function (`usort($a, 'cmp_items')`). PHP global
    // functions are referenced cross-file without imports, so these skip the
    // name gate and rely on resolution's unique-or-drop rule. A
    // `'Cls::method'` string becomes a qualified candidate.
    case 'encapsed_string':
    case 'string': {
      const callee = phpEnclosingCallName(node);
      if (!callee || !PHP_CALLABLE_HOFS.has(callee)) return [];
      const content = phpStringContent(node, source);
      if (!content) return [];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(content)) {
        return [{ name: content, node, skipGate: true }];
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(content)) {
        return [{ name: content, node, skipGate: true }];
      }
      return [];
    }

    // PHP array callables, valid in ANY call's arguments (the shape itself is
    // unambiguous): `[$this, 'method']` → class-scoped `this.method`;
    // `[Foo::class, 'method']` → qualified `Foo::method`.
    case 'array_creation_expression': {
      if (node.namedChildCount !== 2) return [];
      const recv = node.namedChild(0)?.namedChild(0);
      const strEl = node.namedChild(1)?.namedChild(0);
      if (!recv || !strEl) return [];
      if (strEl.type !== 'encapsed_string' && strEl.type !== 'string') return [];
      const member = phpStringContent(strEl, source);
      if (!member || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) return [];
      if (recv.type === 'variable_name' && getNodeText(recv, source) === '$this') {
        return [{ name: `this.${member}`, node: strEl }];
      }
      if (recv.type === 'class_constant_access_expression') {
        const cls = recv.namedChild(0);
        const kw = recv.namedChild(1);
        if (cls && kw && getNodeText(kw, source) === 'class') {
          return [{ name: `${getNodeText(cls, source)}::${member}`, node: strEl }];
        }
      }
      return [];
    }

    // Ruby hook-DSL symbols (`before_action :authenticate`,
    // `rescue_from E, with: :render_404`): the symbol names a method of the
    // ENCLOSING class — route through the class-scoped `this.` resolver
    // (which also walks superclasses, covering ApplicationController-style
    // inheritance). Symbols under any other call yield nothing.
    case 'simple_symbol': {
      const call = rubyEnclosingCall(node);
      if (!call) return [];
      const method = getChildByField(call, 'method');
      if (!method || !isRubyHookCall(getNodeText(method, source))) return [];
      const sym = getNodeText(node, source).replace(/^:/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_?!]*$/.test(sym)) return [];
      return [{ name: `this.${sym}`, node }];
    }

    default:
      return [];
  }
}

/** Content of a PHP string literal node (single- or double-quoted). */
function phpStringContent(node: SyntaxNode, source: string): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'string_content') return getNodeText(child, source).trim();
  }
  return null;
}

/** The function name of the PHP call whose arguments contain `node`, if any. */
function phpEnclosingCallName(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node.parent;
  for (let hops = 0; cur && hops < 4; hops++, cur = cur.parent) {
    if (cur.type === 'function_call_expression') {
      const fn = getChildByField(cur, 'function');
      return fn ? fn.text : null;
    }
    if (cur.type === 'member_call_expression' || cur.type === 'scoped_call_expression') {
      return null; // method calls aren't core HOFs
    }
  }
  return null;
}

/** The Ruby `call` node whose argument_list (or keyword pair) contains `node`. */
function rubyEnclosingCall(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  for (let hops = 0; cur && hops < 4; hops++, cur = cur.parent) {
    if (cur.type === 'call') return cur;
  }
  return null;
}
