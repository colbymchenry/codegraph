# Semantic update reuse (preview)

API v1 has arbitrary whole-graph semantic passes and framework hooks. Their
output is never treated as file-local, and no extension dependency is inferred
from language, filename or a previous set of returned edges.

The first optimization keeps a bounded in-memory cache of **core extraction
before framework hooks** on the owning CodeGraph instance. Keys include exact
relative path, decoded source, selected language and engine environment switches.
An instance cannot survive an engine upgrade; no persistent cache schema exists.
Framework detection/extract/postExtract, reference resolution and every semantic
pass still rerun against a fresh candidate in the original insertion order.
Workers still evaluate framework hooks. Failed extraction is not retained.
Results are cloned before any downstream mutation. Candidates do not share graph
or extension output; only core parser results are reused.

The budget is 128 MiB of estimated serialized payload (twice UTF-8 JSON size),
not a guaranteed JS heap ceiling. The first working set that fits is retained;
a scan larger than the budget does not repeatedly evict everything. Missing,
changed, renamed, failed or non-retained entries use ordinary extraction.
Closing a graph clears its cache. Fresh CLI processes and the first update after
open remain cold. `CODEGRAPH_NO_SEMANTIC_REUSE=1` selects the conservative full
parse path. This is **partial core-parse reuse**, not file-local semantic
invalidation or an incremental database update. Global resolve/store cost remains.

No breaking author API or package change is required. Unrestricted I/O outside
the supplied source/context remains subject to the existing deterministic-author
contract; this optimization does not infer or certify those dependencies.
Before/after source stamps cover the scanned indexed files plus root config and
ignore rules. An observed change aborts before commit and preserves the working
graph. This does not lock the filesystem: arbitrary external plugin I/O or a
write after the final observation is not a certified snapshot. Retry after edits
settle. Cache entries are content-keyed, so a failed candidate may safely retain
unchanged core parses but never graph or plugin output.

Graph-only candidate records contain a checksummed UUID and diagnostic PID.
The project SQLite coordinator is authoritative, independent of PID reuse.
Fresh opens reclaim the exact orphaned stage after process death; an invalid
record blocks recovery without deleting files. During a live graph-only update,
readers can use the old committed graph. The existing SQLite graph transaction
still determines old/new visibility. A commit marker invalidates long-lived
reader caches. Managed config/trust transactions retain their exclusive guard.

Measurements and correctness/recovery coverage will be linked after validation.
