# tree-sitter-kotlin — provenance

The kernel's vendored C (`codegraph-kernel/grammars/kotlin/`) is the `src/` of
[fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin) (MIT) at
main commit `d6af96d2e23ef0a8ff5ab512864378cf08fba311` (2026-10-31,
"fix(scanner): attach a decorated lambda after a completed call (#327)"), byte
for byte, and `src/extraction/wasm/tree-sitter-kotlin.wasm` is built from the
same files. There is no patch. The commit is untagged: its `tree-sitter.json`
says 0.4.0, and the newest tag, 0.3.8, is from 2024.

| file | sha256 (LF, as the commit has it) |
|---|---|
| `src/parser.c` | `d489e0ee02b320ffc1a67c55245b0e150317dfd80321678370c2a2145a0111f3` |
| `src/scanner.c` | `a3c22a33953365af2b6a9408fd7c3828d4c1e83fb95a4ce29a854410ee16e99b` |
| `src/tree_sitter/parser.h` | `a1f6ef161fbaf48a0e10fca90ef5290a062462b307b3898aa562993853b9f80a` |
| `src/tree_sitter/alloc.h` | `b29c1c9fb7cc82f58c84b376df1297d6e2737a1d655fd356db0859e3c29c2fea` |
| `src/tree_sitter/array.h` | `5bdf6ed1a78e3409fd443e085ca967a64c188a5d082aaf7f819bccd53a471c94` |
| `LICENSE` | `948495f61768f7de26bcc61113d8cd95f50bbc15adb678c28c941c6c8fcd5903` |
| `tree-sitter-kotlin.wasm` (built) | `90689092295c4e11d21f2c4f1b9ffce1a3c68f7ce6d4de57c365cd0fc888c7ee`, 6,078,823 bytes |

## Why d6af96d

#3410: 0.3.8 lexed a modifier keyword as a modifier wherever one could start a
declaration, so a call named after one at the start of a statement was a parse
error: Gradle's `allOpen { annotation("jakarta.persistence.Entity") }`, a
method `open()`, `inline(...)`, `suspend { … }` — 22 such keywords. Upstream
made them soft keywords in PR 231 (2026-02), and that change needs two others
beside it: the modifier list's precedence (469f5d9, 7b15e3a), so
`@Transient internal val x` keeps `internal` as a modifier, and a dynamic
precedence on declarations (PR 278), so `actual open class X { … }` is not read
as a chain of infix calls. Those ported alone onto 0.3.8 fixed 35 files of the
corpus below but made error recovery worse in about a dozen, around a shape
0.3.8 also misreads (a class delegating `by` a property, with a secondary
constructor in its body), so the grammar moved to upstream's main instead,
which carries all of it and the year of fixes upstream checked against the
Kotlin compiler's own PSI (2026-10).

Measured on 8,945 `.kt`/`.kts` files from okhttp, nowinandroid,
kotlinx.coroutines, Exposed, koin, ktor, detekt, mihon, compose-samples, moshi,
spring-petclinic-kotlin and the Spring Boot Kotlin tutorial: 540 parsed with an
error on 0.3.8, 2 on d6af96d (both templates under Exposed's
`src/test/resources/template/`), and no file that parsed clean gained an error.
The wasm is 2 MB larger, and parsing that corpus takes 4.6% longer (5.19 s
against 4.96 s, median of 5 interleaved rounds).

What the extractors read differently because of it (both engines):

- An extension function's or property's receiver is a `receiver_type` node
  (field `receiver`) wrapping the type, where 0.3.8 had the bare `user_type`
  before the `.`. `getReceiverType` and `receiver_type_of` read it there; a
  nullable or function-type receiver still gives none, as it did.
- An explicit backing field (Kotlin 2.x: `val state: StateFlow<S>` then
  `field = MutableStateFlow(S())`) is a `backing_field` node under the
  property, and its initializer is walked as the property's code, like `= …`.
  0.3.8 made a property named `field` out of it.
