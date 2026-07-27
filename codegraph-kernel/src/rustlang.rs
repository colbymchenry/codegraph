//! Rust-language extraction — a faithful port of `TreeSitterExtractor`'s rust
//! paths (src/extraction/tree-sitter.ts) plus languages/rust.ts. ("rustlang"
//! because `rust` alone collides with the kernel's own implementation
//! language.) Survey artifact: docs/design/rust-lang-kernel-port-checklist.md.
//!
//! Rust's shape quirks, mirrored exactly (bug-for-bug, all verified against
//! the TS reference):
//! - `isAsync` is dead code upstream: it scans DIRECT children for an `async`
//!   token, but the grammar nests it inside `function_modifiers` — every rust
//!   fn/method carries isAsync **false** (present-false, never absent).
//! - impl blocks push NO scope: members re-dispatch at file scope, so an impl
//!   associated `const` becomes a FILE-level `variable`, and the method↔owner
//!   `contains` edge is a source-order name scan (an impl ABOVE its struct
//!   gets no edge). `impl Trait for Generic<T>`'s receiver resolves to the
//!   TRAIT (the only direct type_identifier), and methods get QN
//!   `Trait::method` — preserve, never "fix" via the grammar's trait:/type:
//!   fields.
//! - `const_item`/`static_item` ride the generic extractVariable fallback:
//!   kind is always `variable`, no signature, and EVERY direct `identifier`
//!   child mints a node (`const MAX: u32 = OTHER;` → two nodes, `MAX` + the
//!   phantom `OTHER`). Top-level initializer values are never body-walked.
//! - Unit structs (`struct Unit;`, no body field) mint NO node; `mod_item`
//!   mints no module node and adds no QN prefix.
//! - Chained-call re-encode is scoped_identifier-gated (`Foo::new().bar()` →
//!   `Foo::new().bar`); instance chains, parens, `.await`, 2-hop fields, and
//!   `self` receivers all collapse to the bare method name (`self` is node
//!   kind `self`, not `identifier`, so it dodges SKIP_RECEIVERS by falling
//!   through). Turbofish callees keep the raw `helper::<T>` text.
//! - `use` emits an import node named by the ROOT module (`crate`/`self`/…),
//!   one root `imports` ref, then one FULL-path `imports` ref per binding;
//!   `use x::*` (use_wildcard) emits nothing at all.
//! - Trait supertraits come only from `trait_bounds`; a scoped supertrait
//!   (`fmt::Debug`) matches no case and is silently dropped.
//! - Rocket `routes!`/`catchers!` are extracted ONLY inside function bodies,
//!   and only when the macro name is a bare identifier.
//! - A rust type alias emits NO ref to its aliased type (the shared code
//!   reads a `value` field; rust's field is `type`).
//! - An `attribute_item` between a doc comment and its item breaks the
//!   docstring sibling chain (`#[derive(..)]` kills the docstring).
//! Files with parse errors defer to wasm.

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_EXPORTED, FUNCTION_REF_CODE, NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

/// JS `/<[^>]*>/g` — the non-nested generic strip (breaks on nested generics
/// by design: `Result<Vec<Foo>, E>` → `Result, E>` → returnType undefined).
fn generic_angle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
/// JS `/^[A-Za-z_]\w*$/` (ASCII \w — the regex crate's \w is Unicode).
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
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
    return_type: Option<String>,
    qualified_name: Option<String>,
    visibility: Option<u8>,
    is_exported: Option<bool>,
    is_async: Option<bool>,
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

