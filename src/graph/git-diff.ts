/**
 * What a change touched, read from git: changed files plus the *line ranges*
 * inside them, which is what turns a diff into graph seeds (an enclosing-symbol
 * lookup per changed range, see `blast.ts`).
 *
 * Paths are relative to the CodeGraph project root and restricted to it
 * (`--relative`), because the project may be a subdirectory of the repository
 * and its file ids are project-relative. The patch pass forces `a/`/`b/`
 * prefixes and turns off textconv and inter-hunk context, so the user's diff
 * config cannot change the headers or the line numbers parsed here. Hunk
 * bodies are read by the `@@` header's line counts, so an added line whose text
 * looks like a file header stays content, and a C-quoted `+++` path (a name
 * holding `"`, `\` or a control character) is decoded before it is matched.
 *
 * Git is run rather than read through a library because `--unified=0` gives
 * exactly the post-image line ranges needed, with no context lines to subtract
 * back out. It is spawned with an argument array, never a shell string, so a
 * ref or path from the caller is never interpreted by a shell, and a ref
 * beginning with `-` is refused before it can reach git as an option.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** An inclusive post-image line span, 1-based except for a deletion at the top of the file. */
export interface LineRange {
  start: number;
  end: number;
  /**
   * Set to true for a pure deletion, where start = end is the line before the gap
   * (0 at the top). Absent otherwise.
   */
  deletion?: true;
}

/** One edited line of a hunk: `n` is its post-image number, null for a `-` line. */
export interface HunkLine {
  n: number | null;
  sign: '+' | '-';
  text: string;
}

/** A hunk's post-image range, the text kept for it, and how many lines the caps dropped. */
export interface Hunk extends LineRange {
  lines: HunkLine[];
  dropped: number;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Pre-image path, set only for a rename (or copy). */
  oldPath?: string;
  ranges: LineRange[];
  hunks: Hunk[];
}

/**
 * What `applyHunks` counted over every line of a hunk's body, whatever the text
 * caps kept (`MAX_HUNK_LINES`, `MAX_FILE_LINES`). Seeding reads it to set aside
 * blank separators and to recognise a removed separator, so a long hunk, or one
 * after earlier hunks used up the per-file cap, is judged on all its lines.
 */
export interface HunkShape {
  /** `-` lines in the hunk, kept or dropped. */
  removed: number;
  /** Post-image numbers of whitespace-only added lines, kept or dropped. */
  blankAdded: number[];
  /** True only when at least one line was removed and every removed line is blank. */
  removedAllBlank: boolean;
}

/**
 * The shape of each hunk `applyHunks` recorded. Kept beside the hunks rather than
 * on them: `Hunk` objects are spread into the JSON report, so an own property
 * would change its shape. Absent for a hunk built by hand.
 */
const hunkShapes = new WeakMap<Hunk, HunkShape>();

/** The shape `applyHunks` counted for `hunk`, or undefined for a hunk it did not record. */
export function hunkShape(hunk: Hunk): HunkShape | undefined {
  return hunkShapes.get(hunk);
}

/** The changed files and the label of the range they were read from. */
export interface ChangedSet {
  basis: string;
  files: ChangedFile[];
}

/** `@@ -oldStart[,oldCount] +newStart[,newCount] @@`; a missing count is 1. */
const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Text kept per hunk, and per file, in the in-memory record (`Hunk.lines`). A
 * regenerated lockfile can be one hunk of 40,000 lines: its ranges still seed the
 * graph, while the caps bound how much of its text is retained in memory. The
 * caps do not decide what seeding sets aside: that reads the hunk's `HunkShape`,
 * which also retains the uncapped numbers of blank added lines.
 */
const MAX_HUNK_LINES = 24;
const MAX_FILE_LINES = 200;

/**
 * Room for `git diff --unified=0` on a large diff. spawnSync's default is
 * 1 MiB, and an overflow makes `runGit` return null.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run git in `root` and return its stdout, or null when git fails (not a
 * repository, an unknown ref, a missing path). `core.quotePath=false` keeps
 * non-ASCII names unescaped, so they match the index's paths.
 */
function runGit(root: string, args: string[]): string | null {
  const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout;
}

/**
 * A ref git would parse as an option (`--output=<file>` makes `git diff` write
 * a file). Git refuses branch and tag names beginning with `-`, and no revision
 * expression begins with one, so refusing these costs nothing a caller can name
 * as a branch or tag.
 */
