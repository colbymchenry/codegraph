//! C# extraction — a faithful Rust port of `TreeSitterExtractor`'s C# paths
//! (src/extraction/tree-sitter.ts) plus languages/csharp.ts.
//!
//! Same porting contract as the other walkers: behavior parity with the wasm
//! path, bug-for-bug, verified by scripts/kernel-parity.mjs and the full-index
//! dump-diff gate. The authoritative quirk list is
//! docs/design/csharp-kernel-port-checklist.md — including every deliberate
//! emission hole (property/accessor bodies, constructor initializers,
//! delegates/events/operators/indexers, top-level locals) and garbage ref
//! (`(repo)` primary-ctor extends, `: byte` enum extends, `nameof` calls)
//! this file preserves on purpose. Positions in UTF-16 code units. Files whose
//! parse tree contains ERRORS defer to the wasm extractor.
//!
//! preParse (#237 `#if` blanking) stays TS-side: the route point hoists it, so
//! the kernel receives pre-blanked bytes — port NOTHING of it here (its regex
//! carries JS `(?m)`/CRLF semantics that must not be re-implemented).

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

/// BUILTIN_TYPES (tree-sitter.ts) — the full shared table; membership is what
/// the TS code tests, so every row is ported even where only the Java/C# row
/// can fire (a C# type named `String`/`error` IS suppressed via other rows).
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

/// extractCsharpReturnType's trailing-nullable strip (`/\?+$/`).
fn trailing_nullable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\?+$").unwrap())
}
/// extractCsharpReturnType's generics strip (`/<[^>]*>/g`) — deliberately
/// non-nesting: `Task<List<Foo>>` → `Task>` → the ident test fails →
/// returnType undefined (same class of quirk as rust; PRESERVE).
fn generic_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
/// `/^[A-Za-z_]\w*$/` with JS's ASCII `\w` (Rust's default `\w` is Unicode).
fn ascii_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][0-9A-Za-z_]*$").unwrap())
}
/// extractStaticMemberRef's capitalized-receiver test.
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}

