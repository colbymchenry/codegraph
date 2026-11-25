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
            // Objective-C, which the kernel does not walk: kept for parity.
            | "implementation_definition"
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
    preceding_docstring_stepping_over(node, src, &[])
}

/// getPrecedingDocstring's `stepOver` — sibling kinds that may stand between
/// the declaration and its comments without ending the run (Dart's
/// `annotation`: `/// Builds it.` `@override` `Widget build(…)`). They are not
/// part of the docstring; the comments on either side of one still join.
pub fn preceding_docstring_stepping_over(
    node: Node,
    src: &str,
    step_over: &[&str],
) -> Option<String> {
    preceding_docstring_with(node, src, step_over, false, false, false)
}

/// getPrecedingDocstring's `skipTrailing`, `skipDetached` and `skipDirectives`,
/// which Go turns on together for the doc comment go doc shows. The comments
/// the run opens with that belong to the line above are left out: one written
/// after code on its line (`const n = 4 // four.`), and any that begins on the
/// line such a comment ends. Of the rest, only the comments that end on the
/// line right above the declaration, together with the ones written on the
/// lines just before them, are kept: a blank line ends the docstring, and a
/// comment that ends on the declaration's own line documents nothing. A
/// directive among them (`//go:embed static`, `//nolint:errcheck`) is left out
/// of the text.
pub fn preceding_go_doc_comment(node: Node, src: &str) -> Option<String> {
    preceding_docstring_with(node, src, &[], true, true, true)
}

