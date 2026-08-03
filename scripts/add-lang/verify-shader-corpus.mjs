#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const expectedIndex = process.argv.indexOf('--expect-glsl');
const expectedGlsl = expectedIndex >= 0 ? Number(process.argv[expectedIndex + 1]) : null;
const shaderExts = new Set([
  '.glsl', '.vert', '.frag', '.comp', '.geom', '.tesc', '.tese', '.rgen', '.rmiss',
  '.rchit', '.rahit', '.rint', '.rcall', '.mesh', '.task', '.glslfx',
  '.hlsl', '.hlsli', '.fx', '.fxh',
]);
const glslExts = new Set([...shaderExts].filter((ext) => !['.hlsl', '.hlsli', '.fx', '.fxh'].includes(ext)));

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.codegraph' || entry.name === 'node_modules') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (shaderExts.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
  }
}
walk(root);

const grammars = await import(pathToFileURL(path.resolve('dist/extraction/grammars.js')).href);
const extraction = await import(pathToFileURL(path.resolve('dist/extraction/tree-sitter.js')).href);
await grammars.loadGrammarsForLanguages(['glsl', 'hlsl']);

const byExtension = {};
let filesErrored = 0;
let nodes = 0;
let edges = 0;
let refs = 0;
const failures = [];
for (const absolute of files) {
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  const extension = path.extname(relative).toLowerCase();
  byExtension[extension] = (byExtension[extension] || 0) + 1;
  const source = fs.readFileSync(absolute, 'utf8');
  const first = extraction.extractFromSource(relative, source);
  const second = extraction.extractFromSource(relative, source);
  const fatal = first.errors.filter((error) => error.severity === 'error');
  const stable =
    first.nodes.length === second.nodes.length &&
    first.edges.length === second.edges.length &&
    first.unresolvedReferences.length === second.unresolvedReferences.length &&
    first.nodes.map((node) => node.id).join('\0') === second.nodes.map((node) => node.id).join('\0');
  if (fatal.length > 0 || !stable) {
    filesErrored++;
    failures.push({ file: relative, errors: fatal.map((error) => error.message), stable });
  }
  nodes += first.nodes.length;
  edges += first.edges.length;
  refs += first.unresolvedReferences.length;
}

const firstPartyGlsl = files.filter((file) => {
  const relative = path.relative(root, file).replace(/\\/g, '/');
  return relative.startsWith('shaders/') && glslExts.has(path.extname(relative).toLowerCase());
}).length;
const summary = { root, files: files.length, firstPartyGlsl, filesErrored, nodes, edges, unresolvedReferences: refs, byExtension, failures };
console.log(JSON.stringify(summary, null, 2));
if (filesErrored > 0 || (expectedGlsl !== null && firstPartyGlsl !== expectedGlsl)) process.exit(1);
