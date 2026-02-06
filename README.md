<div align="center">

# 🔮 CodeGraph

### Supercharge Claude Code with Semantic Code Intelligence

**30% fewer tokens • 25% fewer tool calls • 100% local***

<sub>*Semantic search downloads a ~100MB model on first use; all processing is offline after that.</sub>

[![npm version](https://img.shields.io/npm/v/@colbymchenry/codegraph.svg)](https://www.npmjs.com/package/@colbymchenry/codegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

<br />

### Get Started

```bash
npx @colbymchenry/codegraph
```

<sub>Interactive installer configures Claude Code automatically</sub>


</div>

---

## 🚀 Why CodeGraph?

When you ask Claude Code to work on a complex task, it spawns **Explore agents** that scan your codebase using grep, glob, and file reads. These agents consume tokens with every tool call.

**CodeGraph gives those agents a semantic knowledge graph** — pre-indexed symbol relationships, call graphs, and code structure. Instead of scanning files, agents query the graph instantly.

### 📊 Benchmark Results

We ran the same complex task 3 times with and without CodeGraph:

| Metric | Without CodeGraph | With CodeGraph | Improvement |
|--------|-------------------|----------------|-------------|
| **Explore tokens** | 157.8k | 111.7k | **29% fewer** |
| **Per-agent tokens** | 74.0k | 46.4k | **37% fewer** |
| **Tool calls** | 60 | 45 | **25% fewer** |
| **Main context usage** | 28.7% | 24.0% | **4.7% less** |

<details>
<summary><strong>Full benchmark data</strong></summary>

**With CodeGraph:**
| Test | Agents | Tool Uses | Explore Tokens | Plan Tokens | Time |
|------|--------|-----------|----------------|-------------|------|
| 1 | 3 | 54 | 149.7k | 76.4k | 1m 43s |
| 2 | 2 | 41 | 102.1k | 74.8k | 1m 29s |
| 3 | 2 | 40 | 83.3k | 63.3k | 1m 25s |
| **Avg** | **2.3** | **45** | **111.7k** | **71.5k** | **1m 32s** |

**Without CodeGraph:**
| Test | Agents | Tool Uses | Explore Tokens | Plan Tokens | Time |
|------|--------|-----------|----------------|-------------|------|
| 1 | 3 | 74 | 177.3k | 80.5k | 1m 54s |
| 2 | 2 | 55 | 149.3k | 64.0k | 1m 27s |
| 3 | 2 | 51 | 146.7k | 62.3k | 1m 17s |
| **Avg** | **2.3** | **60** | **157.8k** | **68.9k** | **1m 33s** |

</details>

<details>
<summary><strong>Reproducing the benchmark</strong></summary>

The token and tool-call numbers above were measured manually by giving Claude Code the same task (implementing a feature in a ~10k-line TypeScript project) three times with and without CodeGraph, then reading the per-agent token counts from the Claude Code output.

To run the **precision/recall evaluation suite** against the included test fixtures:

```bash
npm test -- __tests__/evaluation/evaluation.test.ts
```

This runs search, callers/callees, impact, and context queries against two fixture projects (TypeScript and Python) and reports precision, recall, and F1 scores for each.

</details>

### 🔄 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
│                                                                  │
│  "Implement user authentication"                                 │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │  Explore Agent  │ ──── │  Explore Agent  │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                             │
└───────────┼────────────────────────┼─────────────────────────────┘
            │                        │
            ▼                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     CodeGraph MCP Server                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │   Search    │  │   Callers   │  │   Context   │               │
│  │  "auth"     │  │  "login()"  │  │  for task   │               │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │
│         │                │                │                       │
│         └────────────────┼────────────────┘                       │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │   SQLite Graph DB     │                            │
│              │   • 387 symbols       │                            │
│              │   • 1,204 edges       │                            │
│              │   • Instant lookups   │                            │
│              └───────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
```

**Without CodeGraph:** Explore agents use `grep`, `glob`, and `Read` to scan files → many API calls, high token usage

**With CodeGraph:** Explore agents query the graph via MCP tools → instant results, local processing, fewer tokens

---

## ✨ Key Features

<table>
<tr>
<td width="33%" valign="top">

### 🧠 Smart Context Building
One tool call returns everything Claude needs—entry points, related symbols, and code snippets. No more expensive exploration agents.

</td>
<td width="33%" valign="top">

### 🔍 Semantic Search
Find code by meaning, not just text. Search for "authentication" and find `login`, `validateToken`, `AuthService`—even with different naming conventions.

</td>
<td width="33%" valign="top">

### 📈 Impact Analysis
Know exactly what breaks before you change it. Trace callers, callees, and the full impact radius of any symbol.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### 🌍 15+ Languages
TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift, Kotlin—all with the same API.

</td>
<td width="33%" valign="top">

### 🔒 100% Local
No API keys. No external services. Everything runs on your local SQLite database. Semantic search requires a one-time ~100MB model download; after that, all processing is fully offline.

</td>
<td width="33%" valign="top">

### ⚡ Always Fresh
Git hooks automatically sync the index on every commit. Your code intelligence is always up to date.

</td>
</tr>
</table>

---

## 🎯 Quick Start

### 1. Run the Installer

```bash
npx @colbymchenry/codegraph
```

The interactive installer will:
- Configure the MCP server in `~/.claude.json`
- Set up auto-allow permissions for CodeGraph tools
- Add global instructions to `~/.claude/CLAUDE.md` (teaches Claude how to use CodeGraph)
- Optionally initialize your current project

### 2. Restart Claude Code

Restart Claude Code for the MCP server to load.

### 3. Initialize Projects

For each project you want to use CodeGraph with:

```bash
cd your-project
codegraph init -i
```

That's it! Claude Code will now use CodeGraph tools automatically when a `.codegraph/` directory exists.

<details>
<summary><strong>Manual Setup (Alternative)</strong></summary>

If you prefer manual configuration:

**Install globally:**
```bash
npm install -g @colbymchenry/codegraph
```

**Add to `~/.claude.json`:**
```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**Add to `~/.claude/settings.json` (optional, for auto-allow):**
```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_status"
    ]
  }
}
```

</details>

<details>
<summary><strong>Global Instructions Reference</strong></summary>

The installer automatically adds these instructions to `~/.claude/CLAUDE.md`. This is provided here for reference:

```markdown
## CodeGraph

CodeGraph builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If `.codegraph/` exists in the project

**Use codegraph tools for faster exploration.** These tools provide instant lookups via the code graph instead of scanning files:

| Tool | Use For |
|------|---------|
| `codegraph_search` | Find symbols by name (functions, classes, types) |
| `codegraph_context` | Get relevant code context for a task |
| `codegraph_callers` | Find what calls a function |
| `codegraph_callees` | Find what a function calls |
| `codegraph_impact` | See what's affected by changing a symbol |
| `codegraph_node` | Get details + source code for a symbol |

**When spawning Explore agents in a codegraph-enabled project:**

Tell the Explore agent to use codegraph tools for faster exploration.

**For quick lookups in the main session:**
- Use `codegraph_search` instead of grep for finding symbols
- Use `codegraph_callers`/`codegraph_callees` to trace code flow
- Use `codegraph_impact` before making changes to see what's affected

### If `.codegraph/` does NOT exist

At the start of a session, ask the user if they'd like to initialize CodeGraph:

"I notice this project doesn't have CodeGraph initialized. Would you like me to run `codegraph init -i` to build a code knowledge graph?"
```

</details>

---

## 📋 Requirements

- Node.js >= 18.0.0

---

## 💻 CLI Usage

```bash
codegraph                   # Run interactive installer
codegraph install           # Run interactive installer (explicit)
codegraph init [path]       # Initialize in a project
codegraph index [path]      # Full index
codegraph sync [path]       # Incremental update
codegraph status [path]     # Show statistics
codegraph query <search>    # Search symbols
codegraph context <task>    # Build context for AI
codegraph hooks install     # Install git auto-sync hook
codegraph serve --mcp       # Start MCP server
```

## 📖 CLI Commands

### `codegraph` / `codegraph install`

Run the interactive installer for Claude Code integration. Configures MCP server and permissions automatically.

```bash
codegraph                         # Run installer (when no args)
codegraph install                 # Run installer (explicit)
npx @colbymchenry/codegraph       # Run via npx (no global install needed)
```

The installer will:
1. Ask for installation location (global `~/.claude` or local `./.claude`)
2. Configure the MCP server in `claude.json`
3. Optionally set up auto-allow permissions
4. Add global instructions to `~/.claude/CLAUDE.md` (teaches Claude how to use CodeGraph)
5. For local installs: initialize and index the current project

### `codegraph init [path]`

Initialize CodeGraph in a project directory. Creates a `.codegraph/` directory with the database and configuration.

```bash
codegraph init                    # Initialize in current directory
codegraph init /path/to/project   # Initialize in specific directory
codegraph init --index            # Initialize and immediately index
codegraph init --no-hooks         # Skip git hook installation
```

### `codegraph index [path]`

Index all files in the project. Extracts functions, classes, methods, and their relationships.

```bash
codegraph index                   # Index current directory
codegraph index --force           # Force full re-index
codegraph index --quiet           # Suppress progress output
```

### `codegraph sync [path]`

Incrementally sync changes since the last index. Only processes added, modified, or removed files.

```bash
codegraph sync                    # Sync current directory
codegraph sync --quiet            # Suppress output
```

### `codegraph status [path]`

Show index status and statistics.

```bash
codegraph status
```

Output includes:
- Files indexed, nodes, edges
- Nodes by kind (functions, classes, methods, etc.)
- Files by language
- Pending changes (if any)
- Git hook status

### `codegraph query <search>`

Search for symbols in the codebase by name.

```bash
codegraph query "authenticate"           # Search for symbols
codegraph query "User" --kind class      # Filter by kind
codegraph query "process" --limit 20     # Limit results
codegraph query "validate" --json        # Output as JSON
```

### `codegraph context <task>`

Build relevant code context for a task. Uses semantic search to find entry points, then expands through the graph to find related code.

```bash
codegraph context "fix checkout bug"
codegraph context "add user authentication" --format json
codegraph context "refactor payment service" --max-nodes 30
```

### `codegraph hooks`

Manage git hooks for automatic syncing.

```bash
codegraph hooks install    # Install post-commit hook
codegraph hooks remove     # Remove hook
codegraph hooks status     # Check if hook is installed
```

### `codegraph serve`

Start CodeGraph as an MCP server for AI assistants.

```bash
codegraph serve                          # Show MCP configuration help
codegraph serve --mcp                    # Start MCP server (stdio)
codegraph serve --mcp --path /project    # Specify project path
```

## 🔌 MCP Tools Reference

When running as an MCP server, CodeGraph exposes these tools to AI assistants. **These tools are designed to be used by Claude's Explore agents** for faster, more efficient codebase exploration.

### `codegraph_context`

Build context for a specific task. Good for focused queries.

```
codegraph_context(task: "fix checkout validation bug", maxNodes: 20)
```

### `codegraph_search`

Quick symbol search by name. Returns locations only.

```
codegraph_search(query: "UserService", kind: "class", limit: 10)
```

### `codegraph_callers` / `codegraph_callees`

Find what calls a function, or what a function calls.

```
codegraph_callers(symbol: "validatePayment", limit: 20)
codegraph_callees(symbol: "processOrder", limit: 20)
```

### `codegraph_impact`

Analyze what code would be affected by changing a symbol.

```
codegraph_impact(symbol: "UserService", depth: 2)
```

### `codegraph_node`

Get details about a specific symbol. Use `includeCode: true` only when needed.

```
codegraph_node(symbol: "authenticate", includeCode: true)
```

### `codegraph_status`

Check index health and statistics.

### How It Works With Claude Code

Claude's **Explore agents** use these tools instead of grep/glob/Read for faster exploration:

| Without CodeGraph | With CodeGraph | Benefit |
|-------------------|----------------|---------|
| `grep -r "auth"` | `codegraph_search("auth")` | Instant symbol lookup |
| Multiple `Read` calls | `codegraph_context(task)` | Related code in one call |
| Manual file tracing | `codegraph_callers/callees` | Call graph traversal |
| Guessing impact | `codegraph_impact(symbol)` | Know what breaks |

This hybrid approach gives you **~30% fewer tokens** and **~25% fewer tool calls** while letting Claude's native agents handle synthesis.

## 📚 Library Usage

CodeGraph can also be used as a library in your Node.js applications:

```typescript
import CodeGraph from '@colbymchenry/codegraph';

// Initialize a new project
const cg = await CodeGraph.init('/path/to/project');

// Or open an existing one
const cg = await CodeGraph.open('/path/to/project');

// Index with progress callback
await cg.indexAll({
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.current}/${progress.total}`);
  }
});

