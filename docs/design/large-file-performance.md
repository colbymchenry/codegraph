# Large-file indexing performance

Read this before changing a loop in `src/extraction/`, `src/resolution/` or `codegraph-kernel/`, before reviewing a pull request that does, and before answering an issue that says indexing hangs, is slow, or left a file with no symbols.

## The rule

**Indexing a file costs in proportion to its size.** One megabyte of ordinary code takes about a second. Nothing done for a symbol, a reference, a route or a match may read the whole file, all of the file's nodes, all of its imports, or everything before it.

Until November 2026 that was false in every language. Time grew with the square of the file: a 0.9 MB Python file took 27 seconds and a Ruby one 54, a 1.2 MB Express file of inline handlers 58, 1.2 MB of Liquid 41. A file is given a time limit (the parse budget in `src/extraction/parse-budget.ts`, 10 to 20 seconds a parse, and the limits above it), and past it the file is given up on. So the cost was not only time: a large file ended with no symbols, and nothing a user asked about it (callers, impact, its own symbol map) had an answer. The size limit could not be raised from 1 MB to 4 MB until this was fixed (`MAX_SOURCE_FILE_SIZE_BYTES` in `src/file-limits.ts`).

About forty causes were removed, and every one was the same shape. No single one is obvious in review, because each looks like ordinary code that is fine on a 300-line file.

## The shape, and what to write instead

Each row is something that was in the code. The left column is what to look for in a diff.

| What it looks like | Why it grows with the square | Write this |
|---|---|---|
| `text.slice(0, i).split('\n').length`, `(text.substring(0, i).match(/\n/g) \|\| []).length`, or a loop counting newlines up to an offset | A pass over the text for each match. It was in more than fifty route and handler scans. | `lineAt(text, i)` in `src/resolution/synth-utils.ts`. In an extractor class, a table of line starts built once (see `LiquidExtractor.lineStarts`). |
| `content.split('\n')` or `split(/\r?\n/)` inside something called for each reference | The file is split again for each call. | `linesOf(text)` in `synth-utils.ts`. |
| `context.getNodesInFile(f).filter(n => n.startLine <= line && n.endLine >= line …)`, also with `find`, `some` or a `for` loop | Every node of the file, for each reference, and a reference asks several such questions. Nearly forty places. | `nodesAroundLine(context, f, line)` in `src/resolution/nodes-around.ts`, then the same test as before. With the nodes already in hand, `nodesAroundLineIn(nodes, line)`. |
| `getNodesInFile(f).find(n => n.name === x …)` | The same, by name. A routes file did it to its controller once per route. | `nodesNamed(context, f, x)` then the same test. Also `nodesNamedIn`, `nodesNamedLower`, `nodesUnder`, and `context.getNodesInFileNamed`. |
| `imports.find(m => m.localName === name)` or `imports.filter(m => m.source === s)` for each reference | Every import of the file, for each reference. | `importsBoundTo`, `importsFrom`, `importsReadBy`, `pythonMemberImports` in `src/resolution/import-lookup.ts`. |
| `this.nodes.find(n => n.id === id)` in the extractor | Every node extracted so far, for each member. | The extractor's `nodesById` map. |
| `for (let i = 0; i < node.childCount; i++) node.child(i)` and the `namedChild(i)` form; in the kernel `node.child(i)` and `named_child(i)` | Tree-sitter reaches child `i` by stepping from the first child when the children are a flat run, as a thousand comment lines or a thousand statements are. The loop is the square of the run. | Reading every child: `for (const c of node.namedChildren)`. Leaving early: `childrenOf(node)` or `namedChildrenOf(node)` in `src/extraction/tree-sitter-helpers.ts`. Kernel: `for c in node.named_children(&mut node.walk())`. |
| Finding where a declaration stands among its parent's children, to look at the siblings before it (decorators, a visibility marker) | Counted from the first child for each declaration. | Walk back from the node: `previousNamedSibling`, `prev_named_sibling()`. Where the answer depends on everything before (Ruby visibility, C++ access), keep the last answer per parent. |
| A column counted character by character from the start of its line (kernel) | A script minified to one line pays the line's length for each symbol. | `textutil::LineStarts` and `col16` in `codegraph-kernel/src/textutil.rs`. |
| `new RegExp(…name…)` built and run over the file for each symbol | The file, for each symbol. | Read the names once per file into a set and look each up (`laterExports`, `jsCodeWordSites`, `wordsWrittenBare`). |
| `source.indexOf(name, start)` or `source.includes(needle)` for each item | A scan for each item. A name declared late is found late. | Many names in one text: `firstIndexOfEach(text, names)` in `synth-utils.ts`. One fact about a file: ask once per file and keep it (`fileContains` in `src/resolution/index.ts`, `moduleDefaultStated` in `name-matcher.ts`). |
| `pattern.test(code.slice(functionStart, callOffset))` for each call in a function | The function is read from its top for each call. | Find where the first match in the function ends, once, and compare offsets (`shadowed` in `tauri-synthesizer.ts`). |
| "Does this function bind this name by this line?" answered by reading the function from its first line | The same, for each reference. | Read the function once and answer for any line (`JsNameBinding`, `pythonStatementBinders`, `pythonScopesAround`). A scan that keeps its place must answer an earlier line from what it kept, not start again. |
| `scopes.filter(outer => holds(outer, start, end))` for each route | Every route, for each route. | Keep them by stretch of the source and by path (`scanRoutes` in `frameworks/react.ts`). |
| A pattern such as `[\w.]+` given a megabyte of base64 or hex | The pattern starts a name at every character of the run and reads to its end: 30 KB cost a second. | The resolver reads files through `withoutLongRuns` (`src/file-limits.ts`). Read through `context.readFile`, never around it. |
| `target.push(...items)`, `Math.max(...values)` on a list as long as a file's imports or symbols | Not slow. It throws "Maximum call stack size exceeded" past about 125,000 items. | `pushAll`, `maxOf`, `minOf` in `src/utils.ts`. |

