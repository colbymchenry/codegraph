//! PHP extraction — a faithful Rust port of `TreeSitterExtractor`'s PHP paths
//! (src/extraction/tree-sitter.ts) plus languages/php.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The authoritative quirk list is docs/design/php-kernel-port-checklist.md —
//! including what this file preserves on purpose: the visitNode hook consumes
//! const_declaration (constants at ANY scope, values never walked) and
//! trait-`use` (implements refs WITH filePath — the v2 ref-flag wire slot,
//! shipped with ruby) before the ladder; the FIRST file-level namespace scopes
//! the whole walk (braced namespaces scope nothing); anonymous classes on the
//! v0.24.2 grammar mint NO anon-class node (top-level methods become file-level
//! functions, in-body methods vanish) and their instantiates ref is the whole
//! anon-class text run through the suffix logic; scoped calls are DOT-joined
//! (`UserModel.query`); `$this->prop->m()` emits `this->prop.m` (the #1251
//! machinery is resolution-side); nullsafe `?->` emits nothing; literal
//! receivers are not suppressed; interface multi-extends drops all but the
//! first base; property type-hints emit no refs from field nodes. Positions in
//! UTF-16 code units. Files with parse errors defer to wasm (≈0–0.1%).

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE, NONE, NONE_STR,
    REF_FLAG_FILE_PATH,
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

/// PHP_NON_CLASS_RETURN (languages/php.ts:37).
fn is_php_non_class_return(lc: &str) -> bool {
    matches!(
        lc,
        "array" | "string" | "int" | "integer" | "float" | "double" | "bool" | "boolean"
            | "void" | "mixed" | "never" | "null" | "false" | "true" | "object" | "callable"
            | "iterable" | "resource"
    )
}

/// PHP_PSEUDO_TYPES (tree-sitter.ts:5760).
fn is_php_pseudo_type(name: &str) -> bool {
    matches!(
        name,
        "self" | "static" | "parent" | "mixed" | "object" | "iterable" | "callable" | "void"
            | "null" | "false" | "true" | "never" | "array" | "int" | "float" | "string" | "bool"
    )
}

/// PHP_TYPE_NODES (tree-sitter.ts:310).
fn is_php_type_node(kind: &str) -> bool {
    matches!(
        kind,
        "named_type" | "optional_type" | "nullable_type" | "union_type" | "intersection_type"
            | "disjunctive_normal_form_type" | "primitive_type"
    )
}

/// PHP_CALLABLE_HOFS (function-ref.ts:347).
fn is_php_callable_hof(name: &str) -> bool {
    matches!(
        name,
        "array_map" | "array_filter" | "array_walk" | "array_walk_recursive" | "array_reduce"
            | "usort" | "uasort" | "uksort"
            | "array_udiff" | "array_udiff_assoc" | "array_uintersect" | "array_uintersect_assoc"
            | "call_user_func" | "call_user_func_array"
            | "forward_static_call" | "forward_static_call_array"
            | "preg_replace_callback" | "preg_replace_callback_array"
            | "register_shutdown_function" | "register_tick_function"
            | "set_error_handler" | "set_exception_handler" | "spl_autoload_register"
            | "ob_start" | "iterator_apply" | "header_register_callback"
            | "is_callable"
    )
}

