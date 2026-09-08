/**
 * Progress reporting for the callback-edge synthesis tail.
 *
 * Synthesis runs AFTER the resolution bar reaches 100%, so before this it had
 * no progress surface at all — on synthesizer-heavy repos (e.g. large C
 * codebases hitting the fn-pointer pass) the CLI sat frozen at
 * "Resolving refs 100%" long enough that users concluded the index hung and
 * killed it. These tests pin (a) that indexing emits the dedicated 'linking'
 * phase with monotonic per-pass progress, and (b) that the advertised step
 * total stays in sync with the synthesizer's actual pass list.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, IndexProgress } from '../src/index';
import { SYNTH_PASSES, SYNTH_PROGRESS_STEPS } from '../src/resolution/callback-synthesizer';

describe('synthesis progress ("Linking dynamic dispatch" phase)', () => {
  it('SYNTH_PROGRESS_STEPS matches the synthesizer’s actual step count', () => {
    // The constant is cosmetic (progress denominator), but drift makes the bar
    // end early or jump to 100%. Steps = one per SYNTH_PASSES registry entry
    // (each marks exactly once, run or gated-out, sequential or pooled) plus
    // the fixed literal __mark('<label>') sites (the ordered Go pre-passes and
    // the merge/insert tail). Adding a pass = adding a registry entry, so the
    // constant tracks automatically; this pins the fixed-site count.
    const src = fs.readFileSync(
      path.join(__dirname, '../src/resolution/callback-synthesizer.ts'),
      'utf8'
    );
    const fixedSites = (src.match(/__mark\('/g) ?? []).length;
    expect(SYNTH_PROGRESS_STEPS).toBe(SYNTH_PASSES.length + fixedSites);
  });

  it('indexing emits a monotonic linking phase ending at the full step count', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-progress-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper() { return 1; }\n');
      fs.writeFileSync(
        path.join(dir, 'b.ts'),
        "import { helper } from './a';\nexport function main() { return helper(); }\n"
      );

      const events: IndexProgress[] = [];
      const cg = await CodeGraph.init(dir, {
        index: true,
        onProgress: (p) => events.push(p),
      });
      await cg.close();

      const linking = events.filter((e) => e.phase === 'linking');
      expect(linking.length).toBeGreaterThan(0);
      // Emitted up-front so the phase label flips as soon as synthesis starts…
      expect(linking[0]!.current).toBe(0);
      // …and every step reports against the same total, monotonically.
      expect(linking.every((e) => e.total === SYNTH_PROGRESS_STEPS)).toBe(true);
      for (let i = 1; i < linking.length; i++) {
        expect(linking[i]!.current).toBeGreaterThanOrEqual(linking[i - 1]!.current);
      }
      expect(linking[linking.length - 1]!.current).toBe(SYNTH_PROGRESS_STEPS);

      // The linking phase comes after resolution has finished.
      const lastResolving = events.map((e) => e.phase).lastIndexOf('resolving');
      const firstLinking = events.map((e) => e.phase).indexOf('linking');
      expect(firstLinking).toBeGreaterThan(lastResolving);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