fn preceding_docstring_with(
    node: Node,
    src: &str,
    step_over: &[&str],
    skip_trailing: bool,
    skip_detached: bool,
    skip_directives: bool,
) -> Option<String> {
    let mut anchor = node;
    while let Some(parent) = anchor.parent() {
        if is_wrapper(parent.kind()) {
            anchor = parent;
        } else {
            break;
        }
    }

    let mut comments: Vec<Node> = Vec::new();
    let mut sibling = anchor.prev_named_sibling();
    while let Some(s) = sibling {
        if is_comment(s.kind()) {
            comments.push(s);
            sibling = s.prev_named_sibling();
        } else if step_over.contains(&s.kind()) {
            sibling = s.prev_named_sibling();
        } else {
            break;
        }
    }
    comments.reverse(); // collected nearest-first; TS unshifts to keep source order

    let mut first = 0;
    if skip_trailing {
        let mut end_row = 0;
        for c in &comments {
            let trails = if first == 0 {
                follows_code_on_its_line(*c, src)
            } else {
                c.start_position().row == end_row
            };
            if !trails {
                break;
            }
            end_row = c.end_position().row;
            first += 1;
        }
    }
    if skip_detached {
        // Walk back from the declaration: the last comment must end on the
        // line above it, and each one before joins while it ends on the line
        // the next one starts, or the line before that.
        let mut start = comments.len();
        if start > first && comments[start - 1].end_position().row + 1 == anchor.start_position().row {
            start -= 1;
            while start > first
                && comments[start - 1].end_position().row + 1 >= comments[start].start_position().row
            {
                start -= 1;
            }
        }
        first = start;
    }
    let doc_comments: Vec<Node> = comments[first..]
        .iter()
        .copied()
        .filter(|c| !skip_directives || !is_directive(&src[c.byte_range()]))
        .collect();
    if doc_comments.is_empty() {
        return None;
    }
    Some(
        doc_comments
            .iter()
            .map(|c| clean_comment_markers(&src[c.byte_range()]))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

/// isDirective (tree-sitter-helpers.ts) — a comment directive Go tools read,
/// which go doc leaves out of a doc comment's text (go/ast's isDirective): a
/// `//` comment with no space after the slashes that is `//line `, `//extern `
/// or `//export ` followed by text, or that opens with a lowercase word, a
/// colon and a lowercase letter or digit (`//go:embed x`, `//nolint:errcheck`).
fn is_directive(comment: &str) -> bool {
    let Some(text) = comment.strip_prefix("//") else {
        return false;
    };
    if text.starts_with("line ") || text.starts_with("extern ") || text.starts_with("export ") {
        return true;
    }
    let word_char = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = text.as_bytes();
    let word = bytes.iter().take_while(|b| word_char(b)).count();
    word > 0 && bytes.get(word) == Some(&b':') && bytes.get(word + 1).is_some_and(word_char)
}

/// followsCodeOnItsLine (tree-sitter-helpers.ts) — whether code comes before
/// `node` on the line it starts on.
fn follows_code_on_its_line(node: Node, src: &str) -> bool {
    let before = src[..node.start_byte()].trim_end_matches([' ', '\t']);
    !before.is_empty() && !before.ends_with(['\n', '\r'])
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

    /// A `step_over` kind is passed without ending the run, and the comments
    /// on either side of it join; any other node still ends it. With no
    /// step-over kinds the walk stops at the first non-comment, as before.
    #[test]
    fn steps_over_only_the_listed_kinds() {
        let grammar = crate::langs::grammar_for("dart").expect("dart grammar");
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&grammar).unwrap();
        let src = "void g() {}\n/// a\n@x\n// b\nvoid f() {}\n";
        let tree = parser.parse(src, None).unwrap();
        let root = tree.root_node();
        let f = (0..root.named_child_count())
            .filter_map(|i| root.named_child(i))
            .filter(|n| n.kind() == "function_signature")
            .nth(1)
            .expect("f's signature");
        assert_eq!(preceding_docstring(f, src).as_deref(), Some("b"));
        assert_eq!(
            preceding_docstring_stepping_over(f, src, &["annotation"]).as_deref(),
            Some("a\nb")
        );
    }

    /// Skipping trailing comments leaves out one written after code on its
    /// line and one beginning on the line it ends; a comment on a line of its
    /// own still opens the run. Without it, nothing is left out.
    #[test]
    fn skips_the_comments_that_trail_code() {
        let grammar = crate::langs::grammar_for("go").expect("go grammar");
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&grammar).unwrap();
        let src = "package p\n\nconst n = 4 /* a */ // b\n// c\nfunc f() {}\n\nvar m = 1 // d\nfunc g() {}\n";
        let tree = parser.parse(src, None).unwrap();
        let root = tree.root_node();
        let func = |name: &str| {
            (0..root.named_child_count())
                .filter_map(|i| root.named_child(i))
                .find(|n| {
                    n.kind() == "function_declaration"
                        && n.child_by_field_name("name").map(|id| &src[id.byte_range()]) == Some(name)
                })
                .expect(name)
        };
        let skipping_trailing = |n| preceding_docstring_with(n, src, &[], true, false, false);
        assert_eq!(preceding_docstring(func("f"), src).as_deref(), Some("a\nb\nc"));
        assert_eq!(skipping_trailing(func("f")).as_deref(), Some("c"));
        assert_eq!(preceding_docstring(func("g"), src).as_deref(), Some("d"));
        assert_eq!(skipping_trailing(func("g")), None);
    }

    /// Skipping detached comments keeps the comments that end on the line
    /// above the declaration and those on the lines just before them; a blank
    /// line ends the run, and a comment on the declaration's own line is not
    /// kept. Without it, every comment is.
    #[test]
    fn skips_the_comments_a_blank_line_detaches() {
        let grammar = crate::langs::grammar_for("go").expect("go grammar");
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&grammar).unwrap();
        let src = "package p\n\n// a\n\n// b\n/*\nc\n*/\n// d\nfunc f() {}\n\n// e\n\nfunc g() {}\n\n/* h */ func h() {}\n";
        let tree = parser.parse(src, None).unwrap();
        let root = tree.root_node();
        let func = |name: &str| {
            (0..root.named_child_count())
                .filter_map(|i| root.named_child(i))
                .find(|n| {
                    n.kind() == "function_declaration"
                        && n.child_by_field_name("name").map(|id| &src[id.byte_range()]) == Some(name)
                })
                .expect(name)
        };
        let skipping_detached = |n| preceding_docstring_with(n, src, &[], false, true, false);
        assert_eq!(preceding_docstring(func("f"), src).as_deref(), Some("a\nb\nc\nd"));
        assert_eq!(skipping_detached(func("f")).as_deref(), Some("b\nc\nd"));
        assert_eq!(preceding_docstring(func("g"), src).as_deref(), Some("e"));
        assert_eq!(skipping_detached(func("g")), None);
        assert_eq!(preceding_docstring(func("h"), src).as_deref(), Some("h"));
        assert_eq!(skipping_detached(func("h")), None);
    }

    /// The directive shapes go/ast leaves out of a doc comment's text, and
    /// the near misses it keeps.
    #[test]
    fn recognizes_go_directives() {
        for directive in ["//go:embed x", "//nolint:errcheck", "//a1:b", "//line f.go:1", "//extern f", "//export F"] {
            assert!(is_directive(directive), "{directive}");
        }
        for comment in ["// nolint:errcheck", "//TODO: x", "//https://go.dev", "//go:", "//:x", "//line", "/*go:embed x*/", "//go-x:y"] {
            assert!(!is_directive(comment), "{comment}");
        }
    }

    /// Skipping directives leaves them out of the docstring's text but not
    /// out of the comment run: one beside a doc comment drops out of it, and a
    /// declaration whose only comment is one has no docstring.
    #[test]
    fn skips_directives_in_the_text_only() {
        let grammar = crate::langs::grammar_for("go").expect("go grammar");
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&grammar).unwrap();
        let src = "package p\n\n// a\n//go:noinline\n// b\nfunc f() {}\n\n//nolint:unparam\nfunc g() {}\n";
        let tree = parser.parse(src, None).unwrap();
        let root = tree.root_node();
        let func = |name: &str| {
            (0..root.named_child_count())
                .filter_map(|i| root.named_child(i))
                .find(|n| {
                    n.kind() == "function_declaration"
                        && n.child_by_field_name("name").map(|id| &src[id.byte_range()]) == Some(name)
                })
                .expect(name)
        };
        assert_eq!(preceding_docstring(func("f"), src).as_deref(), Some("a\ngo:noinline\nb"));
        assert_eq!(preceding_go_doc_comment(func("f"), src).as_deref(), Some("a\nb"));
        assert_eq!(preceding_docstring(func("g"), src).as_deref(), Some("nolint:unparam"));
        assert_eq!(preceding_go_doc_comment(func("g"), src), None);
    }
}
