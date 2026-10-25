//! Export status — the Rust mirror of `src/extraction/export-status.ts` (#1721).
//!
//! The TS module owns the one implementation of "is this name exported from
//! this file". This mirrors it for the native kernel, which has no syntax tree
//! at the points that ask the per-file question and decodes its own tables.
//! Every function notes the TS function it mirrors — change one side, change
//! the other, or the parity gate (`__tests__/kernel-tsjs-parity.test.ts`) fails.
//!
//! The forms a source scan recognizes, and why the AST walk is not enough, are
//! documented at length in the TS module; this file keeps the same shapes so
//! the two can be read side by side.

/// `IDENTIFIER` in export-status.ts: a plain ASCII identifier.
pub(super) fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Mirrors `commentStrippedJsSource`: C-style comments blanked, string literals
/// left INTACT — what the CommonJS name scan reads, since the bracket form puts
/// the exported name inside a string (`exports["x"] = …`).
///
/// Offsets are preserved (blanked characters are replaced by spaces, newlines
/// kept), matching the TS helper, so a match index still maps to its line.
pub(super) fn comment_stripped_js_source(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out: Vec<u8> = bytes.to_vec();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        let c2 = bytes.get(i + 1).copied().unwrap_or(0);
        if c == b'/' && c2 == b'*' {
            let start = i;
            i += 2;
            while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            if i < bytes.len() {
                i += 2;
            }
            blank_range(&mut out, start, i, bytes);
            continue;
        }
        if c == b'/' && c2 == b'/' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i, bytes);
            continue;
        }
        // A string literal is skipped whole (so a `//` inside it is data), but
        // its characters are left as they are.
        if c == b'"' || c == b'\'' || c == b'`' {
            let quote = c;
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if quote != b'`' && bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < bytes.len() && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    // Every byte written is ASCII or a preserved UTF-8 sequence, so this is
    // valid UTF-8: only ASCII bytes are ever replaced, and multi-byte
    // characters contain no ASCII byte.
    String::from_utf8(out).unwrap_or_else(|_| source.to_string())
}

/// Mirrors `maskedJsSource`: comments blanked AND string contents blanked, so a
/// regex over the result cannot match text that only looks like an export.
pub(super) fn masked_js_source(source: &str) -> String {
    let stripped = comment_stripped_js_source(source);
    let bytes = stripped.as_bytes();
    let mut out: Vec<u8> = bytes.to_vec();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' || c == b'\'' || c == b'`' {
            let quote = c;
            i += 1;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                    continue;
                }
                if quote != b'`' && bytes[i] == b'\n' {
                    break;
                }
                if bytes[i] != b'\n' {
                    out[i] = b' ';
                }
                i += 1;
            }
            if i < bytes.len() && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| stripped)
}

/// Replace every byte in `start..end` with a space, keeping newlines.
fn blank_range(out: &mut [u8], start: usize, end: usize, src: &[u8]) {
    for i in start..end.min(src.len()) {
        if src[i] != b'\n' {
            out[i] = b' ';
        }
    }
}

/// Mirrors `isExportedLaterInSource`: whether `name` is exported by a LATER
/// statement than its declaration — `export default NAME`, `export { NAME }`,
/// `export { NAME as default }`.
///
/// The name must be a specifier the clause exports AS ITSELF or AS THE DEFAULT:
/// `export { A as B }` exports `B`, and `A` is only the local source of it, so
/// a caller asking after `A` must not be told yes (the ambient-module case).
/// `A as default` does count — the binding is the module's default.
pub(super) fn is_exported_later_in_source(source: &str, name: &str) -> bool {
    if !is_identifier(name) {
        return false;
    }
    let n = regex::escape(name);
    // `R` (CRLF mode): JS's multiline `^`/`$` treat `\r` as a line end as well
    // as `\n`; `(?m)` alone sees only `\n`, and would miss `export default
    // NAME;\r\n` on every Windows autocrlf checkout.
    let default_form = format!(r"(?mR)^[ \t]*export\s+default\s+{n}\s*;?[ \t]*$", n = n);
    if regex::Regex::new(&default_form)
        .map(|re| re.is_match(source))
        .unwrap_or(false)
    {
        return true;
    }
    let Ok(clauses) = regex::Regex::new(r"(?mR)^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}") else {
        return false;
    };
    for cap in clauses.captures_iter(source) {
        let Some(body) = cap.get(1) else { continue };
        for raw in body.as_str().split(',') {
            let specifier = raw.trim().trim_start_matches("type ").trim();
            if specifier.is_empty() {
                continue;
            }
            if let Some((local, exported)) = specifier.split_once(" as ") {
                let local = local.trim();
                let exported = exported.trim();
                if exported == name || (exported == "default" && local == name) {
                    return true;
                }
                continue;
            }
            if specifier == name {
                return true;
            }
        }
    }
    false
}

