/**
 * CodeGraph Error Classes
 *
 * Custom error types for better error handling and debugging.
 *
 * @module errors
 *
 * @example
 * ```typescript
 * import { FileError, ParseError, setLogger, silentLogger } from 'codegraph';
 *
 * // Catch specific error types
 * try {
 *   await cg.indexAll();
 * } catch (error) {
 *   if (error instanceof FileError) {
 *     console.log(`File error at ${error.filePath}: ${error.message}`);
 *   } else if (error instanceof ParseError) {
 *     console.log(`Parse error at ${error.filePath}:${error.line}`);
 *   }
 * }
 *
 * // Disable logging for tests
 * setLogger(silentLogger);
 * ```
 */

/**
 * Base error class for all CodeGraph errors.
 *
 * All CodeGraph-specific errors extend this class, allowing you to catch
 * all CodeGraph errors with a single catch block.
 *
 * @example
 * ```typescript
 * try {
 *   await cg.indexAll();
 * } catch (error) {
 *   if (error instanceof CodeGraphError) {
 *     console.log(`CodeGraph error [${error.code}]: ${error.message}`);
 *   }
 * }
 * ```
 */
export class CodeGraphError extends Error {
  /** Error code for categorization (e.g., 'FILE_ERROR', 'PARSE_ERROR') */
  readonly code: string;
  /** Additional context about the error */
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'CodeGraphError';
    this.code = code;
    this.context = context;

    // Maintain proper stack trace for V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error reading or accessing files
 */
export class FileError extends CodeGraphError {
  readonly filePath: string;

  constructor(message: string, filePath: string, cause?: Error) {
    super(message, 'FILE_ERROR', { filePath, cause: cause?.message });
    this.name = 'FileError';
    this.filePath = filePath;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error parsing source code
 */
export class ParseError extends CodeGraphError {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;

  constructor(
    message: string,
    filePath: string,
    options?: { line?: number; column?: number; cause?: Error }
  ) {
    super(message, 'PARSE_ERROR', {
      filePath,
      line: options?.line,
      column: options?.column,
      cause: options?.cause?.message,
    });
    this.name = 'ParseError';
    this.filePath = filePath;
    this.line = options?.line;
    this.column = options?.column;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Error with database operations
 */
export class DatabaseError extends CodeGraphError {
  readonly operation: string;

  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', { operation, cause: cause?.message });
    this.name = 'DatabaseError';
    this.operation = operation;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error with search operations
 */
export class SearchError extends CodeGraphError {
  readonly query: string;

  constructor(message: string, query: string, cause?: Error) {
    super(message, 'SEARCH_ERROR', { query, cause: cause?.message });
    this.name = 'SearchError';
    this.query = query;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error with vector/embedding operations
 */
export class VectorError extends CodeGraphError {
  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'VECTOR_ERROR', { operation, cause: cause?.message });
    this.name = 'VectorError';
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error with configuration
 */
export class ConfigError extends CodeGraphError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

/**
 * Simple logger for CodeGraph operations
 *
 * By default, logs to console.warn for warnings and console.error for errors.
 * Can be configured to use custom logging.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console-based logger
 */
export const defaultLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.CODEGRAPH_DEBUG) {
      console.debug(`[CodeGraph] ${message}`, context ?? '');
    }
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[CodeGraph] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[CodeGraph] ${message}`, context ?? '');
  },
};

/**
 * Silent logger (no output) - useful for tests
 */
export const silentLogger: Logger = {
  debug(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * Current logger instance (can be replaced)
 */
let currentLogger: Logger = defaultLogger;

/**
 * Set the global logger
 */
export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

/**
 * Get the current logger
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Log a debug message
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  currentLogger.debug(message, context);
}

/**
 * Log a warning message
 */
export function logWarn(message: string, context?: Record<string, unknown>): void {
  currentLogger.warn(message, context);
}

/**
 * Log an error message
 */
export function logError(message: string, context?: Record<string, unknown>): void {
  currentLogger.error(message, context);
}
