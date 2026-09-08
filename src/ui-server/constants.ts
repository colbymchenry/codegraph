/**
 * User-facing constants for the `codegraph ui` server.
 *
 * Deliberately dependency-free so the CLI can import them for `--help` text
 * without pulling `node:http` (and the rest of the server) into every
 * invocation of every other subcommand. `ui-server/index.ts` re-exports them,
 * so consumers have one import to reach for.
 */

/** The port `codegraph ui` asks for first. */
export const DEFAULT_UI_PORT = 4747;

/** How many consecutive ports to try before giving up. */
export const DEFAULT_PORT_ATTEMPTS = 20;

/**
 * The only interface the server ever binds. Not configurable, on purpose: this
 * process serves the user's source code, and a `--host` flag is one typo away
 * from publishing it to the local network.
 */
export const LOOPBACK_ADDRESS = '127.0.0.1';

/**
 * Overrides which browser (if any) `codegraph ui` launches. `none` — or `0`,
 * `false`, `off`, or an empty value — suppresses the launch entirely, the same
 * as `--no-open`. Any other value is run as a command with the URL as its
 * single argument.
 */
export const BROWSER_ENV = 'CODEGRAPH_BROWSER';

/**
 * Development/test override for the directory served as the viewer. Point it at
 * a directory containing an `index.html` to serve something other than the
 * shipped build.
 */
export const VIEWER_PATH_ENV = 'CODEGRAPH_VIEWER_PATH';
