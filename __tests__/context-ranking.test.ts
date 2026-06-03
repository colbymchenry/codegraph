/**
 * Context ranking: common-word precision + low-confidence handoff.
 *
 * Regression coverage for the failure where a prose query
 * ("capture intro onboarding screen flat object") surfaced an unrelated
 * constant named `FLAT` (in a download script) as a top entry point — because
 * the descriptive word "flat" exact-matched it and the +exact-name bonus was
 * exempt from single-term dampening. The fix: only distinctive identifiers earn
 * that exemption; an isolated common-word exact match is demoted, and a query
 * that resolves only to such weak matches is flagged low-confidence so the
 * response hands off to explore/trace instead of bluffing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { LOW_CONFIDENCE_MARKER } from '../src/context';
import { isDistinctiveIdentifier } from '../src/search/query-utils';

describe('isDistinctiveIdentifier', () => {
  it('treats plain dictionary words as non-distinctive', () => {
    for (const word of ['flat', 'object', 'screen', 'standing', 'capture']) {
      expect(isDistinctiveIdentifier(word)).toBe(false);
    }
  });

  it('treats leading-capital-only words (proper nouns / sentence start) as non-distinctive', () => {
    expect(isDistinctiveIdentifier('Screen')).toBe(false);
    expect(isDistinctiveIdentifier('Zustand')).toBe(false);
  });

  it('treats camelCase / PascalCase / snake_case / acronyms / digits as distinctive', () => {
    expect(isDistinctiveIdentifier('setLastEmail')).toBe(true);
    expect(isDistinctiveIdentifier('OrgUserStore')).toBe(true);
    expect(isDistinctiveIdentifier('user_store')).toBe(true);
    expect(isDistinctiveIdentifier('REST')).toBe(true);
    expect(isDistinctiveIdentifier('v2')).toBe(true);
  });
});

describe('Context ranking — common-word precision & confidence', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ctxrank-'));

    // The corroborated target: a capture-flow screen whose NAME alone matches
    // three query terms (capture + intro + screen), and which lives under a
    // matching directory.
    const captureDir = path.join(testDir, 'src', 'app', 'capture');
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(
      path.join(captureDir, 'intro.tsx'),
      `export function CaptureIntroScreen() {
  // Onboarding screen shown before the user selects flat or standing object capture.
  return null;
}
`
    );

    // The trap: an unrelated constant literally named FLAT, in a totally
    // different area. "flat" in a prose query exact-matches it.
    const scriptsDir = path.join(testDir, 'scripts', 'dataset');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, 'download.ts'),
      `export const FLAT = 'freiburg_flat_dataset';
export function downloadDataset(name: string): string { return name; }
`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('does not let a common-word exact match (FLAT) outrank a corroborated symbol', async () => {
    const sg = await cg.findRelevantContext(
      'capture intro onboarding screen flat object'
    );
    const rootNames = sg.roots.map((id) => sg.nodes.get(id)?.name);

    // The corroborated capture screen surfaces as an entry point...
    expect(rootNames).toContain('CaptureIntroScreen');
    // ...and the trap constant is never the lead result (the bug we fixed).
    expect(rootNames[0]).not.toBe('FLAT');

    const capIdx = rootNames.indexOf('CaptureIntroScreen');
    const flatIdx = rootNames.indexOf('FLAT');
    if (flatIdx >= 0) expect(capIdx).toBeLessThan(flatIdx);

    // And it's confidently answered (we located a corroborated symbol).
    expect(sg.confidence).toBe('high');
  });

  it('flags low confidence and emits the handoff when only common words match', async () => {
    const query = 'flat object thing';
    const sg = await cg.findRelevantContext(query);
    expect(sg.confidence).toBe('low');

    const md = await cg.buildContext(query, { format: 'markdown' });
    expect(typeof md).toBe('string');
    expect(md as string).toContain(LOW_CONFIDENCE_MARKER);
    // The handoff routes to the precise tools rather than claiming completeness.
    expect(md as string).toMatch(/codegraph_explore/);
  });

  it('does not emit the handoff for a precise, distinctive-symbol query', async () => {
    const sg = await cg.findRelevantContext('CaptureIntroScreen');
    expect(sg.confidence).toBe('high');

    const md = await cg.buildContext('CaptureIntroScreen', { format: 'markdown' });
    expect(md as string).not.toContain(LOW_CONFIDENCE_MARKER);
  });
});
