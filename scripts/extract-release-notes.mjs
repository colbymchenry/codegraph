#!/usr/bin/env node
/**
 * Extract a release-notes block from CHANGELOG.md for a given version
 * (or unwrap text supplied on stdin), then join hard-wrapped paragraphs.
 *
 * Why: GitHub renders release-note Markdown with GFM hard breaks, so
 * every `\n` becomes `<br>`. The CHANGELOG is hard-wrapped at ~75
 * chars for readable diffs, which then renders as awkward visible
 * line breaks on the release page. This script joins indented
 * continuation lines into a single line per bullet so the GFM
 * renderer produces clean paragraphs.
 *
 * Repo-level CHANGELOG.md viewing is unaffected (CommonMark treats
 * newlines as spaces there).
 *
 * GitHub refuses a release body over 125,000 characters, so notes that
 * would be longer are cut before the first entry that doesn't fit, and
 * end with a link to the full list in CHANGELOG.md.
 *
 * Usage:
 *   extract-release-notes.mjs <version>     # read CHANGELOG.md
 *   extract-release-notes.mjs --stdin       # read from stdin (any text)
 */

import { readFileSync } from 'fs';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: extract-release-notes.mjs <version> | --stdin');
  process.exit(1);
}

let block;
let version = null;
if (arg === '--stdin') {
  block = readFileSync(0, 'utf8').replace(/\r\n?/g, '\n').split('\n');
} else {
  version = arg;
  const escaped = version.replace(/\./g, '\\.');
  const headerRe = new RegExp(`^## \\[${escaped}\\]`);
  const anyHeaderRe = /^## \[/;
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) {
    console.error(`no '## [${version}]' entry found in CHANGELOG.md`);
    process.exit(1);
  }
  const after = lines.findIndex((l, i) => i > start && anyHeaderRe.test(l));
  block = lines.slice(start, after === -1 ? lines.length : after);
}

// Track a stack of `{ indent: number }` frames so a continuation line
// can attach to the right ancestor. Handles the post-nested-list
// continuation pattern:
//
//     - top-level
//         - nested
//       back to top-level  <- 2-space indent, joins the top-level bullet
const out = [];
let buf = '';
let stack = [];

function flushBuf() {
  if (buf !== '') {
    out.push(buf);
    buf = '';
  }
}

function leadingSpaces(s) {
  const m = s.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

// Bullets: `-`, `*`, `digit.` only. `+` is intentionally excluded — the
// CHANGELOG uses literal `+` inline (`config + instructions`) and we
// don't want to misread those as nested bullets.
const listItemRe = /^(\s*)([-*]|\d+\.)\s+/;
const fenceRe = /^\s*```/;

let inFence = false;

for (const line of block) {
  // Fenced code blocks: pass through verbatim, no joining.
  if (fenceRe.test(line)) {
    flushBuf();
    stack = [];
    out.push(line);
    inFence = !inFence;
    continue;
  }
  if (inFence) {
    out.push(line);
    continue;
  }
  if (/^\s*$/.test(line)) {
    flushBuf();
    out.push('');
    continue;
  }
  if (/^#/.test(line)) {
    flushBuf();
    stack = [];
    out.push(line);
    continue;
  }
  const itemMatch = line.match(listItemRe);
  if (itemMatch) {
    flushBuf();
    const indent = itemMatch[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack.push({ indent });
    buf = line;
    continue;
  }
  if (/^\s/.test(line)) {
    const indent = leadingSpaces(line);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      flushBuf();
      stack.pop();
    }
    const trimmed = line.replace(/^\s+/, '');
    buf = buf === '' ? trimmed : `${buf} ${trimmed}`;
    continue;
  }
  flushBuf();
  stack = [];
  out.push(line);
}
flushBuf();

// GitHub answers a release body over 125,000 characters with HTTP 422, and
// the Release workflow pushes the promoted CHANGELOG before it creates the
// release, so oversized notes would stop a release halfway, before npm.
// Counted in UTF-8 bytes, which is never less than GitHub's character count,
// with room to spare.
const MAX_BODY_BYTES = 120_000;
const topLevelEntryRe = /^([-*]|\d+\.)\s+/;

function fitToReleaseBody(lines) {
  const size = (line) => Buffer.byteLength(line, 'utf8') + 1;
  if (lines.reduce((n, line) => n + size(line), 0) <= MAX_BODY_BYTES) return lines;
  // Cut only where an entry or a heading starts, outside a code fence, so no
  // entry is shown in part.
  const before = [0];
  const cuts = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (!fenced && (topLevelEntryRe.test(line) || /^#/.test(line))) cuts.push(i);
    if (fenceRe.test(line)) fenced = !fenced;
    before.push(before[i] + size(line));
  });
  const entriesFrom = (i) =>
    lines.slice(i).filter((line) => topLevelEntryRe.test(line)).length;
  const repo = process.env.GITHUB_REPOSITORY || 'colbymchenry/codegraph';
  const ref = version && /^\d+\.\d+\.\d+/.test(version) ? `v${version}` : 'main';
  const pointer = (n) =>
    `_…and ${n} more ${n === 1 ? 'entry' : 'entries'}: the full list is in ` +
    `[CHANGELOG.md](https://github.com/${repo}/blob/${ref}/CHANGELOG.md)._`;
  for (let c = cuts.length - 1; c >= 0; c--) {
    const kept = lines.slice(0, cuts[c]);
    // A heading left with nothing under it goes too.
    while (kept.length > 0 && (/^\s*$/.test(kept[kept.length - 1]) || /^#/.test(kept[kept.length - 1]))) {
      kept.pop();
    }
    const note = pointer(entriesFrom(kept.length));
    if (before[kept.length] + size('') + size(note) <= MAX_BODY_BYTES) return [...kept, '', note];
  }
  return [pointer(entriesFrom(0))];
}

const body = fitToReleaseBody(out);
process.stdout.write(body.join('\n'));
if (!body[body.length - 1]?.endsWith('\n')) process.stdout.write('\n');
