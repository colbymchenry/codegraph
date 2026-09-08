//! Stack-budget guard for the recursive walkers (#1581).
//!
//! Every language walker recurses per AST level (`visit_node` →
//! `visit_for_calls_and_structure` → …). tree-sitter's own parser is
//! iterative, so a pathologically nested file — clang's
//! `parser_overflow.c` nests 16,384 `{`, fuzzer corpora go deeper — parses
//! fine and then overflows the WALKER's native stack. A native overflow is
//! uncatchable: the parse worker is a thread of the `codegraph` process, so
//! the SIGSEGV takes the whole indexer down with no message, no partial
//! index and no per-file fallback. Worker threads get Node's 4 MiB default
//! stack; the main thread's 8 MiB only moves the cliff (100k levels still
//! kill it).
//!
//! The guard turns "about to overflow" into the kernel's existing `defer:`
//! routing signal: `exhausted()` is checked at the top of every recursive
//! walker function (the `stack_guard!` macro in lib.rs), returns `true` once
//! the stack pointer is within `RED_ZONE` of the thread's stack limit, and
//! latches a per-thread flag. `run_guarded` wraps a whole extraction: when
//! the flag is set afterwards the result is discarded and replaced by a
//! `defer:` error, which the TS side (`src/extraction/kernel/index.ts`)
//! already treats as "this file takes the wasm path" — and the wasm walker
//! catches its own JS `RangeError` per file, so the file lands as a partial
//! result with a recorded parse error instead of a dead process.
//!
//! The per-thread stack bounds come from the OS (glibc/musl
//! `pthread_getattr_np`, macOS `pthread_get_stackaddr_np`, Win32
//! `GetCurrentThreadStackLimits`), computed once per thread and cached, so
//! the guard is exact on the 4 MiB worker, the 8 MiB main thread and any
//! `resourceLimits.stackSizeMb` alike. Where the bounds are unavailable the
//! guard falls back to a fixed descent budget measured from the entry stack
//! pointer. Hot path: one thread-local load and one compare.

use std::cell::Cell;

/// Headroom kept free below the deepest walker frame: the napi return path,
/// tree-sitter's node accessors and the error formatting all still need to
/// run after the guard trips, and the frames BETWEEN two guard checks (an
/// `extract_class` between two `visit_node`s) are never more than a few KiB.
const RED_ZONE: usize = 256 * 1024;

/// Descent budget when the OS can't report the thread's stack bounds — safe
/// on anything from Node's 4 MiB worker default upwards.
const FALLBACK_BUDGET: usize = 1024 * 1024;

thread_local! {
    /// Lowest stack-pointer value the walker may reach before the guard
    /// trips. `0` = not computed yet for this thread.
    static THRESHOLD: Cell<usize> = const { Cell::new(0) };
    /// `true` when the thread's threshold came from real OS bounds (fixed
    /// for the thread's lifetime) rather than the per-call fallback budget.
    static THRESHOLD_IS_OS: Cell<bool> = const { Cell::new(false) };
    /// Latched by `exhausted()`; read by `run_guarded` after the walk.
    static OVERFLOWED: Cell<bool> = const { Cell::new(false) };
}

/// Approximate current stack pointer: the address of a local. Stacks grow
/// downward on every target the kernel ships for (x86_64 / aarch64).
#[inline(always)]
fn current_sp() -> usize {
    let marker = 0u8;
    std::hint::black_box(&marker) as *const u8 as usize
}

/// Low (deepest) address of the calling thread's stack, from the OS.
#[cfg(target_os = "linux")]
fn os_stack_low() -> Option<usize> {
    // SAFETY: plain pthread queries on the calling thread; `attr` is
    // initialised by pthread_getattr_np and destroyed before returning.
    unsafe {
        let mut attr: libc::pthread_attr_t = std::mem::zeroed();
        if libc::pthread_getattr_np(libc::pthread_self(), &mut attr) != 0 {
            return None;
        }
        let mut addr: *mut libc::c_void = std::ptr::null_mut();
        let mut size: libc::size_t = 0;
        let rc = libc::pthread_attr_getstack(&attr, &mut addr, &mut size);
        libc::pthread_attr_destroy(&mut attr);
        if rc != 0 || addr.is_null() || size == 0 {
            return None;
        }
        Some(addr as usize)
    }
}

