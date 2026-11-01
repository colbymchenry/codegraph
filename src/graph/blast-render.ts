/**
 * Renderers for a `BlastReport`: terminal text, a PR-comment markdown body, and JSON.
 *
 * The markdown is shaped for a pull-request comment: a headline, a test line,
 * one table of the affected areas, then collapsed sections (every dependent,
 * the per-area test signal, the test suites) and caveats about what the report
 * cannot see. The text report carries the same content without the markdown
 * scaffolding. A dependent marked `questionable` says so on its line in text
 * and markdown, and one caveat line counts the marked dependents; a report
 * with no marks renders no questionable text.
 */
import type { BlastReport } from './blast';

/** Table rows under the headline; the rest fold into one "smaller areas" row. */
const MAX_TABLE_ROWS = 6;
/** Symbols listed in the collapsed list of every dependent. */
const MAX_SYMBOLS_LISTED = 60;
/** Symbols listed per module in the text report before a "…N more" line. */
const MAX_TEXT_SYMBOLS = 25;
/** Unreached seed names listed per area in the test signal before a "…N more". */
const MAX_UNREACHED_LISTED = 8;
/** Test suite files listed in the collapsed test-suite section before a "…N more" line. */
const MAX_TEST_FILES_LISTED = 20;
/** Deleted or unindexed paths named in a caveat line. */
const MAX_CAVEAT_PATHS = 5;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function depthLabel(depth: number): string {
  return Number.isFinite(depth) ? `depth ${depth}` : 'full closure';
}

/** The glyph carried per area test state. */
const TEST_GLYPH: Record<'changed' | 'stale' | 'none' | 'na', string> = { changed: '✓', stale: '⚠', none: '✗', na: '–' };

/** JSON report. `depth: Infinity` (depth "all") serializes as null. */
export function jsonReport(r: BlastReport): string {
  return JSON.stringify(r, null, 2);
}

/** The PR-comment body: headline, test line, one table, then everything else collapsed. */
export function markdownReport(r: BlastReport): string {
  const out: string[] = [];
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);
  out.push('### blast radius');
  out.push('');
  out.push(headline(r, symbols));
  const testLine = testHeadline(r);
  if (testLine) out.push(testLine);
  if (symbols > 0) {
    out.push('');
    out.push(...impactTable(r));
  }
  out.push('');
  out.push(...detailSections(r, symbols));
  const caveats = caveatLines(r);
  if (caveats.length > 0) {
    out.push('');
    for (const line of caveats) out.push(line);
  }
  out.push('');
  out.push(`<sub>\`codegraph blast\` · ${r.basis} · ${depthLabel(r.depth)} · ${plural(r.changed.length, 'changed file')}</sub>`);
  return out.join('\n') + '\n';
}

function headline(r: BlastReport, symbols: number): string {
  const areas = plural(r.areas.length, 'area');
  if (symbols === 0) {
    return `**Nothing outside this diff depends on it.** ${areas} changed; no indexed dependents at ${depthLabel(r.depth)}.`;
  }
  return `**${areas} changed → ${plural(r.modules.length, 'area')} can be affected.** ${plural(symbols, 'dependent symbol')}, ${depthLabel(r.depth)}.`;
}

/** One sentence on whether the diff brought its tests, leading with areas no test reaches. */
function testHeadline(r: BlastReport): string | null {
  if (r.areas.length === 0) return null;
  const none = r.areas.filter((a) => a.tests === 'none');
  const stale = r.areas.filter((a) => a.tests === 'stale');
  const changed = r.areas.filter((a) => a.tests === 'changed');
  const parts: string[] = [];
  if (none.length > 0) parts.push(`**no test reaches ${none.map((a) => a.label).join(', ')}**`);
  if (stale.length > 0) {
    parts.push(`${stale.map((a) => a.label).join(', ')} ${stale.length === 1 ? 'has tests' : 'have tests'} the diff did not touch`);
  }
  if (changed.length > 0) {
    parts.push(`${plural(changed.length, 'area')} updated ${changed.length === 1 ? 'its' : 'their'} tests`);
  }
  if (parts.length === 0) return null;
  return `Tests: ${parts.join('; ')}.`;
}

