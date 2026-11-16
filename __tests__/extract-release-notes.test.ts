/**
 * Unit tests for `scripts/extract-release-notes.mjs`.
 *
 * The script reads CHANGELOG.md from `process.cwd()`, so the tests run it
 * via `node` in a temp directory, the way the Release workflow does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'extract-release-notes.mjs');
// GitHub refuses a release body over 125,000 characters; the script keeps to
// 120,000 UTF-8 bytes.
const MAX_BODY_BYTES = 120_000;

function setup(changelog: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-release-notes-'));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function run(cwd: string, version: string) {
  return execFileSync('node', [SCRIPT, version], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  });
}

function entries(prefix: string, count: number, length: number) {
  return Array.from({ length: count }, (_, i) => `- ${prefix} ${i + 1}: ${'x'.repeat(length)}`);
}

describe('extract-release-notes.mjs', () => {
  let dir: string;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints a short block whole, with hard-wrapped bullets joined', () => {
    dir = setup(
      '# Changelog\n\n## [1.2.3] - 2026-01-02\n\n### Fixes\n\n- One fix that is\n  hard-wrapped.\n- Another fix.\n\n## [1.2.2] - 2026-01-01\n\n- Old.\n',
    );
    expect(run(dir, '1.2.3')).toBe(
      '## [1.2.3] - 2026-01-02\n\n### Fixes\n\n- One fix that is hard-wrapped.\n- Another fix.\n\n',
    );
  });

  it('cuts a block too long for a GitHub release before the first entry that does not fit', () => {
    const fixes = entries('Fix', 300, 500);
    dir = setup(`# Changelog\n\n## [1.2.3] - 2026-01-02\n\n### Fixes\n\n${fixes.join('\n')}\n`);
    const out = run(dir, '1.2.3');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);

    const lines = out.trimEnd().split('\n');
    const kept = lines.filter((line) => line.startsWith('- '));
    // Every entry shown is whole, and they are the first ones, in order.
    expect(kept).toEqual(fixes.slice(0, kept.length));
    expect(kept.length).toBeGreaterThan(200);
    expect(lines[lines.length - 1]).toBe(
      `_…and ${fixes.length - kept.length} more entries: the full list is in ` +
        '[CHANGELOG.md](https://github.com/owner/repo/blob/v1.2.3/CHANGELOG.md)._',
    );
  });

  it('drops a heading the cut would leave with nothing under it', () => {
    // The features fill about 118,000 bytes and the first fix doesn't fit after them.
    const features = entries('Feature', 229, 500);
    const fixes = entries('Fix', 50, 5000);
    dir = setup(
      `# Changelog\n\n## [1.2.3] - 2026-01-02\n\n### New Features\n\n${features.join('\n')}\n\n### Fixes\n\n${fixes.join('\n')}\n`,
    );
    const out = run(dir, '1.2.3');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(out).toContain(features[features.length - 1]);
    expect(out).not.toContain('### Fixes');
    expect(out.trimEnd().split('\n').pop()).toMatch(/^_…and 50 more entries: /);
  });

  it('points an Unreleased block at CHANGELOG.md on main', () => {
    dir = setup(`# Changelog\n\n## [Unreleased]\n\n${entries('Fix', 300, 500).join('\n')}\n`);
    expect(run(dir, 'Unreleased')).toContain(
      '(https://github.com/owner/repo/blob/main/CHANGELOG.md)',
    );
  });
});
