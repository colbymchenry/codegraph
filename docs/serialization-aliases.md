# Serialization Aliases

`codegraph contracts user_id --json` finds explicit serde and Go JSON declarations among indexed Rust and Go files. `CodeGraph.getSerializationAliases({ externalName, filePath, maxFiles, maxItems })` exposes the same read-time report.

Rust supports field rename, direction-specific rename, container rename_all, deserialization alias, and field skip directions. Go supports exported fields with explicit JSON tags, including empty names and ignored tags. Unknown rename rules produce no derived name. Source is reparsed at query time; owners and line numbers come from current source, not stale indexed ranges. Synthetic field IDs are evidence identifiers and are not necessarily persisted graph nodes.

The default scan is 200 files of at most 256 KiB each, with 100 returned declarations. Reports distinguish eligible, scanned and skipped files, match totals within the scanned subset, and truncation. `maxItems: 0` counts matches without displaying them.

These are declarations, not proof of runtime serialization. Custom serializers, flattening, container-level skip behavior, embedding precedence and duplicate-key resolution are outside this initial API. It does not add persistent catalog/schema data or synthesize cross-language calls. Large-repository performance and agent retrieval A/B validation remain pending.