#[cfg(target_os = "macos")]
fn os_stack_low() -> Option<usize> {
    // SAFETY: plain pthread queries on the calling thread.
    unsafe {
        let me = libc::pthread_self();
        // pthread_get_stackaddr_np returns the HIGH end (the stack base).
        let high = libc::pthread_get_stackaddr_np(me) as usize;
        let size = libc::pthread_get_stacksize_np(me);
        if high == 0 || size == 0 || size > high {
            return None;
        }
        Some(high - size)
    }
}

#[cfg(windows)]
fn os_stack_low() -> Option<usize> {
    #[link(name = "kernel32")]
    extern "system" {
        // Win8+ (the bundled Node runtime needs Win10 anyway). Reports the
        // full RESERVED range; Windows commits pages on demand down to it.
        fn GetCurrentThreadStackLimits(low_limit: *mut usize, high_limit: *mut usize);
    }
    let mut low: usize = 0;
    let mut high: usize = 0;
    // SAFETY: both out-pointers are valid for the duration of the call.
    unsafe { GetCurrentThreadStackLimits(&mut low, &mut high) };
    if low == 0 || high <= low {
        return None;
    }
    Some(low)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn os_stack_low() -> Option<usize> {
    None
}

/// Arm the guard for one extraction on the calling thread: clear the latch
/// and (re)compute the threshold. OS bounds are computed once per thread;
/// the fallback budget is re-anchored at every call's entry stack pointer.
pub fn begin() {
    OVERFLOWED.with(|o| o.set(false));
    let cached = THRESHOLD.with(|t| t.get());
    if cached != 0 && THRESHOLD_IS_OS.with(|f| f.get()) {
        return;
    }
    match os_stack_low() {
        Some(low) => {
            THRESHOLD.with(|t| t.set(low.saturating_add(RED_ZONE)));
            THRESHOLD_IS_OS.with(|f| f.set(true));
        }
        None => {
            THRESHOLD.with(|t| t.set(current_sp().saturating_sub(FALLBACK_BUDGET).max(1)));
            THRESHOLD_IS_OS.with(|f| f.set(false));
        }
    }
}

/// `true` once the walker has descended to within `RED_ZONE` of the stack
/// limit. Latches `OVERFLOWED` so `run_guarded` can discard the result. A
/// thread that never called `begin()` (a direct unit-test call) arms itself
/// lazily from the current position.
#[inline(always)]
pub fn exhausted() -> bool {
    let threshold = THRESHOLD.with(|t| t.get());
    if threshold == 0 {
        begin();
        return exhausted();
    }
    if current_sp() < threshold {
        OVERFLOWED.with(|o| o.set(true));
        true
    } else {
        false
    }
}

/// Whether the guard tripped since the last `begin()`.
pub fn overflowed() -> bool {
    OVERFLOWED.with(|o| o.get())
}

/// Run one extraction under the guard. A walk that tripped the guard returns
/// a `defer:` error — the TS side's routine "take the wasm path" signal —
/// regardless of what the truncated walk produced.
pub fn run_guarded<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    begin();
    let out = f();
    if overflowed() {
        return Err(
            "defer: nesting too deep for the native walker — wasm recovery handles it".to_string(),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1 MiB is a quarter of Node's worker default; a guard that holds here
    /// holds on every real thread. Without the guard these walks SIGSEGV the
    /// test process instead of failing an assertion.
    const SMALL_STACK: usize = 1 << 20;
    const DEPTH: usize = 30_000;

    fn on_small_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new()
            .stack_size(SMALL_STACK)
            .spawn(f)
            .expect("spawn")
            .join()
            .expect("walker thread panicked")
    }

    fn nested_parens(prefix: &str, suffix: &str) -> String {
        format!("{prefix}{}1{}{suffix}", "(".repeat(DEPTH), ")".repeat(DEPTH))
    }

    #[test]
    fn os_bounds_are_sane_on_this_platform() {
        // Every shipped target has an OS implementation; the fallback budget
        // is only for platforms the kernel is not built for.
        let low = os_stack_low().expect("OS stack bounds available");
        let sp = current_sp();
        assert!(low < sp, "stack low {low:#x} must be below the current sp {sp:#x}");
        assert!(sp - low < 1 << 31, "implausible stack size {}", sp - low);
    }

    #[test]
    fn small_stack_reports_its_own_bounds() {
        on_small_stack(|| {
            let low = os_stack_low().expect("OS stack bounds available");
            let used = current_sp() - low;
            // std/the OS round the requested size up a little (macOS reports
            // 1,060,864 for a 1 MiB request); the point is that the bounds
            // describe THIS thread's small stack, not the main thread's.
            assert!(
                used <= SMALL_STACK + 128 * 1024,
                "used {used} is not within the {SMALL_STACK}-byte stack"
            );
        });
    }

    #[test]
    fn deep_braces_c_defer_instead_of_crashing() {
        let src = format!("void foo(void) {{\n{}{}\n}}\n", "{".repeat(DEPTH), "}".repeat(DEPTH));
        let r = on_small_stack(move || run_guarded(|| crate::ccpp::extract("deep.c", &src, "c")));
        let err = r.err().expect("deep nesting must defer");
        assert!(err.starts_with("defer:"), "unexpected error: {err}");
    }

    type Extract = fn(&str) -> Result<crate::buffers::EmitOut, String>;

    #[test]
    fn deep_parens_cpp_rust_ts_python_defer_instead_of_crashing() {
        let cases: [(&str, Extract, String); 4] = [
            ("deep.cpp", |s| crate::ccpp::extract("deep.cpp", s, "cpp"), nested_parens("int f() { return ", "; }\n")),
            ("deep.rs", |s| crate::rustlang::extract("deep.rs", s), nested_parens("fn f() -> i32 { ", " }\n")),
            ("deep.ts", |s| crate::tsjs::extract("deep.ts", s, "typescript"), nested_parens("function f() { return ", "; }\n")),
            ("deep.py", |s| crate::python::extract("deep.py", s), nested_parens("def f():\n    return ", "\n")),
        ];
        for (name, extract, src) in cases {
            let r = on_small_stack(move || run_guarded(|| extract(&src)));
            let err = r.err().unwrap_or_else(|| panic!("{name}: deep nesting must defer"));
            assert!(err.starts_with("defer:"), "{name}: unexpected error: {err}");
        }
    }

    #[test]
    fn normal_files_are_untouched_by_the_guard() {
        let src = "int add(int a, int b) { return a + b; }\nint main(void) { return add(1, 2); }\n";
        let r = on_small_stack(move || run_guarded(|| crate::ccpp::extract("ok.c", src, "c")));
        assert!(r.is_ok(), "a shallow file must not defer: {:?}", r.err());
        assert!(!overflowed());
    }

    #[test]
    fn latch_resets_between_runs() {
        let deep = format!("void foo(void) {{\n{}{}\n}}\n", "{".repeat(DEPTH), "}".repeat(DEPTH));
        on_small_stack(move || {
            assert!(run_guarded(|| crate::ccpp::extract("deep.c", &deep, "c")).is_err());
            // The latch from the deep file must not poison the next, shallow one.
            let ok = run_guarded(|| crate::ccpp::extract("ok.c", "int x;\n", "c"));
            assert!(ok.is_ok(), "latch leaked into the next run: {:?}", ok.err());
        });
    }
}
