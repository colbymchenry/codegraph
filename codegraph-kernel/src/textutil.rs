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
            r"\.min\.m?js$",
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

/// Byte offsets of each line start, for UTF-16 column conversion.
pub fn line_starts(src: &str) -> Vec<usize> {
    let mut out = vec![0usize];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            out.push(i + 1);
        }
    }
    out
}

/// UTF-16 code units in `s` — what web-tree-sitter (and JS string ops)
/// count, so kernel-emitted columns are byte-identical to the wasm path's.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// Column (UTF-16 units) of `byte_pos` on line `row`, given `line_starts`.
pub fn col16(src: &str, starts: &[usize], row: usize, byte_pos: usize) -> u32 {
    let ls = starts.get(row).copied().unwrap_or(0);
    if byte_pos <= ls {
        return 0;
    }
    utf16_len(&src[ls..byte_pos]) as u32
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
