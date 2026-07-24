# Repository Documents V1

## Status

Proposed and implemented as an intentionally small first step toward making
CodeGraph a graph of the whole repository, rather than code symbols alone.

## Goal

Index repository-local Markdown alongside source code so that documentation
structure and high-confidence links between documentation and code are
available through the existing graph, search, context, and impact APIs.

The implementation must remain deterministic, local-only, and useful without
an LLM or network access.

## Scope

V1 indexes `.md`, `.mdx`, and `.markdown` files.

It adds:

- a normal `file` node for every indexed Markdown file;
- a `section` node for every Markdown heading;
- `contains` edges that preserve the document hierarchy;
- `references` edges for repository-local Markdown links;
- `references` edges for unambiguous code symbols named in inline code spans;
- searchable document prose through the existing `docstring` FTS field.

V1 deliberately does not parse plain text, PDF, Office files, images, audio,
or other document formats.

## Graph model

### Markdown files

A Markdown file uses the existing `file` node kind and the new `markdown`
language. Text before the first heading is stored as the file node's
`docstring`.

### Sections

`section` is appended to `NODE_KINDS` so the native extraction wire values of
all existing kinds stay stable.

Each ATX or Setext heading creates a section node:

| Field | Value |
| --- | --- |
| `name` | visible heading text |
| `qualifiedName` | `<repo-relative-path>#<slug>` |
| `filePath` | repository-relative Markdown path |
| `language` | `markdown` |
| source range | heading through the line before the next heading of the same or a higher level |
| `docstring` | normalized prose directly below the heading, capped at 4 KiB |

Duplicate heading slugs receive the same numeric suffix convention used by
GitHub-style anchors (`name`, `name-1`, `name-2`).

The file contains top-level sections. A section contains the nearest following
deeper section. This makes the Markdown outline traversable with the existing
graph API.

## References

### Repository-local links

Inline and reference-style Markdown links are normalized relative to the
containing document:

- `#design` targets a section in the same file;
- `../README.md` targets a file node;
- `architecture.md#storage` targets a section node;
- links to source files target their file nodes.

They are resolved strictly by normalized file path or exact qualified name.
There is no fuzzy fallback, so a typo does not silently create a wrong edge.
The persisted edge kind is the existing `references` kind, with
`metadata.docRef = "link"` for callers that want to distinguish it.

V1 does not interpret source-line fragments as symbol references.

### Code symbols in prose

An inline code span is considered a symbol candidate only when it looks like a
single identifier or qualified identifier, for example `AuthService`,
`parse_config`, `Graph.open()`, or `crate::Store`.

The reference resolves only when:

- the full qualified name identifies one definition; or
- an unqualified name has exactly one definition in the repository.

Ambiguous names remain unresolved. No fuzzy name matching or language-family
gate is used for these documentation-to-code references. Persisted edges use
`metadata.docRef = "symbol"`.

Code spans containing whitespace, shell syntax, URLs, or file paths are not
treated as symbols. Fenced code blocks are excluded from both link and symbol
extraction.

## External links

HTTP(S), protocol-relative, `mailto:`, and other URI-scheme links are not
fetched and do not create graph nodes in V1. The URL remains in the source and
therefore in a section's source range, but is omitted from the repository
graph.

Creating external nodes now would require unresolved design decisions around
canonical identity, availability checks, credentials, refresh policy,
deletion, and trust. A later version can add an explicit `external_resource`
node and `external_dependency` edge without changing the local document model.

## Parsing and safety

The Markdown extractor is a dependency-free, line-oriented parser. It handles
the structural features needed by the graph and is not intended to render
Markdown.

- fenced code blocks are skipped;
- URL decoding is guarded against malformed escapes;
- links that normalize outside the repository are discarded;
- extracted prose is capped at 4 KiB per node;
- the repository indexer's existing file-size and ignore rules still apply.

## Compatibility

- Existing node- and edge-kind numeric values remain unchanged.
- The Rust kernel mirrors the appended `section` kind so native extraction
  compatibility checks continue to pass.
- Markdown uses a custom TypeScript extractor and requires no tree-sitter
  grammar or kernel support.
- Existing graph APIs need no schema change: document links are ordinary
  `contains` and `references` edges, and prose uses `docstring`.
- The topology UI is a read-only service over the existing graph. Its design,
  API, security boundary, and zero-regression contract are specified in
  [Repository Topology UI V1](repository-topology-ui-v1.md).

## Acceptance criteria

Given a repository with source code and Markdown:

1. Markdown files and their heading hierarchy are queryable as nodes.
2. Document prose is discoverable through natural search/context retrieval.
3. Local links resolve to the correct document section or source file.
4. An unambiguous inline code symbol resolves to its definition.
5. Ambiguous symbols and external URLs do not produce incorrect edges.
6. Incremental indexing and deletion use the existing per-file lifecycle.
7. TypeScript build, unit tests, integration tests, and native kind-table
   parity pass.
8. The embedded local UI service renders code and document topology without a
   CDN or a second extraction pipeline.

## Deferred work

- external-resource nodes and crawlers;
- non-Markdown document formats;
- source-line fragments that resolve to symbols;
- semantic/LLM-assisted entity and relationship extraction;
- backlinks inferred from prose without explicit links or code spans;
- Markdown AST fidelity beyond the supported structural subset.
