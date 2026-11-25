/**
 * A parse worker in a project with no framework has no use for the framework
 * resolvers, which bring most of the resolver with them. vitest swaps
 * `src/extraction/lazy-frameworks.ts` for an eager stand-in, so this reads what
 * the built worker loads.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const dist = path.resolve(__dirname, '../dist');

/** The dist modules a thread has loaded after running `code`. */
function loaded(code: string): string[] {
  const script = `
    const { extractFromSource } = require(${JSON.stringify(path.join(dist, 'extraction/tree-sitter.js'))});
    ${code}
    console.log(JSON.stringify(Object.keys(require.cache)));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], { encoding: 'utf8' });
  expect(res.status, res.stderr).toBe(0);
  return (JSON.parse(res.stdout) as string[]).map((f) => path.relative(dist, f).split(path.sep).join('/'));
}

describe('framework resolvers in extraction', () => {
  it('are not loaded for a file no framework reads', () => {
    const modules = loaded('extractFromSource("a.yaml", "a: 1", "yaml");');
    expect(modules).not.toContain('resolution/frameworks/index.js');
    expect(modules).not.toContain('resolution/name-matcher.js');
  });

  it('are loaded for a file a framework reads, and read it', () => {
    const modules = loaded(`
      const result = extractFromSource('app.yaml', 'a: 1', 'yaml', ['express']);
      if (!result) process.exit(1);
    `);
    expect(modules).toContain('resolution/frameworks/index.js');
  });
});
