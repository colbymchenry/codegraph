/**
 * CodeGraph TreeView Provider
 *
 * Provides data for the CodeGraph Explorer sidebar in VS Code.
 * Supports two view modes:
 * 1. File structure view - mirrors the project's file tree with symbols inside files
 * 2. Symbol type view - groups symbols by kind (classes, functions, interfaces, etc.)
 *
 * Bug #7 fix: Previously, the tree only showed placeholder root nodes with no
 * children. Now, the "Files" and "Symbols" roots fetch live data from the MCP
 * server when expanded:
 * - Files root: Uses codegraph_files to list indexed files
 * - Symbols root: Uses codegraph_search with an empty query to list top symbols
 * - Search Results root: Remains a placeholder for search command results
 *
 * Bug A fix: Pass format:'flat' to codegraph_files so the output is a simple
 * list of `- filePath (metadata)` lines, instead of the default tree format
 * which uses box-drawing characters that are hard to parse.
 *
 * Bug B fix: Changed query from '*' to '' (empty string). FTS5 treats bare '*'
 * as a prefix operator which requires a preceding token — it returns 0 results.
 * An empty query triggers searchAllByFilters which returns all symbols.
 *
 * Bug F fix: Use top-level `import * as path from 'path'` instead of
 * `require('path')` inside resolvePath() to avoid redundant module loading.
 *
 * Bug I fix: parseFilePaths now correctly handles the flat format
 * (`- filePath (metadata)`) by matching `- ` prefix lines and extracting
 * the path before the metadata parentheses.
 *
 * Lazy loading: children are only fetched when the user expands a node.
 * This avoids loading the entire graph into memory on startup.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CodeGraphManager } from './codegraphManager';
import { t } from './i18n';

/**
 * A node in the CodeGraph Explorer tree.
 * Can represent a file, a folder, or a code symbol.
 */
interface CodeGraphTreeNode {
  /** Unique identifier for VS Code's tree rendering engine */
  id: string;

  /** Display label */
  label: string;

  /** Whether this node can be expanded */
  collapsibleState: vscode.TreeItemCollapsibleState;

  /** Optional icon (ThemeIcon for native VS Code look) */
  iconPath?: vscode.ThemeIcon;

  /** Context menu group (for view/item/context contributions) */
  contextValue?: string;

  /** Command to execute when the node is clicked */
  command?: vscode.Command;

  /** Child nodes (populated lazily from MCP) */
  children?: CodeGraphTreeNode[];

  /** Tooltip for hover info */
  tooltip?: string;

  /** Resource URI (for file nodes, enables file icon resolution) */
  resourceUri?: vscode.Uri;
}

