//! C++ scopes read from the source's braces, for a file whose parse tree has
//! errors — a port of src/extraction/languages/cpp-brace-scopes.ts (read its
//! header for why). Byte offsets here, UTF-16 code units there; columns go
//! through `col16` so positions match the wasm walker's.
//!
//! Only reachable under the `CODEGRAPH_KERNEL_CCPP_ERROR_EXTRACT=1` sweep
//! hatch: every other erroring file defers to wasm before the walk starts.

use crate::textutil as util;
use std::collections::HashMap;

/// Intervals that nest properly, added in order of their opening offset.
pub struct NestedIntervals<T: Clone> {
    opens: Vec<usize>,
    closes: Vec<usize>,
    parents: Vec<Option<usize>>,
    values: Vec<T>,
}

impl<T: Clone> NestedIntervals<T> {
    pub fn new() -> Self {
        NestedIntervals { opens: Vec::new(), closes: Vec::new(), parents: Vec::new(), values: Vec::new() }
    }

    /// Adds the interval `(open, close)`. One that opens before the last one
    /// added, or crosses one that holds it, is refused (false).
    pub fn add(&mut self, open: usize, close: usize, value: T) -> bool {
        if close <= open || self.opens.last().is_some_and(|&last| open <= last) {
            return false;
        }
        let parent = self.innermost(open);
        if let Some(p) = parent {
            if close >= self.closes[p] {
                return false;
            }
        }
        self.opens.push(open);
        self.closes.push(close);
        self.parents.push(parent);
        self.values.push(value);
        true
    }

    /// The values of the intervals holding `offset` (open < offset < close), outermost first.
    pub fn at(&self, offset: usize) -> Vec<T> {
        let mut out = Vec::new();
        let mut k = self.innermost(offset);
        while let Some(i) = k {
            out.push(self.values[i].clone());
            k = self.parents[i];
        }
        out.reverse();
        out
    }

    /// The innermost interval holding `offset`: the last interval opening
    /// before `offset` or one of the intervals around that one.
    fn innermost(&self, offset: usize) -> Option<usize> {
        let count = self.opens.partition_point(|&o| o < offset);
        let mut k = if count == 0 { None } else { Some(count - 1) };
        while let Some(i) = k {
            if self.closes[i] > offset {
                break;
            }
            k = self.parents[i];
        }
        k
    }
}

pub struct BraceScopes {
    closes: HashMap<usize, usize>,
    namespaces: NestedIntervals<String>,
}

impl BraceScopes {
    /// The offset of the `}` that closes the `{` at `open`.
    pub fn close_of(&self, open: usize) -> Option<usize> {
        self.closes.get(&open).copied()
    }

    /// The named namespaces whose braces hold `offset`, outermost first, as written.
    pub fn namespaces_at(&self, offset: usize) -> Vec<String> {
        self.namespaces.at(offset)
    }

    /// The 1-based line and the UTF-16 column of `offset`.
    pub fn position_of(src: &str, line_starts: &[usize], offset: usize) -> (u32, u32) {
        let row = line_starts.partition_point(|&s| s <= offset).saturating_sub(1);
        (row as u32 + 1, util::col16(src, line_starts, row, offset))
    }
}

fn is_blank(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | 0x0c | 0x0b)
}
fn is_word_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$' || c >= 0x80
}
fn is_word_char(c: u8) -> bool {
    is_word_start(c) || c.is_ascii_digit()
}
fn at(s: &[u8], i: usize) -> u8 {
    s.get(i).copied().unwrap_or(0)
}
fn find(src: &str, from: usize, pat: &str) -> Option<usize> {
    src.get(from..).and_then(|rest| rest.find(pat)).map(|k| from + k)
}

/// The end of a `//` comment starting at `i`: its newline (a `\` before it continues the comment).
fn line_comment_end(src: &str, mut i: usize) -> usize {
    let s = src.as_bytes();
    loop {
        let Some(nl) = find(src, i, "\n") else { return s.len() };
        let mut k = nl as isize - 1;
        if k >= 0 && s[k as usize] == b'\r' {
            k -= 1;
        }
        if k < 0 || s[k as usize] != b'\\' {
            return nl;
        }
        i = nl + 1;
    }
}

