#!/usr/bin/env node
// Where the time goes for one benchmark case: the lines with the most CPU samples, over every
// thread of the run. A line of the engine is printed with its text from the build; a line
// outside the engine is named by its file, so time inside the parser itself
// (tree-sitter.wasm, the native kernel) shows as such and is not mistaken for the engine's.
// See docs/design/large-file-performance.md.
//
//   node scripts/benchmarks/large-files/profile.mjs <kernel-languages|other-languages> <built engine: dist> <megabytes> <the harness's own arguments…>
//   node scripts/benchmarks/large-files/profile.mjs other-languages dist 1.2 express/inline
//   node scripts/benchmarks/large-files/profile.mjs kernel-languages dist 1.2 python table
//
// Profile at a size where the case takes some seconds: the line that grows with the square
// of the file is then most of the samples. PROFILE_LINES=<n> prints more than 14 lines.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [harness, distArg, ...rest] = process.argv.slice(2);
if (!['kernel-languages', 'other-languages'].includes(harness) || !distArg || rest.length < 2) {
  console.error('usage: profile.mjs <kernel-languages|other-languages> <built engine: dist> <megabytes> <case arguments…>');
  process.exit(2);
}
const dist = resolve(distArg);
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cg-profile-'));
const run = spawnSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${dir}`, join(here, `${harness}.mjs`), dist, ...rest], { encoding: 'utf8' });
process.stdout.write(run.stdout.split('\n').filter((line) => / s  /.test(line)).join('\n') + '\n');

const samples = new Map();
for (const file of readdirSync(dir).filter((name) => name.endsWith('.cpuprofile'))) {
  const profile = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
  const interval = total / Math.max(1, profile.samples.length);
  for (const node of profile.nodes) {
    const url = node.callFrame.url.replace(/\\/g, '/');
    if (!url) continue;
    const where = url.includes('/dist/') ? url.split('/dist/')[1] : url.split('/').pop();
    for (const tick of node.positionTicks ?? []) {
      const key = `${where}:${tick.line} (${node.callFrame.functionName || 'anonymous'})`;
      samples.set(key, (samples.get(key) ?? 0) + tick.ticks * interval);
    }
  }
}
rmSync(dir, { recursive: true, force: true });

for (const [key, micros] of [...samples].sort((a, b) => b[1] - a[1]).slice(0, +(process.env.PROFILE_LINES ?? 14))) {
  const [file, tail] = key.split(/:(?=\d)/);
  let text = '';
  try {
    text = readFileSync(join(dist, file), 'utf8').split('\n')[+tail.split(' ')[0] - 1].trim().slice(0, 110);
  } catch {
    // Not a file of the build: a line of Node's, or a function inside the parser.
  }
  console.log(`  ${(micros / 1e6).toFixed(2).padStart(6)} s  ${key}${text ? `\n            ${text}` : ''}`);
}
