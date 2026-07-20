//! TypeScript / TSX / JavaScript / JSX extraction — a faithful Rust port of
//! `TreeSitterExtractor`'s TS/JS paths (src/extraction/tree-sitter.ts) plus
//! the typescript/javascript LanguageExtractor configs.
//!
//! Porting contract (R2 of the migration plan): behavior parity with the wasm
//! path, verified by scripts/kernel-parity.mjs over real repos — including
//! bug-for-bug fidelity where the TS code has quirks. Every function notes the
//! TS function it mirrors; if you change one side, change the other or the
//! parity gate fails. Positions are emitted in UTF-16 code units (what
//! web-tree-sitter reports), see util::col16.

mod extractors;
mod fnref;
use crate::textutil as util;

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE,
    NONE, NONE_STR,
};
use crate::ids;
use crate::langs;
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Typescript,
    Tsx,
    Javascript,
    Jsx,
}

impl Variant {
    pub fn from_language(language: &str) -> Option<Variant> {
        match language {
            "typescript" => Some(Variant::Typescript),
            "tsx" => Some(Variant::Tsx),
            "javascript" => Some(Variant::Javascript),
            "jsx" => Some(Variant::Jsx),
            _ => None,
        }
    }
    /// TS-family (typescript/tsx): type annotations, interfaces, enums,
    /// aliases, visibility, isStatic. The JS family lacks all of those hooks.
    fn is_ts(self) -> bool {
        matches!(self, Variant::Typescript | Variant::Tsx)
    }
    /// VALUE_REF_LANGS includes typescript/tsx/javascript but NOT jsx.
    fn value_refs(self) -> bool {
        !matches!(self, Variant::Jsx)
    }
}

/// typescriptExtractor.methodTypes / javascriptExtractor.methodTypes.
fn is_method_type(v: Variant, kind: &str) -> bool {
    kind == "method_definition"
        || (v.is_ts() && kind == "public_field_definition")
        || (!v.is_ts() && kind == "field_definition")
}

fn is_function_type(kind: &str) -> bool {
    matches!(kind, "function_declaration" | "arrow_function" | "function_expression")
}

fn is_class_type(v: Variant, kind: &str) -> bool {
    kind == "class_declaration" || (v.is_ts() && kind == "abstract_class_declaration")
}

fn is_variable_type(kind: &str) -> bool {
    matches!(kind, "lexical_declaration" | "variable_declaration")
}

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts) — full set; only a handful occur in
/// TS/JS grammars but membership is what the TS code tests.
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

/// BUILTIN_TYPES (tree-sitter.ts) — names that never become type references.
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

/// REACT_COMPONENT_HOCS (tree-sitter.ts, #841).
fn is_react_hoc(callee: &str) -> bool {
    matches!(callee, "forwardRef" | "memo" | "React.forwardRef" | "React.memo")
}

fn is_vue_collection_name(name: &str) -> bool {
    matches!(name, "actions" | "mutations" | "getters")
}

/// One scope-stack entry (TS keeps node IDs; rows are our equivalent).
struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

/// Extra node properties, per-extract-site (mirrors createNode's `extra`).
#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<u8>,
    is_exported: Option<bool>,
    is_async: Option<bool>,
    is_static: Option<bool>,
    qualified_name: Option<String>,
}

struct ValueScope<'t> {
    row: u32,
    node: Node<'t>,
    name: String,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    variant: Variant,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    /// Node id string per row. Rows are unique but IDS COLLIDE for same
    /// (kind, name, line) nodes — routine in minified one-line files — and the
    /// TS extractor's fn-ref dedupe and value-ref self-checks key on the ID,
    /// so parity requires comparing ids, not rows.
    node_ids: Vec<String>,
    /// Function/method names defined in this file (fn-ref flush gate).
    defined_fn_names: HashSet<String>,
    /// Simple names from `imports` refs (fn-ref flush gate).
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<(u32, fnref::Candidate)>,
    // Value-reference bookkeeping (flushValueRefs).
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
    vue_store_file: Option<bool>,
}

const MAX_VALUE_REF_NODES: usize = 20_000;

