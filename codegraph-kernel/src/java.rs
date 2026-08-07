//! Java extraction — a faithful Rust port of `TreeSitterExtractor`'s Java
//! paths (src/extraction/tree-sitter.ts) plus languages/java.ts, including
//! the Lombok member synthesizer (#912).
//!
//! Same porting contract as tsjs/: behavior parity with the wasm path,
//! bug-for-bug, verified by scripts/kernel-parity.mjs and the full-index
//! dump-diff gate. Positions in UTF-16 code units. Files whose parse tree
//! contains ERRORS defer to the wasm extractor (encoding-dependent recovery —
//! see tsjs/mod.rs).

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_STATIC, FUNCTION_REF_CODE, NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

fn is_method_type(kind: &str) -> bool {
    matches!(kind, "method_declaration" | "constructor_declaration")
}
fn is_interface_type(kind: &str) -> bool {
    matches!(kind, "interface_declaration" | "annotation_type_declaration")
}

/// JAVA_NON_CLASS_RETURN_NODES (languages/java.ts).
fn is_non_class_return(kind: &str) -> bool {
    matches!(kind, "void_type" | "integral_type" | "floating_point_type" | "boolean_type")
}

/// BUILTIN_TYPES (tree-sitter.ts) — shared table; only the Java-relevant names
/// fire here but membership is what the TS code tests.
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

/// LOMBOK_LOG_ANNOTATIONS (languages/java.ts).
fn is_lombok_log_annotation(name: &str) -> bool {
    matches!(
        name,
        "Slf4j" | "Log4j" | "Log4j2" | "Log" | "CommonsLog" | "JBossLog" | "Flogger" | "XSlf4j"
            | "CustomLog"
    )
}

fn generic_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
fn method_ref_type_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([A-Z][A-Za-z0-9_]*)\s*::").unwrap())
}
fn is_prefix_re(word: &str) -> bool {
    // /^is[A-Z]/ for Lombok boolean getters.
    word.len() > 2 && word.starts_with("is") && word.as_bytes()[2].is_ascii_uppercase()
}

struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

