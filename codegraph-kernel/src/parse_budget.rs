//! A parse with a wall-clock budget (#3274).
//!
//! tree-sitter 0.25's error recovery can loop without reading on: a
//! half-typed JSX attribute (`<a {{b:>c:d(e f)` in a .tsx file) never
//! finishes parsing. Nothing outside a native parse can stop it: the parse
//! worker's `terminate()` stops JavaScript and wasm but not this thread, which
//! kept spinning and kept the indexer from exiting, and a sync parses on the
//! process's own thread. So `extract_file` gives its call a deadline, every
//! language's parse goes through [`parse`], and its progress callback cancels
//! the parse once the deadline passes. The `timeout:` error it returns is the
//! TS side's signal to record the file's parse as timed out.

use std::cell::Cell;
use std::time::{Duration, Instant};
use tree_sitter::{ParseOptions, ParseState, Parser, Point, Tree};

thread_local! {
    /// The deadline of the extraction running on this thread, and its budget in ms.
    static DEADLINE: Cell<Option<(Instant, u32)>> = const { Cell::new(None) };
}

/// Restores the previous deadline when the extraction ends, panicking or not.
struct Restore(Option<(Instant, u32)>);

impl Drop for Restore {
    fn drop(&mut self) {
        DEADLINE.with(|d| d.set(self.0));
    }
}

/// Run `f` with a deadline `budget_ms` from now for every [`parse`] it makes;
/// `None` (an older caller) leaves the parses unbounded, as before.
pub fn with_budget<T>(budget_ms: Option<u32>, f: impl FnOnce() -> T) -> T {
    let deadline = budget_ms.map(|ms| (Instant::now() + Duration::from_millis(u64::from(ms)), ms));
    let _restore = Restore(DEADLINE.with(|d| d.replace(deadline)));
    f()
}

/// `parser.parse(source, None)`, cancelled once the extraction's deadline
/// passes: `Err("timeout: …")` then, and the old `Err("parser returned null
/// tree")` for any other null tree.
pub fn parse(parser: &mut Parser, source: &str) -> Result<Tree, String> {
    let Some((deadline, ms)) = DEADLINE.with(Cell::get) else {
        return parser.parse(source, None).ok_or_else(|| "parser returned null tree".to_string());
    };
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut read = |i: usize, _: Point| (i < len).then(|| &bytes[i..]).unwrap_or_default();
    let mut cancel = |_: &ParseState| Instant::now() >= deadline;
    let tree = parser.parse_with_options(&mut read, None, Some(ParseOptions::new().progress_callback(&mut cancel)));
    tree.ok_or_else(|| {
        if Instant::now() >= deadline {
            format!("timeout: the parse ran past its {ms}ms budget")
        } else {
            "parser returned null tree".to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tsx_parser() -> Parser {
        let mut parser = Parser::new();
        parser.set_language(&crate::langs::grammar_for("tsx").expect("tsx grammar")).expect("set_language");
        parser
    }

    #[test]
    fn a_parse_that_never_ends_times_out() {
        // The issue's 16 bytes loop in tree-sitter 0.25.10's error recovery.
        let started = Instant::now();
        let out = with_budget(Some(200), || parse(&mut tsx_parser(), "<a {{b:>c:d(e f)"));
        let err = out.err().expect("the parse should be cancelled");
        assert!(err.starts_with("timeout:"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "cancelled late: {:?}", started.elapsed());
    }

    #[test]
    fn a_parse_within_its_budget_is_unchanged() {
        let tree = with_budget(Some(10_000), || parse(&mut tsx_parser(), "<a {{b:>c:d(e)")).expect("parses");
        assert!(tree.root_node().has_error());
        let plain = tsx_parser().parse("export const a = <div />;", None).expect("parses");
        let bounded = with_budget(Some(10_000), || parse(&mut tsx_parser(), "export const a = <div />;")).expect("parses");
        assert_eq!(plain.root_node().to_sexp(), bounded.root_node().to_sexp());
    }

    #[test]
    fn the_deadline_ends_with_its_extraction() {
        with_budget(Some(10_000), || assert!(DEADLINE.with(Cell::get).is_some()));
        assert!(DEADLINE.with(Cell::get).is_none());
    }
}
