import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
await build({ entryPoints: ['extensions/drupal/index.cjs'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'extensions/drupal/dist/index.cjs' });
const pkg = JSON.parse(readFileSync('extensions/drupal/package.json', 'utf8'));
const artifact = { format: 'codegraph-extension-1', package: pkg, files: { 'dist/index.cjs': readFileSync('extensions/drupal/dist/index.cjs', 'utf8') } };
mkdirSync('dist/extensions', { recursive: true });
writeFileSync('dist/extensions/drupal.cgext', JSON.stringify(artifact));
writeFileSync(`dist/extensions/drupal-${pkg.version}.cgext`, JSON.stringify(artifact));
// Historical bytes remain installable and reviewable after the source evolves.
copyFileSync('extensions/drupal/releases/drupal-0.1.0.cgext', 'dist/extensions/drupal-0.1.0.cgext');
console.log('Built official Drupal extension');