// Search for symbols
const results = cg.searchNodes('UserService');

// Get callers of a function
const node = results[0].node;
const callers = cg.getCallers(node.id);

// Build context for a task
const context = await cg.buildContext('fix login bug', {
  maxNodes: 20,
  includeCode: true,
  format: 'markdown'
});

// Get impact radius
const impact = cg.getImpactRadius(node.id, 2);

// Sync changes
const syncResult = await cg.sync();

// Clean up
cg.close();
```

## ⚙️ How It Works

### 1. Extraction

CodeGraph uses [tree-sitter](https://tree-sitter.github.io/) to parse source code into ASTs. Language-specific queries (`.scm` files) extract:

- **Nodes**: Functions, methods, classes, interfaces, types, variables
- **Edges**: Calls, imports, extends, implements, returns_type

Each node gets a unique ID based on its kind, file path, name, and line number.

### 2. Storage

All data is stored in a local SQLite database (`.codegraph/codegraph.db`):

- **nodes** table: All code entities with metadata
- **edges** table: Relationships between nodes
- **files** table: File tracking for incremental updates
- **node_vectors** / **vector_map**: Embeddings for semantic search (using sqlite-vss)

### 3. Reference Resolution

After extraction, CodeGraph resolves references:

1. Match function calls to function definitions
2. Resolve imports to their source files
3. Link class inheritance and interface implementations
4. Apply framework-specific patterns (Express routes, etc.)

### 4. Semantic Search

CodeGraph uses local embeddings (via [@xenova/transformers](https://github.com/xenova/transformers.js)) to enable semantic search:

1. Code symbols are embedded using a transformer model
2. Queries are embedded and compared using cosine similarity
3. Results are ranked by relevance

### 5. Graph Queries

The graph structure enables powerful queries:

- **Callers/Callees**: Direct call relationships
- **Impact Radius**: BFS traversal to find all potentially affected code
- **Dependencies**: What a symbol depends on
- **Dependents**: What depends on a symbol

### 6. Context Building

When you request context for a task:

1. Semantic search finds relevant entry points
2. Graph traversal expands to related code
3. Code snippets are extracted
4. Results are formatted for AI consumption

## ⚙️ Configuration

The `.codegraph/config.json` file controls indexing behavior:

```json
{
  "version": 1,
  "projectName": "my-project",
  "languages": ["typescript", "javascript"],
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**",
    "*.min.js"
  ],
  "frameworks": ["express", "react"],
  "maxFileSize": 1048576
}
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `languages` | Languages to index (auto-detected if empty) | `[]` |
| `exclude` | Glob patterns to ignore | `["node_modules/**", ...]` |
| `frameworks` | Framework hints for better resolution | `[]` |
| `maxFileSize` | Skip files larger than this (bytes). Skipped files won't appear in the graph. | `1048576` (1MB) |

