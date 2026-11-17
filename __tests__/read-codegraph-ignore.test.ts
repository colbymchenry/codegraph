import { describe, expect, it, vi } from 'vitest';
import { readCodegraphIgnore } from '../src/extraction/read-codegraph-ignore';

describe('readCodegraphIgnore', () => {
  it('returns empty and does not parse when the ignore file is absent', () => {
    const parse = vi.fn(() => 'unexpected');
    const isFile = vi.fn(() => false);

    expect(readCodegraphIgnore('/p', parse, isFile)).toBe('');
    expect(isFile).toHaveBeenCalledExactlyOnceWith('/p/.codegraphignore');
    expect(parse).not.toHaveBeenCalled();
  });

  it('returns the parsed rules unchanged for the root ignore file', () => {
    const parse = vi.fn(() => 'gen/\n!gen/keep.ts\n');
    const isFile = vi.fn(() => true);

    expect(readCodegraphIgnore('/p', parse, isFile)).toBe('gen/\n!gen/keep.ts\n');
    expect(isFile).toHaveBeenCalledExactlyOnceWith('/p/.codegraphignore');
    expect(parse).toHaveBeenCalledExactlyOnceWith('/p/.codegraphignore');
  });

  it('returns empty when the parser returns empty for a present file', () => {
    const parse = vi.fn(() => '');
    const isFile = vi.fn(() => true);

    expect(readCodegraphIgnore('/p', parse, isFile)).toBe('');
    expect(parse).toHaveBeenCalledExactlyOnceWith('/p/.codegraphignore');
  });
});
