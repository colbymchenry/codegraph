# CodeGraph Usage Guide

Complete guide to using CodeGraph for semantic code intelligence.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [Core Concepts](#core-concepts)
4. [CLI Commands](#cli-commands)
5. [Claude Code Integration](#claude-code-integration)
6. [Git Worktree Support](#git-worktree-support)
7. [MCP Tools Reference](#mcp-tools-reference)
8. [Library Usage](#library-usage)
9. [Common Workflows](#common-workflows)
10. [Configuration](#configuration)
11. [Best Practices](#best-practices)
12. [Troubleshooting](#troubleshooting)

---

## Quick Start

### For Claude Code Users

```bash
# Run the interactive installer (recommended)
npx @colbymchenry/codegraph

# Or install globally
npm install -g @colbymchenry/codegraph
codegraph install
```

The installer will:
- Configure the MCP server in `~/.claude.json`
- Set up auto-allow permissions
- Add global instructions to `~/.claude/CLAUDE.md`
- Optionally initialize your current project

### For CLI Users

```bash
# Install globally
npm install -g @colbymchenry/codegraph

# In any project
cd your-project
codegraph init --index
```

---

## Installation

### Global Installation (Recommended)

```bash
npm install -g @colbymchenry/codegraph
```

After installation, the `codegraph` command is available globally.

### Local Development

```bash
# Clone and build
git clone https://github.com/colbymchenry/codegraph.git
cd codegraph
npm install --legacy-peer-deps
npm run build

# Link globally for development
npm link
```

### Requirements

- **Node.js**: >= 18.0.0
- **Git**: Optional but recommended for auto-sync hooks
- **Disk Space**: ~300MB for embedding models (downloaded on first use)

---

## Core Concepts

### The Knowledge Graph

CodeGraph builds a semantic knowledge graph with two main components:

**Nodes** - Code entities:
- Functions, methods, classes, interfaces
- Variables, constants, types
- Routes, components (framework-specific)

**Edges** - Relationships:
- `calls` - Function/method invocations
- `imports`/`exports` - Module dependencies
- `extends`/`implements` - Inheritance
- `returns_type`, `references`, `instantiates`, etc.

### Per-Project Storage

Each project gets its own `.codegraph/` directory:

```
your-project/
├── .codegraph/
│   ├── codegraph.db       # SQLite database with graph + vectors
│   ├── config.json        # Project configuration (committed)
│   └── .gitignore         # Ignores db, keeps config
├── .git/
└── src/
```

**What to commit:**
- ✅ `.codegraph/config.json` - Configuration settings
- ❌ `.codegraph/codegraph.db` - Generated index (too large, machine-specific)

### Incremental Updates

CodeGraph tracks file content hashes and only reindexes changed files:

1. **Initial index**: Scans all files
2. **Sync**: Detects changes via content hashing
3. **Git hooks**: Auto-sync after each commit (optional)

---

## CLI Commands

### `codegraph` / `codegraph install`

Run the interactive installer for Claude Code integration.

```bash
codegraph                  # Auto-detects and guides setup
codegraph install          # Explicit installer command
```

**What it does:**
- Configures MCP server in `~/.claude.json`
- Sets up auto-allow permissions in `~/.claude/settings.json`
- Adds usage instructions to `~/.claude/CLAUDE.md`
- Optionally initializes current project

### `codegraph init [path]`

Initialize CodeGraph in a project directory.

```bash
codegraph init                      # Initialize in current directory
codegraph init /path/to/project     # Initialize specific directory
codegraph init --index              # Init + immediate indexing
codegraph init --no-hooks           # Skip git hook installation
```

**Creates:**
- `.codegraph/` directory
- Empty SQLite database
- Default configuration file
- Git post-commit hook (unless `--no-hooks`)

**Options:**
- `-i, --index` - Run full indexing immediately
- `--no-hooks` - Skip git hooks installation

### `codegraph index [path]`

Index all files in the project.

```bash
codegraph index                     # Index current directory
codegraph index /path/to/project    # Index specific project
codegraph index --force             # Force full re-index
codegraph index --quiet             # Suppress progress output
```

**When to use:**
- After initial `codegraph init`
- After pulling major changes
- When forcing a complete rebuild

**Performance:**
- ~1-5 seconds for small projects (< 100 files)
- ~10-60 seconds for medium projects (100-1000 files)
- ~1-5 minutes for large projects (1000-10000 files)

### `codegraph sync [path]`

Incrementally sync changes since last index.

```bash
codegraph sync                      # Sync current directory
codegraph sync --quiet              # Suppress output
```

**When to use:**
- After making code changes
- After switching branches
- Automatically via git hooks

**How it works:**
1. Scans all files and computes content hashes
2. Compares with stored hashes from last index
3. Re-indexes only changed/added files
4. Removes deleted files from graph

### `codegraph status [path]`

Show index status and statistics.

```bash
codegraph status                    # Current directory
codegraph status /path/to/project   # Specific project
```

**Output includes:**
- Total files, nodes, edges
- Database size
- Breakdown by node kind (functions, classes, etc.)
- Breakdown by language
- Git hooks status
- Last indexed timestamp

**Example output:**
```
CodeGraph Status

Project: /Users/dev/my-app

Index Statistics:
  Files:     387
  Nodes:     2,145
  Edges:     3,892
  DB Size:   2.4 MB

Nodes by Kind:
  function        842
  method          521
  class           198
  interface       87
  type            312
  variable        185

Files by Language:
  typescript      312
  javascript      58
  tsx             17

✓ Index is up to date
✓ Git hooks: installed
```

### `codegraph query <search>`

Search for symbols in the codebase by name.

```bash
codegraph query "authenticate"              # Simple search
codegraph query "User" --kind class         # Filter by kind
codegraph query "validate" --limit 20       # Limit results
codegraph query "api" --json                # JSON output
```

**Options:**
- `--kind <type>` - Filter by node kind (function, class, method, etc.)
- `--limit <n>` - Maximum number of results (default: 10)
- `--json` - Output as JSON instead of formatted text

**Example output:**
```
Search Results for "authenticate":

function    authenticate (0%)
  src/auth.ts:15
  (username: string, password: string): Promise<User>

method      authenticate (0%)
  src/services/AuthService.ts:42
  (credentials: Credentials): Promise<Token>

function    isAuthenticated (0%)
  src/middleware/auth.ts:8
  (req: Request): boolean
```

### `codegraph context <task>`

Build relevant code context for a task.

```bash
codegraph context "fix login bug"
codegraph context "add user authentication" --format json
codegraph context "refactor payment service" --max-nodes 30
```

**Options:**
- `--format <type>` - Output format: `markdown` (default) or `json`
- `--max-nodes <n>` - Maximum nodes to include (default: 20)
- `--include-code` - Include full code snippets (default: true)

**How it works:**
1. Performs semantic search on the task description
2. Finds relevant entry points (functions, classes)
3. Expands through the graph (callers, callees, dependencies)
4. Extracts code snippets
5. Formats as structured context

**Example output:**
```markdown
## Code Context

**Query:** fix login bug

### Entry Points

- **login** (function) - src/auth.ts:15
- **validateCredentials** (function) - src/auth.ts:28

### Related Symbols

- src/auth.ts: authenticate:15, validateCredentials:28, hashPassword:42
- src/models/User.ts: User:5, findByUsername:12
- src/services/TokenService.ts: generateToken:8

### Code

#### login (src/auth.ts:15)

\`\`\`typescript
export async function login(username: string, password: string): Promise<Token> {
  const user = await User.findByUsername(username);
  if (!user) {
    throw new AuthError('User not found');
  }
  
  const valid = await validateCredentials(user, password);
  if (!valid) {
    throw new AuthError('Invalid credentials');
  }
  
  return TokenService.generateToken(user.id);
}
\`\`\`

...
```

### `codegraph hooks`

Manage git hooks for automatic syncing.

```bash
codegraph hooks install     # Install post-commit hook
codegraph hooks remove      # Remove hook
codegraph hooks status      # Check if hook is installed
```

**The post-commit hook:**
- Runs `codegraph sync --quiet` after each commit
- Executes in background (non-blocking)
- Only runs if `.codegraph/` directory exists
- Works with git worktrees (installs in main repo)

**Hook location:**
- Regular repo: `.git/hooks/post-commit`
- Git worktree: `main-repo/.git/hooks/post-commit` (shared)

### `codegraph serve`

Start CodeGraph as an MCP server for AI assistants.

```bash
codegraph serve                          # Show MCP configuration help
codegraph serve --mcp                    # Start MCP server (stdio)
codegraph serve --mcp --path /project    # Specify project path
```

**Usage:**
- Typically configured in `~/.claude.json`, not run manually
- Uses stdio transport for communication with Claude Code
- Exposes MCP tools for semantic search and graph queries

---

## Claude Code Integration

### Automatic Setup (Recommended)

```bash
npx @colbymchenry/codegraph
```

Or if installed globally:

```bash
codegraph install
```

The installer configures everything automatically.

### Manual Setup

**1. Add to `~/.claude.json`:**

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

**2. Add auto-allow permissions in `~/.claude/settings.json`:**

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

**3. Add global instructions to `~/.claude/CLAUDE.md`:**

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

### If `.codegraph/` does NOT exist

At the start of a session, ask the user if they'd like to initialize CodeGraph:

"I notice this project doesn't have CodeGraph initialized. Would you like me to run `codegraph init -i` to build a code knowledge graph?"
```

**4. Restart Claude Code**

### Initialize Projects

For each project you want to use CodeGraph with:

```bash
cd your-project
codegraph init --index
```

### How Claude Uses CodeGraph

**Without CodeGraph:**
```
User: "Find all functions that call authenticate"
  → Spawn Explore agent
  → grep -r "authenticate"
  → Read multiple files
  → Manually trace calls
  → 60+ tool calls, 150k+ tokens
```

**With CodeGraph:**
```
User: "Find all functions that call authenticate"
  → codegraph_callers(symbol: "authenticate")
  → Instant graph lookup
  → 1 tool call, ~500 tokens
```

**Performance Impact:**
- **~30% fewer tokens** in Explore agents
- **~25% fewer tool calls** overall
- **Faster exploration** - graph queries vs file scanning

---

## Git Worktree Support

CodeGraph fully supports git worktrees with intelligent hook sharing and independent indices.

### How It Works

**Shared:**
- ✅ Git hooks (installed in main repo's `.git/hooks/`)

**Independent:**
- ✅ Code indices (each worktree has its own `.codegraph/`)
- ✅ Configuration (can be customized per worktree)

### Setup Pattern

**Main repository:**
```bash
cd main-repo
codegraph init --index
# Installs hooks in main-repo/.git/hooks/post-commit
```

**Worktrees:**
```bash
git worktree add ../feature-branch
cd ../feature-branch
codegraph init --index --no-hooks  # Skip hook installation
```

**Why `--no-hooks`?**
- Hooks are already installed in main repo
- Worktrees share the main repo's hooks directory
- No need to install again

### Workflow Example

```bash
# Main branch
cd ~/projects/my-app
codegraph init --index
# Index: 387 files, 2,145 nodes

# Create worktree for feature
git worktree add ../my-app-feature
cd ../my-app-feature
codegraph init --index --no-hooks

# Add new API endpoints
cat > src/api/users.ts << 'EOF'
export async function getUsers(): Promise<User[]> { ... }
export async function createUser(data: UserInput): Promise<User> { ... }
EOF

git add src/api/users.ts
git commit -m "add user API"
# Hook auto-syncs in background

# Search in feature branch
codegraph query "getUsers"
# Found: getUsers in src/api/users.ts

# Search in main branch
cd ~/projects/my-app
codegraph query "getUsers"
# Not found (different index)
```

### Directory Structure

```
~/projects/
├── my-app/                    # Main repository
│   ├── .git/
│   │   ├── hooks/
│   │   │   └── post-commit    # ← Shared hook
│   │   └── worktrees/
│   │       └── my-app-feature/
│   ├── .codegraph/            # ← Independent index
│   │   └── codegraph.db
│   └── src/
│
└── my-app-feature/            # Worktree
    ├── .git                   # → Points to my-app/.git
    ├── .codegraph/            # ← Independent index
    │   └── codegraph.db
    └── src/
        └── api/
            └── users.ts       # New file only in this branch
```

### Status Comparison

```bash
# Main branch
cd ~/projects/my-app
codegraph status
# Files: 387
# Nodes: 2,145

# Feature branch
cd ~/projects/my-app-feature
codegraph status
# Files: 388  (one more file)
# Nodes: 2,147  (two more functions)
```

### Best Practices

1. **Install hooks once** in the main repository
2. **Use `--no-hooks`** when initializing worktrees
3. **Each worktree gets its own index** - this is correct and expected
4. **Sync before switching** contexts to keep indices fresh

---

## MCP Tools Reference

When running as an MCP server, CodeGraph exposes these tools to Claude Code.

### `codegraph_status`

Get index status and statistics.

**Parameters:** None

**Returns:**
```json
{
  "initialized": true,
  "totalFiles": 387,
  "totalNodes": 2145,
  "totalEdges": 3892,
  "languages": ["typescript", "javascript"],
  "nodesByKind": {
    "function": 842,
    "class": 198,
    "method": 521
  }
}
```

### `codegraph_search`

Quick symbol search by name.

**Parameters:**
- `query` (required) - Search term
- `kind` (optional) - Node kind filter
- `limit` (optional) - Max results (default: 10)

**Returns:**
```json
{
  "results": [
    {
      "id": "function:src/auth.ts:authenticate:15",
      "kind": "function",
      "name": "authenticate",
      "filePath": "src/auth.ts",
      "startLine": 15,
      "signature": "(username: string, password: string): Promise<User>",
      "score": 0
    }
  ]
}
```

### `codegraph_context`

Build context for a specific task.

**Parameters:**
- `task` (required) - Task description
- `maxNodes` (optional) - Max nodes to include (default: 20)
- `includeCode` (optional) - Include code snippets (default: true)

**Returns:**
```json
{
  "entryPoints": ["function:src/auth.ts:login:15"],
  "nodes": [...],
  "edges": [...],
  "codeBlocks": [
    {
      "nodeId": "function:src/auth.ts:login:15",
      "nodeName": "login",
      "nodeKind": "function",
      "filePath": "src/auth.ts",
      "startLine": 15,
      "endLine": 28,
      "code": "export async function login(...) { ... }",
      "language": "typescript"
    }
  ],
  "relatedFiles": ["src/auth.ts", "src/models/User.ts"]
}
```

### `codegraph_callers`

Find what calls a symbol.

**Parameters:**
- `symbol` (required) - Symbol name to search
- `limit` (optional) - Max results (default: 20)

**Returns:**
```json
{
  "symbol": "authenticate",
  "callers": [
    {
      "id": "function:src/api/auth.ts:loginHandler:8",
      "kind": "function",
      "name": "loginHandler",
      "filePath": "src/api/auth.ts",
      "startLine": 8
    }
  ]
}
```

### `codegraph_callees`

Find what a symbol calls.

**Parameters:**
- `symbol` (required) - Symbol name to search
- `limit` (optional) - Max results (default: 20)

**Returns:**
```json
{
  "symbol": "login",
  "callees": [
    {
      "id": "function:src/auth.ts:authenticate:15",
      "kind": "function",
      "name": "authenticate",
      "filePath": "src/auth.ts",
      "startLine": 15
    }
  ]
}
```

### `codegraph_impact`

Analyze impact of changing a symbol.

**Parameters:**
- `symbol` (required) - Symbol name to analyze
- `depth` (optional) - Traversal depth (default: 2)

**Returns:**
```json
{
  "symbol": "authenticate",
  "impactedNodes": [
    {
      "id": "function:src/api/auth.ts:loginHandler:8",
      "kind": "function",
      "name": "loginHandler",
      "distance": 1
    },
    {
      "id": "function:src/api/users.ts:getUserProfile:12",
      "kind": "function",
      "name": "getUserProfile",
      "distance": 2
    }
  ],
  "totalImpacted": 15
}
```

### `codegraph_node`

Get full details about a specific symbol.

**Parameters:**
- `symbol` (required) - Symbol name to look up
- `includeCode` (optional) - Include source code (default: false)

**Returns:**
```json
{
  "node": {
    "id": "function:src/auth.ts:authenticate:15",
    "kind": "function",
    "name": "authenticate",
    "filePath": "src/auth.ts",
    "startLine": 15,
    "endLine": 28,
    "signature": "(username: string, password: string): Promise<User>",
    "docstring": "Authenticate user with username and password",
    "code": "export async function authenticate(...) { ... }"
  },
  "edges": {
    "calls": ["User.findByUsername", "validatePassword"],
    "calledBy": ["loginHandler", "refreshToken"]
  }
}
```

---

## Library Usage

CodeGraph can be used as a library in Node.js applications.

### Installation

```bash
npm install @colbymchenry/codegraph
```

### Basic Usage

```typescript
import CodeGraph from '@colbymchenry/codegraph';

// Initialize a new project
const cg = await CodeGraph.init('/path/to/project', {
  config: {
    frameworks: ['express', 'react']
  },
  index: true,
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.current}/${progress.total}`);
  }
});

// Get status
const status = await cg.getStatus();
console.log(`Indexed ${status.totalNodes} nodes`);

// Search for symbols
const results = cg.searchNodes('authenticate');
console.log(`Found ${results.length} matches`);

// Get callers
const callers = await cg.getCallers(results[0].node.id);
console.log(`${results[0].node.name} is called by ${callers.length} functions`);

// Build context for a task
const context = await cg.buildContext('fix login bug', {
  maxNodes: 20,
  includeCode: true,
  format: 'markdown'
});
console.log(context.summary);

// Clean up
cg.close();
```

### Opening Existing Projects

```typescript
import CodeGraph from '@colbymchenry/codegraph';

// Open existing project
const cg = await CodeGraph.open('/path/to/project', {
  sync: true  // Auto-sync on open
});

// Use the graph
const impact = await cg.getImpactRadius('function:src/auth.ts:login:15', {
  maxDepth: 2,
  maxNodes: 50
});

cg.close();
```

### Incremental Updates

```typescript
// Sync changes
const syncResult = await cg.sync();
console.log(`Updated ${syncResult.filesChanged} files`);

// Or index specific files
await cg.indexFiles(['src/auth.ts', 'src/api/users.ts']);
```

### Graph Traversal

```typescript
// Get dependencies
const deps = await cg.getDependencies('class:src/services/AuthService.ts:AuthService:8');

// Get dependents
const dependents = await cg.getDependents('function:src/utils/hash.ts:hash:5');

// Find paths between nodes
const paths = await cg.findPaths(
  'function:src/api/auth.ts:login:10',
  'class:src/models/User.ts:User:5',
  { maxDepth: 5, maxPaths: 3 }
);
```

### Semantic Search

```typescript
// Search by meaning
const results = await cg.search('authentication middleware', {
  limit: 10,
  nodeKinds: ['function', 'class']
});

// Find relevant context
const context = await cg.findRelevantContext('user registration flow', {
  searchLimit: 5,
  traversalDepth: 2,
  maxNodes: 30
});
```

### Git Hooks Management

```typescript
// Install hooks
const installResult = cg.installGitHooks();
if (installResult.success) {
  console.log('Hooks installed');
}

// Remove hooks
const removeResult = cg.removeGitHooks();

// Check status
const isInstalled = cg.isGitHooksInstalled();
```

### Configuration

```typescript
// Get current config
const config = cg.getConfig();

// Update config
await cg.updateConfig({
  frameworks: ['nextjs', 'express'],
  exclude: ['node_modules/**', 'dist/**', 'coverage/**']
});
```

### Statistics

```typescript
// Get detailed stats
const stats = await cg.getStats();
console.log(stats);
// {
//   files: 387,
//   nodes: {
//     total: 2145,
//     byKind: { function: 842, class: 198, ... },
//     byLanguage: { typescript: 1823, javascript: 322 }
//   },
//   edges: {
//     total: 3892,
//     byKind: { calls: 2145, imports: 842, ... }
//   }
// }
```

---

## Common Workflows

### 1. Setting Up a New Project

```bash
cd your-project

# Initialize with indexing
codegraph init --index

# Check status
codegraph status

# Test search
codegraph query "main"
```

### 2. Daily Development Flow

```bash
# Make code changes
git add .
git commit -m "add feature"
# Hook auto-syncs in background

# Or manually sync
codegraph sync

# Query the graph
codegraph query "myNewFunction"
```

### 3. Understanding Unknown Codebase

```bash
# Index the project
codegraph init --index

# Find entry points
codegraph query "main"
codegraph query "app"

# Understand a specific feature
codegraph context "how does authentication work?"

# Trace dependencies
codegraph query "authenticate" --kind function
# Get the ID from results, then:
codegraph callers <function-id>
codegraph callees <function-id>
```

### 4. Impact Analysis Before Refactoring

```bash
# Find the function to refactor
codegraph query "calculateTotal"

# Check what would be affected
codegraph impact "calculateTotal"

# Build full context
codegraph context "refactor calculateTotal function"
```

### 5. Working with Multiple Branches

```bash
# Main branch
cd main-repo
codegraph init --index

# Feature branch (worktree)
git worktree add ../feature-branch
cd ../feature-branch
codegraph init --index --no-hooks

# Work independently
# Each branch has its own index
# Search results reflect current branch code
```

### 6. Integrating with CI/CD

```bash
# In CI pipeline
npm install -g @colbymchenry/codegraph

# Index and export stats
codegraph init --index --no-hooks
codegraph status --json > codegraph-stats.json

# Use for analysis, metrics, documentation generation
```

### 7. Finding Code Patterns

```bash
# Find all authentication-related code
codegraph query "auth" --limit 50

# Find all API endpoints
codegraph query "route" --kind route

# Find all React components
codegraph query "component" --kind component
```

---

## Configuration

Configuration is stored in `.codegraph/config.json`.

### Default Configuration

```json
{
  "version": 1,
  "projectName": "my-project",
  "languages": [],
  "exclude": [
    "node_modules/**",
    "vendor/**",
    ".git/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "*.min.js",
    "*.bundle.js",
    "__pycache__/**",
    ".venv/**",
    "Pods/**",
    ".gradle/**"
  ],
  "frameworks": [],
  "embeddingModel": "nomic-embed-text-v1.5",
  "chunkStrategy": "ast",
  "maxFileSize": 1048576,
  "gitHooksEnabled": true
}
```

### Configuration Options

**`projectName`** (string)
- Human-readable project name
- Auto-detected from directory name

**`languages`** (array)
- Languages to index: `["typescript", "javascript", "python"]`
- Empty array = auto-detect all supported languages

**`exclude`** (array)
- Glob patterns to ignore
- Always exclude: dependencies, build outputs, git

**`frameworks`** (array)
- Framework hints for better resolution
- Options: `laravel`, `express`, `nextjs`, `rails`, `django`, `spring`, `react`, `vue`, `shopify`

**`embeddingModel`** (string)
- Model for semantic search
- Options: `nomic-embed-text-v1.5` (default), `all-MiniLM-L6-v2`

**`chunkStrategy`** (string)
- How to chunk code for embeddings
- Options: `ast` (default), `hybrid`

**`maxFileSize`** (number)
- Skip files larger than this (bytes)
- Default: 1048576 (1MB)

**`gitHooksEnabled`** (boolean)
- Whether to install git hooks
- Default: `true`

### Customizing Configuration

**Via init:**
```bash
codegraph init --config '{"frameworks": ["nextjs", "react"]}'
```

**Manual edit:**
```bash
cd your-project
vim .codegraph/config.json
# Make changes
codegraph index --force  # Re-index with new config
```

**Via library:**
```typescript
await cg.updateConfig({
  frameworks: ['express', 'react'],
  exclude: [...defaultExcludes, 'custom-dir/**']
});
```

### Framework-Specific Patterns

CodeGraph includes special handling for popular frameworks:

**Laravel (PHP)**
- Route definitions: `Route::get('/users', ...)`
- Eloquent models: `User::find($id)`
- Facades: `Auth::user()`, `Cache::get()`
- Views: `view('users.index')`

**Express (Node.js)**
- Routes: `app.get('/users', ...)`
- Middleware: `app.use(authenticate)`

**Next.js (React)**
- API routes: `pages/api/**/*.ts`
- Server actions
- Client/server components

**React**
- Component rendering: `<UserProfile />`
- Hook usage: `useState`, `useEffect`

**Shopify (Liquid)**
- Template rendering: `{% render 'product-card' %}`
- Sections: `{% section 'header' %}`
- Assets: `{{ 'style.css' | asset_url }}`

---

## Best Practices

### 1. Initialize Early

```bash
# Initialize as soon as you clone/start a project
git clone repo
cd repo
npm install
codegraph init --index  # ← Do this right away
```

### 2. Commit Configuration

```bash
# Always commit config, never commit database
git add .codegraph/config.json
git commit -m "add codegraph config"

# .codegraph/.gitignore already excludes *.db
```

### 3. Use Git Hooks

```bash
# Let hooks keep your index fresh
codegraph init  # Installs hooks by default

# Work normally - auto-sync after commits
git commit -m "changes"  # ← Hook runs in background
```

### 4. Sync Before Important Queries

```bash
# If you've made many changes without committing
codegraph sync

# Then query
codegraph context "implement feature X"
```

### 5. Exclude Generated Code

```json
{
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**",
    "*.generated.ts",
    "prisma/migrations/**"
  ]
}
```

### 6. Use Framework Hints

```json
{
  "frameworks": ["nextjs", "react", "express"]
}
```

This enables better reference resolution for framework-specific patterns.

### 7. Regular Maintenance

```bash
# Periodically rebuild index (e.g., after major refactoring)
codegraph index --force

# Check for issues
codegraph status
```

### 8. Monitor Database Size

```bash
codegraph status
# DB Size: 2.4 MB  ← Should stay reasonable

# If too large, check for accidentally indexed files
# Update exclude patterns in config
```

### 9. Worktree Strategy

```bash
# Main repo: full setup
cd main
codegraph init --index

# Worktrees: skip hooks
git worktree add ../feature
cd ../feature
codegraph init --index --no-hooks
```

### 10. Claude Code Integration

```bash
# Set up once globally
codegraph install

# Then just initialize projects
cd project1 && codegraph init --index
cd project2 && codegraph init --index

# Claude automatically uses CodeGraph when available
```

---

## Troubleshooting

### "CodeGraph not initialized"

**Problem:** Running commands in a non-initialized directory.

**Solution:**
```bash
codegraph init --index
```

### "database is locked"

**Problem:** Another CodeGraph process is accessing the database.

**Solution:**
```bash
# Wait a few seconds for background sync to complete
sleep 3
codegraph sync

# Or kill background processes
pkill -f "codegraph sync"
```

### Indexing is slow

**Problem:** Large codebase or too many files.

**Solutions:**
```bash
# 1. Exclude more directories
vim .codegraph/config.json
# Add to "exclude": ["node_modules/**", "vendor/**", "dist/**"]

# 2. Increase maxFileSize to skip large files
# { "maxFileSize": 2097152 }  // 2MB

# 3. Use --quiet to reduce console overhead
codegraph index --quiet
```

### Missing symbols in search

**Problem:** Code changes not reflected in index.

**Solutions:**
```bash
# Sync changes
codegraph sync

# Force full re-index
codegraph index --force

# Check if file is excluded
codegraph status  # Shows indexed files count
```

### MCP server not connecting

**Problem:** Claude Code can't connect to CodeGraph.

**Solutions:**
```bash
# 1. Verify MCP configuration
cat ~/.claude.json
# Should have "codegraph" entry

# 2. Test MCP server manually
codegraph serve --mcp
# Should start without errors

# 3. Check project is initialized
cd project
codegraph status

# 4. Restart Claude Code
```

### Git hooks not working

**Problem:** Commits don't trigger auto-sync.

**Solutions:**
```bash
# Check if hooks are installed
codegraph hooks status

# Reinstall hooks
codegraph hooks install

# Verify hook file exists
cat .git/hooks/post-commit
# Should contain "CodeGraph auto-sync hook"

# Test manually
codegraph sync --quiet
```

### Out of memory on large codebases

**Problem:** Node.js runs out of memory during indexing.

**Solution:**
```bash
# Increase Node.js memory
NODE_OPTIONS="--max-old-space-size=4096" codegraph index
```

### Unresolved references

**Problem:** Function calls not linked to definitions.

**Solutions:**
```bash
# 1. Add framework hints
vim .codegraph/config.json
# { "frameworks": ["express", "react"] }

# 2. Re-index with new config
codegraph index --force

# 3. Check if target is in excluded directory
# Adjust exclude patterns if needed
```

### Different results in worktrees

**Problem:** Search results differ between main and worktree.

**Solution:** This is **expected behavior**! Each worktree has independent code and should have its own index. If you want to search the main branch code, switch to the main branch directory.

### Embedding model download fails

**Problem:** First-time initialization fails to download model.

**Solutions:**
```bash
# 1. Check internet connection
ping huggingface.co

# 2. Check disk space (needs ~300MB)
df -h

# 3. Manually download
mkdir -p ~/.codegraph/models
# Re-run initialization
codegraph init --index
```

### Permission errors

**Problem:** Cannot create `.codegraph/` directory.

**Solution:**
```bash
# Check directory permissions
ls -la

# Ensure you own the project directory
sudo chown -R $USER:$USER .

# Try again
codegraph init
```

---

## Additional Resources

- **GitHub Repository**: https://github.com/colbymchenry/codegraph
- **NPM Package**: https://www.npmjs.com/package/@colbymchenry/codegraph
- **Issues & Support**: https://github.com/colbymchenry/codegraph/issues
- **API Documentation**: See `README.md` and inline JSDoc comments

---

## Summary

CodeGraph provides semantic code intelligence through:

✅ **Fast initialization** - `codegraph init --index`  
✅ **Automatic syncing** - Git hooks keep index fresh  
✅ **Powerful queries** - Search, callers, callees, impact analysis  
✅ **Claude Code integration** - Reduce tokens, faster exploration  
✅ **Git worktree support** - Independent indices per branch  
✅ **15+ languages** - Universal tree-sitter parsing  
✅ **100% local** - No external APIs, no data leaves your machine  

**Get started in 30 seconds:**

```bash
npx @colbymchenry/codegraph
```

Happy coding! 🚀
