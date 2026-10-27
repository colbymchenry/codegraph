/**
 * Read/write classification for a file-scope value occurrence (#996).
 *
 * `flushValueRefs` already edges a symbol to the same-file file-scope value it
 * mentions; this says whether that mention reads the value, writes it, or does
 * both. The answer is purely syntactic — where the name sits relative to the
 * assignment/declaration binding it — so a repository never needs a type
 * checker to answer "where is this global modified".
 *
 * Mirrored in the native kernel (`codegraph-kernel/src/value_refs.rs`); the two
 * must agree on every occurrence, since kernel↔wasm parity compares exact edges.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';

export interface ValueRefAccess {
  read: boolean;
  write: boolean;
}

const READ: ValueRefAccess = { read: true, write: false };
const WRITE: ValueRefAccess = { read: false, write: true };
const READ_WRITE: ValueRefAccess = { read: true, write: true };

/**
 * Nodes between a name and the assignment/declaration that binds it. Every
 * entry is transparent: climbing it never changes whether the name is being
 * addressed as a target, and a name that lands on a value field falls through
 * to `READ` below.
 */
const TARGET_WRAPPERS = new Set([
  // Destructuring / grouping.
  'pattern_list', 'tuple_pattern', 'list_pattern', 'array_pattern',
  'object_pattern', 'pair_pattern', 'rest_pattern', 'paren_pattern',
  'parenthesized_expression', 'parenthesized_pattern', 'array_pattern_with_tail',
  'list_splat_pattern', 'dictionary_splat_pattern', 'assignment_pattern',
  'object_assignment_pattern', 'shorthand_property_identifier_pattern',
  'binding_pattern', 'pattern',
  // Go groups assignment operands in an `expression_list`.
  'expression_list',
  // Kotlin/Swift/Dart wrap the assignable target.
  'directly_assignable_expression', 'assignable_expression',
  // Kotlin declares through `variable_declaration` inside `property_declaration`.
  'variable_declaration',
]);

/** `x++` / `++x` — the operator is always an increment/decrement. */
const INHERENT_UPDATE_TYPES = new Set(['update_expression']);

/** `x++`-shaped nodes that also cover reads (`!x`, `-x`, `x!`). */
const OPTIONAL_UPDATE_TYPES = new Set([
  'postfix_expression', 'prefix_expression',
  'postfix_unary_expression', 'prefix_unary_expression',
  'unary_expression',
]);

/** Assignment nodes whose spelling alone says the target is also read. */
const INHERENT_COMPOUND_TYPES = new Set([
  'augmented_assignment_expression', // TS/TSX/ArkTS
  'augmented_assignment',            // Python, Kotlin (`+=`)
  'compound_assignment_expr',        // Rust
  'operator_assignment',             // Ruby
]);

const ASSIGNMENT_TYPES = new Set([
  'assignment_expression',  // TS/JS, C/C++, Java, C#, Scala, Dart, PHP
  'assignment_statement',   // Go
  'assignment',             // Python, Ruby, Kotlin, Swift, Pascal
  'infix_expression',       // Scala `x += 1` desugars to an assignment
  'short_var_declaration',  // Go `x := …`
]);

const DECLARATION_TYPES = new Set([
  'variable_declarator',              // TS/JS, Java, C#
  'init_declarator',                  // C/C++
  'let_declaration',                  // Rust
  'const_spec', 'var_spec',           // Go
  'const_item', 'static_item',        // Rust (file-scope)
  'val_definition', 'var_definition', // Scala
  'property_declaration',             // Kotlin / Swift
  'initialized_variable_definition',  // Dart
  'declConst', 'declVar',             // Pascal
]);

/**
 * Binding positions. A parameter is a declaration, but it is not a write to the
 * file-scope value of the same name — the shadow prune may not have seen it
 * (it only counts declarators), so classifying it as a write would mint a false
 * `writes` edge.
 */
const PARAMETER_TYPES = new Set([
  'required_parameter', 'optional_parameter', 'formal_parameter',
  'parameter', 'parameter_declaration', 'simple_parameter',
  'function_parameter', 'variadic_parameter', 'rest_parameter',
  'function_value_parameters', 'formal_parameters', 'parameter_list',
]);

const COMPOUND_OPERATORS = new Set([
  '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=',
  '&=', '|=', '^=', '&&=', '||=', '??=', '++', '--',
  'kAddAssign', 'kSubAssign', 'kMulAssign', 'kDivAssign',
]);

/** `x = 1`, `x := 1`, Go's `x = 1`, Pascal's `x := 1`. */
const PLAIN_OPERATORS = new Set(['=', ':=', '<-', 'kAssign']);

