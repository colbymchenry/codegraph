//! Swift extraction — a faithful Rust port of `TreeSitterExtractor`'s Swift
//! paths (src/extraction/tree-sitter.ts) plus languages/swift.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The authoritative quirk list is docs/design/swift-kernel-port-checklist.md.
//! The port's center of gravity is the DEDICATED in-class property branch
//! (#1020 — Alamofire's 348 `property` nodes): computed properties become
//! `property` nodes whose getter walks with the property pushed; stored
//! `static let/var` → constant/variable, instance stored → field; decorator/
//! type-annotation/attr-arg refs all attach to the ENCLOSING TYPE; stored
//! declarations descend so initializer calls attribute to the class. Also
//! preserved on purpose: `parameter` field never resolves (zero param type
//! refs, zero signatures), isAsync is present-false (dead hook), `open` →
//! internal visibility, everything-is-`extends` inheritance (first
//! type_identifier of each specifier), no instantiates refs ever (`Foo()` is
//! a plain call), subscript reads as `calls arr`, `defer` as `calls defer`,
//! multi-case enum entries minting only the first case, `/** */` block docs
//! ignored AND chain-breaking, init/deinit/subscript minting no nodes with
//! their bodies routed through visitNode (calls → class, static reads →
//! nothing). Positions in UTF-16 code units. Files with parse errors defer
//! to wasm (structurally high incidence, 9–27% — the sweep runs
//! --max-deferral 0.3 by measured both-arm reality).

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE,
    NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

/// BUILTIN_TYPES (tree-sitter.ts) — full shared table (`Bool` is NOT in it;
/// `Int`/`String`/`Double` are, via the Scala rows — checklist nuances).
fn is_builtin_type(name: &str) -> bool {
    matches!(
        name,
        "string" | "number" | "boolean" | "void" | "null" | "undefined" | "never" | "any"
            | "unknown" | "object" | "symbol" | "bigint" | "true" | "false"
            | "str" | "bool" | "i8" | "i16" | "i32" | "i64" | "i128" | "isize"
            | "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "f32" | "f64" | "char"
            | "int" | "long" | "short" | "byte" | "float" | "double"
            | "int8" | "int16" | "int32" | "int64" | "uint8" | "uint16" | "uint32" | "uint64"
            | "float32" | "float64" | "complex64" | "complex128" | "rune" | "error"
            | "Int" | "Long" | "Short" | "Byte" | "Float" | "Double" | "Boolean" | "Char"
            | "Unit" | "String" | "Any" | "AnyRef" | "AnyVal" | "Nothing" | "Null"
    )
}

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts:373) — full shared set. Note the
/// swift-relevant membership quirks: `line_string_literal` IS in it,
/// `multi_line_string_literal` and `dictionary_literal` are NOT.
fn is_literal_receiver(kind: &str) -> bool {
    matches!(
        kind,
        "string" | "string_literal" | "interpreted_string_literal" | "raw_string_literal"
            | "template_string" | "concatenated_string" | "formatted_string" | "f_string"
            | "line_string_literal" | "string_content" | "heredoc_body"
            | "number" | "number_literal" | "integer" | "integer_literal" | "float"
            | "float_literal" | "int_literal" | "decimal_integer_literal" | "real_literal"
            | "char_literal" | "character_literal" | "rune_literal" | "regex" | "regex_literal"
            | "true" | "false" | "boolean_literal" | "bool_literal" | "none" | "null" | "nil"
            | "null_literal" | "undefined"
            | "list" | "list_literal" | "array" | "array_literal" | "array_creation_expression"
            | "dictionary" | "dict_literal" | "object" | "tuple" | "set"
    )
}

/// `/^[A-Za-z_]\w*$/` with JS's ASCII `\w`.
fn ascii_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}
/// getReturnType's generics strip (`/<[^>]*>/g`) — non-nesting (rust-class quirk).
fn generic_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
/// extractStaticMemberRef's capitalized-receiver test.
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}

/// JS `\s` for the chained-call inner-callee strip (`.replace(/\s+/g, '')`).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{00A0}' | '\u{1680}'
            | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' | '\u{FEFF}'
    )
}
fn strip_js_ws(s: &str) -> String {
    s.chars().filter(|c| !is_js_space(*c)).collect()
}

struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<u8>,
    is_static: Option<bool>,
    is_async: Option<bool>,
    is_exported: Option<bool>,
    return_type: Option<String>,
}

struct ValueScope<'t> {
    row: u32,
    node: Node<'t>,
    name: String,
}

struct Cand {
    from: u32,
    name: String,
    line: u32,
    column_byte: usize,
    row: usize,
}

