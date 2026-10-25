/**
 * The viewer's locale tables (en and zh-CN) stay in step with the strings the
 * components actually reference.
 *
 * We do NOT import `locale.ts` — the engine's node test has no Svelte plugin,
 * so the tables live in the plain, rune-free `locale.ts` (the reactive
 * `locale.svelte.ts` shell wraps it), and importing it here would still be a
 * hard dependency on file layout. Instead this statically scans the source
 * tree for `t('...')` / `tPair('...')` calls and parses the two tables out of
 * `locale.ts` with regex. Anything the components reference must exist in both
 * locales; nothing may be defined twice in a table; and the two tables must
 * name the exact same set of keys.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', 'ui', 'src');
const LOCALE_FILE = path.join(SRC, 'lib', 'locale.ts');

/** Files whose contents are scanned for locale references. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.svelte') || entry.name.endsWith('.ts')) {
        if (full === LOCALE_FILE) continue;
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

/** Every key referenced as `t('key'…)` or `tPair('key'…)` in the source. */
function referencedKeys(): string[] {
  const refs: string[] = [];
  const re = /\bt(?:Pair)?\(\s*'([^']+)'\s*(?:,|\))/g;
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      refs.push(m[1]!);
    }
  }
  return refs;
}

interface Tables {
  en: string[];
  zh: string[];
}

/** Parse the `en` and `'zh-CN'` key tables out of locale.ts by regex. */
function parseTables(): Tables {
  const text = fs.readFileSync(LOCALE_FILE, 'utf8');
  const enStart = text.indexOf('en: {');
  const zhStart = text.indexOf("'zh-CN': {");
  if (enStart < 0 || zhStart < 0) {
    throw new Error('could not locate the en / zh-CN tables in locale.ts');
  }
  const enBlock = text.slice(enStart, zhStart);
  const zhBlock = text.slice(zhStart);
  const zhEnd = zhBlock.indexOf('\n};');
  const zhBlockTrimmed = zhEnd < 0 ? zhBlock : zhBlock.slice(0, zhEnd);

  const blockKeys = (block: string) =>
    [...block.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]!);

  const zhKeys = blockKeys(zhBlockTrimmed).filter((k) => k !== 'zh-CN');
  return { en: blockKeys(enBlock), zh: zhKeys };
}

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

describe('viewer locale tables', () => {
  const tables = parseTables();
  const refs = referencedKeys();

  it('references at least one key', () => {
    expect(refs.length).toBeGreaterThan(0);
  });

  it('defines every referenced key in both locales', () => {
    const missing = (keys: Set<string>) =>
      refs.filter((k) => !keys.has(k)) as string[];
    expect(missing(new Set(tables.en)), 'referenced but missing in en').toEqual([]);
    expect(missing(new Set(tables.zh)), 'referenced but missing in zh-CN').toEqual([]);
  });

  it('has no duplicate keys in either table', () => {
    expect(duplicates(tables.en), 'duplicate keys in en').toEqual([]);
    expect(duplicates(tables.zh), 'duplicate keys in zh-CN').toEqual([]);
  });

  it('has identical key sets in en and zh-CN', () => {
    expect(new Set(tables.en)).toEqual(new Set(tables.zh));
    expect(tables.en.length).toBe(tables.zh.length);
  });
});
