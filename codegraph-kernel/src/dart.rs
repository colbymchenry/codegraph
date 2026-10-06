//! Dart extraction — a faithful Rust port of the dart paths of
//! `TreeSitterExtractor` (src/extraction/tree-sitter.ts) plus
//! languages/dart.ts.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The authoritative quirk list is docs/design/dart-kernel-port-checklist.md.
//! The center of gravity is THE SIBLING-BODY DOUBLE-WALK: dart attaches every
//! function/method body as a NEXT SIBLING of its signature node, and the TS
//! walkers consume the body TWICE — once via resolveBody (attributed to the
//! function/method) and once via the enclosing generic walk (attributed to
//! the file/class). The deterministic result — duplicate local-function
//! nodes with the SAME id under different parents, duplicated
//! calls/instantiates refs, file/class-attributed fn-ref twins — must be
//! reproduced byte-for-byte in the observed interleave; a "helpful" dedupe
//! breaks parity. Other load-bearing oddities preserved on purpose:
//! callTypes is EMPTY (all call refs ride extractBareCall's selector
//! walking in the body walker — cascades are invisible, `?.` encodes like
//! `.`); `ConfigT.load()` double-emits (calls + a static-member references
//! ref — no callee-of-call skip in the dart branch); operator methods mint
//! `method "<anonymous>"`; the unnamed constructor is skipped
//! (isMisparsedFunction) while named ctors/factories — `const` ones and
//! redirecting factories included — are named by the CTOR name with the
//! class as returnType; instance fields mint NO nodes (only
//! static_final_declaration → constant, via the hook); every initializer is
//! body-walked once — a constant's from the constant, a field's or a
//! top-level variable's from the class or the file; prefixed return
//! types keep the PREFIX (`other.OtherClass f()` → returnType `other` —
//! bug, preserved); enum `with` mixins emit nothing while enum `implements`
//! works; deferred imports are invisible; named-argument callbacks are NOT
//! fn-ref-captured; `async*`/`sync*` are NOT async. Positions in UTF-16
//! code units. Files with parse errors defer to wasm (3.4–20.7% both-arm
//! incidence — empty object patterns and unnamed `library;` dominate).

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

/// BUILTIN_TYPES (tree-sitter.ts:5768-5782).
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

/// extractDartReturnType's simple-name gate + the static-member receiver gate.
fn simple_type_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap())
}
fn cap_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
/// The chained-call re-encode gate (`/^[A-Z]/`).
fn starts_upper_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z]").unwrap())
}
/// extractDartReturnType's `<...>` strip (`/<[^>]*>/g`).
fn angle_args_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}

/// The UpperCamel test of isDartTypeName (`/^[_$]*[A-Z]/`) — how Dart writes
/// a type, `_Private` and `$Generated` ones included.
fn is_upper_camel(text: &str) -> bool {
    text.trim_start_matches(&['_', '$'][..])
        .chars()
        .next()
        .map(|c| c.is_ascii_uppercase())
        .unwrap_or(false)
}

/// DART_BODILESS_CTORS (dart.ts) — `const Foo.bar();` and a redirecting
/// factory `const factory Foo.bar() = _Bar;`, each a signature kind of its
/// own inside a `declaration`.
fn is_bodiless_ctor(kind: &str) -> bool {
    matches!(kind, "constant_constructor_signature" | "redirecting_factory_constructor_signature")
}

/// DART_LOWERCASE_TYPES (dart.ts) — Dart's lowercase built-in types, which a
/// type argument can name: `<int>`, `<void>`.
fn is_lowercase_type(name: &str) -> bool {
    matches!(name, "int" | "double" | "num" | "bool" | "dynamic" | "void")
}

/// DART_PREFIXED (dart.ts) — what a callee can sit under in front of a
/// generic call: `await`, `-`, `!`.
fn is_prefixed(kind: &str) -> bool {
    matches!(kind, "unary_expression" | "await_expression")
}

/// DART_COMMENTS (dart.ts) — line and block comments, and dartdoc.
fn is_comment(node: Node) -> bool {
    matches!(node.kind(), "comment" | "documentation_comment")
}

/// dartPrevNamed (dart.ts) — the named sibling before `node`, past comments:
/// `tester //` + newline + `.state(…)` puts the comment, not `tester`, right
/// before the `.state` selector.
fn prev_named<'t>(node: Node<'t>) -> Option<Node<'t>> {
    let mut prev = node.prev_named_sibling();
    while let Some(p) = prev.filter(|p| is_comment(*p)) {
        prev = p.prev_named_sibling();
    }
    prev
}

