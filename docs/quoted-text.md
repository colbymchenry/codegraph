# Quoted Text Lookup

Ask `codegraph_explore` where `"Access denied"` appears to receive exact current-source matches. This lookup uses the existing tool and never changes persistent graph data. File paths, exact indexed symbol names, explicit flow queries and queries with named symbols keep their normal graph handling.

The public API `CodeGraph.queryQuotedText(query, options)` accepts directory/language filters and independent file-scan, match and matching-file limits. It reads at most 200 indexed files by default, at most 256 KiB each. Missing and oversized files are skipped. Up to 8 distinct quoted phrases of 2-160 characters are searched, case sensitively, within individual lines. Double quotes and typographic quotes are recognized; ASCII single quotes are recognized outside word contractions. Quotes containing punctuation alone retain normal Explore behavior.

Reports include scanned-subset match totals, eligible/scanned/skipped files, output truncation, 1-based line numbers and 0-based UTF-16 columns. Long source lines are returned as snippets with their start column. A miss is not evidence that the whole repository lacks the text: files outside the index, files beyond scan limits and skipped files are not searched. Matching text is not an AST string-literal classification or a call/runtime relationship.

This first contribution uses bounded read-time scanning rather than adding a file-text schema. Large-repository latency and retrieval agent A/B validation remain pending.