pub fn extract(file_path: &str, source: &str, language: &str) -> Result<EmitOut, String> {
    let variant = Variant::from_language(language)
        .ok_or_else(|| format!("tsjs walker does not handle language: {language}"))?;
    let grammar = langs::grammar_for(language)
        .ok_or_else(|| format!("no grammar for language: {language}"))?;

    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language({language}) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;

    // Files with parse ERRORS defer to the wasm extractor (the `defer:` prefix
    // tells the TS side this is expected routing, not a malfunction). Reason:
    // tree-sitter's error RECOVERY — same grammar, same core version — resolves
    // differently under UTF-8 (native) vs UTF-16 (web-tree-sitter) parsing, so
    // an erroring file's tree can differ between the paths (proven on vscode:
    // `readonly import('x').T[]` recovered with the ERROR inside vs outside the
    // type annotation). Erroring files are rare (0-0.42% across express/
    // excalidraw/vscode) and per-file wasm fallback keeps routing graph-neutral
    // by construction; clean files — 99.6%+ — stay on the fast path.
    if tree.root_node().has_error() {
        return Err("defer: parse tree contains errors — wasm recovery is canonical".to_string());
    }

    let mut w = Walker {
        src: source,
        file_path,
        variant,
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
        vue_store_file: None,
    };

    // File node (TreeSitterExtractor.extract): id `file:<path>`, endLine =
    // newline count + 1, isExported explicitly false.
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

    w.visit_node(tree.root_node());

    // End-of-file passes, in the TS extract() order.
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
    // --- small helpers --------------------------------------------------------

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

    /// isInsideClassLikeNode.
    fn inside_class_like(&self) -> bool {
        self.stack
            .last()
            .map(|s| matches!(s.kind, "class" | "struct" | "interface" | "trait" | "enum" | "module"))
            .unwrap_or(false)
    }

    fn push_ref(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
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
            // Feed the fn-ref flush gate the same way flushFnRefCandidates
            // derives importedNames from `imports` refs.
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    fn push_call_ref(&mut self, name: &str, node: Node) {
        self.push_ref(self.top_row(), name, edge_kind_index("calls").unwrap(), node);
    }

    // --- createNode -----------------------------------------------------------

    /// createNode (tree-sitter.ts): id, qualified name from the scope stack,
    /// contains edge from the parent scope, value-ref bookkeeping.
    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);

        // endLine body extension: resolveBody only (TS/JS: function-valued
        // class fields whose body nests in the arrow / HOF-wrapped arrow).
        let mut end_line = node.end_position().row as u32 + 1;
        if (kind == "function" || kind == "method") && matches!(node.kind(), "public_field_definition" | "field_definition")
        {
            if let Some(body) = resolve_field_body(node) {
                let be = body.end_position().row as u32 + 1;
                if be > end_line {
                    end_line = be;
                }
            }
        }

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
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }

        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
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
            return_type: NONE_STR,
            extra_json: NONE_STR,
        });

        // Containment edge from the current scope.
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

        self.node_ids.push(id);
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        self.capture_value_ref_scope(kind, name, row, node);
        Some(row)
    }

    // --- value references (captureValueRefScope / flushValueRefs) --------------

    fn capture_value_ref_scope(&mut self, kind: &'static str, name: &str, row: u32, node: Node<'t>) {
        if !self.variant.value_refs() {
            return;
        }
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

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if !self.variant.value_refs() || std::env::var("CODEGRAPH_VALUE_REFS").as_deref() == Ok("0") {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune: count declarators of each target name across the whole
        // tree; more declarators than file-scope nodes ⇒ an inner re-binding
        // shadows the target. (TS/JS declarators are `variable_declarator`;
        // the other kinds in the TS switch belong to other grammars.)
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
            // Self-skip and per-scope dedupe compare node ID STRINGS (which
            // collide for same-(kind, name, line) nodes), matching the TS side.
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

    // --- function-as-value refs (#756) -----------------------------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let Some(mode) = fnref::dispatch(node.kind()) else { return };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        for (cand, _mode) in fnref::capture(node, mode, self.src) {
            self.fn_ref_cands.push((from, cand));
        }
    }

    /// scanFnRefSubtree: capture-only walk of subtrees the main walkers skip.
    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        let kind = node.kind();
        if depth > 0
            && (is_function_type(kind) || matches!(kind, "lambda_literal" | "lambda_expression"))
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
        for (from, c) in cands {
            // Gate: `this.<member>` always flushes; everything else must match
            // a same-file function/method or an imported name. (The `::` and
            // ungated-mode policies belong to other languages' specs.)
            if !c.name.starts_with("this.")
                && !c.name.contains("::")
                && !self.defined_fn_names.contains(&c.name)
                && !self.imported_names.contains(&c.name)
            {
                continue;
            }
            // Dedupe on the node ID STRING, not the row — ids collide for
            // same-(kind, name, line) nodes (minified one-liners) and the TS
            // side keys its dedupe on `${fromNodeId}|${name}`.
            if !seen.insert((self.node_ids[from as usize].clone(), c.name.clone())) {
                continue;
            }
            let column = util::col16(self.src, &self.line_starts, c.row, c.column_byte);
            let name_ref = self.arena.put(&c.name);
            self.tables.push_ref(&RefRow {
                from_idx: from,
                kind: FUNCTION_REF_CODE,
                line: c.line,
                column,
                reference_name: name_ref,
                candidates: NONE_STR,
                from_id_str: NONE_STR,
            });
        }
    }

    // --- the dispatcher (visitNode) --------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        // Function-as-value capture — independent of the dispatch ladder.
        self.maybe_capture_fn_refs(node);

        if is_function_type(kind) {
            // (the isInsideClassLike + methodTypes overlap is Python/Ruby-only)
            self.extract_function(node, None);
            skip_children = true;
        } else if is_class_type(self.variant, kind) {
            self.extract_class(node);
            skip_children = true;
        } else if is_method_type(self.variant, kind) {
            if classify_ts_class_member(node) == Member::Property {
                let prop = self.extract_property(node);
                if let (Some((row, name)), Some(value)) = (prop, node.child_by_field_name("value")) {
                    self.stack.push(Scope { row, kind: "property", name });
                    self.visit_function_body(value);
                    self.stack.pop();
                }
                self.scan_fn_ref_subtree(node, 0);
            } else {
                self.extract_method(node);
            }
            skip_children = true;
        } else if self.variant.is_ts() && kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "type_alias_declaration" {
            skip_children = self.extract_type_alias(node);
        } else if is_variable_type(kind) && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_statement" {
            self.extract_import(node);
        } else if kind == "export_statement" && node.child_by_field_name("source").is_some() {
            // Re-export: `export { X } from './y'`.
            self.emit_re_export_refs(node);
        } else if kind == "export_statement" && self.looks_like_vue_store_file() {
            // Vuex MODULE default export (`export default { actions: {…} }`).
            if let Some(exported) = node.child_by_field_name("value") {
                if matches!(exported.kind(), "object" | "object_expression") {
                    self.extract_store_collection_methods(exported);
                    skip_children = true;
                }
            }
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        } else if self.variant.is_ts()
            && matches!(kind, "property_signature" | "method_signature")
            && self.inside_class_like()
        {
            let parent = self.top_row();
            self.extract_type_annotations(node, parent);
        }

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- visitFunctionBody ------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        }

        // Local variable type annotations (TS family only).
        if self.variant.is_ts() && kind == "variable_declarator" {
            let owner = self.top_row();
            self.extract_variable_type_annotation(node, owner);
        }

        // Nested NAMED functions become their own nodes.
        if is_function_type(kind) {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node, None);
                return;
            }
        }

        if is_class_type(self.variant, kind) {
            self.extract_class(node);
            return;
        }
        if self.variant.is_ts() && kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if self.variant.is_ts() && kind == "interface_declaration" {
            self.extract_interface(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- name / signature / modifier helpers ------------------------------------

    /// extractName / extractNameRaw for the TS/JS configs.
    fn extract_name(&self, node: Node) -> String {
        // javascriptExtractor.resolveName: field_definition names its key the
        // `property` field.
        if !self.variant.is_ts() && node.kind() == "field_definition" {
            if let Some(prop) = node.child_by_field_name("property") {
                return self.text(prop).to_string();
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if matches!(node.kind(), "arrow_function" | "function_expression") {
            return "<anonymous>".to_string();
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

    /// typescriptExtractor.getSignature / javascriptExtractor.getSignature.
    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if self.variant.is_ts() {
            if let Some(ret) = node.child_by_field_name("return_type") {
                let ret_text = self.text(ret);
                let stripped = ret_text.strip_prefix(':').unwrap_or(ret_text).trim_start();
                sig.push_str(": ");
                sig.push_str(stripped);
            }
        }
        Some(sig)
    }

    /// typescriptExtractor.getVisibility (TS only — JS has no hook).
    fn visibility_of(&self, node: Node) -> Option<u8> {
        if !self.variant.is_ts() {
            return None;
        }
        for i in 0..node.child_count() {
            let child = node.child(i)?;
            if child.kind() == "accessibility_modifier" {
                return match self.text(child) {
                    "public" => Some(1),
                    "private" => Some(2),
                    "protected" => Some(3),
                    _ => None,
                };
            }
        }
        None
    }

    /// isExported: walk the parent chain for an export_statement.
    fn is_exported(&self, node: Node) -> bool {
        let mut cur = node.parent();
        while let Some(p) = cur {
            if p.kind() == "export_statement" {
                return true;
            }
            cur = p.parent();
        }
        false
    }

    fn has_keyword_child(&self, node: Node, kw: &str) -> bool {
        for i in 0..node.child_count() {
            if let Some(c) = node.child(i) {
                if c.kind() == kw {
                    return true;
                }
            }
        }
        false
    }

    fn is_async(&self, node: Node) -> bool {
        self.has_keyword_child(node, "async")
    }

    /// TS has an isStatic hook; JS does not (None = field absent).
    fn is_static(&self, node: Node) -> Option<bool> {
        if self.variant.is_ts() {
            Some(self.has_keyword_child(node, "static"))
        } else {
            None
        }
    }

    fn is_const_decl(&self, node: Node) -> bool {
        node.kind() == "lexical_declaration" && self.has_keyword_child(node, "const")
    }

    // (extract_* functions continue in impl blocks below)
}

/// classifyTsClassMember (#808): a class field is a METHOD only when its value
/// is callable (arrow / function expression / HOF call wrapping one).
#[derive(PartialEq)]
enum Member {
    Method,
    Property,
}

fn classify_ts_class_member(node: Node) -> Member {
    if !matches!(node.kind(), "public_field_definition" | "field_definition") {
        return Member::Method;
    }
    for i in 0..node.named_child_count() {
        let Some(child) = node.named_child(i) else { continue };
        if matches!(child.kind(), "arrow_function" | "function_expression") {
            return Member::Method;
        }
        if child.kind() == "call_expression" {
            if let Some(args) = child.child_by_field_name("arguments") {
                for j in 0..args.named_child_count() {
                    if let Some(arg) = args.named_child(j) {
                        if matches!(arg.kind(), "arrow_function" | "function_expression") {
                            return Member::Method;
                        }
                    }
                }
            }
        }
    }
    Member::Property
}

/// typescriptExtractor.resolveBody / javascriptExtractor.resolveBody: the body
/// of a function-valued class field, nested in the arrow / HOF-wrapped arrow.
fn resolve_field_body(node: Node) -> Option<Node> {
    if !matches!(node.kind(), "public_field_definition" | "field_definition") {
        return None;
    }
    for i in 0..node.named_child_count() {
        let child = node.named_child(i)?;
        if matches!(child.kind(), "arrow_function" | "function_expression") {
            return child.child_by_field_name("body");
        }
        if child.kind() == "call_expression" {
            if let Some(args) = child.child_by_field_name("arguments") {
                for j in 0..args.named_child_count() {
                    if let Some(arg) = args.named_child(j) {
                        if matches!(arg.kind(), "arrow_function" | "function_expression") {
                            return arg.child_by_field_name("body");
                        }
                    }
                }
            }
        }
    }
    None
}

/// resolveBody ?? getChildByField(node, 'body') — the body-walk resolution.
fn body_of(node: Node) -> Option<Node> {
    resolve_field_body(node).or_else(|| node.child_by_field_name("body"))
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