- A class whose last supertype is a delegation, `class A : I by Impl() { … }`,
  lost its body to a trailing lambda on 0.3.8, and the extractors then walked
  its header as a bodiless class's, so `Impl()` linked from the class. Read
  right, the class has its body, and a bodied class's header is not walked
  (the asymmetry `docs/design/kotlin-kernel-port-checklist.md` records), so
  those links are gone until headers are walked.
- New named nodes: `annotated_expression`, `backing_field`, `context_receiver`,
  `destructuring_declaration`, `guard_condition`, `receiver_type`,
  `interpolation_identifier_start`, `interpolation_expression_start` and `_end`
  (where 0.3.8 had anonymous `$` and `${`), `null_literal` (was an anonymous
  `null`) and `quest` (a nullable type's `?`). No node type the extractors read
  was removed.
- 0.3.8's scanner patch (no automatic semicolon before a same-line word
  starting with `e`, for infix calls like Exposed's `Users.id eq id1`) is gone:
  d6af96d's scanner inserts one on the same line only before `;` or `import`,
  which is what the patch did.
- One shape d6af96d reads worse than 0.3.8: an object expression with two or
  more supertypes passed straight to a call, `f(object : A(), B { … })` or
  `listOf(object : A(), B { … })`, ends after its first supertype, and the rest
  reads as a second argument, a call with a trailing lambda, so the anonymous
  class is lost and its members come out as local functions. One supertype,
  or the object assigned or returned, reads right. The corpus has 2 such
  expressions out of 2,235 (Exposed's `JdbcTransaction.exec` and
  `R2dbcTransaction.exec`).
- The `preParse` rewrites written for 0.3.8 stay, but one (`fun interface`, a
  qualified or nullable function-type receiver, a primary constructor on the
  line after its class, `when` guards, `..<`): over the corpus they change 215
  files and turn no clean parse into an error or back, so extraction is
  unchanged; d6af96d reads the original syntax as well, so they can go in a
  change of their own. The one gone stripped a multi-dollar string's `$$`,
  which d6af96d reads: without it, a literal `${…}` became interpolation, and
  Spring's `@Value($$"${app.flag:false}")` broke the file (4 files of the
  corpus).

## Rebuild

```
git clone https://github.com/fwcd/tree-sitter-kotlin && cd tree-sitter-kotlin
git checkout d6af96d2e23ef0a8ff5ab512864378cf08fba311
cp src/parser.c src/scanner.c /path/to/codegraph/codegraph-kernel/grammars/kotlin/
cp src/tree_sitter/*.h /path/to/codegraph/codegraph-kernel/grammars/kotlin/tree_sitter/
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-kotlin.wasm .
cp tree-sitter-kotlin.wasm /path/to/codegraph/src/extraction/wasm/
```

`build --wasm` compiles the checked-in `src/parser.c`; it does not regenerate
it. The wasm of 2026-11-19 was built on Windows with emsdk 4.0.4 (no Docker).
It imports `env.iswspace`, `env.iswalpha`, `env.iswalnum`, `env.memcmp`,
`env.strcmp`, `env.malloc`, `env.calloc`, `env.realloc`, `env.free`,
`env.abort`, `env.memory`, `env.__stack_pointer`, `env.__memory_base`,
`env.__table_base` and `env.__indirect_function_table`; the 0.3.8 build
imported the same less `iswalnum`, `memcmp` and `strcmp`, all of which
web-tree-sitter provides. The kernel compiles the scanner as C11, as the
commit's own `bindings/rust/build.rs` does: it has a `_Static_assert`, which
MSVC accepts only from `/std:c11`.

Then rebuild the kernel (`npm run build:kernel`) and run
`__tests__/kernel-grammar-parity.test.ts`, `__tests__/kernel-kotlin-parity.test.ts`
and `scripts/kernel-parity.mjs --lang kotlin` on a Kotlin repo: the wasm and
the kernel must parse the same.
