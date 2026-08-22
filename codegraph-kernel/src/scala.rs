//! Scala extraction — a faithful Rust port of the scala paths of
//! `TreeSitterExtractor` (src/extraction/tree-sitter.ts) plus
//! languages/scala.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The authoritative quirk list is docs/design/scala-kernel-port-checklist.md —
//! including the load-bearing oddities this file preserves on purpose:
//! functionTypes is EMPTY so every def routes through extractMethod (top level
//! falls back to a `function` node); NO namespace node ever (package headers
//! ignored, QNs bare); imports are named the FIRST path segment (`import
//! com.example.C` → `com`); the val/var hook keys on the enclosing-definition
//! NODE TYPE (object vals → constants, class/trait/enum/given vals → fields)
//! and consumes the initializer (no calls/instantiates from hook-consumed
//! initializers); extension methods mint NO nodes (the first def's body calls
//! leak to the enclosing scope, every later def is invisible, and the braced
//! form resolves its `body` field to the `{` TOKEN — whole extension
//! invisible); anonymous `new T { … }` bodies leak their defs to the
//! enclosing scope (findAnonymousClassBody misses template_body); nested
//! defs in bodies mint NOTHING (inverse of kotlin); the bodied-vs-bodiless
//! class asymmetry (bodiless headers walk class_parameters → default-value
//! calls emit from the class; bodied ones never see them); curried signatures
//! keep only the FIRST parameter list and type params win the `parameters`
//! field; static-member WRITES emit (unlike kotlin); infix calls are
//! invisible; `derives` emits nothing; value-ref same-name targets take the
//! LAST registration. Positions in UTF-16 code units. Files with parse errors
//! defer to wasm — including scala-3 PHANTOM hasError files (flag-true, zero
//! ERROR nodes): trust the flag.

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

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts:373-388).
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

/// BUILTIN_TYPES (tree-sitter.ts:5768-5782) — the shared cross-language table.
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

/// SCALA_BUILTIN_TYPES (languages/scala.ts:14-17) — the hook's OWN smaller set.
fn is_scala_builtin(name: &str) -> bool {
    matches!(
        name,
        "Int" | "Long" | "Short" | "Byte" | "Float" | "Double" | "Boolean" | "Char" | "Unit"
            | "String" | "Any" | "AnyRef" | "AnyVal" | "Nothing" | "Null"
    )
}

/// extractScalaReturnType's simple-name gate (`/^[A-Za-z_]\w*$/`).
fn simple_type_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
/// extractScalaReturnType's generic-args strip (`/\[[^\]]*\]/g`).
fn bracket_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap())
}
/// Static-member receiver gate (`/^[A-Z][A-Za-z0-9_]*$/`).
fn cap_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
/// The #750 re-encode gate (`/^[A-Z]/`).
fn starts_upper_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z]").unwrap())
}
/// JS `\s+` for the re-encode/return-type strips (Unicode whitespace).
fn ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

struct Cand {
    from: u32,
    name: String,
    line: u32,
    column_byte: usize,
    row: usize,
}

