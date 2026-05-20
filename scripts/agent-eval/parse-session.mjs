#!/usr/bin/env node
// Parse the newest Claude Code session log for a project + its subagent logs,
// and report the tool-call breakdown (main + subagents). Works for interactive
// runs (driven via itrun.sh) — Claude Code writes full transcripts to
// ~/.claude/projects/<escaped-cwd>/<session>.jsonl with subagents/ alongside.
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const projectArg = process.argv[2];
if (!projectArg) { console.error('usage: parse-session.mjs <project-dir>'); process.exit(1); }

// Claude Code escapes the (real) cwd by replacing every "/" with "-".
const real = realpathSync(projectArg);
const escaped = real.replace(/\//g, '-');
const projDir = join(homedir(), '.claude', 'projects', escaped);
if (!existsSync(projDir)) { console.error('no session logs at', projDir); process.exit(1); }

// Newest top-level session .jsonl
const sessions = readdirSync(projDir)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, m: statSync(join(projDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (sessions.length === 0) { console.error('no .jsonl sessions in', projDir); process.exit(1); }
const sessionId = sessions[0].f.replace('.jsonl', '');

function tally(file) {
  const counts = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') counts[b.name] = (counts[b.name] || 0) + 1;
    }
  }
  return counts;
}

// Sum token usage from a transcript. The TUI's "Done (…Xk tokens…)" line only
// covers a subagent's throughput; this works for main-thread runs too and is
// consistent across both paths. `gen` = output, `fresh` = uncached input
// (input + cache_creation), `cached` = cache reads (≈free), `total` = all.
function sumTokens(file) {
  const t = { gen: 0, fresh: 0, cached: 0 };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const u = ev.message?.usage;
    if (!u) continue;
    t.gen += u.output_tokens || 0;
    t.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    t.cached += u.cache_read_input_tokens || 0;
  }
  return t;
}

const mainCounts = tally(join(projDir, sessionId + '.jsonl'));

// Subagent transcripts live under <session>/subagents/*.jsonl
const subDir = join(projDir, sessionId, 'subagents');
const subCounts = {};
let subAgentFiles = 0;
if (existsSync(subDir)) {
  for (const f of readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
    subAgentFiles++;
    const c = tally(join(subDir, f));
    for (const [k, v] of Object.entries(c)) subCounts[k] = (subCounts[k] || 0) + v;
  }
}

const fmt = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `    ${String(v).padStart(3)}  ${k}`).join('\n') || '    (none)';

console.log(`session: ${sessionId}`);
console.log(`\nMAIN thread tools:\n${fmt(mainCounts)}`);
console.log(`\nSUBAGENT tools (${subAgentFiles} subagent transcript${subAgentFiles === 1 ? '' : 's'}):\n${fmt(subCounts)}`);

const explore = subCounts['mcp__codegraph__codegraph_explore'] || mainCounts['mcp__codegraph__codegraph_explore'] || 0;
const reads = (subCounts['Read'] || 0) + (mainCounts['Read'] || 0);
const greps = (subCounts['Grep'] || 0) + (mainCounts['Grep'] || 0) + (subCounts['Bash'] || 0) + (mainCounts['Bash'] || 0);
console.log(`\nVERDICT: codegraph_explore used ${explore}x | Read ${reads} | Grep/Bash ${greps}`);

// Token totals (main + subagents), consistent across main-thread and subagent runs.
const tok = { gen: 0, fresh: 0, cached: 0 };
const addTok = (t) => { tok.gen += t.gen; tok.fresh += t.fresh; tok.cached += t.cached; };
addTok(sumTokens(join(projDir, sessionId + '.jsonl')));
if (existsSync(subDir)) {
  for (const f of readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) addTok(sumTokens(join(subDir, f)));
}
const k = (n) => (n / 1000).toFixed(1) + 'k';
console.log(`TOKENS: gen ${k(tok.gen)} | fresh-in ${k(tok.fresh)} | cached-in ${k(tok.cached)} | billable≈ ${k(tok.gen + tok.fresh)}`);