/**
 * How `node` (a name matched to a file-scope value) is used.
 *
 * Defaults to a read: anything not in a binding position is evaluated, which is
 * exactly what makes it a read. Both flags are true for compound assignment and
 * `++`/`--`, where the old value is consumed and a new one stored.
 */
export function valueRefAccess(node: SyntaxNode, source: string): ValueRefAccess {
  let cur = node;
  let parent = cur.parent;

  while (parent && TARGET_WRAPPERS.has(parent.type)) {
    cur = parent;
    parent = parent.parent;
  }
  if (!parent) return READ;

  if (INHERENT_UPDATE_TYPES.has(parent.type)) return READ_WRITE;
  if (OPTIONAL_UPDATE_TYPES.has(parent.type)) {
    return isIncrement(parent, source) ? READ_WRITE : READ;
  }
  if (PARAMETER_TYPES.has(parent.type)) return READ;

  if (parent.type === 'infix_expression') {
    // Scala: a compound operator is an assignment; any other infix expression
    // (`x + 1`) only reads its operands.
    if (getChildByField(parent, 'left')?.id !== cur.id) return READ;
    return isCompoundOperator(parent, source) ? READ_WRITE : READ;
  }

  const target = targetOf(parent);
  if (!target || target.id !== cur.id) return READ;

  if (INHERENT_COMPOUND_TYPES.has(parent.type)) return READ_WRITE;
  if (DECLARATION_TYPES.has(parent.type)) return WRITE;
  if (ASSIGNMENT_TYPES.has(parent.type)) {
    return isCompoundOperator(parent, source) ? READ_WRITE : WRITE;
  }
  return READ;
}

/** The child of `parent` that an assignment/declaration stores into. */
function targetOf(parent: SyntaxNode): SyntaxNode | null {
  switch (parent.type) {
    case 'assignment':
      // Python/Ruby `left`, Swift `target`, Pascal `lhs`, Kotlin positional.
      return (
        getChildByField(parent, 'left') ??
        getChildByField(parent, 'target') ??
        getChildByField(parent, 'lhs') ??
        parent.namedChildren[0] ??
        null
      );
    case 'property_declaration': {
      // Kotlin `val x = …` wraps the name in variable_declaration; Swift
      // `let x = …` wraps it in a pattern.
      const named = parent.namedChildren.find(
        (c) => c.type === 'variable_declaration' || c.type === 'pattern'
      );
      return getChildByField(parent, 'name') ?? named ?? parent.namedChildren[0] ?? null;
    }
    case 'initialized_variable_definition':
      return getChildByField(parent, 'name') ?? parent.namedChildren[0] ?? null;
    case 'infix_expression':
      return getChildByField(parent, 'left');
    default:
      return (
        getChildByField(parent, 'left') ??
        getChildByField(parent, 'name') ??
        getChildByField(parent, 'pattern') ??
        getChildByField(parent, 'lhs') ??
        getChildByField(parent, 'target') ??
        getChildByField(parent, 'declarator') ??
        null
      );
  }
}

/** Whether an assignment-ish node's operator consumes the old value. */
function isCompoundOperator(parent: SyntaxNode, source: string): boolean {
  const explicit = getChildByField(parent, 'operator');
  if (explicit) {
    const text = getNodeText(explicit, source);
    if (PLAIN_OPERATORS.has(text) || explicit.type === 'kAssign') return false;
    if (COMPOUND_OPERATORS.has(text)) return true;
  }
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (!child) continue;
    // `++`/`--` and compound spellings are anonymous tokens in most grammars.
    // Named operator nodes cover Scala (operator_identifier), Pascal and Dart.
    if (!child.isNamed && COMPOUND_OPERATORS.has(child.type) && !PLAIN_OPERATORS.has(child.type)) {
      return true;
    }
    if (
      child.isNamed &&
      (child.type === 'operator_identifier' ||
        child.type === 'increment_operator' ||
        child.type === 'decrement_operator' ||
        child.type === 'postfix_operator' ||
        child.type.startsWith('k')) &&
      COMPOUND_OPERATORS.has(getNodeText(child, source))
    ) {
      return true;
    }
  }
  return false;
}

/** `x++`, `--x`, `x!` — only the increment/decrement forms write. */
function isIncrement(parent: SyntaxNode, source: string): boolean {
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (!child) continue;
    if (child.type === 'increment_operator' || child.type === 'decrement_operator') return true;
    const text = getNodeText(child, source);
    if (text === '++' || text === '--') return true;
  }
  return false;
}
