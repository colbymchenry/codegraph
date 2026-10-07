/**
 * A site: where codegraph keys an edge and SCIP resolves the same reference —
 * (caller node, 1-based line, callee name, kind). The merge lines codegraph's
 * edges up with SCIP's occurrences by this key, so both sides build it here.
 *
 * codegraph's edge `col` is where the call EXPRESSION starts (`this.step()` →
 * the `this`), SCIP's range is the callee NAME, so the column can't be part of
 * the key — two same-named calls on one line collapse into one site, which the
 * merge treats identically anyway. The line is the expression's too: a call
 * reached through a multi-line chain is keyed on the line the chain starts
 * (callLine), in every language.
 */

import type { SiteKind } from './syntax';

export type { SiteKind } from './syntax';

export function siteKey(source: string, line: number, name: string, kind: SiteKind): string {
  return `${source}\0${line}\0${name}\0${kind}`;
}

export function parseSiteKey(key: string): { source: string; line: number; name: string; kind: SiteKind } {
  const [source, line, name, kind] = key.split('\0');
  return { source: source!, line: Number(line), name: name!, kind: kind as SiteKind };
}

/**
 * A `references` site is keyed by its file, not its caller: the merge only
 * verifies or removes codegraph's references (it never inserts one, see merge.ts),
 * so it needs no caller node, and codegraph's sources for them (an interface's
 * property, a type alias) are kinds callerAt doesn't name.
 */
export function referenceKey(file: string, line: number, name: string): string {
  return siteKey(file, line, name, 'references');
}

/** The site kind an edge is keyed by: `implements`/`extends` share `inherits`. */
export function siteKindOfEdge(kind: string): SiteKind {
  return kind === 'implements' || kind === 'extends' ? 'inherits' : (kind as SiteKind);
}

/** The site of one of codegraph's edges: from its source node (`file` is that node's file) and its target's name. */
export function edgeSiteKey(source: string, file: string, line: number, name: string, kind: string): string {
  return kind === 'references' ? referenceKey(file, line, name) : siteKey(source, line, name, siteKindOfEdge(kind));
}

/** The site of a call SCIP resolved: its callee name at (0-based) `line`/`col` of `lines`, keyed where codegraph keys it. */
export function callSiteKey(caller: string, lines: string[], line: number, col: number, name: string, kind: SiteKind): string {
  return siteKey(caller, callLine(lines, line, col) + 1, name, kind);
}

/** How far back a chain is followed: past it, the call stays on its own line. */
const MAX_CHAIN_LINES = 50;

interface Pos { l: number; c: number }

/**
 * The 0-based line codegraph keys a call on: where its call expression starts.
 * For a callee name reached through member access that is where the receiver
 * starts, followed back through every `.` (or `?.`) and the receiver before it —
 * a name, a bracketed group, a postfix `?`/`!` — so a chain laid out over lines,
 * dots leading (`mk()⏎.bar()`) or trailing (`mk().⏎bar()`), counts on its first.
 */
export function callLine(lines: string[], line: number, col: number): number {
  let start: Pos = { l: line, c: col };
  for (;;) {
    let p = before(lines, start, line);
    if (!p || lines[p.l]![p.c] !== '.') return start.l;
    if (p.c > 0 && lines[p.l]![p.c - 1] === '?') p = { l: p.l, c: p.c - 1 };
    p = before(lines, p, line);
    if (!p) return start.l;
    const receiver = receiverStart(lines, p, line);
    if (!receiver) return p.l; // a receiver this doesn't read (a string literal, …): the chain starts no later than its end
    start = receiver;
  }
}

/** The last non-blank character before `at`, across lines (a line comment above doesn't count). */
function before(lines: string[], at: Pos, from: number): Pos | null {
  let l = at.l;
  let text = lines[l]!.slice(0, at.c);
  for (;;) {
    const m = /\S\s*$/.exec(text);
    if (m) return { l, c: m.index };
    if (--l < 0 || from - l > MAX_CHAIN_LINES) return null;
    text = lines[l]!.replace(/(?:^|\s)(?:\/\/|#(?![[!])).*$/, '');
  }
}

/** Where the receiver ending at `end` starts: postfix `?`/`!`, bracketed groups, then a name. Null when none of those ends it. */
function receiverStart(lines: string[], end: Pos, from: number): Pos | null {
  let p: Pos | null = end;
  let start: Pos | null = null;
  while (p) {
    const ch = lines[p.l]![p.c]!;
    if (ch === '?' || ch === '!') {
      start = p;
      p = p.c > 0 ? { l: p.l, c: p.c - 1 } : null;
    } else if (ch === ')' || ch === ']') {
      const open = opener(lines, p, from);
      if (!open) return null;
      start = open;
      p = open.c > 0 ? { l: open.l, c: open.c - 1 } : null;
    } else if (/[\w$]/.test(ch)) {
      let c = p.c;
      while (c > 0 && /[\w$]/.test(lines[p.l]![c - 1]!)) c--;
      return { l: p.l, c };
    } else {
      return start;
    }
  }
  return start;
}

/** The bracket that opens the group closed at `close`, scanning back across lines. */
function opener(lines: string[], close: Pos, from: number): Pos | null {
  let depth = 0;
  for (let l = close.l; l >= 0 && from - l <= MAX_CHAIN_LINES; l--) {
    const text = lines[l]!;
    for (let c = l === close.l ? close.c : text.length - 1; c >= 0; c--) {
      const ch = text[c];
      if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if ((ch === '(' || ch === '[' || ch === '{') && --depth === 0) return { l, c };
    }
  }
  return null;
}
