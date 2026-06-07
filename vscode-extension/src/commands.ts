/**
 * CodeGraph Commands
 *
 * Registers all VS Code commands contributed by the CodeGraph extension.
 * Commands are the primary user interaction surface (Command Palette, context menus,
 * keyboard shortcuts).
 *
 * Each command validates the current state before invoking the MCP client,
 * providing clear feedback when CodeGraph is not ready.
 *
 * Bug #1 fix: MCP tools return { content: [{ type: 'text', text: '...' }] }
 * not structured JSON. We now:
 * 1. Extract text from result.content[0].text
 * 2. Parse the markdown-formatted text to build QuickPick items
 * 3. Extract file paths and line numbers for navigation
 *
 * Bug #9 fix: getSymbolAtCursor now tries to qualify the word with its
 * surrounding context (e.g., ClassName.methodName instead of just methodName).
 *
 * Bug C fix: extractMcpText now returns { text, isError } so callers can
 * distinguish error responses from successful results and show appropriate UI.
 *
 * Bug G fix: OutputChannel is now cached to avoid creating duplicate channels
 * on repeated fallback displays.
 *
 * All user-facing strings use i18n module for Chinese localization.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CodeGraphManager } from './codegraphManager';
import { t } from './i18n';

// =============================================================================
// MCP response parsing utilities
// =============================================================================

/**
 * Result of extracting text from an MCP ToolResult.
 *
 * Bug C fix: Previously extractMcpText() returned just a string, making it
 * impossible for callers to distinguish error responses from successful ones.
 * Now returns a structured result with an isError flag.
 */
interface McpTextResult {
  /** The extracted text content from content[0].text */
  text: string;
  /** True if the MCP server flagged this as an error (isError: true) */
  isError: boolean;
}

/**
 * MCP ToolResult format (as defined in src/mcp/tools.ts).
 *
 * The server returns structured content, not raw JSON objects:
 *   { content: [{ type: 'text', text: 'markdown-formatted string' }], isError?: boolean }
 *
 * Bug C fix: Now returns { text, isError } instead of just text.
 * Callers check isError first and show an error message instead of
 * trying to parse error text as search results.
 *
 * Returns null if the response format is unexpected or empty.
 */
function extractMcpText(result: unknown): McpTextResult | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const isError = r.isError === true;

  // Extract text from content array
  const content = r.content as Array<{ type: string; text: string }> | undefined;
  if (content && content.length > 0 && content[0].text) {
    return { text: content[0].text, isError };
  }
  return null;
}

/**
 * Parse a search result entry from the markdown-formatted text.
 *
 * CodeGraph codegraph_search returns text in this format:
 *   ## Search Results (N found)
 *
 *   ### symbolName (kind)
 *   filePath:line
 *   `signature`
 *
 * This regex extracts: name, kind, filePath, line, signature from each entry.
 */
interface ParsedSymbol {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  signature?: string;
}

/**
 * Parse search results from CodeGraph's markdown-formatted output.
 *
 * The format is:
 *   ### symbolName (kind)
 *   filePath:line
 *   `signature`
 *
 * We use regex to extract structured data from the markdown text.
 */
function parseSearchResults(text: string): ParsedSymbol[] {
  const results: ParsedSymbol[] = [];
  // Match each ### heading block with its file path and optional signature
  const entryRegex = /### (.+?) \((\w+)\)\n(.+?)(?:\n`(.+?)`)?/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(text)) !== null) {
    const name = match[1];
    const kind = match[2];
    const location = match[3].trim();
    const signature = match[4]; // Optional — may be undefined

    // Parse "filePath:line" or just "filePath"
    const lastColon = location.lastIndexOf(':');
    let filePath = location;
    let line = 0;

    if (lastColon !== -1) {
      const possibleLine = parseInt(location.substring(lastColon + 1), 10);
      if (!isNaN(possibleLine)) {
        filePath = location.substring(0, lastColon);
        line = possibleLine;
      }
    }

    results.push({ name, kind, filePath, line, signature });
  }

  return results;
}

/**
 * Parse node list results from codegraph_callers/callees output.
 *
 * The format is:
 *   - symbolName (kind) - filePath:line
 */