/// `/^[A-Za-z_]\w*$/` with JS's ASCII `\w`.
fn ascii_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}
/// String-callable simple-name shape (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
fn simple_callable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}
/// String-callable qualified shape (`/^\w+::\w+$/`, JS ASCII `\w`).
fn qualified_callable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9A-Za-z_]+::[0-9A-Za-z_]+$").unwrap())
}
/// extractStaticMemberRef's capitalized-receiver test.
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
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
    skip_gate: bool,
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
    let grammar = crate::langs::grammar_for("php").ok_or("no php grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(php) failed: {e}"))?;
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

    // extractFilePackage: the FIRST namespace_definition among the root's
    // direct namedChildren; braced namespaces (a compound_statement /
    // declaration_list child) make NO node and scope NOTHING. The node stays
    // pushed for the whole walk — QNs become `App\Services::Name` and import
    // nodes/refs hang off it.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for i in 0..root.named_child_count() {
        let Some(child) = root.named_child(i) else { continue };
        if child.kind() != "namespace_definition" {
            continue;
        }
        let ns_name = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .find(|c| c.kind() == "namespace_name");
        let has_body = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .any(|c| matches!(c.kind(), "compound_statement" | "declaration_list"));
        if let Some(ns_name) = ns_name {
            if !has_body {
                let pkg = w.text(ns_name).to_string();
                if !pkg.is_empty() {
                    if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
                        w.stack.push(Scope { row, kind: "namespace", name: pkg });
                        pkg_pushed = true;
                    }
                }
            }
        }
        break;
    }

    w.visit_node(root);
    w.flush_fn_ref_candidates();
    w.flush_value_refs();
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
        let end_line = node.end_position().row as u32 + 1; // no resolveBody for php

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
            decorators: NONE_STR, // php attributes never emit decorates refs
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
        // captureValueRefScope — with a namespace pushed, top-level constants
        // have a `namespace` parent (NOT in the accepted set) and are dropped
        // as targets; class/enum consts qualify, interface/trait ones don't.
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

    // --- hooks (languages/php.ts) ------------------------------------------------

    /// getVisibility: any `visibility_modifier` child with one of the three
    /// texts; none → public (the php default).
    fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() == "visibility_modifier" {
                match self.text(child) {
                    "public" => return 1,
                    "private" => return 2,
                    "protected" => return 3,
                    _ => {}
                }
            }
        }
        1 // PHP defaults to public
    }

    fn is_static(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "static_modifier")
    }

    /// extractPhpReturnType — `self`/`static` collapse to the `'self'` marker
    /// (#608 chained-call fuel); primitives/unions → None.
    fn return_type_of(&self, node: Node) -> Option<String> {
        let mut rt = node.child_by_field_name("return_type")?;
        if rt.kind() == "optional_type" {
            rt = rt.named_child(0).unwrap_or(rt);
        }
        if rt.kind() == "primitive_type" {
            return None;
        }
        let name_node = if rt.kind() == "named_type" { rt.named_child(0).unwrap_or(rt) } else { rt };
        let text = self.text(name_node).trim();
        let text = text.strip_prefix('\\').unwrap_or(text);
        if text.is_empty() {
            return None;
        }
        let last = text.rsplit('\\').next().unwrap_or(text);
        let lc = last.to_lowercase();
        if matches!(lc.as_str(), "self" | "static" | "this" | "$this") {
            return Some("self".to_string());
        }
        if is_php_non_class_return(&lc) {
            return None;
        }
        if !ascii_ident_re().is_match(last) {
            return None; // unions/intersections/complex
        }
        Some(last.to_string())
    }

    // --- the visitNode hook (php.ts:108) ------------------------------------------

    fn try_visit_hook(&mut self, node: Node<'t>) -> bool {
        match node.kind() {
            // Class/interface/trait/enum/top-level constants: one `constant`
            // node per const_element, NO extras, values never walked.
            "const_declaration" => {
                let elements: Vec<Node> = (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .filter(|c| c.kind() == "const_element")
                    .collect();
                for elem in elements {
                    let name_node = (0..elem.named_child_count())
                        .filter_map(|i| elem.named_child(i))
                        .find(|c| c.kind() == "name");
                    let Some(name_node) = name_node else { continue };
                    let name = self.text(name_node).to_string();
                    self.create_node("constant", &name, elem, Extra::default());
                }
                true
            }
            // Trait use inside a class-like body: one `implements` ref per
            // used name (full qualified text), all at the use_declaration's
            // position — WITH filePath (the hook sets ctx.filePath; v2 flag).
            "use_declaration" => {
                let names: Vec<Node> = (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .filter(|c| matches!(c.kind(), "name" | "qualified_name"))
                    .collect();
                let parent = self.top_row();
                let implements = edge_kind_index("implements").unwrap();
                let line = self.line_of(node);
                let col = self.col_of(node);
                for n in names {
                    let name_ref = self.arena.put(self.text(n));
                    self.tables.push_ref_flagged(
                        &RefRow {
                            from_idx: parent,
                            kind: implements,
                            line,
                            column: col,
                            reference_name: name_ref,
                            candidates: NONE_STR,
                            from_id_str: NONE_STR,
                        },
                        REF_FLAG_FILE_PATH,
                    );
                }
                true
            }
            _ => false,
        }
    }

    // --- the dispatcher (visitNode, PHP-relevant branches) ------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        if self.try_visit_hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_definition" {
            // functionTypes; method_declaration is not in it, so this is
            // always extractFunction (php functions can't be class members).
            self.extract_function(node);
            skip_children = true;
        } else if kind == "class_declaration" {
            self.extract_class(node, "class");
            skip_children = true;
        } else if kind == "trait_declaration" {
            // classifyClassNode → 'trait'.
            self.extract_class(node, "trait");
            skip_children = true;
        } else if kind == "method_declaration" {
            // Inside a class-like → method; outside (an anonymous class's
            // members at TOP level — grammar-bump delta #1) the 1747 gate
            // bounces to extractFunction: a file-level `function` node.
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "property_declaration" && self.inside_class_like() {
            self.extract_field(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if matches!(
            kind,
            "namespace_use_declaration" | "include_expression" | "include_once_expression"
                | "require_expression" | "require_once_expression"
        ) {
            self.extract_import(node);
            // children still visited (importTypes sets no skipChildren)
        } else if matches!(
            kind,
            "function_call_expression" | "member_call_expression" | "scoped_call_expression"
        ) {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                // v0.24.2 nests the declaration_list in `anonymous_class`, so
                // this never fires — mirrored for shape.
                self.extract_anonymous_class(node, anon_body);
                skip_children = true;
            }
        }
        // text / php_tag / text_interpolation / namespace_definition /
        // nullsafe_member_call_expression / expression_statement / closures /
        // match / attributes: no branch — children visited.

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- visitFunctionBody --------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if matches!(
            kind,
            "function_call_expression" | "member_call_expression" | "scoped_call_expression"
        ) {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                return;
            }
        }

        // Static value reads (`Cls::CONST`, `Cls::$prop`, `Cls::class`).
        self.extract_static_member_ref(node);

        // Nested NAMED functions; body-level class/trait/enum/interface
        // declarations (the polyfill idiom). NOTE: no method_declaration
        // branch — in-body anonymous-class methods vanish (delta #1), and the
        // visitNode hook does NOT run here (a const_declaration in a body-level
        // class still extracts via extractClass's own visitNode body walk).
        if kind == "function_definition" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            self.extract_class(node, "class");
            return;
        }
        if kind == "trait_declaration" {
            self.extract_class(node, "trait");
            return;
        }
        if kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if kind == "interface_declaration" {
            self.extract_interface(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- extractors ----------------------------------------------------------------

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
            signature: None, // no getSignature hook
            visibility: Some(self.visibility_of(node)),
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        self.extract_php_type_refs(node, row);
        // decorators: none.
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
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };
        self.extract_php_type_refs(node, row);
        self.stack.push(Scope { row, kind: "method", name });
        // Bodiless (interface/abstract) methods still mint nodes, no walk.
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_class(&mut self, node: Node<'t>, kind: &'static str) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node(kind, &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        // primary-ctor refs: csharp-only (needs a parameter_list child type);
        // decorators: none.
        self.stack.push(Scope { row, kind, name });
        let body = node.child_by_field_name("body").unwrap_or(node);
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
            ..Extra::default() // NO visibility — extractInterface never asks
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
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else { return };
        // class_interface_clause → implements refs; the backing type is never
        // read (it's not in a base_clause).
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if child.kind() == "enum_case" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    fn extract_enum_members(&mut self, node: Node<'t>) {
        // name-field path: one enum_member at the enum_case; backed values
        // (`= 'H'`) never walked.
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    /// extractField — the php property_element branch (2077-2104): one `field`
    /// node per element, `$` re-added in the signature only, then RETURN — no
    /// decorators, no type-annotation refs from fields.
    fn extract_field(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = Some(self.visibility_of(node));
        let is_static = Some(self.is_static(node));

        let prop_elements: Vec<Node> = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .filter(|c| c.kind() == "property_element")
            .collect();
        if prop_elements.is_empty() {
            // The declarator/bare fallbacks find nothing on php shapes.
            return;
        }
        // The type node: first namedChild that isn't a modifier or element.
        // QUIRK: final_modifier/abstract_modifier are NOT excluded — a
        // `final public Foo $x` takes `final` as the type text. PRESERVE.
        let type_node = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| {
                !matches!(
                    c.kind(),
                    "visibility_modifier" | "static_modifier" | "readonly_modifier"
                        | "property_element" | "var_modifier"
                )
            });
        let type_text = type_node.map(|t| self.text(t).to_string());

        for elem in prop_elements {
            let var_name = (0..elem.named_child_count())
                .filter_map(|i| elem.named_child(i))
                .find(|c| c.kind() == "variable_name");
            let Some(var_name) = var_name else { continue };
            let name_node = (0..var_name.named_child_count())
                .filter_map(|i| var_name.named_child(i))
                .find(|c| c.kind() == "name");
            let Some(name_node) = name_node else { continue };
            let name = self.text(name_node).to_string();
            let signature = match &type_text {
                Some(t) => format!("{t} ${name}"),
                None => format!("${name}"),
            };
            self.create_node(
                "field",
                &name,
                elem,
                Extra {
                    docstring: docstring.clone(),
                    signature: Some(signature),
                    visibility,
                    is_static,
                    ..Extra::default()
                },
            );
        }
    }

    // --- imports -------------------------------------------------------------------

    /// pushPhpUseRef (3563): `Foo\Bar\Baz` → an `imports` ref named
    /// `Foo\Bar::Baz`; a global-namespace name (no `\` after stripping one
    /// leading `\`) emits nothing here.
    fn push_php_use_ref(&mut self, fqn: &str, from_row: u32, node: Node) {
        let clean = fqn.strip_prefix('\\').unwrap_or(fqn);
        let Some(last_sep) = clean.rfind('\\') else { return };
        let name = format!("{}::{}", &clean[..last_sep], &clean[last_sep + 1..]);
        self.push_ref_at(from_row, &name, edge_kind_index("imports").unwrap(), node);
    }

    fn extract_import(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let import_text = self.text(node).trim().to_string();
        let imports_kind = edge_kind_index("imports").unwrap();

        if matches!(
            kind,
            "include_expression" | "include_once_expression" | "require_expression"
                | "require_once_expression"
        ) {
            // phpStaticIncludePath: static string literals only; dynamic
            // forms (`__DIR__ . '/x'`, interpolation) emit NOTHING.
            let mut arg = node.named_child(0);
            if let Some(a) = arg {
                if a.kind() == "parenthesized_expression" {
                    arg = a.named_child(0);
                }
            }
            let Some(arg) = arg else { return };
            if !matches!(arg.kind(), "string" | "encapsed_string") {
                return;
            }
            let mut content: Option<Node> = None;
            for i in 0..arg.named_child_count() {
                let Some(c) = arg.named_child(i) else { continue };
                if c.kind() != "string_content" {
                    return; // interpolation/escape → not a static path
                }
                if content.is_none() {
                    content = Some(c);
                }
            }
            let Some(content) = content else { return };
            let module_name = self.text(content).to_string();
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
            self.push_ref_at(parent, &module_name.clone(), imports_kind, node);
            return;
        }

        // namespace_use_declaration.
        let ns_prefix = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "namespace_name");
        let use_group = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "namespace_use_group");
        if let (Some(ns_prefix), Some(use_group)) = (ns_prefix, use_group) {
            // Grouped `use A\{B, C as D, Sub\E}` — hook declines, the inline
            // branch emits per-member nodes named `A\B` (first `name` child =
            // the SOURCE name; a nested `Sub\E` clause has a qualified_name,
            // no direct `name` → SKIPPED, grammar-bump delta #2). All nodes
            // and refs sit at the whole declaration's position.
            let prefix = self.text(ns_prefix).to_string();
            let clauses: Vec<Node> = (0..use_group.named_child_count())
                .filter_map(|i| use_group.named_child(i))
                .filter(|c| {
                    matches!(c.kind(), "namespace_use_group_clause" | "namespace_use_clause")
                })
                .collect();
            for clause in clauses {
                let ns_name = (0..clause.named_child_count())
                    .filter_map(|i| clause.named_child(i))
                    .find(|c| c.kind() == "namespace_name");
                let name = match ns_name {
                    Some(nn) => (0..nn.named_child_count())
                        .filter_map(|i| nn.named_child(i))
                        .find(|c| c.kind() == "name"),
                    None => (0..clause.named_child_count())
                        .filter_map(|i| clause.named_child(i))
                        .find(|c| c.kind() == "name"),
                };
                if let Some(name) = name {
                    let full = format!("{prefix}\\{}", self.text(name));
                    self.create_node(
                        "import",
                        &full,
                        node,
                        Extra { signature: Some(import_text.clone()), ..Extra::default() },
                    );
                    let parent = self.top_row();
                    self.push_php_use_ref(&full, parent, node);
                }
            }
            return;
        }

        // Single use (incl. `use function`/`use const`/aliased): the hook's
        // qualified_name-else-name read; alias never included.
        let use_clause = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "namespace_use_clause");
        let Some(use_clause) = use_clause else { return };
        let target = (0..use_clause.named_child_count())
            .filter_map(|i| use_clause.named_child(i))
            .find(|c| c.kind() == "qualified_name")
            .or_else(|| {
                (0..use_clause.named_child_count())
                    .filter_map(|i| use_clause.named_child(i))
                    .find(|c| c.kind() == "name")
            });
        let Some(target) = target else { return }; // hook null → nothing
        let module_name = self.text(target).to_string();
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
        self.push_ref_at(parent, &module_name.clone(), imports_kind, node);
        // emitPhpUseRefs → the `Foo\Bar::Baz` ref (bare single-segment `use
        // Countable;` has no `\` → no `::` ref).
        self.push_php_use_ref(&module_name, parent, node);
    }

    // --- calls ---------------------------------------------------------------------

    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let mut callee_name = String::new();

        let name_field = node.child_by_field_name("name");
        let object_field = node
            .child_by_field_name("object")
            .or_else(|| node.child_by_field_name("scope"));

        if let (Some(name_field), Some(object_field)) = (name_field, object_field) {
            // member_call_expression / scoped_call_expression.
            let method_name = self.text(name_field);

            // Fluent static-factory `Cls::factory($x)->method()` — encode
            // `Cls::factory().method` (inner args dropped) and return; the
            // inner scoped call is also visited by recursion (`Cls.factory`).
            if !method_name.is_empty() && object_field.kind() == "scoped_call_expression" {
                let inner_scope = object_field.child_by_field_name("scope");
                let inner_name = object_field.child_by_field_name("name");
                let callee = match (inner_scope, inner_name) {
                    (Some(s), Some(n)) => {
                        format!("{}::{}().{method_name}", self.text(s), self.text(n))
                    }
                    _ => method_name.to_string(),
                };
                if !callee.is_empty() {
                    self.push_ref_at(caller, &callee, edge_kind_index("calls").unwrap(), node);
                }
                return;
            }

            // receiverName = raw receiver text with ONE leading `$` stripped:
            // `$this->prop->m()` → `this->prop.m` (#1251 encoding — the whole
            // resolution machinery is TS-side); chains keep args
            // (`this->factory($cfg).m`); literals are NOT suppressed
            // (`"chain".upper`); scoped calls are DOT-joined (`UserModel.query`).
            let receiver_raw = self.text(object_field);
            let receiver = receiver_raw.strip_prefix('$').unwrap_or(receiver_raw);
            if !method_name.is_empty() {
                if matches!(receiver, "self" | "this" | "cls" | "super" | "parent" | "static") {
                    callee_name = method_name.to_string();
                } else {
                    callee_name = format!("{receiver}.{method_name}");
                }
            }
        } else {
            // function_call_expression: raw func text — bare `helper`,
            // qualified `\App\Helpers\format_id` verbatim, `$fn` for
            // variable callees, FCC `f(...)` → `f`.
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
        // php has no constructor/type/name FIELDS → namedChild(0). Backslashes
        // are NOT split by the suffix logic → `new \App\Models\User()` keeps
        // the full qualified text; `new $cls()` keeps the `$`; an
        // anonymous_class yields its whole source text through the shared
        // normalization (garbage, deterministic — preserve).
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

    /// extractAnonymousClass — unreachable on v0.24.2 (the declaration_list
    /// nests inside `anonymous_class`, so findAnonymousClassBody finds no
    /// DIRECT child) — mirrored from the shared TS path for shape.
    fn extract_anonymous_class(&mut self, node: Node<'t>, body: Node<'t>) {
        let type_node = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let mut type_name =
            type_node.map(|t| self.text(t).to_string()).unwrap_or_else(|| "Object".to_string());
        type_name = strip_generic_and_qualifier(&type_name);
        if type_name.is_empty() {
            type_name = "Object".to_string();
        }
        let anon_name = format!("<{type_name}$anon@{}>", node.start_position().row + 1);
        let Some(row) = self.create_node("class", &anon_name, node, Extra::default()) else {
            return;
        };
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

    /// extractStaticMemberRef — php's class_constant_access_expression +
    /// scoped_property_access_expression (member_access_expression is
    /// evaluated but its variable_name receiver never passes).
    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if !matches!(
            node.kind(),
            "class_constant_access_expression" | "scoped_property_access_expression"
                | "member_access_expression"
        ) {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        if let Some(parent) = node.parent() {
            if matches!(
                parent.kind(),
                "function_call_expression" | "member_call_expression" | "scoped_call_expression"
            ) {
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

    /// extractInheritance — base_clause takes ONLY the first base (interface
    /// multi-extends drops the rest); class_interface_clause takes ALL
    /// children unfiltered (full text, incl. leading `\`).
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        let implements_kind = edge_kind_index("implements").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "base_clause" {
                if let Some(target) = child.named_child(0) {
                    let name = self.text(target).to_string();
                    self.push_ref_at(class_row, &name, extends_kind, target);
                }
            } else if child.kind() == "class_interface_clause" {
                for j in 0..child.named_child_count() {
                    let Some(iface) = child.named_child(j) else { continue };
                    let name = self.text(iface).to_string();
                    self.push_ref_at(class_row, &name, implements_kind, iface);
                }
            }
        }
    }

    // --- php type refs (extractPhpTypeRefs, 6022) ----------------------------------

    fn extract_php_type_refs(&mut self, node: Node<'t>, from_row: u32) {
        let params = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "formal_parameters");
        if let Some(params) = params {
            for i in 0..params.named_child_count() {
                let Some(p) = params.named_child(i) else { continue };
                for j in 0..p.named_child_count() {
                    let Some(c) = p.named_child(j) else { continue };
                    if is_php_type_node(c.kind()) {
                        self.walk_php_type_position(c, from_row);
                    }
                }
            }
        }
        for i in 0..node.named_child_count() {
            let Some(c) = node.named_child(i) else { continue };
            if is_php_type_node(c.kind()) {
                self.walk_php_type_position(c, from_row);
            }
        }
    }

    fn walk_php_type_position(&mut self, node: Node<'t>, from_row: u32) {
        match node.kind() {
            "primitive_type" => {}
            "name" => {
                let name = self.text(node);
                if !name.is_empty() && !is_php_pseudo_type(name) {
                    self.push_ref_at(from_row, &name.to_string(), edge_kind_index("references").unwrap(), node);
                }
            }
            "qualified_name" => {
                let text = self.text(node);
                let last = text.rsplit('\\').next().unwrap_or("");
                if !last.is_empty() && !is_php_pseudo_type(last) {
                    self.push_ref_at(from_row, &last.to_string(), edge_kind_index("references").unwrap(), node);
                }
            }
            _ => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        self.walk_php_type_position(c, from_row);
                    }
                }
            }
        }
    }

    // --- function-as-value refs (PHP_SPEC, function-ref.ts:360) --------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        if node.kind() != "arguments" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.normalize_fn_ref_value(c, from, 0);
            }
        }
    }

    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "argument" => {
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            // String callable — trustworthy ONLY as an argument to a known
            // callable-taking core function; skipGate (resolution's
            // unique-or-drop rule takes over). Namespaced strings drop.
            "string" | "encapsed_string" => {
                let Some(callee) = php_enclosing_call_name(v).map(|f| self.text(f)) else {
                    return;
                };
                if !is_php_callable_hof(callee) {
                    return;
                }
                let Some(content) = self.php_string_content(v) else { return };
                if simple_callable_re().is_match(&content) || qualified_callable_re().is_match(&content)
                {
                    self.push_fn_ref_cand(from, &content, v, true);
                }
            }
            // Array callables in ANY call's arguments: `[$this, 'm']` →
            // this.m; `[Foo::class, 'm']` → Foo::m; `['Cls', 'm']` → nothing.
            "array_creation_expression" => {
                if v.named_child_count() != 2 {
                    return;
                }
                let recv = v.named_child(0).and_then(|e| e.named_child(0));
                let str_el = v.named_child(1).and_then(|e| e.named_child(0));
                let (Some(recv), Some(str_el)) = (recv, str_el) else { return };
                if !matches!(str_el.kind(), "encapsed_string" | "string") {
                    return;
                }
                let Some(member) = self.php_string_content(str_el) else { return };
                if !simple_callable_re().is_match(&member) {
                    return;
                }
                if recv.kind() == "variable_name" && self.text(recv) == "$this" {
                    let name = format!("this.{member}");
                    self.push_fn_ref_cand(from, &name, str_el, false);
                } else if recv.kind() == "class_constant_access_expression" {
                    let cls = recv.named_child(0);
                    let kw = recv.named_child(1);
                    if let (Some(cls), Some(kw)) = (cls, kw) {
                        if self.text(kw) == "class" {
                            let name = format!("{}::{member}", self.text(cls));
                            self.push_fn_ref_cand(from, &name, str_el, false);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// phpStringContent: the string's first string_content child, trimmed.
    fn php_string_content(&self, node: Node) -> Option<String> {
        for i in 0..node.named_child_count() {
            let Some(c) = node.named_child(i) else { continue };
            if c.kind() == "string_content" {
                return Some(self.text(c).trim().to_string());
            }
        }
        None
    }

    fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node, skip_gate: bool) {
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
            skip_gate,
        });
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halts at functionTypes (function_definition) + arrow_function (in
        // the fixed list); anonymous_function is NOT halted — scans descend
        // into closures.
        if depth > 0
            && matches!(
                node.kind(),
                "function_definition" | "arrow_function" | "function_expression" | "lambda_literal"
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
            // `this.<m>` and `Cls::m` shapes always flush; HOF-position string
            // callables skip the gate (unique-or-drop at resolution); the rest
            // gate on defined-in-file ∪ bare single-segment `use` imports
            // (path-shaped and `::`-shaped import refs match neither regex).
            if !c.name.starts_with("this.") && !c.name.contains("::") {
                let skip = c.skip_gate;
                if !skip
                    && !self.defined_fn_names.contains(&c.name)
                    && !self.imported_names.contains(&c.name)
                {
                    continue;
                }
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

    // --- value references ------------------------------------------------------------

    fn flush_value_refs(&mut self) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let targets = std::mem::take(&mut self.fs_values);
        let _counts = std::mem::take(&mut self.fs_value_counts);
        if std::env::var("CODEGRAPH_VALUE_REFS").as_deref() == Ok("0") {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune: the per-grammar declarator switch has NO resolving php
        // cases (`assignment` is python's node; property_declaration's
        // Kotlin/Swift path yields null) → declCounts stays empty → no php
        // target is ever pruned. Skipping the scan is byte-identical.

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
                // `name` is the php-live reader kind — ANY textual occurrence
                // of a target name in a reader's subtree emits (const reads,
                // `self::MAX`, `$MAX` variable names, interpolated `$MAX`).
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

/// The function name node of the php call whose arguments contain `node` —
/// ≤4 parent hops to a function_call_expression; member/scoped calls abort
/// (method-call HOFs never qualify). (function-ref.ts:822)
fn php_enclosing_call_name(node: Node) -> Option<Node> {
    let mut cur = node.parent();
    for _ in 0..4 {
        let c = cur?;
        if c.kind() == "function_call_expression" {
            return c.child_by_field_name("function");
        }
        if matches!(c.kind(), "member_call_expression" | "scoped_call_expression") {
            return None;
        }
        cur = c.parent();
    }
    None
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

/// The shared `new ns.Foo<T>()` normalization: strip `<...` from the first
/// `<` (index > 0), keep the segment after the last `.`/`::`, strip ONE
/// leading `:` or `.`, trim. Backslashes are NOT handled — php qualified
/// names pass through whole.
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