/// dartNextNamed (dart.ts) — the named sibling after `node`, past comments.
fn next_named<'t>(node: Node<'t>) -> Option<Node<'t>> {
    let mut next = node.next_named_sibling();
    while let Some(n) = next.filter(|n| is_comment(*n)) {
        next = n.next_named_sibling();
    }
    next
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
    /// 0 = absent; 1 public, 2 private.
    visibility: u8,
    is_async: Option<bool>,
    is_static: Option<bool>,
    return_type: Option<String>,
    /// resolveBody-driven endLine extension (LIVE for dart sibling bodies).
    end_line_override: Option<u32>,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    node_id_allocator: ids::NodeIdAllocator,
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
    let grammar = crate::langs::grammar_for("dart").ok_or("no dart grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(dart) failed: {e}"))?;
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
        node_id_allocator: ids::NodeIdAllocator::default(),
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
        // Dart import names are URIs (`package:x/y.dart`) — they match neither
        // SIMPLE_NAME nor QUALIFIED_IMPORT, so importedNames stays empty in
        // practice; ported for fidelity.
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
        let column = self.col_of(node);
        let id = self.node_id_allocator.generate(self.file_path, kind, name, start_line, column);

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

        // endLine extension (:1322-1334) — LIVE for dart: a function/method
        // node's endLine extends to its sibling function_body's end.
        let mut end_line = node.end_position().row as u32 + 1;
        if let Some(ext) = extra.end_line_override {
            if ext > end_line {
                end_line = ext;
            }
        }

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

        // captureValueRefScope (:735-767). Dart mints only `constant` targets.
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
                self.fs_values.insert(name.to_string(), row);
                *self.fs_value_counts.entry(name.to_string()).or_insert(0) += 1;
            }
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope { row, node, name: name.to_string() });
        }

        Some(row)
    }

    // --- languages/dart.ts helper transcriptions --------------------------

    /// dartInnerSignature (dart.ts:9-17).
    fn inner_signature(&self, node: Node<'t>) -> Node<'t> {
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(c.kind(), "function_signature" | "getter_signature" | "setter_signature")
            });
            if let Some(inner) = inner {
                return inner;
            }
        }
        node
    }

    /// dartConstructorSignature (dart.ts:25-35).
    fn constructor_signature(&self, node: Node<'t>) -> Option<Node<'t>> {
        if matches!(node.kind(), "factory_constructor_signature" | "constructor_signature")
            || is_bodiless_ctor(node.kind())
        {
            return Some(node);
        }
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            return node.named_children(&mut cursor).find(|c| {
                matches!(c.kind(), "factory_constructor_signature" | "constructor_signature")
            });
        }
        None
    }

    /// dartEnclosingTypeName (dart.ts:38-50).
    fn enclosing_type_name(&self, node: Node<'t>) -> Option<&'t str> {
        let mut p = node.parent();
        while let Some(parent) = p {
            if matches!(
                parent.kind(),
                "class_definition" | "mixin_declaration" | "extension_declaration" | "extension_type_declaration" | "enum_declaration"
            ) {
                return parent.child_by_field_name("name").map(|n| self.text(n));
            }
            p = parent.parent();
        }
        None
    }

    /// dartCtorInfo (dart.ts:61-70).
    fn ctor_info(&self, node: Node<'t>) -> Option<(String, String)> {
        let ctor = self.constructor_signature(node)?;
        // The names before the parameters: a redirecting factory names its
        // target after them (`factory Foo() = _Impl.named;`).
        let mut cursor = ctor.walk();
        let ids: Vec<Node<'t>> = ctor
            .named_children(&mut cursor)
            .take_while(|c| c.kind() != "formal_parameter_list")
            .filter(|c| c.kind() == "identifier")
            .collect();
        let class_name = self.enclosing_type_name(node)?;
        let first = ids.first()?;
        if self.text(*first) != class_name {
            return None; // misparsed method, not a ctor
        }
        let ctor_name = ids.get(1).map(|n| self.text(*n)).unwrap_or(class_name);
        Some((class_name.to_string(), ctor_name.to_string()))
    }

    /// extractDartReturnType (dart.ts:80-92).
    fn return_type_of(&self, node: Node<'t>) -> Option<String> {
        if let Some((class_name, _)) = self.ctor_info(node) {
            return Some(class_name);
        }
        let sig = self.inner_signature(node);
        let mut cursor = sig.walk();
        let ret = sig
            .named_children(&mut cursor)
            .find(|c| c.kind() == "type_identifier")?;
        let text = angle_args_re().replace_all(self.text(ret), "");
        let text = text.trim();
        let last = text.split('.').next_back()?;
        if last.is_empty() || !simple_type_name_re().is_match(last) {
            return None;
        }
        Some(last.to_string())
    }

    /// isMisparsedFunction (dart.ts:177-188) — skip the UNNAMED constructor,
    /// and a `const` ctor / redirecting factory that names no enclosing type
    /// (error recovery's).
    fn is_misparsed_function(&self, node: Node<'t>) -> bool {
        match self.ctor_info(node) {
            Some((class_name, ctor_name)) => ctor_name == class_name,
            None => is_bodiless_ctor(node.kind()),
        }
    }

    /// getSignature (dart.ts:189-208).
    fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let sig = self.inner_signature(node);
        let mut c1 = sig.walk();
        let params = sig
            .named_children(&mut c1)
            .find(|c| c.kind() == "formal_parameter_list");
        // A constructor has no return type: the type a redirecting factory
        // names is its target (`= _Impl`).
        let mut c2 = sig.walk();
        let ret = if is_bodiless_ctor(sig.kind()) {
            None
        } else {
            sig.named_children(&mut c2)
                .find(|c| matches!(c.kind(), "type_identifier" | "void_type"))
        };
        if params.is_none() && ret.is_none() {
            return None;
        }
        let mut result = String::new();
        if let Some(r) = ret {
            result.push_str(self.text(r));
            result.push(' ');
        }
        if let Some(p) = params {
            result.push_str(self.text(p));
        }
        let trimmed = result.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// getVisibility (dart.ts:209-222) — `_` prefix = private; every
    /// constructor is public (the unwrap misses ctor signatures / the name
    /// FIELD is the class identifier).
    fn visibility_of(&self, node: Node<'t>) -> u8 {
        let name_node = if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(c.kind(), "function_signature" | "getter_signature" | "setter_signature")
            });
            inner.and_then(|i| {
                let mut ic = i.walk();
                let found = i.named_children(&mut ic).find(|c| c.kind() == "identifier");
                found
            })
        } else {
            node.child_by_field_name("name")
        };
        match name_node {
            Some(n) if self.text(n).starts_with('_') => 2,
            _ => 1,
        }
    }

    /// isAsync (dart.ts:223-233) — the `async` anon child of the SIBLING
    /// function_body; `async*`/`sync*` are different token types → false.
    fn is_async_of(&self, node: Node<'t>) -> bool {
        if let Some(next) = node.next_named_sibling() {
            if next.kind() == "function_body" {
                for i in 0..next.child_count() {
                    if let Some(c) = next.child(i) {
                        if c.kind() == "async" {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// isStatic (dart.ts:234-243).
    fn is_static_of(&self, node: Node<'t>) -> bool {
        if node.kind() == "method_signature" {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "static" {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// getDeclarationWrapper (dart.ts) — a member with no body (`Foo._();`,
    /// `const Foo.c();`, an abstract `void m();`) is a `declaration` wrapping
    /// its signature, and the member's `///` dartdoc and `@annotation`s come
    /// before the wrapper. A signature that opens the declaration takes both
    /// from there.
    fn declaration_wrapper(&self, node: Node<'t>) -> Option<Node<'t>> {
        let parent = node.parent()?;
        if parent.kind() != "declaration" {
            return None;
        }
        if parent.named_child(0)? == node {
            Some(parent)
        } else {
            None
        }
    }

    /// docstringFor (tree-sitter.ts) — the preceding comment run, looked up
    /// from the declaration wrapper when there is one.
    fn docstring_of(&self, node: Node<'t>) -> Option<String> {
        preceding_docstring(self.declaration_wrapper(node).unwrap_or(node), self.src)
    }

    /// resolveBody (dart.ts:158-171).
    fn resolve_body(&self, node: Node<'t>) -> Option<Node<'t>> {
        if matches!(node.kind(), "function_signature" | "method_signature") {
            let next = node.next_named_sibling()?;
            if next.kind() == "function_body" {
                return Some(next);
            }
            return None;
        }
        if let Some(standard) = node.child_by_field_name("body") {
            return Some(standard);
        }
        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .find(|c| matches!(c.kind(), "class_body" | "extension_body"));
        found
    }

    /// extractName (tree-sitter.ts:90-192) — resolveName (ctor names) →
    /// name field → the method_signature inner unwrap → identifier-ish
    /// child → `<anonymous>` (operators land here).
    fn extract_name(&self, node: Node<'t>) -> String {
        // resolveName hook (dart.ts:244-260): named ctor/factory → ctor name.
        if let Some((class_name, ctor_name)) = self.ctor_info(node) {
            if ctor_name != class_name {
                return ctor_name;
            }
        }
        // `class A = B with C;` — the mixin application's own identifier.
        if node.kind() == "class_definition" {
            let mut cursor = node.walk();
            let application = node.named_children(&mut cursor).find(|c| c.kind() == "mixin_application_class");
            if let Some(application) = application {
                let mut ac = application.walk();
                let id = application.named_children(&mut ac).find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    return self.text(id).to_string();
                }
            }
        }
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature" | "getter_signature" | "setter_signature"
                        | "constructor_signature" | "factory_constructor_signature"
                )
            });
            if let Some(inner) = inner {
                let mut ic = inner.walk();
                let id = inner.named_children(&mut ic).find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    return self.text(id).to_string();
                }
            }
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
        stack_guard!();
        // The visitNode hook (dart.ts:144-157) — the constants branch.
        if node.kind() == "static_final_declaration" {
            let mut cursor = node.walk();
            let name_node = node.named_children(&mut cursor).find(|c| c.kind() == "identifier");
            if let Some(name_node) = name_node {
                // signature = first value sibling's text, sliced to 100
                // UTF-16 units (a flattened chain captures just its head).
                let signature = name_node.next_named_sibling().map(|v| {
                    let (sliced, _) = util::slice_utf16(self.text(v), 100);
                    if util::utf16_len(&sliced) >= 100 {
                        format!("= {sliced}...")
                    } else {
                        format!("= {sliced}")
                    }
                });
                let name = self.text(name_node).to_string();
                let constant = self.create_node("constant", &name, node, Extra { signature, ..Default::default() });
                // The initializer is code the constant runs — its calls,
                // instantiations, reads and the types it names (#2327) are
                // the constant's. walkInitializer: the body walk, and the
                // dispatcher's fn-ref scan skips what it walked.
                if let Some(constant) = constant {
                    self.stack.push(Scope { row: constant, kind: "constant", name });
                    self.visit_body(node);
                    self.stack.pop();
                    return;
                }
            }
            self.scan_fn_ref_subtree(node, 0);
            return;
        }

        // A field's or top-level variable's initializer is code its class or
        // the file runs (neither mints a node) — the hook's
        // `initialized_identifier` row, walked like a body (walkInitializer).
        if node.kind() == "initialized_identifier" && self.is_field_or_top_level_entry(node) {
            self.visit_body(node);
            return;
        }

        // A field's declared type is its class's (Dart fields mint no nodes);
        // a top-level variable's is the file's (#2327). The visitNode hook's
        // `declaration` / `program` rows (dart.ts). (Parent lookups walk down
        // from the root, so only the node kinds that can be these positions
        // ask for theirs.)
        if node.kind() == "declaration" {
            let in_body = node
                .parent()
                .map(|p| matches!(p.kind(), "class_body" | "extension_body" | "enum_body"))
                .unwrap_or(false);
            let mut cursor = node.walk();
            let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
            let is_field = in_body
                && kids
                    .iter()
                    .any(|c| matches!(c.kind(), "initialized_identifier_list" | "static_final_declaration_list"));
            if is_field {
                let owner = self.top_row();
                for child in kids {
                    if !matches!(child.kind(), "initialized_identifier_list" | "static_final_declaration_list") {
                        self.type_refs_dart(child, owner);
                    }
                }
            }
        } else if matches!(node.kind(), "type_identifier" | "type_arguments" | "function_type" | "record_type")
            && node.parent().map(|p| p.kind() == "program").unwrap_or(false)
        {
            let owner = self.top_row();
            self.type_refs_dart(node, owner);
        }

        // maybeCaptureFnRefs (:990) — the double-walk fn-ref twin source.
        self.maybe_capture_fn_refs(node);

        match node.kind() {
            "function_signature" => {
                // functionTypes row — method_signature does NOT include it →
                // always extractFunction, even inside a class (abstract
                // members become kind `function` contained by the class).
                self.extract_function(node);
                return;
            }
            // `extension_type_declaration` is Dart 3.3's extension type. It is a
            // different node from `extension_declaration` above, which is the
            // older `extension` — the names are near neighbours and only one of
            // them was listed.
            "class_definition" | "mixin_declaration" | "extension_declaration" | "extension_type_declaration" => {
                self.extract_class(node);
                return;
            }
            "method_signature"
            | "constructor_signature"
            | "constant_constructor_signature"
            | "redirecting_factory_constructor_signature" => {
                self.extract_method(node);
                return;
            }
            "enum_declaration" => {
                self.extract_enum(node);
                return;
            }
            "type_alias" => {
                let skip = self.extract_type_alias(node);
                if skip {
                    return;
                }
            }
            "import_or_export" => {
                self.extract_import(node);
                return;
            }
            "new_expression" => {
                // INSTANTIATION_KINDS row — from the FILE/CLASS on the
                // sibling revisit (the double-walk's pass 2a).
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

    // --- extractFunction / extractMethod (:1517 / :1737) ------------------

    fn extract_function(&mut self, node: Node<'t>) {
        stack_guard!();
        // No receiver hook. Name first (resolveName inside extract_name).
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            // :1549 — body-only walk (nothing pushed). Dart signatures always
            // name; preserved for fidelity.
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        // isMisparsedFunction: the unnamed constructor is skipped — node
        // suppressed, body still walked (attributed to the current stack top).
        if self.is_misparsed_function(node) {
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        let docstring = self.docstring_of(node);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_async = self.is_async_of(node);
        let is_static = self.is_static_of(node);
        let return_type = self.return_type_of(node);
        let body = self.resolve_body(node);
        let end_line_override = body.map(|b| b.end_position().row as u32 + 1);
        let row = self.create_node(
            "function",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(is_async),
                is_static: Some(is_static),
                return_type,
                end_line_override,
            },
        );
        let Some(row) = row else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = body {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        // Gate (:1747): not inside class-like (no methodsAreTopLevel, no
        // receiver, parent never object/object_expression) → extractFunction.
        if !self.inside_class_like() {
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        // isMisparsedFunction — the unnamed ctor: body-only walk.
        if self.is_misparsed_function(node) {
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        let docstring = self.docstring_of(node);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_async = self.is_async_of(node);
        let is_static = self.is_static_of(node);
        let return_type = self.return_type_of(node);
        let body = self.resolve_body(node);
        let end_line_override = body.map(|b| b.end_position().row as u32 + 1);
        // Operators mint method "<anonymous>" — extractMethod has NO skip.
        let row = self.create_node(
            "method",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(is_async),
                is_static: Some(is_static),
                return_type,
                end_line_override,
            },
        );
        let Some(row) = row else { return };
        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = body {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass (:1679) — classes, mixins, extensions ---------------

    fn extract_class(&mut self, node: Node<'t>) {
        stack_guard!();
        let resolved_body = self.resolve_body(node);
        // No skipBodilessClass. Anonymous `extension on String` → the name
        // fallback finds the ON type's type_identifier — a class named after
        // the extended type (preserved).
        let name = self.extract_name(node);
        let docstring = self.docstring_of(node);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "class",
            &name,
            node,
            Extra { docstring, visibility, ..Default::default() },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        // extractCsharpPrimaryCtorParamRefs — csharp-gated no-op.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "class", name });
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
        stack_guard!();
        let body = match self.resolve_body(node) {
            Some(b) => b,
            None => return,
        };
        let name = self.extract_name(node);
        let docstring = self.docstring_of(node);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "enum",
            &name,
            node,
            Extra { docstring, visibility, ..Default::default() },
        );
        let Some(row) = row else { return };
        // Enum `with` mixins are a DIRECT child (no superclass wrapper) →
        // no clause matches; `interfaces` DOES → implements only.
        self.extract_inheritance(node, row);
        // No extractDecoratorsFor on the enum path.
        self.stack.push(Scope { row, kind: "enum", name });
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            if child.kind() == "enum_constant" {
                self.extract_enum_members(child);
            } else {
                self.visit(child);
            }
        }
        self.stack.pop();
    }

    /// extractEnumMembers (:1958) — one enum_member per constant, positioned
    /// at the enum_constant node; ctor arguments never walked.
    fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    // --- extractTypeAlias (:2890, plain path) -----------------------------

    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = self.docstring_of(node);
        // `value` field is null (type_alias has no fields) → no refs from
        // the aliased type; returns false → children re-visited.
        self.create_node("type_alias", &name, node, Extra { docstring, ..Default::default() });
        false
    }

    // --- extractImport (:3170; hook dart.ts:261-304) ----------------------

    fn extract_import(&mut self, node: Node<'t>) {
        let find_child = |parent: Node<'t>, kind: &str| -> Option<Node<'t>> {
            let mut cursor = parent.walk();
            let found = parent.named_children(&mut cursor).find(|c| c.kind() == kind);
            found
        };
        let uri_of = |spec: Node<'t>| -> Option<Node<'t>> {
            let configurable = find_child(spec, "configurable_uri")?;
            let uri = find_child(configurable, "uri")?;
            find_child(uri, "string_literal")
        };
        let mut module: Option<String> = None;
        if let Some(li) = find_child(node, "library_import") {
            if let Some(spec) = find_child(li, "import_specification") {
                if let Some(sl) = uri_of(spec) {
                    module = Some(self.text(sl).replace(['\'', '"'], ""));
                }
            }
        }
        if module.is_none() {
            if let Some(le) = find_child(node, "library_export") {
                if let Some(sl) = uri_of(le) {
                    module = Some(self.text(sl).replace(['\'', '"'], ""));
                }
            }
        }
        // Deferred imports (bare `uri`, no configurable_uri) → hook null →
        // nothing at all (invisible).
        let Some(module) = module.filter(|m| !m.is_empty()) else { return };
        let signature = self.text(node).trim().to_string();
        let created = self.create_node(
            "import",
            &module,
            node,
            Extra { signature: Some(signature), ..Default::default() },
        );
        if created.is_some() && !self.stack.is_empty() {
            let parent_row = self.top_row();
            self.push_ref_at(parent_row, &module, "imports", node);
        }
    }

    // --- extractInstantiation (:4610, generic tail) -----------------------

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
        let mut class_name = self.text(ctor).to_string();
        if let Some(lt) = class_name.find('<') {
            if lt > 0 {
                class_name.truncate(lt);
            }
        }
        let last_dot = class_name.rfind('.').map(|i| i as i64).unwrap_or(-1);
        let last_colons = class_name.rfind("::").map(|i| (i + 1) as i64).unwrap_or(-1);
        let last = last_dot.max(last_colons);
        if last >= 0 {
            class_name = class_name[(last as usize + 1)..].to_string();
            class_name = class_name.trim_start_matches([':', '.']).to_string();
        }
        let class_name = class_name.trim().to_string();
        if class_name.is_empty() {
            return;
        }
        self.push_ref_at(from_row, &class_name, "instantiates", node);
    }

    // --- extractBareCall (dart.ts:305-379) --------------------------------

    fn bare_call_name(&self, node: Node<'t>) -> Option<String> {
        if node.kind() == "selector" {
            let mut cursor = node.walk();
            let has_arg_part = node.named_children(&mut cursor).any(|c| c.kind() == "argument_part");
            if !has_arg_part {
                return None;
            }
            // Past comments: `box.grow /* by */ (3)` calls `box.grow`.
            let prev = prev_named(node)?;
            return self.callee_name(prev);
        }

        // A generic call the grammar read as two comparisons
        // (`ref.read<Repo>(p)`), named at its `<`, where a parsed call's
        // argument part starts.
        if node.kind() == "relational_operator" {
            let (callee, _) = self.misparsed_generic_call(node)?;
            return self.callee_name(callee);
        }

        // new_expression arm — DEAD in practice (the INSTANTIATION branch
        // fires first in the body walker); ported for fidelity.
        if node.kind() == "new_expression" {
            let mut cursor = node.walk();
            let found = node
                .named_children(&mut cursor)
                .find(|c| c.kind() == "type_identifier")
                .map(|t| self.text(t).to_string());
            return found;
        }

        // const EdgeInsets.all(8.0) — const constructor call.
        if node.kind() == "const_object_expression" {
            let mut c1 = node.walk();
            let type_id = node.named_children(&mut c1).find(|c| c.kind() == "type_identifier");
            let mut c2 = node.walk();
            let name_id = node.named_children(&mut c2).find(|c| c.kind() == "identifier");
            return match (type_id, name_id) {
                (Some(t), Some(n)) => Some(format!("{}.{}", self.text(t), self.text(n))),
                (Some(t), None) => Some(self.text(t).to_string()),
                _ => None,
            };
        }

        // `=> BlocProvider<CounterCubit>.value(…)` — a constructor called
        // with type arguments, as most expressions parse it. The type is the
        // LAST type_identifier: an import prefix (`p.X<T>.named`) is one too.
        if node.kind() == "constructor_invocation" {
            let mut c1 = node.walk();
            let type_id = node.named_children(&mut c1).filter(|c| c.kind() == "type_identifier").last();
            let mut c2 = node.walk();
            let name_id = node.named_children(&mut c2).find(|c| c.kind() == "identifier");
            return match (type_id, name_id) {
                (Some(t), Some(n)) => Some(format!("{}.{}", self.text(t), self.text(n))),
                (Some(t), None) => Some(self.text(t).to_string()),
                _ => None,
            };
        }

        None
    }

    /// dartReceiverOf (dart.ts) — the receiver of the member access
    /// `selector`: the node in front of it, past comments, or the end of an
    /// arrow function's body when the grammar ended the arrow in front of a
    /// generic call (`(ref) => ref.watch<int>(p)` → `((ref) => ref).watch<int>(p)`).
    fn receiver_of(&self, selector: Node<'t>) -> Option<Node<'t>> {
        let prev = prev_named(selector);
        let body = prev
            .filter(|p| p.kind() == "function_expression")
            .and_then(|p| p.named_child(p.named_child_count().checked_sub(1)?));
        match body {
            Some(body) if body.kind() == "function_expression_body" => {
                body.named_child(body.named_child_count().checked_sub(1)?)
            }
            _ => prev,
        }
    }

    /// dartCallee (dart.ts) — the callee name of the call whose argument part
    /// follows `prev`.
    fn callee_name(&self, prev: Node<'t>) -> Option<String> {
        if prev.kind() == "identifier" {
            return Some(self.text(prev).to_string());
        }
        if prev.kind() == "selector" {
            let mut pc = prev.walk();
            let accessor = prev.named_children(&mut pc).find(|c| {
                matches!(
                    c.kind(),
                    "unconditional_assignable_selector" | "conditional_assignable_selector"
                )
            });
            if let Some(accessor) = accessor {
                let mut ac = accessor.walk();
                let method_id = accessor.named_children(&mut ac).find(|c| c.kind() == "identifier");
                if let Some(method_id) = method_id {
                    let accessor_prev = self.receiver_of(prev);
                    if let Some(ap) = accessor_prev {
                        if ap.kind() == "identifier" {
                            return Some(format!("{}.{}", self.text(ap), self.text(method_id)));
                        }
                        // A constructor called with type arguments names
                        // its type all the same (`BlocProvider<T>.value`).
                        if let Some(type_name) = self.type_arguments_receiver(ap) {
                            return Some(format!("{}.{}", type_name, self.text(method_id)));
                        }
                        // Chained static-factory: the receiver is itself
                        // a call — re-encode `<inner>().<method>` when
                        // the chain starts capitalized (#750).
                        if ap.kind() == "selector" {
                            let mut apc = ap.walk();
                            if ap.named_children(&mut apc).any(|c| c.kind() == "argument_part") {
                                if let Some(inner) = self.callee_of_arg_part(ap) {
                                    if starts_upper_re().is_match(&inner) {
                                        return Some(format!("{}().{}", inner, self.text(method_id)));
                                    }
                                }
                            }
                        }
                    }
                    return Some(self.text(method_id).to_string());
                }
            }
        }
        // super.method() / this.method(): prev is a bare accessor.
        if matches!(
            prev.kind(),
            "unconditional_assignable_selector" | "conditional_assignable_selector"
        ) {
            let mut pc = prev.walk();
            let id = prev.named_children(&mut pc).find(|c| c.kind() == "identifier");
            if let Some(id) = id {
                return Some(self.text(id).to_string());
            }
        }
        None
    }

    /// dartMisparsedGenericCall (dart.ts) — a generic call tree-sitter-dart
    /// parsed as two comparisons, `(ref.read < Repo) > (p)`, found from its
    /// `<`: the node its callee ends with (under any `await` or prefix
    /// operator) and the identifier naming its type argument. Recovered when
    /// the type argument names a type and the code is laid out as a call —
    /// `<` against the callee, `(` against the `>`. A call chained on it keeps
    /// its bare name, which the resolver types from the chain written before
    /// it, as it types a parsed chain's `X().m` (#750).
    fn misparsed_generic_call(&self, lt: Node<'t>) -> Option<(Node<'t>, Node<'t>)> {
        if lt.kind() != "relational_operator" || lt.child(0)?.kind() != "<" {
            return None;
        }
        let inner = lt.parent()?;
        let outer = inner.parent()?;
        if inner.kind() != "relational_expression" || outer.kind() != "relational_expression" {
            return None;
        }
        let left = outer.named_child(0)?;
        if left.start_byte() != inner.start_byte() || left.end_byte() != inner.end_byte() {
            return None;
        }
        let gt = outer.named_child(1)?;
        if gt.kind() != "relational_operator" || gt.child(0)?.kind() != ">" {
            return None;
        }
        let args = outer.named_child(2)?;
        if !matches!(args.kind(), "parenthesized_expression" | "record_literal") || args.start_byte() != gt.end_byte() {
            return None;
        }
        // A comment against the `<` (`ref.read /* c */<Repo>(p)`) is a
        // sibling of its own, so the callee is not against it.
        let before = lt.prev_named_sibling()?;
        if is_comment(before) || before.end_byte() != lt.start_byte() {
            return None;
        }
        // The type argument: `T`, `p.T`, `T<…>` or `p.T<…>`, and nothing else.
        let head = lt.next_named_sibling()?;
        if head.kind() != "identifier" {
            return None;
        }
        let mut type_name = head;
        let mut rest = head.next_named_sibling();
        if let Some(sel) = rest {
            let accessor = sel.named_child(0).filter(|a| a.kind() == "unconditional_assignable_selector");
            if sel.kind() == "selector" {
                if let Some(accessor) = accessor {
                    let mut ac = accessor.walk();
                    let name = accessor.named_children(&mut ac).find(|c| c.kind() == "identifier");
                    type_name = name?;
                    rest = sel.next_named_sibling();
                }
            }
        }
        if let Some(sel) = rest {
            let only_type_args = sel.named_child_count() == 1
                && sel.named_child(0).map(|t| t.kind() == "type_arguments").unwrap_or(false);
            if sel.kind() == "selector" && only_type_args {
                rest = sel.next_named_sibling();
            }
        }
        if rest.is_some() {
            return None;
        }
        let name = self.text(type_name);
        if !is_upper_camel(name) && !is_lowercase_type(name) {
            return None;
        }
        // `await repo.load<User>(id)` and `-x.size<int>(y)` put the callee
        // under the prefix.
        let mut callee = before;
        while is_prefixed(callee.kind()) {
            let count = callee.named_child_count();
            callee = callee.named_child(count.checked_sub(1)?)?;
        }
        Some((callee, type_name))
    }

    /// dartInMisparsedGenericCall (dart.ts) — whether a member access
    /// (`.member` on `receiver`, followed by `next` under `parent`) belongs to
    /// a misparsed generic call: its callee is called, and a prefixed type
    /// argument (`p.Repo`) names a type.
    fn in_misparsed_generic_call(
        &self,
        receiver: Node<'t>,
        next: Option<Node<'t>>,
        parent: Option<Node<'t>>,
    ) -> bool {
        let mut after = next;
        let mut up = parent;
        while after.is_none() {
            let Some(u) = up.filter(|u| is_prefixed(u.kind())) else { break };
            after = u.next_named_sibling();
            up = if after.is_some() { None } else { u.parent() };
        }
        if let Some(a) = after {
            if a.kind() == "relational_operator" && self.misparsed_generic_call(a).is_some() {
                return true;
            }
        }
        if parent.map(|p| p.kind()) != Some("relational_expression") {
            return false;
        }
        receiver
            .prev_named_sibling()
            .map(|b| b.kind() == "relational_operator" && self.misparsed_generic_call(b).is_some())
            .unwrap_or(false)
    }

    /// dartCalleeOfArgPart (dart.ts:100-116).
    fn callee_of_arg_part(&self, arg_part: Node<'t>) -> Option<String> {
        let prev = prev_named(arg_part)?;
        if prev.kind() == "identifier" {
            return Some(self.text(prev).to_string());
        }
        if prev.kind() == "selector" {
            let mut pc = prev.walk();
            let accessor = prev.named_children(&mut pc).find(|c| {
                matches!(
                    c.kind(),
                    "unconditional_assignable_selector" | "conditional_assignable_selector"
                )
            });
            let method_id = accessor.and_then(|a| {
                let mut ac = a.walk();
                let found = a.named_children(&mut ac).find(|c| c.kind() == "identifier");
                found
            });
            if let Some(method_id) = method_id {
                let accessor_prev = prev_named(prev);
                if let Some(ap) = accessor_prev {
                    if ap.kind() == "identifier" {
                        return Some(format!("{}.{}", self.text(ap), self.text(method_id)));
                    }
                    if let Some(type_name) = self.type_arguments_receiver(ap) {
                        return Some(format!("{}.{}", type_name, self.text(method_id)));
                    }
                }
                return Some(self.text(method_id).to_string());
            }
        }
        None
    }

    /// dartTypeArgumentsReceiver (dart.ts) — `BlocProvider` in
    /// `BlocProvider<CounterCubit>.value(…)`, when `selector` is the `<…>`
    /// between the type and `.value`. Only a constructor is called that way.
    fn type_arguments_receiver(&self, selector: Node<'t>) -> Option<&'t str> {
        if selector.kind() != "selector" || selector.named_child_count() != 1 {
            return None;
        }
        if selector.named_child(0)?.kind() != "type_arguments" {
            return None;
        }
        let type_node = prev_named(selector)?;
        if type_node.kind() != "identifier" {
            return None;
        }
        Some(self.text(type_node))
    }

    // --- extractStaticMemberRef — the dart branch (:4759-4767) ------------

    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let owner_row = self.top_row();
        if node.kind() != "selector" {
            return;
        }
        let mut cursor = node.walk();
        if node.named_children(&mut cursor).any(|c| c.kind() == "argument_part") {
            return;
        }
        let Some(prev) = self.receiver_of(node) else { return };
        if prev.kind() == "identifier" && cap_ident_re().is_match(self.text(prev)) {
            // `Map` in `x.read<Map<K, V>>(y)` parsed as comparisons is a type
            // argument, which the body walker references as a type.
            if let Some(before) = prev.prev_named_sibling() {
                if before.kind() == "relational_operator" && self.misparsed_generic_call(before).is_some() {
                    return;
                }
            }
            let name = self.text(prev).to_string();
            // NO callee-of-call skip — `ConfigT.load()` double-emits
            // (references + calls). Position = the IDENTIFIER (receiver).
            self.push_ref_at(owner_row, &name, "references", prev);
        }
    }

    // --- extractDecoratorsFor (:4897-5024) — the sibling scan -------------

    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        // Scan 1: direct children (+ modifiers descent) — inert for dart
        // (annotations are preceding siblings), ported for fidelity.
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
        // Scan 2: preceding siblings, backward, stop at the first
        // non-annotation — stacked annotations emit in REVERSE source order.
        // A `declaration`-wrapped member's annotations precede the wrapper.
        let anchor = self.declaration_wrapper(decl).unwrap_or(decl);
        if let Some(parent) = anchor.parent() {
            let decl_start = anchor.start_byte();
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

    // --- extractInheritance — the dart rows (:5368-5393, :5437-5459) ------

    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        // The type an extension is `on` — a `references` edge (#2327).
        if node.kind() == "extension_declaration" {
            let mut oc = node.walk();
            let on_types: Vec<Node<'t>> = node.children_by_field_name("class", &mut oc).collect();
            for on_type in on_types {
                self.type_refs_dart(on_type, class_row);
            }
        }
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in kids {
            if child.kind() == "mixin_application_class" {
                // `class A = B with M implements I;` — extends B, implements
                // each mixin and interface, in source order.
                let mut cc = child.walk();
                let application = child.named_children(&mut cc).find(|c| c.kind() == "mixin_application");
                let Some(application) = application else { continue };
                let mut ac = application.walk();
                let parts: Vec<Node<'t>> = application.named_children(&mut ac).collect();
                for t in parts {
                    match t.kind() {
                        "type_identifier" => {
                            let name = self.text(t).to_string();
                            self.push_ref_at(class_row, &name, "extends", t);
                        }
                        "mixins" | "interfaces" => {
                            let mut mc = t.walk();
                            let targets: Vec<Node<'t>> = t.named_children(&mut mc).collect();
                            for m in targets {
                                if t.kind() == "interfaces" || m.kind() == "type_identifier" {
                                    let name = self.text(m).to_string();
                                    self.push_ref_at(class_row, &name, "implements", m);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            } else if child.kind() == "superclass" {
                // extends type + `with` mixins (implements) — dart branch.
                let mut cc = child.walk();
                let targets: Vec<Node<'t>> = child.named_children(&mut cc).collect();
                for t in targets {
                    if t.kind() == "mixins" {
                        let mut mc = t.walk();
                        let mixins: Vec<Node<'t>> = t.named_children(&mut mc).collect();
                        for m in mixins {
                            if m.kind() == "type_identifier" {
                                let name = self.text(m).to_string();
                                self.push_ref_at(class_row, &name, "implements", m);
                            }
                        }
                    } else if t.kind() == "type_identifier" {
                        let name = self.text(t).to_string();
                        self.push_ref_at(class_row, &name, "extends", t);
                    }
                }
            } else if child.kind() == "interfaces" {
                // implements — one per named child, FULL child text.
                let mut cc = child.walk();
                let targets: Vec<Node<'t>> = child.named_children(&mut cc).collect();
                for iface in targets {
                    let name = self.text(iface).to_string();
                    self.push_ref_at(class_row, &name, "implements", iface);
                }
            }
        }
    }

    // --- extractTypeAnnotations — the dart path (:5819-5833) --------------

    fn extract_type_annotations(&mut self, node: Node<'t>, row: u32) {
        let sig = if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let found = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature" | "getter_signature" | "setter_signature"
                        | "constructor_signature" | "factory_constructor_signature"
                )
            });
            found.unwrap_or(node) // operators fall back to the wrapper itself
        } else {
            node
        };
        // A redirecting factory names the class it constructs after `=`, then
        // perhaps that class's constructor (`= _$QuestionImpl.fromJson`, two
        // type_identifiers). Neither the constructor nor an import prefix is
        // a type, and Dart writes types UpperCamel.
        if sig.kind() == "redirecting_factory_constructor_signature" {
            let mut cursor = sig.walk();
            let kids: Vec<Node<'t>> = sig.named_children(&mut cursor).collect();
            for child in kids {
                if child.kind() != "type_identifier" || is_upper_camel(self.text(child)) {
                    self.type_refs_from_subtree(child, row);
                }
            }
            return;
        }
        self.type_refs_from_subtree(sig, row);
    }

    fn type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        stack_guard!();
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

    // --- type positions outside signatures (#2327; dart.ts pushDartTypeRefs) ---

    /// isDartTypeName (dart.ts) — UpperCamelCase (`/^[_$]*[A-Z]/`: lowercase
    /// is a built-in or an error-recovery artifact), not a built-in, not an
    /// import prefix (`p` in `p.Foo`), not the class a `new`/`const`
    /// constructor call names.
    fn is_type_name_dart(&self, node: Node<'t>) -> bool {
        let text = self.text(node);
        if !is_upper_camel(text) || is_builtin_type(text) {
            return false;
        }
        if node.next_sibling().map(|s| s.kind() == ".").unwrap_or(false) {
            return false;
        }
        !node
            .parent()
            .map(|p| matches!(p.kind(), "new_expression" | "const_object_expression"))
            .unwrap_or(false)
    }

    /// pushDartTypeRefs (dart.ts) — every type named inside `node`.
    fn type_refs_dart(&mut self, node: Node<'t>, from_row: u32) {
        stack_guard!();
        if node.kind() == "type_identifier" {
            if self.is_type_name_dart(node) {
                let name = self.text(node).to_string();
                self.push_ref_at(from_row, &name, "references", node);
            }
            return;
        }
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for c in kids {
            self.type_refs_dart(c, from_row);
        }
    }

    /// isDartFieldOrTopLevelEntry (dart.ts) — an `initialized_identifier`
    /// declaring a field or a top-level variable, not the second variable of
    /// a local declaration (`for (var i = 0, j = n(); …)`).
    fn is_field_or_top_level_entry(&self, node: Node<'t>) -> bool {
        let Some(list) = node.parent() else { return false };
        if list.kind() != "initialized_identifier_list" {
            return false;
        }
        let Some(owner) = list.parent() else { return false };
        if owner.kind() == "program" {
            return true;
        }
        owner.kind() == "declaration"
            && owner
                .parent()
                .map(|p| matches!(p.kind(), "class_body" | "extension_body" | "enum_body"))
                .unwrap_or(false)
    }

    /// dartMemberRead (dart.ts) — `x.area` / `x?.area` not followed by a call's
    /// argument part, receiver a plain name: a `references` ref `x.area` on
    /// `area`, which the resolver links to a getter only (#2338).
    fn extract_member_read(&mut self, node: Node<'t>) {
        if node.kind() != "selector" {
            return;
        }
        let mut cursor = node.walk();
        let accessor = node.named_children(&mut cursor).find(|c| {
            matches!(c.kind(), "unconditional_assignable_selector" | "conditional_assignable_selector")
        });
        let member = accessor.and_then(|a| {
            let mut ac = a.walk();
            let found = a.named_children(&mut ac).find(|c| c.kind() == "identifier");
            found
        });
        let Some(member) = member else { return };
        let Some(receiver) = prev_named(node) else { return };
        if receiver.kind() != "identifier" {
            return;
        }
        let next = next_named(node);
        if let Some(next) = next {
            if next.kind() == "selector" {
                let mut nc = next.walk();
                if next.named_children(&mut nc).any(|c| c.kind() == "argument_part") {
                    return;
                }
            }
        }
        // The callee of a generic call the grammar read as comparisons
        // (`ref.read<Repo>(p)`) is called; a prefixed type argument names a type.
        if self.in_misparsed_generic_call(receiver, next, node.parent()) {
            return;
        }
        let name = format!("{}.{}", self.text(receiver), self.text(member));
        let reader = self.top_row();
        self.push_ref_at(reader, &name, "references", member);
    }

    // --- visitFunctionBody (:5129-5286) — dart rows -----------------------

    fn visit_body(&mut self, node: Node<'t>) {
        stack_guard!();
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        if kind == "new_expression" {
            // INSTANTIATION branch fires first — extractBareCall's
            // new_expression arm is dead. Children still recursed.
            self.extract_instantiation(node);
        } else if let Some(callee) = self.bare_call_name(node) {
            // extractBareCall (:5159-5173) — ref at the MATCHED node.
            if !self.stack.is_empty() {
                let caller_row = self.top_row();
                self.push_ref_at(caller_row, &callee, "calls", node);
            }
        }

        self.extract_static_member_ref(node);

        // A getter read `x.area` (#2338); a type the body names (#2327) — the
        // type argument of a generic call parsed as comparisons included.
        self.extract_member_read(node);
        let type_node = match kind {
            "type_identifier" => Some(node),
            "relational_operator" => self.misparsed_generic_call(node).map(|(_, type_name)| type_name),
            _ => None,
        };
        if let Some(type_node) = type_node.filter(|t| self.is_type_name_dart(*t)) {
            let name = self.text(type_node).to_string();
            let owner = self.top_row();
            self.push_ref_at(owner, &name, "references", type_node);
        }

        if kind == "function_signature" {
            // Nested named functions (:5245) — extractFunction walks the
            // nested body itself; the enclosing walker ALSO revisits the
            // sibling function_body (double-walk pass 2b) via recursion.
            self.extract_function(node);
            return;
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit_body(child);
        }
    }

    // --- function-as-value capture (#756) — DART_SPEC ---------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "arguments" => ("args", ""),
            "assignment_expression" => ("rhs", "right"),
            "pair" => ("value", "value"),
            "list_literal" => ("list", ""),
            "static_final_declaration" => ("varinit", ""),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            "args" | "list" => {
                let mut cursor = node.walk();
                for c in node.named_children(&mut cursor) {
                    values.push(c);
                }
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
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
            "value" => {
                let v = node.child_by_field_name(field).or_else(|| {
                    let count = node.named_child_count();
                    if count > 0 { node.named_child(count - 1) } else { None }
                });
                if let Some(v) = v {
                    values.push(v);
                }
            }
            _ => {
                // varinit, NO field (function-ref.ts:471-487): the last named
                // child, requiring ≥2 named children; the name-field guard is
                // inert (static_final_declaration has no name/pattern field).
                let count = node.named_child_count();
                if count >= 2 {
                    if let Some(v) = node.named_child(count - 1) {
                        values.push(v);
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with DART_SPEC's one layer (`argument` → fan out).
    /// Named arguments are NOT captured (named_argument is not a layer).
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        stack_guard!();
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
            "argument" => {
                let mut cursor = v.walk();
                let kids: Vec<Node<'t>> = v.named_children(&mut cursor).collect();
                for c in kids {
                    self.normalize_fn_ref_value(c, from, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        stack_guard!();
        if depth > 12 {
            return;
        }
        // Halt list: functionTypes (function_signature) + the lambda kinds —
        // function_expression IS dart's lambda, so constant-initializer
        // lambdas don't leak candidates.
        if depth > 0
            && matches!(
                node.kind(),
                "function_signature" | "arrow_function" | "function_expression"
                    | "lambda_literal" | "lambda_expression"
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

        // Shadow prune — the dart declarator shapes (:844-850): each bumps
        // its first identifier-typed named child. Uninitialized locals bump;
        // assignment_expression is NOT a prune case.
        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if matches!(
                n.kind(),
                "static_final_declaration" | "initialized_identifier" | "initialized_variable_definition"
            ) {
                let mut cursor = n.walk();
                let id = n.named_children(&mut cursor).find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    let nm = self.text(id);
                    if targets.contains_key(nm) {
                        *decl_counts.entry(nm).or_insert(0) += 1;
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
            // The Dart sibling-body pull (:883-892) is LIVE and load-bearing:
            // reader scopes are SIGNATURE nodes; their reads live in the
            // sibling function_body.
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
