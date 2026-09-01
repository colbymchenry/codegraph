#!/usr/bin/env node
/**
 * Keep `@colbymchenry/codegraph-ui` on the engine's version number.
 *
 * The component package draws its screens from the engine's own JSON API, and
 * that API is versioned with the binary that serves it — a payload field can
 * appear or change shape in any engine release. So the two ship as one number:
 * `@colbymchenry/codegraph-ui@1.6.0` is the reader for `codegraph@1.6.0`, and a
 * host can pin them together without a compatibility table.
 *
 * This SYNCS rather than asserts, deliberately. The documented release flow is
 * "edit the version in package.json, run the Release workflow" — often as a
 * single-file edit in the GitHub web UI — and a check that failed the build
 * because a second file had not been edited would turn that into a two-step
 * dance for no gain. The same reasoning the workflow's package-lock sync step
 * already runs on.
 *
 * Idempotent: a re-run with the versions already equal writes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../package.json', import.meta.url));
const ui = fileURLToPath(new URL('../ui/package.json', import.meta.url));

const engineVersion = JSON.parse(readFileSync(root, 'utf8')).version;
const raw = readFileSync(ui, 'utf8');
const manifest = JSON.parse(raw);

if (manifest.version === engineVersion) {
  console.log(`[sync-ui-version] ui already at ${engineVersion}`);
  process.exit(0);
}

// A targeted replacement, not a re-serialise: rewriting the whole file would
// reformat a manifest a human maintains and bury the one-line change in noise.
const next = raw.replace(
  /("version"\s*:\s*)"[^"]*"/,
  (_match, prefix) => `${prefix}"${engineVersion}"`
);
if (next === raw) {
  console.error('[sync-ui-version] could not find a "version" field in ui/package.json');
  process.exit(1);
}
writeFileSync(ui, next);
console.log(`[sync-ui-version] ui ${manifest.version} -> ${engineVersion}`);
