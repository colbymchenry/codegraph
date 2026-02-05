# CodeGraph Quick Reference

One-page reference for common CodeGraph commands and workflows.

---

## Installation

```bash
# Interactive installer (recommended)
npx @colbymchenry/codegraph

# Global installation
npm install -g @colbymchenry/codegraph

# Development (from source)
git clone https://github.com/colbymchenry/codegraph.git
cd codegraph
npm install --legacy-peer-deps
npm run build
npm link
```

---

## Essential Commands

| Command | Description | Example |
|---------|-------------|---------|
| `codegraph` | Run interactive installer | `codegraph` |
| `codegraph init` | Initialize in current dir | `codegraph init --index` |
| `codegraph index` | Full index/re-index | `codegraph index` |
| `codegraph sync` | Incremental update | `codegraph sync` |
| `codegraph status` | Show statistics | `codegraph status` |
| `codegraph query <term>` | Search symbols | `codegraph query "authenticate"` |
| `codegraph context <task>` | Build AI context | `codegraph context "fix login"` |
| `codegraph hooks install` | Install git hooks | `codegraph hooks install` |

---

## Common Flags

| Flag | Usage | Description |
|------|-------|-------------|
| `--index` | `init --index` | Auto-index after init |
| `--no-hooks` | `init --no-hooks` | Skip git hook installation |
| `--force` | `index --force` | Force full re-index |
| `--quiet` | `sync --quiet` | Suppress output |
| `--json` | `query --json` | JSON output format |
| `--kind <type>` | `query --kind function` | Filter by node kind |
| `--limit <n>` | `query --limit 20` | Limit results |
| `--format <type>` | `context --format json` | Output format |

---

## Quick Start Workflows

### New Project Setup
```bash
cd your-project
codegraph init --index
codegraph status
```

### Daily Development
```bash
# Make changes
git add .
git commit -m "changes"  # Hook auto-syncs

# Or manually
codegraph sync
```

### Search & Explore
```bash
# Find symbols
codegraph query "authenticate"

# Build context
codegraph context "fix login bug"

# Check impact
codegraph query "myFunction"
# Use ID from result:
# codegraph impact <id>
```

### Git Worktrees
```bash
# Main repo
cd main
codegraph init --index

# Worktree (skip hooks - already installed)
git worktree add ../feature
cd ../feature
codegraph init --index --no-hooks
```

---

## MCP Tools (for Claude Code)

| Tool | Purpose | Example |
|------|---------|---------|
| `codegraph_status` | Get index stats | Auto-called by Claude |
| `codegraph_search` | Find symbols | `search(query: "auth")` |
| `codegraph_context` | Build context | `context(task: "fix login")` |
| `codegraph_callers` | Find callers | `callers(symbol: "login")` |
| `codegraph_callees` | Find callees | `callees(symbol: "main")` |
| `codegraph_impact` | Impact analysis | `impact(symbol: "User")` |
| `codegraph_node` | Get node details | `node(symbol: "authenticate")` |

---

## Node Kinds

```
file, module, function, method, class, struct, interface, trait,
protocol, property, field, variable, constant, enum, enum_member,
type_alias, namespace, parameter, import, export, route, component
```

---

## Edge Kinds

```
contains, calls, imports, exports, extends, implements, references,
type_of, returns, instantiates, overrides, decorates
```

---

## Supported Languages

```
TypeScript, JavaScript, TSX, JSX, Python, Go, Rust, Java, C, C++,
C#, PHP, Ruby, Swift, Kotlin, Liquid
```

---

## Supported Frameworks

```
Laravel, Express, Next.js, Nuxt, Rails, Django, Flask, Spring,
SwiftUI, UIKit, Android, Shopify, React, Vue, Svelte
```

---

## Configuration (.codegraph/config.json)

```json
{
  "version": 1,
  "projectName": "my-project",
  "languages": [],
  "exclude": [
    "node_modules/**",
    "vendor/**",
    "dist/**",
    "build/**"
  ],
  "frameworks": ["express", "react"],
  "embeddingModel": "nomic-embed-text-v1.5",
  "maxFileSize": 1048576,
  "gitHooksEnabled": true
}
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Not initialized" | `codegraph init --index` |
| "Database locked" | Wait 3s or `pkill -f codegraph` |
| Slow indexing | Add excludes, use `--quiet` |
| Missing symbols | `codegraph sync` or `--force` |
| MCP not connecting | Check `~/.claude.json`, restart Claude |
| Hooks not working | `codegraph hooks install` |
| Out of memory | `NODE_OPTIONS="--max-old-space-size=4096"` |

---

## File Structure

```
your-project/
├── .codegraph/
│   ├── codegraph.db       # Generated index (gitignored)
│   ├── config.json        # Configuration (commit this)
│   └── .gitignore         # Auto-generated
├── .git/
│   └── hooks/
│       └── post-commit    # Auto-sync hook
└── src/
```

---

## Git Worktree Behavior

| Aspect | Behavior |
|--------|----------|
| Git hooks | ✅ Shared (main repo) |
| CodeGraph index | ❌ Independent per worktree |
| Configuration | ❌ Independent per worktree |
| Database file | ❌ Separate per worktree |

**Setup pattern:**
- Main: `codegraph init --index`
- Worktrees: `codegraph init --index --no-hooks`

---

## Performance Benchmarks

| Project Size | Files | Time | DB Size |
|--------------|-------|------|---------|
| Small | < 100 | 1-5s | ~500KB |
| Medium | 100-1000 | 10-60s | 1-5MB |
| Large | 1000-10000 | 1-5min | 5-50MB |

---

## Library Usage (TypeScript)

```typescript
import CodeGraph from '@colbymchenry/codegraph';

// Initialize
const cg = await CodeGraph.init('/path/to/project', {
  index: true,
  onProgress: (p) => console.log(p.phase)
});

// Search
const results = cg.searchNodes('authenticate');

// Get callers
const callers = await cg.getCallers(results[0].node.id);

// Build context
const context = await cg.buildContext('fix login bug');

// Sync
const syncResult = await cg.sync();

// Clean up
cg.close();
```

---

## Claude Code Integration

**~/.claude.json:**
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

**Initialize projects:**
```bash
cd project
codegraph init --index
```

**Claude automatically uses CodeGraph when `.codegraph/` exists!**

---

## Benefits

- 🚀 **30% fewer tokens** in Claude Code Explore agents
- ⚡ **25% fewer tool calls** overall
- 🔍 **Instant graph queries** vs file scanning
- 🏠 **100% local** - no external APIs
- 🌍 **15+ languages** supported
- 🔄 **Auto-sync** with git hooks
- 🌳 **Git worktree** compatible

---

## Resources

- **Docs**: See `USAGE_GUIDE.md` for comprehensive guide
- **GitHub**: https://github.com/colbymchenry/codegraph
- **NPM**: https://www.npmjs.com/package/@colbymchenry/codegraph
- **Issues**: https://github.com/colbymchenry/codegraph/issues

---

## Quick Example

```bash
# Install
npm install -g @colbymchenry/codegraph

# Setup
cd my-project
codegraph init --index

# Search
codegraph query "authenticate"

# Context
codegraph context "how does login work?"

# Status
codegraph status

# That's it! 🎉
```
