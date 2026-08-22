//! C / C++ extraction — a faithful Rust port of `TreeSitterExtractor`'s c/cpp
//! paths (src/extraction/tree-sitter.ts) plus languages/c-cpp.ts, one dual-
//! language module flagged like tsjs/ (checklist:
//! docs/design/ccpp-kernel-port-checklist.md — read it before editing).
//!
//! The seven preParse blanking passes are NOT here: the TS route point
//! (src/extraction/kernel/index.ts) applies `extractor.preParse` before the
//! kernel call, so this walker receives the SAME blanked bytes the wasm
//! extractor parses (all blanks are equal-length-space replacements — every
//! offset survives). `.metal`/`.cu`/`.cuh` arrive as language 'cpp' with their
//! dialect blanks already applied.
//!
//! Quirks mirrored bug-for-bug (each pinned by the parity gates):
//!  - cpp namespace prefix stack (#1291): named `namespace a::b {` pushes the
//!    name AS WRITTEN onto the qualifiedName prefix; anonymous falls through.
//!    No namespace NODE is minted (#1093 crowd-out).
//!  - out-of-line `Cls::method` defs: name = LAST `::` segment of the
//!    declarator's qualified_identifier (BFS that skips parameter_list +
//!    trailing_return_type), receiver = the template-stripped qualifier,
//!    qualifiedName composed against the namespace prefix with the re-spelled-
//!    prefix anchor rule; owner `contains` edge to the FIRST earlier
//!    struct/class/enum/trait of the receiver's bare name.
//!  - macro-name salvage: recoverCppMacroDefinedName (ALL-CAPS macro def whose
//!    real name is the lone first argument) at resolveName, and
//!    recoverMangledCppName (glued "Ret name" → last token) as the universal
//!    post-hoc net for BOTH c and cpp.
//!  - `class MACRO Name` misparse residue: isMisparsedFunction drops the
//!    phantom function (name starts `namespace`, C++ keywords, or the bodyless
//!    class/struct `type` + non-function_declarator shape, #946/#1061) but
//!    still walks the body.
//!  - C file-scope variables: init/pointer/array declarators only — a BARE
//!    identifier declarator is the macro-prototype misparse and is skipped
//!    (loses uninit scalars by design); cpp declarations instead take the TS
//!    GENERIC fallback (direct identifier children only → `int x;` extracts,
//!    `int x = 5;` does not — bug-for-bug).
//!  - inheritance quirk: extractInheritance recurses into
//!    field_declaration_list, where a field_declaration with no DIRECT
//!    field_identifier child (pointer/array/method members) but a direct
//!    type_identifier emits an `extends` ref to that type (the Go-embedding
//!    branch matching c/cpp shapes). Kept: the parity gate pins today's graph.
//!  - static-member/value-read pass (cpp only): `field_expression` is in
//!    MEMBER_ACCESS_TYPES (listed for Scala, same node kind in cpp), so
//!    `Capitalized.member` / `Capitalized->member` VALUE reads emit
//!    `references` refs; qualified_identifier is checked too but its scope
//!    child is namespace_identifier/template_type/…, never a plain
//!    identifier, so it can't emit.
//!  - explicit operator calls (#1247) ride an ERROR child — but has_error()
//!    defers the whole file to wasm, so the ported branch is a faithful no-op
//!    here; kept so an error-free shape (if a grammar bump ever produces one)
//!    stays parity-true.
//!  - local fn-pointer fan-out (#932-adjacent): `auto k = &fn<…>;` records
//!    per-caller targets (insertion-ordered, branch reassignments accumulate);
//!    a later bare `k(args)` emits one `calls` ref PER target and suppresses
//!    the local name. Template args stripped like base-class refs (#1043).
//!  - stack construction (#1035): cpp `declaration` with class-like named
//!    `type` and an init_declarator whose value is argument_list /
//!    initializer_list → `instantiates` (most-vexing-parse excluded).
//!  - value-reference edges: C only (VALUE_REF_LANGS has 'c', not 'cpp') —
//!    shadow prune via init_declarator counts, MAX_VALUE_REF_NODES cap,
//!    CODEGRAPH_VALUE_REFS=0 kill switch.
//!  - fn-ref capture (#756): cFamilySpec for both; cpp adds addressOfOnly
//!    (bare identifiers only qualify in file-scope value/list positions).
//!
//! Files with parse errors defer to wasm (`defer:`) — error recovery is
//! encoding-dependent and the wasm recovery is canonical.

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_EXPORTED, FUNCTION_REF_CODE, NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

// --- compiled regexes (JS \w/\s spelled as ASCII classes for parity) ---------

/// recoverCppMacroDefinedName: macro-shaped parsed name.
fn macro_shaped_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$").unwrap())
}
fn has_lower_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[a-z]").unwrap())
}
/// normalizeCppReturnType: smart-pointer/optional unwrap.
fn ret_wrapper_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>")
            .unwrap()
    })
}
fn ret_keyword_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:const|volatile|typename|struct|class|enum)\b").unwrap())
}
fn angle_group_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}
fn ptr_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[*&]+").unwrap())
}
fn ws_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}
fn simple_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}
/// recoverMangledCppName's `Ret (name)` idiom guard.
fn ret_paren_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\S+\s+\([A-Za-z_][A-Za-z0-9_]*\)").unwrap())
}
/// Operator-call receiver: simple identifier / dotted member chain.
fn operator_receiver_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_.]*$").unwrap())
}
/// Symbolic operator tail (`/^[^\w\s]/` in JS).
fn symbolic_op_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[^A-Za-z0-9_\s]").unwrap())
}
/// extractStaticMemberRef's capitalized-receiver test.
fn capitalized_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z0-9_]*$").unwrap())
}
/// normalizeValue's qualified `&Cls::m` member-pointer test (`/^[A-Za-z_][\w:]*$/`).
fn qualified_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_:]*$").unwrap())
}