struct ValueScope<'t> {
    row: u32,
    node: Node<'t>,
    name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    /// 0 = absent; 1 public, 2 private, 3 protected.
    visibility: u8,
    /// (present, value) — isAsync/isStatic are literal-false hooks for scala.
    is_async: Option<bool>,
    is_static: Option<bool>,
    return_type: Option<String>,
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
    let grammar = crate::langs::grammar_for("scala").ok_or("no scala grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(scala) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    if tree.root_node().has_error() {
        // Includes scala-3 PHANTOMS (flag-true, zero ERROR nodes) — the flag
        // is the policy, never node-scanning.
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

    // File node (tree-sitter.ts:508-521).
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

    // No packageTypes → no namespace node, ever.
    w.visit(tree.root_node());
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
    /// isInsideClassLikeNode (:1486) — stack-top kind only.
    fn inside_class_like(&self) -> bool {
        self.stack
            .last()
            .map(|s| matches!(s.kind, "class" | "struct" | "interface" | "trait" | "enum" | "module"))
            .unwrap_or(false)
    }

    fn push_ref_at(&mut self, from_row: u32, name: &str, kind: &str, node: Node) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: edge_kind_index(kind).unwrap(),
            line: self.line_of(node),
            column: self.col_of(node),
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        // flushFnRefCandidates' importedNames (tree-sitter.ts:661-675). Scala
        // import refs are named the FIRST path segment — always SIMPLE_NAME.
        if kind == "imports" {
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    // --- createNode (tree-sitter.ts:1308) ---------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);

        // buildQualifiedName (:1447-1460) — non-file stack names, `::`-joined;
        // namespacePrefix always empty (no C++ namespaces, no scala namespace).
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

        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility,
            flags,
            start_line,
            end_line: node.end_position().row as u32 + 1, // no resolveBody hook
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
        self.node_ids.push(id.clone());
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }

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

        // captureValueRefScope (:735-767).
        if (kind == "constant" || kind == "variable")
            && util::utf16_len(name) >= 3
            && util::has_upper_or_underscore().is_match(name)
        {
            let parent_ok = self
                .stack
                .last()
                .map(|s| matches!(s.kind, "file" | "class" | "module" | "struct" | "enum"))
                .unwrap_or(false);
            if parent_ok {
                self.fs_values.insert(name.to_string(), row); // LAST wins
                *self.fs_value_counts.entry(name.to_string()).or_insert(0) += 1;
            }
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope { row, node, name: name.to_string() });
        }

        Some(row)
    }

    // --- languages/scala.ts helper transcriptions -------------------------

    /// getValVarName (scala.ts:5-11).
    fn val_var_name(&self, node: Node<'t>) -> Option<&'t str> {
        let pattern = node.child_by_field_name("pattern")?;
        if pattern.kind() == "identifier" {
            return Some(self.text(pattern));
        }
        let mut cursor = pattern.walk();
        for c in pattern.named_children(&mut cursor) {
            if c.kind() == "identifier" {
                return Some(self.text(c));
            }
        }
        None
    }

    /// extractVisibility (scala.ts:69-80) → wire byte (1 public default).
    fn visibility_of(&self, node: Node<'t>) -> u8 {
        let mut cursor = node.walk();
        for c in node.named_children(&mut cursor) {
            if c.kind() == "modifiers" || c.kind() == "access_modifier" {
                let t = self.text(c);
                if t.contains("private") {
                    return 2;
                }
                if t.contains("protected") {
                    return 3;
                }
            }
        }
        1
    }

    /// isStatic (scala.ts:123-129) — text scan, effectively always false.
    fn is_static_of(&self, node: Node<'t>) -> bool {
        let mut cursor = node.walk();
        for c in node.named_children(&mut cursor) {
            if c.kind() == "modifiers" && self.text(c).contains("static") {
                return true;
            }
        }
        false
    }

    /// getSignature (scala.ts:110-117) — first-match-wins fields: curried
    /// defs keep only the first list; a type_parameters node carrying field
    /// `parameters` wins over the value list.
    fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let params = node.child_by_field_name("parameters");
        let ret = node.child_by_field_name("return_type");
        if params.is_none() && ret.is_none() {
            return None;
        }
        let mut sig = params.map(|p| self.text(p).to_string()).unwrap_or_default();
        if let Some(r) = ret {
            sig.push_str(": ");
            sig.push_str(self.text(r));
        }
        if sig.is_empty() {
            None
        } else {
            Some(sig)
        }
    }

    /// extractScalaReturnType (scala.ts:56-67).
    fn return_type_of(&self, node: Node<'t>) -> Option<String> {
        let rt = node.child_by_field_name("return_type")?;
        let raw = self.text(rt).trim();
        if raw.starts_with("this.") {
            return None;
        }
        let base = bracket_args_re().replace_all(raw, "");
        let base = ws_re().replace_all(&base, "");
        let last = base.split('.').next_back()?;
        if last.is_empty() || !simple_type_name_re().is_match(last) {
            return None;
        }
        Some(last.to_string())
    }

    /// scalaBaseTypeName (tree-sitter.ts:201-224).
    fn scala_base_type_name(&self, node: Option<Node<'t>>) -> Option<String> {
        let node = node?;
        match node.kind() {
            "type_identifier" | "identifier" => Some(self.text(node).to_string()),
            "generic_type" => self.scala_base_type_name(node.named_child(0)),
            "stable_type_identifier" | "stable_identifier" => {
                let mut cursor = node.walk();
                let last = node
                    .named_children(&mut cursor)
                    .filter(|c| c.kind() == "type_identifier" || c.kind() == "identifier")
                    .last();
                last.map(|n| self.text(n).to_string())
            }
            _ => {
                let mut cursor = node.walk();
                let id = node
                    .named_children(&mut cursor)
                    .find(|c| c.kind() == "type_identifier");
                id.map(|n| self.text(n).to_string())
            }
        }
    }

    /// emitScalaTypeRefs (scala.ts:27-45) — the hook's own builtin set.
    fn emit_scala_type_refs(&mut self, type_node: Node<'t>, from_row: u32) {
        if type_node.kind() == "type_identifier" {
            let name = self.text(type_node);
            if !name.is_empty() && !is_scala_builtin(name) {
                let name = name.to_string();
                self.push_ref_at(from_row, &name, "references", type_node);
            }
            return;
        }
        let mut cursor = type_node.walk();
        let kids: Vec<Node<'t>> = type_node.named_children(&mut cursor).collect();
        for c in kids {
            self.emit_scala_type_refs(c, from_row);
        }
    }

    /// extractName (tree-sitter.ts:98-192) — scala-reachable branches: the
    /// `name` field's raw text (operator glyphs and backticks kept), else the
    /// first identifier-ish child, else `<anonymous>`.
    fn extract_name(&self, node: Node<'t>) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        let mut cursor = node.walk();
        for c in node.named_children(&mut cursor) {
            if matches!(c.kind(), "identifier" | "type_identifier" | "simple_identifier" | "constant") {
                return self.text(c).to_string();
            }
        }
        "<anonymous>".to_string()
    }

    // --- the main walk (visitNode, tree-sitter.ts:936-1303) ---------------

    fn visit(&mut self, node: Node<'t>) {
        // The visitNode hook (scala.ts:131-198) runs FIRST.
        if self.hook(node) {
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        // maybeCaptureFnRefs (:990).
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        match kind {
            // methodTypes (functionTypes is EMPTY — :994 never fires).
            "function_definition" | "function_declaration" => {
                self.extract_method_or_function(node);
                return; // skipChildren
            }
            "class_definition" | "object_definition" => {
                self.extract_class(node, "class");
                return;
            }
            "trait_definition" => {
                self.extract_class(node, "trait");
                return;
            }
            "enum_definition" => {
                self.extract_enum(node);
                return;
            }
            "type_definition" => {
                let skip = self.extract_type_alias(node);
                if skip {
                    return;
                }
                // plain path → false → children re-visited (nothing matches).
            }
            "import_declaration" => {
                self.extract_import(node);
                return; // skipChildren
            }
            "call_expression" => {
                self.extract_call(node);
                // no skipChildren — chains/args re-visited
            }
            "instance_expression" => {
                // INSTANTIATION_KINDS (:1255). findAnonymousClassBody looks
                // for class_body/declaration_list — scala's template_body is
                // neither → extractAnonymousClass never runs → children
                // recursed: anon-body defs LEAK to the enclosing scope.
                self.extract_instantiation(node);
            }
            _ => {}
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    /// The visitNode hook (scala.ts:131-198). Returns true when consumed.
    fn hook(&mut self, node: Node<'t>) -> bool {
        match node.kind() {
            "val_definition" | "var_definition" => {
                let is_val = node.kind() == "val_definition";
                let name = match self.val_var_name(node) {
                    Some(n) => n.to_string(),
                    None => return false,
                };
                // Enclosing-definition NODE-TYPE walk (scala.ts:146-156).
                let mut enclosing: Option<&'static str> = None;
                let mut p = node.parent();
                while let Some(parent) = p {
                    match parent.kind() {
                        "class_definition" => {
                            enclosing = Some("class_definition");
                            break;
                        }
                        "trait_definition" => {
                            enclosing = Some("trait_definition");
                            break;
                        }
                        "enum_definition" => {
                            enclosing = Some("enum_definition");
                            break;
                        }
                        "given_definition" => {
                            enclosing = Some("given_definition");
                            break;
                        }
                        "object_definition" => {
                            enclosing = Some("object_definition");
                            break;
                        }
                        _ => p = parent.parent(),
                    }
                }
                let is_instance_field = matches!(
                    enclosing,
                    Some("class_definition") | Some("trait_definition") | Some("enum_definition")
                        | Some("given_definition")
                );
                let kind: &'static str = if is_instance_field {
                    "field"
                } else if is_val {
                    "constant"
                } else {
                    "variable"
                };
                let type_node = node.child_by_field_name("type");
                let signature = type_node.map(|t| {
                    format!("{} {}: {}", if is_val { "val" } else { "var" }, name, self.text(t))
                });
                let visibility = self.visibility_of(node);
                let created = self.create_node(
                    kind,
                    &name,
                    node,
                    Extra { signature, visibility, ..Default::default() },
                );
                if let (Some(row), Some(t)) = (created, type_node) {
                    self.emit_scala_type_refs(t, row);
                }
                true
            }
            "enum_case_definitions" => {
                let mut cursor = node.walk();
                let cases: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for case in cases {
                    if case.kind() == "simple_enum_case" || case.kind() == "full_enum_case" {
                        if let Some(name_node) = case.child_by_field_name("name") {
                            let name = self.text(name_node).to_string();
                            // ctx.createNode('enum_member', name, child) — no
                            // extras: no docstring/visibility/flags.
                            self.create_node("enum_member", &name, case, Extra::default());
                        }
                    }
                }
                true
            }
            "extension_definition" => {
                // childForFieldName('body') is FIRST-MATCH-WINS over the full
                // (named + anonymous) child list: paren/indent form → the
                // first function_definition (its children visited — no node
                // minted, later defs invisible); braced form → the `{` TOKEN
                // (namedChildCount 0 — whole extension invisible).
                if let Some(body) = node.child_by_field_name("body") {
                    let mut cursor = body.walk();
                    let kids: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
                    for child in kids {
                        self.visit(child);
                    }
                }
                true
            }
            _ => false,
        }
    }

    // --- extractMethod → extractFunction routing (:1737 / :1517) ----------

    fn extract_method_or_function(&mut self, node: Node<'t>) {
        // No receiver hook, no methodsAreTopLevel: inside class-like → method,
        // else → function (the object/object_expression parent check never
        // matches scala node kinds).
        let is_method = self.inside_class_like();
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            // Unreachable for scala defs (name field required) — preserved:
            // walk the body with nothing pushed.
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_body(body);
            }
            return;
        }
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_static = self.is_static_of(node);
        let return_type = self.return_type_of(node);
        let row = self.create_node(
            if is_method { "method" } else { "function" },
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(false),
                is_static: Some(is_static),
                return_type,
            },
        );
        let Some(row) = row else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: if is_method { "method" } else { "function" }, name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass (:1679) — classes, objects, traits ------------------

    fn extract_class(&mut self, node: Node<'t>, kind: &'static str) {
        let resolved_body = node.child_by_field_name("body"); // template_body
        // No skipBodilessClass — bodiless mints (scala-complete).
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            kind,
            &name,
            node,
            Extra { docstring, visibility, ..Default::default() },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind, name });
        // THE ASYMMETRY: bodiless classes walk the node ITSELF — header
        // children (class_parameters defaults, extends args) reach the
        // ladder; bodied classes walk only template_body children.
        let body = resolved_body.unwrap_or(node);
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
        self.stack.pop();
    }

    // --- extractEnum (:1914) ----------------------------------------------

    fn extract_enum(&mut self, node: Node<'t>) {
        let body = match node.child_by_field_name("body") {
            Some(b) => b,
            None => return, // bodiless enum mints nothing
        };
        let name = self.extract_name(node);
        let docstring = preceding_docstring(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "enum",
            &name,
            node,
            Extra { docstring, visibility, ..Default::default() },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        // No extractDecoratorsFor on the enum path (annotated enums emit no
        // decorates — shared-pipeline behavior).
        self.stack.push(Scope { row, kind: "enum", name });
        // enumMemberTypes is EMPTY → every body child goes through visitNode
        // (enum_case_definitions hits the hook; defs become methods).
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
        self.stack.pop();
    }

    // --- extractTypeAlias (:2890, plain path :2967-2991) ------------------

    /// Returns skipChildren — always false on the scala plain path.
    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.src);
        // isExported hook absent; visibility not read on this path. The
        // alias-value ref walk reads field 'value' — scala's field is 'type'
        // → no reference to the aliased type, ever.
        self.create_node("type_alias", &name, node, Extra { docstring, ..Default::default() });
        false
    }

    // --- extractImport (:3170-3236) ---------------------------------------

    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim();
        // extractImport hook (scala.ts:200-211): `path` field is FIRST-MATCH-
        // WINS → the FIRST dotted segment names the import.
        let module = if let Some(path) = node.child_by_field_name("path") {
            Some(self.text(path))
        } else {
            let mut cursor = node.walk();
            let mut found = None;
            for c in node.named_children(&mut cursor) {
                if c.kind() == "identifier" || c.kind() == "stable_identifier" {
                    found = Some(self.text(c));
                    break;
                }
            }
            found
        };
        let Some(module) = module else { return };
        let module = module.to_string();
        let signature = import_text.to_string();
        let created = self.create_node(
            "import",
            &module,
            node,
            Extra { signature: Some(signature), ..Default::default() },
        );
        // Generic imports ref (:3183-3194) — hook sets no handledRefs.
        if created.is_some() && !module.is_empty() && !self.stack.is_empty() {
            let parent_row = self.top_row();
            self.push_ref_at(parent_row, &module, "imports", node);
        }
    }

    // --- extractCall (:3684) ----------------------------------------------

    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };

        let mut callee: Option<String> = None;
        if func.kind() == "field_expression" {
            // Member branch (:4364): property = `field` field for scala.
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
                if let Some(receiver) = receiver {
                    if is_literal_receiver(receiver.kind()) {
                        return; // literal receivers emit NOTHING (#1230)
                    }
                    if matches!(receiver.kind(), "identifier" | "simple_identifier" | "field_identifier") {
                        let recv_name = self.text(receiver);
                        if matches!(recv_name, "self" | "this" | "cls" | "super") {
                            callee = Some(method_name.to_string());
                        } else {
                            callee = Some(format!("{recv_name}.{method_name}"));
                        }
                    } else if receiver.kind() == "call_expression" {
                        // The #750 re-encode, scala arm (:4443-4464): inner
                        // callee via the REAL `function` field; re-encode only
                        // capitalized (companion-factory / apply) chains.
                        let inner_fn = receiver.child_by_field_name("function");
                        let inner_callee = inner_fn
                            .map(|f| {
                                let t = self.text(f).replace("->", ".");
                                ws_re().replace_all(&t, "").into_owned()
                            })
                            .unwrap_or_default();
                        let reencode = starts_upper_re().is_match(&inner_callee);
                        callee = Some(if reencode {
                            format!("{inner_callee}().{method_name}")
                        } else {
                            method_name.to_string()
                        });
                    } else {
                        callee = Some(method_name.to_string());
                    }
                } else {
                    callee = Some(method_name.to_string());
                }
            }
        } else {
            // Else branch (:4518-4520): RAW func text (apply-sugar `WidgetS`,
            // `genericCall[Int]` type args kept, curried `curried(1)` inners).
            callee = Some(self.text(func).to_string());
        }

        let Some(mut callee) = callee else { return };
        // Parenthesized-conversion (:4529-4532).
        if let Some(caps) = util::paren_conversion().captures(&callee) {
            if let Some(inner) = caps.get(1) {
                callee = inner.as_str().to_string();
            }
        }
        if callee.is_empty() {
            return;
        }
        self.push_ref_at(caller_row, &callee, "calls", node);
    }

    // --- extractInstantiation (:4610, scala arm :4647-4662) ---------------

    fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let from_row = self.top_row();
        let ctor = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let Some(ctor) = ctor else { return };
        if let Some(name) = self.scala_base_type_name(Some(ctor)) {
            self.push_ref_at(from_row, &name, "instantiates", node);
        }
    }

    // --- extractStaticMemberRef (:4750-4808) ------------------------------

    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let owner_row = self.top_row();
        // MEMBER_ACCESS_TYPES — only field_expression occurs in scala trees.
        if !matches!(
            node.kind(),
            "field_access" | "member_access_expression" | "navigation_expression"
                | "field_expression" | "class_constant_access_expression"
                | "scoped_property_access_expression" | "qualified_identifier"
        ) {
            return;
        }
        // Callee-of-call skip: `Type.method()`'s callee access is already a
        // calls ref.
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
            if cap_ident_re().is_match(text) {
                let text = text.to_string();
                self.push_ref_at(owner_row, &text, "references", recv);
            }
        }
    }

    // --- extractDecoratorsFor (:4897-5024) --------------------------------

    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        // consider(): scala annotations are `annotation` nodes; the name is
        // the first identifier-ish child (type_identifier for scala), with
        // call_expression unwrap for invoked decorators.
        // Scan 1: direct children (+ modifiers descent — inert for scala,
        // annotations aren't inside modifiers in this grammar, but ported).
        let mut cursor = decl.walk();
        let kids: Vec<Node<'t>> = decl.named_children(&mut cursor).collect();
        for child in kids {
            self.consider_decorator(child, decorated_row);
            if child.kind() == "modifiers" {
                let mut mc = child.walk();
                let inner: Vec<Node<'t>> = child.named_children(&mut mc).collect();
                for m in inner {
                    self.consider_decorator(m, decorated_row);
                }
            }
        }
        // Scan 2: preceding siblings (TS class style — inert for scala where
        // annotations are children, ported for fidelity).
        if let Some(parent) = decl.parent() {
            let decl_start = decl.start_byte();
            let mut decl_idx: Option<usize> = None;
            for i in 0..parent.named_child_count() {
                if let Some(sib) = parent.named_child(i) {
                    if sib.start_byte() == decl_start {
                        decl_idx = Some(i);
                        break;
                    }
                }
            }
            if let Some(di) = decl_idx {
                for j in (0..di).rev() {
                    let Some(sib) = parent.named_child(j) else { continue };
                    if !matches!(sib.kind(), "decorator" | "annotation" | "marker_annotation") {
                        break;
                    }
                    self.consider_decorator(sib, decorated_row);
                }
            }
        }
    }

    fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        if !matches!(n.kind(), "decorator" | "annotation" | "marker_annotation" | "attribute") {
            return;
        }
        let mut target: Option<Node<'t>> = None;
        let mut cursor = n.walk();
        let kids: Vec<Node<'t>> = n.named_children(&mut cursor).collect();
        for child in kids {
            if child.kind() == "call_expression" {
                let fnn = child.child_by_field_name("function").or_else(|| child.named_child(0));
                if let Some(f) = fnn {
                    target = Some(f);
                }
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
        let mut name = self.text(target).to_string();
        if let Some(lt) = name.find('<') {
            if lt > 0 {
                name.truncate(lt);
            }
        }
        let last_dot = name.rfind('.').map(|i| i as i64).unwrap_or(-1);
        let last_colons = name.rfind("::").map(|i| (i + 1) as i64).unwrap_or(-1);
        let last = last_dot.max(last_colons);
        if last >= 0 {
            name = name[(last as usize + 1)..].to_string();
            name = name.trim_start_matches([':', '.']).to_string();
        }
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        self.push_ref_at(decorated_row, &name, "decorates", n);
    }

    // --- extractInheritance — the scala branch (:5339-5360) ---------------

    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in kids {
            if matches!(
                child.kind(),
                "extends_clause" | "superclass" | "base_clause" | "extends_interfaces"
            ) {
                // Iterate ALL supertypes (with-chains, comma form); unwrap
                // each via scalaBaseTypeName; `arguments` children → None →
                // skipped. `derives_clause` is a different kind — silent.
                let mut cc = child.walk();
                let targets: Vec<Node<'t>> = child.named_children(&mut cc).collect();
                for target in targets {
                    if let Some(name) = self.scala_base_type_name(Some(target)) {
                        self.push_ref_at(class_row, &name, "extends", target);
                    }
                }
            }
        }
    }

    // --- extractTypeAnnotations (:5788-5880) ------------------------------

    fn extract_type_annotations(&mut self, node: Node<'t>, row: u32) {
        // Scala walks EVERY `parameters`-TYPE child (all curried lists; the
        // type_parameters node is a different kind, matched by walk 3).
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for pc in &kids {
            if pc.kind() == "parameters" {
                self.type_refs_from_subtree(*pc, row);
            }
        }
        if let Some(rt) = node.child_by_field_name("return_type") {
            self.type_refs_from_subtree(rt, row);
        }
        // Context/upper bounds: the first type_parameters child.
        if let Some(tp) = kids.iter().find(|c| c.kind() == "type_parameters") {
            self.type_refs_from_subtree(*tp, row);
        }
        // Direct type_annotation child — no such scala kind; ported cheaply.
        if let Some(ta) = kids.iter().find(|c| c.kind() == "type_annotation") {
            self.type_refs_from_subtree(*ta, row);
        }
    }

    fn type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        if node.kind() == "type_identifier" {
            let name = self.text(node);
            if !name.is_empty() && !is_builtin_type(name) {
                let name = name.to_string();
                self.push_ref_at(from_row, &name, "references", node);
            }
            return;
        }
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for c in kids {
            self.type_refs_from_subtree(c, from_row);
        }
    }

    // --- visitFunctionBody (:5129-5286) — scala rows ----------------------

    fn visit_body(&mut self, node: Node<'t>) {
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        if kind == "call_expression" {
            self.extract_call(node);
            // falls through to recursion
        } else if kind == "instance_expression" {
            // instantiates + recursion (findAnonymousClassBody null): anon
            // template_body defs are NOT dispatched here (functionTypes
            // empty; methodTypes not checked in this walker) — their calls
            // attribute to the enclosing method.
            self.extract_instantiation(node);
        }

        self.extract_static_member_ref(node);

        // Nested named defs mint NOTHING (:5245 checks functionTypes — EMPTY;
        // the inverse of kotlin). Body-local classes/objects/traits/enums DO
        // extract fully.
        match kind {
            "class_definition" | "object_definition" => {
                self.extract_class(node, "class");
                return;
            }
            "trait_definition" => {
                self.extract_class(node, "trait");
                return;
            }
            "enum_definition" => {
                self.extract_enum(node);
                return;
            }
            _ => {}
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit_body(child);
        }
    }

    // --- function-as-value capture (#756) — SCALA_SPEC --------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "arguments" => ("args", ""),
            "assignment_expression" => ("rhs", "right"),
            "val_definition" => ("varinit", "value"),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            "args" => {
                let mut cursor = node.walk();
                for c in node.named_children(&mut cursor) {
                    values.push(c);
                }
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
                    // Param-storage skip: lhs tail == rhs text.
                    let lhs = node
                        .child_by_field_name("left")
                        .or_else(|| node.child_by_field_name("lhs"))
                        .or_else(|| node.child_by_field_name("target"))
                        .or_else(|| {
                            if node.named_child_count() >= 2 {
                                node.named_child(0)
                            } else {
                                None
                            }
                        });
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    if !(lhs_last.is_some() && lhs_last == Some(self.text(rhs).trim())) {
                        values.push(rhs);
                    }
                }
            }
            _ => {
                // varinit — destructuring patterns capture nothing.
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
                if let Some(v) = node.child_by_field_name(field) {
                    values.push(v);
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with SCALA_SPEC's unwrap (postfix_expression → first
    /// named child — eta-expansion `handler _`). No layers.
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v).to_string();
                if name.is_empty() || is_stoplisted(&name) {
                    return;
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
            "postfix_expression" => {
                if let Some(inner) = v.named_child(0) {
                    self.normalize_fn_ref_value(inner, from, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halt list: functionTypes is EMPTY for scala, so only the literal
        // lambda kinds halt — the scan descends into nested
        // function_definitions inside hook-consumed vals.
        if depth > 0
            && matches!(
                node.kind(),
                "arrow_function" | "function_expression" | "lambda_literal" | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for c in children {
            self.scan_fn_ref_subtree(c, depth + 1);
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

    // --- value-reference edges (:398-931) ---------------------------------

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

        // Shadow prune — the scala declarator shape: val_definition /
        // var_definition with an `identifier` pattern (tuple/case-class
        // patterns bump nothing).
        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if matches!(n.kind(), "val_definition" | "var_definition") {
                if let Some(pat) = n.child_by_field_name("pattern") {
                    if pat.kind() == "identifier" {
                        let nm = self.text(pat);
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
            // The Dart/Pascal sibling-body pull (:891) — a next sibling of
            // kind function_body/block joins the scan. Effectively inert for
            // scala (bodies nest) but ported for fidelity.
            if let Some(sib) = scope.node.next_named_sibling() {
                if matches!(sib.kind(), "function_body" | "block") {
                    stack.push(sib);
                }
            }
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

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
