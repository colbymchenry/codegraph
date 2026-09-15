//! Markdown path references from code string literals — the kernel half of the
//! code → documentation edge (`open("docs/guide.md#install")`).
//!
//! The wasm arm builds these in `TreeSitterExtractor`; a routed language never
//! reaches it, so without this the edge is absent for every kernel language.
//! `kernel-tsjs-parity` compares refs byte for byte, so the candidate regex and
//! the normalizer below mirror `extractMarkdownPathCandidates` and
//! `normalizeMarkdownPathReference` (src/extraction/tree-sitter.ts) exactly —
//! including the rejections. Change one side and the parity gate fails.

use regex::Regex;
use std::sync::OnceLock;

/// MARKDOWN_PATH_STRING_NODE_TYPES.
pub fn is_markdown_path_string_kind(kind: &str) -> bool {
    matches!(
        kind,
        "string"
            | "string_literal"
            | "template_string"
            | "raw_string_literal"
            | "interpreted_string_literal"
            | "interpolated_string_expression"
    )
}

fn candidate_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)((?:\.{1,2}[\\/]+|[A-Za-z0-9_.@-]+[\\/]+|[\\/]+)?(?:[A-Za-z0-9_.@-]+[\\/]+)*[A-Za-z0-9_.@-]+\.(?:md|mdx|markdown)(?:\?[^'"`\s)>,;]*)?(?:#[^'"`\s)>,;]*)?)"#,
        )
        .expect("markdown path candidate regex")
    })
}

fn scheme_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").expect("scheme regex"))
}

/// `decodeURIComponent`, falling back to the raw value when it would throw.
fn decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return value.to_string();
            }
            let hex = match std::str::from_utf8(&bytes[i + 1..i + 3]) {
                Ok(h) => h,
                Err(_) => return value.to_string(),
            };
            match u8::from_str_radix(hex, 16) {
                Ok(b) => out.push(b),
                Err(_) => return value.to_string(),
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_string())
}

/// `path.posix.normalize` for the shapes a doc path takes.
fn posix_normalize(p: &str) -> String {
    let is_abs = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if matches!(out.last(), Some(&last) if last != "..") {
                    out.pop();
                } else if !is_abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if is_abs {
        return format!("/{joined}");
    }
    if joined.is_empty() {
        return ".".to_string();
    }
    joined
}

fn ends_with_md(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".mdx") || lower.ends_with(".markdown")
}

/// `normalizeMarkdownPathReference` — None where the TS returns null.
fn normalize(reference_name: &str, file_path: &str) -> Option<String> {
    let trimmed = reference_name.trim().replace('\\', "/");
    if trimmed.is_empty() || scheme_re().is_match(&trimmed) {
        return None;
    }

    let (path_with_query, anchor) = match trimmed.find('#') {
        Some(i) => (&trimmed[..i], &trimmed[i..]),
        None => (trimmed.as_str(), ""),
    };
    let raw_path = match path_with_query.find('?') {
        Some(i) => &path_with_query[..i],
        None => path_with_query,
    };
    let clean_path = decode_path(raw_path);

    if !ends_with_md(&clean_path) {
        return None;
    }

    let file_posix = file_path.replace('\\', "/");
    let base_dir = match file_posix.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => file_posix[..i].to_string(),
        None => ".".to_string(),
    };

    let normalized_path = if let Some(rest) = clean_path.strip_prefix('/') {
        posix_normalize(rest.trim_start_matches('/'))
    } else if clean_path.starts_with("./") || clean_path.starts_with("../") {
        let joined = if base_dir == "." {
            clean_path.clone()
        } else {
            format!("{base_dir}/{clean_path}")
        };
        posix_normalize(&joined)
    } else {
        posix_normalize(&clean_path)
    };

    if normalized_path.is_empty()
        || normalized_path == "."
        || normalized_path == ".."
        || normalized_path.starts_with("../")
    {
        return None;
    }

    Some(format!("{normalized_path}{anchor}"))
}

/// Every markdown path reference in one string literal's text, as
/// (normalized name, byte offset of the match within `text`). The offset is
/// added to the literal's own column, mirroring the wasm arm.
pub fn markdown_path_refs(text: &str, file_path: &str) -> Vec<(String, usize)> {
    let mut refs = Vec::new();
    for m in candidate_re().find_iter(text) {
        // A `scheme://host/x.md` URL is not a repo path. The wasm arm looks
        // back 16 chars for the `://` rather than matching it, because the
        // candidate pattern starts after the scheme.
        let start = m.start();
        let prefix = &text[start.saturating_sub(16)..start];
        if prefix.ends_with("://") {
            continue;
        }
        if let Some(name) = normalize(m.as_str(), file_path) {
            refs.push((name, start));
        }
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_paths_against_the_file() {
        let refs = markdown_path_refs("'../docs/guide.md#install'", "src/load-docs.ts");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].0, "docs/guide.md#install");
    }

    #[test]
    fn rejects_an_escape_above_the_repo_root() {
        assert!(markdown_path_refs("'../../../up.md'", "src/x.ts").is_empty());
    }

    #[test]
    fn a_scheme_prefixed_path_is_whatever_the_wasm_arm_makes_of_it() {
        // Not asserted either way here on purpose. The candidate pattern can
        // start inside a URL (at the `//`), so the `://` look-back does not
        // always fire, and the wasm arm — not a guess about it — is the spec.
        // `kernel-tsjs-parity` pins this against a torture fixture instead.
        let _ = markdown_path_refs("'https://example.com/a.md'", "src/x.ts");
    }

    #[test]
    fn keeps_a_bare_name_and_an_anchor() {
        let refs = markdown_path_refs("'README.md'", "src/x.ts");
        assert_eq!(refs[0].0, "README.md");
    }
}