/** One row per affected area with the nearest symbol to start reading at. */
function impactTable(r: BlastReport): string[] {
  const shown = r.modules.slice(0, MAX_TABLE_ROWS);
  const hidden = r.modules.slice(MAX_TABLE_ROWS);
  const areaOf = new Map<string, string>();
  for (const a of r.areas) for (const f of a.files) areaOf.set(f, a.label);
  const rows = ['| Can be affected | Symbols | Nearest hop | Reached from |', '| --- | --: | --- | --- |'];
  for (const mod of shown) {
    const nearest = mod.symbols[0];
    const hop = nearest
      ? `\`${nearest.path}:${nearest.span}\` ${nearest.name} — ${nearest.relation}, depth ${nearest.depth}${nearest.questionable ? ', questionable' : ''}`
      : '—';
    // Two names, then a count, so the column cannot outgrow the table.
    const names = [...new Set(mod.from.map((f) => areaOf.get(f) ?? f))];
    const from = names.length === 0 ? '—'
      : names.length <= 2 ? names.join(', ')
        : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
    rows.push(`| ${mod.label} | ${mod.symbols.length} | ${hop} | ${from} |`);
  }
  if (hidden.length > 0) {
    const symbols = hidden.reduce((n, m) => n + m.symbols.length, 0);
    rows.push(`| _${plural(hidden.length, 'smaller area')}_ | ${symbols} | ${hidden.slice(0, 3).map((m) => m.label).join(', ')}${hidden.length > 3 ? ', …' : ''} | see below |`);
  }
  return rows;
}

/**
 * The collapsed sections: every dependent symbol, the per-area test signal, and
 * the test suites. The blank line after each `</summary>` is required for GitHub
 * to render markdown inside a details block.
 */
function detailSections(r: BlastReport, symbols: number): string[] {
  const out: string[] = [];
  if (symbols > 0) {
    out.push('<details>');
    out.push(`<summary><strong>All ${plural(symbols, 'dependent symbol')}</strong>, grouped by area</summary>`);
    out.push('');
    let listed = 0;
    for (const mod of r.modules) {
      out.push(`**${mod.label}** — ${plural(mod.symbols.length, 'symbol')} in ${plural(mod.files.length, 'file')}`);
      out.push('');
      for (const s of mod.symbols) {
        if (listed >= MAX_SYMBOLS_LISTED) break;
        out.push(`- \`${s.path}:${s.span}\` — ${s.name} (${s.relation}, depth ${s.depth}${s.questionable ? ', questionable' : ''})`);
        listed++;
      }
      out.push('');
      if (listed >= MAX_SYMBOLS_LISTED) {
        // `listed` counts printed rows only, so `symbols - listed` is the rows
        // not printed, and with exactly the cap printed there is no such line.
        if (symbols > listed) {
          out.push(`…${plural(symbols - listed, 'further symbol')} not listed.`);
          out.push('');
        }
        break;
      }
    }
    out.push('</details>');
  }
  if (r.areas.length > 0) {
    const by = (s: string): number => r.areas.filter((a) => a.tests === s).length;
    const states = [
      by('changed') > 0 ? `${by('changed')} ✓` : '',
      by('stale') > 0 ? `${by('stale')} ⚠` : '',
      by('none') > 0 ? `${by('none')} ✗` : '',
      by('na') > 0 ? `${by('na')} –` : '',
    ].filter(Boolean).join(' · ');
    out.push('<details>');
    out.push(`<summary><strong>Test signal</strong> per changed area — ${states}</summary>`);
    out.push('');
    out.push('_Reached = a node under a test path has a resolved edge into the changed symbol. It undercounts anything called indirectly — through a CLI, a spawned process or a dynamic import — so read a low ratio as “look here”, never as a coverage gate._');
    out.push('');
    for (const a of r.areas) {
      const bits = a.behavioural > 0 ? [`${a.reached} of ${a.behavioural} reached`] : [];
      if (a.changedTestFiles.length > 0) {
        bits.push(`${plural(a.changedTestFiles.length, 'test file')} changed here: ${a.changedTestFiles.map((f) => `\`${f}\``).join(', ')}`);
      } else if (a.testFiles.length > 0) {
        bits.push(`${plural(a.testFiles.length, 'test file')} ${a.testFiles.length === 1 ? 'reaches' : 'reach'} it, none changed here`);
      } else if (a.behavioural > 0) bits.push('no test file reaches it');
      else bits.push('no function, method or class changed here');
      out.push(`- ${TEST_GLYPH[a.tests]} **${a.label}** — ${bits.join(' · ')}`);
      if (a.unreached.length > 0) {
        out.push(`  - not reached: ${a.unreached.slice(0, MAX_UNREACHED_LISTED).map((n) => `\`${n}\``).join(', ')}${a.unreached.length > MAX_UNREACHED_LISTED ? `, …${a.unreached.length - MAX_UNREACHED_LISTED} more` : ''}`);
      }
    }
    out.push('');
    out.push('</details>');
  }
  if (r.testModules.length > 0) {
    const symbolCount = r.testModules.reduce((n, m) => n + m.symbols.length, 0);
    const files = new Set(r.testModules.flatMap((m) => m.files));
    out.push('<details>');
    out.push(`<summary>${plural(files.size, 'test suite')} also ${files.size === 1 ? 'references' : 'reference'} this code</summary>`);
    out.push('');
    out.push(`${plural(symbolCount, 'symbol')}, kept out of the table so they cannot crowd out the areas a reviewer has to look at.`);
    out.push('');
    for (const f of [...files].sort().slice(0, MAX_TEST_FILES_LISTED)) out.push(`- \`${f}\``);
    if (files.size > MAX_TEST_FILES_LISTED) out.push(`- …${files.size - MAX_TEST_FILES_LISTED} more`);
    out.push('');
    out.push('</details>');
  }
  return out;
}