/// Mirrors `isCommonJsExportedName`: whether a name is exported by a CommonJS
/// assignment anywhere in the file — `exports.NAME = …`,
/// `module.exports.NAME = …`, `exports["NAME"] = …`, or a
/// `module.exports = { NAME }` object literal.
pub(super) fn is_common_js_exported_name(source: &str, name: &str) -> bool {
    if !is_identifier(name) {
        return false;
    }
    let n = regex::escape(name);
    let assignment = format!(
        r#"\b(?:module\.exports|exports)\s*(?:\.|\[)\s*['"]?{n}['"]?\s*\]?\s*="#,
        n = n
    );
    if regex::Regex::new(&assignment)
        .map(|re| re.is_match(source))
        .unwrap_or(false)
    {
        return true;
    }
    let Ok(object) = regex::Regex::new(r"\bmodule\.exports\s*=\s*(\{[\s\S]*?\})\s*;?") else {
        return false;
    };
    for cap in object.captures_iter(source) {
        let Some(rhs) = cap.get(1) else { continue };
        if let Some(names) = common_js_object_export_names(rhs.as_str()) {
            if names.iter().any(|x| x == name) {
                return true;
            }
        }
    }
    false
}

/// Mirrors `commonJsObjectExportNames`: the names a `module.exports = { … }`
/// object literal exports, in shorthand (`{ x }`), keyed (`{ x: impl }`) and
/// string-keyed (`{ 'x': impl }`) form. None when the right-hand side is not an
/// object literal.
pub(super) fn common_js_object_export_names(right: &str) -> Option<Vec<String>> {
    let text = right.trim();
    if !text.starts_with('{') || !text.ends_with('}') {
        return None;
    }
    let body = &text[1..text.len() - 1];
    let mut names = Vec::new();
    for raw_entry in split_top_level(body) {
        let entry = raw_entry.trim();
        if entry.is_empty() {
            continue;
        }
        // `...spread` contributes names this scan cannot know — skip it rather
        // than guess one.
        if entry.starts_with("...") {
            continue;
        }
        match top_level_colon(entry) {
            None => {
                // Shorthand `{ x }` — the name is the binding.
                let name = entry.trim_start_matches("...").trim();
                if is_identifier(name) {
                    names.push(name.to_string());
                }
            }
            Some(colon) => {
                let key = entry[..colon].trim();
                if let Some(inner) = quoted_identifier(key) {
                    names.push(inner);
                } else if is_identifier(key) {
                    names.push(key.to_string());
                }
            }
        }
    }
    Some(names)
}

/// Mirrors `commonJsExportNameFromAssignment`: the property a CommonJS export
/// assignment binds a value to — `exports.NAME = …`, `module.exports.NAME = …`,
/// `exports["NAME"] = …` — or None for any other assignment.
///
/// The bracket form's quotes must match, which this crate's regex cannot
/// express (no backreferences), so the quoting is stripped by hand.
pub(super) fn common_js_export_name_from_assignment(left: &str) -> Option<String> {
    let text = left.trim();
    let Ok(dot) = regex::Regex::new(r"^(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)$") else {
        return None;
    };
    if let Some(cap) = dot.captures(text) {
        return cap.get(1).map(|m| m.as_str().to_string());
    }
    let head = ["module.exports", "exports"]
        .iter()
        .find_map(|prefix| text.strip_prefix(prefix))?;
    let inner = head.trim_start().strip_prefix('[')?.trim_end().strip_suffix(']')?;
    let inner = inner.trim();
    let unquoted = inner
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| inner.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))?;
    let unquoted = unquoted.trim();
    if is_identifier(unquoted) {
        Some(unquoted.to_string())
    } else {
        None
    }
}

/// `'x'` / `"x"` → `x`, for an object-literal key. None when not a quoted
/// identifier.
fn quoted_identifier(key: &str) -> Option<String> {
    let inner = key
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| key.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))?;
    if is_identifier(inner) {
        Some(inner.to_string())
    } else {
        None
    }
}

/// Split an object-literal body on top-level commas (not inside
/// braces/brackets/parens/strings). Mirrors `splitTopLevel`.
///
/// Byte iteration is safe here: every character this looks at is ASCII, and a
/// UTF-8 continuation byte is never one of them, so the slices land on
/// character boundaries.
fn split_top_level(body: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut start = 0usize;
    let mut quote: Option<u8> = None;
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' | b'`' => quote = Some(c),
            b'{' | b'[' | b'(' => depth += 1,
            b'}' | b']' | b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&body[start..]);
    parts
}

/// The index of the top-level `:` in an object-literal entry, or None.
/// Mirrors `topLevelColon`.
fn top_level_colon(entry: &str) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut quote: Option<u8> = None;
    let bytes = entry.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' | b'\'' | b'`' => quote = Some(c),
            b'{' | b'[' | b'(' => depth += 1,
            b'}' | b']' | b')' => depth -= 1,
            b':' if depth == 0 => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}