## 🌐 Supported Languages

| Language | Extension | Status |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx` | Full support |
| JavaScript | `.js`, `.jsx`, `.mjs` | Full support |
| Python | `.py` | Full support |
| Go | `.go` | Full support |
| Rust | `.rs` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support |
| PHP | `.php` | Full support |
| Ruby | `.rb` | Full support |
| C | `.c`, `.h` | Full support |
| C++ | `.cpp`, `.hpp`, `.cc` | Full support |
| Swift | `.swift` | Basic support |
| Kotlin | `.kt` | Basic support |

## 🔧 Troubleshooting

### "CodeGraph not initialized"

Run `codegraph init` in your project directory first.

### Indexing is slow

- Check if `node_modules` or other large directories are excluded
- Use `--quiet` flag to reduce console output overhead
- Consider increasing `maxFileSize` if you have large files to skip

### MCP server not connecting

1. Ensure the project is initialized and indexed
2. Check the path in your MCP configuration is correct
3. Verify `codegraph serve --mcp` works from the command line
4. Check Claude Code logs for connection errors

### Missing symbols in search

- Run `codegraph sync` to pick up recent changes
- Check if the file's language is supported
- Verify the file isn't excluded by config patterns
- Files larger than `maxFileSize` (default 1MB) are silently skipped during indexing. Increase the limit in `.codegraph/config.json` if needed

---

## 📚 Documentation

- **[Implementation Plan](IMPLEMENTATION_PLAN.md)** - Technical architecture and design decisions
- **[Contributing Guide](CLAUDE.md)** - Guidelines for contributing to CodeGraph

---

## 📄 License

MIT

---

<div align="center">

**Made for the Claude Code community** 🤖

[Report Bug](https://github.com/colbymchenry/codegraph/issues) · [Request Feature](https://github.com/colbymchenry/codegraph/issues)

</div>