struct SwiftPropInfo<'t> {
    name_node: Option<Node<'t>>,
    is_let: bool,
    is_computed: bool,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    node_ids: Vec<String>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("swift").ok_or("no swift grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(swift) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    if tree.root_node().has_error() {
        return Err("defer: parse tree contains errors — wasm recovery is canonical".to_string());
    }

    let mut w = Walker {
        src: source,
        file_path,
        line_starts: util::line_starts(source),
        arena: Arena::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        node_ids: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
        fs_values: HashMap::new(),
        fs_value_counts: HashMap::new(),
        value_scopes: Vec::new(),
    };

    let line_count = source.bytes().filter(|b| *b == b'\n').count() as u32 + 1;
    let base_name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    let mut flags = BoolFlags::default();
    flags.set(FLAG_IS_EXPORTED, false);
    let file_id = w.arena.put(&ids::file_node_id(file_path));
    let name_ref = w.arena.put(base_name);
    let qn_ref = w.arena.put(file_path);
    w.tables.push_node(&NodeRow {
        kind: node_kind_index("file").unwrap(),
        visibility: 0,
        flags,
        start_line: 1,
        end_line: line_count,
        start_column: 0,
        end_column: 0,
        name: name_ref,
        qualified_name: qn_ref,
        id: file_id,
        docstring: NONE_STR,
        signature: NONE_STR,
        decorators: NONE_STR,
        type_parameters: NONE_STR,
        return_type: NONE_STR,
        extra_json: NONE_STR,
    });
    w.node_ids.push(ids::file_node_id(file_path));
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    // No packageTypes — swift has no namespace node; top-level QNs are bare.
    w.visit_node(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
    w.stack.pop();

    let duration_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let meta = build_meta(&w.tables, w.arena.len(), NONE_STR, duration_ms);
    Ok(EmitOut {
        meta,
        nodes: w.tables.nodes,
        edges: w.tables.edges,
        refs: w.tables.refs,
        arena: w.arena.into_vec(),
    })
}

/// firstSimpleIdentifier (tree-sitter.ts:261): BFS (FIFO), at most 40 nodes
/// popped, first `simple_identifier` wins.
fn first_simple_identifier<'t>(node: Option<Node<'t>>) -> Option<Node<'t>> {
    let mut q: VecDeque<Node<'t>> = VecDeque::new();
    if let Some(n) = node {
        q.push_back(n);
    }
    let mut guard = 0;
    while guard < 40 {
        let Some(n) = q.pop_front() else { break };
        guard += 1;
        if n.kind() == "simple_identifier" {
            return Some(n);
        }
        for i in 0..n.named_child_count() {
            if let Some(c) = n.named_child(i) {
                q.push_back(c);
            }
        }
    }
    None
}

/// lastNamedOfType (function-ref.ts:600): rightmost matching DESCENDANT in
/// document order (deeper matches override).
fn last_simple_identifier<'t>(node: Node<'t>) -> Option<Node<'t>> {
    let mut found: Option<Node<'t>> = None;
    for i in 0..node.named_child_count() {
        let Some(child) = node.named_child(i) else { continue };
        if child.kind() == "simple_identifier" {
            found = Some(child);
        }
        if let Some(deeper) = last_simple_identifier(child) {
            found = Some(deeper);
        }
    }
    found
}

