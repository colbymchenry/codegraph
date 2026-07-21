//! Python extraction — a faithful Rust port of `TreeSitterExtractor`'s Python
//! paths (src/extraction/tree-sitter.ts) plus languages/python.ts.
//!
//! Same porting contract as tsjs/java: behavior parity, bug-for-bug —
//! including the quirks: decorates refs only fire for bare-identifier
//! decorators (`@staticmethod` yes, `@app.route(...)` no — python's `call`
//! kind isn't `call_expression`), module-level assignments always extract as
//! `variable` (no isConst hook), and `self.method` fn-ref candidates carry the
//! BARE attribute name. Python is not a TYPE_ANNOTATION language — no type
//! refs anywhere. Files with parse errors defer to wasm.

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_STATIC, FUNCTION_REF_CODE, NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;

struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    is_async: Option<bool>,
    is_static: Option<bool>,
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
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("python").ok_or("no python grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(python) failed: {e}"))?;
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
        let end_line = node.end_position().row as u32 + 1;

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
            visibility: 0,
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
        // captureValueRefScope
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

    /// pythonExtractor.getSignature: params + ` -> returnType`.
    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if let Some(ret) = node.child_by_field_name("return_type") {
            sig.push_str(" -> ");
            sig.push_str(self.text(ret));
        }
        Some(sig)
    }

    /// pythonExtractor.isAsync: the PREVIOUS SIBLING token is `async`.
    fn is_async(&self, node: Node) -> bool {
        node.prev_sibling().map(|p| p.kind() == "async").unwrap_or(false)
    }

    /// pythonExtractor.isStatic: preceding decorator mentioning `staticmethod`.
    fn is_static(&self, node: Node) -> bool {
        if let Some(prev) = node.prev_named_sibling() {
            if prev.kind() == "decorator" {
                return self.text(prev).contains("staticmethod");
            }
        }
        false
    }

    // --- visitNode ------------------------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_definition" {
            // functionTypes ∩ methodTypes: inside a class-like ⇒ method.
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "class_definition" {
            self.extract_class(node);
            skip_children = true;
        } else if kind == "assignment" && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_statement" || kind == "import_from_statement" {
            self.extract_import(node);
        } else if kind == "call" {
            self.extract_call(node);
        }

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call" {
            self.extract_call(node);
        }

        // Nested NAMED functions become their own nodes.
        if kind == "function_definition" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_definition" {
            self.extract_class(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- extractors --------------------------------------------------------------

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
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        // (python is not a TYPE_ANNOTATION language — no type refs)
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
            signature: self.signature_of(node),
            is_async: Some(self.is_async(node)),
            is_static: Some(self.is_static(node)),
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };
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
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };

        // Inheritance: `class Flask(Scaffold, Mixin):` — argument_list children.
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "argument_list" {
                for j in 0..child.named_child_count() {
                    let Some(arg) = child.named_child(j) else { continue };
                    if matches!(arg.kind(), "identifier" | "attribute") {
                        let name = self.text(arg).to_string();
                        self.push_ref_at(row, &name, extends_kind, arg);
                    }
                }
            }
        }
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

    /// extractVariable's python branch: `left = right` at module scope.
    fn extract_variable(&mut self, node: Node<'t>) {
        let docstring = preceding_docstring(node, self.src);
        let left = node.child_by_field_name("left").or_else(|| node.named_child(0));
        let right = node.child_by_field_name("right").or_else(|| node.named_child(1));
        let Some(left) = left else { return };
        if !matches!(left.kind(), "identifier" | "constant") {
            return;
        }
        let name = self.text(left).to_string();
        let signature = right.map(|r| util::init_signature(self.text(r)));
        // No isConst hook ⇒ always `variable` (UPPER_CASE constants included).
        self.create_node("variable", &name, node, Extra { docstring, signature, ..Extra::default() });
    }

    fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let imports_kind = edge_kind_index("imports").unwrap();

        if node.kind() == "import_from_statement" {
            // Hook path: module_name field → import node + module ref, then
            // per-name binding refs (emitPyFromImportRefs).
            let Some(module_node) = node.child_by_field_name("module_name") else { return };
            let module_name = self.text(module_node).to_string();
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

            // emitPyFromImportRefs: one `imports` ref per imported name.
            for i in 0..node.named_child_count() {
                let Some(child) = node.named_child(i) else { continue };
                if child.start_byte() == module_node.start_byte()
                    && child.end_byte() == module_node.end_byte()
                {
                    continue;
                }
                if child.kind() == "wildcard_import" {
                    continue;
                }
                let name_node = match child.kind() {
                    "aliased_import" => child
                        .child_by_field_name("alias")
                        .or_else(|| child.child_by_field_name("name"))
                        .or_else(|| child.named_child(0)),
                    "dotted_name" => Some(child),
                    _ => None,
                };
                let Some(name_node) = name_node else { continue };
                let raw = self.text(name_node);
                let local = raw.rsplit('.').next().unwrap_or("");
                if local.is_empty() {
                    continue;
                }
                self.push_ref_at(parent, &local.to_string(), imports_kind, name_node);
            }
            return;
        }

        // import_statement: `import a.b, x as y` — one import node + module ref
        // per dotted name (the python multi-import branch).
        let parent = self.top_row();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "dotted_name" {
                let name = self.text(child).to_string();
                self.create_node(
                    "import",
                    &name,
                    node,
                    Extra { signature: Some(import_text.clone()), ..Extra::default() },
                );
                self.push_ref_at(parent, &name, imports_kind, child);
            } else if child.kind() == "aliased_import" {
                let dotted = (0..child.named_child_count())
                    .filter_map(|j| child.named_child(j))
                    .find(|c| c.kind() == "dotted_name");
                if let Some(dotted) = dotted {
                    let name = self.text(dotted).to_string();
                    self.create_node(
                        "import",
                        &name,
                        node,
                        Extra { signature: Some(import_text.clone()), ..Extra::default() },
                    );
                    self.push_ref_at(parent, &name, imports_kind, dotted);
                }
            }
        }
    }

    /// extractCall — python `call` through the generic tail (attribute callees).
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "attribute" {
                // `property` and `field` fields don't exist on attribute —
                // the generic path falls back to namedChild(1) (the attr name).
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
                            return;
                        }
                    }
                    let recv_ident = receiver.filter(|r| {
                        matches!(r.kind(), "identifier" | "simple_identifier" | "field_identifier")
                    });
                    if let Some(r) = recv_ident {
                        let receiver_name = self.text(r);
                        if !matches!(receiver_name, "self" | "this" | "cls" | "super") {
                            callee_name = format!("{receiver_name}.{method_name}");
                        } else {
                            callee_name = method_name.to_string();
                        }
                    } else {
                        callee_name = method_name.to_string();
                    }
                }
            } else {
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            if let Some(c) = util::paren_conversion().captures(&callee_name) {
                callee_name = c[1].to_string();
            }
            let from = self.top_row();
            self.push_ref_at(from, &callee_name.clone(), edge_kind_index("calls").unwrap(), node);
        }
    }

    /// extractDecoratorsFor — python decorators are PRECEDING SIBLINGS inside
    /// decorated_definition. Only bare-identifier decorators yield a target
    /// (python's `call` kind isn't `call_expression`, and `attribute` isn't in
    /// the target-kind list — mirrored exactly).
    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for i in 0..decl.named_child_count() {
            if let Some(child) = decl.named_child(i) {
                self.consider_decorator(child, decorated_row);
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
        let mut name = self.text(target).to_string();
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
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        self.push_ref_at(decorated_row, &name, edge_kind_index("decorates").unwrap(), n);
    }

    // --- fn refs (PYTHON_SPEC) ------------------------------------------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "argument_list" => ("args", ""),
            "assignment" => ("rhs", "right"),
            "keyword_argument" => ("value", "value"),
            "pair" => ("value", "value"),
            "list" => ("list", ""),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            "args" | "list" => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        values.push(c);
                    }
                }
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
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
            _ => {
                if let Some(v) = node.child_by_field_name(field) {
                    values.push(v);
                }
            }
        }

        for v in values {
            let (name, anchor) = match v.kind() {
                "identifier" => (self.text(v).to_string(), v),
                // `self.handle_click` — object EXACTLY `self`; BARE attr name.
                "attribute" => {
                    let obj = v.child_by_field_name("object");
                    let attr = v.child_by_field_name("attribute");
                    match (obj, attr) {
                        (Some(o), Some(a))
                            if o.kind() == "identifier" && self.text(o) == "self" =>
                        {
                            (self.text(a).to_string(), a)
                        }
                        _ => continue,
                    }
                }
                _ => continue,
            };
            if name.is_empty() || is_stoplisted(&name) {
                continue;
            }
            let p = anchor.start_position();
            self.fn_ref_cands.push(Cand {
                from,
                name,
                line: p.row as u32 + 1,
                column_byte: anchor.start_byte(),
                row: p.row,
            });
        }
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        if depth > 12 {
            return;
        }
        // Halts at functionTypes ∪ the fixed arrow/lambda list — python's
        // `lambda` kind is NOT in that list (mirrored).
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

    // --- value refs -------------------------------------------------------------------

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

        // Shadow prune — python's declarator shape is `assignment`.
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
                            if let Some(c) = left.named_child(i) {
                                if c.kind() == "identifier" {
                                    let nm = self.text(c);
                                    if targets.contains_key(nm) {
                                        *decl_counts.entry(nm).or_insert(0) += 1;
                                    }
                                }
                            }
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

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}

/// LITERAL_RECEIVER_TYPES membership (shared table; python names among them).
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

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
