/**
 * `codegraph orphans` and `codegraph_orphans` share this entry point: it
 * checks the options, reads the merge base and the diff, wires the file reads
 * and the text search, and renders the report, returning what to print instead
 * of printing it. The rules (what "added" means, the orphan and guess
 * predicates, the exclusions) are in the `./orphans` header.
 *
 * A base is required: "added" needs a pre-image commit, the merge base of the
 * base ref and HEAD, so there is no working-tree default as blast has.
 *
 * Async: the text-mention check uses the raw `searchIndexText` stage, which
 * spawns ripgrep without attributing hits to symbols.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDatabasePath } from '../db';
import { GrepIndexError, searchIndexText } from '../search/grep';
import { validatePathWithinRoot } from '../utils';
import { changedFiles, hasUnreadRanges, refExists, runGit } from './git-diff';
import { findOrphans, MentionSearchIncompleteError, type OrphansIO } from './orphans';
import { checkIndexCurrency, currencyFailure } from './orphans-freshness';
import { jsonReport, textReport } from './orphans-render';
import { openOrphansStore } from './orphans-store';

export interface OrphansArgs {
  /** Git ref whose merge base with HEAD the additions are counted from. Required. */
  base?: string;
  /** `text` (default) or `json`. */
  format?: string;
}

/** The report on success (`ok: true`), or the message to show on failure. */
export type OrphansResult = { ok: true; output: string } | { ok: false; message: string };

function fail(message: string): OrphansResult {
  return { ok: false, message };
}

/**
 * Run orphans for the CodeGraph project at `root`. Checks, in order: base
 * given, format, index, base ref known, merge base, diff, the diff's changed
 * lines, then the index's content hashes against disk for changed indexed
 * files; the first that fails is the answer. Synced uncommitted edits are valid.
 * A search that cannot run (a
 * `GrepIndexError`: ripgrep cannot be started, or the index is gone), or a
 * text-mention check that cannot finish for a name
 * (`MentionSearchIncompleteError`), is a failure too:
 * without the search, "orphaned" would claim more than was checked. An indexed
 * file the search cannot read is not a failure: the report counts it
 * (`searchUnread`) and the text says a mention there would be missed.
 */
export async function runOrphans(root: string, args: OrphansArgs): Promise<OrphansResult> {
  const absRoot = path.resolve(root);
  if (args.base === undefined || args.base === '') {
    return fail('a base ref is required (--base <ref>, or base over MCP): orphans lists the symbols added since the merge base of that ref and HEAD');
  }
  const base = args.base;
  const format = args.format ?? 'text';
  if (format !== 'text' && format !== 'json') return fail(`format must be text or json, got "${format}"`);
  if (!fs.existsSync(getDatabasePath(absRoot))) {
    return fail(`CodeGraph not initialized in ${absRoot}. Run \`codegraph init\` first.`);
  }
  // refExists refuses a ref beginning with `-`, so nothing below passes one to git as an option.
  if (!refExists(absRoot, base)) {
    return fail(`base ref "${base}" is not in this checkout. ` +
      'In CI, fetch enough history for the merge base (actions/checkout with `fetch-depth: 0`).');
  }
  const mergeBase = runGit(absRoot, ['merge-base', base, 'HEAD'])?.trim();
  if (!mergeBase) return fail(`"${base}" and HEAD have no merge base in ${absRoot}`);
  const diff = changedFiles(absRoot, base);
  if (!diff) return fail(`could not read a diff in ${absRoot}. Is it inside a git repository?`);
  // A modified or renamed file's added symbols cannot be told from old ones without its changed lines, and an
  // empty report would read as "none". An added file's symbols are all added and a deleted file has none, so
  // neither needs the lines.
  if (diff.files.some((f) => hasUnreadRanges(f) && (f.status === 'modified' || f.status === 'renamed'))) {
    return fail('git could not read the changed lines of the diff (a very large diff can exceed the buffer the read ' +
      'allows), so no added symbol was checked; narrow the diff and run again');
  }

  const currency = checkIndexCurrency(absRoot, diff.files);
  if (currency === null) {
    return fail(`could not check the index against the working tree in ${absRoot}; let it sync (or run \`codegraph sync\`) and run again`);
  }
  const stale = currencyFailure(currency);
  if (stale !== null) return fail(stale);

  const io: OrphansIO = {
    // `./` makes the path relative to the cwd, the project root, which is what
    // the diff's `--relative` paths are relative to.
    preImage: (file) => runGit(absRoot, ['show', `${mergeBase}:./${file.oldPath ?? file.path}`]),
    // Only a file whose real location is inside the project is read, as for
    // every other read that serves file content (#527). An indexed symlink
    // leading outside, which the indexer follows (#935), is refused like a
    // missing file; the text search refuses it too.
    source: (rel) => {
      const safe = validatePathWithinRoot(absRoot, rel);
      if (safe === null) return null;
      try {
        return fs.readFileSync(safe, 'utf8');
      } catch {
        return null;
      }
    },
    // The raw search runs over exactly the indexed files, without symbol
    // attribution. `truncated.files` counts missing, unreadable or refused
    // paths, which the report carries as `searchUnread`.
    search: async (pattern, maxHits) => {
      const r = await searchIndexText(absRoot, pattern, { maxHits });
      return {
        hits: r.hits,
        truncated: r.truncated.hits > 0,
        unread: r.truncated.files,
      };
    },
  };
  const store = openOrphansStore(absRoot);
  try {
    const report = { basis: diff.basis, mergeBase, ...(await findOrphans(store, diff.files, io)) };
    const output = format === 'json' ? `${jsonReport(report)}\n` : textReport(report);
    return { ok: true, output };
  } catch (err) {
    if (err instanceof GrepIndexError || err instanceof MentionSearchIncompleteError) return fail(err.message);
    throw err;
  } finally {
    store.close();
  }
}