/**
 * What the report cannot see or vouch for: deleted and unindexed files, so "no
 * dependents" is not read as "safe", and dependents marked questionable.
 */
function caveatLines(r: BlastReport): string[] {
  const out: string[] = [];
  if (r.deleted.length > 0) {
    out.push(`⚠️ ${plural(r.deleted.length, 'deleted file')} (${r.deleted.slice(0, MAX_CAVEAT_PATHS).join(', ')}) — ` +
      'their dependents cannot be computed from a graph built at this commit, since the files are gone from it.');
  }
  if (r.unindexed.length > 0) {
    out.push(`⚠️ ${plural(r.unindexed.length, 'changed file')} not in the graph (${r.unindexed.slice(0, MAX_CAVEAT_PATHS).join(', ')}) — ` +
      'no parser claims the extension, or the index predates the file.');
  }
  // Counts every marked dependent in `impacted`, including those inside changed
  // files and test files, which the module lists leave out. Never set under strict.
  const marked = r.impacted.filter((s) => s.questionable).length;
  if (marked > 0) {
    out.push(`${plural(marked, 'dependent')} reached only through name-matched calls ${marked === 1 ? 'is' : 'are'} ` +
      `marked questionable; strict (\`--strict\`, or \`strict: true\` over MCP) leaves ${marked === 1 ? 'it' : 'them'} out.`);
  }
  return out;
}

/** Terminal report: same content as the markdown, no markdown scaffolding. */
export function textReport(r: BlastReport): string {
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);
  const lines = [
    `blast radius — ${r.basis} (${depthLabel(r.depth)})`,
    `  changed: ${plural(r.changed.length, 'file')} in ${plural(r.areas.length, 'area')}, ${plural(r.seeds.length, 'seed symbol')}`,
    `  impacted: ${plural(symbols, 'symbol')} in ${plural(r.modules.length, 'area')}`,
    '',
  ];
  for (const a of r.areas) {
    lines.push(`${TEST_GLYPH[a.tests]} ${a.label} — ${plural(a.files.length, 'changed file')}, ${a.reached}/${a.behavioural} reached by a test`);
  }
  if (r.areas.length > 0) lines.push('');
  for (const mod of r.modules) {
    lines.push(`${mod.label} — ${plural(mod.symbols.length, 'symbol')} in ${plural(mod.files.length, 'file')}`);
    for (const s of mod.symbols.slice(0, MAX_TEXT_SYMBOLS)) {
      lines.push(`  ${s.relation} ← ${s.name} (${s.path}:${s.span}) [depth ${s.depth}]${s.questionable ? ' [questionable]' : ''}`);
    }
    const hidden = mod.symbols.length - MAX_TEXT_SYMBOLS;
    if (hidden > 0) lines.push(`  …${plural(hidden, 'more symbol')}`);
    lines.push('');
  }
  if (symbols === 0) lines.push('no indexed dependents outside the changed files themselves', '');
  if (r.testModules.length > 0) {
    const files = new Set(r.testModules.flatMap((m) => m.files));
    lines.push(`${plural(files.size, 'test suite')} also ${files.size === 1 ? 'references' : 'reference'} this code (not listed)`, '');
  }
  // A terminal gets the text-presentation sign (no emoji variation selector).
  for (const line of caveatLines(r)) lines.push(line.replace(/⚠️ /, '⚠ '), '');
  return lines.join('\n').replace(/\n+$/, '\n');
}
