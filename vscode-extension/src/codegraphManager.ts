/**
 * CodeGraph Manager
 *
 * Manages the full lifecycle of the CodeGraph MCP child process:
 * detection → auto-install → initialization → connection → monitoring → error recovery.
 *
 * Uses a finite state machine (FSM) to track the extension's current status:
 * uninitialized → installing → indexing → ready → error
 *
 * Design rationale:
 * - The VS Code Extension Host cannot load CodeGraph directly (Node version mismatch),
 *   so we manage it as an external subprocess.
 * - We auto-detect whether the current workspace has a .codegraph/ directory.
 *   If yes, we auto-start; if no, we prompt the user to initialize.
 * - We implement exponential-backoff retry for transient connection failures
 *   (e.g., daemon lock contention, port conflicts) to avoid flooding the user with errors.
 *
 * Auto-install strategy:
 * 1. Primary: Standalone installer (curl/irm) — no npm/Node.js required
 * 2. Fallback: npm install -g @luowei729/codegraph
 * 3. If both fail: show error with manual install instructions
 *
 * Bug fixes applied:
 * - #4: Handle MCP process crash via onCrash callback, transition to error state
 * - #5: Set codegraph:enabled context immediately on activation (not just on ready)
 * - #10: Reindex uses 'codegraph sync' instead of stopping/restarting MCP server
 * - #12: findCodeGraphCommand is synchronous (not async) since it uses execSync
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync } from 'child_process';
import { McpClient } from './mcpClient';
import { t } from './i18n';

/** Possible states of the CodeGraph extension */
export type CodeGraphState = 'uninitialized' | 'installing' | 'indexing' | 'ready' | 'error';

/**
 * CodeGraphManager
 *
 * Singleton per workspace. Handles:
 * 1. Locating the codegraph executable (local → global)
 * 2. Auto-installing CodeGraph if not found (standalone installer → npm fallback)
 * 3. Detecting .codegraph/ directory presence
 * 4. Prompting for initialization if absent
 * 5. Starting the MCP server subprocess
 * 6. Auto-retry with exponential backoff on failure
 * 7. Building and deleting project indexes
 * 8. Exposing the MCP client for other extension components
 */
export class CodeGraphManager implements vscode.Disposable {
  /** The active MCP client (null when not connected) */
  private client: McpClient | null = null;

  /** Current FSM state */
  private state: CodeGraphState = 'uninitialized';

  /** Absolute path to the active workspace/project */
  private projectPath: string = '';

  /** VS Code status bar item showing CodeGraph state */
  private statusBarItem: vscode.StatusBarItem;

  /** Number of consecutive start failures (for backoff calculation) */
  private retryCount = 0;

  /** Maximum allowed retries before giving up and showing error to user */
  private readonly maxRetries = 3;

  /** Disposables to clean up on extension deactivation */
  private disposables: vscode.Disposable[] = [];

  /** Event emitter for state changes (TreeView, commands listen to this) */
  private _onStateChange = new vscode.EventEmitter<CodeGraphState>();
  public readonly onStateChange = this._onStateChange.event;

  /**
   * @param context - VS Code extension context for registering disposables
   */
  constructor(private context: vscode.ExtensionContext) {
    // Create status bar item at priority 100 (left side, after source control)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'codegraph.showMenu';
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);

