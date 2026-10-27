//! Read/write classification for a file-scope value occurrence (#996).
//!
//! `flush_value_refs` in each language walker already edges a symbol to the
//! same-file file-scope value it mentions; this says whether that mention
//! reads the value, writes it, or does both. The answer is purely syntactic —
//! where the name sits relative to the assignment/declaration binding it — so
//! no type checker is needed to answer "where is this global modified".
//!
//! This is the native twin of `src/extraction/value-ref-access.ts`. The two
//! must agree on every occurrence, since kernel↔wasm parity compares exact
//! edges (including line/column, which the TS side sets from the same node).

use tree_sitter::Node;

/// A name evaluated as a value.
const READ: (bool, bool) = (true, false);
/// A name bound as an assignment/declaration target.
const WRITE: (bool, bool) = (false, true);
/// `x += 1`, `x++`: the old value is consumed and a new one stored.
const READ_WRITE: (bool, bool) = (true, true);

fn text<'s>(node: Node, src: &'s str) -> &'s str {
    &src[node.byte_range()]
}

/// How `node` (a name matched to a file-scope value) is used.
///
/// Defaults to a read: anything not in a binding position is evaluated, which
/// is exactly what makes it a read. Both flags are true for compound
/// assignment and `++`/`--`.
pub fn access(node: Node, src: &str) -> (bool, bool) {
    let mut cur = node;
    let mut parent = cur.parent();
    while let Some(p) = parent {
        if is_target_wrapper(p.kind()) {
            cur = p;
            parent = p.parent();
        } else {
            break;
        }
    }
    let Some(parent) = parent else { return READ };

    if parent.kind() == "update_expression" {
        return READ_WRITE;
    }
    if is_optional_update(parent.kind()) {
        return if is_increment(parent, src) { READ_WRITE } else { READ };
    }
    if is_parameter(parent.kind()) {
        return READ;
    }

    if parent.kind() == "infix_expression" {
        // Scala: a compound operator is an assignment; any other infix
        // expression (`x + 1`) only reads its operands.
        if parent.child_by_field_name("left").map(|l| l.id()) != Some(cur.id()) {
            return READ;
        }
        return if is_compound_operator(parent, src) { READ_WRITE } else { READ };
    }

    let Some(target) = target_of(parent) else { return READ };
    if target.id() != cur.id() {
        return READ;
    }

    if is_inherent_compound(parent.kind()) {
        return READ_WRITE;
    }
    if is_declaration(parent.kind()) {
        return WRITE;
    }
    if is_assignment(parent.kind()) {
        return if is_compound_operator(parent, src) { READ_WRITE } else { WRITE };
    }
    READ
}

/// Nodes between a name and the assignment/declaration that binds it. Every
/// entry is transparent: climbing it never changes whether the name is being
/// addressed as a target, and a name that lands on a value field falls through
/// to `READ`.
fn is_target_wrapper(kind: &str) -> bool {
    matches!(
        kind,
        // Destructuring / grouping.
        "pattern_list" | "tuple_pattern" | "list_pattern" | "array_pattern"
            | "object_pattern" | "pair_pattern" | "rest_pattern" | "paren_pattern"
            | "parenthesized_expression" | "parenthesized_pattern" | "array_pattern_with_tail"
            | "list_splat_pattern" | "dictionary_splat_pattern" | "assignment_pattern"
            | "object_assignment_pattern" | "shorthand_property_identifier_pattern"
            | "binding_pattern" | "pattern"
            // Go groups assignment operands in an `expression_list`.
            | "expression_list"
            // Kotlin/Swift/Dart wrap the assignable target.
            | "directly_assignable_expression" | "assignable_expression"
            // Kotlin declares through `variable_declaration` inside `property_declaration`.
            | "variable_declaration"
    )
}

/// `x++`-shaped nodes that also cover reads (`!x`, `-x`, `x!`).
fn is_optional_update(kind: &str) -> bool {
    matches!(
        kind,
        "postfix_expression"
            | "prefix_expression"
            | "postfix_unary_expression"
            | "prefix_unary_expression"
            | "unary_expression"
    )
}

/// Assignment nodes whose spelling alone says the target is also read.
fn is_inherent_compound(kind: &str) -> bool {
    matches!(
        kind,
        "augmented_assignment_expression" // TS/TSX/ArkTS
            | "augmented_assignment"      // Python, Kotlin (`+=`)
            | "compound_assignment_expr"  // Rust
            | "operator_assignment"       // Ruby
    )
}

fn is_assignment(kind: &str) -> bool {
    matches!(
        kind,
        "assignment_expression" // TS/JS, C/C++, Java, C#, Scala, Dart, PHP
            | "assignment_statement" // Go
            | "assignment"       // Python, Ruby, Kotlin, Swift, Pascal
            | "infix_expression" // Scala `x += 1` desugars to an assignment
            | "short_var_declaration" // Go `x := …`
    )
}

