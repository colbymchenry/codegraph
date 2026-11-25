/**
 * Grammar preload set for a file list (#1628).
 *
 * Path-only detection calls every `.h` file C, but parse-time detection reads
 * the source and can reclassify it as C++ or Objective-C. Workers only ever
 * receive the grammars named by this set, so a header that turns out to be
 * Objective-C in a project with no `.m` file had no parser to go to and the
 * file failed outright with `Failed to get parser for language: objc`.
 */

import { describe, it, expect } from 'vitest';
import { preloadLanguagesForFiles } from '../src/extraction';

describe('grammar preload set (#1628)', () => {
  it('covers both ambiguous readings of a .h file, C++ and Objective-C', () => {
    const langs = preloadLanguagesForFiles(['repro.h']);
    // Path-only detection says C…
    expect(langs).toContain('c');
    // …and parse-time detection may say either of these instead.
    expect(langs).toContain('cpp');
    expect(langs).toContain('objc');
  });

  it('adds nothing for a project with no C-family headers', () => {
    const langs = preloadLanguagesForFiles(['a.ts', 'b.py']);
    expect(langs).not.toContain('c');
    expect(langs).not.toContain('cpp');
    expect(langs).not.toContain('objc');
  });

  it('does not duplicate a language the files already need', () => {
    const langs = preloadLanguagesForFiles(['repro.h', 'seed.m', 'other.cpp']);
    expect(langs.filter((l) => l === 'objc')).toHaveLength(1);
    expect(langs.filter((l) => l === 'cpp')).toHaveLength(1);
  });

  it('honors extension overrides when detecting the base set', () => {
    const langs = preloadLanguagesForFiles(['weird.frob'], { '.frob': 'python' });
    expect(langs).toContain('python');
  });
});