export class CodeGraphTreeProvider implements vscode.TreeDataProvider<CodeGraphTreeNode> {
  /** Event to signal that the tree should refresh */
  private _onDidChangeTreeData = new vscode.EventEmitter<CodeGraphTreeNode | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private manager: CodeGraphManager) {}

  /** Trigger a full tree refresh (e.g., after state change or re-index) */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Convert a CodeGraphTreeNode into a VS Code TreeItem for rendering.
   *
   * We return a plain TreeItem (not a custom class) because VS Code's
   * native tree rendering is fastest and most theme-consistent.
   */
  getTreeItem(element: CodeGraphTreeNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.label, element.collapsibleState);
    treeItem.id = element.id;
    treeItem.iconPath = element.iconPath;
    treeItem.contextValue = element.contextValue;
    treeItem.command = element.command;
    treeItem.tooltip = element.tooltip;
    // If this node represents a file, set resourceUri for file icon theming
    if (element.resourceUri) {
      treeItem.resourceUri = element.resourceUri;
    }
    return treeItem;
  }

  /**
   * Return child nodes for a given parent element.
   *
   * Bug #7 fix: Now fetches data from the MCP server instead of returning
   * empty arrays. Roots expand into live data from CodeGraph.
   *
   * If element is undefined, returns root-level nodes based on current state.
   * If element is a root node, fetches its children from MCP.
   */
  async getChildren(element?: CodeGraphTreeNode): Promise<CodeGraphTreeNode[]> {
    if (!element) {
      return this.getRootNodes();
    }

    // Fetch children from MCP based on the root node type
    const client = this.manager.getClient();
    if (!client) {
      return element.children || [];
    }

    switch (element.id) {
      case 'files-root':
        return this.fetchFilesRoot(client);
      case 'symbols-root':
        return this.fetchSymbolsRoot(client);
      case 'search-root':
        // Search results are populated by command actions, not auto-fetched
        return element.children || [];
      default:
        // For non-root nodes, return cached children
        return element.children || [];
    }
  }

  /**
   * Build the root-level nodes based on current manager state.
   *
   * State-based UI: show different roots depending on whether CodeGraph is
   * uninitialized, indexing, ready, or in error state.
   */
  private async getRootNodes(): Promise<CodeGraphTreeNode[]> {
    const state = this.manager.getState();

    // State: uninitialized
    if (state === 'uninitialized') {
      return [
        {
          id: 'uninitialized',
          label: t('sidebar.notInitialized'),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon('info'),
          tooltip: t('action.buildIndexTooltip'),
        },
      ];
    }

    // State: installing (auto-installing CodeGraph)
    if (state === 'installing') {
      return [
        {
          id: 'installing',
          label: t('install.installing'),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon('cloud-download'),
          tooltip: t('install.checking'),
        },
      ];
    }

    // State: indexing
    if (state === 'indexing') {
      return [
        {
          id: 'indexing',
          label: t('sidebar.indexing'),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon('sync~spin'),
          tooltip: t('index.building'),
        },
      ];
    }

    // State: error
    if (state === 'error') {
      return [
        {
          id: 'error',
          label: t('sidebar.error'),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon('error'),
          tooltip: t('action.retry'),
          command: {
            command: 'codegraph.initialize',
            title: t('action.retry'),
          },
        },
      ];
    }

    // State: ready → show the dual-view root nodes
    return [
      {
        id: 'files-root',
        label: t('sidebar.files'),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('file-directory'),
        tooltip: t('sidebar.browseFiles'),
      },
      {
        id: 'symbols-root',
        label: t('sidebar.symbols'),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('symbol-class'),
        tooltip: t('sidebar.browseSymbols'),
      },
      {
        id: 'search-root',
        label: t('sidebar.searchResults'),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('search'),
        tooltip: t('sidebar.recentSearches'),
      },
    ];
  }

  /**
   * Fetch the files root from CodeGraph.
   *
   * Bug A fix: Pass format:'flat' so the output is a simple list of
   * `- filePath (metadata)` lines instead of the default tree format
   * with box-drawing characters (├── │ └──) that are hard to parse.
   *
   * Bug I fix: parseFilePaths now correctly handles the flat format.
   *
   * Uses codegraph_files tool to list indexed files in the project.
   */
  private async fetchFilesRoot(client: import('./mcpClient').McpClient): Promise<CodeGraphTreeNode[]> {
    try {
      const result = await client.callTool('codegraph_files', {
        // Bug A fix: Request flat format instead of default tree format.
        // Tree format uses box-drawing chars (├── │ └──) that are extremely
        // difficult to parse. Flat format is `- path (lang, N symbols)`.
        format: 'flat',
        // Don't include metadata to keep output simpler for parsing
        includeMetadata: false,
        projectPath: this.manager.getProjectPath(),
      });

      const text = this.extractText(result);
      if (!text) {
        return this.createErrorNode(t('tree.noFiles'));
      }

      // Bug I fix: Parse the flat format correctly
      const filePaths = this.parseFilePaths(text);

      if (filePaths.length === 0) {
        return this.createErrorNode(t('tree.noIndexedFiles'));
      }

      // Convert file paths to tree nodes
      return filePaths.map((filePath) => ({
        id: `file-${filePath}`,
        label: filePath.split('/').pop() || filePath,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: vscode.ThemeIcon.File,
        tooltip: filePath,
        command: {
          command: 'vscode.open',
          title: 'Open File',
          arguments: [vscode.Uri.file(this.resolvePath(filePath))],
        },
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return this.createErrorNode(t('tree.loadFilesFailed', msg));
    }
  }

  /**
   * Fetch the symbols root from CodeGraph.
   *
   * Bug B fix: Use empty query string instead of '*'. FTS5 treats bare '*'
   * as a prefix operator requiring a preceding token, returning 0 results.
   * An empty query triggers searchAllByFilters which returns all symbols.
   *
   * Uses codegraph_search to list top symbols in the project.
   */
  private async fetchSymbolsRoot(client: import('./mcpClient').McpClient): Promise<CodeGraphTreeNode[]> {
    try {
      const result = await client.callTool('codegraph_search', {
        // Bug B fix: Use empty string instead of '*'.
        // searchNodes('') → parseQuery('') → text='' → searchAllByFilters()
        // which returns all nodes without FTS5 query issues.
        query: '',
        limit: 50,
        projectPath: this.manager.getProjectPath(),
      });

      const text = this.extractText(result);
      if (!text) {
        return this.createErrorNode(t('tree.noSymbols'));
      }

      // Check for "no results" messages
      if (text.includes('No results found')) {
        return this.createErrorNode(t('tree.noIndexedSymbols'));
      }

      // Parse search results for symbol entries
      const symbols = this.parseSymbolsFromSearch(text);
      if (symbols.length === 0) {
        return this.createErrorNode(t('tree.noIndexedSymbols'));
      }

      // Return symbols as tree nodes
      return symbols.map((sym) => ({
        id: `symbol-${sym.name}-${sym.filePath}`,
        label: sym.name,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: this.getSymbolIcon(sym.kind),
        tooltip: `${sym.name} (${sym.kind}) - ${sym.filePath}:${sym.line}`,
        command: {
          command: 'vscode.open',
          title: 'Open File',
          arguments: [
            vscode.Uri.file(this.resolvePath(sym.filePath)),
            { selection: new vscode.Range(sym.line - 1, 0, sym.line - 1, 0) },
          ],
        },
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return this.createErrorNode(t('tree.loadSymbolsFailed', msg));
    }
  }

  // ---------------------------------------------------------------------------
  // Text parsing helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract text content from an MCP ToolResult.
   * MCP responses have the format: { content: [{ type: 'text', text: '...' }], isError?: boolean }
   */
  private extractText(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const r = result as Record<string, unknown>;
    const content = r.content as Array<{ type: string; text: string }> | undefined;
    if (content && content.length > 0 && content[0].text) {
      return content[0].text;
    }
    return null;
  }

  /**
   * Parse file paths from codegraph_files flat format output.
   *
   * Bug A + Bug I fix: The flat format is:
   *   ## Files (N)
   *
   *   - src/index.ts
   *   - src/utils.ts
   *   - package.json
   *
   * (With includeMetadata: false, no parenthetical metadata is appended.)
   *
   * We match lines starting with `- ` and extract the path.
   * Previously this skipped `-` lines entirely, which would have missed
   * all file entries in flat format.
   */
  private parseFilePaths(text: string): string[] {
    const paths: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();

      // Skip empty lines and header lines (## Files (N))
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Bug I fix: Match flat format list items: "- filePath"
      // The flat format from formatFilesFlat outputs "- path" per line.
      if (trimmed.startsWith('- ')) {
        // Extract path after "- " prefix
        let filePath = trimmed.substring(2).trim();

        // Strip any metadata in parentheses if includeMetadata was true
        // e.g., "src/index.ts (TypeScript, 5 symbols)" → "src/index.ts"
        const parenIdx = filePath.indexOf(' (');
        if (parenIdx !== -1) {
          filePath = filePath.substring(0, parenIdx).trim();
        }

        // Remove any remaining markdown artifacts
        filePath = filePath.replace(/`/g, '').replace(/\*\*/g, '').trim();

        // Only include non-empty paths that look like file paths
        if (filePath && (filePath.includes('/') || filePath.includes('.'))) {
          paths.push(filePath);
        }
      }
    }
    return paths;
  }

  /**
   * Parse symbol entries from codegraph_search output.
   * Format: ### symbolName (kind)\nfilePath:line\n`signature`
   */
  private parseSymbolsFromSearch(text: string): Array<{ name: string; kind: string; filePath: string; line: number }> {
    const symbols: Array<{ name: string; kind: string; filePath: string; line: number }> = [];
    const entryRegex = /### (.+?) \((\w+)\)\n(.+?)(?:\n`(.+?)`)?/g;
    let match: RegExpExecArray | null;

    while ((match = entryRegex.exec(text)) !== null) {
      const name = match[1];
      const kind = match[2];
      const location = match[3].trim();
      const lastColon = location.lastIndexOf(':');
      let filePath = location;
      let line = 1;

      if (lastColon !== -1) {
        const possibleLine = parseInt(location.substring(lastColon + 1), 10);
        if (!isNaN(possibleLine)) {
          filePath = location.substring(0, lastColon);
          line = possibleLine;
        }
      }

      symbols.push({ name, kind, filePath, line });
    }

    return symbols;
  }

  /**
   * Get a VS Code ThemeIcon for a symbol kind.
   */
  private getSymbolIcon(kind: string): vscode.ThemeIcon {
    switch (kind.toLowerCase()) {
      case 'class':
        return new vscode.ThemeIcon('symbol-class');
      case 'method':
      case 'function':
        return new vscode.ThemeIcon('symbol-method');
      case 'interface':
        return new vscode.ThemeIcon('symbol-interface');
      case 'variable':
      case 'property':
        return new vscode.ThemeIcon('symbol-property');
      case 'constant':
        return new vscode.ThemeIcon('symbol-constant');
      case 'enum':
        return new vscode.ThemeIcon('symbol-enum');
      case 'type':
      case 'typealias':
        return new vscode.ThemeIcon('symbol-struct');
      case 'module':
        return new vscode.ThemeIcon('symbol-module');
      default:
        return new vscode.ThemeIcon('symbol-field');
    }
  }

  /**
   * Resolve a relative path to absolute using the project root.
   *
   * Bug F fix: Uses top-level `import * as path from 'path'` instead of
   * `require('path')` inside the method. The previous approach called
   * require() on every invocation, which is unnecessary overhead.
   */
  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(this.manager.getProjectPath(), filePath);
  }

  /**
   * Create a single error/info node for the tree.
   */
  private createErrorNode(message: string): CodeGraphTreeNode[] {
    return [{
      id: 'tree-error',
      label: message,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon('info'),
      tooltip: message,
    }];
  }
}