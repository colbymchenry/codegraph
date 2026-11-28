//! Shared utilities for the TS/JS walker: compiled regexes, UTF-16 position
//! conversion, generated-file detection, and small text helpers — each
//! mirroring a specific helper in src/extraction/tree-sitter.ts (noted inline).

use regex::Regex;
use std::sync::OnceLock;

macro_rules! re {
    ($name:ident, $pat:expr) => {
        pub fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($pat).expect(concat!("regex ", stringify!($name))))
        }
    };
}

// RTK_HOOK_NAME_RE (tree-sitter.ts)
re!(rtk_hook_name, r"^use[A-Z][A-Za-z0-9]*(?:Query|Mutation)$");
// reactComponentHoc's styled test
re!(styled_callee, r"^styled\b");
// PascalCase component gate (#841)
re!(pascal_case, r"^[A-Z]");
// extractCall parenthesized-conversion normalization
re!(paren_conversion, r"^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$");
// tsJsCalleeName's dotted chain (`a.b.c`); ASCII classes, as JS's `\w` is
re!(dotted_chain, r"^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)+$");
// flushFnRefCandidates SIMPLE_NAME
re!(simple_name, r"^[A-Za-z_$][A-Za-z0-9_$]*$");
// flushFnRefCandidates QUALIFIED_IMPORT
re!(qualified_import, r"^[A-Za-z_$][A-Za-z0-9_$.\\]*[.\\]([A-Za-z_$][A-Za-z0-9_$]*)$");
// captureFnRefCandidates rhs param-storage skip — trailing identifier of LHS
re!(lhs_last_name, r"([A-Za-z_$][A-Za-z0-9_$]*)\s*$");
// extractTsTupleContractNames identifier test
re!(ident_dollar, r"^[A-Za-z_$][A-Za-z0-9_$]*$");
// looksLikeVueStoreFile signal (VUE_STORE_FILE_SIGNAL)
re!(
    vue_store_signal,
    r"\bdefineStore\b|\bcreateStore\b|\bVuex\b|\bmutations\b|\bactions\b|\bgetters\b|\bnamespaced\b"
);
// value-ref target-name distinctiveness: /[A-Z_]/
re!(has_upper_or_underscore, r"[A-Z_]");

/// isGeneratedFile (src/extraction/generated-detection.ts) — full pattern list
/// ported so future language walkers share it.
pub fn is_generated_file(file_path: &str) -> bool {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = RES.get_or_init(|| {
        [
            r"\.pb\.go$",
            r"\.pulsar\.go$",
            r"_grpc\.pb\.go$",
            r"_mock\.go$",
            r"_mocks\.go$",
            r"^mock_[^/]+\.go$",
            r"\.generated\.[jt]sx?$",
            r"\.gen\.[jt]sx?$",
            r"\.pb\.[jt]s$",
            r"_pb\.[jt]s$",
            r"_grpc_pb\.[jt]s$",
            r"[.-]min\.m?js$",
            r"_pb2(_grpc)?\.py$",
            r"_pb2\.pyi$",
            r"\.pb\.(cc|h)$",
            r"\.g\.cs$",
            r"Grpc\.cs$",
            r"OuterClass\.java$",
            r"Grpc\.java$",
            r"\.pb\.swift$",
            r"\.g\.dart$",
            r"\.freezed\.dart$",
            r"\.pb\.dart$",
            r"\.pbgrpc\.dart$",
            r"\.chopper\.dart$",
            r"\.generated\.rs$",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("generated pattern"))
        .collect()
    });
    patterns.iter().any(|p| p.is_match(file_path))
}

// isMinifiedContent's WEBPACK_RUNTIME (`\b` ASCII, as in JS).
re!(webpack_runtime, r"(?-u:\b)function __webpack_require__\s*\(");

/// isMinifiedContent (src/extraction/generated-detection.ts): a `.js` / `.mjs`
/// / `.cjs` file of at least 4000 UTF-16 units whose text sits mostly on lines
/// of 1000 units or more, dense with `;{}(),` — or that carries a webpack
/// runtime. Lengths are counted in UTF-16 units, as the JS string ops count
/// them, so both extractors agree on every file.
pub fn is_minified_content(file_path: &str, content: &str) -> bool {
    const LINE: usize = 1000;
    let lower = file_path.to_ascii_lowercase();
    if !(lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs")) {
        return false;
    }
    // UTF-16 units never outnumber UTF-8 bytes: a short file is out at once.
    if content.len() < 4 * LINE {
        return false;
    }
    let total = content.encode_utf16().count();
    if total < 4 * LINE {
        return false;
    }
    if webpack_runtime().is_match(content) {
        return true;
    }
    let (mut long, mut punctuation) = (0usize, 0usize);
    let (mut line_len, mut line_punct) = (0usize, 0usize);
    for unit in content.encode_utf16() {
        if unit == 10 {
            if line_len >= LINE {
                long += line_len;
                punctuation += line_punct;
            }
            line_len = 0;
            line_punct = 0;
            continue;
        }
        line_len += 1;
        // ; { } ( ) ,
        if matches!(unit, 59 | 123 | 125 | 40 | 41 | 44) {
            line_punct += 1;
        }
    }
    if line_len >= LINE {
        long += line_len;
        punctuation += line_punct;
    }
    long as f64 >= total as f64 * 0.5 && punctuation as f64 >= long as f64 * 0.03
}

/// Where each line of a source starts, and what turns a byte offset on a
/// line into its UTF-16 column without reading the line: see `col16`. Reads
/// as the slice of line starts.
pub struct LineStarts {
    starts: Vec<usize>,
    /// Each character of more than one byte, in order: where it starts, and
    /// the bytes the source spends up to and including it beyond the UTF-16
    /// units it counts for. Empty for a source that is all ASCII.
    wide: Vec<(usize, usize)>,
}