/// Per-node metadata for the receiver-method owner lookup and
/// findNodeByName (mirrors the TS scans over `this.nodes` — FIRST match
/// wins, earlier-in-file only).
struct NodeMeta {
    kind: &'static str,
    name: String,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    nodes_meta: Vec<NodeMeta>,
    node_ids: Vec<String>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("rust").ok_or("no rust grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(rust) failed: {e}"))?;
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
        nodes_meta: Vec::new(),
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
    w.nodes_meta.push(NodeMeta { kind: "file", name: base_name.to_string() });
    w.node_ids.push(ids::file_node_id(file_path));
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

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
    /// isInsideClassLikeNode — stack TOP only, file doesn't count.
    fn inside_class_like(&self) -> bool {
        self.stack
            .last()
            .map(|s| matches!(s.kind, "class" | "struct" | "interface" | "trait" | "enum" | "module"))
            .unwrap_or(false)
    }

    fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: kind_code,
            line: self.line_of(node),
            column: self.col_of(node),
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        if kind_code == edge_kind_index("imports").unwrap() {
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                // `::`-separated rust paths match NEITHER regex (separators are
                // `.`/`\`), so multi-segment use-imports contribute nothing to
                // the fn-ref gate — the rust gate is effectively same-file-only.
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);
        let end_line = node.end_position().row as u32 + 1;

        let qualified = extra.qualified_name.unwrap_or_else(|| {
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
        });

        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_exported {
            flags.set(FLAG_IS_EXPORTED, v);
        }
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
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
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: ret_ref,
            extra_json: NONE_STR,
        });
        self.nodes_meta.push(NodeMeta { kind, name: name.to_string() });
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
        // captureValueRefScope: rust consts are kind `variable` — still targets.
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

    /// extractName — nameField `name`, else the identifier-like child scan.
    fn extract_name(&self, node: Node) -> String {
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

    /// rustExtractor.getSignature: raw params text + ` -> ` + raw return type.
    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if let Some(rt) = node.child_by_field_name("return_type") {
            sig.push_str(" -> ");
            sig.push_str(self.text(rt));
        }
        Some(sig)
    }

    /// rustExtractor.getVisibility: direct `visibility_modifier` child whose
    /// text contains `pub` → public, else private; none → private.
    fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            if let Some(c) = node.child(i) {
                if c.kind() == "visibility_modifier" {
                    return if self.text(c).contains("pub") { 1 } else { 2 };
                }
            }
        }
        2 // private — Rust defaults to private
    }

    /// extractRustReturnType (languages/rust.ts:14).
    fn return_type_of(&self, node: Node) -> Option<String> {
        let mut rt = node.child_by_field_name("return_type")?;
        if rt.kind() == "reference_type" {
            rt = (0..rt.named_child_count())
                .filter_map(|i| rt.named_child(i))
                .find(|c| matches!(c.kind(), "type_identifier" | "scoped_type_identifier" | "generic_type"))
                .unwrap_or(rt);
        }
        if matches!(rt.kind(), "primitive_type" | "unit_type" | "tuple_type") {
            return None;
        }
        let text = self.text(rt).trim();
        let stripped = generic_angle_re().replace_all(text, "");
        let last = stripped.rsplit("::").next().unwrap_or("").trim();
        if last.is_empty() || !simple_ident_re().is_match(last) {
            return None;
        }
        Some(if last == "Self" { "self".to_string() } else { last.to_string() })
    }

    /// rustExtractor.getReceiverType: parent-walk to the nearest impl_item;
    /// LAST direct type_identifier child wins (for `impl Trait for Generic<T>`
    /// that's the TRAIT — bug preserved); else the first generic_type's inner
    /// type_identifier.
    fn receiver_type_of(&self, node: Node) -> Option<String> {
        let mut parent = node.parent();
        while let Some(p) = parent {
            if p.kind() == "impl_item" {
                let type_idents: Vec<Node> = (0..p.named_child_count())
                    .filter_map(|i| p.named_child(i))
                    .filter(|c| c.kind() == "type_identifier")
                    .collect();
                if let Some(last) = type_idents.last() {
                    return Some(self.text(*last).to_string());
                }
                let generic = (0..p.named_child_count())
                    .filter_map(|i| p.named_child(i))
                    .find(|c| c.kind() == "generic_type");
                if let Some(g) = generic {
                    let inner = (0..g.named_child_count())
                        .filter_map(|i| g.named_child(i))
                        .find(|c| c.kind() == "type_identifier");
                    if let Some(inner) = inner {
                        return Some(self.text(inner).to_string());
                    }
                }
                return None;
            }
            parent = p.parent();
        }
        None
    }

    // --- visitNode ------------------------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if matches!(kind, "function_item" | "function_signature_item") {
            self.extract_fn_or_method(node);
            skip_children = true;
        } else if kind == "trait_item" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "struct_item" {
            self.extract_struct(node);
            skip_children = true;
        } else if kind == "enum_item" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "type_item" {
            self.extract_type_alias(node);
            // extractTypeAlias returns false for rust (plain alias) — children
            // are visited (nothing in them has a branch).
        } else if matches!(kind, "let_declaration" | "const_item" | "static_item")
            && !self.inside_class_like()
        {
            // Inside a class-like scope the gate fails and the else-ladder
            // falls through with children VISITED — a trait const's value
            // expression emits calls refs from the trait node.
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "use_declaration" {
            self.extract_import(node);
            // importTypes branch never sets skipChildren.
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "struct_expression" {
            self.extract_instantiation(node);
        } else if kind == "impl_item" {
            // Emits the implements back-reference; skipChildren stays false so
            // the declaration_list is visited at FILE scope (impl pushes
            // nothing on the stack).
            self.extract_rust_impl_item(node);
        }

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- extractors --------------------------------------------------------------

    /// extractFunction/extractMethod, decision resolved once: method iff a
    /// receiver is found (fn inside an impl — including a NESTED fn inside an
    /// impl method's body, whose parent walk passes through the outer fn) or
    /// the stack top is class-like (trait members).
    fn extract_fn_or_method(&mut self, node: Node<'t>) {
        let receiver = self.receiver_type_of(node);
        let as_method = receiver.is_some() || self.inside_class_like();

        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }

        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: self.signature_of(node),
            visibility: Some(self.visibility_of(node)),
            // isAsync hook exists but never finds a direct `async` child (it
            // nests in function_modifiers) — present-false on every node.
            is_async: Some(false),
            return_type: self.return_type_of(node),
            qualified_name: receiver.as_ref().map(|r| format!("{r}::{name}")),
            ..Extra::default() // isExported hook absent → flag not set
        };
        let kind: &'static str = if as_method { "method" } else { "function" };
        let Some(row) = self.create_node(kind, &name, node, extra) else { return };

        // Contains edge from the owner: receiver present AND not class-like —
        // FIRST earlier-in-file struct/class/enum/trait of the receiver's name.
        if as_method && !self.inside_class_like() {
            if let Some(receiver) = &receiver {
                let owner_row = self
                    .nodes_meta
                    .iter()
                    .position(|m| {
                        m.name == *receiver
                            && matches!(m.kind, "struct" | "class" | "enum" | "trait")
                    })
                    .map(|i| i as u32);
                if let Some(owner_row) = owner_row {
                    self.tables.push_edge(&EdgeRow {
                        source_idx: owner_row,
                        target_idx: row,
                        kind: edge_kind_index("contains").unwrap(),
                        provenance: 0,
                        line: NONE,
                        column: NONE,
                        metadata_json: NONE_STR,
                        source_id_str: NONE_STR,
                        target_id_str: NONE_STR,
                    });
                }
            }
        }

        self.extract_type_annotations(node, row);
        // extractDecoratorsFor: rust attribute_items are siblings, not
        // decorator/annotation/attribute node types — complete no-op.
        self.stack.push(Scope { row, kind, name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    /// extractInterface — kind `trait` (interfaceKind), inheritance from
    /// trait_bounds, body children visited with the trait pushed.
    fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default() // no visibility/isExported on the interface path
        };
        let Some(row) = self.create_node("trait", &name, node, extra) else { return };
        self.extract_inheritance(node, row);

        self.stack.push(Scope { row, kind: "trait", name });
        let body = node.child_by_field_name("body").unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    /// extractStruct — body field REQUIRED (unit structs mint no node; tuple
    /// structs' ordered_field_declaration_list is a body).
    fn extract_struct(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("struct", &name, node, extra) else { return };
        self.extract_inheritance(node, row);

        self.stack.push(Scope { row, kind: "struct", name });
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    /// extractEnum — body required; enum_variant children → enum_member nodes
    /// (name field only, payloads never walked); other children re-dispatched.
    fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else { return };
        self.extract_inheritance(node, row);

        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(c) = body.named_child(i) else { continue };
            if c.kind() == "enum_variant" {
                if let Some(name_node) = c.child_by_field_name("name") {
                    let vname = self.text(name_node).to_string();
                    self.create_node("enum_member", &vname, c, Extra::default());
                }
            } else {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    /// extractTypeAlias — plain `type_alias` node. QUIRK: the alias-value ref
    /// walk reads a `value` field; rust type_item's field is `type` → no ref
    /// to the aliased type. Returns children-visited (false) like the TS.
    fn extract_type_alias(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        };
        self.create_node("type_alias", &name, node, extra);
    }

    /// extractVariable's generic fallback: kind is ALWAYS `variable` (no
    /// isConst hook), every direct `identifier` child mints a node positioned
    /// at the CHILD, docstring shared, isExported present-false, no signature,
    /// and the initializer value is never body-walked.
    fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "identifier" {
                continue;
            }
            let name = self.text(child).to_string();
            if !name.is_empty() {
                self.create_node(
                    "variable",
                    &name,
                    child,
                    Extra {
                        docstring: docstring.clone(),
                        is_exported: Some(false),
                        ..Extra::default()
                    },
                );
            }
        }
    }

    /// extractImport via the rust hook: import node named by the ROOT module +
    /// one generic root `imports` ref + per-binding FULL-path refs.
    /// `use x::*;` (use_wildcard) → hook returns null → nothing at all.
    fn extract_import(&mut self, node: Node<'t>) {
        let use_arg = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| matches!(c.kind(), "scoped_use_list" | "scoped_identifier" | "use_list" | "identifier"));
        let Some(use_arg) = use_arg else { return };

        let module_name = self.root_module(use_arg);
        let signature = self.text(node).trim().to_string();
        self.create_node(
            "import",
            &module_name.clone(),
            node,
            Extra { signature: Some(signature), ..Extra::default() },
        );
        let parent = self.top_row();
        let imports_kind = edge_kind_index("imports").unwrap();
        if !module_name.is_empty() {
            self.push_ref_at(parent, &module_name, imports_kind, node);
        }
        self.emit_use_binding_refs(node, parent);
    }

    /// getRootModule (languages/rust.ts:124).
    fn root_module(&self, n: Node) -> String {
        let Some(first) = n.named_child(0) else {
            return self.text(n).to_string();
        };
        match first.kind() {
            "identifier" | "crate" | "super" | "self" => self.text(first).to_string(),
            "scoped_identifier" => self.root_module(first),
            _ => self.text(first).to_string(),
        }
    }

    /// emitRustUseBindingRefs (tree-sitter.ts:3451) — one FULL-path `imports`
    /// ref per binding; `Path as Alias` links the source path; leaves that are
    /// only `self`/`super`/`crate`/`*` are skipped.
    fn emit_use_binding_refs(&mut self, node: Node<'t>, from_row: u32) {
        let mut paths: Vec<(String, Node)> = Vec::new();
        fn join(prefix: &str, seg: &str) -> String {
            if prefix.is_empty() { seg.to_string() } else { format!("{prefix}::{seg}") }
        }
        fn collect<'t>(w: &Walker<'t>, n: Node<'t>, prefix: &str, paths: &mut Vec<(String, Node<'t>)>) {
            match n.kind() {
                "identifier" => paths.push((join(prefix, w.text(n)), n)),
                "scoped_identifier" => {
                    let full = w.text(n).trim();
                    paths.push((
                        if prefix.is_empty() { full.to_string() } else { format!("{prefix}::{full}") },
                        n,
                    ));
                }
                "scoped_use_list" => {
                    let seg = n
                        .child_by_field_name("path")
                        .map(|p| w.text(p).trim().to_string())
                        .unwrap_or_default();
                    let new_prefix = if seg.is_empty() { prefix.to_string() } else { join(prefix, &seg) };
                    let list = n.child_by_field_name("list").or_else(|| {
                        (0..n.named_child_count())
                            .filter_map(|i| n.named_child(i))
                            .find(|c| c.kind() == "use_list")
                    });
                    if let Some(list) = list {
                        collect(w, list, &new_prefix, paths);
                    }
                }
                "use_list" => {
                    for i in 0..n.named_child_count() {
                        if let Some(c) = n.named_child(i) {
                            collect(w, c, prefix, paths);
                        }
                    }
                }
                "use_as_clause" => {
                    let p = n.child_by_field_name("path").or_else(|| n.named_child(0));
                    if let Some(p) = p {
                        collect(w, p, prefix, paths);
                    }
                }
                _ => {} // visibility_modifier, use_wildcard, bare crate/self/super
            }
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                collect(self, c, "", &mut paths);
            }
        }
        let imports_kind = edge_kind_index("imports").unwrap();
        for (text, n) in paths {
            let leaf = text.rsplit("::").next().unwrap_or("");
            if leaf.is_empty() || matches!(leaf, "self" | "super" | "crate" | "*") {
                continue;
            }
            self.push_ref_at(from_row, &text, imports_kind, n);
        }
    }

    /// extractCall — the rust paths of the generic else-branch (4312+).
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "field_expression" {
                let property = func
                    .child_by_field_name("property")
                    .or_else(|| func.child_by_field_name("field"))
                    .or_else(|| func.named_child(1));
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver = func
                        .child_by_field_name("object")
                        .or_else(|| func.child_by_field_name("operand"))
                        .or_else(|| func.child_by_field_name("argument"))
                        .or_else(|| func.named_child(0));
                    if let Some(r) = receiver {
                        if is_literal_receiver(r.kind()) {
                            return; // emit NOTHING (#1230)
                        }
                    }
                    if let Some(r) = receiver {
                        match r.kind() {
                            // rust `self` is node kind `self`, NOT `identifier` —
                            // it dodges this branch and falls to the bare-name
                            // fallthrough (same net effect as SKIP_RECEIVERS).
                            "identifier" | "simple_identifier" | "field_identifier" => {
                                let receiver_name = self.text(r);
                                if !matches!(receiver_name, "self" | "this" | "cls" | "super") {
                                    callee_name = format!("{receiver_name}.{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            "call_expression" => {
                                // Chained-call re-encode: ONLY an associated-
                                // function chain (`Foo::new().bar()`, inner
                                // callee a scoped_identifier). Instance chains
                                // keep the bare method name.
                                let inner_fn = r.child_by_field_name("function");
                                let reencode =
                                    inner_fn.map(|f| f.kind() == "scoped_identifier").unwrap_or(false);
                                if reencode {
                                    let inner: String = self
                                        .text(inner_fn.unwrap())
                                        .replace("->", ".")
                                        .chars()
                                        .filter(|c| !c.is_whitespace())
                                        .collect();
                                    callee_name = format!("{inner}().{method_name}");
                                } else {
                                    callee_name = method_name.to_string();
                                }
                            }
                            _ => {
                                // field_expression 2-hop, parenthesized,
                                // await_expression, `self` — bare method name.
                                callee_name = method_name.to_string();
                            }
                        }
                    } else {
                        callee_name = method_name.to_string();
                    }
                }
            } else if matches!(func.kind(), "scoped_identifier" | "scoped_call_expression") {
                callee_name = self.text(func).to_string();
            } else {
                // identifier; generic_function keeps the raw turbofish text
                // (`helper::<T>` — unresolvable downstream, preserved).
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            // Parenthesized-callee normalization — `(f)(x)` → `f`.
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
            let from = self.top_row();
            self.push_ref_at(from, &callee_name.clone(), edge_kind_index("calls").unwrap(), node);
        }
    }

    /// extractInstantiation — struct_expression via the GENERIC path: strip
    /// from the first `<`, keep the trailing `::`/`.` segment (JS slice
    /// semantics: slice(lastDot+1) after a `::` leaves one `:`, then ONE
    /// leading `[:.]` is stripped).
    fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let ctor = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let Some(ctor) = ctor else { return };

        let mut class_name = self.text(ctor).to_string();
        if let Some(lt) = class_name.find('<') {
            if lt > 0 {
                class_name.truncate(lt);
            }
        }
        let last_dot = class_name.rfind('.').map(|i| i as i64).unwrap_or(-1);
        let last_colon = class_name.rfind("::").map(|i| i as i64).unwrap_or(-1);
        let last = last_dot.max(last_colon);
        if last >= 0 {
            class_name = class_name[(last + 1) as usize..].to_string();
            if let Some(rest) = class_name.strip_prefix(&[':', '.'][..]) {
                class_name = rest.to_string();
            }
        }
        let class_name = class_name.trim().to_string();

        if !class_name.is_empty() {
            let from = self.top_row();
            self.push_ref_at(from, &class_name, edge_kind_index("instantiates").unwrap(), node);
        }
    }

    /// extractRustRouteMacro — body-walker-only; bare `routes`/`catchers`
    /// identifiers only (`rocket::routes![…]` is skipped); identifier runs in
    /// the token tree join with `::`, flushed on `,` and at end.
    fn extract_rust_route_macro(&mut self, node: Node<'t>) {
        let Some(macro_name) = node.named_child(0) else { return };
        let name = self.text(macro_name);
        if name != "routes" && name != "catchers" {
            return;
        }
        let token_tree = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "token_tree");
        let Some(token_tree) = token_tree else { return };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        let refs_kind = edge_kind_index("references").unwrap();

        let mut parts: Vec<&str> = Vec::new();
        let mut line = 0u32;
        let mut column_byte = 0usize;
        let mut row = 0usize;
        macro_rules! flush {
            () => {
                if !parts.is_empty() {
                    let joined = parts.join("::");
                    let column = util::col16(self.src, &self.line_starts, row, column_byte);
                    let name_ref = self.arena.put(&joined);
                    self.tables.push_ref(&RefRow {
                        from_idx: from,
                        kind: refs_kind,
                        line,
                        column,
                        reference_name: name_ref,
                        candidates: NONE_STR,
                        from_id_str: NONE_STR,
                    });
                    parts.clear();
                }
            };
        }
        for i in 0..token_tree.child_count() {
            let Some(t) = token_tree.child(i) else { continue };
            if t.kind() == "identifier" {
                if parts.is_empty() {
                    line = t.start_position().row as u32 + 1;
                    column_byte = t.start_byte();
                    row = t.start_position().row;
                }
                parts.push(self.text(t));
            } else if t.kind() == "," {
                flush!();
            }
        }
        flush!();
    }

    /// extractInheritance — the rust-reachable cases: trait_bounds
    /// (supertraits; a scoped `fmt::Debug` bound matches NO case and is
    /// dropped), the Go embedding check on field_declaration (inert in rust —
    /// every field has a field_identifier), and the field_declaration_list
    /// recursion that reaches it.
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            match child.kind() {
                "trait_bounds" => {
                    for j in 0..child.named_child_count() {
                        let Some(bound) = child.named_child(j) else { continue };
                        let type_node: Option<Node> = match bound.kind() {
                            "type_identifier" => Some(bound),
                            "generic_type" => (0..bound.named_child_count())
                                .filter_map(|k| bound.named_child(k))
                                .find(|c| c.kind() == "type_identifier"),
                            "higher_ranked_trait_bound" => {
                                let generic = (0..bound.named_child_count())
                                    .filter_map(|k| bound.named_child(k))
                                    .find(|c| c.kind() == "generic_type");
                                generic
                                    .and_then(|g| {
                                        (0..g.named_child_count())
                                            .filter_map(|k| g.named_child(k))
                                            .find(|c| c.kind() == "type_identifier")
                                    })
                                    .or_else(|| {
                                        (0..bound.named_child_count())
                                            .filter_map(|k| bound.named_child(k))
                                            .find(|c| c.kind() == "type_identifier")
                                    })
                            }
                            _ => None, // scoped_type_identifier: dropped (quirk)
                        };
                        if let Some(tn) = type_node {
                            let name = self.text(tn).to_string();
                            self.push_ref_at(class_row, &name, extends_kind, tn);
                        }
                    }
                }
                "field_declaration" => {
                    let has_field_identifier = (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .any(|c| c.kind() == "field_identifier");
                    if !has_field_identifier {
                        let type_id = (0..child.named_child_count())
                            .filter_map(|j| child.named_child(j))
                            .find(|c| c.kind() == "type_identifier");
                        if let Some(type_id) = type_id {
                            let name = self.text(type_id).to_string();
                            self.push_ref_at(class_row, &name, extends_kind, type_id);
                        }
                    }
                }
                "field_declaration_list" | "class_heritage" => {
                    self.extract_inheritance(child, class_row);
                }
                _ => {}
            }
        }
    }

    /// extractRustImplItem — `impl Trait for Type` back-reference: positional
    /// type-node filter (NEVER the grammar's trait:/type: fields), ≥2 needed,
    /// target found by FIRST earlier node of kind struct/enum/class (never
    /// trait); ref FROM the type's node, named by the trait's full text.
    fn extract_rust_impl_item(&mut self, node: Node<'t>) {
        let has_for = (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "for" && !c.is_named());
        if !has_for {
            return;
        }
        let type_idents: Vec<Node> = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .filter(|c| matches!(c.kind(), "type_identifier" | "generic_type" | "scoped_type_identifier"))
            .collect();
        if type_idents.len() < 2 {
            return;
        }
        let trait_node = type_idents[0];
        let type_node = type_idents[type_idents.len() - 1];

        let trait_name = self.text(trait_node).to_string();
        let type_name = if type_node.kind() == "generic_type" {
            (0..type_node.named_child_count())
                .filter_map(|i| type_node.named_child(i))
                .find(|c| c.kind() == "type_identifier")
                .map(|c| self.text(c).to_string())
                .unwrap_or_else(|| self.text(type_node).to_string())
        } else {
            self.text(type_node).to_string()
        };

        let target_row = self
            .nodes_meta
            .iter()
            .position(|m| m.name == type_name && matches!(m.kind, "struct" | "enum" | "class"))
            .map(|i| i as u32);
        if let Some(target_row) = target_row {
            self.push_ref_at(target_row, &trait_name, edge_kind_index("implements").unwrap(), trait_node);
        }
    }

    /// extractTypeAnnotations — parameters + return_type subtrees, one
    /// `references` ref per type_identifier leaf not in BUILTIN_TYPES. The
    /// trailing `type_annotation` child lookup is included for fidelity (the
    /// rust grammar has no such node — always a no-op).
    fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("return_type") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let type_annotation = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = type_annotation {
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

    // --- visitFunctionBody -----------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        // Rocket route macros: handler paths live in a raw token tree.
        if kind == "macro_invocation" {
            self.extract_rust_route_macro(node);
        }

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "struct_expression" {
            self.extract_instantiation(node);
        }

        // Nested NAMED fns become their own nodes (a nested fn inside an impl
        // method walks up to the impl and indexes as a METHOD).
        if matches!(kind, "function_item" | "function_signature_item") {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_fn_or_method(node);
                return;
            }
        }

        // Structural nodes inside bodies.
        if kind == "struct_item" {
            self.extract_struct(node);
            return;
        }
        if kind == "enum_item" {
            self.extract_enum(node);
            return;
        }
        if kind == "trait_item" {
            self.extract_interface(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- fn refs (RUST_SPEC) ----------------------------------------------------

    /// maybeCaptureFnRefs with RUST_SPEC's dispatch: arguments→args,
    /// assignment_expression→rhs(right), field_initializer→value(value),
    /// array_expression→list, static_item/let_declaration→varinit(value).
    /// No layers/unwrap/special — only bare identifiers qualify (`&handler`
    /// captures nothing). QUIRK: const_item is NOT in the dispatch.
    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
            Value,
            List,
            Varinit,
        }
        let mode = match node.kind() {
            "arguments" => Mode::Args,
            "assignment_expression" => Mode::Rhs,
            "field_initializer" => Mode::Value,
            "array_expression" => Mode::List,
            "static_item" | "let_declaration" => Mode::Varinit,
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
                if let Some(rhs) = node.child_by_field_name("right") {
                    // Param-storage skip: `o.cb = cb`.
                    let lhs_text = node
                        .child_by_field_name("left")
                        .map(|l| self.text(l))
                        .unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    if !(lhs_last.is_some() && lhs_last == Some(self.text(rhs).trim())) {
                        values.push(rhs);
                    }
                }
            }
            Mode::Value => {
                let v = node.child_by_field_name("value").or_else(|| {
                    if node.named_child_count() > 0 {
                        node.named_child(node.named_child_count() - 1)
                    } else {
                        None
                    }
                });
                if let Some(v) = v {
                    values.push(v);
                }
            }
            Mode::Varinit => {
                // Destructuring skip: a tuple/struct pattern LHS extracts data,
                // never a function alias (static_item's name is an identifier,
                // let_declaration's `pattern` field can be a pattern).
                let name_node = node
                    .child_by_field_name("name")
                    .or_else(|| node.child_by_field_name("pattern"));
                if let Some(nn) = name_node {
                    if matches!(
                        nn.kind(),
                        "object_pattern" | "array_pattern" | "tuple_pattern" | "struct_pattern"
                    ) {
                        return;
                    }
                }
                if let Some(v) = node.child_by_field_name("value") {
                    values.push(v);
                }
            }
        }

        for v in values {
            // normalizeValue: idTypes = {identifier} only, no layers/unwrap.
            if v.kind() == "identifier" {
                let name = self.text(v).to_string();
                if name.is_empty() || is_stoplisted(&name) {
                    continue;
                }
                let p = v.start_position();
                self.fn_ref_cands.push(Cand {
                    from,
                    name,
                    line: p.row as u32 + 1,
                    column_byte: v.start_byte(),
                    row: p.row,
                });
            }
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        if depth > 0
            && matches!(
                node.kind(),
                "function_item" | "function_signature_item" | "arrow_function"
                    | "function_expression" | "lambda_literal" | "lambda_expression"
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

    // --- value refs -------------------------------------------------------------

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

        // Shadow prune — rust declarator shapes: const_item/static_item (name
        // field) and let_declaration (the shadow source: `pattern` field; a
        // tuple pattern bumps every named child).
        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut bump = |decl_counts: &mut HashMap<&'t str, u32>, name_node: Option<Node<'t>>, src: &'t str, targets: &HashMap<String, u32>| {
            if let Some(n) = name_node {
                if matches!(n.kind(), "identifier" | "simple_identifier") {
                    let nm = &src[n.byte_range()];
                    if targets.contains_key(nm) {
                        *decl_counts.entry(nm).or_insert(0) += 1;
                    }
                }
            }
        };
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            match n.kind() {
                "const_item" | "static_item" => {
                    bump(&mut decl_counts, n.child_by_field_name("name"), self.src, &targets)
                }
                "let_declaration" => {
                    let left = n
                        .child_by_field_name("left")
                        .or_else(|| n.child_by_field_name("pattern"))
                        .or_else(|| n.named_child(0));
                    if let Some(left) = left {
                        if left.kind() == "identifier" {
                            bump(&mut decl_counts, Some(left), self.src, &targets);
                        } else {
                            for i in 0..left.named_child_count() {
                                bump(&mut decl_counts, left.named_child(i), self.src, &targets);
                            }
                        }
                    }
                }
                _ => {}
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

fn is_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}

/// LITERAL_RECEIVER_TYPES (shared table).
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

/// BUILTIN_TYPES (shared table — port the WHOLE set: a rust `String`
/// type_identifier IS suppressed via the Scala row).
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

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