function parseNodeList(text: string): ParsedSymbol[] {
  const results: ParsedSymbol[] = [];
  // Match list items: "- name (kind) - filePath:line"
  const itemRegex = /- (.+?) \((\w+)\) - (.+)/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(text)) !== null) {
    const name = match[1];
    const kind = match[2];
    const location = match[3].trim();

    // Parse "filePath:line"
    const lastColon = location.lastIndexOf(':');
    let filePath = location;
    let line = 0;

    if (lastColon !== -1) {
      const possibleLine = parseInt(location.substring(lastColon + 1), 10);
      if (!isNaN(possibleLine)) {
        filePath = location.substring(0, lastColon);
        line = possibleLine;
      }
    }

    results.push({ name, kind, filePath, line });
  }

  return results;
}

/**
 * Parse impact analysis results from codegraph_impact output.
 *
 * The format is:
 *   ## Impact: "symbol" affects N symbols
 *
 *   **filePath:**
 *   name:line, name2:line2
 *
 * We extract each name:line pair with its parent filePath.
 */
function parseImpactResults(text: string): ParsedSymbol[] {
  const results: ParsedSymbol[] = [];
  let currentFile = '';

  // Split into lines for line-by-line parsing
  const lines = text.split('\n');
  for (const line of lines) {
    // Match file headers: **filePath:**
    const fileMatch = line.match(/^\*\*(.+?):\*\*$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Match symbol lines: name1:line1, name2:line2
    // Skip empty lines and header lines
    if (!line.trim() || line.startsWith('#') || line.startsWith('Impact')) {
      continue;
    }

    // Parse comma-separated name:line pairs
    // Only process lines that look like symbol references (contain colons after names)
    if (currentFile && line.includes(':')) {
      const pairs = line.split(',');
      for (const pair of pairs) {
        const trimmed = pair.trim();
        // Match "name:line" pattern — name can contain dots for qualified names
        const symMatch = trimmed.match(/^(.+):(\d+)$/);
        if (symMatch) {
          results.push({
            name: symMatch[1],
            kind: 'symbol', // Impact results don't include kind info in text
            filePath: currentFile,
            line: parseInt(symMatch[2], 10),
          });
        }
      }
    }
  }

  return results;
}

// =============================================================================
// Bug G fix: Cached OutputChannel
// =============================================================================

/**
 * Bug G fix: Cache the OutputChannel so repeated fallback displays reuse
 * the same channel instead of creating duplicates in the Output panel.
 * VS Code's createOutputChannel with the same name returns a new instance
 * each time, cluttering the dropdown.
 */
let cachedOutputChannel: vscode.OutputChannel | null = null;

/**
 * Show raw text output in a VS Code output channel when structured parsing fails.
 * This is a fallback for unrecognized response formats.
 *
 * Bug G fix: Reuses a single cached OutputChannel named "CodeGraph" instead of
 * creating a new one per call.
 */
function showRawTextOutput(title: string, text: string): void {
  if (!cachedOutputChannel) {
    cachedOutputChannel = vscode.window.createOutputChannel(t('output.channelName'));
  }
  cachedOutputChannel.clear();
  cachedOutputChannel.appendLine(`--- ${title} ---`);
  cachedOutputChannel.appendLine(text);
  cachedOutputChannel.show(true); // Show but don't take focus
}

/**
 * Register all CodeGraph commands with the VS Code command system.
 *
 * @param context - Extension context for registering disposables
 * @param manager - The CodeGraph manager (provides MCP client access)
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  manager: CodeGraphManager
): void {
  const commands: vscode.Disposable[] = [
    // -------------------------------------------------------------------------
    // Index management commands (建立索引 / 删除索引)
    // -------------------------------------------------------------------------

    vscode.commands.registerCommand('codegraph.initialize', async () => {
      // Already initialized? Just reconnect
      if (manager.getState() === 'ready') {
        vscode.window.showInformationMessage(t('prompt.alreadyInitialized'));
        return;
      }
      await manager.initialize();
    }),

    /**
     * Build index command — triggered by the sidebar button.
     * If already initialized, runs reindex; otherwise does full init.
     */
    vscode.commands.registerCommand('codegraph.buildIndex', async () => {
      await manager.buildIndex();
    }),

    /**
     * Delete index command — triggered by the sidebar button.
     * Removes .codegraph/ directory after confirmation.
     */
    vscode.commands.registerCommand('codegraph.deleteIndex', async () => {
      await manager.deleteIndex();
    }),

    vscode.commands.registerCommand('codegraph.reindex', async () => {
      await manager.reindex();
    }),

    // -------------------------------------------------------------------------
    // Search commands
    // -------------------------------------------------------------------------

    vscode.commands.registerCommand('codegraph.searchSymbol', async () => {
      const client = manager.getClient();
      if (!client) {
        vscode.window.showWarningMessage(t('prompt.notReady'));
        return;
      }

      const query = await vscode.window.showInputBox({
        prompt: t('search.prompt'),
        placeHolder: t('search.placeholder'),
      });
      if (!query) return;

      try {
        const result = await client.callTool('codegraph_search', {
          query,
          limit: 20,
        });

        // Bug #1 + Bug C fix: Extract text and check isError from MCP ToolResult
        const mcpResult = extractMcpText(result);

        if (!mcpResult) {
          vscode.window.showInformationMessage(t('prompt.noResults'));
          return;
        }

        // Bug C fix: Show error message for server-side errors instead of
        // trying to parse error text as search results
        if (mcpResult.isError) {
          vscode.window.showErrorMessage(`CodeGraph 错误: ${mcpResult.text}`);
          return;
        }

        const text = mcpResult.text;

        // Check for "not found" messages from the server
        if (text.includes('No results found')) {
          vscode.window.showInformationMessage(t('prompt.noResultsFor', query));
          return;
        }

        // Parse the markdown-formatted search results
        const parsed = parseSearchResults(text);

        if (parsed.length === 0) {
          // If we couldn't parse the format, show raw text as fallback
          showRawTextOutput(t('sidebar.searchResults'), text);
          return;
        }

        // Present parsed results in QuickPick for navigation
        const items: vscode.QuickPickItem[] = parsed.map((s) => ({
          label: s.name,
          description: `${s.kind} · ${s.filePath}${s.line ? `:${s.line}` : ''}`,
          detail: s.signature || '',
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: t('search.foundResults', String(items.length)),
        });

        if (selected) {
          // Find the original parsed symbol by matching label + description
          const originalSymbol = parsed.find(
            (s) => s.name === selected.label
          );
          if (originalSymbol) {
            await openNodeLocation(originalSymbol, manager);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(t('search.failed', msg));
      }
    }),

    // -------------------------------------------------------------------------
    // Navigation commands (callers, callees, impact)
    // -------------------------------------------------------------------------

    vscode.commands.registerCommand('codegraph.showCallers', async () => {
      await runSymbolQuery(manager, 'codegraph_callers', '调用者');
    }),

    vscode.commands.registerCommand('codegraph.showCallees', async () => {
      await runSymbolQuery(manager, 'codegraph_callees', '被调用者');
    }),

    vscode.commands.registerCommand('codegraph.showImpact', async () => {
      await runSymbolQuery(manager, 'codegraph_impact', '影响分析', { depth: 2 });
    }),

    // -------------------------------------------------------------------------
    // TreeView refresh
    // -------------------------------------------------------------------------

    vscode.commands.registerCommand('codegraph.refresh', async () => {
      // TreeProvider.refresh() is called via the TreeProvider instance in extension.ts
      // This command is registered so the view title button can trigger it.
      vscode.commands.executeCommand('codegraph.refreshTree');
    }),
  ];

  context.subscriptions.push(...commands);
}

// =============================================================================
// Private helpers
// =============================================================================

/**
 * Run a symbol-based query (callers, callees, impact) for the symbol under the cursor.
 *
 * Bug #1 fix: Parse MCP ToolResult format (content[0].text) instead of
 * accessing result.nodes directly.
 * Bug C fix: Check isError flag before parsing results.
 *
 * @param manager - CodeGraph manager
 * @param toolName - MCP tool name (e.g., 'codegraph_callers')
 * @param displayName - Human-readable name for UI messages (Chinese)
 * @param extraArgs - Additional arguments to pass to the tool
 */
async function runSymbolQuery(
  manager: CodeGraphManager,
  toolName: string,
  displayName: string,
  extraArgs: Record<string, unknown> = {}
): Promise<void> {
  const client = manager.getClient();
  if (!client) {
    vscode.window.showWarningMessage(t('prompt.notReady'));
    return;
  }

  const symbol = await getSymbolAtCursor();
  if (!symbol) {
    vscode.window.showWarningMessage(t('prompt.noSymbol'));
    return;
  }

  try {
    const result = await client.callTool(toolName, {
      symbol,
      limit: 20,
      ...extraArgs,
    });

    // Bug #1 + Bug C fix: Extract text and check isError
    const mcpResult = extractMcpText(result);

    if (!mcpResult) {
      vscode.window.showInformationMessage(t('prompt.noResults'));
      return;
    }

    // Bug C fix: Show error message for server-side errors
    if (mcpResult.isError) {
      vscode.window.showErrorMessage(`CodeGraph 错误: ${mcpResult.text}`);
      return;
    }

    const text = mcpResult.text;

    // Check for "not found" messages from the server
    if (text.includes('not found in the codebase')) {
      vscode.window.showInformationMessage(t('prompt.symbolNotFound', symbol));
      return;
    }

    if (text.includes(`No ${displayName.toLowerCase()} found`) || text.includes('No callers') || text.includes('No callees')) {
      vscode.window.showInformationMessage(t('prompt.noResults'));
      return;
    }

    // Parse based on tool type — callers/callees use list format, impact uses grouped format
    let parsed: ParsedSymbol[];

    if (toolName === 'codegraph_impact') {
      parsed = parseImpactResults(text);
    } else {
      parsed = parseNodeList(text);
    }

    if (parsed.length === 0) {
      // If we couldn't parse the format, show raw text as fallback
      showRawTextOutput(displayName, text);
      return;
    }

    // Present parsed results in QuickPick for navigation
    const items: vscode.QuickPickItem[] = parsed.map((s) => ({
      label: s.name,
      description: `${s.kind} · ${s.filePath}:${s.line}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `${displayName}: ${symbol}（${items.length} 个结果）`,
    });

    if (selected) {
      const originalSymbol = parsed.find(
        (s) => s.name === selected.label
      );
      if (originalSymbol) {
        await openNodeLocation(originalSymbol, manager);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(t('search.queryFailed', displayName, msg));
  }
}

/**
 * Get the symbol name at the current cursor position in the active editor.
 *
 * Bug #9 fix: Uses a multi-strategy approach:
 * 1. Try to get a qualified name by looking at surrounding dots (e.g., ClassName.method)
 * 2. Fall back to the bare word at cursor position
 *
 * This improves accuracy for tools like codegraph_callers that need precise
 * symbol names when multiple symbols share the same short name.
 */
async function getSymbolAtCursor(): Promise<string | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;

  const position = editor.selection.active;

  // Strategy 1: Try to get a qualified name if cursor is on "obj.method" or "Class.method"
  // This finds the larger range including dots and identifiers on both sides
  const qualifiedRange = editor.document.getWordRangeAtPosition(
    position,
    // Match qualified identifiers: word characters plus dots for property access
    /[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*/
  );

  if (qualifiedRange) {
    const qualifiedName = editor.document.getText(qualifiedRange);
    // If we got something with a dot, use the qualified form
    if (qualifiedName && qualifiedName.includes('.')) {
      // Return just the last part after the final dot for codegraph lookup
      // CodeGraph indexes symbols by their short name, not qualified name
      const parts = qualifiedName.split('.');
      return parts[parts.length - 1];
    }
    // If no dot, it's just a regular word — still valid
    if (qualifiedName) return qualifiedName;
  }

  // Strategy 2: Fall back to bare word detection
  const wordRange = editor.document.getWordRangeAtPosition(position);
  if (!wordRange) return null;

  return editor.document.getText(wordRange);
}

/**
 * Open a file at a specific line/column based on a parsed symbol result.
 *
 * @param node - A ParsedSymbol with filePath, line, name
 * @param manager - CodeGraph manager (for resolving relative paths)
 */
async function openNodeLocation(node: ParsedSymbol, manager: CodeGraphManager): Promise<void> {
  if (!node.filePath) return;

  let filePath = node.filePath;
  // If CodeGraph returns a relative path, resolve it against the project root
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(manager.getProjectPath(), filePath);
  }

  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);

    const line = Math.max(0, node.line - 1); // Convert 1-based to 0-based
    const column = 0;
    const position = new vscode.Position(line, column);

    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  } catch (err) {
    // File may not exist or may be excluded from the workspace
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showWarningMessage(t('prompt.cannotOpenFile', filePath, msg));
  }
}
