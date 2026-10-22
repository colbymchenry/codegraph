/**
 * Node's built-in `node:sqlite`, loaded in one place, so that a runtime
 * without it fails with the one explanation that fits it: CodeGraph needs
 * Node.js 22.5+, or its own bundled runtime. Any other failure to open a
 * database is SQLite's own, and is reported as such (see ./open-error.ts).
 */

/** The parts of `node:sqlite` CodeGraph uses. */
export interface NodeSqliteModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => any;
}

/** `node:sqlite` is missing or could not be loaded in this Node.js runtime. */
export class NodeSqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Node.js ${process.version} could not load its built-in SQLite module (${reason}).\n` +
        'CodeGraph requires node:sqlite (Node.js 22.5+). Install the self-contained CodeGraph ' +
        'release (it bundles a compatible Node), or run on Node 22.5+.',
      { cause }
    );
    this.name = 'NodeSqliteUnavailableError';
  }
}

/** Load `node:sqlite`, or throw {@link NodeSqliteUnavailableError}. */
export function loadNodeSqlite(): NodeSqliteModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as NodeSqliteModule;
  } catch (err) {
    throw new NodeSqliteUnavailableError(err);
  }
}