/// CPP_NON_CLASS_RETURN (languages/c-cpp.ts).
fn is_non_class_return(name: &str) -> bool {
    matches!(
        name,
        "void" | "bool" | "char" | "short" | "int" | "long" | "float" | "double" | "unsigned"
            | "signed" | "size_t" | "ssize_t" | "auto" | "wchar_t" | "char8_t" | "char16_t"
            | "char32_t" | "int8_t" | "int16_t" | "int32_t" | "int64_t" | "uint8_t" | "uint16_t"
            | "uint32_t" | "uint64_t" | "intptr_t" | "uintptr_t" | "nullptr_t"
    )
}

/// CPP_PRIMITIVE_NAMES (languages/c-cpp.ts) — recoverMangledCppName's guard.
fn is_cpp_primitive_name(name: &str) -> bool {
    matches!(
        name,
        "bool" | "void" | "int" | "char" | "short" | "long" | "float" | "double" | "unsigned"
            | "signed" | "wchar_t" | "char8_t" | "char16_t" | "char32_t" | "char_t" | "size_t"
            | "auto" | "const" | "struct" | "class" | "enum" | "union" | "typename"
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

/// LITERAL_RECEIVER_TYPES (tree-sitter.ts) — full set; membership is what the
/// TS code tests even though only a few kinds occur in the c/cpp grammars.
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

/// stripCppTemplateArgs (languages/c-cpp.ts): depth-counted removal of every
/// balanced `<…>` group; `<` and `>` never reach the output.
fn strip_cpp_template_args(name: &str) -> String {
    if !name.contains('<') {
        return name.to_string();
    }
    let mut out = String::with_capacity(name.len());
    let mut depth = 0u32;
    for ch in name.chars() {
        if ch == '<' {
            depth += 1;
        } else if ch == '>' {
            depth = depth.saturating_sub(1);
        } else if depth == 0 {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// recoverMangledCppName (languages/c-cpp.ts) — universal post-hoc salvage for
/// a name still mangled by an unblanked macro ("Ret name" → "name").
fn recover_mangled_cpp_name(name: String) -> String {
    if !name.chars().any(|c| c.is_whitespace())
        || name.starts_with("operator")
        || name.starts_with('~')
    {
        return name;
    }
    if ret_paren_name_re().is_match(&name) {
        return name; // `Ret (name)` idiom — leave alone
    }
    let before_params = match name.find('(') {
        Some(i) => &name[..i],
        None => &name[..],
    };
    // (JS: `beforeParams.trim().split(/\s+/)` — split_whitespace already
    // ignores leading/trailing whitespace, so no explicit trim.)
    let candidate = before_params.split_whitespace().last().unwrap_or("");
    if candidate.is_empty()
        || !simple_ident_re().is_match(candidate)
        || is_cpp_primitive_name(candidate)
    {
        return name;
    }
    candidate.to_string()
}

/// normalizeCppReturnType (languages/c-cpp.ts).
fn normalize_cpp_return_type(raw: &str) -> Option<String> {
    let mut t = raw.trim().to_string();
    if t.is_empty() {
        return None;
    }
    if let Some(c) = ret_wrapper_re().captures(&t) {
        if let Some(inner) = c.get(1) {
            t = inner.as_str().to_string();
        }
    }
    let t = ret_keyword_re().replace_all(&t, " ");
    let t = angle_group_re().replace_all(&t, " ");
    let t = ptr_ref_re().replace_all(&t, " ");
    let t = ws_run_re().replace_all(&t, " ");
    let t = t.trim();
    if t.is_empty() {
        return None;
    }
    let parts: Vec<&str> = t.split("::").filter(|p| !p.is_empty()).collect();
    let last = *parts.last()?;
    if is_non_class_return(last) || !simple_ident_re().is_match(last) {
        return None;
    }
    Some(last.to_string())
}

/// JS `String.replace(/->/g,'.').replace(/\s+/g,'')` used on receivers.
fn arrow_dot_no_ws(s: &str) -> String {
    s.replace("->", ".").chars().filter(|c| !c.is_whitespace()).collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    C,
    Cpp,
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
    is_exported: Option<bool>,
    return_type: Option<String>,
    qualified_name: Option<String>,
}

struct ValueScope<'t> {
    row: u32,
    node: Node<'t>,
    name: String,
}

/// Capture mode for a fn-ref candidate (gate policy keys on it).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Args,
    Rhs,
    Value,
    List,
    Varinit,
}

struct Cand {
    from: u32,
    name: String,
    mode: Mode,
    explicit_ref: bool,
    line: u32,
    column_byte: usize,
    row: usize,
}

/// Per-node metadata for the receiver-method owner lookup (mirrors the TS
/// side's scan over `this.nodes` — FIRST match wins, earlier-in-file only).
struct NodeMeta {
    kind: &'static str,
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
    nodes_meta: Vec<NodeMeta>,
    node_ids: Vec<String>,
    /// C/C++ enclosing `namespace ns { … }` names (cpp only ever non-empty).
    namespace_prefix: Vec<String>,
    /// cppLocalFnPtrs: caller row → local name → insertion-ordered targets.
    local_fn_ptrs: HashMap<u32, HashMap<String, Vec<String>>>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str, language: &str) -> Result<EmitOut, String> {
    let variant = match language {
        "c" => Variant::C,
        "cpp" => Variant::Cpp,
        other => return Err(format!("ccpp walker got language '{other}'")),
    };
    let grammar = crate::langs::grammar_for(language).ok_or("no c/cpp grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language({language}) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    // Measurement hatch (parity sweeps only — never set in production): skip
    // the defer so the sweep can QUANTIFY how often UTF-8 vs UTF-16 error
    // recovery actually diverges on this language's erroring files.
    let no_defer = std::env::var("CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT").as_deref() == Ok("1");
    if tree.root_node().has_error() && !no_defer {
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
        nodes_meta: Vec::new(),
        node_ids: Vec::new(),
        namespace_prefix: Vec::new(),
        local_fn_ptrs: HashMap::new(),
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
        // (c/cpp define no resolveBody hook, so createNode's endLine extension
        // for sibling-body grammars never fires — endLine is the node's own.)
        let end_line = node.end_position().row as u32 + 1;

        let qualified = extra.qualified_name.unwrap_or_else(|| {
            let mut parts: Vec<&str> = self.namespace_prefix.iter().map(|s| s.as_str()).collect();
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
        // captureValueRefScope (capture is variant-agnostic like the TS side;
        // flushValueRefs gates on the language — C only).
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

    // --- name extraction -----------------------------------------------------

    /// extractName: extractNameRaw + the universal recoverMangledName net
    /// (wired for BOTH c and cpp in languages/c-cpp.ts).
    fn extract_name(&self, node: Node) -> String {
        recover_mangled_cpp_name(self.extract_name_raw(node))
    }

    /// extractNameRaw for the c/cpp extractor configs (nameField 'declarator';
    /// cpp resolveName = extractCppQualifiedMethodName).
    fn extract_name_raw(&self, node: Node) -> String {
        if self.variant == Variant::Cpp {
            if let Some(hook) = self.extract_cpp_qualified_method_name(node) {
                return hook;
            }
        }
        if let Some(name_node) = node.child_by_field_name("declarator") {
            let mut resolved = name_node;
            // Unwrap pointer/reference declarators (`int* f()`, `T& f()`).
            while matches!(resolved.kind(), "pointer_declarator" | "reference_declarator") {
                let inner = resolved
                    .child_by_field_name("declarator")
                    .or_else(|| resolved.named_child(0));
                match inner {
                    Some(i) => resolved = i,
                    None => break,
                }
            }
            // C++ conversion operator: `operator <type>`.
            if resolved.kind() == "operator_cast" {
                return match resolved.named_child(0) {
                    Some(t) => format!("operator {}", self.text(t).trim()),
                    None => self.text(resolved).to_string(),
                };
            }
            if resolved.kind() == "function_declarator" || resolved.kind() == "declarator" {
                let inner = resolved
                    .child_by_field_name("declarator")
                    .or_else(|| resolved.named_child(0));
                return match inner {
                    Some(i) => self.text(i).to_string(),
                    None => self.text(resolved).to_string(),
                };
            }
            return self.text(resolved).to_string();
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

    /// extractCppQualifiedMethodName (languages/c-cpp.ts:75).
    fn extract_cpp_qualified_method_name(&self, node: Node) -> Option<String> {
        if let Some(n) = self.recover_cpp_macro_defined_name(node) {
            return Some(n);
        }
        let declarator = node.child_by_field_name("declarator")?;
        let qid = find_declarator_qualified_id(declarator)?;
        let text = self.text(qid).trim();
        let parts: Vec<&str> = text.split("::").filter(|p| !p.is_empty()).collect();
        parts.last().map(|s| s.to_string())
    }

    /// recoverCppMacroDefinedName (languages/c-cpp.ts:49).
    fn recover_cpp_macro_defined_name(&self, node: Node) -> Option<String> {
        if node.kind() != "function_definition" {
            return None;
        }
        let declarator = node.child_by_field_name("declarator")?;
        if declarator.kind() != "function_declarator" {
            return None;
        }
        let inner = declarator.child_by_field_name("declarator")?;
        if inner.kind() != "identifier" {
            return None;
        }
        let macro_name = self.text(inner);
        if !macro_shaped_re().is_match(macro_name) {
            return None;
        }
        let params = declarator.child_by_field_name("parameters")?;
        if params.named_child_count() < 2 {
            return None;
        }
        let lone_ident_text = |p: Node| -> Option<&'t str> {
            if p.kind() == "parameter_declaration"
                && p.named_child_count() == 1
                && p.named_child(0).map(|c| c.kind() == "type_identifier").unwrap_or(false)
            {
                Some(self.text(p.named_child(0).unwrap()))
            } else {
                None
            }
        };
        let name = params.named_child(0).and_then(lone_ident_text)?;
        if !has_lower_re().is_match(name) {
            return None;
        }
        for i in 1..params.named_child_count() {
            if let Some(p) = params.named_child(i) {
                if lone_ident_text(p).is_some() {
                    return None;
                }
            }
        }
        Some(name.to_string())
    }

    /// extractCppReceiverType (languages/c-cpp.ts:86).
    fn receiver_type_of(&self, node: Node) -> Option<String> {
        let declarator = node.child_by_field_name("declarator")?;
        let qid = find_declarator_qualified_id(declarator)?;
        let text = self.text(qid).trim();
        let parts: Vec<&str> = text.split("::").filter(|p| !p.is_empty()).collect();
        if parts.len() <= 1 {
            return None;
        }
        let receiver = strip_cpp_template_args(&parts[..parts.len() - 1].join("::"));
        if receiver.is_empty() {
            None
        } else {
            Some(receiver)
        }
    }

    /// extractCppReturnType: the `type` field, normalized.
    fn return_type_of(&self, node: Node) -> Option<String> {
        let type_node = node.child_by_field_name("type")?;
        normalize_cpp_return_type(self.text(type_node))
    }

    /// cppExtractor.getVisibility: the FIRST access_specifier among the
    /// parent's children decides (document order, not nearest-preceding —
    /// bug-for-bug with the TS loop).
    fn visibility_of(&self, node: Node) -> Option<u8> {
        let parent = node.parent()?;
        for i in 0..parent.child_count() {
            let Some(child) = parent.child(i) else { continue };
            if child.kind() == "access_specifier" {
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

    /// cExtractor.isConst: any named `type_qualifier` child reading "const".
    fn is_const_declaration(&self, node: Node) -> bool {
        (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .any(|c| c.kind() == "type_qualifier" && self.text(c) == "const")
    }

    /// cppExtractor.isMisparsedFunction (languages/c-cpp.ts:811). cpp only.
    fn is_misparsed_function(&self, name: &str, node: Node) -> bool {
        if self.variant != Variant::Cpp {
            return false;
        }
        if name.starts_with("namespace") {
            return true;
        }
        if matches!(name, "switch" | "if" | "for" | "while" | "do" | "case" | "return") {
            return true;
        }
        is_macro_misparsed_type_decl(node)
    }

    /// composeReceiverQualifiedName (tree-sitter.ts:1424).
    fn compose_receiver_qualified_name(&self, receiver_type: &str, name: &str) -> String {
        let base = format!("{receiver_type}::{name}");
        if self.namespace_prefix.is_empty() {
            return base;
        }
        let receiver_head = receiver_type.split("::").next().unwrap_or("");
        let anchor = self.namespace_prefix.iter().position(|p| p == receiver_head);
        let prefix: &[String] = match anchor {
            Some(i) => &self.namespace_prefix[..i],
            None => &self.namespace_prefix[..],
        };
        if prefix.is_empty() {
            base
        } else {
            format!("{}::{}", prefix.join("::"), base)
        }
    }

    // --- visitNode -----------------------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        // C++ namespace blocks: prefix-only, no node (#1291/#1093). Anonymous
        // namespaces fall through to the generic walk.
        if self.variant == Variant::Cpp && kind == "namespace_definition" {
            let ns_name = node
                .child_by_field_name("name")
                .map(|n| self.text(n).to_string())
                .unwrap_or_default();
            if !ns_name.is_empty() {
                self.namespace_prefix.push(ns_name);
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        self.visit_node(c);
                    }
                }
                self.namespace_prefix.pop();
                return;
            }
        }

        self.maybe_capture_fn_refs(node);

        if kind == "function_definition" {
            // functionTypes for both; cpp's methodTypes also lists it, so
            // inside a class-like scope it extracts as a method.
            if self.inside_class_like() && self.variant == Variant::Cpp {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if self.variant == Variant::Cpp && kind == "class_specifier" {
            self.extract_class(node);
            skip_children = true;
        } else if kind == "struct_specifier" {
            self.extract_struct(node);
            skip_children = true;
        } else if kind == "enum_specifier" {
            self.extract_enum(node);
            skip_children = true;
        } else if kind == "type_definition"
            || (self.variant == Variant::Cpp && kind == "alias_declaration")
        {
            skip_children = self.extract_type_alias(node);
        } else if kind == "declaration" && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "preproc_include" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            // INSTANTIATION_KINDS: cpp `new Foo(...)`. (No anonymous-class
            // body exists under new_expression in this grammar; children are
            // still walked for nested calls.)
            self.extract_instantiation(node);
        }

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- extractors ----------------------------------------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        // Receiver present (out-of-line `Cls::method` def) → method instead.
        if self.variant == Variant::Cpp && self.receiver_type_of(node).is_some() {
            self.extract_method(node);
            return;
        }

        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }
        // Misparse artifacts: drop the node, still walk the body (#946/#1061).
        if self.is_misparsed_function(&name, node) {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }

        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: if self.variant == Variant::Cpp { self.visibility_of(node) } else { None },
            return_type: self.return_type_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        // (extractTypeAnnotations + extractDecoratorsFor are structural no-ops
        // for c/cpp: not in TYPE_ANNOTATION_LANGUAGES, and the decorator node
        // kinds never appear as direct children/preceding siblings in these
        // grammars — `attribute` only occurs under attribute_declaration.)
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        let receiver_type = if self.variant == Variant::Cpp { self.receiver_type_of(node) } else { None };

        if !self.inside_class_like() && receiver_type.is_none() {
            // (object-literal parents don't occur in c/cpp) — treat as function.
            self.extract_function(node);
            return;
        }

        let name = self.extract_name(node);
        if self.is_misparsed_function(&name, node) {
            if let Some(body) = node.child_by_field_name("body") {
                self.visit_function_body(body);
            }
            return;
        }

        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: if self.variant == Variant::Cpp { self.visibility_of(node) } else { None },
            return_type: self.return_type_of(node),
            qualified_name: receiver_type
                .as_ref()
                .map(|r| self.compose_receiver_qualified_name(r, &name)),
            ..Extra::default() // extractMethod passes no isExported
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };

        // Out-of-line def: contains edge from the FIRST earlier-in-file
        // struct/class/enum/trait node of the receiver's name.
        if let Some(receiver_type) = &receiver_type {
            if !self.inside_class_like() {
                let owner_row = self
                    .nodes_meta
                    .iter()
                    .position(|m| {
                        m.name == *receiver_type
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

        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    /// extractClass for cpp class_specifier (skipBodilessClass, #1093).
    fn extract_class(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: self.visibility_of(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "class", name });
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    /// extractStruct: bodiless specifiers (fwd decls / elaborated refs) skip.
    fn extract_struct(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: if self.variant == Variant::Cpp { self.visibility_of(node) } else { None },
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

    fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = node.child_by_field_name("body") else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring(node, self.src),
            visibility: if self.variant == Variant::Cpp { self.visibility_of(node) } else { None },
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if child.kind() == "enumerator" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    /// extractEnumMembers: enumerator's `name` field (C/C++ always has one;
    /// the TS fallbacks for other grammars are unreachable here).
    fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    /// extractTypeAlias for type_definition / alias_declaration. Returns true
    /// when children were consumed (typedef struct/enum bodies).
    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring(node, self.src);

        // resolveTypeAliasKind: first child that is an enum/struct specifier
        // WITH a body decides the node kind (anon inner specifier takes the
        // typedef's name).
        let mut resolved: Option<&'static str> = None;
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "enum_specifier" && child.child_by_field_name("body").is_some() {
                resolved = Some("enum");
                break;
            }
            if child.kind() == "struct_specifier" && child.child_by_field_name("body").is_some() {
                resolved = Some("struct");
                break;
            }
        }

        if resolved == Some("struct") {
            let Some(row) = self.create_node(
                "struct",
                &name,
                node,
                Extra { docstring, ..Extra::default() },
            ) else {
                return true;
            };
            self.stack.push(Scope { row, kind: "struct", name });
            let type_child = node
                .child_by_field_name("type")
                .or_else(|| self.find_child_by_kind(node, "struct_specifier"));
            if let Some(tc) = type_child {
                self.extract_inheritance(tc, row);
                let body = tc.child_by_field_name("body").unwrap_or(tc);
                for i in 0..body.named_child_count() {
                    if let Some(c) = body.named_child(i) {
                        self.visit_node(c);
                    }
                }
            }
            self.stack.pop();
            return true;
        }

        if resolved == Some("enum") {
            let Some(row) = self.create_node(
                "enum",
                &name,
                node,
                Extra { docstring, ..Extra::default() },
            ) else {
                return true;
            };
            self.stack.push(Scope { row, kind: "enum", name });
            if let Some(inner) = self.find_child_by_kind(node, "enum_specifier") {
                self.extract_inheritance(inner, row);
                if let Some(body) = inner.child_by_field_name("body") {
                    for i in 0..body.named_child_count() {
                        let Some(child) = body.named_child(i) else { continue };
                        if child.kind() == "enumerator" {
                            self.extract_enum_members(child);
                        } else {
                            self.visit_node(child);
                        }
                    }
                }
            }
            self.stack.pop();
            return true;
        }

        self.create_node("type_alias", &name, node, Extra { docstring, ..Extra::default() });
        false
    }

    fn find_child_by_kind(&self, node: Node<'t>, kind: &str) -> Option<Node<'t>> {
        (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == kind)
    }

    /// extractVariable: C takes the dedicated branch (file-scope declarators,
    /// tree-sitter.ts:2795); cpp takes the TS GENERIC fallback (direct
    /// identifier children).
    fn extract_variable(&mut self, node: Node<'t>) {
        let is_const = self.variant == Variant::C && self.is_const_declaration(node);
        let kind: &'static str = if is_const { "constant" } else { "variable" };
        let docstring = preceding_docstring(node, self.src);
        // isExported?.() ?? false — EXPLICIT false (tri-state flag set).
        let is_exported = Some(false);

        if self.variant == Variant::C {
            if has_function_ancestor(node) {
                return;
            }
            for i in 0..node.named_child_count() {
                let Some(child) = node.named_child(i) else { continue };
                if !matches!(
                    child.kind(),
                    "init_declarator" | "pointer_declarator" | "array_declarator"
                ) {
                    continue;
                }
                let Some(name_node) = c_declarator_identifier(child) else { continue };
                let name = self.text(name_node);
                if name.is_empty() {
                    continue;
                }
                let value_node = if child.kind() == "init_declarator" {
                    child.child_by_field_name("value")
                } else {
                    None
                };
                let signature = value_node.map(|v| util::init_signature(self.text(v)));
                self.create_node(
                    kind,
                    name,
                    child,
                    Extra {
                        docstring: docstring.clone(),
                        signature,
                        is_exported,
                        ..Extra::default()
                    },
                );
            }
        } else {
            // Generic fallback: direct identifier children only (`int x;`
            // extracts; `int x = 5;` nests in an init_declarator and does not).
            for i in 0..node.named_child_count() {
                let Some(child) = node.named_child(i) else { continue };
                if child.kind() != "identifier" {
                    continue;
                }
                let name = self.text(child).to_string();
                if !name.is_empty() && name != "<anonymous>" {
                    self.create_node(
                        kind,
                        &name,
                        child,
                        Extra { docstring: docstring.clone(), is_exported, ..Extra::default() },
                    );
                }
            }
        }
    }

    /// extractImport via the c/cpp extractImport hook: `#include <sys.h>` /
    /// `#include "local.h"`. A hook miss (`#include MACRO`) extracts nothing.
    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let module_name: Option<String> =
            if let Some(sys) = self.find_child_by_kind(node, "system_lib_string") {
                let t = self.text(sys);
                let t = t.strip_prefix('<').unwrap_or(t);
                let t = t.strip_suffix('>').unwrap_or(t);
                Some(t.to_string())
            } else if let Some(lit) = self.find_child_by_kind(node, "string_literal") {
                self.find_child_by_kind(lit, "string_content").map(|sc| self.text(sc).to_string())
            } else {
                None
            };
        let Some(module_name) = module_name else { return };
        self.create_node(
            "import",
            &module_name,
            node,
            Extra { signature: Some(import_text), ..Extra::default() },
        );
        if !module_name.is_empty() {
            let parent = self.top_row();
            self.push_ref_at(parent, &module_name, edge_kind_index("imports").unwrap(), node);
        }
    }

    // --- calls / instantiation ----------------------------------------------

    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let calls_kind = edge_kind_index("calls").unwrap();

        // C++ explicit operator call `a.operator+(b)` (#1247): the
        // operator_name hides in an ERROR child. (has_error() defers such
        // files to wasm, so this scan is a faithful no-op today.)
        if self.variant == Variant::Cpp {
            if let Some(func) = func {
                let mut operator_name = String::new();
                'err: for i in 0..node.named_child_count() {
                    let Some(child) = node.named_child(i) else { continue };
                    if child.kind() != "ERROR" {
                        continue;
                    }
                    for j in 0..child.named_child_count() {
                        if let Some(op) = child.named_child(j) {
                            if op.kind() == "operator_name" {
                                operator_name = self.text(op).to_string();
                                break 'err;
                            }
                        }
                    }
                }
                if !operator_name.is_empty() {
                    let sym = operator_name["operator".len()..].trim().to_string();
                    if symbolic_op_re().is_match(&sym) {
                        let compact: String = sym.chars().filter(|c| !c.is_whitespace()).collect();
                        operator_name = format!("operator{compact}");
                    }
                    let receiver = arrow_dot_no_ws(self.text(func));
                    if receiver != "this" && !operator_receiver_re().is_match(&receiver) {
                        return;
                    }
                    let callee = if receiver == "this" {
                        operator_name
                    } else {
                        format!("{receiver}.{operator_name}")
                    };
                    self.push_ref_at(caller_row, &callee, calls_kind, node);
                    return;
                }
            }
        }

        let mut callee_name = String::new();
        if let Some(func) = func {
            if func.kind() == "field_expression" {
                // `obj.method()` / `ptr->method()` — the `field` field.
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
                            return; // #1230: literal receivers emit nothing
                        }
                    }
                    match receiver.map(|r| r.kind()) {
                        Some("identifier") | Some("simple_identifier") | Some("field_identifier") => {
                            let receiver_name = self.text(receiver.unwrap());
                            if !matches!(receiver_name, "self" | "this" | "cls" | "super") {
                                callee_name = format!("{receiver_name}.{method_name}");
                            } else {
                                callee_name = method_name.to_string();
                            }
                        }
                        Some("call_expression") => {
                            // Call-result receiver (#645/#608): re-encode as
                            // `<innerCallee>().<method>` — C/C++ re-encode any inner.
                            let inner_fn = receiver.unwrap().child_by_field_name("function");
                            let inner_callee =
                                inner_fn.map(|f| arrow_dot_no_ws(self.text(f))).unwrap_or_default();
                            if !inner_callee.is_empty() {
                                callee_name = format!("{inner_callee}().{method_name}");
                            } else {
                                callee_name = method_name.to_string();
                            }
                        }
                        _ => {
                            callee_name = method_name.to_string();
                        }
                    }
                }
            } else {
                // Bare / qualified / templated / parenthesized callee.
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            // `(*fp)(x)` → `fp` (parenthesized-conversion normalization).
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
        }

        // Template-arg strip on callees (`fn<T, 256>(args)`, `ns::fn<T>()`).
        if !callee_name.is_empty() && callee_name.contains('<') && !callee_name.contains("operator")
        {
            callee_name = strip_cpp_template_args(&callee_name);
        }

        // Local fn-pointer fan-out: a bare callee bound earlier from `&fn`
        // emits one calls ref PER recorded target (insertion order).
        if !callee_name.is_empty()
            && self.variant == Variant::Cpp
            && simple_ident_re().is_match(&callee_name)
        {
            let targets = self
                .local_fn_ptrs
                .get(&caller_row)
                .and_then(|locals| locals.get(&callee_name))
                .cloned();
            if let Some(targets) = targets {
                if !targets.is_empty() {
                    for target in &targets {
                        self.push_ref_at(caller_row, target, calls_kind, node);
                    }
                    return;
                }
            }
        }

        if !callee_name.is_empty() {
            self.push_ref_at(caller_row, &callee_name, calls_kind, node);
        }
    }

    /// extractInstantiation: `new Foo(...)` and stack constructions (both
    /// read the type from the `type` field; template args + qualifiers strip).
    fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
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
        // Keep the trailing identifier of `ns::Foo` / `a.Foo`.
        let last_dot = class_name.rfind('.').map(|i| i as isize).unwrap_or(-1);
        let last_colons = class_name.rfind("::").map(|i| i as isize).unwrap_or(-1);
        let cut = last_dot.max(last_colons);
        if cut >= 0 {
            class_name = class_name[(cut as usize + 1)..].to_string();
            if class_name.starts_with(':') || class_name.starts_with('.') {
                class_name.remove(0);
            }
        }
        let class_name = class_name.trim().to_string();
        if !class_name.is_empty() {
            self.push_ref_at(from, &class_name, edge_kind_index("instantiates").unwrap(), node);
        }
    }

    /// isCppStackConstruction (#1035).
    fn is_cpp_stack_construction(&self, node: Node) -> bool {
        let Some(type_node) = node.child_by_field_name("type") else { return false };
        if !matches!(
            type_node.kind(),
            "type_identifier" | "template_type" | "qualified_identifier"
        ) {
            return false;
        }
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "init_declarator" {
                continue;
            }
            if let Some(value) = child.child_by_field_name("value") {
                if matches!(value.kind(), "argument_list" | "initializer_list") {
                    return true;
                }
            }
        }
        false
    }

    /// recordCppFnPtrBinding (tree-sitter.ts:5089).
    fn record_cpp_fn_ptr_binding(&mut self, local_name: &str, value: Option<Node>) {
        let Some(value) = value else { return };
        if value.kind() != "pointer_expression" {
            return;
        }
        if value.child(0).map(|c| c.kind() != "&").unwrap_or(true) {
            return; // `*p` dereference, not address-of
        }
        let arg = value
            .child_by_field_name("argument")
            .or_else(|| value.named_child(0));
        let Some(arg) = arg else { return };
        if !matches!(arg.kind(), "identifier" | "template_function" | "qualified_identifier") {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let caller_row = self.top_row();
        let target = strip_cpp_template_args(self.text(arg));
        if target.is_empty() || target == local_name {
            return;
        }
        let targets = self
            .local_fn_ptrs
            .entry(caller_row)
            .or_default()
            .entry(local_name.to_string())
            .or_default();
        if !targets.contains(&target) {
            targets.push(target); // Set semantics, insertion-ordered
        }
    }

    /// extractStaticMemberRef — cpp only (c is not in STATIC_MEMBER_LANGS).
    /// In this grammar the firing shape is `field_expression` (listed in
    /// MEMBER_ACCESS_TYPES for Scala — same node kind here): a capitalized
    /// simple receiver's value read.
    fn extract_static_member_ref(&mut self, node: Node<'t>) {
        if self.variant != Variant::Cpp {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        if !matches!(node.kind(), "field_expression" | "qualified_identifier") {
            return;
        }
        // Skip `Type.method()` — the access is a call's callee, already linked.
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
        if !matches!(
            recv.kind(),
            "identifier" | "type_identifier" | "simple_identifier" | "name" | "scoped_type_identifier"
        ) {
            return;
        }
        let text = self.text(recv);
        if capitalized_re().is_match(text) {
            let owner = self.top_row();
            let name = text.to_string();
            self.push_ref_at(owner, &name, edge_kind_index("references").unwrap(), recv);
        }
    }

    // --- function bodies -----------------------------------------------------

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

        // C++ stack construction `Calculator calc(0)` / `Widget w{1,2}` (#1035).
        if kind == "declaration"
            && self.variant == Variant::Cpp
            && self.is_cpp_stack_construction(node)
        {
            self.extract_instantiation(node);
        }

        // C++ local fn-pointer bindings: declarations and branch reassignments.
        if self.variant == Variant::Cpp && !self.stack.is_empty() {
            if kind == "declaration" {
                for i in 0..node.named_child_count() {
                    let Some(child) = node.named_child(i) else { continue };
                    if child.kind() != "init_declarator" {
                        continue;
                    }
                    let Some(decl) = child.child_by_field_name("declarator") else { continue };
                    if decl.kind() != "identifier" {
                        continue;
                    }
                    let local = self.text(decl).to_string();
                    self.record_cpp_fn_ptr_binding(&local, child.child_by_field_name("value"));
                }
            } else if kind == "assignment_expression" {
                if let Some(left) = node.child_by_field_name("left") {
                    if left.kind() == "identifier" {
                        let local = self.text(left).to_string();
                        self.record_cpp_fn_ptr_binding(&local, node.child_by_field_name("right"));
                    }
                }
            }
        }

        // Static-member / value-read: `Foo.BAR`, `Foo->x` (cpp).
        self.extract_static_member_ref(node);

        // Nested NAMED functions become their own nodes.
        if kind == "function_definition" {
            let nested_name = self.extract_name(node);
            if !nested_name.is_empty() && nested_name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }

        // Structural nodes inside bodies (local classes; macro-misparse rescue).
        if self.variant == Variant::Cpp && kind == "class_specifier" {
            self.extract_class(node);
            return;
        }
        if kind == "struct_specifier" {
            self.extract_struct(node);
            return;
        }
        if kind == "enum_specifier" {
            self.extract_enum(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- inheritance ---------------------------------------------------------

    /// extractInheritance — the branches whose node kinds occur in the c/cpp
    /// grammars: base_class_clause (#1043), the field_declaration Go-embedding
    /// shape, and the field_declaration_list recursion that reaches it.
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            match child.kind() {
                "base_class_clause" => {
                    for j in 0..child.named_child_count() {
                        let Some(t) = child.named_child(j) else { continue };
                        if matches!(
                            t.kind(),
                            "type_identifier" | "qualified_identifier" | "template_type"
                        ) {
                            let name = strip_cpp_template_args(self.text(t));
                            self.push_ref_at(class_row, &name, extends_kind, t);
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

    // --- fn-ref capture (#756, cFamilySpec) ----------------------------------

    /// maybeCaptureFnRefs + captureFnRefCandidates for the cFamily dispatch:
    /// argument_list(args), assignment_expression(rhs:right),
    /// init_declarator(varinit:value), initializer_list(list),
    /// initializer_pair(value:value).
    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let mode = match node.kind() {
            "argument_list" => Mode::Args,
            "assignment_expression" => Mode::Rhs,
            "init_declarator" => Mode::Varinit,
            "initializer_list" => Mode::List,
            "initializer_pair" => Mode::Value,
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
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
                    // Param-storage skip: `o->cb = cb` (LHS last name == RHS).
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
                // (init_declarator has no name/pattern field — no destructure skip)
                if let Some(v) = node.child_by_field_name("value") {
                    values.push(v);
                }
            }
        }

        for v in values {
            let explicit_ref = v.kind() != "identifier"; // !idTypes.has(type)
            self.normalize_fn_ref_value(v, from, mode, explicit_ref, 0);
        }
    }

    /// normalizeValue for cFamilySpec: bare identifiers, and the
    /// pointer_expression unwrap (`&fn`; `&Cls::m` keeps the qualified name).
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, mode: Mode, explicit_ref: bool, depth: u32) {
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v);
                if name.is_empty() || is_stoplisted(name) {
                    return;
                }
                self.push_fn_ref_cand(from, name.to_string(), mode, explicit_ref, v);
            }
            "pointer_expression" => {
                // `&x` is a function value; `*x` is a data read.
                if v.child(0).map(|c| c.kind() != "&").unwrap_or(true) {
                    return;
                }
                let Some(inner) = v.child_by_field_name("argument") else { return };
                if inner.kind() == "qualified_identifier" {
                    let text = self.text(inner).trim();
                    if qualified_ref_re().is_match(text) && !is_stoplisted(text) {
                        self.push_fn_ref_cand(from, text.to_string(), mode, explicit_ref, inner);
                    }
                    return;
                }
                self.normalize_fn_ref_value(inner, from, mode, explicit_ref, depth + 1);
            }
            _ => {}
        }
    }

    fn push_fn_ref_cand(&mut self, from: u32, name: String, mode: Mode, explicit_ref: bool, node: Node) {
        let p = node.start_position();
        self.fn_ref_cands.push(Cand {
            from,
            name,
            mode,
            explicit_ref,
            line: p.row as u32 + 1,
            column_byte: node.start_byte(),
            row: p.row,
        });
    }

    /// scanFnRefSubtree: capture-only walk of subtrees the main walkers skip
    /// (variable-declaration initializers). Halts at nested functions/lambdas.
    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        if depth > 0
            && matches!(
                node.kind(),
                "function_definition" | "arrow_function" | "function_expression"
                    | "lambda_literal" | "lambda_expression"
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

    /// flushFnRefCandidates with the cFamily gate policy: value/list positions
    /// at FILE scope skip the same-file/import gate (C has no symbol imports);
    /// cpp additionally requires explicit `&` forms outside those positions.
    fn flush_fn_ref_candidates(&mut self) {
        let cands = std::mem::take(&mut self.fn_ref_cands);
        if cands.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }
        let address_of_only = self.variant == Variant::Cpp;
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for c in cands {
            let at_file_scope = self.node_ids[c.from as usize].starts_with("file:");
            if address_of_only
                && !c.explicit_ref
                && !(at_file_scope && matches!(c.mode, Mode::Value | Mode::List))
            {
                continue;
            }
            if !c.name.starts_with("this.") && !c.name.contains("::") {
                let skip_gate = matches!(c.mode, Mode::Value | Mode::List) && at_file_scope;
                if !skip_gate
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

    // --- value refs (C only: VALUE_REF_LANGS has 'c', not 'cpp') -------------

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if self.variant != Variant::C {
            return;
        }
        if std::env::var("CODEGRAPH_VALUE_REFS").as_deref() == Ok("0") {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — the C declarator shape is init_declarator (a
        // file-scope const AND the local that shadows it both count).
        let mut decl_counts: HashMap<&str, u32> = HashMap::new();
        let mut dstack: Vec<Node> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if n.kind() == "init_declarator" {
                if let Some(name_node) = c_declarator_identifier(n) {
                    if matches!(name_node.kind(), "identifier" | "simple_identifier") {
                        let nm = self.text(name_node);
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
            // (No Dart/Pascal sibling-body pull-in: c/cpp bodies are children.)
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

// --- free helpers ------------------------------------------------------------

/// findDeclaratorQualifiedId (languages/c-cpp.ts:13): BFS for the declarator's
/// `qualified_identifier`, skipping parameter_list + trailing_return_type so a
/// qualified PARAMETER type can't be mistaken for the method name.
fn find_declarator_qualified_id(declarator: Node) -> Option<Node> {
    let mut queue: VecDeque<Node> = VecDeque::new();
    queue.push_back(declarator);
    while let Some(current) = queue.pop_front() {
        if current.kind() == "qualified_identifier" {
            return Some(current);
        }
        for i in 0..current.named_child_count() {
            if let Some(child) = current.named_child(i) {
                if child.kind() != "parameter_list" && child.kind() != "trailing_return_type" {
                    queue.push_back(child);
                }
            }
        }
    }
    None
}

/// cDeclaratorIdentifier (tree-sitter.ts:234): resolve the declared identifier
/// through init/pointer/array/parenthesized declarator wrappers; a
/// function_declarator means prototype/fn-ptr — null. (The C grammar's
/// parenthesized_declarator exposes no `declarator` field, so that arm always
/// terminates — bug-for-bug with getChildByField returning null there.)
fn c_declarator_identifier(node: Node) -> Option<Node> {
    let mut cur = Some(node);
    let mut guard = 0;
    while let Some(n) = cur {
        guard += 1;
        if guard > 12 {
            return None;
        }
        match n.kind() {
            "identifier" => return Some(n),
            "function_declarator" => return None,
            "init_declarator" | "pointer_declarator" | "array_declarator"
            | "parenthesized_declarator" => {
                cur = n.child_by_field_name("declarator");
            }
            _ => return None,
        }
    }
    None
}

/// isMacroMisparsedTypeDecl (languages/c-cpp.ts:261): `class MACRO Name {…}`
/// misparse residue — bodyless class/struct specifier in `type` + a
/// non-function_declarator declarator.
fn is_macro_misparsed_type_decl(node: Node) -> bool {
    let Some(type_node) = node.child_by_field_name("type") else { return false };
    if type_node.kind() != "class_specifier" && type_node.kind() != "struct_specifier" {
        return false;
    }
    let has_body = (0..type_node.named_child_count())
        .filter_map(|i| type_node.named_child(i))
        .any(|c| c.kind() == "field_declaration_list");
    if has_body {
        return false;
    }
    if let Some(declarator) = node.child_by_field_name("declarator") {
        if declarator.kind() == "function_declarator" {
            return false;
        }
    }
    true
}

/// hasFunctionAncestor (tree-sitter.ts:295).
fn has_function_ancestor(node: Node) -> bool {
    let mut p = node.parent();
    while let Some(n) = p {
        if n.kind() == "function_definition" {
            return true;
        }
        p = n.parent();
    }
    false
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
