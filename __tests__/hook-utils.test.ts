import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripMarkerBlock, isEffectivelyEmpty, chmodExecutable } from '../src/sync/hook-utils';

const BEGIN = '# >>> codegraph test >>>';
const END   = '# <<< codegraph test <<<';

describe('stripMarkerBlock', () => {
  it('removes block between markers and preserves surrounding content', () => {
    const content = `line before\n${BEGIN}\ninner line\n${END}\nline after`;
    expect(stripMarkerBlock(content, BEGIN, END)).toBe('line before\nline after');
  });

  it('returns content unchanged when no markers present', () => {
    const content = 'no markers here\njust lines';
    expect(stripMarkerBlock(content, BEGIN, END)).toBe(content);
  });

  it('strips only the specified markers, leaving other marker strings untouched', () => {
    const otherBegin = '# >>> other >>>';
    const otherEnd   = '# <<< other <<<';
    const content = [
      'keep',
      BEGIN, 'codegraph block', END,
      'also keep',
      otherBegin, 'other content', otherEnd,
      'end',
    ].join('\n');
    const result = stripMarkerBlock(content, otherBegin, otherEnd);
    expect(result).toContain(BEGIN);
    expect(result).toContain('codegraph block');
    expect(result).not.toContain('other content');
    expect(result).not.toContain(otherBegin);
  });

  it('strips from begin marker to EOF when end marker is absent', () => {
    const content = `before\n${BEGIN}\ninner`;
    expect(stripMarkerBlock(content, BEGIN, END)).toBe('before');
  });

  it('returns content unchanged when end marker is present but begin is absent', () => {
    const content = `before\n${END}\nafter`;
    expect(stripMarkerBlock(content, BEGIN, END)).toBe(content);
  });

  it('is idempotent: calling twice produces the same result as calling once', () => {
    const content = `a\n${BEGIN}\nb\n${END}\nc`;
    const once  = stripMarkerBlock(content, BEGIN, END);
    const twice = stripMarkerBlock(once, BEGIN, END);
    expect(twice).toBe(once);
  });
});

describe('isEffectivelyEmpty', () => {
  it('returns true for shebang line and blank lines only', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\n\n')).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(isEffectivelyEmpty('')).toBe(true);
  });

  it('returns false when real user content is present', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\necho "user hook"')).toBe(false);
  });

  it('returns false when a begin marker line is present', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\n# >>> codegraph auto-init hook >>>')).toBe(false);
  });

  it('returns false when an end marker line is present', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\n# <<< codegraph auto-init hook <<<')).toBe(false);
  });

  it('returns false when shebang is present alongside marker lines', () => {
    const content = [
      '#!/bin/sh',
      '# >>> codegraph sync hook >>>',
      '# <<< codegraph sync hook <<<',
    ].join('\n');
    expect(isEffectivelyEmpty(content)).toBe(false);
  });
});

describe('chmodExecutable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `hook-utils-chmod-${Date.now()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });

  it.skipIf(process.platform === 'win32')('sets 0o755 executable bit on POSIX', () => {
    fs.writeFileSync(tmp, '#!/bin/sh\n', { mode: 0o644 });
    chmodExecutable(tmp);
    expect(fs.statSync(tmp).mode & 0o111).not.toBe(0);
  });

  it('does not throw when the file does not exist', () => {
    expect(() => chmodExecutable('/nonexistent/path/file.sh')).not.toThrow();
  });
});
