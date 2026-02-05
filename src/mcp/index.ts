/**
 * CodeGraph MCP Server
 *
 * Model Context Protocol server that exposes CodeGraph functionality
 * as tools for AI assistants like Claude.
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'codegraph';
 *
 * const server = new MCPServer('/path/to/project');
 * await server.start();
 * ```
 */

import CodeGraph from '../index';
import { StdioTransport, JsonRpcRequest, JsonRpcNotification, ErrorCodes } from './transport';
import { tools, ToolHandler } from './tools';

/**
 * MCP Server Info
 */
const SERVER_INFO = {
  name: 'codegraph',
  version: '0.1.0',
};

/**
 * MCP Protocol Version
 */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * MCP Server for CodeGraph
 *
 * Implements the Model Context Protocol to expose CodeGraph
 * functionality as tools that can be called by AI assistants.
 */
export class MCPServer {
  private transport: StdioTransport;
  private cg: CodeGraph | null = null;
  private toolHandler: ToolHandler | null = null;
  private projectPath: string | null;
  private initError: string | null = null;

  constructor(projectPath?: string) {
    this.projectPath = projectPath || null;
    this.transport = new StdioTransport();
  }

  /**
   * Start the MCP server
   *
   * Note: CodeGraph initialization is deferred until the initialize request
   * is received, which includes the rootUri from the client.
   */
  async start(): Promise<void> {
    // Start listening for messages immediately - don't check initialization yet
    // We'll get the project path from the initialize request's rootUri
    this.transport.start(this.handleMessage.bind(this));

    // Keep the process running
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * Initialize CodeGraph for the project
   */
  private async initializeCodeGraph(projectPath: string): Promise<void> {
    this.projectPath = projectPath;

    if (!CodeGraph.isInitialized(projectPath)) {
      this.initError = `CodeGraph not initialized in ${projectPath}. Run 'codegraph init' first.`;
      return;
    }

    try {
      this.cg = await CodeGraph.open(projectPath);
      this.toolHandler = new ToolHandler(this.cg);
      this.initError = null;
    } catch (err) {
      this.initError = `Failed to open CodeGraph: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Stop the server
   */
  stop(): void {
    try {
      if (this.cg) {
        this.cg.close();
        this.cg = null;
      }
    } finally {
      this.transport.stop();
      process.exit(0);
    }
  }

  /**
   * Handle incoming JSON-RPC messages
   */
  private async handleMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    // Check if it's a request (has id) or notification (no id)
    const isRequest = 'id' in message;

    switch (message.method) {
      case 'initialize':
        if (isRequest) {
          await this.handleInitialize(message as JsonRpcRequest);
        }
        break;

      case 'initialized':
        // Notification that client has finished initialization
        // No action needed - the client is ready
        break;

      case 'tools/list':
        if (isRequest) {
          await this.handleToolsList(message as JsonRpcRequest);
        }
        break;

      case 'tools/call':
        if (isRequest) {
          await this.handleToolsCall(message as JsonRpcRequest);
        }
        break;

      case 'ping':
        if (isRequest) {
          this.transport.sendResult((message as JsonRpcRequest).id, {});
        }
        break;

      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`
          );
        }
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      rootUri?: string;
      workspaceFolders?: Array<{ uri: string; name: string }>;
    } | undefined;

    // Extract project path from rootUri or workspaceFolders
    let projectPath = this.projectPath;

    if (params?.rootUri) {
      // Convert file:// URI to path
      projectPath = params.rootUri.replace(/^file:\/\//, '');
    } else if (params?.workspaceFolders?.[0]?.uri) {
      projectPath = params.workspaceFolders[0].uri.replace(/^file:\/\//, '');
    }

    // Fall back to current working directory if no path provided
    if (!projectPath) {
      projectPath = process.cwd();
    }

    // Initialize CodeGraph if we have a project path
    await this.initializeCodeGraph(projectPath);

    // We accept the client's protocol version but respond with our supported version
    this.transport.sendResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    });
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(request: JsonRpcRequest): Promise<void> {
    this.transport.sendResult(request.id, {
      tools: tools,
    });
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    if (!params || !params.name) {
      this.transport.sendError(
        request.id,
        ErrorCodes.InvalidParams,
        'Missing tool name'
      );
      return;
    }

    const toolName = params.name;
    const toolArgs = params.arguments || {};

    // Validate tool exists
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      this.transport.sendError(
        request.id,
        ErrorCodes.InvalidParams,
        `Unknown tool: ${toolName}`
      );
      return;
    }

    // Execute the tool
    if (!this.toolHandler) {
      const errorMsg = this.initError ||
        (this.projectPath
          ? `CodeGraph not initialized in ${this.projectPath}. Run 'codegraph init' first.`
          : 'No project path provided. Ensure Claude Code is running in a project directory.');
      this.transport.sendError(
        request.id,
        ErrorCodes.InternalError,
        errorMsg
      );
      return;
    }

    const result = await this.toolHandler.execute(toolName, toolArgs);

    this.transport.sendResult(request.id, result);
  }
}

// Export for use in CLI
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
