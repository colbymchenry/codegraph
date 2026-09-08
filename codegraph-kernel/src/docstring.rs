//! getPrecedingDocstring / cleanCommentMarkers — faithful port of
//! src/extraction/tree-sitter-helpers.ts (#780 wrapper-climb semantics).

use regex::Regex;
use std::sync::OnceLock;
use tree_sitter::Node;

/// DOCSTRING_WRAPPER_TYPES (tree-sitter-helpers.ts).
fn is_wrapper(kind: &str) -> bool {
    matches!(
        kind,
        "export_statement"
            | "decorated_definition"
            | "lexical_declaration"
            | "variable_declaration"
            | "variable_declarator"
            | "ambient_declaration"
    )
}

fn is_comment(kind: &str) -> bool {
    matches!(
        kind,
        "comment" | "line_comment" | "block_comment" | "documentation_comment"
    )
}

struct Cleaners {
    block_open: Regex,
    block_close: Regex,
    lua_open: Regex,
    lua_close: Regex,
    paren_star_open: Regex,
    paren_star_close: Regex,
    brace_open: Regex,
    brace_close: Regex,
    slashes: Regex,
    dashes: Regex,
    hash: Regex,
    percent: Regex,
    star_cont: Regex,
}

fn cleaners() -> &'static Cleaners {
    static C: OnceLock<Cleaners> = OnceLock::new();
    C.get_or_init(|| Cleaners {
        block_open: Regex::new(r"^/\*+!?").unwrap(),
        block_close: Regex::new(r"\*+/$").unwrap(),
        lua_open: Regex::new(r"^--\[=*\[").unwrap(),
        lua_close: Regex::new(r"\]=*\]$").unwrap(),
        paren_star_open: Regex::new(r"^\(\*").unwrap(),
        paren_star_close: Regex::new(r"\*\)$").unwrap(),
        brace_open: Regex::new(r"^\{").unwrap(),
        brace_close: Regex::new(r"\}$").unwrap(),
        slashes: Regex::new(r"\A//[/!]?\s?").unwrap(),
        dashes: Regex::new(r"\A--\s?").unwrap(),
        hash: Regex::new(r"\A#\s?").unwrap(),
        percent: Regex::new(r"\A%+\s?").unwrap(),
        star_cont: Regex::new(r"\A\s*\*\s?").unwrap(),
    })
}

/// JS multiline `^` anchors after \n, \r, U+2028, U+2029; the regex crate's
/// `(?m)^` anchors after `\n` only. On CRLF content the JS engine finds a line
/// start after the `\r`, so a greedy leading `\s*` (the block-continuation
/// rule) consumes the `\n` and leaves the bare `\r` in the docstring —
/// byte-parity on CRLF checkouts (every Windows autocrlf clone) depends on
/// reproducing exactly that.
fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JS-semantics `str.replace(/^<pat>/gm, "")`: try the \A-anchored `pat` at
/// position 0 and after every JS line terminator, left to right, resuming
/// after each match's end — a faithful /g replace. (Remaining known
/// divergence: JS `\s` includes U+FEFF, Rust's does not; an embedded BOM
/// inside a comment is accepted as unreachable.)
fn js_multiline_strip(s: &str, pat: &Regex) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0usize;
    let mut pos = 0usize;
    while pos <= s.len() {
        let at_line_start = pos == 0
            || s[..pos].chars().next_back().is_some_and(is_js_line_terminator);
        if at_line_start {
            if let Some(m) = pat.find(&s[pos..]) {
                if !m.is_empty() {
                    out.push_str(&s[last..pos]);
                    last = pos + m.end();
                    pos = last;
                    continue;
                }
            }
        }
        match s[pos..].chars().next() {
            Some(c) => pos += c.len_utf8(),
            None => break,
        }
    }
    out.push_str(&s[last..]);
    out
}

/// cleanCommentMarkers — strip comment syntax, keep the prose.
pub fn clean_comment_markers(comment: &str) -> String {
    let c = cleaners();
    let mut s = comment.trim().to_string();
    if s.starts_with("/*") {
        s = c.block_open.replace(&s, "").into_owned();
        s = c.block_close.replace(&s, "").into_owned();
    } else if s.starts_with("--[") {
        s = c.lua_open.replace(&s, "").into_owned();
        s = c.lua_close.replace(&s, "").into_owned();
    } else if s.starts_with("(*") {
        s = c.paren_star_open.replace(&s, "").into_owned();
        s = c.paren_star_close.replace(&s, "").into_owned();
    } else if s.starts_with('{') {
        s = c.brace_open.replace(&s, "").into_owned();
        s = c.brace_close.replace(&s, "").into_owned();
    }
    s = js_multiline_strip(&s, &c.slashes);
    s = js_multiline_strip(&s, &c.dashes);
    s = js_multiline_strip(&s, &c.hash);
    s = js_multiline_strip(&s, &c.percent);
    s = js_multiline_strip(&s, &c.star_cont);
    s.trim().to_string()
}

/// getPrecedingDocstring — collect the comment run immediately preceding the
/// node (climbing out of declaration wrappers first), cleaned and joined.
/// Returns None when there is no preceding comment (a PRESENT-but-empty
/// docstring after cleaning still returns Some(""), matching the TS helper).
pub fn preceding_docstring(node: Node, src: &str) -> Option<String> {
    let mut anchor = node;
    while let Some(parent) = anchor.parent() {
        if is_wrapper(parent.kind()) {
            anchor = parent;
        } else {
            break;
        }
    }

    let mut comments: Vec<&str> = Vec::new();
    let mut sibling = anchor.prev_named_sibling();
    while let Some(s) = sibling {
        if is_comment(s.kind()) {
            comments.push(&src[s.byte_range()]);
            sibling = s.prev_named_sibling();
        } else {
            break;
        }
    }
    if comments.is_empty() {
        return None;
    }
    comments.reverse(); // collected nearest-first; TS unshifts to keep source order
    Some(
        comments
            .iter()
            .map(|c| clean_comment_markers(c))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_and_block_markers() {
        assert_eq!(clean_comment_markers("// hello"), "hello");
        assert_eq!(clean_comment_markers("/// doc line"), "doc line");
        assert_eq!(
            clean_comment_markers("/**\n * Adds things.\n * @param a first\n */"),
            "Adds things.\n@param a first"
        );
    }

    /// CRLF parity with the JS reference: multiline `^` matches after `\r`,
    /// so the block-continuation `\s*` eats the `\n` and the bare `\r`
    /// survives in the cleaned docstring (pinned against the wasm extractor
    /// on a CRLF checkout — the Windows autocrlf shape).
    #[test]
    fn crlf_matches_js_reference() {
        assert_eq!(
            clean_comment_markers("/**\r\n * Class docs.\r\n * Multi-line.\r\n */"),
            "Class docs.\rMulti-line."
        );
        assert_eq!(
            clean_comment_markers("// a\r\n// b"),
            "a\r\nb"
        );
    }
}
