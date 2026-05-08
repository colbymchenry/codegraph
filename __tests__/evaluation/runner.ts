import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../../src/index.js';
import { scoreSearchNodes, scoreFindRelevantContext } from './scoring.js';
import { testCases } from './test-cases.js';
import type { EvalReport, EvalResult } from './types.js';

const codebasePath = process.env.EVAL_CODEBASE || process.argv[2];
if (!codebasePath) {
  console.error('Usage: EVAL_CODEBASE=/path/to/codebase npx tsx __tests__/evaluation/runner.ts');
  console.error('   or: npx tsx __tests__/evaluation/runner.ts /path/to/codebase');
  process.exit(1);
}

const resolvedPath = path.resolve(codebasePath);
if (!fs.existsSync(path.join(resolvedPath, '.codegraph', 'codegraph.db'))) {
  console.error(`No .codegraph/codegraph.db found at ${resolvedPath}`);
  process.exit(1);
}

let codegraphSha = 'unknown';
try {
  codegraphSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}

console.log(`\nCodeGraph Eval — ${path.basename(resolvedPath)}`);
console.log(`Codebase: ${resolvedPath}`);
console.log(`Commit:   ${codegraphSha}`);
console.log(`Cases:    ${testCases.length}`);
console.log('');

async function run() {
  const cg = CodeGraph.openSync(resolvedPath);
  const results: EvalResult[] = [];

  for (const tc of testCases) {
    const start = performance.now();

    if (tc.api === 'searchNodes') {
      const searchResults = cg.searchNodes(tc.query, {
        limit: 10,
        kinds: tc.kinds,
        ...(tc.options as Record<string, unknown>),
      });
      const latency = performance.now() - start;
      const result = scoreSearchNodes(tc.id, tc.expectedSymbols, searchResults, latency);
      results.push(result);
    } else {
      const subgraph = await cg.findRelevantContext(tc.query, {
        searchLimit: 8,
        traversalDepth: 3,
        maxNodes: 80,
        minScore: 0.2,
        ...(tc.options as Record<string, unknown>),
      });
      const latency = performance.now() - start;
      const result = scoreFindRelevantContext(tc.id, tc.expectedSymbols, subgraph, latency);
      results.push(result);
    }
  }

  cg.close();

  // Print results table
  const maxIdLen = Math.max(...results.map((r) => r.caseId.length));

  for (const r of results) {
    const status = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const id = r.caseId.padEnd(maxIdLen);
    const recall = `recall=${r.recall.toFixed(2)}`;
    const extra =
      r.edgeDensity !== undefined
        ? `density=${r.edgeDensity.toFixed(2)}`
        : `mrr=${r.mrr.toFixed(2)}`;
    const latency = `${Math.round(r.latencyMs)}ms`;

    console.log(`  ${id}  ${status}  ${recall}  ${extra}  ${latency}`);

    if (r.missedSymbols.length > 0) {
      console.log(`  ${' '.repeat(maxIdLen)}        missed: ${r.missedSymbols.join(', ')}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const meanRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const mrrResults = results.filter((r) => r.mrr > 0 || r.caseId.startsWith('search-'));
  const meanMRR =
    mrrResults.length > 0 ? mrrResults.reduce((s, r) => s + r.mrr, 0) / mrrResults.length : 0;

  console.log('');
  const summaryColor = failed === 0 ? '\x1b[32m' : '\x1b[33m';
  console.log(
    `${summaryColor}SUMMARY: ${passed}/${results.length} passed | recall=${meanRecall.toFixed(2)} | mrr=${meanMRR.toFixed(2)}\x1b[0m`
  );

  // Save JSON report
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    codebasePath: resolvedPath,
    codegraphSha,
    summary: { total: results.length, passed, failed, meanRecall, meanMRR },
    results,
  };

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportFile = path.join(
    resultsDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportFile}`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
