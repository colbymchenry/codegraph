# CodeGraph for VSCode

**Semantic Code Intelligence for VS Code**

CodeGraph for VSCode is a VS Code extension that provides semantic code intelligence through static analysis. It builds a knowledge graph of your codebase, enabling powerful code navigation, impact analysis, and symbol search capabilities.

---

## Features

### 🔍 Smart Symbol Search
Search for functions, classes, variables, and other symbols across your entire codebase with intelligent filtering and ranking.

### 📊 Call Graph Visualization
- **Show Callers**: Find all functions that call the selected symbol
- **Show Callees**: Find all functions called by the selected symbol
- **Impact Analysis**: Understand the ripple effect of changes

### 🌳 Code Explorer
Browse your codebase as an interactive tree view in the Activity Bar, showing:
- File structure
- Symbol hierarchy
- Dependency relationships

### ⚡ Real-time Indexing
Automatically indexes your codebase and updates the graph when files change.

### 🌐 Bilingual Support
Full support for Chinese (Simplified/Traditional) and English interfaces. The extension automatically detects your VS Code language setting.

---

## Installation

### From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "CodeGraph for VSCode"
4. Click Install

### From VSIX File
1. Download the `.vsix` file
2. In VS Code, go to Extensions
3. Click "..." menu → "Install from VSIX..."
4. Select the downloaded file

---

## Getting Started

### 1. Initialize Your Project
Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P) and run:
```
CodeGraph: Initialize Project
```

This creates a `.codegraph/` directory in your project root containing the knowledge graph database.

### 2. Build Index
Click the **Build Index** button (➕) in the CodeGraph Explorer sidebar, or run:
```
CodeGraph: Build Index
```

### 3. Explore Your Code
- Open the CodeGraph Explorer from the Activity Bar (left sidebar)
- Browse files and symbols
- Right-click on symbols to access analysis commands

---

## Commands

| Command | Description |
|---------|-------------|
| `CodeGraph: Initialize Project` | Create `.codegraph/` directory for the current workspace |
| `CodeGraph: Build Index` | Build or rebuild the code index |
| `CodeGraph: Delete Index` | Remove the `.codegraph/` directory |
| `CodeGraph: Search Symbol` | Search for symbols across the codebase |
| `CodeGraph: Show Callers` | Find all callers of the selected symbol |
| `CodeGraph: Show Callees` | Find all callees of the selected symbol |
| `CodeGraph: Show Impact` | Analyze the impact of changes |
| `CodeGraph: Re-index` | Re-index the codebase |
| `CodeGraph: Refresh` | Refresh the CodeGraph Explorer view |

---

## Requirements

- **VS Code**: 1.85.0 or higher
- **CodeGraph CLI**: Automatically installed if not present
  - Standalone installer (no npm/Node.js required)
  - Falls back to `npm install -g @colbymchenry/codegraph` if standalone fails

---

## How It Works

CodeGraph for VSCode communicates with the CodeGraph CLI via the Model Context Protocol (MCP). The extension:

1. **Spawns** `codegraph serve --mcp` as a subprocess
2. **Communicates** via MCP stdio (JSON-RPC over stdin/stdout)
3. **Receives** analysis results and displays them in VS Code

This architecture ensures:
- **Isolation**: Extension doesn't import core library directly
- **Compatibility**: Works with any Node.js version (VS Code uses Node 20.x, CodeGraph needs 22.5+)
- **Fork-friendly**: Extension is optional and doesn't affect core CLI

---

## Configuration

The extension automatically detects and manages CodeGraph:

- **Auto-detect**: Checks for `.codegraph/` directory on startup
- **Auto-install**: Installs CodeGraph CLI if not found
- **Auto-index**: Prompts to build index if not initialized

No manual configuration required!

---

## Troubleshooting

### Extension not activating
- Ensure you have a workspace folder open
- Check the Output panel (View → Output → CodeGraph)

### CodeGraph CLI not found
The extension will attempt to auto-install. If this fails:
```bash
# macOS/Linux
curl -fsSL https://raw.githubusercontent.com/luowei729/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/luowei729/codegraph/main/install.ps1 | iex

# Or via npm
npm install -g @colbymchenry/codegraph
```

### Index not updating
- Run `CodeGraph: Re-index` from Command Palette
- Check that files are saved (unsaved changes aren't indexed)

---

## License

MIT

---

## Links

- **GitHub**: https://github.com/luowei729/codegraph
- **Issues**: https://github.com/luowei729/codegraph/issues
- **CodeGraph CLI**: https://github.com/luowei729/codegraph

---

## Changelog

### 0.9.11
- Initial release
- Semantic code intelligence via CodeGraph CLI
- Bilingual support (Chinese/English)
- Auto-install and auto-index
- Call graph visualization
- Impact analysis
- Real-time indexing

---

**Made with ❤️ by the CodeGraph team**
