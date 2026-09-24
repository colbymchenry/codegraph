# Java static-field call corpus checks (#1949)

Compare `calls` edges by caller file, line, column, and target qualified name after a fresh `codegraph init --yes` with the same source tree. The baseline is CodeGraph `ba3c21e`; the follow-up is this branch. Both runs used Node 24.21.0 on macOS.

| Public source | Revision and scope | Baseline Java calls | Follow-up Java calls | Delta |
|---|---|---:|---:|---|
| [Play Framework](https://github.com/playframework/playframework/tree/e1f3c2a92be8aa8b2f853d7d3175955efbe18a1e) | `e1f3c2a92be8aa8b2f853d7d3175955efbe18a1e`, 790 Java files | 13,926 | 13,897 | 29 removed, 0 added |
| [AOSP SystemUI](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/packages/SystemUI/src) | `94b4c163b7dfe5ce3607f7bb8456f9573f7de57d`, `packages/SystemUI/src`, 1,077 Java and 4,089 Kotlin files | 37,221 | 37,153 | 84 removed, 16 added |

The original #1949 head (`126a2e6`) and this follow-up produce **identical Java `calls` edges** on both public source trees: 13,897 for Play and 37,153 for AOSP SystemUI. The follow-up addresses cases absent from these source sets, especially decompiled Java representations of Kotlin companion singletons.

Play's 29 removed calls comprise 27 `Integer.TYPE` and other primitive `TYPE` `.equals` calls in `ClassUtils.java`, one `XMLConstants.DEFAULT_NS_PREFIX.equals` in `XPath.java`, and one `PLAY_GROUP_ID.equals` in a Java test. Excluding test sources yields **28 removed, 0 added**, matching the maintainer's production-source count. All 29 baseline targets were unrelated project methods.

The 16 added AOSP calls were checked individually against their Java call sites and Kotlin declarations. Each is a Java `Object.INSTANCE.method()` call to one of eight indexed Kotlin `object` declarations. The 84 removed edges pointed to unrelated project methods from Android framework constants and fields, including `Intent.ACTION_*`, `Interpolators.*`, `AccessibilityAction.*`, and framework `CREATOR`s; two removed `bind` calls and one `getSectionSubLists` call were replaced by the correct Kotlin object targets among the 16 additions.

These AOSP source files are **not** the maintainer's decompiled SystemUI corpus of about 3,400 Java files. The exact 37 gained call sites cannot be classified from this source comparison. The public build revision, decompiler output, or 37-row edge diff is needed for a same-corpus audit.
