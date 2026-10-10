#!/usr/bin/env node
// Precompute index overrides using the same automatic policy as live decisions.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  records: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' },
} });
if (!values.records || !values.root || !values.output) {
  console.error('usage: node scripts/decide-offline.mjs --records decisions.jsonl --root <project> --output overrides.json');
  process.exit(2);
}
// Parse all records before sending any requests; malformed input must not spend money.
if (resolve(values.records) === resolve(values.output)) throw new Error('The output must differ from the records file.');
const records = readFileSync(values.records, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
if (!records.every(r => r && typeof r.point === 'string' && typeof r.key === 'string' && r.key
  && r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
  && r.heuristic && (r.heuristic.pick === null || typeof r.heuristic.pick === 'string'))) {
  throw new Error('Each record requires a point, key, payload and heuristic pick.');
}
const D = createRequire(import.meta.url)('../dist/decision/index.js');
process.env.CODEGRAPH_DECISIONS = 'auto';
D.resetDecisionConfig();
const overrides = {};
try {
  for (const rec of records) {
    if (!['A1', 'A2', 'A6'].includes(rec.point)) continue;
    const entry = await D.decideWithLedger(rec, { root: resolve(values.root) });
    if (entry?.applied) overrides[`${rec.point}|${rec.key}`] = entry.verdict;
  }
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(values.output, JSON.stringify(overrides) + '\n');
  console.log(`Wrote ${Object.keys(overrides).length} index overrides.`);
} finally { D.resetLive(); }
