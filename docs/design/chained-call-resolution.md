# Design + status: chained static-factory / fluent call resolution

**Status:** SHIPPED for **13 languages** (C++, C, PHP, Java, Kotlin, C#, Swift, Rust,
Go, Scala, Dart, Objective-C, Pascal/Delphi) + a conformance pass. **TypeScript and Luau
were evaluated and intentionally skipped** (both gradually typed → the mechanism is +0 /
regresses on real code). See "Full README classification" below. Tracking issue:
**#750** (which began as "the statically-typed README languages" but that enumeration was
incomplete — it missed ObjC / Pascal / Luau).

**Motivation:** a call whose **receiver is itself a call** — a factory / singleton /
builder that returns an object — should produce a `calls` edge to the chained method:

```java
Foo.getInstance().bar();   // bar() should resolve to Foo::bar, never a same-named decoy
```

Before this work, every statically-typed language **dropped the receiver** and
name-matched the bare method (`bar`), so in 7 of 9 languages it silently attached to a
**same-named method on an unrelated type** — a correctness bug, not just missing coverage.

---

## The 3-part mechanism (per language)

1. **Capture the factory's declared return type** — a per-language `getReturnType`
   hook writes `nodes.return_type` (schema v5). `*Foo`→`Foo`, `List<Bar>`→`List`,
   `pkg.Foo`→`Foo`, `-> Self` / `: self` / `this.type` → the declaring type.
2. **Preserve the chained receiver at extraction** — `tree-sitter.ts` (or a bespoke
   extractor) encodes `Foo.getInstance().bar()` as the marker string
   `Foo.getInstance().bar` (the `().` marker never appears in an ordinary ref). A
   per-language gate keeps **instance** chains (`list.map().filter()`) bare so their
   existing resolution is untouched — only capitalized-receiver / factory chains re-encode.
3. **Resolve AND VALIDATE** — at resolution the receiver's type is inferred from what
   the inner call returns, then the outer method is resolved **on that type** and
   validated: the method must exist on the type (or a supertype it conforms to), so a
   wrong inference yields **no edge**, never a wrong one.

Three shared resolvers in `src/resolution/name-matcher.ts`, all calling
`resolveMethodOnType` (which has the conformance supertype-walk):

| Resolver | Receiver style | Languages |
|---|---|---|
| `matchCppCallChain` | `field_expression` (`Foo::instance().bar`) | C++, C |
| `matchScopedCallChain` | `::` (`Cls::for($x)->m`, `Foo::new().bar`) | PHP, Rust |
| `matchDottedCallChain` | `.` (`Foo.create().bar`) | Java, Kotlin, C#, Swift, Go, Scala, Dart |