/// Past whitespace and comments from `i`.
fn skip_blank(src: &str, mut i: usize) -> usize {
    let s = src.as_bytes();
    while i < s.len() {
        let c = s[i];
        if is_blank(c) || c == b'\n' {
            i += 1;
        } else if c == b'/' && at(s, i + 1) == b'/' {
            i = line_comment_end(src, i + 2);
        } else if c == b'/' && at(s, i + 1) == b'*' {
            i = find(src, i + 2, "*/").map_or(s.len(), |e| e + 2);
        } else {
            break;
        }
    }
    i
}

/// The end of the identifier at `i`, if one starts there.
fn word_end(s: &[u8], i: usize) -> Option<usize> {
    if i >= s.len() || !is_word_start(s[i]) {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && is_word_char(s[j]) {
        j += 1;
    }
    Some(j)
}

/// Past the string or character literal whose quote is at `i` (it stops at a newline).
fn quoted_end(s: &[u8], i: usize) -> usize {
    let quote = s[i];
    let mut j = i + 1;
    while j < s.len() {
        let c = s[j];
        if c == b'\\' {
            j += if at(s, j + 1) == b'\r' && at(s, j + 2) == b'\n' { 3 } else { 2 };
        } else if c == quote {
            return j + 1;
        } else if c == b'\n' {
            return j;
        } else {
            j += 1;
        }
    }
    s.len()
}

/// Past the `(…)` group at `i` (strings inside skipped).
fn paren_group_end(s: &[u8], i: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut j = i;
    while j < s.len() {
        let c = s[j];
        if c == b'"' || c == b'\'' {
            j = quoted_end(s, j);
            continue;
        }
        if c == b'(' {
            depth += 1;
        } else if c == b')' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(j + 1);
            }
        }
        j += 1;
    }
    None
}

/// namespaceHead: after the `namespace` keyword ending at `from`, the name as
/// written and the offset of the body's `{`.
fn namespace_head(src: &str, from: usize) -> Option<(String, usize)> {
    let s = src.as_bytes();
    let mut i = skip_blank(src, from);
    while src.get(i..).is_some_and(|r| r.starts_with("[[")) {
        let end = find(src, i + 2, "]]")?;
        i = skip_blank(src, end + 2);
    }
    let mut name: Option<(usize, usize)> = None;
    while let Some(end) = word_end(s, i) {
        name = Some((name.map_or(i, |(start, _)| start), end));
        i = skip_blank(src, end);
        if !src.get(i..).is_some_and(|r| r.starts_with("::")) {
            break;
        }
        i = skip_blank(src, i + 2);
        if let Some(inline) = word_end(s, i) {
            if &src[i..inline] == "inline" {
                i = skip_blank(src, inline);
            }
        }
    }
    if name.is_some() {
        while let Some(end) = word_end(s, i) {
            let paren = skip_blank(src, end);
            if at(s, paren) != b'(' {
                return None;
            }
            i = skip_blank(src, paren_group_end(s, paren)?);
        }
    }
    if at(s, i) != b'{' {
        return None;
    }
    Some((name.map_or(String::new(), |(start, end)| src[start..end].to_string()), i))
}

fn is_raw_delimiter(d: &[u8]) -> bool {
    d.len() <= 16 && d.iter().all(|&b| (0x21..=0x7e).contains(&b) && !matches!(b, b'"' | b'(' | b')' | b'\\'))
}

fn is_raw_prefix(w: &[u8]) -> bool {
    matches!(w, b"R" | b"uR" | b"UR" | b"LR" | b"u8R")
}

struct Branch {
    at_if: Vec<usize>,
    after_first: Option<Vec<usize>>,
}