fn is_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "variable_declarator"             // TS/JS, Java, C#
            | "init_declarator"           // C/C++
            | "let_declaration"           // Rust
            | "const_spec" | "var_spec"   // Go
            | "const_item" | "static_item" // Rust (file-scope)
            | "val_definition" | "var_definition" // Scala
            | "property_declaration"      // Kotlin / Swift
            | "initialized_variable_definition" // Dart
            | "declConst" | "declVar"     // Pascal
    )
}

/// Binding positions. A parameter is a declaration, but it is not a write to
/// the file-scope value of the same name — the shadow prune may not have seen
/// it (it only counts declarators), so classifying it as a write would mint a
/// false `writes` edge.
fn is_parameter(kind: &str) -> bool {
    matches!(
        kind,
        "required_parameter"
            | "optional_parameter"
            | "formal_parameter"
            | "parameter"
            | "parameter_declaration"
            | "simple_parameter"
            | "function_parameter"
            | "variadic_parameter"
            | "rest_parameter"
            | "function_value_parameters"
            | "formal_parameters"
            | "parameter_list"
    )
}

/// The child of `parent` that an assignment/declaration stores into.
fn target_of(parent: Node) -> Option<Node> {
    match parent.kind() {
        "assignment" => {
            // Python/Ruby `left`, Swift `target`, Pascal `lhs`, Kotlin positional.
            field(parent, "left")
                .or_else(|| field(parent, "target"))
                .or_else(|| field(parent, "lhs"))
                .or_else(|| parent.named_child(0))
        }
        "property_declaration" => {
            // Kotlin `val x = …` wraps the name in variable_declaration; Swift
            // `let x = …` wraps it in a pattern.
            let named = (0..parent.named_child_count())
                .filter_map(|i| parent.named_child(i))
                .find(|c| matches!(c.kind(), "variable_declaration" | "pattern"));
            field(parent, "name")
                .or(named)
                .or_else(|| parent.named_child(0))
        }
        "initialized_variable_definition" => {
            field(parent, "name").or_else(|| parent.named_child(0))
        }
        "infix_expression" => field(parent, "left"),
        _ => field(parent, "left")
            .or_else(|| field(parent, "name"))
            .or_else(|| field(parent, "pattern"))
            .or_else(|| field(parent, "lhs"))
            .or_else(|| field(parent, "target"))
            .or_else(|| field(parent, "declarator")),
    }
}

fn field<'t>(node: Node<'t>, name: &str) -> Option<Node<'t>> {
    node.child_by_field_name(name)
}

/// Whether an assignment-ish node's operator consumes the old value.
fn is_compound_operator(parent: Node, src: &str) -> bool {
    if let Some(explicit) = parent.child_by_field_name("operator") {
        let op = text(explicit, src);
        if is_plain_operator(op) || explicit.kind() == "kAssign" {
            return false;
        }
        if is_compound_operator_text(op) {
            return true;
        }
    }
    for i in 0..parent.child_count() {
        let Some(child) = parent.child(i) else { continue };
        let kind = child.kind();
        // `++`/`--` and compound spellings are anonymous tokens in most
        // grammars. Named operator nodes cover Scala (operator_identifier),
        // Pascal and Dart.
        if !child.is_named() && is_compound_operator_text(kind) && !is_plain_operator(kind) {
            return true;
        }
        if child.is_named()
            && (kind == "operator_identifier"
                || kind == "increment_operator"
                || kind == "decrement_operator"
                || kind == "postfix_operator"
                || kind.starts_with('k'))
            && is_compound_operator_text(text(child, src))
        {
            return true;
        }
    }
    false
}

/// `x++`, `--x`, `x!` — only the increment/decrement forms write.
fn is_increment(parent: Node, src: &str) -> bool {
    for i in 0..parent.child_count() {
        let Some(child) = parent.child(i) else { continue };
        if matches!(child.kind(), "increment_operator" | "decrement_operator") {
            return true;
        }
        if matches!(text(child, src), "++" | "--") {
            return true;
        }
    }
    false
}

fn is_compound_operator_text(op: &str) -> bool {
    matches!(
        op,
        "+=" | "-=" | "*=" | "/=" | "%=" | "**=" | "<<=" | ">>=" | ">>>=" | "&=" | "|=" | "^="
            | "&&=" | "||=" | "??=" | "++" | "--" | "kAddAssign" | "kSubAssign" | "kMulAssign"
            | "kDivAssign"
    )
}

/// `x = 1`, `x := 1`, Go's `x = 1`, Pascal's `x := 1`.
fn is_plain_operator(op: &str) -> bool {
    matches!(op, "=" | ":=" | "<-" | "kAssign")
}