**Conformance pass (#754).** When the chained method lives on a **supertype** the
return type conforms to (an inherited / default-interface / trait / mixin / embedded
method), the first pass can't see it — `implements`/`extends` edges aren't built yet.
So failed chain refs are deferred (`CHAIN_LANGUAGES` in `resolution/index.ts`) and
re-resolved in a second pass `resolveChainedCallsViaConformance()` after edges exist,
walking `context.getSupertypes(...)`.

**Adding a language:** `getReturnType` in `languages/*.ts`; encode the chained receiver
+ a node-type gate; add the language to the right `matchReference` gate (and
`CONSTRUCTS_VIA_BARE_CALL` if a bare capitalized call constructs the class); add to
`CHAIN_LANGUAGES`; synthetic tests + a real-repo A/B; bump `EXTRACTION_VERSION`.

---

## Coverage (validated — each via synthetic decoy/absent-method tests + a real-repo A/B)

| Language | PR | Receiver | Real-repo A/B (unique `calls` edges) | Notes |
|---|---|---|---|---|
| **C++ / C** | #645 (#742) | `field_expression` | — | The original: singletons / factories / chained getters. |
| **PHP** | #608 (#749) | `::` → `->` | — | `Cls::for($x)->method()` — the Laravel per-tenant client idiom. `: self`/`: static`. |
| **Java** | #751 | `.` | Guava **+1,507 / −0** | Missing-edge → purely additive. |
| **Kotlin** | #752 | `.` | arrow **+49 / −438** | Wrong-edge → precision win (438 removed = test/doc noise + wrong). Needed the capitalized-receiver gate + constructor-receiver handling. |
| **C#** | #753 | `.` | Newtonsoft +3 / NodaTime **+73 / −0** | Additive. Return type is the `returns` field; extension-method chains correctly don't resolve. |
| **conformance** | #754 | (resolver upgrade) | arrow **+22 / −0** | Supertype walk — enables Swift protocol-ext, Rust trait, Go embedded, Dart mixin, Java/Kotlin/C# inherited chains. |
| **Swift** | #755 | `.` | Alamofire / Kingfisher **0 / 0** | Neutral-safe (unique fluent names already bare-resolved). Needed a nested-extension naming fix (`KF.Builder`→`KF::Builder`). |
| **Rust** | #757 | `::` | clap **+937 / −775** | Precision win (622 wrong→right retargets, +162 net). `-> Self`; trait-default methods via conformance. Single-hop. |
| **Go** | #760 | `.` | gin **net-zero** | `New().Method()`; embedded structs via conformance. Variable-inner fallback. **Found + fixed a batched-resolver runaway** (a mutated `original.referenceName` looped the offset-0 batch → 5M edges / 1.4 GB; fixed by tying the fallback to the original ref + a non-progress guard). |
| **Scala** | #761 | `.` | gatling **+14 / −59** | Precision win (−59 = stdlib `Option`/`Iterator` `.map`/`.flatMap` the baseline mis-tied to gatling's `Validation::*`). Companion factories + case-class `apply`. |
| **Dart** | #762 | `.` | localsend hand-written **+17 / −10** | Precision win **+ constructors made first-class** (factory/named ctors `Foo.create()`/`Foo._()` are now indexed; unnamed `Foo()` stays `instantiates`). `dartCtorInfo` validates a ctor against the enclosing class name — handles a tree-sitter misparse where `@override (A,B) m()` makes `m()` look like a ctor. |
| **Objective-C** | #786 | message send | SDWebImage **+35 / −75** | Precision win. Chained message send `[[Foo create] doIt]` over `message_expression`. getReturnType skips nullability qualifiers (`nonnull instancetype`). A class-message factory returns the receiver class by convention, so `[[X alloc] init]` / singleton chains resolve on `X` (validated). The −75 are wrong `init` mis-matches retargeted to the right class. |
| **Pascal/Delphi** | #791 | `.` (`exprDot`) | PascalCoin **+19 / −18** | Precision win. `TFoo.GetInstance().DoIt()` over Pascal's `exprCall`/`exprDot`. getReturnType from the `typeref` (incl. interface returns `IFoo`). Re-encoding gated on the Delphi `TFoo`/`IFoo` type convention so capitalized *variable* chains stay bare. A constructor (no `: TBar`) or typecast `TFoo(x)` resolves on the class. 15 of the −18 are correct class→interface retargets (`GetInstance(): IAsn1OctetString`). |
| **TypeScript** | — | `.` | typeorm +0/−6 · nest **+0/−164** | **Evaluated, NOT shipped** — gradual typing; see below. |
| **Luau** | — | `:` / `.` | Fusion +0/−0 · matter +0/−0 | **Evaluated, NOT shipped** — gradually typed; additive-safe (missing-edge gap, no regression) but real Luau rarely annotates factory returns, so +0 on both benchmarks. Works for `Foo.create(): Bar` then `:doIt()` (synthetic). |

`EXTRACTION_VERSION` is now **18** (C++→…→Pascal chains→paren-less calls→free-routine attribution). Re-index with `codegraph index -f`
to pick up the newer extractor on an existing graph.

## Why TypeScript was skipped

The mechanism resolves a chain from the factory's **declared** return type. TypeScript
leans on **type inference** — e.g. NestJS's `Test.createTestingModule(m) { return new
TestingModuleBuilder(...) }` has no `: TestingModuleBuilder` annotation — so the
factory's type can't be recovered, the re-encoded chain can't resolve, and it **drops
the bare-name edge** the existing resolver found. Real-repo A/B was **+0 added on both
typeorm and nest** with a net recall regression (−164 on nest, mostly the ubiquitous
`Test.createTestingModule({…}).compile()` pattern). The removed edges were mostly
*wrong* (baseline mis-resolved `.compile()` to `ModuleCompiler::compile`), so it's
precision-positive but recall-negative — against the recall-first invariant, and adding
nothing where it doesn't hurt (TS method names are unique enough that bare-name already
lands them). It was fully implemented (5 synthetic tests passed, runaway-safe bare-name
fallback) and consciously not shipped. The only path to a TS win would be reading
**inferred** return types (resolving `return new X()` in the factory body) — a much
larger change. Full write-up on issue #750.

---

## Full README classification (all 21 languages)

The mechanism's real requirement is a **declared return type** to recover the receiver's
type — not "statically typed" (PHP qualifies via its `: self` / `: Type` return
declarations). Against the README's full supported-language list:

| Bucket | Languages |
|---|---|
| **Covered** (13) | C++, C, PHP, Java, Kotlin, C#, Swift, Rust, Go, Scala, Dart, Objective-C, Pascal/Delphi |
| **Evaluated, skipped** (2) | **TypeScript** — gradual typing → inference-typed factories can't be recovered; net recall regression. **Luau** — gradually typed; additive-safe but +0 on Fusion AND matter (real Luau rarely annotates factory returns). Both: the mechanism needs reliably-declared return types, which gradually-typed code too often omits. |
| **Pascal call-coverage follow-ups** | Two gaps from the chained-call work, both resolved. **Paren-less calls (#793):** Pascal lets a no-arg method drop its parens (`Obj.Free;`, `TFoo.GetInstance.DoIt;`), which parse as a bare `exprDot` and weren't extracted as calls at all. Now extracted, scoped to STATEMENT position (a bare dot in assignment/condition position is left alone — ambiguous with a field/property access). PascalCoin A/B **+1131 / −1**, all new edges resolve to methods. **Free-routine attribution (#795):** a procedure/function defined only in the `implementation` section (no interface decl, not a method) had no node, so its body's calls were lumped under the file; now it gets a function node and its calls attribute to it. PascalCoin A/B **+511 / −145** (file-level aggregates → per-routine edges). |
| **Out of scope — no declared return types** (6) | JavaScript, Ruby, Lua, Svelte, Vue, Liquid (Liquid has no methods/chains at all) |
| **Partial / separate** (1) | Python — only optional `-> T` hints; tracked as #578, not part of this mechanism |

So #750's original framing ("the 9 statically-typed README languages") was incomplete —
it missed three more typed languages, all now resolved: **Objective-C** shipped (#786,
same wrong-edge gap, mechanism ports directly); **Pascal/Delphi** shipped (#791, a clean
port for the paren'd chain — an initial "blocked" read was wrong, caused by probing only
the paren-less form); **Luau** evaluated and skipped (gradual typing → +0 on real repos,
additive-safe).

The through-line: this mechanism fits languages with **reliably-declared return types**
(the 13 shipped). Gradually-typed languages (TypeScript, Luau) omit them too often for
it to pay off, and dynamically-typed languages have none.

---

## Edge cases / model
- **Single-hop**: a chain re-encodes one hop; deeper hops (`a.b().c().d()`) keep the
  bare name (the inner `()` defeats the `Class::method` split). Re-measure on deep
  fluent-builder repos.
- **Validation, not guessing**: every resolver ends in `resolveMethodOnType`, so an
  unknown / wrong inferred type produces **no edge** — the decoy / absent-method
  guarantee that makes this safe to ship.
- **Per-language receiver gate** keeps instance chains bare so existing resolution is
  never regressed; the A/B "removed" counts are wrong-edge corrections, not losses.

## Related work
- **Dynamic-dispatch / callback synthesis** (a *different* mechanism): observer /
  EventEmitter / React-render / JSX-child / django-ORM edge synthesis lives in
  `callback-edge-synthesis.md` + `dynamic-dispatch-coverage-playbook.md`.
- The verbose session working-notes for #750 are in
  `.claude/handoffs/chained-call-multilang-probe.md` (scratch; this doc is the
  permanent record).