/// Per-node metadata kept for the Lombok synthesizer's taken-member scan
/// (mirrors its walk over ctx.nodes by qualifiedName).
struct NodeMeta {
    kind: &'static str,
    name: String,
    qualified_name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<u8>,
    is_static: Option<bool>,
    return_type: Option<String>,
    decorators: Option<Vec<String>>,
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
    nodes_meta: Vec<NodeMeta>,
    /// Node id string per row — ids COLLIDE for same-(kind, name, line) nodes
    /// and the TS side's fn-ref dedupe / value-ref self-checks key on the id.
    node_ids: Vec<String>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("java").ok_or("no java grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(java) failed: {e}"))?;
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

    // File node (TreeSitterExtractor.extract).
    let line_count = source.bytes().filter(|b| *b == b'\n').count() as u32 + 1;
    let base_name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    let mut flags = BoolFlags::default();
    flags.set(crate::buffers::FLAG_IS_EXPORTED, false);
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
    w.nodes_meta.push(NodeMeta {
        kind: "file",
        name: base_name.to_string(),
        qualified_name: file_path.to_string(),
    });
    w.node_ids.push(ids::file_node_id(file_path));
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    // extractFilePackage: wrap top-level declarations in a `namespace` node
    // carrying the package FQN.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for i in 0..root.named_child_count() {
        let Some(child) = root.named_child(i) else { continue };
        if child.kind() != "package_declaration" {
            continue;
        }
        let id_node = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .find(|c| matches!(c.kind(), "scoped_identifier" | "identifier"));
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

    // --- createNode ------------------------------------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);
        let end_line = node.end_position().row as u32 + 1; // no resolveBody for java

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
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let dec_ref: StrRef = match &extra.decorators {
            Some(list) if !list.is_empty() => self.arena.put_list(list),
            _ => NONE_STR,
        };
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
        self.nodes_meta.push(NodeMeta { kind, name: name.to_string(), qualified_name: qualified });
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
        self.capture_value_ref_scope(kind, name, row, node);
        Some(row)
    }

    fn capture_value_ref_scope(&mut self, kind: &'static str, name: &str, row: u32, node: Node<'t>) {
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
    }

    // --- modifiers / hooks (languages/java.ts) -----------------------------------

    fn modifiers_child(&self, node: Node<'t>) -> Option<Node<'t>> {
        (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "modifiers")
    }

    fn visibility_of(&self, node: Node) -> Option<u8> {
        for i in 0..node.child_count() {
            let child = node.child(i)?;
            if child.kind() == "modifiers" {
                let text = self.text(child);
                if text.contains("public") {
                    return Some(1);
                }
                if text.contains("private") {
                    return Some(2);
                }
                if text.contains("protected") {
                    return Some(3);
                }
            }
        }
        None
    }

    fn is_static(&self, node: Node) -> bool {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "modifiers" && self.text(child).contains("static") {
                    return true;
                }
            }
        }
        false
    }

    /// javaExtractor.isConst: `static final` field → constant.
    fn is_const(&self, node: Node) -> bool {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "modifiers" {
                    let text = self.text(child);
                    return word_re("static").is_match(text) && word_re("final").is_match(text);
                }
            }
        }
        false
    }

    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let params_text = self.text(params);
        match node.child_by_field_name("type") {
            Some(ret) => Some(format!("{} {}", self.text(ret), params_text)),
            None => Some(params_text.to_string()),
        }
    }

    /// normalizeJavaType (languages/java.ts).
    fn normalize_java_type(&self, type_node: Option<Node>) -> Option<String> {
        let t = type_node?;
        if is_non_class_return(t.kind()) || t.kind() == "array_type" {
            return None;
        }
        let raw = generic_args_re().replace_all(self.text(t).trim(), "").into_owned();
        let last = raw.rsplit('.').next().unwrap_or("").trim().to_string();
        if last.is_empty() || !simple_ident_re().is_match(&last) {
            return None;
        }
        Some(last)
    }

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

    // --- the dispatcher (visitNode, Java-relevant branches) -----------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "class_declaration" {
            self.extract_class(node);
            skip_children = true;
        } else if is_method_type(kind) {
            self.extract_method(node);
            skip_children = true;
        } else if is_interface_type(kind) {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "field_declaration" && self.inside_class_like() {
            self.extract_field(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "local_variable_declaration" && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_declaration" {
            self.extract_import(node);
        } else if kind == "method_invocation" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                skip_children = true;
            }
        }

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

        if kind == "method_invocation" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                return;
            }
        }

        // Static-member / value-read (`Type.CONST`) — self-gates on field_access.
        self.extract_static_member_ref(node);

        if kind == "class_declaration" {
            self.extract_class(node);
            return;
        }
        if kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if is_interface_type(kind) {
            self.extract_interface(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- extractors --------------------------------------------------------------

    fn extract_class(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: self.visibility_of(node),
            ..Extra::default() // java has no isExported hook
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope { row, kind: "class", name });
        let body = node.child_by_field_name("body").unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        // Lombok member synthesis (#912) — class still on the stack.
        self.synthesize_lombok_members(node, row);
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        if !self.inside_class_like() {
            // (object-literal parents don't exist in Java; a stray top-level
            // method extracts as a function, mirroring extractMethod's tail)
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_static: Some(self.is_static(node)),
            return_type: self.normalize_java_type(node.child_by_field_name("type")),
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

    /// extractFunction — only reachable for a method outside any class.
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
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_static: Some(self.is_static(node)),
            return_type: self.normalize_java_type(node.child_by_field_name("type")),
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

    fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            ..Extra::default()
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

    fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: self.visibility_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if child.kind() == "enum_constant" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
        // (identifier-children / leaf fallbacks are other grammars' shapes)
    }

    /// extractField — each declarator becomes a field/constant node.
    fn extract_field(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let is_static = Some(self.is_static(node));
        let field_kind: &'static str = if self.is_const(node) { "constant" } else { "field" };

        let declarators: Vec<Node> = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .filter(|c| c.kind() == "variable_declarator")
            .collect();

        if !declarators.is_empty() {
            let type_node = (0..node.named_child_count())
                .filter_map(|i| node.named_child(i))
                .find(|c| {
                    !matches!(
                        c.kind(),
                        "modifiers" | "modifier" | "variable_declarator" | "variable_declaration"
                            | "marker_annotation" | "annotation"
                    )
                });
            let type_text = type_node.map(|t| self.text(t).to_string());

            for decl in declarators {
                let name_node = decl.child_by_field_name("name").or_else(|| {
                    (0..decl.named_child_count())
                        .filter_map(|i| decl.named_child(i))
                        .find(|c| c.kind() == "identifier")
                });
                let Some(name_node) = name_node else { continue };
                let name = self.text(name_node).to_string();
                let signature = match &type_text {
                    Some(t) => format!("{t} {name}"),
                    None => name.clone(),
                };
                let row = self.create_node(
                    field_kind,
                    &name,
                    decl,
                    Extra {
                        docstring: docstring.clone(),
                        signature: Some(signature),
                        visibility,
                        is_static,
                        ..Extra::default()
                    },
                );
                if let Some(row) = row {
                    self.extract_decorators_for(node, row);
                    self.extract_type_annotations(node, row);
                }
            }
        } else {
            let name_node = node.child_by_field_name("name").or_else(|| {
                (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .find(|c| c.kind() == "identifier")
            });
            if let Some(name_node) = name_node {
                let name = self.text(name_node).to_string();
                self.create_node(
                    field_kind,
                    &name,
                    node,
                    Extra { docstring, visibility, is_static, ..Extra::default() },
                );
            }
        }
    }

    /// extractVariable's generic fallback (top-level locals — rare in Java).
    fn extract_variable(&mut self, node: Node<'t>) {
        let kind: &'static str = if self.is_const(node) { "constant" } else { "variable" };
        let docstring = preceding_docstring(node, self.src);
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            let name = match child.kind() {
                "identifier" => self.text(child).to_string(),
                "variable_declarator" => self.extract_name(child),
                _ => continue,
            };
            if name.is_empty() || name == "<anonymous>" {
                continue;
            }
            self.create_node(
                kind,
                &name,
                child,
                Extra { docstring: docstring.clone(), ..Extra::default() },
            );
        }
    }

    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let scoped = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "scoped_identifier");
        let Some(scoped) = scoped else { return }; // hook declined
        let module_name = self.text(scoped).to_string();
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

    /// extractCall — the Java method_invocation paths.
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let name_field = node.child_by_field_name("name");
        let object_field = node
            .child_by_field_name("object")
            .or_else(|| node.child_by_field_name("scope"));

        let mut callee_name = String::new();
        if let (Some(name_field), Some(object_field)) = (name_field, object_field) {
            let method_name = self.text(name_field);

            // Static-factory / fluent chain: `Foo.getInstance().bar()` →
            // `<inner-receiver>.<inner-method>().<method>` (#645/#608).
            if !method_name.is_empty() && object_field.kind() == "method_invocation" {
                let inner_obj = object_field.child_by_field_name("object");
                let inner_name = object_field.child_by_field_name("name");
                if let (Some(io), Some(inm)) = (inner_obj, inner_name) {
                    let callee = format!("{}.{}().{}", self.text(io), self.text(inm), method_name);
                    self.push_ref_at(caller, &callee, edge_kind_index("calls").unwrap(), node);
                    return;
                }
            }

            // `this.userbo.toLogin2()` — unwrap the field after `this.`.
            let receiver_name = if object_field.kind() == "field_access" {
                let inner = object_field.child_by_field_name("object");
                let fld = object_field.child_by_field_name("field");
                match (inner, fld) {
                    (Some(inner), Some(fld))
                        if matches!(inner.kind(), "this" | "this_expression") =>
                    {
                        self.text(fld).to_string()
                    }
                    _ => self.text(object_field).to_string(),
                }
            } else {
                self.text(object_field).to_string()
            };
            let receiver_name = receiver_name.strip_prefix('$').unwrap_or(&receiver_name);

            if !method_name.is_empty() {
                if matches!(receiver_name, "self" | "this" | "cls" | "super" | "parent" | "static") {
                    callee_name = method_name.to_string();
                } else {
                    callee_name = format!("{receiver_name}.{method_name}");
                }
            }
        } else {
            // Bare call `foo()` — the generic tail: function field ?? first child.
            let func = node
                .child_by_field_name("function")
                .or_else(|| node.named_child(0));
            if let Some(func) = func {
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
            self.push_ref_at(caller, &callee_name.clone(), edge_kind_index("calls").unwrap(), node);
        }
    }

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
        let class_name = strip_generic_and_qualifier(self.text(ctor));
        if !class_name.is_empty() {
            let from = self.top_row();
            self.push_ref_at(from, &class_name, edge_kind_index("instantiates").unwrap(), node);
        }
    }

    /// extractAnonymousClass — `new T() { ... }`.
    fn extract_anonymous_class(&mut self, node: Node<'t>, body: Node<'t>) {
        let type_node = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let mut type_name = type_node.map(|t| self.text(t).to_string()).unwrap_or_else(|| "Object".to_string());
        type_name = strip_generic_and_qualifier(&type_name);
        if type_name.is_empty() {
            type_name = "Object".to_string();
        }

        let anon_name = format!("<{type_name}$anon@{}>", node.start_position().row + 1);
        let Some(row) = self.create_node("class", &anon_name, node, Extra::default()) else {
            return;
        };
        // Bug-for-bug: the TS code uses `startPosition.row` (0-based) as the
        // LINE here — the one place it forgets the +1.
        let (line, column) = match type_node {
            Some(t) => (t.start_position().row as u32, self.col_of(t)),
            None => (node.start_position().row as u32, self.col_of(node)),
        };
        self.push_ref(row, &type_name, edge_kind_index("extends").unwrap(), line, column);

        self.stack.push(Scope { row, kind: "class", name: anon_name });
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    /// extractStaticMemberRef — `Type.CONST` value reads (java: field_access).
    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "field_access" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        // Skip `Type.method()` — the access is a call's callee, already linked.
        if let Some(parent) = node.parent() {
            if parent.kind() == "method_invocation" {
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

    /// extractInheritance — the Java clauses (type_list-aware).
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        let implements_kind = edge_kind_index("implements").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            match child.kind() {
                "superclass" | "extends_interfaces" => {
                    let type_list = (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .find(|c| c.kind() == "type_list");
                    let targets: Vec<Node> = match type_list {
                        Some(tl) => (0..tl.named_child_count()).filter_map(|j| tl.named_child(j)).collect(),
                        None => child.named_child(0).into_iter().collect(),
                    };
                    for target in targets {
                        let name = self.text(target).to_string();
                        self.push_ref_at(class_row, &name, extends_kind, target);
                    }
                }
                "super_interfaces" => {
                    let type_list = (0..child.named_child_count())
                        .filter_map(|j| child.named_child(j))
                        .find(|c| c.kind() == "type_list");
                    let targets: Vec<Node> = match type_list {
                        Some(tl) => (0..tl.named_child_count()).filter_map(|j| tl.named_child(j)).collect(),
                        None => (0..child.named_child_count()).filter_map(|j| child.named_child(j)).collect(),
                    };
                    for iface in targets {
                        let name = self.text(iface).to_string();
                        self.push_ref_at(class_row, &name, implements_kind, iface);
                    }
                }
                _ => {}
            }
        }
    }

    /// extractDecoratorsFor — Java annotations live inside `modifiers`.
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
        // Preceding-sibling scan (TS-style class decorators) — Java annotations
        // are inside modifiers, so this is inert here; kept for parity of shape.
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

    /// extractTypeAnnotations — Java's returnField is `type`.
    fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("type") {
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

    // --- function-as-value refs (JAVA_SPEC: method references only) ----------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let mode_field: Option<&str> = match node.kind() {
            "argument_list" => Some(""),          // args: every named child
            "assignment_expression" => Some("right"),
            "variable_declarator" => Some("value"),
            _ => None,
        };
        let Some(field) = mode_field else { return };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        if field.is_empty() {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    values.push(c);
                }
            }
        } else if field == "right" {
            if let Some(rhs) = node.child_by_field_name("right") {
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
        } else if let Some(v) = node.child_by_field_name("value") {
            // varinit — destructuring patterns don't exist in Java.
            values.push(v);
        }

        for v in values {
            if v.kind() != "method_reference" {
                continue; // idTypes is EMPTY for Java — only method references
            }
            let mut last_ident: Option<Node> = None;
            for i in 0..v.named_child_count() {
                if let Some(c) = v.named_child(i) {
                    if c.kind() == "identifier" {
                        last_ident = Some(c);
                    }
                }
            }
            let Some(last) = last_ident else { continue };
            let m = self.text(last);
            let text = self.text(v);
            let name = if text.starts_with("this::") || text.starts_with("super::") {
                format!("this.{m}")
            } else if let Some(c) = method_ref_type_re().captures(text) {
                if m == "new" {
                    continue;
                }
                format!("{}::{m}", &c[1])
            } else {
                continue;
            };
            let p = last.start_position();
            self.fn_ref_cands.push(Cand {
                from,
                name,
                line: p.row as u32 + 1,
                column_byte: last.start_byte(),
                row: p.row,
            });
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // (functionTypes is empty for Java; lambda_expression halts the scan)
        if depth > 0 && matches!(node.kind(), "lambda_literal" | "lambda_expression") {
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
            // Dedupe on the node ID string (ids collide; the TS side keys on
            // `${fromNodeId}|${name}`).
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

    // --- value references ------------------------------------------------------------

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

        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if n.kind() == "variable_declarator" {
                if let Some(first) = n.named_child(0) {
                    if first.kind() == "identifier" {
                        let nm = self.text(first);
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
            // ID-string comparisons, matching the TS side (ids collide).
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

    // --- Lombok synthesis (#912, languages/java.ts synthesizeLombokMembers) ------------

    fn lombok_annotation_names(&self, node: Node<'t>) -> HashSet<String> {
        let mut names = HashSet::new();
        let Some(modifiers) = self.modifiers_child(node) else { return names };
        for i in 0..modifiers.named_child_count() {
            let Some(child) = modifiers.named_child(i) else { continue };
            if matches!(child.kind(), "marker_annotation" | "annotation") {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Some(simple) = self.text(name_node).trim().rsplit('.').next() {
                        if !simple.is_empty() {
                            names.insert(simple.to_string());
                        }
                    }
                }
            }
        }
        names
    }

    fn synthesize_lombok_members(&mut self, class_node: Node<'t>, class_row: u32) {
        let class_anns = self.lombok_annotation_names(class_node);
        let class_getter = class_anns.contains("Getter");
        let class_setter = class_anns.contains("Setter");
        let is_data = class_anns.contains("Data");
        let is_value = class_anns.contains("Value");
        let has_builder = class_anns.contains("Builder") || class_anns.contains("SuperBuilder");
        let has_to_string = is_data || is_value || class_anns.contains("ToString");
        let has_equals = is_data || is_value || class_anns.contains("EqualsAndHashCode");
        let log_ann = class_anns.iter().find(|a| is_lombok_log_annotation(a)).cloned();

        let Some(body) = class_node.child_by_field_name("body") else { return };
        let fields: Vec<Node> = (0..body.named_child_count())
            .filter_map(|i| body.named_child(i))
            .filter(|c| c.kind() == "field_declaration")
            .collect();

        let class_has_lombok = class_getter
            || class_setter
            || is_data
            || is_value
            || has_builder
            || has_to_string
            || has_equals
            || log_ann.is_some();
        if !class_has_lombok && !fields.iter().any(|f| !self.lombok_annotation_names(*f).is_empty()) {
            return;
        }

        // Members the source already declares (exact `classQN::name` matches).
        let class_qn = self.nodes_meta[class_row as usize].qualified_name.clone();
        let class_name = self.nodes_meta[class_row as usize].name.clone();
        let mut taken_methods: HashSet<String> = HashSet::new();
        let mut taken_fields: HashSet<String> = HashSet::new();
        for m in &self.nodes_meta {
            if m.qualified_name == format!("{class_qn}::{}", m.name) {
                match m.kind {
                    "method" | "function" => {
                        taken_methods.insert(m.name.clone());
                    }
                    "field" | "variable" | "constant" | "property" => {
                        taken_fields.insert(m.name.clone());
                    }
                    _ => {}
                }
            }
        }

        let class_name_node = class_node.child_by_field_name("name").unwrap_or(class_node);

        macro_rules! emit_method {
            ($name:expr, $anchor:expr, $sig:expr, $from:expr, $is_static:expr, $ret:expr) => {{
                let name: String = $name;
                if !name.is_empty() && !taken_methods.contains(&name) {
                    taken_methods.insert(name.clone());
                    self.create_node(
                        "method",
                        &name,
                        $anchor,
                        Extra {
                            visibility: Some(1),
                            signature: Some($sig),
                            docstring: Some(format!("Lombok-generated ({})", $from)),
                            decorators: Some(vec!["lombok".to_string()]),
                            is_static: $is_static,
                            return_type: $ret,
                        },
                    );
                }
            }};
        }

        // Per-field getters/setters.
        for fd in &fields {
            let mods = self
                .modifiers_child(*fd)
                .map(|m| self.text(m))
                .unwrap_or("");
            if word_re("static").is_match(mods) {
                continue;
            }
            let is_final = word_re("final").is_match(mods);
            let field_anns = self.lombok_annotation_names(*fd);
            let field_getter = field_anns.contains("Getter");
            let field_setter = field_anns.contains("Setter");

            let want_getter = class_getter || is_data || is_value || field_getter;
            let want_setter = (class_setter || is_data || field_setter) && !is_final;
            if !want_getter && !want_setter {
                continue;
            }

            let type_node = fd.child_by_field_name("type");
            let type_text = type_node
                .map(|t| self.text(t).trim().to_string())
                .unwrap_or_else(|| "Object".to_string());
            let is_boolean_primitive = type_node.map(|t| t.kind() == "boolean_type").unwrap_or(false);
            let return_type = self.normalize_java_type(type_node);

            for i in 0..fd.named_child_count() {
                let Some(vd) = fd.named_child(i) else { continue };
                if vd.kind() != "variable_declarator" {
                    continue;
                }
                let Some(name_node) = vd.child_by_field_name("name") else { continue };
                let field_name = self.text(name_node).trim().to_string();
                if field_name.is_empty() {
                    continue;
                }

                if want_getter {
                    let g = if is_boolean_primitive {
                        if is_prefix_re(&field_name) {
                            field_name.clone()
                        } else {
                            format!("is{}", capitalize(&field_name))
                        }
                    } else {
                        format!("get{}", capitalize(&field_name))
                    };
                    let from = if field_getter {
                        "@Getter"
                    } else if is_data {
                        "@Data"
                    } else if is_value {
                        "@Value"
                    } else {
                        "@Getter"
                    };
                    emit_method!(g.clone(), name_node, format!("{type_text} {g}()"), from, None, return_type.clone());
                }
                if want_setter {
                    let base = if is_boolean_primitive && is_prefix_re(&field_name) {
                        field_name[2..].to_string()
                    } else {
                        field_name.clone()
                    };
                    let s = format!("set{}", capitalize(&base));
                    let from = if field_setter {
                        "@Setter"
                    } else if is_data {
                        "@Data"
                    } else {
                        "@Setter"
                    };
                    emit_method!(s.clone(), name_node, format!("void {s}({type_text} {field_name})"), from, None, None);
                }
            }
        }

        // Class-level synthesized methods.
        if has_builder {
            let from = if class_anns.contains("SuperBuilder") { "@SuperBuilder" } else { "@Builder" };
            emit_method!(
                "builder".to_string(),
                class_name_node,
                format!("static {class_name}.{class_name}Builder builder()"),
                from,
                Some(true),
                Some(format!("{class_name}Builder"))
            );
        }
        if has_to_string {
            let from = if is_data { "@Data" } else if is_value { "@Value" } else { "@ToString" };
            emit_method!("toString".to_string(), class_name_node, "String toString()".to_string(), from, None, None);
        }
        if has_equals {
            let from = if is_data { "@Data" } else if is_value { "@Value" } else { "@EqualsAndHashCode" };
            emit_method!("equals".to_string(), class_name_node, "boolean equals(Object o)".to_string(), from, None, None);
            emit_method!("hashCode".to_string(), class_name_node, "int hashCode()".to_string(), from, None, None);
        }

        // Logger field (@Slf4j and friends).
        if let Some(log_ann) = log_ann {
            if !taken_fields.contains("log") {
                self.create_node(
                    "field",
                    "log",
                    class_name_node,
                    Extra {
                        visibility: Some(2),
                        is_static: Some(true),
                        signature: Some("Logger log".to_string()),
                        docstring: Some(format!("Lombok-generated (@{log_ann})")),
                        decorators: Some(vec!["lombok".to_string()]),
                        ..Extra::default()
                    },
                );
            }
        }
    }
}

fn find_anonymous_class_body(node: Node) -> Option<Node> {
    for i in 0..node.named_child_count() {
        if let Some(child) = node.named_child(i) {
            if matches!(child.kind(), "class_body" | "declaration_list") {
                return Some(child);
            }
        }
    }
    None
}

/// The `new ns.Foo<T>()` name normalization shared by instantiation /
/// anonymous-class / decorator extraction: strip `<...` from the first `<`
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

fn capitalize(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `\bword\b` matcher (modifier keyword tests in languages/java.ts).
fn word_re(word: &'static str) -> &'static Regex {
    static STATIC_RE: OnceLock<Regex> = OnceLock::new();
    static FINAL_RE: OnceLock<Regex> = OnceLock::new();
    match word {
        "static" => STATIC_RE.get_or_init(|| Regex::new(r"\bstatic\b").unwrap()),
        "final" => FINAL_RE.get_or_init(|| Regex::new(r"\bfinal\b").unwrap()),
        _ => unreachable!("word_re only supports static/final"),
    }
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
