/**
 * A Rust module file is test code when its parent declares it under a test
 * `cfg` — `#[cfg(test)] mod tests;` loading `tests.rs` or `tests/mod.rs` (#3265).
 */
import { describe, it, expect } from 'vitest';
import { inCfgTestFile } from '../src/graph/test-code';

const reader = (files: Record<string, string>) => (p: string): string | undefined => files[p];

describe('inCfgTestFile', () => {
  it('reads the parent of name.rs and name/mod.rs alike', () => {
    const read = reader({ 'src/store.rs': 'pub fn a() {}\n\n#[cfg(test)]\nmod tests;\n' });
    expect(inCfgTestFile('src/store/tests.rs', read)).toBe(true);
    expect(inCfgTestFile('src/store/tests/mod.rs', read)).toBe(true);
  });

  it('reads a mod.rs or crate-root parent', () => {
    expect(inCfgTestFile('src/store/tests.rs', reader({ 'src/store/mod.rs': '#[cfg(test)]\n#[allow(unused)]\npub(crate) mod tests;\n' }))).toBe(true);
    expect(inCfgTestFile('src/tests.rs', reader({ 'src/lib.rs': '#[cfg(all(test, feature = "x"))]\nmod tests;\n' }))).toBe(true);
  });

  it('follows a plain module down from a test module file', () => {
    const read = reader({
      'src/store.rs': '#[cfg(test)]\nmod tests;\n',
      'src/store/tests/mod.rs': 'mod fixtures;\n',
    });
    expect(inCfgTestFile('src/store/tests/fixtures.rs', read)).toBe(true);
  });

  it('is not fooled by a plain, a not(test), or a nested declaration', () => {
    expect(inCfgTestFile('src/store/tests.rs', reader({ 'src/store.rs': 'mod tests;\n' }))).toBe(false);
    expect(inCfgTestFile('src/store/real.rs', reader({ 'src/store.rs': '#[cfg(not(test))]\nmod real;\n' }))).toBe(false);
    expect(inCfgTestFile('src/store/tests.rs', reader({ 'src/store.rs': 'mod inner {\n    #[cfg(test)]\n    mod tests;\n}\n' }))).toBe(false);
    expect(inCfgTestFile('src/store/other.rs', reader({ 'src/store.rs': '#[cfg(test)]\nmod tests;\nmod other;\n' }))).toBe(false);
    expect(inCfgTestFile('src/lib.rs', reader({}))).toBe(false);
  });
});
