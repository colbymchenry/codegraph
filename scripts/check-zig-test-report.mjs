#!/usr/bin/env node
/** Enforce the declared Zig runtime denominator; skipped/todo tests cannot pass. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

assert.ok(process.argv[2], 'Usage: node scripts/check-zig-test-report.mjs <vitest-json-report>');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const suites = [
  'zig-extraction.test.ts', 'zig-production.test.ts', 'zig-static-semantics.test.ts',
  'zig-instance-fields.test.ts', 'zig-acceptance.test.ts',
];
assert.equal(report.success, true, 'Vitest did not complete successfully');
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0, 'Skipped tests are not acceptance');
assert.equal(report.numTodoTests, 0, 'Todo tests are not acceptance');
assert.ok(report.numTotalTests >= 125, 'The declared 125-test runtime contract is incomplete');
assert.equal(report.numPassedTests, report.numTotalTests);
const actual = report.testResults.map(s => path.basename(s.name.replaceAll('\\', '/')));
assert.deepEqual(actual.sort(), suites.sort(), 'Required Zig suite missing or duplicated');
for (const suite of report.testResults) {
  assert.equal(suite.status, 'passed', suite.name);
  assert.ok(suite.assertionResults.length > 0, `Empty suite: ${suite.name}`);
  for (const test of suite.assertionResults) assert.equal(test.status, 'passed', test.fullName);
}
console.log(JSON.stringify({ gate: 'zig-runtime-contract', passed: report.numPassedTests, skipped: 0, suites: suites.length }));
