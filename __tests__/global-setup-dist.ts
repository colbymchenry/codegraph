/**
 * Build what the suite reads from `dist/` when it is missing or older than
 * its sources (#1879).
 *
 * About thirty suites spawn `dist/bin/codegraph.js` (the MCP server, the CLI,
 * watchdogs), the parallel resolver loads its worker from `dist/`, and the
 * `codegraph ui` suites serve `dist/viewer/`. On a fresh checkout those suites
 * failed on spawn timeouts or a missing-viewer error that never pointed at the
 * build. After an edit without a rebuild they quietly exercised the old code
 * instead. Each half is rebuilt only when its own sources are newer.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

/** Why `output` must be rebuilt from `sourceDir`, or null when it is current. */
function staleReason(output: string, sourceDir: string): string | null {
  if (!fs.existsSync(output)) return 'missing';
  return newestMtime(path.join(ROOT, sourceDir)) > fs.statSync(output).mtimeMs ? `older than ${sourceDir}/` : null;
}

function build(what: string, reason: string, command: string): void {
  process.stderr.write(`[test setup] ${what} is ${reason}; running: ${command}\n`);
  execSync(command, { cwd: ROOT, stdio: 'inherit' });
}

export default function setup(): void {
  const engine = staleReason(path.join(ROOT, 'dist', 'bin', 'codegraph.js'), 'src');
  if (engine) build('dist/', engine, 'npx tsc && npm run copy-assets');
  // The viewer build checks the engine's copied grammars, so it runs second.
  const viewer = staleReason(path.join(ROOT, 'dist', 'viewer', 'index.html'), 'ui/src');
  if (viewer) build('dist/viewer/', viewer, 'npm run build:ui');
}
