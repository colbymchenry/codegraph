# No — it's the opposite.

No — it's the opposite. CG-72 exists to *prevent* the scenario you're describing, and nothing in this epic puts any plugin on a slow path. Let me untangle the two things the card compresses.

**What's shipping in this epic (CG-64–71) has nothing to do with the kernel.** v1 plugins are framework/semantic plugins — route resolvers and synthesis passes, the same `FrameworkResolver` contract the ~35 built-ins (Express, Next.js, Django, Drupal…) use. They don't parse files; they run in the resolution layer after extraction. An external Acme-routes plugin executes on *exactly* the same path, at exactly the same speed, as the in-tree Drupal resolver. There is no legacy piping anywhere in v1. (The one real cost, which built-ins pay identically: any resolver with an `extract()` hook makes its languages' files take the decoded path instead of the kernel's raw-buffer shortcut — that's the price of framework extraction itself, in-tree or plugin, and CG-71's perf gate measures it.)

**CG-72 is about a different, not-yet-existing thing: plugins that add a whole new *language*.** For language support there are two implementations today — the Rust kernel (hot path for migrated languages) and the TS/tree-sitter extractor (the fallback, which plenty of in-tree languages still use). If we published a language-plugin API *today*, the only interface we could hand authors is the TS `LanguageExtractor` — and then yes, your worry becomes real, twice over:

1. Third-party languages would run the fallback path while first-party ones go native — permanently second-class, because
2. a published API is frozen. Semver obligations would fossilize the legacy interface as the public contract, and every future kernel change would have to tiptoe around it. We'd have built the slow lane *into the spec*.

So the deferral isn't "language plugins will be slow" — it's "we refuse to ship an API whose only possible implementation is the slow lane." CG-72's job is to design a backend-neutral `LanguageProvider` centered on the kernel's batch/buffer contract, so tree-sitter and the Rust walker become two implementations *behind* the same boundary and a third-party provider (likely WASM) plugs into the fast contract, not the legacy one. Until that spike lands, the honest position — stated in the doc — is that a new language is still a core contribution: nobody can write a language plugin at all yet, fast or slow, and that's deliberate.

One calibration on "way slower": the fallback path is just tree-sitter — it's what every language used before the kernel existed and what several still use. The kernel is a big win, not the difference between usable and unusable. The real stake in CG-72 is API-freezing, with performance as the visible symptom.
