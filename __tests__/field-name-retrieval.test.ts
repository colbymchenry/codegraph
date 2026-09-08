/**
 * Multi-word FIELD-NAME query retrieval (#1196).
 *
 * A query bag of object-literal keys / API field names (`profileInfo
 * isTrialEligible quotaInfo billingMethod`) has no nodes of its own — the
 * definers are methods whose names contain each token at a camel-hump
 * boundary (`profileInfo` → `getProfileInfoV2`). Three compounding defects
 * made those definers unreachable:
 *   1. the CamelCase-boundary LIKE step title-cased interior humps
 *      (`profileInfo` → `Profileinfo`) and then compared case-SENSITIVELY,
 *      dropping every row SQLite's case-insensitive LIKE had just found;
 *   2. that step's kind whitelist held only type-like kinds, so on
 *      method-centric codebases it contributed nothing at all;
 *   3. explore's named-symbol seeding was exact-name only, so a field token
 *      seeded no files and the output budget went to unrelated neighbors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('field-name query retrieval (#1196)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1196-'));
    fs.mkdirSync(path.join(testDir, 'controller'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'service'), { recursive: true });

    fs.writeFileSync(
      path.join(testDir, 'controller', 'profileController.js'),
      `const billing = require('../service/billing');

class ProfileController {
  getProfileInfo(userId) {
    return { profileInfo: { id: userId }, isTrialEligible: this.checkTrialEligibility(userId) };
  }
  getProfileInfoV2(userId) {
    const quotaInfo = this.loadQuotaInfo(userId);
    return { profileInfo: { id: userId }, quotaInfo, billingMethod: billing.getBillingMethod(userId) };
  }
  checkTrialEligibility(userId) { return userId > 100; }
  loadQuotaInfo(userId) { return { used: 1, max: 10, userId }; }
}
module.exports = new ProfileController();
`
    );
    fs.writeFileSync(
      path.join(testDir, 'service', 'billing.js'),
      `function _getCustomerBillingMethods(userId) {
  return [{ type: 'card', userId }];
}
function getBillingMethod(userId) {
  return _getCustomerBillingMethods(userId)[0];
}
module.exports = { getBillingMethod };
`
    );
    // Noise files so the definers aren't the only content.
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(
        path.join(testDir, 'service', `noise${i}.js`),
        `function unrelatedHelper${i}() { return ${i}; }\nmodule.exports = { unrelatedHelper${i} };\n`
      );
    }

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('a bag of field-name tokens surfaces the files that DEFINE those fields', async () => {
    const res = await handler.execute('codegraph_explore', {
      query: 'profileInfo isTrialEligible quotaInfo billingMethod',
    });
    const text = res.content[0]!.text as string;

    // The two definer files the reporter saw entirely absent.
    expect(text).toContain('profileController.js');
    expect(text).toContain('billing.js');
    // The camel-infix definers themselves are shown.
    expect(text).toMatch(/getProfileInfo(V2)?/);
    expect(text).toContain('BillingMethod');
  });

  it('exact-name seeding still wins when the token IS a real symbol', async () => {
    // `getBillingMethod` names a real function — the fallback must not
    // dilute or replace exact seeding.
    const res = await handler.execute('codegraph_explore', { query: 'getBillingMethod' });
    const text = res.content[0]!.text as string;
    expect(text).toContain('billing.js');
    expect(text).toContain('getBillingMethod');
  });
});
