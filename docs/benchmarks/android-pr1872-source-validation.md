# Android source validation against PR #1872

The [Android platform analysis guide](../design/android-platform-analysis.md#public-reference-projects)
lists the AOSP, AAOS, and AndroidX source revisions fetched on 2026-09-24.
The maintainer's PR #1872 review used 11,489 **decompiled** SystemUI and
AndroidX Java files. This run uses current source files instead, so the counts
are not directly comparable. The checks ran on macOS with Node 24.21.0,
CodeGraph 1.6.0, and `CODEGRAPH_KERNEL=0`.

To repeat the review's three Java checks, the baseline was upstream `main` at
`ba3c21e` and the comparison was the Java/Kotlin inheritance branch at
`31188e4193eb`. In the combined checkout, the baseline linked the
`IKeyguardService.Stub` reference in `KeyguardService.java` to an unrelated
`AllowlistProviderService.Stub`; the comparison left it unresolved because
the generated Stub class was absent. Seventeen SystemUI `OnClickListener`
inheritance references (including `View.OnClickListener`) linked to an unrelated
SystemUI class in the baseline and zero did in the comparison. In isolated
AndroidX, `LinearLayoutManager` resolved to its own
`RecyclerView.LayoutManager` only in the comparison. The combined checkout
also contains an AOSP internal `RecyclerView.LayoutManager`; the core branch
was updated to disambiguate that collision by source-tree proximity.
The baseline indexed 291,893 nodes and 658,555 edges; the comparison indexed
292,709 nodes and 661,745 edges over the same 8,485 files.

For the TypeScript control, the same 240 upstream `src/` files produced 8,439
nodes and 26,172 edges in both builds; the sorted edge rows had the same
SHA-256 (`0b5ff27c3eed7ccae74af7f95ccd0f2870a1655a3e726f22d48ab0d55d9f546a`).
Standalone `aidl-impl IKeyguardService` returned `no_implementation_found`;
with the core inheritance change applied, it found one verified anonymous Stub
implementation in `KeyguardService.java:410`. The latter checks the two PRs
together and is not a standalone claim for the Android tools PR.
