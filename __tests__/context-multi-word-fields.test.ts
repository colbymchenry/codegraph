/**
 * Regression coverage for #1196 — multi-word field-name queries never
 * surfaced the defining files because three retrieval mechanisms were
 * dead on service-layer codebases (camel-infix definers are methods,
 * not classes):
 *
 *  1. The context builder's 5b CamelCase-boundary LIKE step used
 *     case-sensitive `indexOf` after lowercasing interior humps, so a
 *     titleCased token ("Profileinfo") never matched "getProfileInfoV2"
 *     in JS, and restricted kinds to declaration-only classes.
 *  2. The 5c compound-term step shared the same declaration-only kinds
 *     whitelist, so it contributed nothing on method-centric codebases.
 *  3. explore's named-symbol seeding was exact-name only — a field-name
 *     token (`profileInfo`) has no node of its own, so the seed was empty
 *     and weak FTS sub-token hits took the render budget instead.
 *
 * The mini-repo below models a service-layer JS codebase where every
 * camel-infix definer is a method, then asserts the previously-missing
 * methods surface for the field-name query.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('multi-word field-name queries surface defining files (#1196)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1196-'));

    // Service-layer JS: every "field" is a key on a response object built
    // inside a method whose name CONTAINS the field at a camel-hump
    // boundary. There are no class-level containers to fall back on.
    const controllerDir = path.join(testDir, 'controller');
    const serviceDir = path.join(testDir, 'service');
    fs.mkdirSync(controllerDir, { recursive: true });
    fs.mkdirSync(serviceDir, { recursive: true });

    fs.writeFileSync(
      path.join(controllerDir, 'profileController.js'),
      `function getProfileInfo(req, res) {
  res.json({ profileInfo: { name: req.user.name, isTrialEligible: true } });
}
function getProfileInfoV2(req, res) {
  res.json({ profileInfo: { name: req.user.name, isTrialEligible: false } });
}
module.exports = { getProfileInfo, getProfileInfoV2 };
`
    );

    fs.writeFileSync(
      path.join(serviceDir, 'billing.js'),
      `function _getCustomerBillingMethods(accountId) {
  return { billingMethod: 'card', quotaInfo: { used: 0 } };
}
module.exports = { _getCustomerBillingMethods };
`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.js'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('5b: case-insensitive CamelCase-boundary check recovers getProfileInfoV2 from a "profileInfo" token', async () => {
    // The defining file MUST surface — before the fix, the case-sensitive
    // `indexOf(titleCased)` after `titleCased.toLowerCase()` silently
    // dropped the match. (#1196 bug 1)
    const sg = await cg.findRelevantContext('profileInfo');
    const names = Array.from(sg.nodes.values()).map((n) => n.name);
    const files = Array.from(sg.nodes.values()).map((n) => n.filePath);
    expect(names).toContain('getProfileInfoV2');
    expect(files.some((f) => f.endsWith('profileController.js'))).toBe(true);
  });

  it('5b+5c: callable kinds (method/function) participate in CamelCase matching on a service-layer codebase', async () => {
    // Before the fix, the kind whitelist was class/interface/struct/... only,
    // so on a JS-only codebase 5b and 5c contributed zero results. (#1196 bug 2)
    const sg = await cg.findRelevantContext('billingMethod');
    const names = Array.from(sg.nodes.values()).map((n) => n.name);
    const files = Array.from(sg.nodes.values()).map((n) => n.filePath);
    expect(names).toContain('_getCustomerBillingMethods');
    expect(files.some((f) => f.endsWith('billing.js'))).toBe(true);
  });

  it('multi-word field query recovers BOTH defining methods (#1196 bug 3: named-symbol seeding)', async () => {
    // The original failure: a 4-token bag of business field names returned
    // 134 unrelated symbols across 26 files and never surfaced the two
    // defining methods. Assert the field-name tokens SEED the methods
    // that assemble them. (#1196 bug 3)
    const sg = await cg.findRelevantContext('profileInfo isTrialEligible quotaInfo billingMethod');
    const names = Array.from(sg.nodes.values()).map((n) => n.name);
    expect(names).toContain('getProfileInfoV2');
    expect(names).toContain('_getCustomerBillingMethods');
  });

  it('camel-infix boundary: a token at a true prefix or camel-hump boundary wins; a mid-word lowercase run does not', async () => {
    // Add a name that contains "profileinfo" as a MID-WORD LOWERCASE RUN
    // (no camel hump) and a name that contains it at a TRUE PREFIX boundary.
    // The first should NOT be a camel-infix hit; the second SHOULD.
    fs.writeFileSync(
      path.join(testDir, 'boundaries.js'),
      `function getProfileInfoByName() { return 1; }   // camel-hump boundary: matches
function reprofileinfoBogus() { return 1; }          // mid-word lowercase run: no boundary
module.exports = { getProfileInfoByName, reprofileinfoBogus };
`
    );
    await cg.sync();

    // Use a query that goes through the camel-infix fallback (no exact-name
    // node exists for "profileinfo") by adding the lowercase token after
    // a name that does match exactly.
    const sg = await cg.findRelevantContext('getProfileInfo profileinfo');
    const names = Array.from(sg.nodes.values()).map((n) => n.name);

    // True camel-hump boundary is reachable.
    expect(names).toContain('getProfileInfoByName');
    // Mid-word lowercase run is NOT — `reprofileinfo` in `reprofileinfoBogus`
    // has a lowercase char before it and a lowercase char at the boundary,
    // so the findCamelInfixCallables boundary filter drops it.
    expect(names).not.toContain('reprofileinfoBogus');
  });
});