Two more things that are not a line of code:

- **The same code exists twice.** The native kernel (`codegraph-kernel/`) and the wasm extractor (`src/extraction/tree-sitter.ts`, `src/extraction/languages/`) extract the same languages. A fault fixed in one is usually in the other. The kernel reads 17 languages; the wasm extractor reads the rest, and all of them when the kernel is absent or `CODEGRAPH_KERNEL=0`.
- **Frameworks and bridges are their own passes.** `src/resolution/frameworks/*.ts` and the synthesizers read a routes file or a bridge with patterns, and link each route to its handler. They had the fault as much as the extractors, and a benchmark of plain functions never reaches them.

## Rules for a lookup that keeps an index

The helpers above keep an index per file. A new one follows the same rules, and `__tests__/large-file-lookups.test.ts` is where it is pinned against the expression it replaces.

1. **Same answer, same order.** The helper returns what the old expression returned, or a superset in the file's own order that the caller filters exactly as before. `nodesAroundLine` and `nodesNamed` are supersets on purpose: the caller's test is unchanged, so its answer is.
2. **Keyed by what the context hands out.** A `WeakMap` on the array `getNodesInFile` or `getImportMappings` returned, or a map by context and file. Never a module-level map by file path alone: a resolver outlives one sync.
3. **Dropped with the caches.** A memo in `name-matcher.ts` is deleted in `clearNameMatcherMemos`, and `__tests__/name-matcher-memo-clears.test.ts` fails if it is not. A memo in `ReferenceResolver` is cleared in `clearCaches`.
4. **Small inputs take the old path.** Under a few dozen items the plain pass is as quick, and it keeps ordinary files on the code that has always run. Test both sides of the threshold.
5. **It changes nothing else.** One of these fixes changed what is read (`withoutLongRuns`); every other is the same answer reached without reading again. Keep a speed fix and a behaviour change in separate pull requests.

## Measuring

The benchmarks are in `scripts/benchmarks/large-files/`. Each takes a built engine and a size in megabytes, writes one generated project a case, indexes it, and marks what is over 2 seconds a megabyte.

