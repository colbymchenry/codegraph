/**
 * CodeGraph VS Code Extension - Entry Point
 *
 * This is the main activation file for the CodeGraph VS Code extension.
 * It is called by VS Code when the extension is activated (onStartupFinished).
 *
 * Responsibilities:
 * 1. Instantiate the CodeGraphManager (state machine + subprocess manager)
 * 2. Register the TreeView provider for the CodeGraph Explorer sidebar
 * 3. Register all commands
 * 4. Activate CodeGraph detection/connection for the current workspace
 * 5. Set up auto-refresh listeners
 *
 * Design notes:
 * - We do NOT import the CodeGraph core library directly because the VS Code
 *   Extension Host runs Node.js ~20.x, which lacks the node:sqlite module
 *   required by CodeGraph (needs Node 22.5+). Instead, we spawn codegraph
 *   as a subprocess and communicate via MCP stdio.
 * - The extension is designed to be entirely optional: users who don't care
 *   about the VS Code UI can simply ignore this directory; it does not affect
 *   the core codegraph CLI or MCP server in any way.
 * - All user-facing strings use the i18n module for bilingual support (zh/en).
 */

import * as vscode from 'vscode';
import { CodeGraphManager } from './codegraphManager';
import { CodeGraphTreeProvider } from './treeProvider';
import { registerCommands } from './commands';
import { t } from './i18n';

/**
 * VS Code calls this function when the extension is activated.
 *
 * Activation events (defined in package.json):
 * - onStartupFinished: activate after VS Code has finished loading
 * - onCommand: also activate if a CodeGraph command is invoked before startup finishes
 *
 * Bug J fix: Wrapped the entire activation in try-catch so that unexpected
 * errors (e.g., VS Code API failures, workspace access issues) don't cause
 * a silent activation failure. The user sees an error message instead.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[CodeGraph] Extension activating...');

  try {
    // -------------------------------------------------------------------------
    // 1. Create the manager (handles subprocess lifecycle and FSM state)
    // -------------------------------------------------------------------------
    const manager = new CodeGraphManager(context);

    // -------------------------------------------------------------------------
    // 2. Create the TreeView provider and register the view
    // -------------------------------------------------------------------------
    const treeProvider = new CodeGraphTreeProvider(manager);

    // Register the explorer view (defined in package.json contributes.views)
    const treeView = vscode.window.createTreeView('codegraphExplorer', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Register a command to refresh the tree (used by the view title button)
    const refreshTreeCommand = vscode.commands.registerCommand(
      'codegraph.refreshTree',
      () => treeProvider.refresh()
    );
    context.subscriptions.push(refreshTreeCommand);

    // -------------------------------------------------------------------------
    // 3. Register all user-facing commands (Command Palette, menus, etc.)
    // -------------------------------------------------------------------------
    registerCommands(context, manager);

    // -------------------------------------------------------------------------
    // 4. Wire state change events to UI updates
    // -------------------------------------------------------------------------
    // When the manager's FSM state changes (e.g., ready → error),
    // refresh the TreeView so the user sees updated status.
    const stateChangeDisposable = manager.onStateChange(() => {
      treeProvider.refresh();
    });
    context.subscriptions.push(stateChangeDisposable);

    // -------------------------------------------------------------------------
    // 5. Activate CodeGraph for the current workspace
    // -------------------------------------------------------------------------
    // This detects .codegraph/, starts the subprocess, or prompts the user.
    await manager.activate();

    // -------------------------------------------------------------------------
    // 6. Listen for file saves to trigger TreeView refresh
    // -------------------------------------------------------------------------
    // CodeGraph's internal file watcher (FSEvents/inotify/ReadDirectoryChangesW)
    // detects filesystem changes automatically. We listen to VS Code's save event
    // so the TreeView refreshes promptly after the user edits files, giving
    // immediate visual feedback that the graph may be updating.
    const saveDisposable = vscode.workspace.onDidSaveTextDocument(() => {
      // Only refresh if CodeGraph is active; otherwise ignore
      if (manager.getState() === 'ready') {
        treeProvider.refresh();
      }
    });
    context.subscriptions.push(saveDisposable);

    console.log('[CodeGraph] Extension activated successfully.');
  } catch (error) {
    // Bug J fix: Catch any unexpected errors during activation and show
    // a clear error message. Without this, the extension silently fails
    // to activate and the user has no idea what went wrong.
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[CodeGraph] Extension activation failed:', msg);
    vscode.window.showErrorMessage(t('error.activationFailed', msg));
  }
}

/**
 * VS Code calls this function when the extension is deactivated.
 *
 * We must clean up resources here to prevent orphaned CodeGraph subprocesses.
 * The manager's dispose() method kills the child process gracefully.
 */
export function deactivate(): void {
  console.log('[CodeGraph] Extension deactivating...');
  // VS Code automatically disposes all context.subscriptions,
  // which includes the manager and its child process.
}