/// JS `\s` (WhiteSpace ∪ LineTerminator) — differs from Rust's `\p{White_Space}`
/// on U+FEFF (JS: yes) and U+0085 (JS: no). The chained-call inner-callee strip
/// (`.replace(/\s+/g, '')`) runs on arbitrary source slices, so match JS exactly.
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

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
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
    let grammar = crate::langs::grammar_for("csharp").ok_or("no csharp grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(csharp) failed: {e}"))?;
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

    // File node (TreeSitterExtractor.extract). Source here is the pre-blanked
    // text (the route point hoists preParse), identical bytes on both arms.
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

    // extractFilePackage: the FIRST top-level namespace declaration mints ONE
    // `namespace` node that stays pushed for the ENTIRE file — a second
    // top-level namespace's types nest under the first's node/QN, nested
    // namespaces leave no trace, and every import ref in a namespaced file
    // hangs off this node (checklist §namespace).
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for i in 0..root.named_child_count() {
        let Some(child) = root.named_child(i) else { continue };
        if child.kind() != "namespace_declaration"
            && child.kind() != "file_scoped_namespace_declaration"
        {
            continue;
        }
        // csharpExtractor.extractPackage: `name` field ?? first
        // qualified_name/identifier named child. No trim.
        let name_node = child.child_by_field_name("name").or_else(|| {
            (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| matches!(c.kind(), "qualified_name" | "identifier"))
        });
        if let Some(name_node) = name_node {
            let pkg = w.text(name_node).to_string();
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

/// classifyClassNode (languages/csharp.ts): a record_declaration with an
/// anonymous `struct` keyword child is a record struct.
fn record_is_struct(node: Node) -> bool {
    (0..node.child_count())
        .filter_map(|i| node.child(i))
        .any(|c| c.kind() == "struct")
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
        let end_line = node.end_position().row as u32 + 1; // no resolveBody for csharp

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
            decorators: NONE_STR, // C# extraction emits no decorators (checklist §decorators)
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

    // --- hooks (languages/csharp.ts) --------------------------------------------
    //
    // C# modifiers are individual named `modifier` children — there is NO
    // Java-style `modifiers` wrapper (probed).

    /// getVisibility: FIRST `modifier` child whose text is one of the four
    /// levels wins; none → private (the C# default).
    fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() == "modifier" {
                match self.text(child) {
                    "public" => return 1,
                    "private" => return 2,
                    "protected" => return 3,
                    "internal" => return 4,
                    _ => {}
                }
            }
        }
        2 // C# defaults to private
    }

    fn is_static(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "modifier" && self.text(c) == "static")
    }

    fn is_async(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "modifier" && self.text(c) == "async")
    }

    /// isConst: `const` → true; else `static` AND `readonly` both present.
    fn is_const(&self, node: Node) -> bool {
        let mut has_static = false;
        let mut has_readonly = false;
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() != "modifier" {
                continue;
            }
            match self.text(child) {
                "const" => return true,
                "static" => has_static = true,
                "readonly" => has_readonly = true,
                _ => {}
            }
        }
        has_static && has_readonly
    }

    /// extractCsharpReturnType — reads the `returns` field; feeds the
    /// #645/#608 chained-call resolution. Constructors have no `returns`.
    fn return_type_of(&self, node: Node) -> Option<String> {
        let t = node.child_by_field_name("returns")?;
        if matches!(t.kind(), "predefined_type" | "array_type") {
            return None;
        }
        let mut s = self.text(t).trim().to_string();
        s = trailing_nullable_re().replace(&s, "").into_owned();
        s = generic_args_re().replace_all(&s, "").into_owned();
        let last = s.rsplit('.').next().unwrap_or("").trim().to_string();
        if last.is_empty() || !ascii_ident_re().is_match(&last) {
            return None;
        }
        Some(last)
    }

    /// extractName (tree-sitter.ts:90) — the C#-reachable paths: the `name`
    /// field (always present on named declarations), else the shared
    /// identifier scan, else `<anonymous>`.
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

    // --- the dispatcher (visitNode, C#-relevant branches) -----------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "class_declaration" || kind == "record_declaration" {
            // classifyClassNode: `record struct` → extractStruct, else class.
            if kind == "record_declaration" && record_is_struct(node) {
                self.extract_struct(node);
            } else {
                self.extract_class(node);
            }
            skip_children = true;
        } else if kind == "method_declaration" || kind == "constructor_declaration" {
            self.extract_method(node);
            skip_children = true;
        } else if kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if kind == "struct_declaration" || kind == "record_struct_declaration" {
            self.extract_struct(node);
            skip_children = true;
        } else if kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "property_declaration" && self.inside_class_like() {
            // Property accessor/expression bodies are NEVER walked (calls
            // inside are lost by design) — candidates-only scan.
            self.extract_property(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "field_declaration" && self.inside_class_like() {
            self.extract_field(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "local_declaration_statement" && !self.inside_class_like() {
            // Top-level statements: extractVariable's generic fallback finds no
            // direct identifier/variable_declarator children (C# nests them in
            // variable_declaration) → ZERO nodes, zero refs. Candidates only.
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "using_directive" {
            self.extract_import(node);
            // no skipChildren (TS importTypes branch) — children visited below
        } else if kind == "invocation_expression" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                skip_children = true;
            }
        }
        // Everything else (namespace_declaration, global_statement, delegates,
        // events, operators, indexers, destructors, local functions, preproc_*)
        // falls through: no node minted, children visited — their bodies' calls
        // attribute to the enclosing scope (checklist §dispatch).

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

        if kind == "invocation_expression" {
            self.extract_call(node);
        } else if kind == "object_creation_expression" {
            self.extract_instantiation(node);
            if let Some(anon_body) = find_anonymous_class_body(node) {
                self.extract_anonymous_class(node, anon_body);
                return;
            }
        }

        // Static value reads (`ReadType.ReadAsDouble`) — body walker only.
        self.extract_static_member_ref(node);

        // (variable_declarator type-annotation branch: C# has no
        // `type_annotation` child node — structurally inert, not ported.
        // functionTypes is empty — no nested-function branch.)

        if kind == "class_declaration" || kind == "record_declaration" {
            if kind == "record_declaration" && record_is_struct(node) {
                self.extract_struct(node);
            } else {
                self.extract_class(node);
            }
            return;
        }
        if kind == "struct_declaration" || kind == "record_struct_declaration" {
            self.extract_struct(node);
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

    // --- extractors --------------------------------------------------------------

    fn extract_class(&mut self, node: Node<'t>) {
        // skipBodilessClass unset: a bodiless `record Empty;` still mints a node.
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default() // isExported hook absent → flag not present
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.extract_primary_ctor_param_refs(node, row);
        // extractDecoratorsFor: C# attributes never match its accepted node
        // types (attribute_list is skipped, its children never reached) —
        // zero `decorates` refs; the call slot emits nothing.

        self.stack.push(Scope { row, kind: "class", name });
        // body ?? node: a bodiless record's own children are iterated
        // "harmlessly" — visit_node on identifier/parameter_list/base_list
        // children falls through (base-arg identifiers still feed fn-ref
        // capture, mirroring the TS walk).
        let body = node.child_by_field_name("body").unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        // no synthesizeMembers for C#
        self.stack.pop();
    }

    fn extract_struct(&mut self, node: Node<'t>) {
        // Body gate — EXCEPT C# positional records (`record struct M(…);`,
        // node type record_declaration), complete definitions with no body.
        // A bodiless `struct Fwd;` mints NO node. (#831)
        let body = node.child_by_field_name("body");
        if body.is_none() && node.kind() != "record_declaration" {
            return;
        }
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("struct", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.extract_primary_ctor_param_refs(node, row);
        // NOTE: extractStruct does NOT call extractDecoratorsFor (TS parity).
        if let Some(body) = body {
            self.stack.push(Scope { row, kind: "struct", name });
            for i in 0..body.named_child_count() {
                if let Some(c) = body.named_child(i) {
                    self.visit_node(c);
                }
            }
            self.stack.pop();
        }
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
        // The underlying type (`enum ReadType : byte`) sits in base_list →
        // an `extends` ref named `byte` (garbage, PRESERVE).
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if child.kind() == "enum_member_declaration" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    fn extract_enum_members(&mut self, node: Node<'t>) {
        // name-field path: one enum_member node positioned at the MEMBER node
        // (attributes included in its span); values/attributes ignored.
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
        // (identifier-children / leaf fallbacks are other grammars' shapes)
    }

    /// extractProperty (1986) — property_declaration only (dispatch-gated to
    /// class-like scopes). Accessor bodies and `=>` value clauses are never
    /// walked; type refs DO come from the `type` field.
    fn extract_property(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = Some(self.visibility_of(node));
        let is_static = Some(self.is_static(node)); // ?? false — always concrete

        let name_node = node
            .child_by_field_name("name")
            .or_else(|| node.child_by_field_name("property"))
            .or_else(|| {
                (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .find(|c| c.kind() == "identifier")
            });
        let Some(name_node) = name_node else { return };
        let name = self.text(name_node).to_string();
        if name.is_empty() {
            return;
        }

        // Generic scan (isTsJsField=false): FIRST namedChild that isn't a
        // modifier/name/accessor/initializer. A BARE-identifier declared type
        // (`public Widget Parent {get;}`) is excluded by the `identifier`
        // filter → the signature loses its type (QUIRK, preserve); the type
        // ref below still fires via the `type` FIELD.
        let type_node = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| {
                !matches!(
                    c.kind(),
                    "modifier" | "modifiers" | "identifier" | "accessor_list" | "accessors"
                        | "equals_value_clause"
                )
            });
        let type_text = type_node.map(|t| {
            let raw = self.text(t);
            // TS `.replace(/^:\s*/, '')` — inert for C# type text; mirrored.
            match raw.strip_prefix(':') {
                Some(rest) => rest.trim_start_matches(is_js_space).to_string(),
                None => raw.to_string(),
            }
        });
        let signature = match &type_text {
            Some(t) => format!("{t} {name}"),
            None => name.clone(),
        };

        let row = self.create_node(
            "property",
            &name,
            node,
            Extra { docstring, signature: Some(signature), visibility, is_static, ..Extra::default() },
        );
        if let Some(row) = row {
            // decorators: none for C#; then the csharp type-ref path.
            self.extract_csharp_type_refs(node, row);
        }
    }

    /// extractField (2046) — field_declaration; each declarator becomes a
    /// field/constant node anchored at the DECLARATOR.
    fn extract_field(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let visibility = Some(self.visibility_of(node));
        let is_static = Some(self.is_static(node));
        // `const` / `static readonly` → constant (value-ref targets).
        let field_kind: &'static str = if self.is_const(node) { "constant" } else { "field" };

        // Direct declarators (Java shape) — none for C#; the wrapper path:
        let mut declarators: Vec<Node> = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .filter(|c| c.kind() == "variable_declarator")
            .collect();
        let var_decl = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "variable_declaration");
        if declarators.is_empty() {
            if let Some(vd) = var_decl {
                declarators = (0..vd.named_child_count())
                    .filter_map(|i| vd.named_child(i))
                    .filter(|c| c.kind() == "variable_declarator")
                    .collect();
            }
        }
        // (PHP property_element branch: unreachable for C#.)

        if !declarators.is_empty() {
            let type_search = var_decl.unwrap_or(node);
            let type_node = (0..type_search.named_child_count())
                .filter_map(|i| type_search.named_child(i))
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
                    // decorators: none; type refs from the OUTER declaration —
                    // multi-declarator fields emit the type refs once PER
                    // declarator, each from its own field node.
                    self.extract_csharp_type_refs(node, row);
                }
            }
        } else {
            // Bare fallback (unreachable on non-erroring C#; ported for shape).
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

    /// extractMethod (1737) — method_declaration + constructor_declaration.
    /// Signature is ALWAYS undefined (no getSignature hook); isAsync is real.
    fn extract_method(&mut self, node: Node<'t>) {
        if !self.inside_class_like() {
            // Unreachable on non-erroring C# (top-level `void M(){}` parses as
            // local_function_statement; erroring files defer) — mirror the TS
            // treat-as-function tail for shape.
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };
        // extractTypeAnnotations short-circuits into the csharp path:
        // `returns`-field refs FIRST, then per-parameter type refs.
        self.extract_csharp_type_refs(node, row);
        // decorators: none.
        self.stack.push(Scope { row, kind: "method", name });
        // The `body` FIELD only (block or arrow_expression_clause). A
        // constructor_initializer (`: base(args)`) is NOT the body → its
        // argument calls are LOST (quirk, preserve).
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    /// extractFunction — only reachable for a method outside any class
    /// (unreachable on non-erroring C#; kept faithful to the generic tail).
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
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
            return_type: self.return_type_of(node),
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        self.extract_csharp_type_refs(node, row);
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_variable(&mut self, node: Node<'t>) {
        // extractVariable's generic fallback: direct identifier /
        // variable_declarator children only — C# nests declarators inside
        // variable_declaration, so this NEVER fires (`var x = F();` at top
        // level produces no node, no calls ref, no instantiates — preserve).
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

    /// extractImport via csharpExtractor.extractImport: moduleName = first
    /// qualified_name child's text, else first identifier's — with the alias
    /// quirks (alias-to-qualified keeps generic args on the TARGET text;
    /// alias-to-identifier captures the ALIAS name) preserved verbatim.
    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let target = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "qualified_name")
            .or_else(|| {
                (0..node.named_child_count())
                    .filter_map(|i| node.named_child(i))
                    .find(|c| c.kind() == "identifier")
            });
        let Some(target) = target else { return }; // hook declined → no node, no ref
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
        // One generic `imports` ref from the stack top (the namespace node in
        // a namespaced file, else the file node). No per-binding emitter.
        let parent = self.top_row();
        self.push_ref_at(parent, &module_name.clone(), edge_kind_index("imports").unwrap(), node);
    }

    /// extractCall — the C# branch (tree-sitter.ts:4502) + shared tail.
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };

        let mut callee_name: String;
        if func.kind() == "member_access_expression" {
            let recv = func.child_by_field_name("expression");
            let name_node = func.child_by_field_name("name");
            let method_name = name_node.map(|n| self.text(n)).unwrap_or("");
            let chained = recv
                .map(|r| r.kind() == "invocation_expression" && !method_name.is_empty())
                .unwrap_or(false);
            if chained {
                // Chained factory `Foo.Create(args).Bar()` → `Foo.Create().Bar`
                // (inner whitespace stripped, EVERY call-receiver re-encodes —
                // no capitalization gate, unlike kotlin/scala).
                let inner_func = recv.unwrap().child_by_field_name("function");
                let inner_callee = inner_func.map(|f| strip_js_ws(self.text(f))).unwrap_or_default();
                callee_name = if inner_callee.is_empty() {
                    method_name.to_string()
                } else {
                    format!("{inner_callee}().{method_name}")
                };
            } else {
                // RAW full member-access text: `this.Run`, `base.Method`,
                // `"lit".ToUpper`, multi-line fluent chains with their
                // newlines — no SKIP_RECEIVERS, no literal filter (preserve).
                callee_name = self.text(func).to_string();
            }
        } else {
            // Bare `Helper()`, generic `Generic<int>` kept verbatim,
            // `nameof(...)` → a calls ref named `nameof`, `?.` chains raw,
            // `(myDel)(x)` → parenthesized text (normalized below).
            callee_name = self.text(func).to_string();
        }

        // Shared parenthesized-conversion normalization — the one shared
        // normalization C# actually hits: `(myDel)(x)` → `myDel`.
        if !callee_name.is_empty() {
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
        }
        // (template strip + fn-ptr fan-out are c/cpp-gated — not C#.)

        if !callee_name.is_empty() {
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
        // `new List<Foo>()` → `List`; `new Ns.Foo()` → `Foo`. Target-typed
        // `new()` / anonymous `new { }` / arrays `new T[n]` never reach here
        // (not in INSTANTIATION_KINDS) — invisible by design.
        let class_name = strip_generic_and_qualifier(self.text(ctor));
        if !class_name.is_empty() {
            let from = self.top_row();
            self.push_ref_at(from, &class_name, edge_kind_index("instantiates").unwrap(), node);
        }
    }

    /// extractAnonymousClass — `new T() { ... }`. The C# grammar never
    /// produces a class_body/declaration_list child on object_creation
    /// (object initializers are initializer_expression), so this is
    /// unreachable — mirrored from the shared TS path like java.rs.
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

    /// extractStaticMemberRef — csharp ∈ STATIC_MEMBER_LANGS; C#'s
    /// member-access node with the `expression` receiver field.
    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if node.kind() != "member_access_expression" {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let owner = self.top_row();
        // Skip `Type.Method()` — the access is a call's callee, already linked.
        if let Some(parent) = node.parent() {
            if parent.kind() == "invocation_expression" {
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

    /// extractInheritance — the C# base_list branch (5577): EVERY namedChild
    /// emits one `extends` ref (interfaces conflated by design; the garbage
    /// `(repo)` argument-list / `BaseDto(Name)` / `: byte` shapes preserved).
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "base_list" {
                continue;
            }
            for j in 0..child.named_child_count() {
                let Some(base) = child.named_child(j) else { continue };
                let name = if base.kind() == "generic_name" {
                    // `ClientBase<T>` → head identifier; position = generic_name.
                    let ident = (0..base.named_child_count())
                        .filter_map(|k| base.named_child(k))
                        .find(|c| c.kind() == "identifier");
                    match ident {
                        Some(idn) => self.text(idn).to_string(),
                        None => self.text(base).to_string(),
                    }
                } else {
                    self.text(base).to_string()
                };
                self.push_ref_at(class_row, &name, extends_kind, base);
            }
        }
    }

    // --- C# type-reference engine (extractCsharpTypeRefs, 5893) -----------------

    fn extract_csharp_type_refs(&mut self, node: Node<'t>, from_row: u32) {
        // Property `type` / method `returns` (a node carries only one).
        let direct = node
            .child_by_field_name("type")
            .or_else(|| node.child_by_field_name("returns"));
        if let Some(t) = direct {
            self.walk_type_position(t, from_row);
        }
        // Field declarations: the variable_declaration wrapper's `type` field.
        let var_decl = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "variable_declaration");
        if let Some(vd) = var_decl {
            if let Some(t) = vd.child_by_field_name("type") {
                self.walk_type_position(t, from_row);
            }
        }
        // Method/constructor parameters: ONLY each `parameter`'s `type` field.
        if let Some(params) = node.child_by_field_name("parameters") {
            for i in 0..params.named_child_count() {
                let Some(p) = params.named_child(i) else { continue };
                if p.kind() != "parameter" {
                    continue;
                }
                if let Some(t) = p.child_by_field_name("type") {
                    self.walk_type_position(t, from_row);
                }
            }
        }
    }

    /// extractCsharpPrimaryCtorParamRefs (5938) — the class/struct/record
    /// primary constructor's parameter_list (an unnamed-field child).
    fn extract_primary_ctor_param_refs(&mut self, node: Node<'t>, owner_row: u32) {
        let param_list = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "parameter_list");
        let Some(param_list) = param_list else { return };
        for i in 0..param_list.named_child_count() {
            let Some(p) = param_list.named_child(i) else { continue };
            if p.kind() != "parameter" {
                continue;
            }
            if let Some(t) = p.child_by_field_name("type") {
                self.walk_type_position(t, owner_row);
            }
        }
    }

    /// walkCsharpTypePosition (5955).
    fn walk_type_position(&mut self, node: Node<'t>, from_row: u32) {
        match node.kind() {
            "predefined_type" => {}
            "identifier" => {
                let name = self.text(node);
                if !name.is_empty() && !is_builtin_type(name) {
                    self.push_ref_at(from_row, &name.to_string(), edge_kind_index("references").unwrap(), node);
                }
            }
            "qualified_name" => {
                // Rightmost segment is the type; position = the whole node.
                let text = self.text(node);
                let last = text.rsplit('.').next().unwrap_or(text);
                if !last.is_empty() && !is_builtin_type(last) {
                    self.push_ref_at(from_row, &last.to_string(), edge_kind_index("references").unwrap(), node);
                }
            }
            "tuple_element" => {
                // Walk the type field only — never the element NAME.
                if let Some(t) = node.child_by_field_name("type") {
                    self.walk_type_position(t, from_row);
                }
            }
            _ => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        self.walk_type_position(c, from_row);
                    }
                }
            }
        }
    }

    // --- function-as-value refs (CSHARP_SPEC, function-ref.ts:250) --------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        #[derive(PartialEq)]
        enum Mode {
            Args,
            Rhs,
            List,
            Varinit,
        }
        let mode = match node.kind() {
            "argument_list" => Mode::Args,
            "assignment_expression" => Mode::Rhs, // covers `+=` event subscription
            "initializer_expression" => Mode::List,
            "variable_declarator" => Mode::Varinit,
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
                    // Param-storage skip: `this.status = status`.
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
                // No `value` field on C# variable_declarator: the initializer
                // is the LAST named child — but an initializer-less declarator
                // has its NAME there. Require ≥2 named children and never pick
                // the name child. (Destructuring pattern gate never matches C#.)
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
                if !is_destructuring && node.named_child_count() >= 2 {
                    if let Some(value) = node.named_child(node.named_child_count() - 1) {
                        let is_name = name_child.map(|nc| nc.id() == value.id()).unwrap_or(false);
                        if !is_name {
                            values.push(value);
                        }
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue (function-ref.ts:525) for CSHARP_SPEC: bare identifiers,
    /// the transparent `argument` layer, and the `this.Member` special.
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v);
                self.push_fn_ref_cand(from, name, v);
            }
            "argument" => {
                // Transparent layer (field=null) → recurse all named children.
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            "member_access_expression" => {
                // `this.Run0` — receiver must be EXACTLY `this` (the vendored
                // grammar yields the anonymous `this` token via the field;
                // text-prefix fallback for field-less shapes). Candidate is
                // the BARE member name at the name node's position.
                let Some(name_node) = v.child_by_field_name("name") else { return };
                let is_this = match v.child_by_field_name("expression") {
                    Some(e) => e.kind() == "this_expression" || e.kind() == "this",
                    None => self.text(v).starts_with("this."),
                };
                if is_this {
                    let name = self.text(name_node);
                    self.push_fn_ref_cand(from, name, name_node);
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
        // functionTypes is EMPTY for C#; the literal halt list applies —
        // lambda_expression IS C#'s lambda, so initializer lambdas stop the
        // scan; anonymous_method_expression is NOT listed and scans through.
        if depth > 0
            && matches!(
                node.kind(),
                "arrow_function" | "function_expression" | "lambda_literal" | "lambda_expression"
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
            // C# candidates are always bare names (its this-forms normalize to
            // the bare member), so the `this.`/`::` bypasses are inert — kept
            // for shared-shape parity. Gate: definedHere ∪ importedNames.
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

    // --- value references --------------------------------------------------------

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

        // Shadow prune: count every variable_declarator declaring a target
        // name (field declarators AND method-body/top-level locals); more
        // declarations than file-scope captures → shadowed → dropped.
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
            // (property_declaration's bump is structurally null for C# — not ported.)
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
/// anonymous-class extraction: strip `<...` from the first `<` (index > 0),
/// keep the segment after the last `.`/`::`, strip ONE leading `:` or `.`,
/// trim. (The vbnet paren strip in the TS path is vbnet-gated — inert here.)
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