```bash
npm run build:kernel && npm run build

# The 17 languages the kernel reads, about 24 shapes each (317 cases)
node scripts/benchmarks/large-files/kernel-languages.mjs dist 1.2
node scripts/benchmarks/large-files/kernel-languages.mjs dist 3.9 python,ruby mixed,imports

# Everything else the README lists: the other languages, each framework's
# routes file, each bridge (96 cases)
node scripts/benchmarks/large-files/other-languages.mjs dist 1.2
node scripts/benchmarks/large-files/other-languages.mjs dist 3.9 express,rails

# The wasm extractor, which is what a machine without the kernel runs
CODEGRAPH_KERNEL=0 node scripts/benchmarks/large-files/other-languages.mjs dist 1.2
```

How to read them:

- **Run three sizes: 0.3, 1.2 and 3.9.** A linear case takes four times as long for four times the size. One that takes ten to sixteen times as long has the fault, even when the small size looks fast. Under about half a megabyte the fixed cost of starting hides everything.
- **Read the counts, not only the seconds.** A case that yields no symbols, routes or edges gave the engine nothing to link and measured nothing. A file over the size limit is left out by the engine and looks very fast; the harness marks it `NOT MEASURED`.
- **The shape decides.** A benchmark of only functions, or only calls, hid most of the faults. The shapes that found them: functions that each declare a local and call a helper and the function before them (`mixed`), methods calling each other through the object (`members`), a table of rows, one statement that is the whole file (`object`, `switch`, `enum`), a script on one line (`minified`), one long string (`blob`, `hex`, `dots`), some thousand imports (`imports`), a long run of comment lines (`commentrun`), and for a framework its routes file together with the controller it names.
- **Start from the README's tables, not from the list of parsers.** The first pass measured the kernel's 17 languages and called it every language. The other 18 language rows, the frameworks, the routers and the bridges had the same fault. A new language, framework or bridge gets a case in `other-languages.mjs` in the same change.

Where things stood when this was written (November 2026, one Mac): the 317 kernel cases at 3.9 MB average 2.1 seconds, the slowest 12 (a C++ file of 130,000 `#include` lines). The 96 other cases average 3.9 seconds with the largest file of each just under 4 MB. Cases around 2 seconds a megabyte that are linear, with 120,000 or more symbols in one file: Nix bindings, Elysia chains, NestJS controllers.

## Finding the cause

```bash
node scripts/benchmarks/large-files/profile.mjs other-languages dist 1.2 express/inline
node scripts/benchmarks/large-files/profile.mjs kernel-languages dist 1.2 python mixed
```

It prints the lines with the most CPU samples over every thread, with each line's text from the build. Profile at a size where the case takes several seconds: the faulty line is then most of the samples, and it is nearly always one line. Fix it, run again, and the next one surfaces; a case often has three or four behind each other.

A line named `tree-sitter.wasm` is time inside the wasm parser, and the kernel's time shows on the one line that calls `kernel.extractFile`: neither is in the engine's TypeScript loops. For the kernel, build it with symbols and sample the process with the system's profiler to see which Rust function it is.

## Proving nothing else changed

A speed fix must leave the graph as it was, and the check is mechanical. Build the engine before the change (a `git worktree` of `main`, built) and after it, index the same projects with both, and compare what `scripts/dump-graph.mjs` prints: every node, edge, unresolved reference and file.

```bash
node scripts/benchmarks/large-files/compare-graphs.mjs ../main/dist dist __tests__/fixtures src
CODEGRAPH_KERNEL=0 node scripts/benchmarks/large-files/compare-graphs.mjs ../main/dist dist __tests__/fixtures src

# The benchmark's own projects, small, one a case
BENCH_WRITE=/tmp/cases node scripts/benchmarks/large-files/other-languages.mjs dist 0.06
node scripts/benchmarks/large-files/compare-graphs.mjs ../main/dist dist --each /tmp/cases
```

Compare over, at least: `__tests__/fixtures`, this repository's `src`, real projects in the languages the change touches, the benchmark's projects written with `BENCH_WRITE`, and a small project written for each decision the faster path makes (a nested route, a name that is part of another name, Windows line endings, a file with no newline at its end). Run it with the kernel and with `CODEGRAPH_KERNEL=0`. A difference is a bug in the fix until shown otherwise.

Then the tests. Four files pin this, and a fix adds to the one that fits:

| Test file | What it pins |
|---|---|
| `__tests__/large-file-indexing.test.ts` | The kernel's languages: shapes of real large files at 1 to 3.9 MB, each bounded in time and checked for what the faster path decides. |
| `__tests__/large-file-frameworks.test.ts` | The other languages, routes files and bridges, the same way. |
| `__tests__/kernel-large-file-parity.test.ts` | The kernel and the wasm extractor agree on files of some thousand declarations. |
| `__tests__/large-file-lookups.test.ts` | Each lookup against the expression it replaced, on both sides of the size where it starts keeping an index. |

A test that only bounds the time is half a test. Each case also asserts something the faster path could get wrong: the decorator on the right declaration, the route on its own handler and no other, the call a local binding hides left unlinked.

## Traps that cost a run

- **Run the suite without `CODEGRAPH_NO_DAEMON`.** The benchmark scripts set it for themselves. In the environment of `npm test` it fails exactly the daemon tests (38 tests in 7 files), which looks like a regression and is not.
- **The test setup rebuilds `dist` when `src` is newer.** Do not run tests while a benchmark is reading `dist`, and do not edit `src` while the suite runs: the tests that start the built CLI fail.
- **The first case pays for loading the engine.** The harnesses index a small project first; a timing script of your own must too.
- **A hand-written expectation is often wrong.** Ask the unchanged engine what it yields for a small input before asserting it. Things that surprised: a bare Ruby `private` is not read as a visibility (only `private :name`), a Kotlin `@Deprecated("x")` yields no `decorates` reference, a Python decorator written as a call is a `calls` reference.

## Known and left as it is

- **Tree-sitter's own error recovery.** Where a grammar cannot parse a long run of lines, the parser's recovery takes the square of the run, inside the parser, and a profile shows it as `tree-sitter.wasm` (`ts_parser__recover`, `ts_subtree_summarize_children`), not as a line of the engine. No loop of ours can fix that. The cure is a `preParse` rewrite that hands the parser something it can read, at the same length (see `blankLoneMacroLines`), and that changes what the parser makes of every such file: it is a behaviour change, with its own before-and-after comparison on real code, not a speed fix. One case was found and cured that way: React Native's shim for a Swift module, `@interface RCT_EXTERN_MODULE(…)` over lines of `RCT_EXTERN_METHOD(…)`, where 16,000 such lines took 7 seconds and 32,000 ran out the parse budget (`src/extraction/languages/objc-rn-extern.ts`). Expect others wherever a file is mostly macros the grammar does not know.
- **Memory.** Memory per megabyte did not change, so a 4 MB file can take four times what a 1 MB file did while it is indexed. Fourteen real files of 1 to 3.8 MB peaked between 0.15 and 0.7 GB; a 3.8 MB bundle peaked at 1.8 GB.
- **Linear, and heavy.** A file of 120,000 symbols takes 8 seconds at 3.9 MB. That is its size.

## When an issue says indexing is slow, hangs, or a file has no symbols

1. Get the file's language, its size, and what it mostly holds (see the shapes above). Ask for `codegraph status`: it names files left out for their size, and an index run reports a parse that timed out.
2. Check the report's date against the release that carries these fixes (see the house rule on anchoring reports in `AGENTS.md`). Before that release, every large file was slow.
3. Reproduce with a generated file of that shape at that size. If no case in the harnesses has the shape, add one: that is the first half of the fix.
4. Time it at three sizes. Four times the size for four times the time is not this fault: look at the parser (profile) or at the project (many files, not one large one).
5. Profile, fix the line, compare the graphs, add the test.

## When a pull request touches extraction or resolution

- Look in the diff for the left column of the table. A new `getNodesInFile(...).find`, a new `split('\n')`, a new index loop over children, a new pattern built from a name: each is fine at 300 lines and seconds at a megabyte.
- Ask what the new code does for each symbol, reference or match, and whether that depends on the file's size.
- A new language, framework or bridge comes with a case in `other-languages.mjs`, timed at 1.2 and 3.9 MB.
- Run both harnesses on the branch and on `main` for the languages it touches, and `compare-graphs.mjs` if it claims to change nothing.