/// scanCppBraceScopes: `src` as the parser saw it (after preParse). None when
/// the braces don't balance.
pub fn scan(src: &str) -> Option<BraceScopes> {
    let s = src.as_bytes();
    let n = s.len();
    let mut closes: HashMap<usize, usize> = HashMap::new();
    let mut open: Vec<usize> = Vec::new();
    let mut branches: Vec<Branch> = Vec::new();
    let mut namespace_at: Vec<(usize, String)> = Vec::new();
    let mut pending_namespace: Option<(String, usize)> = None;
    let mut balanced = true;
    let mut line_start = true;
    let mut word_start: usize = 0;
    let mut word_end_at: Option<usize> = None;
    // Past a byte-order mark, so line 1 can be a directive.
    let mut i = if src.starts_with('\u{feff}') { 3 } else { 0 };
    while i < n {
        let c = s[i];
        if c == b'\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if is_blank(c) {
            i += 1;
            continue;
        }
        if c == b'/' && at(s, i + 1) == b'/' {
            i = line_comment_end(src, i + 2);
            continue;
        }
        if c == b'/' && at(s, i + 1) == b'*' {
            i = find(src, i + 2, "*/").map_or(n, |e| e + 2);
            continue;
        }
        if c == b'#' && line_start {
            let mut j = i + 1;
            while j < n && is_blank(s[j]) {
                j += 1;
            }
            let directive: &[u8] = match word_end(s, j) {
                Some(e) => &s[j..e],
                None => b"",
            };
            while j < n {
                let d = s[j];
                if d == b'\n' {
                    let mut k = j as isize - 1;
                    if k >= 0 && s[k as usize] == b'\r' {
                        k -= 1;
                    }
                    if k < 0 || s[k as usize] != b'\\' {
                        break;
                    }
                    j += 1;
                } else if d == b'/' && at(s, j + 1) == b'/' {
                    j = line_comment_end(src, j + 2);
                } else if d == b'/' && at(s, j + 1) == b'*' {
                    j = find(src, j + 2, "*/").map_or(n, |e| e + 2);
                } else if d == b'"' {
                    j = quoted_end(s, j);
                } else {
                    j += 1;
                }
            }
            match directive {
                b"if" | b"ifdef" | b"ifndef" => branches.push(Branch { at_if: open.clone(), after_first: None }),
                b"else" | b"elif" | b"elifdef" | b"elifndef" => {
                    if let Some(group) = branches.last_mut() {
                        let at_if = group.at_if.clone();
                        let current = std::mem::replace(&mut open, at_if);
                        if group.after_first.is_none() {
                            group.after_first = Some(current);
                        }
                    }
                }
                b"endif" => {
                    if let Some(group) = branches.pop() {
                        if let Some(after) = group.after_first {
                            open = after;
                        }
                    }
                }
                _ => {}
            }
            i = j;
            continue;
        }
        line_start = false;
        if c == b'"' {
            if word_end_at == Some(i) && is_raw_prefix(&s[word_start..i]) {
                if let Some(paren) = find(src, i + 1, "(") {
                    let delimiter = &src[i + 1..paren];
                    if is_raw_delimiter(delimiter.as_bytes()) {
                        let close = format!("){delimiter}\"");
                        i = find(src, paren + 1, &close).map_or(n, |e| e + delimiter.len() + 2);
                        continue;
                    }
                }
            }
            i = quoted_end(s, i);
            continue;
        }
        if c == b'\'' {
            i = quoted_end(s, i);
            continue;
        }
        if c.is_ascii_digit() || (c == b'.' && at(s, i + 1).is_ascii_digit()) {
            let mut j = i + 1;
            while j < n {
                let d = s[j];
                if is_word_char(d) || d == b'.' {
                    j += 1;
                } else if d == b'\'' && is_word_char(at(s, j + 1)) {
                    j += 2;
                } else if (d == b'+' || d == b'-') && matches!(s[j - 1], b'e' | b'E' | b'p' | b'P') {
                    j += 1;
                } else {
                    break;
                }
            }
            word_start = i;
            word_end_at = Some(j);
            i = j;
            continue;
        }
        if is_word_start(c) {
            let end = word_end(s, i).unwrap_or(i + 1);
            word_start = i;
            word_end_at = Some(end);
            if &s[i..end] == b"namespace" {
                if let Some(head) = namespace_head(src, end) {
                    pending_namespace = Some(head);
                }
            }
            i = end;
            continue;
        }
        if c == b'{' {
            open.push(i);
            if pending_namespace.as_ref().is_some_and(|(_, brace)| *brace == i) {
                let (name, _) = pending_namespace.take().unwrap();
                if !name.is_empty() {
                    namespace_at.push((i, name));
                }
            }
        } else if c == b'}' {
            match open.pop() {
                None => balanced = false,
                Some(from) => {
                    closes.entry(from).or_insert(i);
                }
            }
        }
        i += 1;
    }
    if !balanced || !open.is_empty() {
        return None;
    }
    namespace_at.sort_by_key(|(brace, _)| *brace);
    let mut namespaces = NestedIntervals::new();
    for (brace, name) in namespace_at {
        if let Some(&close) = closes.get(&brace) {
            namespaces.add(brace, close, name);
        }
    }
    Some(BraceScopes { closes, namespaces })
}
