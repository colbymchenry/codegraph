import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
await build({ entryPoints: ['extensions/drupal/index.cjs'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'extensions/drupal/dist/index.cjs' });
const pkg = JSON.parse(readFileSync('extensions/drupal/package.json', 'utf8'));
const artifact = { format: 'codegraph-extension-1', package: pkg, files: { 'dist/index.cjs': readFileSync('extensions/drupal/dist/index.cjs', 'utf8') } };
mkdirSync('dist/extensions', { recursive: true });
writeFileSync('dist/extensions/drupal.cgext', JSON.stringify(artifact));
console.log('Built official Drupal extension');
