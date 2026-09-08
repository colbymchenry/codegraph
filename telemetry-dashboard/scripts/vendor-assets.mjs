#!/usr/bin/env node
/**
 * Copies third-party browser libraries out of node_modules into public/vendor/.
 *
 * Workers Static Assets are served verbatim — nothing in public/ goes through a
 * bundler — so a library from npm has to be physically present there. Keeping
 * it a copy step (rather than a checked-in blob or a CDN <script>) means the
 * version is pinned by package.json, there is no third-party origin at runtime,
 * and the CSP can stay `script-src 'self'`.
 *
 * public/vendor/ is gitignored; `npm run dev` and `npm run deploy` both run this
 * first, so it is always present and always matches the lockfile.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, 'public', 'vendor');

const FILES = [
  ['node_modules/chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['node_modules/chart.js/LICENSE.md', 'chart.js-LICENSE.md'],
];

mkdirSync(vendorDir, { recursive: true });

for (const [from, to] of FILES) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.error(`vendor-assets: missing ${from} — run \`npm install\` first`);
    process.exit(1);
  }
  copyFileSync(source, join(vendorDir, to));
}

console.log(`vendor-assets: copied ${FILES.length} file(s) into public/vendor/`);