impl LineStarts {
    /// The bytes before `pos` that count for no UTF-16 unit.
    fn spare_before(&self, pos: usize) -> usize {
        match self.wide.partition_point(|&(at, _)| at < pos) {
            0 => 0,
            n => self.wide[n - 1].1,
        }
    }
}

impl std::ops::Deref for LineStarts {
    type Target = [usize];
    fn deref(&self) -> &[usize] {
        &self.starts
    }
}

/// Byte offsets of each line start, for UTF-16 column conversion.
pub fn line_starts(src: &str) -> LineStarts {
    let mut starts = vec![0usize];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    let mut wide = Vec::new();
    if !src.is_ascii() {
        let mut spare = 0usize;
        for (at, c) in src.char_indices() {
            if c.len_utf8() > 1 {
                spare += c.len_utf8() - c.len_utf16();
                wide.push((at, spare));
            }
        }
    }
    LineStarts { starts, wide }
}

/// UTF-16 code units in `s` — what web-tree-sitter (and JS string ops)
/// count, so kernel-emitted columns are byte-identical to the wasm path's.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// Column (UTF-16 units) of `byte_pos` on line `row`, given `line_starts`.
///
/// Read from the table: the bytes from the line's start, less those that
/// count for no unit. Counted character by character from the line's start
/// for every symbol and reference, a script minified to one line took the
/// square of its length: a megabyte, a minute.
/// The source is no longer read; the parameter stays so every caller is as it was.
pub fn col16(_src: &str, starts: &LineStarts, row: usize, byte_pos: usize) -> u32 {
    let ls = starts.get(row).copied().unwrap_or(0);
    if byte_pos <= ls {
        return 0;
    }
    (byte_pos - ls - (starts.spare_before(byte_pos) - starts.spare_before(ls))) as u32
}

/// JS `String.prototype.slice(0, n)` in UTF-16 units, without splitting a
/// surrogate pair (when the cut would split one, we stop one code unit short —
/// a lone surrogate isn't representable in Rust and never round-trips through
/// SQLite anyway). Returns (sliced, was_truncated_at_or_beyond_n).
pub fn slice_utf16(s: &str, n: usize) -> (String, bool) {
    let mut used = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            return (out, true);
        }
        used += w;
        out.push(c);
        if used == n {
            // Exactly at the limit: truncated iff any source remains.
            let truncated = out.len() < s.len();
            return (out, truncated);
        }
    }
    (out, false)
}

/// objectKeyName (tree-sitter.ts): strip ONE leading and ONE trailing quote
/// character (`'`, `"`, or backtick).
pub fn object_key_name(s: &str) -> String {
    let mut out = s;
    if let Some(first) = out.chars().next() {
        if first == '\'' || first == '"' || first == '`' {
            out = &out[first.len_utf8()..];
        }
    }
    if let Some(last) = out.chars().last() {
        if last == '\'' || last == '"' || last == '`' {
            out = &out[..out.len() - last.len_utf8()];
        }
    }
    out.to_string()
}

/// The `= <first 100 UTF-16 units>[...]` initializer signature used by
/// extractVariable (its `.length >= 100` check fires exactly when the slice
/// hit the cap).
pub fn init_signature(value_text: &str) -> String {
    let (sliced, _) = slice_utf16(value_text, 100);
    if utf16_len(&sliced) >= 100 {
        format!("= {sliced}...")
    } else {
        format!("= {sliced}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_cols() {
        let src = "aé😀b";
        // 'a'=1, 'é'=1, '😀'=2 utf16 units; bytes: a=1, é=2, 😀=4
        assert_eq!(utf16_len(src), 5);
        let starts = line_starts(src);
        assert_eq!(col16(src, &starts, 0, 1), 1); // after 'a'
        assert_eq!(col16(src, &starts, 0, 3), 2); // after 'é'
        assert_eq!(col16(src, &starts, 0, 7), 4); // after '😀'
    }

    /// The table gives, at every character of every line, the column that
    /// counting the line's characters gives.
    #[test]
    fn utf16_cols_match_counting() {
        let src = "plain ascii\naé😀b — ü\n\n日本語 x 😀😀\nlast";
        let starts = line_starts(src);
        for (row, &start) in starts.iter().enumerate() {
            let end = starts.get(row + 1).map_or(src.len(), |next| next - 1);
            for (offset, _) in src[start..end].char_indices().chain([(end - start, ' ')]) {
                let counted = utf16_len(&src[start..start + offset]) as u32;
                assert_eq!(col16(src, &starts, row, start + offset), counted, "row {row} offset {offset}");
            }
        }
        // Before a line's start, or on a row the source does not have: 0, and the offset itself.
        assert_eq!(col16(src, &starts, 1, 3), 0);
        assert_eq!(col16("abc", &line_starts("abc"), 9, 2), 2);
    }

    #[test]
    fn init_sig_short_and_long() {
        assert_eq!(init_signature("[1, 2]"), "= [1, 2]");
        let long = "x".repeat(150);
        let sig = init_signature(&long);
        assert!(sig.starts_with("= "));
        assert!(sig.ends_with("..."));
        assert_eq!(utf16_len(&sig[2..sig.len() - 3]), 100);
    }

    #[test]
    fn generated_patterns() {
        assert!(is_generated_file("src/api.generated.ts"));
        assert!(is_generated_file("vendor/jquery.min.js"));
        assert!(!is_generated_file("src/app.ts"));
    }
}
