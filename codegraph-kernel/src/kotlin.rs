//! Kotlin extraction — a faithful Rust port of `TreeSitterExtractor`'s Kotlin
//! paths (src/extraction/tree-sitter.ts) plus languages/kotlin.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The authoritative quirk list is docs/design/kotlin-kernel-port-checklist.md.
//! Two surfaces are FIRSTS for the kernel: extension-function receivers
//! (getReceiverType → `Type::method` qualified-name OVERRIDE with no package
//! prefix + the owner-contains fallback that excludes `interface` kinds and
//! is source-order dependent) and extractModifiers (expect/actual platform
//! modifiers → the node DECORATORS wire field, on every created node — the
//! KMP synthesizer's input). Preserved on purpose: the FIELD_COUNT-0 dead
//! cluster (no signatures, ZERO type-annotation refs), hook-consumed property
//! initializers emitting nothing, the bodiless-class header re-walk asymmetry,
//! enum-entry bodies being invisible, KDoc (`multiline_comment`) never being
//! a docstring AND chain-breaking, comment-gluing into import/package extents,
//! `@Anno(args)` emitting nothing while `@Anno` emits decorates, zero
//! instantiates refs (constructors are capitalized `calls`), the qualified-
//! receiver `com::qext` bug, the paren-then-lambda `trailing()` garbage
//! callee, and the packaged-file value-ref target drop (namespace parents are
//! not accepted). The fun-interface misparse-recovery hook branches are
//! DEFER-SHIELDED (every such file has_error → wasm) and are not ported.
//! Positions in UTF-16 code units. Expected deferral 4.7–8.5% (both-arm,
//! grammar-inherent — incl. phantom errors: trust the has_error FLAG).

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE,
    NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts:373) — full shared set.
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

/// `/^[A-Za-z_]\w*$/` with JS's ASCII `\w` (getReturnType's ident test).
fn ascii_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}
/// extractStaticMemberRef's capitalized-receiver test.
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}

/// JS `\s` for the #750 inner-callee strip.
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