function isOptionLike(ref: string): boolean {
  return ref.startsWith('-');
}

/**
 * True when `ref` names a commit git can resolve. Checked before diffing so an
 * unknown base fails with a caller-facing message rather than a null diff. A
 * ref beginning with `-` is never passed to git and reports false.
 */
export function refExists(root: string, ref: string): boolean {
  if (isOptionLike(ref)) return false;
  return runGit(resolve(root), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

/**
 * Changed files + post-image line ranges, or null when git fails.
 *
 * With a `base`, the diff runs from the MERGE BASE of `base` and HEAD to the
 * WORKING TREE. The merge base, not the tip of the base branch: on a branch
 * whose base moved after it was cut, diffing against the tip would attribute
 * other people's merges to this branch and list files its author never
 * touched. The working tree, not HEAD: the post-image line numbers are then
 * those of the files on disk, which is what the index describes, so a range
 * selects the symbol it edits even when the tree holds uncommitted edits. Those
 * edits to tracked files are part of the diff. The basis reads `<base>...HEAD`
 * when tracked files under the project match HEAD, and
 * `<base>...HEAD plus uncommitted changes` when they do not. Untracked files
 * are not in the diff.
 *
 * With no `base` this reports the working tree against HEAD (the "what am I
 * about to push" case), falling back to the last commit when the tree is clean,
 * so a run by hand answers something useful. When the tree is clean and there
 * is no HEAD~1 (a single-commit repository), the answer is an empty set with
 * the working-tree basis rather than a failure.
 *
 * `root` is the CodeGraph project root, which may be a subdirectory of the git
 * repository: paths come back relative to it, and changes outside it are not
 * reported. A `base` beginning with `-` returns null without running git, and
 * so does a `base` that shares no history with HEAD.
 */
export function changedFiles(root: string, base?: string): ChangedSet | null {
  const dir = resolve(root);
  if (base !== undefined) {
    if (isOptionLike(base)) return null;
    const mergeBase = runGit(dir, ['merge-base', base, 'HEAD'])?.trim();
    if (!mergeBase) return null;
    const files = diffFiles(dir, [mergeBase]);
    if (files === null) return null;
    const clean = workingTreeMatchesHead(dir);
    if (clean === null) return null;
    return { basis: clean ? `${base}...HEAD` : `${base}...HEAD plus uncommitted changes`, files };
  }
  const working = diffFiles(dir, ['HEAD']);
  if (working === null) return null;
  if (working.length > 0) return { basis: 'working tree vs HEAD', files: working };
  const last = diffFiles(dir, ['HEAD~1...HEAD']);
  if (last === null) return { basis: 'working tree vs HEAD', files: [] };
  return { basis: 'HEAD~1...HEAD', files: last };
}

/**
 * Whether tracked content under the project root matches HEAD, including both
 * staged and unstaged edits. Untracked files (including the index directory)
 * are not compared. Null means git could not compare.
 */
function workingTreeMatchesHead(root: string): boolean | null {
  const changed = runGit(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']);
  return changed === null ? null : changed.length === 0;
}

/**
 * Both git passes for one revision or range: name-status (statuses, renames) then hunks.
 *
 * Both run with `--relative` from `dir`: git otherwise prints repo-relative
 * paths and every change in the repository, while CodeGraph file ids are
 * relative to the project root. A file renamed into `dir` from outside it comes
 * back as added; one renamed out of it comes back as deleted, at its old path.
 */
function diffFiles(dir: string, range: string[]): ChangedFile[] | null {
  const status = runGit(dir, ['diff', '--name-status', '--find-renames', '--relative', '-z', ...range, '--']);
  if (status === null) return null;
  const files = parseNameStatus(status);
  if (files.length === 0) return files;
  const patch = runGit(dir, [
    'diff',
    '--unified=0',
    // `diff.interHunkContext` would merge nearby hunks with unchanged lines
    // between them, widening the ranges past the edit.
    '--inter-hunk-context=0',
    '--no-color',
    '--no-ext-diff',
    // A textconv filter rewrites the text git compares, so its line numbers
    // need not be the file's.
    '--no-textconv',
    '--find-renames',
    '--relative',
    // `diff.mnemonicPrefix`, `diff.noprefix` and `diff.srcPrefix`/`dstPrefix`
    // change the `---`/`+++` headers; stripPrefix expects exactly `b/` on `+++`.
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...range,
    '--',
  ]);
  // A failed patch pass still leaves the statuses: the files are reported with
  // no ranges rather than not at all.
  if (patch !== null) applyHunks(files, patch);
  return files;
}

/**
 * `--name-status -z` output: NUL-separated fields, where a rename (or copy)
 * spends THREE fields (`R096`, old, new) and everything else spends two.
 * Splitting on NUL and walking with a cursor is the only way to read it: a
 * line-oriented parse silently pairs a rename's old path with the next file's
 * status. A copy is reported as `renamed`.
 */
export function parseNameStatus(out: string): ChangedFile[] {
  const fields = out.split('\0').filter((f) => f !== '');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    // The loop bound guarantees this field exists.
    const code = fields[i++] as string;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = fields[i++];
      const path = fields[i++];
      if (path === undefined) break;
      files.push({ path, status: 'renamed', oldPath, ranges: [], hunks: [] });
      continue;
    }
    const path = fields[i++];
    if (path === undefined) break;
    if (code.startsWith('A')) files.push({ path, status: 'added', ranges: [], hunks: [] });
    else if (code.startsWith('D')) files.push({ path, status: 'deleted', ranges: [], hunks: [] });
    else files.push({ path, status: 'modified', ranges: [], hunks: [] });
  }
  return files;
}

/**
 * Attach each hunk's post-image range, and the text the caps keep, to its file,
 * in place. Hunks for a path not in `files`, or for a `+++ /dev/null` (deleted)
 * file, are skipped. For every hunk it records it also counts the removed lines
 * and notes the blank added ones over the whole body, kept or dropped (see
 * `hunkShape`).
 *
 * A hunk's body is read by the counts in its `@@` header: until the header's
 * pre-image lines (`-` and context) and post-image lines (`+` and context) are
 * all accounted for, every line is content. Only a line outside a hunk can be a
 * `+++` or `@@` header, so an added source line whose text is `++ b/y.ts`
 * (printed as `+++ b/y.ts`) stays a line of its hunk.
 */
export function applyHunks(files: ChangedFile[], patch: string): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let current: ChangedFile | undefined;
  /** The open hunk's record; undefined while reading a hunk of a skipped file. */
  let hunk: Hunk | undefined;
  /** The open hunk's counts, used only while `hunk` is set. */
  let shape: HunkShape | undefined;
  /** True once the open hunk has removed a line that is not blank. */
  let removedNonBlank = false;
  /** Pre- and post-image lines the open hunk has still to deliver. */
  let oldLeft = 0;
  let newLeft = 0;
  /** Post-image number for the next `+` line of the open hunk. */
  let next = 0;
  /** Lines kept or dropped so far for the current file, against MAX_FILE_LINES. */
  let kept = 0;
  for (const line of patch.split('\n')) {
    // Every file starts with this, and a content line cannot (it begins with
    // `+`, `-`, a space or `\`), so it closes any hunk, including one whose
    // counts were not met. The next file's `--- a/x` header then arrives
    // outside a hunk and is ignored.
    if (line.startsWith('diff --git ')) {
      current = undefined;
      hunk = undefined;
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      readHunkLine(line);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      current = raw === '/dev/null' ? undefined : byPath.get(stripPrefix(raw));
      hunk = undefined;
      kept = 0;
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = undefined;
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      // The counts are taken even for a skipped file: its hunk bodies must be
      // consumed as content too, or a line in them could pass for a header.
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      const start = Number(m[2]);
      const count = m[3] === undefined ? 1 : Number(m[3]);
      newLeft = count;
      next = start;
      if (!current) continue;
      // `+N,0` marks a deletion gap after N (0 at the top), not an edited line.
      // The flag makes seeding look for a symbol that contains both N and N+1;
      // see `seedsForFile` in blast.ts.
      const range: LineRange = count === 0 ? { start, end: start, deletion: true } : { start, end: start + count - 1 };
      hunk = { ...range, lines: [], dropped: 0 };
      shape = { removed: 0, blankAdded: [], removedAllBlank: false };
      removedNonBlank = false;
      hunkShapes.set(hunk, shape);
      current.ranges.push(range);
      current.hunks.push(hunk);
    }
    // Anything else outside a hunk (`index`, `--- a/x`, rename and mode lines,
    // `\ No newline at end of file` after a hunk's last line) carries nothing.
  }

  /** One line inside the open hunk, counted against the header's line counts. */
  function readHunkLine(line: string): void {
    const sign = line[0];
    if (sign === '+' && newLeft > 0) {
      newLeft -= 1;
      if (hunk) {
        // Counted whether or not the caps keep the text.
        if (shape && line.slice(1).trim() === '') shape.blankAdded.push(next);
        pushLine(hunk, { n: next, sign: '+', text: line.slice(1) }, kept++ < MAX_FILE_LINES);
      }
      next += 1;
    } else if (sign === '-' && oldLeft > 0) {
      oldLeft -= 1;
      if (hunk) {
        if (shape) {
          shape.removed += 1;
          if (line.slice(1).trim() !== '') removedNonBlank = true;
          shape.removedAllBlank = !removedNonBlank;
        }
        pushLine(hunk, { n: null, sign: '-', text: line.slice(1) }, kept++ < MAX_FILE_LINES);
      }
    } else if (sign === ' ' && oldLeft > 0 && newLeft > 0) {
      // A context line: `--unified=0 --inter-hunk-context=0` asks for none, but
      // one still occupies a line of both images.
      oldLeft -= 1;
      newLeft -= 1;
      next += 1;
    }
    // `\ No newline at end of file` inside a hunk occupies no line of either image.
  }
}