impl<'t> Walker<'t> {
    fn text(&self, node: Node) -> &'t str {
        &self.src[node.byte_range()]
    }
    fn line_of(&self, node: Node) -> u32 {
        node.start_position().row as u32 + 1
    }
    fn col_of(&self, node: Node) -> u32 {
        util::col16(self.src, &self.line_starts, node.start_position().row, node.start_byte())
    }
    fn end_col_of(&self, node: Node) -> u32 {
        util::col16(self.src, &self.line_starts, node.end_position().row, node.end_byte())
    }
    fn top_row(&self) -> u32 {
        self.stack.last().map(|s| s.row).unwrap_or(0)
    }
    fn inside_class_like(&self) -> bool {
        self.stack
            .last()
            .map(|s| matches!(s.kind, "class" | "struct" | "interface" | "trait" | "enum" | "module"))
            .unwrap_or(false)
    }

    fn push_ref(&mut self, from_row: u32, name: &str, kind_code: u8, line: u32, column: u32) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: kind_code,
            line,
            column,
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        if kind_code == edge_kind_index("imports").unwrap() {
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        self.push_ref(from_row, name, kind_code, self.line_of(node), self.col_of(node));
    }

    // --- createNode ------------------------------------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);
        let end_line = node.end_position().row as u32 + 1; // no resolveBody for swift

        let qualified = {
            let mut parts: Vec<&str> = Vec::new();
            for s in &self.stack {
                if s.kind != "file" {
                    parts.push(&s.name);
                }
            }
            let mut qn = parts.join("::");
            if !qn.is_empty() {
                qn.push_str("::");
            }
            qn.push_str(name);
            qn
        };

        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_exported {
            flags.set(FLAG_IS_EXPORTED, v);
        }
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility.unwrap_or(0),
            flags,
            start_line,
            end_line,
            start_column: self.col_of(node),
            end_column: self.end_col_of(node),
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: doc_ref,
            signature: sig_ref,
            decorators: NONE_STR, // extractModifiers absent — never set from modifiers
            type_parameters: NONE_STR,
            return_type: ret_ref,
            extra_json: NONE_STR,
        });
        self.node_ids.push(id);

        let parent_row = self.top_row();
        self.tables.push_edge(&EdgeRow {
            source_idx: parent_row,
            target_idx: row,
            kind: edge_kind_index("contains").unwrap(),
            provenance: 0,
            line: NONE,
            column: NONE,
            metadata_json: NONE_STR,
            source_id_str: NONE_STR,
            target_id_str: NONE_STR,
        });

        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        // captureValueRefScope — struct:/enum: parents accepted (the swift
        // static-let-namespacing idiom).
        let target_kind_ok = kind == "constant" || kind == "variable";
        if target_kind_ok
            && util::utf16_len(name) >= 3
            && util::has_upper_or_underscore().is_match(name)
        {
            let parent_ok = self
                .stack
                .last()
                .map(|s| matches!(s.kind, "file" | "class" | "module" | "struct" | "enum"))
                .unwrap_or(false);
            if parent_ok {
                self.fs_values.insert(name.to_string(), row);
                *self.fs_value_counts.entry(name.to_string()).or_insert(0) += 1;
            }
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope { row, node, name: name.to_string() });
        }
        Some(row)
    }

    // --- hooks (languages/swift.ts) ----------------------------------------------

    /// extractName incl. the resolveName hook: a multi-segment extension name
    /// (`extension KF.Builder`) takes the LAST type_identifier's text.
    fn extract_name(&self, node: Node) -> String {
        if node.kind() == "class_declaration" {
            if let Some(name_node) = node.child_by_field_name("name") {
                if name_node.kind() == "user_type" {
                    let ids: Vec<Node> = (0..name_node.named_child_count())
                        .filter_map(|i| name_node.named_child(i))
                        .filter(|c| c.kind() == "type_identifier")
                        .collect();
                    if ids.len() > 1 {
                        return self.text(ids[ids.len() - 1]).to_string();
                    }
                }
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                if matches!(c.kind(), "identifier" | "type_identifier" | "simple_identifier" | "constant") {
                    return self.text(c).to_string();
                }
            }
        }
        "<anonymous>".to_string()
    }

    /// getVisibility: whole-text substring matching over `modifiers` children;
    /// default INTERNAL. `open` → internal, `fileprivate` → private (via the
    /// 'private' substring), `public private(set)` → public (first match).
    fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() == "modifiers" {
                let text = self.text(child);
                if text.contains("public") {
                    return 1;
                }
                if text.contains("private") {
                    return 2;
                }
                if text.contains("internal") {
                    return 4;
                }
                // 'fileprivate' arm is dead — 'private' already matched.
            }
        }
        4 // Swift defaults to internal
    }

    /// isStatic: modifiers text contains 'static' OR 'class' (class members
    /// count — deliberate; substring semantics preserved).
    fn is_static(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| {
                c.kind() == "modifiers" && {
                    let t = self.text(c);
                    t.contains("static") || t.contains("class")
                }
            })
    }

    /// isAsync: dead hook — `async` never sits inside `modifiers` (it's an
    /// anon child after the params) → effectively always false, but PRESENT.
    fn is_async(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "modifiers" && self.text(c).contains("async"))
    }

    /// extractSwiftReturnType — POSITIONAL: first user_type/optional_type after
    /// the name simple_identifier, before function_body; last dotted segment;
    /// generics stripped non-nesting; Void → None.
    fn return_type_of(&self, node: Node) -> Option<String> {
        let mut seen_name = false;
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "simple_identifier" && !seen_name {
                seen_name = true;
                continue;
            }
            if !seen_name {
                continue;
            }
            if child.kind() == "function_body" {
                return None;
            }
            let type_node = match child.kind() {
                "user_type" => Some(child),
                "optional_type" => (0..child.named_child_count())
                    .filter_map(|j| child.named_child(j))
                    .find(|c| c.kind() == "user_type"),
                _ => None,
            };
            if child.kind() == "user_type" || child.kind() == "optional_type" {
                let Some(t) = type_node else { return None };
                let name = generic_args_re()
                    .replace_all(self.text(t).trim(), "")
                    .into_owned();
                let last = name.rsplit('.').next().unwrap_or("").trim();
                if last.is_empty() || !ascii_ident_re().is_match(last) || last == "Void" {
                    return None;
                }
                return Some(last.to_string());
            }
        }
        None
    }

    /// swiftPropertyInfo (tree-sitter.ts:277).
    fn swift_property_info(&self, node: Node<'t>) -> SwiftPropInfo<'t> {
        let pattern = node.child_by_field_name("name").or_else(|| {
            (0..node.named_child_count())
                .filter_map(|i| node.named_child(i))
                .find(|c| matches!(c.kind(), "value_binding_pattern" | "pattern"))
        });
        let binding = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "value_binding_pattern");
        let is_let = binding
            .map(|b| self.text(b).trim_start().starts_with("let"))
            .unwrap_or(false);
        let is_computed = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .any(|c| matches!(c.kind(), "computed_property" | "protocol_property_requirements"));
        SwiftPropInfo { name_node: first_simple_identifier(pattern), is_let, is_computed }
    }

    // --- the dispatcher (visitNode, Swift-relevant branches) -----------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_declaration" {
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "class_declaration" {
            // classifyClassNode: `struct`/`enum` keyword children; actor and
            // extension fall through to 'class'.
            let mut classified = "class";
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "struct" {
                        classified = "struct";
                        break;
                    }
                    if c.kind() == "enum" {
                        classified = "enum";
                        break;
                    }
                }
            }
            match classified {
                "struct" => self.extract_struct(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            skip_children = true;
        } else if kind == "protocol_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "typealias_declaration" {
            skip_children = self.extract_type_alias(node);
        } else if kind == "property_declaration" && !self.inside_class_like() {
            // Top-level let/var (extractVariable's swift branch). Initializers
            // are NEVER walked — candidates-only scan.
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if matches!(kind, "property_declaration" | "protocol_property_declaration")
            && self.inside_class_like()
        {
            skip_children = self.dedicated_property_branch(node);
        } else if kind == "import_declaration" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        }
        // init/deinit/subscript declarations, macro_invocation, directive,
        // diagnostic, operator/precedence declarations, protocol function
        // requirements, associatedtype: no branch — recursed. Their calls
        // attribute to the enclosing scope; static-member reads inside them
        // emit NOTHING (the pass is body-walker-only).

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    /// THE DEDICATED PROPERTY BRANCH (tree-sitter.ts:1113-1193, #1020).
    /// Returns skipChildren.
    fn dedicated_property_branch(&mut self, node: Node<'t>) -> bool {
        let owner_row = self.top_row();
        let info = self.swift_property_info(node);
        let mut computed_prop: Option<(u32, String)> = None;

        if let Some(name_node) = info.name_node {
            let name = self.text(name_node).to_string();
            if info.is_computed {
                let row = self.create_node(
                    "property",
                    &name,
                    node,
                    Extra {
                        visibility: Some(self.visibility_of(node)),
                        is_static: Some(self.is_static(node)),
                        ..Extra::default()
                    },
                );
                if let Some(row) = row {
                    computed_prop = Some((row, name));
                }
            } else {
                let is_static = self.is_static(node);
                let kind: &'static str = if is_static {
                    if info.is_let { "constant" } else { "variable" }
                } else {
                    "field"
                };
                self.create_node(
                    kind,
                    &name,
                    node,
                    Extra {
                        visibility: Some(self.visibility_of(node)),
                        is_static: Some(is_static),
                        ..Extra::default()
                    },
                );
            }
        }

        // All three ref passes attach to the ENCLOSING TYPE (ownerId).
        self.extract_decorators_for(node, owner_row);
        // extractVariableTypeAnnotation: the direct type_annotation child.
        let ta = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = ta {
            self.extract_type_refs_from_subtree(ta, owner_row);
        }
        // walkAttrArgs: extractStaticMemberRef over the whole modifiers subtree
        // (`@Siblings(through: Pivot.self)` metatype args).
        let mods = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "modifiers");
        if let Some(mods) = mods {
            self.walk_attr_args(mods);
        }

        if let Some((row, name)) = computed_prop {
            let getter = (0..node.named_child_count())
                .filter_map(|i| node.named_child(i))
                .find(|c| matches!(c.kind(), "computed_property" | "protocol_property_requirements"));
            if let Some(getter) = getter {
                self.stack.push(Scope { row, kind: "property", name });
                self.visit_function_body(getter);
                self.stack.pop();
            }
            return true; // skipChildren — computed only
        }
        // Stored: descend generically — initializer calls attribute to the
        // CLASS; observers' bodies likewise; modifiers re-walk is harmless.
        false
    }

    fn walk_attr_args(&mut self, n: Node<'t>) {
        self.extract_static_member_ref(n);
        for i in 0..n.named_child_count() {
            if let Some(c) = n.named_child(i) {
                self.walk_attr_args(c);
            }
        }
    }

    // --- visitFunctionBody ---------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        }
        // (INSTANTIATION_KINDS has no swift types; extractBareCall absent.)

        self.extract_static_member_ref(node);

        if kind == "function_declaration" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            let mut classified = "class";
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "struct" {
                        classified = "struct";
                        break;
                    }
                    if c.kind() == "enum" {
                        classified = "enum";
                        break;
                    }
                }
            }
            match classified {
                "struct" => self.extract_struct(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            return;
        }
        if kind == "protocol_declaration" {
            self.extract_interface(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- extractors -----------------------------------------------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None, // getSignature reads the never-resolving 'parameter' field
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)), // present-false (dead hook)
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_class(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        // primaryCtor refs: csharp-only (no parameter_list child type).
        // Classes DO get decorates (`@Observable class`), unlike struct/enum.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "class", name });
        let body = node.child_by_field_name("body").unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    fn extract_struct(&mut self, node: Node<'t>) {
        // Body gate (:1876) — bodiless mints nothing (record exemption is C#).
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("struct", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        // NO extractDecoratorsFor for structs (`@main struct` emits nothing).
        self.stack.push(Scope { row, kind: "struct", name });
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else { return };
        // Raw-value types ride inheritance (`enum Suit: String` → extends
        // String — extends refs have NO builtin filter). NO decorates.
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if child.kind() == "enum_entry" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    fn extract_enum_members(&mut self, node: Node<'t>) {
        // `name` field = the FIRST case name only — `case put, delete` mints
        // ONLY `put` (the identifier-scan fallback is dead, the field always
        // resolves). Associated/raw values never walked.
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default() // NO visibility, NO decorates
        };
        let Some(row) = self.create_node("interface", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "interface", name });
        let body = node.child_by_field_name("body").unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    /// extractTypeAlias (:2890) — plain type_alias node + value-subtree type
    /// refs (`typealias Handler = (Data) -> Void` → refs Data + Void…Void is
    /// builtin-suppressed; `= KF.Builder` → refs KF AND Builder). Returns
    /// skipChildren=false (children also recursed, harmlessly).
    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        };
        let row = self.create_node("type_alias", &name, node, extra);
        if let Some(row) = row {
            if let Some(value) = node.child_by_field_name("value") {
                self.extract_type_refs_from_subtree(value, row);
            }
        }
        false
    }

    /// extractVariable — the swift top-level branch (:2851): let → constant /
    /// var → variable via swiftPropertyInfo; computed skipped; position = the
    /// whole declaration; extras = docstring + isExported literal FALSE.
    fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let info = self.swift_property_info(node);
        let Some(name_node) = info.name_node else { return };
        if info.is_computed {
            return;
        }
        let kind: &'static str = if info.is_let { "constant" } else { "variable" };
        let name = self.text(name_node).to_string();
        self.create_node(
            kind,
            &name,
            node,
            Extra { docstring, is_exported: Some(false), ..Extra::default() },
        );
    }

    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let identifier = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "identifier");
        let Some(identifier) = identifier else { return }; // hook null → nothing
        let module_name = self.text(identifier).to_string();
        if module_name.is_empty() {
            return;
        }
        self.create_node(
            "import",
            &module_name,
            node,
            Extra { signature: Some(import_text), ..Extra::default() },
        );
        let parent = self.top_row();
        self.push_ref_at(parent, &module_name.clone(), edge_kind_index("imports").unwrap(), node);
    }

    /// extractCall — swift rides the generic member branch (navigation) and
    /// the raw-text else; the full matrix is in the checklist.
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };
        let mut callee_name = String::new();

        if func.kind() == "navigation_expression" {
            // property = property/field fields (null) → namedChild(1), with
            // the navigation_suffix simple_identifier unwrap.
            let property = func
                .child_by_field_name("property")
                .or_else(|| func.child_by_field_name("field"))
                .or_else(|| {
                    let c1 = func.named_child(1);
                    match c1 {
                        Some(c) if c.kind() == "navigation_suffix" => (0..c.named_child_count())
                            .filter_map(|i| c.named_child(i))
                            .find(|g| g.kind() == "simple_identifier")
                            .or(Some(c)),
                        other => other,
                    }
                });
            if let Some(property) = property {
                let method_name = self.text(property);
                let receiver = func
                    .child_by_field_name("object")
                    .or_else(|| func.child_by_field_name("operand"))
                    .or_else(|| func.child_by_field_name("argument"))
                    .or_else(|| func.named_child(0));
                if let Some(r) = receiver {
                    if is_literal_receiver(r.kind()) {
                        return; // `"lit".upper()` / `5.times()` — nothing
                    }
                }
                let recv_ident = receiver.filter(|r| {
                    matches!(r.kind(), "identifier" | "simple_identifier" | "field_identifier")
                });
                if let Some(r) = recv_ident {
                    let receiver_name = self.text(r);
                    if matches!(receiver_name, "self" | "this" | "cls" | "super") {
                        callee_name = method_name.to_string();
                    } else {
                        callee_name = format!("{receiver_name}.{method_name}");
                    }
                } else if receiver.map(|r| r.kind() == "call_expression").unwrap_or(false) {
                    // #750 swift re-encode: innerNav = receiver.namedChild(0),
                    // ws-stripped; capitalized chains only.
                    let inner = receiver.unwrap().named_child(0);
                    let inner_callee =
                        inner.map(|n| strip_js_ws(self.text(n))).unwrap_or_default();
                    let reencode = inner_callee
                        .as_bytes()
                        .first()
                        .map(|b| b.is_ascii_uppercase())
                        .unwrap_or(false);
                    callee_name = if reencode {
                        format!("{inner_callee}().{method_name}")
                    } else {
                        method_name.to_string()
                    };
                } else {
                    // self_expression / super_expression / inner nav /
                    // postfix / multi_line_string_literal → bare method name.
                    callee_name = method_name.to_string();
                }
            }
        } else {
            // Raw func text: bare `helper`, `Foo` (constructor = plain call),
            // `arr` (subscript reads!), `m[i]`, `defer`, `.make`, tuple
            // callees (conv-regex below), array-literal callees (bump delta 8).
            callee_name = self.text(func).to_string();
        }

        if !callee_name.is_empty() {
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
            self.push_ref_at(caller, &callee_name.clone(), edge_kind_index("calls").unwrap(), node);
        }
    }

    /// extractStaticMemberRef — swift's navigation_expression value reads,
    /// body walker + walkAttrArgs only.
    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "navigation_expression" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        // Skip the callee nav of a call.
        if let Some(parent) = node.parent() {
            if parent.kind() == "call_expression" {
                let callee = parent
                    .child_by_field_name("function")
                    .or_else(|| parent.child_by_field_name("method"))
                    .or_else(|| parent.named_child(0));
                if let Some(callee) = callee {
                    if callee.start_byte() == node.start_byte() {
                        return;
                    }
                }
            }
        }
        let recv = node
            .child_by_field_name("object")
            .or_else(|| node.child_by_field_name("expression"))
            .or_else(|| node.child_by_field_name("scope"))
            .or_else(|| node.named_child(0));
        let Some(recv) = recv else { return };
        if matches!(
            recv.kind(),
            "identifier" | "type_identifier" | "simple_identifier" | "name" | "scoped_type_identifier"
        ) {
            let text = self.text(recv);
            if capitalized_re().is_match(text) {
                self.push_ref_at(owner, &text.to_string(), edge_kind_index("references").unwrap(), recv);
            }
        }
    }

    /// extractInheritance — the swift inheritance_specifier case: FIRST
    /// type_identifier of each specifier's user_type, everything as `extends`
    /// (conformances included; `: Module.Base` takes `Module`).
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "inheritance_specifier" {
                continue;
            }
            let user_type = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "user_type");
            let Some(user_type) = user_type else { continue };
            let type_id = (0..user_type.named_child_count())
                .filter_map(|j| user_type.named_child(j))
                .find(|c| c.kind() == "type_identifier");
            let Some(type_id) = type_id else { continue };
            let name = self.text(type_id).to_string();
            self.push_ref_at(class_row, &name, extends_kind, type_id);
        }
    }

    /// extractTypeAnnotations — generic path: the 'parameter' field NEVER
    /// resolves (zero param refs), 'return_type' DOES; the direct
    /// type_annotation find is null for functions.
    fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if let Some(params) = node.child_by_field_name("parameter") {
            // Unreachable (field never resolves) — mirrored for shape.
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("return_type") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let ta = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = ta {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        if node.kind() == "type_identifier" {
            let type_name = self.text(node).to_string();
            if !type_name.is_empty() && !is_builtin_type(&type_name) {
                self.push_ref_at(from_row, &type_name, edge_kind_index("references").unwrap(), node);
            }
            return;
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.extract_type_refs_from_subtree(c, from_row);
            }
        }
    }

    /// extractDecoratorsFor — swift `attribute` nodes inside `modifiers`.
    /// Coverage: functions/methods/classes/dedicated-branch properties only.
    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for i in 0..decl.named_child_count() {
            let Some(child) = decl.named_child(i) else { continue };
            self.consider_decorator(child, decorated_row);
            if child.kind() == "modifiers" {
                for j in 0..child.named_child_count() {
                    if let Some(m) = child.named_child(j) {
                        self.consider_decorator(m, decorated_row);
                    }
                }
            }
        }
        // Preceding-sibling scan — swift attributes are never siblings; the
        // scan stops at the first non-decorator sibling immediately.
        let Some(parent) = decl.parent() else { return };
        let decl_start = decl.start_byte();
        let mut decl_idx: isize = -1;
        for i in 0..parent.named_child_count() {
            if let Some(sib) = parent.named_child(i) {
                if sib.start_byte() == decl_start {
                    decl_idx = i as isize;
                    break;
                }
            }
        }
        if decl_idx > 0 {
            let mut j = decl_idx - 1;
            while j >= 0 {
                let Some(sib) = parent.named_child(j as usize) else {
                    j -= 1;
                    continue;
                };
                if !matches!(sib.kind(), "decorator" | "annotation" | "marker_annotation") {
                    break;
                }
                self.consider_decorator(sib, decorated_row);
                j -= 1;
            }
        }
    }

    fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        if !matches!(n.kind(), "decorator" | "annotation" | "marker_annotation" | "attribute") {
            return;
        }
        let mut target: Option<Node> = None;
        for i in 0..n.named_child_count() {
            let Some(child) = n.named_child(i) else { continue };
            if child.kind() == "call_expression" {
                target = child.child_by_field_name("function").or_else(|| child.named_child(0));
                if target.is_some() {
                    break;
                }
            }
            if matches!(
                child.kind(),
                "identifier" | "member_expression" | "scoped_identifier" | "navigation_expression"
                    | "user_type" | "type_identifier"
            ) {
                target = Some(child);
                break;
            }
        }
        let Some(target) = target else { return };
        let name = strip_generic_and_qualifier(self.text(target));
        if name.is_empty() {
            return;
        }
        self.push_ref_at(decorated_row, &name, edge_kind_index("decorates").unwrap(), n);
    }

    // --- function-as-value refs (SWIFT_SPEC, function-ref.ts:288) -------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
            List,
            Varinit,
        }
        let mode = match node.kind() {
            "value_arguments" => Mode::Args,
            "assignment" => Mode::Rhs, // field 'result'
            "array_literal" => Mode::List,
            "property_declaration" => Mode::Varinit, // field 'value'
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args | Mode::List => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        values.push(c);
                    }
                }
            }
            Mode::Rhs => {
                if let Some(rhs) = node.child_by_field_name("result") {
                    // Param-storage skip — swift's LHS field is `target`.
                    let lhs = node
                        .child_by_field_name("left")
                        .or_else(|| node.child_by_field_name("lhs"))
                        .or_else(|| node.child_by_field_name("target"))
                        .or_else(|| {
                            if node.named_child_count() >= 2 { node.named_child(0) } else { None }
                        });
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    let rhs_text = self.text(rhs).trim();
                    if !(lhs_last.is_some() && lhs_last == Some(rhs_text)) {
                        values.push(rhs);
                    }
                }
            }
            Mode::Varinit => {
                // Destructuring gate: swift's name field is a `pattern` node —
                // never in the pattern-kind set → never skipped.
                let name_child = node
                    .child_by_field_name("name")
                    .or_else(|| node.child_by_field_name("pattern"));
                let is_destructuring = name_child
                    .map(|nc| {
                        matches!(
                            nc.kind(),
                            "object_pattern" | "array_pattern" | "tuple_pattern" | "struct_pattern"
                        )
                    })
                    .unwrap_or(false);
                if !is_destructuring {
                    if let Some(v) = node.child_by_field_name("value") {
                        values.push(v);
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "simple_identifier" => {
                let name = self.text(v);
                self.push_fn_ref_cand(from, name, v);
            }
            "value_argument" => {
                // Layer with field 'value' + the label-forward skip (the
                // Alamofire A/B finding): label text == value text → dropped.
                let label = v.child_by_field_name("name");
                let value = v.child_by_field_name("value").or_else(|| {
                    if v.named_child_count() > 0 {
                        v.named_child(v.named_child_count() - 1)
                    } else {
                        None
                    }
                });
                if let (Some(l), Some(val)) = (label, value) {
                    if self.text(l).trim() == self.text(val).trim() {
                        return;
                    }
                }
                if let Some(inner) = v.child_by_field_name("value") {
                    self.normalize_fn_ref_value(inner, from, depth + 1);
                }
            }
            "selector_expression" => {
                // `#selector(fire)` → fire; dotted → rightmost
                // simple_identifier (incl. the `_` quirk); else trimmed text.
                let Some(inner) = v.named_child(0) else { return };
                if matches!(inner.kind(), "identifier" | "simple_identifier") {
                    let name = self.text(inner);
                    self.push_fn_ref_cand(from, name, inner);
                    return;
                }
                if let Some(last) = last_simple_identifier(v) {
                    let name = self.text(last);
                    self.push_fn_ref_cand(from, name, last);
                    return;
                }
                let name = self.text(inner).trim().to_string();
                self.push_fn_ref_cand(from, &name, inner);
            }
            _ => {}
        }
    }

    fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node) {
        if name.is_empty() || is_stoplisted(name) {
            return;
        }
        let p = node.start_position();
        self.fn_ref_cands.push(Cand {
            from,
            name: name.to_string(),
            line: p.row as u32 + 1,
            column_byte: node.start_byte(),
            row: p.row,
        });
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halts at functionTypes (function_declaration) + the fixed list —
        // lambda_literal IS in it (closures halt the scan).
        if depth > 0
            && matches!(
                node.kind(),
                "function_declaration" | "arrow_function" | "function_expression" | "lambda_literal"
                    | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.scan_fn_ref_subtree(c, depth + 1);
            }
        }
    }

    fn flush_fn_ref_candidates(&mut self) {
        let cands = std::mem::take(&mut self.fn_ref_cands);
        if cands.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for c in cands {
            if !c.name.starts_with("this.")
                && !c.name.contains("::")
                && !self.defined_fn_names.contains(&c.name)
                && !self.imported_names.contains(&c.name)
            {
                continue;
            }
            if !seen.insert((self.node_ids[c.from as usize].clone(), c.name.clone())) {
                continue;
            }
            let column = util::col16(self.src, &self.line_starts, c.row, c.column_byte);
            let name_ref = self.arena.put(&c.name);
            self.tables.push_ref(&RefRow {
                from_idx: c.from,
                kind: FUNCTION_REF_CODE,
                line: c.line,
                column,
                reference_name: name_ref,
                candidates: NONE_STR,
                from_id_str: NONE_STR,
            });
        }
    }

    // --- value references -------------------------------------------------------------

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if std::env::var("CODEGRAPH_VALUE_REFS").as_deref() == Ok("0") {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — TWO cases resolve for swift: property_declaration
        // (firstSimpleIdentifier over the name/binding pattern; guard-let/
        // if-let bindings have no property_declaration → never prune) AND the
        // shared `assignment` case — a declared-then-assigned `let X: T`
        // followed by `X = …` branches counts one bump per assignment (the
        // directly_assignable_expression's simple_identifier child), pruning
        // X exactly as the wasm arm does (caught by the swift-nio sweep).
        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if n.kind() == "assignment" {
                let left = n
                    .child_by_field_name("left")
                    .or_else(|| n.child_by_field_name("pattern"))
                    .or_else(|| n.named_child(0));
                if let Some(left) = left {
                    if left.kind() == "identifier" {
                        let nm = self.text(left);
                        if targets.contains_key(nm) {
                            *decl_counts.entry(nm).or_insert(0) += 1;
                        }
                    } else {
                        for i in 0..left.named_child_count() {
                            let Some(c) = left.named_child(i) else { continue };
                            if matches!(c.kind(), "identifier" | "simple_identifier") {
                                let nm = self.text(c);
                                if targets.contains_key(nm) {
                                    *decl_counts.entry(nm).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                }
            }
            if n.kind() == "property_declaration" {
                let vd = (0..n.named_child_count())
                    .filter_map(|i| n.named_child(i))
                    .find(|c| c.kind() == "variable_declaration"); // kotlin shape — None for swift
                let id = match vd {
                    Some(vd) => (0..vd.named_child_count())
                        .filter_map(|i| vd.named_child(i))
                        .find(|c| c.kind() == "simple_identifier"),
                    None => first_simple_identifier(n.child_by_field_name("name").or_else(|| {
                        (0..n.named_child_count())
                            .filter_map(|i| n.named_child(i))
                            .find(|c| matches!(c.kind(), "value_binding_pattern" | "pattern"))
                    })),
                };
                if let Some(id) = id {
                    if matches!(id.kind(), "identifier" | "simple_identifier") {
                        let nm = self.text(id);
                        if targets.contains_key(nm) {
                            *decl_counts.entry(nm).or_insert(0) += 1;
                        }
                    }
                }
            }
            for i in 0..n.named_child_count() {
                if let Some(c) = n.named_child(i) {
                    dstack.push(c);
                }
            }
        }
        let shadowed: Vec<String> = decl_counts
            .iter()
            .filter(|(nm, c)| **c > counts.get(**nm).copied().unwrap_or(1))
            .map(|(nm, _)| nm.to_string())
            .collect();
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        let refs_kind = edge_kind_index("references").unwrap();
        for scope in &scopes {
            let mut seen: HashSet<&str> = HashSet::new();
            let mut stack: Vec<Node> = vec![scope.node];
            let mut visited = 0usize;
            while let Some(n) = stack.pop() {
                if visited >= MAX_VALUE_REF_NODES {
                    break;
                }
                visited += 1;
                if matches!(n.kind(), "identifier" | "constant" | "name" | "simple_identifier") {
                    let ref_name = self.text(n);
                    if let Some(&target_row) = targets.get(ref_name) {
                        let target_id = self.node_ids[target_row as usize].as_str();
                        if target_id != self.node_ids[scope.row as usize]
                            && ref_name != scope.name
                            && !seen.contains(&target_id)
                        {
                            seen.insert(target_id);
                            let meta = self.arena.put(r#"{"valueRef":true}"#);
                            self.tables.push_edge(&EdgeRow {
                                source_idx: scope.row,
                                target_idx: target_row,
                                kind: refs_kind,
                                provenance: 0,
                                line: NONE,
                                column: NONE,
                                metadata_json: meta,
                                source_id_str: NONE_STR,
                                target_id_str: NONE_STR,
                            });
                        }
                    }
                }
                for i in 0..n.named_child_count() {
                    if let Some(c) = n.named_child(i) {
                        stack.push(c);
                    }
                }
            }
        }
    }
}

/// The shared decorator-name normalization: strip `<...` from the first `<`
/// (index > 0), keep the segment after the last `.`/`::`, strip ONE leading
/// `:` or `.`, trim.
fn strip_generic_and_qualifier(raw: &str) -> String {
    let mut name = raw.to_string();
    if let Some(lt) = name.find('<') {
        if lt > 0 {
            name.truncate(lt);
        }
    }
    let last_dot = name
        .rfind('.')
        .map(|i| i as isize)
        .unwrap_or(-1)
        .max(name.rfind("::").map(|i| i as isize).unwrap_or(-1));
    if last_dot >= 0 {
        name = name[(last_dot as usize + 1)..].to_string();
        if name.starts_with(':') || name.starts_with('.') {
            name.remove(0);
        }
    }
    name.trim().to_string()
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
