//! Function-as-value capture (#756) — the TS/JS slice of
//! src/extraction/function-ref.ts (TS_JS_SPEC): container dispatch, value
//! normalization, and the `this.member` special form. The flush-time gate
//! lives in the walker (it needs the file's nodes and import refs).

use tree_sitter::Node;

/// CaptureMode (function-ref.ts) — gate policy keys on it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Args,
    Rhs,
    Value,
    List,
    VarInit,
}

pub struct Candidate {
    pub name: String,
    pub line: u32,
    pub column_byte: usize, // converted to UTF-16 at emit time
    pub row: usize,
}

/// NAME_STOPLIST (function-ref.ts).
fn stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}

/// TS_JS_SPEC.dispatch: container node type → capture mode.
pub fn dispatch(kind: &str) -> Option<Mode> {
    match kind {
        "arguments" => Some(Mode::Args),
        "assignment_expression" => Some(Mode::Rhs),
        "variable_declarator" => Some(Mode::VarInit),
        "pair" => Some(Mode::Value),
        "array" => Some(Mode::List),
        _ => None,
    }
}

/// captureFnRefCandidates for the TS/JS spec. Returns (candidate, mode) pairs.
pub fn capture(container: Node, mode: Mode, src: &str) -> Vec<(Candidate, Mode)> {
    let mut value_nodes: Vec<Node> = Vec::new();

    match mode {
        Mode::Args | Mode::List => {
            for i in 0..container.named_child_count() {
                if let Some(c) = container.named_child(i) {
                    value_nodes.push(c);
                }
            }
        }
        Mode::Rhs => {
            if let Some(rhs) = container.child_by_field_name("right") {
                // Param-storage skip: `this.status = status` — LHS's trailing
                // identifier equals the RHS text ⇒ a stored local/parameter.
                let lhs_text = container
                    .child_by_field_name("left")
                    .map(|l| &src[l.byte_range()])
                    .unwrap_or("");
                let lhs_last = super::util::lhs_last_name()
                    .captures(lhs_text)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str());
                let rhs_text = src[rhs.byte_range()].trim();
                if !(lhs_last.is_some() && lhs_last == Some(rhs_text)) {
                    value_nodes.push(rhs);
                }
            }
        }
        Mode::Value => {
            if let Some(v) = container.child_by_field_name("value") {
                value_nodes.push(v);
            }
        }
        Mode::VarInit => {
            // Destructuring extracts DATA, never a function alias.
            let name_node = container.child_by_field_name("name");
            let is_pattern = name_node
                .map(|n| matches!(n.kind(), "object_pattern" | "array_pattern"))
                .unwrap_or(false);
            if !is_pattern {
                if let Some(v) = container.child_by_field_name("value") {
                    value_nodes.push(v);
                }
            }
        }
    }

    let mut out = Vec::new();
    for v in value_nodes {
        for (name, node) in normalize(v, src) {
            if name.is_empty() || stoplisted(&name) {
                continue;
            }
            let p = node.start_position();
            out.push((
                Candidate {
                    name,
                    line: p.row as u32 + 1,
                    column_byte: node.start_byte(),
                    row: p.row,
                },
                mode,
            ));
        }
    }
    out
}

/// normalizeValue for the TS/JS spec: bare identifiers, plus the
/// `this.<member>` member_expression special form (object EXACTLY `this`).
fn normalize<'t>(node: Node<'t>, src: &str) -> Vec<(String, Node<'t>)> {
    match node.kind() {
        "identifier" => vec![(src[node.byte_range()].to_string(), node)],
        "member_expression" => {
            let obj = node.child_by_field_name("object");
            let prop = node.child_by_field_name("property");
            if let (Some(o), Some(p)) = (obj, prop) {
                if o.kind() == "this" && p.kind() == "property_identifier" {
                    return vec![(format!("this.{}", &src[p.byte_range()]), p)];
                }
            }
            vec![]
        }
        _ => vec![],
    }
}
