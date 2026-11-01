/**
 * `codegraph blast` and `codegraph_blast` share this entry point: it checks
 * the options, reads the diff, walks the index and renders the report, and
 * returns what to print instead of printing it, so the CLI and the MCP tool
 * give the same answer and the same messages.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDatabasePath } from '../db';
import { blastRadius } from './blast';
import { jsonReport, markdownReport, textReport } from './blast-render';
import { openBlastStore } from './blast-store';
import { changedFiles, refExists } from './git-diff';

export interface BlastArgs {
  /** Git ref to diff against through the merge base; absent, the working tree (or the last commit). */
  base?: string;
  /** A positive integer, or `all` / `full` / `max` for the full closure. Default 2. */
  depth?: string | number;
  /** `text` (default), `markdown` or `json`. */
  format?: string;
  /** Leave out dependents reached only through questionable (name-matched) call edges. */
  strict?: boolean;
}

/** The report on success (`ok: true`), or the message to show on failure. */
export type BlastResult = { ok: true; output: string } | { ok: false; message: string };

type Format = 'text' | 'json' | 'markdown';

/** Default walk depth: direct dependents and their dependents. */
const DEFAULT_DEPTH = 2;

function fail(message: string): BlastResult {
  return { ok: false, message };
}

function resolveFormat(raw: string | undefined): Format | BlastResult {
  if (raw === undefined) return 'text';
  if (raw === 'text' || raw === 'markdown' || raw === 'json') return raw;
  return fail(`format must be text, markdown or json, got "${raw}"`);
}

/** `all`, `full` or `max` is the full closure; otherwise a number >= 1, floored. */
function resolveDepth(raw: string | number | undefined): number | BlastResult {
  if (raw === undefined) return DEFAULT_DEPTH;
  const text = String(raw);
  if (/^(all|full|max)$/i.test(text)) return Number.POSITIVE_INFINITY;
  const d = Number(text);
  if (!Number.isFinite(d) || d < 1) return fail(`depth must be a positive number or "all", got "${text}"`);
  return Math.floor(d);
}

/**
 * Run blast for the CodeGraph project at `root`. Checks run in this order:
 * format, depth, index, base ref, diff; the first that fails is the answer.
 */
export function runBlast(root: string, args: BlastArgs): BlastResult {
  const absRoot = path.resolve(root);
  const format = resolveFormat(args.format);
  if (typeof format !== 'string') return format;
  const depth = resolveDepth(args.depth);
  if (typeof depth !== 'number') return depth;

  if (!fs.existsSync(getDatabasePath(absRoot))) {
    return fail(`CodeGraph not initialized in ${absRoot}. Run \`codegraph init\` first.`);
  }
  // An unknown base is usually a shallow CI checkout, not a typo; the message says so.
  if (args.base !== undefined && !refExists(absRoot, args.base)) {
    return fail(`base ref "${args.base}" is not in this checkout. ` +
      'In CI, fetch enough history for the merge base (actions/checkout with `fetch-depth: 0`).');
  }
  const diff = changedFiles(absRoot, args.base);
  if (!diff) return fail(`could not read a diff in ${absRoot}. Is it inside a git repository?`);

  const store = openBlastStore(absRoot);
  try {
    const report = blastRadius(store, diff.files, diff.basis, depth, { strict: args.strict === true });
    // Every format ends in one newline, so the CLI can write it as is.
    const output = format === 'json' ? `${jsonReport(report)}\n`
      : format === 'markdown' ? markdownReport(report)
        : textReport(report);
    return { ok: true, output };
  } finally {
    store.close();
  }
}