/// Per-node metadata for the extension-fn owner-contains lookup.
struct NodeMeta {
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
    return_type: Option<String>,
    /// composeReceiverQualifiedName override (extension methods) — the id
    /// still hashes the bare NAME; only the qualifiedName column changes.
    qualified_override: Option<String>,
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

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    node_ids: Vec<String>,
    nodes_meta: Vec<NodeMeta>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("kotlin").ok_or("no kotlin grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(kotlin) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    if tree.root_node().has_error() {
        // Includes the PHANTOM errors (complete CSTs with hasError set) and
        // every fun-interface misparse — trust the flag, wasm is canonical.
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
        nodes_meta: Vec::new(),
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
    w.nodes_meta.push(NodeMeta { kind: "file", name: base_name.to_string() });
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    // extractFilePackage: the FIRST package_header among root's direct named
    // children → namespace node (comment-glued extents included), pushed for
    // the whole walk.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for i in 0..root.named_child_count() {
        let Some(child) = root.named_child(i) else { continue };
        if child.kind() != "package_header" {
            continue;
        }
        let id_node = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .find(|c| c.kind() == "identifier");
        if let Some(id_node) = id_node {
            let pkg = w.text(id_node).trim().to_string();
            if !pkg.is_empty() {
                if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
                    w.stack.push(Scope { row, kind: "namespace", name: pkg });
                    pkg_pushed = true;
                }
            }
        }
        break;
    }

    w.visit_node(root);
    w.flush_fn_ref_candidates();
    w.flush_value_refs(root);
    if pkg_pushed {
        w.stack.pop();
    }
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

    /// resolveBody (kotlin.ts:219): first ERROR child whose child(0) is `{`
    /// (fun-interface parent body — unreachable post-defer, kept for
    /// contract), else first function_body | class_body | enum_class_body.
    fn resolve_body(&self, node: Node<'t>) -> Option<Node<'t>> {
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "ERROR" {
                if let Some(first) = child.child(0) {
                    if first.kind() == "{" {
                        return Some(child);
                    }
                }
            }
            if matches!(child.kind(), "function_body" | "class_body" | "enum_class_body") {
                return Some(child);
            }
        }
        None
    }

    // --- createNode ------------------------------------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);
        // endLine extension via resolveBody — LIVE for kotlin function/method
        // kinds (in-range for this grammar, so practically a no-op — but the
        // hook is part of the contract).
        let mut end_line = node.end_position().row as u32 + 1;
        if kind == "function" || kind == "method" {
            if let Some(body) = self.resolve_body(node) {
                let be = body.end_position().row as u32 + 1;
                if be > end_line {
                    end_line = be;
                }
            }
        }

        let qualified = match &extra.qualified_override {
            Some(qn) => qn.clone(),
            None => {
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
            }
        };

        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        // extractModifiers merge (tree-sitter.ts:1355) — runs for EVERY
        // created node: expect/actual platform modifiers → decorators.
        let mods = self.extract_modifiers(node);
        let dec_ref: StrRef = match &mods {
            Some(list) if !list.is_empty() => self.arena.put_list(list),
            _ => NONE_STR,
        };
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
            decorators: dec_ref,
            type_parameters: NONE_STR,
            return_type: ret_ref,
            extra_json: NONE_STR,
        });
        self.node_ids.push(id);
        self.nodes_meta.push(NodeMeta { kind, name: name.to_string() });

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
        // captureValueRefScope — namespace parents are NOT accepted, so
        // packaged files' top-level constants are never targets (quirk).
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

    // --- hooks (languages/kotlin.ts) ----------------------------------------------

    /// extractName — the zero-field grammar means the nameField lookup always
    /// misses; names come from the shared fallback scan (first direct
    /// identifier-family child; backtick names keep their backticks).
    fn extract_name(&self, node: Node) -> String {
        if let Some(name_node) = node.child_by_field_name("simple_identifier") {
            // nameField is a TYPE name used as a FIELD name — never resolves
            // (mirrored for shape; the grammar has zero fields).
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

    /// getVisibility: modifiers text includes public/private/protected/
    /// internal in that order; default PUBLIC. Text-includes semantics —
    /// annotation text inside modifiers can flip it (bug-for-bug).
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
                if text.contains("protected") {
                    return 3;
                }
                if text.contains("internal") {
                    return 4;
                }
            }
        }
        1 // Kotlin defaults to public
    }

    /// isAsync: modifiers text includes 'suspend' (text-includes false
    /// positive on `@suspendMarker` annotations — preserve).
    fn is_async(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "modifiers" && self.text(c).contains("suspend"))
    }

    /// extractKotlinReturnType — positional: the first user_type/nullable_type
    /// AFTER function_value_parameters; function_body/type_constraints first →
    /// None; Unit/Nothing → None; `: T` generic params leak (preserve).
    fn return_type_of(&self, node: Node) -> Option<String> {
        let mut seen_params = false;
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "function_value_parameters" {
                seen_params = true;
                continue;
            }
            if !seen_params {
                continue;
            }
            if matches!(child.kind(), "function_body" | "type_constraints") {
                return None;
            }
            if matches!(child.kind(), "user_type" | "nullable_type") {
                let ut = if child.kind() == "nullable_type" {
                    (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .find(|c| c.kind() == "user_type")
                        .unwrap_or(child)
                } else {
                    child
                };
                let type_id = (0..ut.named_child_count())
                    .filter_map(|j| ut.named_child(j))
                    .find(|c| c.kind() == "type_identifier");
                let name = self.text(type_id.unwrap_or(ut)).trim();
                if name.is_empty() || !ascii_ident_re().is_match(name) {
                    return None;
                }
                if matches!(name, "Unit" | "Nothing") {
                    return None;
                }
                return Some(name.to_string());
            }
        }
        None
    }

    /// getReceiverType — extension functions: the last user_type BEFORE a `.`
    /// child; its FIRST type_identifier's text (qualified receivers take the
    /// FIRST segment — the `com::qext` bug, preserve).
    fn receiver_type_of(&self, node: Node<'t>) -> Option<String> {
        let mut found_user_type: Option<Node> = None;
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            match child.kind() {
                "user_type" => found_user_type = Some(child),
                "." => {
                    if let Some(ut) = found_user_type {
                        let type_id = (0..ut.named_child_count())
                            .filter_map(|j| ut.named_child(j))
                            .find(|c| c.kind() == "type_identifier");
                        return Some(self.text(type_id.unwrap_or(ut)).to_string());
                    }
                }
                "simple_identifier" | "function_value_parameters" => break,
                _ => {}
            }
        }
        None
    }

    /// extractModifiers — expect/actual platform modifiers, matched by NODE
    /// TYPE (never text), in order. Runs inside create_node for every node.
    fn extract_modifiers(&self, node: Node) -> Option<Vec<String>> {
        let mut mods: Vec<String> = Vec::new();
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() != "modifiers" {
                continue;
            }
            for j in 0..child.child_count() {
                let Some(pm) = child.child(j) else { continue };
                if pm.kind() != "platform_modifier" {
                    continue;
                }
                for k in 0..pm.child_count() {
                    let Some(kw) = pm.child(k) else { continue };
                    if matches!(kw.kind(), "expect" | "actual") {
                        mods.push(kw.kind().to_string());
                    }
                }
            }
        }
        if mods.is_empty() { None } else { Some(mods) }
    }

    // --- the visitNode hook (property branch ONLY — fun-interface recovery is
    // defer-shielded and not ported) ------------------------------------------------

    fn try_visit_hook(&mut self, node: Node<'t>) -> bool {
        if node.kind() != "property_declaration" {
            return false;
        }
        let var_decl = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "variable_declaration");
        let name_node = var_decl.and_then(|vd| {
            (0..vd.named_child_count())
                .filter_map(|i| vd.named_child(i))
                .find(|c| c.kind() == "simple_identifier")
        });
        let Some(name_node) = name_node else { return false }; // destructuring → decline
        let name = self.text(name_node).to_string();
        if name.is_empty() {
            return false;
        }

        // Scope walk up the parent chain — first match wins.
        let mut scope: &str = "const";
        let mut p = node.parent();
        while let Some(pn) = p {
            match pn.kind() {
                "function_body" | "function_declaration" | "lambda_literal"
                | "anonymous_initializer" | "control_structure_body" | "getter" | "setter" => {
                    scope = "local";
                    break;
                }
                "companion_object" | "object_declaration" => {
                    scope = "const";
                    break;
                }
                "class_declaration" => {
                    scope = "instance";
                    break;
                }
                _ => {}
            }
            p = pn.parent();
        }
        if scope == "local" {
            return true; // a local — extract nothing, subtree still scanned
        }

        let binding = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "binding_pattern_kind");
        let is_val = binding.map(|b| self.text(b) == "val").unwrap_or(false);
        let kind: &'static str = if scope == "instance" {
            "field"
        } else if is_val {
            "constant"
        } else {
            "variable"
        };
        // The `type`-field signature read is dead (zero fields) → signature
        // undefined; NO docstring/visibility/isStatic — the modifiers merge in
        // create_node still decorates expect/actual properties.
        self.create_node(kind, &name, node, Extra::default());
        true
    }

    // --- the dispatcher (visitNode, Kotlin-relevant branches) -----------------------

    fn visit_node(&mut self, node: Node<'t>) {
        if self.try_visit_hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

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
            // classifyClassNode: `interface`/`enum` keyword children.
            let mut classified = "class";
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "interface" {
                        classified = "interface";
                        break;
                    }
                    if c.kind() == "enum" {
                        classified = "enum";
                        break;
                    }
                }
            }
            match classified {
                "interface" => self.extract_interface(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            skip_children = true;
        } else if kind == "object_declaration" {
            // extraClassNodeTypes → extractClass → kind `class`.
            self.extract_class(node);
            skip_children = true;
        } else if kind == "type_alias" {
            skip_children = self.extract_type_alias(node);
        } else if kind == "property_declaration" {
            // Hook-declined destructuring: extractField/extractVariable both
            // find no matching children for kotlin — NOTHING minted, RHS
            // invisible; candidates-only scan.
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_header" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        }
        // companion_object, anonymous_initializer, secondary_constructor,
        // getter/setter siblings, file_annotation, object_literal, if/when at
        // top level: no branch — recursed (calls attribute to the stack top).

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- visitFunctionBody ----------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        }
        // (INSTANTIATION_KINDS has no kotlin members; extractBareCall absent.)

        self.extract_static_member_ref(node);

        if kind == "function_declaration" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                // extractFunction diverts receiver-bearing nested fns to
                // extractMethod itself.
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            let mut classified = "class";
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "interface" {
                        classified = "interface";
                        break;
                    }
                    if c.kind() == "enum" {
                        classified = "enum";
                        break;
                    }
                }
            }
            match classified {
                "interface" => self.extract_interface(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            return;
        }
        // object_declaration is NOT dispatched here — a body-local object's
        // `fun`s hit the function branch above and leak out as FUNCTIONS
        // under the enclosing fn; its properties mint nothing (quirk).

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- extractors ------------------------------------------------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        // getReceiverType short-circuit (1522) — extension fns at any scope.
        if self.receiver_type_of(node).is_some() {
            self.extract_method(node);
            return;
        }
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = self.resolve_body(node) {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None, // dead hook (zero fields)
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(false), // kotlin isStatic is always false
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        // extractTypeAnnotations: the generic path's field lookups all miss
        // (zero fields) — kotlin emits ZERO type-annotation refs.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = self.resolve_body(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        let receiver = self.receiver_type_of(node);
        let name = self.extract_name(node);
        let qualified_override = receiver.as_ref().map(|r| format!("{r}::{name}"));
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(false),
            return_type: self.return_type_of(node),
            qualified_override,
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };
        // Owner-contains fallback (1799): receiver present, not class-like →
        // the FIRST same-file node named like the receiver with kind ∈
        // {struct, class, enum, trait} (interface EXCLUDED; source-order
        // dependent — both quirks preserved). Additive to the normal edge.
        if let Some(recv) = &receiver {
            if !self.inside_class_like() {
                let owner = self
                    .nodes_meta
                    .iter()
                    .position(|m| {
                        m.name == *recv && matches!(m.kind, "struct" | "class" | "enum" | "trait")
                    })
                    .map(|i| i as u32);
                if let Some(owner_row) = owner {
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
        // Type annotations: dead. Decorators: live.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = self.resolve_body(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_class(&mut self, node: Node<'t>) {
        let resolved_body = self.resolve_body(node);
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        // primaryCtor refs: csharp-gated no-op.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "class", name });
        // Bodied: ONLY class_body children (primary-ctor properties/defaults
        // invisible). Bodiless: the class node itself → header children
        // visited → ctor default-value + super-arg calls attribute to the
        // CLASS (the asymmetry, pinned).
        let body = resolved_body.unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default() // NO visibility
        };
        let Some(row) = self.create_node("interface", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "interface", name });
        let body = self.resolve_body(node).unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = self.resolve_body(node) else { return };
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
        // name field → null (zero fields) → the identifier-children scan: one
        // enum_member per direct simple_identifier, positioned AT the
        // identifier. Entry value_arguments and entry class_bodies (override
        // methods!) are never visited — invisible (quirk).
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if matches!(child.kind(), "simple_identifier" | "identifier" | "property_identifier") {
                let name = self.text(child).to_string();
                self.create_node("enum_member", &name, child, Extra::default());
            }
        }
    }

    /// extractTypeAlias — plain node; the alias-value ref walk reads the
    /// `value` FIELD → null (zero fields) → NO refs. Returns false →
    /// children re-visited (harmless).
    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
        };
        self.create_node("type_alias", &name, node, extra);
        false
    }

    fn extract_import(&mut self, node: Node<'t>) {
        // Comment-gluing: the header's extent (and thus the signature) can
        // include trailing comment lines — the trimmed FULL text is the
        // signature; the ref stays at the header start.
        let import_text = self.text(node).trim().to_string();
        let identifier = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "identifier");
        let Some(identifier) = identifier else { return };
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

    /// extractCall — the kotlin paths: navigation member branch (+ the #750
    /// re-encode) and the raw-text else (paren-then-lambda / glued-invoke
    /// garbage preserved).
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
                        return; // `"literal".uppercase()` / `5.toString()`
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
                    // #750 kotlin re-encode: innerNav = receiver.namedChild(0)
                    // (NOT a function field), ws-stripped, /^[A-Z]/ gate.
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
                    // this_expression / super_expression / 2-hop nav /
                    // postfix `!!` / parenthesized → bare method name.
                    callee_name = method_name.to_string();
                }
            }
        } else {
            // Raw func text: bare `helper`, constructor `WidgetK` (NO
            // instantiates ever), backticked names verbatim, the
            // paren-then-lambda `trailing()` and glued-invoke chains
            // byte-for-byte.
            callee_name = self.text(func).to_string();
        }

        if !callee_name.is_empty() {
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
            self.push_ref_at(caller, &callee_name.clone(), edge_kind_index("calls").unwrap(), node);
        }
    }

    /// extractStaticMemberRef — navigation_expression value reads, body
    /// walker only (assignment WRITES parse as directly_assignable_expression
    /// — not a member-access kind — and emit nothing).
    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "navigation_expression" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
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

    /// extractInheritance — delegation_specifier: user_type ?? its
    /// constructor_invocation's user_type → FIRST type_identifier → ONE
    /// `extends` ref at the typeId (interfaces ride extends too; qualified
    /// supertypes take the FIRST segment — `com`; `by`-delegation emits
    /// NOTHING).
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "delegation_specifier" {
                continue;
            }
            let user_type = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "user_type");
            let ctor_inv = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "constructor_invocation");
            let target = user_type.or(ctor_inv);
            let Some(target) = target else { continue };
            let type_id: Node = if target.kind() == "user_type" {
                (0..target.named_child_count())
                    .filter_map(|j| target.named_child(j))
                    .find(|c| c.kind() == "type_identifier")
                    .unwrap_or(target)
            } else {
                // constructor_invocation → its user_type → first type_identifier
                let ut = (0..target.named_child_count())
                    .filter_map(|j| target.named_child(j))
                    .find(|c| c.kind() == "user_type");
                match ut {
                    Some(ut) => (0..ut.named_child_count())
                        .filter_map(|j| ut.named_child(j))
                        .find(|c| c.kind() == "type_identifier")
                        .unwrap_or(ut),
                    None => target,
                }
            };
            let name = self.text(type_id).to_string();
            self.push_ref_at(class_row, &name, extends_kind, type_id);
        }
    }

    /// extractDecoratorsFor — kotlin annotations inside `modifiers`:
    /// `@Marker` (user_type child) → decorates ref; `@Anno(args)`
    /// (constructor_invocation) → NOTHING. Runs for functions/methods/classes
    /// only (hook properties never call it).
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

    // --- function-as-value refs (KOTLIN_SPEC, function-ref.ts:240) ------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
        }
        let mode = match node.kind() {
            "value_arguments" => Mode::Args,
            "assignment" => Mode::Rhs, // NO field — RHS = LAST named child
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        values.push(c);
                    }
                }
            }
            Mode::Rhs => {
                let rhs = if node.named_child_count() > 0 {
                    node.named_child(node.named_child_count() - 1)
                } else {
                    None
                };
                if let Some(rhs) = rhs {
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
            // value_argument layer with NO field resolution (zero fields) —
            // the label-forward skip is DEAD for kotlin; fan out namedChildren.
            "value_argument" => {
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            // `::topLevel` / `OtherClass::handle` — receiver = LAST
            // type_identifier child, member = LAST simple_identifier child;
            // `String::class` has no member (anon keyword) → nothing;
            // lowercase receivers dropped by the CASE regex, not node type.
            "callable_reference" => {
                let mut receiver: Option<Node> = None;
                let mut member: Option<Node> = None;
                for i in 0..v.named_child_count() {
                    let Some(child) = v.named_child(i) else { continue };
                    if child.kind() == "type_identifier" {
                        receiver = Some(child);
                    }
                    if child.kind() == "simple_identifier" {
                        member = Some(child);
                    }
                }
                let Some(member) = member else { return };
                let m = self.text(member);
                match receiver {
                    None => self.push_fn_ref_cand(from, m, member),
                    Some(recv) => {
                        let recv_text = self.text(recv);
                        if recv_text.as_bytes().first().map(|b| b.is_ascii_uppercase()).unwrap_or(false) {
                            let name = format!("{recv_text}::{m}");
                            self.push_fn_ref_cand(from, &name, member);
                        }
                    }
                }
            }
            // `this::caller` → this.<member> (class-scoped, always flushes).
            "navigation_expression" => {
                if !self.text(v).starts_with("this::") {
                    return;
                }
                for i in 0..v.named_child_count() {
                    let Some(child) = v.named_child(i) else { continue };
                    if child.kind() == "navigation_suffix" && self.text(child).starts_with("::") {
                        if child.named_child_count() > 0 {
                            if let Some(id) = child.named_child(child.named_child_count() - 1) {
                                let name = format!("this.{}", self.text(id));
                                self.push_fn_ref_cand(from, &name, id);
                            }
                        }
                        return;
                    }
                }
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
        // lambda_literal halts (no captures inside `by lazy { }` under a
        // hook-consumed property).
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

    // --- value references --------------------------------------------------------------

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

        // Shadow prune — kotlin cases: property_declaration (its
        // variable_declaration's first simple_identifier; destructuring bumps
        // nothing) AND the shared `assignment` case (the swift-sweep lesson —
        // directly_assignable_expression children bump).
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
                    .find(|c| c.kind() == "variable_declaration");
                if let Some(vd) = vd {
                    let id = (0..vd.named_child_count())
                        .filter_map(|i| vd.named_child(i))
                        .find(|c| c.kind() == "simple_identifier");
                    if let Some(id) = id {
                        let nm = self.text(id);
                        if targets.contains_key(nm) {
                            *decl_counts.entry(nm).or_insert(0) += 1;
                        }
                    }
                }
                // (the Swift name-field half of the shared case is a null
                // path for kotlin — variable_declaration always present)
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
                // simple_identifier is kotlin's live reader kind —
                // `${TARGET}` interpolations read, `$TARGET`
                // (interpolated_identifier) doesn't.
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

/// The shared decorator-name normalization.
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
