/**
 * What name-matcher.ts keeps per context is read from the project, and a
 * resolver outlives any one sync: a memo clearNameMatcherMemos doesn't drop
 * answers an edit by what the file said before it, in a long-lived server only,
 * where no test of a single index ever sees it. So every module-level memo is
 * either dropped there or named below with why it holds nothing of the project.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'resolution', 'name-matcher.ts'), 'utf8').replace(/\r\n/g, '\n');

/** Module-level state this file may keep past clearCaches. */
const HOLDS_NO_PROJECT_STATE: ReadonlyMap<string, string> = new Map([
  ['LOCAL_BINDING_PATTERNS', 'regular expressions, by the name they look for'],
  ['PATTERN_MEMO', 'regular expressions, by the name they look for'],
  ['TS_FIELD_PATTERNS', 'regular expressions, by the field they look for'],
  ['RUST_CHAINED_CALLS', 'keyed by the reference object, which a sync makes anew'],
  ['PY_CHAIN_GUESSING', 'keyed by the reference object, for the length of one lookup'],
  ['CPP_ARGUMENT_CHOICES_IN_FLIGHT', 'a recursion guard, empty between lookups'],
]);

/** A module-level collection that starts empty; one built from a literal (`new Map([`) is a constant. */
const MEMO = /^(?:export )?const ([A-Za-z_$][\w$]*)\b[^=\n]*= new (?:WeakMap|WeakSet|Map|Set|LRUCache)\b(?:<.*>)?\(\)/gm;

const declared = [...source.matchAll(MEMO)].map((m) => m[1]!);
const clearing = /export function clearNameMatcherMemos\([^)]*\): void \{\n([\s\S]*?)\n\}\n/.exec(source)?.[1] ?? '';

describe('name-matcher.ts memos', () => {
  it('finds the memos and the function that clears them', () => {
    // Against a pattern that silently stops matching.
    expect(declared.length).toBeGreaterThan(200);
    expect(clearing).toContain('.delete(context)');
  });

  it('every memo is dropped by clearNameMatcherMemos, or holds no project state', () => {
    const kept = declared.filter((name) => !new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(clearing));
    expect(kept.filter((name) => !HOLDS_NO_PROJECT_STATE.has(name))).toEqual([]);
  });

  it('the allow-list names only what is kept', () => {
    const stale = [...HOLDS_NO_PROJECT_STATE.keys()].filter((name) => !declared.includes(name) || new RegExp(`\\b${name}\\b`).test(clearing));
    expect(stale).toEqual([]);
  });
});