/** Keep `line` in `hunk` unless either cap is reached; otherwise count it as dropped. */
function pushLine(hunk: Hunk, line: HunkLine, withinFile: boolean): void {
  if (!withinFile || hunk.lines.length >= MAX_HUNK_LINES) {
    hunk.dropped += 1;
    return;
  }
  hunk.lines.push(line);
}

/**
 * The path of a `+++` header, as `--name-status -z` prints it: `b/src/x.ts` →
 * `src/x.ts`. A C-quoted header (`"b/src/a\"b.ts"`) is decoded first. An
 * unquoted one loses what follows a tab, which is the tab git appends to a
 * name containing a space; a tab inside a name forces quoting, so it cannot be
 * part of an unquoted one. The patch pass forces `--dst-prefix=b/`, so `b/` is
 * the only prefix to expect.
 */
function stripPrefix(raw: string): string {
  const name = raw.startsWith('"') ? (unquoteC(raw) ?? raw) : (raw.split('\t')[0] ?? raw);
  return name.startsWith('b/') ? name.slice(2) : name;
}

/** git's named C escapes (`unquote_c_style` in git's quote.c), each one byte. */
const C_ESCAPES = new Map<string, number>([
  ['a', 0x07], ['b', 0x08], ['t', 0x09], ['n', 0x0a], ['v', 0x0b], ['f', 0x0c], ['r', 0x0d],
  ['"', 0x22], ['\\', 0x5c],
]);