    // Register command to show the status menu when clicking the status bar
    const menuCommand = vscode.commands.registerCommand(
      'codegraph.showMenu',
      () => this.showStatusMenu()
    );
    this.disposables.push(menuCommand);
    context.subscriptions.push(this);
  }

  /**
   * Activate the manager when the extension starts.
   *
   * Bug #5 fix: Set codegraph:enabled context IMMEDIATELY so the TreeView
   * is visible from the start, even before the MCP connection is established.
   *
   * Flow:
   * 1. Set codegraph:enabled context (makes TreeView visible)
   * 2. Check if there's an open workspace folder
   * 3. Check if codegraph is installed — if not, auto-install silently
   * 4. Check if .codegraph/ exists in the project root
   * 5. If exists → auto-start CodeGraph server
   * 6. If absent → show info message prompting user to initialize
   */
  async activate(): Promise<void> {
    // Bug #5 fix: Enable the TreeView immediately so users can see
    // state messages (uninitialized, error) instead of a hidden view
    await vscode.commands.executeCommand('setContext', 'codegraph:enabled', true);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      // No folder open: extension is essentially idle
      this.setState('uninitialized');
      return;
    }

    // Use the first workspace folder as the project root
    this.projectPath = workspaceFolders[0].uri.fsPath;

    // Check if codegraph is installed — auto-install if not found
    const codegraphPath = this.findCodeGraphCommand();
    if (!codegraphPath) {
      // CodeGraph not installed — silently install it
      await this.autoInstallCodeGraph();
      // After install, check again
      if (!this.findCodeGraphCommand()) {
        // Install failed — stay in error state, user can retry
        return;
      }
    }

    const isInit = this.isCodeGraphInitialized(this.projectPath);

    if (isInit) {
      // .codegraph/ exists → try to connect immediately
      await this.startCodeGraph();
    } else {
      // Not initialized → inform user and offer to set up
      this.setState('uninitialized');
      this.promptInitialize();
    }
  }

  /**
   * User-initiated initialization (建立索引).
   *
   * Runs `codegraph init -i` in the project directory, which creates the
   * .codegraph/ directory and performs the first full index.
   * After completion, automatically starts the MCP server.
   *
   * If CodeGraph is not installed, attempts auto-install first.
   */
  async initialize(): Promise<void> {
    if (!this.projectPath) {
      vscode.window.showErrorMessage(t('prompt.noWorkspace'));
      return;
    }

    // Ensure CodeGraph is installed before initializing
    if (!this.findCodeGraphCommand()) {
      const installed = await this.autoInstallCodeGraph();
      if (!installed) {
        return; // autoInstallCodeGraph already showed error message
      }
    }

    this.setState('indexing');
    try {
      // Run codegraph init -i (creates .codegraph/ and indexes)
      await this.runCliCommand('init', ['-i']);
      // After successful init, start the MCP server
      await this.startCodeGraph();
      vscode.window.showInformationMessage(t('index.buildSuccess'));
    } catch (error) {
      this.setState('error');
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(t('index.buildFailed', msg));
    }
  }

  /**
   * Build index for the current project (建立索引).
   *
   * Same as initialize() but with clearer naming for the UI button.
   * If already initialized, runs reindex instead.
   */
  async buildIndex(): Promise<void> {
    if (!this.projectPath) {
      vscode.window.showErrorMessage(t('prompt.noWorkspace'));
      return;
    }

    // If already initialized, just reindex
    if (this.isCodeGraphInitialized(this.projectPath)) {
      await this.reindex();
      return;
    }

    // Otherwise, do full initialization
    await this.initialize();
  }

  /**
   * Delete the CodeGraph index for the current project (删除索引).
   *
   * Removes the .codegraph/ directory and stops the MCP server.
   * Shows a confirmation dialog before proceeding.
   */
  async deleteIndex(): Promise<void> {
    if (!this.projectPath) {
      vscode.window.showErrorMessage(t('prompt.noWorkspace'));
      return;
    }

    // Show confirmation dialog
    const confirm = await vscode.window.showWarningMessage(
      t('confirm.deleteIndex'),
      { modal: true },
      t('confirm.yes')
    );

    if (confirm !== t('confirm.yes')) {
      return; // User cancelled
    }

    this.setState('indexing');
    try {
      // Stop the MCP server first
      this.client?.stop();
      this.client = null;
      await vscode.commands.executeCommand('setContext', 'codegraph:ready', false);

      // Remove the .codegraph directory
      const codegraphDir = path.join(this.projectPath, '.codegraph');
      if (fs.existsSync(codegraphDir)) {
        fs.rmSync(codegraphDir, { recursive: true, force: true });
      }

      this.setState('uninitialized');
      vscode.window.showInformationMessage(t('index.deleteSuccess'));
    } catch (error) {
      this.setState('error');
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(t('index.deleteFailed', msg));
    }
  }

  /**
   * User-initiated re-index.
   *
   * Bug #10 fix: Instead of stopping the MCP server and restarting it (which
   * causes a service interruption window), we now use `codegraph sync` which
   * triggers a re-index while keeping the server running. CodeGraph's built-in
   * file watcher will pick up the changes automatically.
   *
   * If sync is not available or fails, we fall back to the old approach of
   * stopping and restarting the MCP server.
   */
  async reindex(): Promise<void> {
    if (this.state !== 'ready') {
      vscode.window.showWarningMessage(t('prompt.notReady'));
      return;
    }
    this.setState('indexing');
    try {
      // Bug #10 fix: Use 'sync' command instead of 'index' to avoid
      // stopping/restarting the MCP server. The sync command triggers
      // a re-index of changed files while the server keeps running.
      await this.runCliCommand('sync');
      // No need to restart — the MCP server picks up changes automatically
      // because CodeGraph's MCPEngine has watch: true by default
      this.setState('ready');
      vscode.window.showInformationMessage(t('index.reindexSuccess'));
    } catch (error) {
      // If sync fails (e.g., command not available in older versions),
      // fall back to full stop/restart cycle
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[CodeGraph] sync failed, falling back to restart:', msg);
      try {
        await this.stopAndRestart();
        vscode.window.showInformationMessage(t('index.reindexSuccess'));
      } catch (restartError) {
        this.setState('error');
        const restartMsg = restartError instanceof Error ? restartError.message : String(restartError);
        vscode.window.showErrorMessage(t('index.reindexFailed', restartMsg));
      }
    }
  }

  /** Expose the MCP client so commands and TreeView can query CodeGraph */
  getClient(): McpClient | null {
    return this.client;
  }

  /** Current FSM state */
  getState(): CodeGraphState {
    return this.state;
  }

  /** Active project path */
  getProjectPath(): string {
    return this.projectPath;
  }

  /** Dispose all resources (called on extension deactivation) */
  dispose(): void {
    this.client?.stop();
    this.disposables.forEach((d) => d.dispose());
    this._onStateChange.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Auto-install CodeGraph when it's not found on the system.
   *
   * Installation strategy (no npm required):
   * 1. Primary: Standalone installer script
   *    - macOS/Linux: curl -fsSL https://raw.githubusercontent.com/luowei729/codegraph/main/install.sh | sh
   *    - Windows: irm https://raw.githubusercontent.com/luowei729/codegraph/main/install.ps1 | iex
   *    This downloads the correct binary for the OS without needing Node.js or npm.
   *
   * 2. Fallback: npm install -g @luowei729/codegraph
   *    Only attempted if the standalone installer fails AND npm is available.
   *
   * 3. If both fail: show error with manual install instructions.
   *
   * @returns true if installation succeeded, false otherwise
   */
  private async autoInstallCodeGraph(): Promise<boolean> {
    this.setState('installing');
    vscode.window.showInformationMessage(t('install.installing'));

    // Strategy 1: Try standalone installer (no npm/Node.js required)
    const standaloneSuccess = await this.runStandaloneInstaller();
    if (standaloneSuccess) {
      vscode.window.showInformationMessage(t('install.success'));
      return true;
    }

    // Strategy 2: Try npm install as fallback
    const npmAvailable = this.isNpmAvailable();
    if (npmAvailable) {
      const npmSuccess = await this.runNpmInstaller();
      if (npmSuccess) {
        vscode.window.showInformationMessage(t('install.success'));
        return true;
      }
    }

    // Both strategies failed
    this.setState('error');
    const installHint = process.platform === 'win32'
      ? 'PowerShell: irm https://raw.githubusercontent.com/luowei729/codegraph/main/install.ps1 | iex'
      : '终端: curl -fsSL https://raw.githubusercontent.com/luowei729/codegraph/main/install.sh | sh';
    vscode.window.showErrorMessage(
      t('install.failed', '自动安装失败。请手动安装:\n' + installHint)
    );
    return false;
  }

  /**
   * Run the standalone CodeGraph installer script.
   *
   * This is the preferred installation method because:
   * - No Node.js or npm required
   * - Downloads the correct platform-specific binary
   * - Works on macOS, Linux, and Windows
   *
   * @returns true if installation succeeded
   */
  private async runStandaloneInstaller(): Promise<boolean> {
    return new Promise((resolve) => {
      let child;

      if (process.platform === 'win32') {
        // Windows: Use PowerShell to run the install script
        child = spawn('powershell', [
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          'irm https://raw.githubusercontent.com/luowei729/codegraph/main/install.ps1 | iex'
        ]);
      } else {
        // macOS/Linux: Use sh to run the install script
        // curl downloads the script, sh executes it
        child = spawn('sh', ['-c',
          'curl -fsSL https://raw.githubusercontent.com/luowei729/codegraph/main/install.sh | sh'
        ]);
      }

      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(true);
        } else {
          console.warn('[CodeGraph] Standalone installer failed:', stderr);
          resolve(false);
        }
      });

      child.on('error', (err: Error) => {
        console.warn('[CodeGraph] Standalone installer error:', err.message);
        resolve(false);
      });
    });
  }

  /**
   * Check if npm is available on the system.
   *
   * @returns true if npm command is available
   */
  private isNpmAvailable(): boolean {
    try {
      if (process.platform === 'win32') {
        execSync('where npm', { encoding: 'utf8', timeout: 3000 });
      } else {
        execSync('which npm', { encoding: 'utf8', timeout: 3000 });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install CodeGraph via npm as a fallback.
   *
   * @returns true if installation succeeded
   */
  private async runNpmInstaller(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('npm', ['install', '-g', '@luowei729/codegraph'], {
        // Use the user's home directory as cwd for global installs
        cwd: process.env.HOME || process.env.USERPROFILE || '.',
      });

      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(true);
        } else {
          console.warn('[CodeGraph] npm install failed:', stderr);
          resolve(false);
        }
      });

      child.on('error', (err: Error) => {
        console.warn('[CodeGraph] npm install error:', err.message);
        resolve(false);
      });
    });
  }

  /**
   * Start the CodeGraph MCP server subprocess.
   *
   * Steps:
   * 1. Locate the codegraph executable
   * 2. Spawn `codegraph serve --mcp` as a child process
   * 3. Connect via McpClient
   * 4. On failure, retry with exponential backoff up to maxRetries
   *
   * Bug #4 fix: Register crash callback on the MCP client so that unexpected
   * process exits transition the manager to 'error' state instead of leaving
   * it in a zombie 'ready' state.
   */
  private async startCodeGraph(): Promise<void> {
    const codegraphPath = this.findCodeGraphCommand();
    if (!codegraphPath) {
      // Should not reach here if autoInstallCodeGraph was called,
      // but handle defensively
      this.setState('error');
      vscode.window.showErrorMessage(t('error.commandNotFound'));
      return;
    }

    // Stop any previous client before starting a new one
    this.client?.stop();

    this.client = new McpClient(
      codegraphPath,
      ['serve', '--mcp'],
      this.projectPath
    );

    // Bug #4 fix: Register crash callback so we transition to 'error' state
    // when the MCP process dies unexpectedly (e.g., segfault, OOM kill)
    this.client.onCrash = (code: number | null) => {
      console.error(`[CodeGraph] MCP process crashed with exit code ${code}`);
      this.setState('error');
      vscode.window.showErrorMessage(
        t('connect.crashed', code ?? 'null')
      );
    };

    try {
      await this.client.start();
      this.retryCount = 0;
      this.setState('ready');

      // Set VS Code context so menu contributions enable
      await vscode.commands.executeCommand('setContext', 'codegraph:ready', true);
    } catch (error) {
      await this.handleStartError(error);
    }
  }

  /**
   * Stop the MCP server and restart it fresh.
   * Used as a fallback when the sync command fails during reindex.
   *
   * Bug H fix: Explicitly null the client reference before calling
   * startCodeGraph, which handles creating a fresh client.
   */
  private async stopAndRestart(): Promise<void> {
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
    await this.startCodeGraph();
  }

  /**
   * Handle connection failure with exponential backoff retry.
   *
   * Retry delays: 2s, 4s, 8s (total ~14s before giving up).
   * This covers transient issues like daemon lock contention or slow disk I/O.
   */
  private async handleStartError(error: unknown): Promise<void> {
    this.retryCount++;
    const msg = error instanceof Error ? error.message : String(error);

    if (this.retryCount < this.maxRetries) {
      const delayMs = Math.pow(2, this.retryCount) * 1000;
      vscode.window.showWarningMessage(
        t('connect.retryIn', msg, String(delayMs / 1000))
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await this.startCodeGraph();
    } else {
      this.setState('error');
      vscode.window.showErrorMessage(
        t('connect.maxRetries', String(this.maxRetries), msg)
      );
    }
  }

  /**
   * Find the codegraph executable using a tiered search strategy:
   *
   * Tier 1: Local node_modules/.bin/codegraph (project-local install)
   *   → Preferred because it respects project-specific versions
   * Tier 2: Global PATH (user installed via install.sh or npm i -g)
   *   → Fallback for globally managed installations
   *
   * Bug #12 fix: This method is now synchronous (not async) since it only
   * uses synchronous fs.existsSync and execSync. Marking it async was misleading
   * because callers would think it's non-blocking, but it actually blocks.
   */
  private findCodeGraphCommand(): string | null {
    // Tier 1: Local node_modules binary
    if (this.projectPath) {
      const localBin = path.join(this.projectPath, 'node_modules', '.bin', 'codegraph');
      if (fs.existsSync(localBin)) {
        return localBin;
      }
    }

    // Tier 2: Global PATH
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const globalBin = execSync(`${whichCmd} codegraph`, {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      if (globalBin && fs.existsSync(globalBin)) {
        return globalBin;
      }
    } catch {
      // which/where not available or codegraph not in PATH
    }

    // Tier 2b: Windows-specific — check common install locations
    if (process.platform === 'win32') {
      const homeDir = process.env.USERPROFILE || '';
      const commonPaths = [
        path.join(homeDir, '.codegraph', 'bin', 'codegraph.exe'),
        path.join(homeDir, 'AppData', 'Local', 'codegraph', 'codegraph.exe'),
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
    }

    // Tier 2c: macOS/Linux — check common install locations
    if (process.platform !== 'win32') {
      const homeDir = process.env.HOME || '';
      const commonPaths = [
        path.join(homeDir, '.codegraph', 'bin', 'codegraph'),
        path.join(homeDir, '.local', 'bin', 'codegraph'),
        '/usr/local/bin/codegraph',
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
    }

    return null;
  }

  /** Check if the project has been initialized with CodeGraph */
  private isCodeGraphInitialized(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, '.codegraph'));
  }

  /**
   * Run a codegraph CLI subcommand and wait for it to complete.
   *
   * Captures stdout/stderr and resolves/rejects based on exit code.
   * Used for init, sync, index, etc. (synchronous operations, not MCP server).
   */
  private async runCliCommand(subcommand: string, args: string[] = []): Promise<void> {
    const codegraphPath = this.findCodeGraphCommand();
    if (!codegraphPath) {
      throw new Error(t('error.commandNotFound'));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(codegraphPath, [subcommand, ...args], {
        cwd: this.projectPath,
      });

      let stderr = '';

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || `Process exited with code ${code}`));
        }
      });

      child.on('error', (err: Error) => {
        reject(new Error(`Failed to run codegraph ${subcommand}: ${err.message}`));
      });
    });
  }

  /** Update FSM state and notify listeners + update status bar */
  private setState(state: CodeGraphState): void {
    this.state = state;
    this.updateStatusBar();
    this._onStateChange.fire(state);
  }

  /** Update the status bar item text/icon based on current state */
  private updateStatusBar(): void {
    switch (this.state) {
      case 'uninitialized':
        this.statusBarItem.text = '$(circle-outline) CodeGraph';
        this.statusBarItem.tooltip = t('statusBar.notInitialized');
        break;
      case 'installing':
        this.statusBarItem.text = '$(cloud-download) CodeGraph';
        this.statusBarItem.tooltip = t('install.installing');
        break;
      case 'indexing':
        this.statusBarItem.text = '$(sync~spin) CodeGraph';
        this.statusBarItem.tooltip = t('statusBar.indexing');
        break;
      case 'ready':
        this.statusBarItem.text = '$(check) CodeGraph';
        this.statusBarItem.tooltip = t('statusBar.ready');
        break;
      case 'error':
        this.statusBarItem.text = '$(error) CodeGraph';
        this.statusBarItem.tooltip = t('statusBar.error');
        break;
    }
  }

  /**
   * Show a context menu when the user clicks the status bar item.
   * Provides quick access to common actions based on current state.
   */
  private async showStatusMenu(): Promise<void> {
    const items: { item: vscode.QuickPickItem; action: () => void }[] = [];

    if (this.state === 'uninitialized') {
      items.push({
        item: { label: t('action.buildIndex'), iconPath: new vscode.ThemeIcon('add') },
        action: () => this.buildIndex(),
      });
    }

    if (this.state === 'ready') {
      items.push(
        { item: { label: t('action.reindex'), iconPath: new vscode.ThemeIcon('refresh') }, action: () => this.reindex() },
        { item: { label: t('action.deleteIndex'), iconPath: new vscode.ThemeIcon('trash') }, action: () => this.deleteIndex() },
        { item: { label: t('action.search'), iconPath: new vscode.ThemeIcon('search') }, action: () => vscode.commands.executeCommand('codegraph.searchSymbol') }
      );
    }

    if (this.state === 'error') {
      items.push({
        item: { label: t('action.retry'), iconPath: new vscode.ThemeIcon('refresh') },
        action: () => this.startCodeGraph(),
      });
    }

    const selection = await vscode.window.showQuickPick(items.map((i) => i.item));
    if (selection) {
      items.find((i) => i.item.label === selection.label)?.action();
    }
  }

  /**
   * Prompt the user to initialize CodeGraph when .codegraph/ is absent.
   *
   * We use InformationMessage (non-blocking) rather than Modal (blocking)
   * because the user may want to keep working without initializing.
   */
  private promptInitialize(): void {
    vscode.window
      .showInformationMessage(
        t('sidebar.notInitialized') + ' 是否立即建立索引？',
        t('confirm.yes'),
        t('confirm.cancel')
      )
      .then((selection) => {
        if (selection === t('confirm.yes')) {
          this.buildIndex();
        }
      });
  }
}