/** True for an ASCII octal digit no greater than `max`. */
function isOctal(b: number | undefined, max = 0x37): b is number {
  return b !== undefined && b >= 0x30 && b <= max;
}

/**
 * The name inside a C-quoted path that opens `raw`, or null when `raw` is not
 * one git writes. git quotes a path holding `"`, `\` or a control character (a
 * tab, a newline) in patch headers even with `core.quotePath=false`, which only
 * stops it escaping bytes above 0x7f; `--name-status -z` never quotes, so the
 * header must be decoded to match the name-status path. The escapes are git's:
 * the named ones above, and `\NNN`, three octal digits for one byte (a first
 * digit of at most 3 keeps it within a byte). The result is the bytes read as
 * UTF-8. The input is walked as UTF-8 bytes: `"` and `\` are ASCII, so they
 * never occur inside a multi-byte character. What follows the closing quote
 * (the tab git appends when the name has a space) is dropped.
 */
function unquoteC(raw: string): string | null {
  const src = Buffer.from(raw, 'utf8');
  if (src[0] !== 0x22) return null;
  const out: number[] = [];
  for (let i = 1; i < src.length; i++) {
    // The loop bound guarantees this byte exists.
    const b = src[i] as number;
    if (b === 0x22) return Buffer.from(out).toString('utf8');
    if (b !== 0x5c) {
      out.push(b);
      continue;
    }
    const e = src[i + 1];
    const named = e === undefined ? undefined : C_ESCAPES.get(String.fromCharCode(e));
    if (named !== undefined) {
      out.push(named);
      i += 1;
      continue;
    }
    const d2 = src[i + 2];
    const d3 = src[i + 3];
    if (!isOctal(e, 0x33) || !isOctal(d2) || !isOctal(d3)) return null;
    out.push(((e - 0x30) << 6) | ((d2 - 0x30) << 3) | (d3 - 0x30));
    i += 3;
  }
  // No closing quote.
  return null;
}
