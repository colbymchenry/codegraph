#!/usr/bin/env node
// Parse Claude Code stream-json run log(s): tool-call sequence, token usage, and
// RESIDUAL CONTEXT OCCUPANCY — how many tokens of the context window each tool
// family's responses still occupy when the run ends.
//
// Usage: parse-run.mjs <run.jsonl> [run.t2.jsonl ...] [--brief] [--envelope] [--answer <glob>]...
//   Multiple files = one multi-turn session's segments, IN ORDER (run-all.sh
//   writes run-<label>.jsonl, run-<label>.t2.jsonl, … for a `Q1||Q2||Q3` set).
//   `--resume` does not replay prior messages, so the segments concatenate
//   cleanly and token accounting carries across the boundary.
//
//   `--brief` drops the numbered tool-call transcript and keeps everything else,
//   for harnesses that print one of these blocks per run (ab-new-vs-baseline.sh
//   at RUNS>=2 is otherwise mostly call listings).
//
//   Every run also reports EXPLORE SUFFICIENCY — each codegraph_explore call
//   bucketed by what the agent did next (see classifySufficiency) — and EXPLORE
//   ALLOCATION EFFICIENCY, the share of the bytes explore returned that belonged
//   to files the agent's final answer actually cited (see computeAllocation).
//
//   `--envelope` additionally reports how the codegraph_explore responses were
//   DIVIDED across files — the per-file share of the source envelope (#1500).
//   `--answer <glob>` (repeatable, implies --envelope) marks the files that
//   actually answer the question and reports their combined share: bar 2 of the
//   CG-1/CG-22 allocation gate. See formatEnvelope for why it parses the
//   rendered markdown rather than the CG-4 diagnostic sidecar.
//
// ---------------------------------------------------------------------------
// Why occupancy, and how it's measured
// ---------------------------------------------------------------------------
// A single-question A/B reports cost/tokens/time/tool-calls for ONE answer. It
// cannot see what issue #1500 measured: a tool response stays in the window for
// everything that follows, so it is charged against every later turn's headroom.
// That is a per-session cost our single-question runs structurally miss.
//
// Tokens are MEASURED, not estimated at bytes/4. For assistant request k,
//   ctx_k = usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// is the exact token count of that request's whole prompt. So
//   gap_k = ctx_k - ctx_{k-1}
// is exactly the tokens appended since the previous request: the previous
// assistant output (thinking + text + tool_use JSON) plus the tool_results and
// user text that followed it. We split gap_k across those blocks in proportion
// to their characters, which attributes each tool_result its measured share.
// (Measured on real runs, explore output lands near 2.3 chars/token — bytes/4
// under-counts it by ~40%, which is why the estimate isn't good enough.)
//
// Two traps this file works around, both verified against real logs:
//   * Claude Code emits ONE assistant event PER CONTENT BLOCK, all carrying the
//     same message.id and the same `usage`. Summing usage per event double-counts
//     every turn that emits both thinking and a tool_use — dedupe by message.id.
//   * The streamed `output_tokens` is a partial snapshot (observed `out=2` on a
//     turn that really generated ~1100). Never trust it; the char-proportional
//     split doesn't need it.
//
// Residual ≠ contributed. Content leaves the window two ways, and both are
// tracked: a `compact_boundary` system event (everything prior is replaced by a
// summary) and micro-compaction (ctx drops mid-run — oldest tool results are
// dropped first, so eviction is applied FIFO).
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

// Nominal window for the share-of-window column. Override for a [1m] context.
const WINDOW_TOKENS = Number(process.env.CG_WINDOW_TOKENS || 200_000);
const CHARS_PER_TOKEN_FALLBACK = 3.0;

/** Which tool family a tool_use belongs to. */
function familyOf(name) {
  if (/codegraph/.test(name)) return 'codegraph';
  if (name === 'Read' || name === 'NotebookRead') return 'read';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'Bash' || name === 'BashOutput') return 'bash';
  return 'other';
}
const FAMILIES = ['codegraph', 'read', 'search', 'bash', 'other'];
// The without-arm's way of getting the same bytes: reading and searching files.
const FILE_ACCESS = ['read', 'search', 'bash'];

// A Bash command that INVOKES the codegraph CLI, in any command position and by
// any path. Mentions are not invocations: `grep codegraph src/`, `ls .codegraph`
// and `which codegraph` all pass. Kept in step with run-all.sh's blocking hook.
const CG_CLI_RE = /(^|[;&|(]|&&|\|\||\$\(|`)\s*(?:[A-Za-z_]\w*=\S*\s+)*[\w./~-]*codegraph(\s|$)/;

const textOf = (content) =>
  Array.isArray(content) ? content.map((c) => c.text ?? (typeof c === 'string' ? c : JSON.stringify(c))).join('')
    : typeof content === 'string' ? content
      : content == null ? '' : JSON.stringify(content);

/** Characters an assistant content block occupies once it is back in the prompt. */
function assistantBlockChars(b) {
  if (b.type === 'text') return (b.text || '').length;
  if (b.type === 'thinking') return (b.thinking || '').length;
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {}).length + (b.name || '').length;
  return JSON.stringify(b).length;
}

/**
 * Parse one session (its segment files, in order) into tool + occupancy stats.
 * Exported so parse-bench-readme.mjs can aggregate without duplicating any of
 * this — deliberately NOT a separate module file: a new scripts/agent-eval/*.mjs
 * scores into the self-query eval fixture's own corpus and moves its numbers.
 */
export function parseSession(files) {
  const events = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* partial line */ }
    }
  }

  const toolCalls = [];          // display sequence
  const nameById = new Map();    // tool_use_id -> tool name
  const cliById = new Set();     // tool_use_ids that tried to run the codegraph CLI
  const counts = {};             // tool name -> calls
  // Attempts vs successes: run-all.sh's hook DENIES CLI invocations, and a
  // denied attempt puts no codegraph output in the window. Only a call that
  // actually returned content contaminates the arm.
  let initTools = null, result = null, raced = false, cliCalls = 0, cliContaminated = 0;
  const results = [];  // one `result` event per session segment (multi-turn)
  let compactions = 0;
  // Raw codegraph_explore response text, in call order. Feeds the envelope view
  // (see formatEnvelope) — kept here rather than re-parsed from the log later so
  // a multi-segment session's responses stay in one ordered list.
  const exploreTexts = [];

  // A timeline of everything appended to the context, in order. `req` entries
  // are assistant requests (carrying that request's ctx); `add` entries are
  // characters appended (assistant output blocks, tool results, user text).
  const timeline = [];
  const seenMsgIds = new Set();

  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      initTools = (ev.tools || []).filter((t) => /codegraph/.test(t));
    }
    if (ev.type === 'system' && (ev.subtype === 'compact_boundary' || ev.subtype === 'compaction')) {
      compactions++;
      timeline.push({ kind: 'compact' });
    }
    if (ev.type === 'assistant' && ev.message) {
      const id = ev.message.id;
      // One event per content block, same id + same usage: count usage once,
      // but take the content blocks from every event that carries the id.
      if (id && !seenMsgIds.has(id)) {
        seenMsgIds.add(id);
        const u = ev.message.usage || {};
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        timeline.push({ kind: 'req', ctx, out: u.output_tokens || 0 });
      }
      for (const b of ev.message.content || []) {
        timeline.push({ kind: 'add', family: null, chars: assistantBlockChars(b) });
        if (b.type === 'tool_use') {
          nameById.set(b.id, b.name);
          counts[b.name] = (counts[b.name] || 0) + 1;
          let detail = '';
          if (b.name === 'Task') detail = ` [subagent_type=${b.input?.subagent_type ?? '?'}] ${(b.input?.description ?? '').slice(0, 40)}`;
          else if (/codegraph/.test(b.name)) detail = ` ${JSON.stringify(b.input?.query ?? b.input?.task ?? b.input?.symbol ?? '').slice(0, 60)}`;
          else if (b.name === 'Bash') {
            detail = ` ${(b.input?.command ?? '').slice(0, 50)}`;
            // An arm with no codegraph MCP can still shell out to the CLI — the
            // target repo carries the .codegraph/ index and the binary is on
            // PATH. That silently turns a "without" arm into codegraph-over-CLI.
            if (CG_CLI_RE.test(b.input?.command ?? '')) { cliCalls++; cliById.add(b.id); }
          }
          else if (b.name === 'Read') detail = ` ${(b.input?.file_path ?? '').split('/').slice(-1)[0]}`;
          toolCalls.push(`${b.name}${detail}`);
        }
      }
    }
    if (ev.type === 'user' && ev.message) {
      const content = ev.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            const t = textOf(b.content);
            // MCP cold-start race: the agent fired before `serve --mcp` had
            // registered its tools, so it floundered into grep/Read. That
            // measures startup latency, not steady-state value — flag it.
            if (/No such tool available/.test(t)) raced = true;
            // A CLI attempt that came back an error was blocked (by the hook, or
            // by the binary being genuinely absent) and put nothing in context.
            if (cliById.has(b.tool_use_id) && !b.is_error) cliContaminated++;
            const name = nameById.get(b.tool_use_id) || '';
            if (/codegraph_explore/.test(name) && !b.is_error) exploreTexts.push(t);
            timeline.push({ kind: 'add', family: familyOf(name), chars: t.length, tool: name });
          } else {
            timeline.push({ kind: 'add', family: null, chars: textOf([b]).length });
          }
        }
      } else if (typeof content === 'string') {
        timeline.push({ kind: 'add', family: null, chars: content.length });
      }
    }
    if (ev.type === 'result') { result = ev; results.push(ev); }
  }

  // ---- Pass 1: chars/token, calibrated on tool-result-dominated gaps. ------
  // Splitting a gap in proportion to characters over-attributes to tool results
  // whenever the assistant's own output is under-represented in the transcript
  // (redacted/empty thinking blocks are the common case — a gap whose only
  // visible chars were a 73-char tool_result charged it the whole 830-token
  // delta, 5.5 tok/char). So calibrate the ratio on gaps that are ≥80% tool
  // result by characters, then price every result at that ratio.
  const reqIdx = timeline.map((t, i) => (t.kind === 'req' ? i : -1)).filter((i) => i >= 0);
  const gaps = [];
  for (let k = 1; k < reqIdx.length; k++) {
    const prev = timeline[reqIdx[k - 1]], cur = timeline[reqIdx[k]];
    let chars = 0, toolChars = 0, compacted = false;
    const byFamily = {};
    for (let i = reqIdx[k - 1] + 1; i < reqIdx[k]; i++) {
      const t = timeline[i];
      if (t.kind === 'compact') { compacted = true; continue; }
      if (t.kind !== 'add') continue;
      chars += t.chars;
      if (t.family) { toolChars += t.chars; byFamily[t.family] = (byFamily[t.family] || 0) + t.chars; }
    }
    gaps.push({ delta: cur.ctx - prev.ctx, chars, toolChars, byFamily, compacted });
  }
  const clean = gaps.filter((g) => !g.compacted && g.delta > 0 && g.chars > 500 && g.toolChars / g.chars >= 0.8);
  // A gap where the window also SHED content has a delta far below what was
  // added, which reads as absurdly dense text and would drag the whole run's
  // ratio with it. Shedding can only push a gap's chars/token UP, so take the
  // lower median as the honest centre and drop anything well above it, then
  // pool the survivors. (On runs that never shed, every ratio is within a few
  // percent of the others and this changes nothing.)
  const ratios = clean.map((g) => g.toolChars / g.delta).sort((a, b) => a - b);
  const lowerMedian = ratios.length ? ratios[Math.floor((ratios.length - 1) / 2)] : 0;
  let sumD = 0, sumC = 0;
  for (const g of clean) {
    if (lowerMedian > 0 && g.toolChars / g.delta > lowerMedian * 1.5) continue;  // shed
    sumD += g.delta; sumC += g.toolChars;
  }
  if (sumD === 0) { // no clean gap — fall back to every growing gap, all chars
    for (const g of gaps) if (!g.compacted && g.delta > 0 && g.chars > 0) { sumD += g.delta; sumC += g.chars; }
  }
  const charsPerToken = sumD > 0 ? sumC / sumD : CHARS_PER_TOKEN_FALLBACK;
  const calibrated = sumD > 0;

  // How far a single result's token density strays from the run-level ratio.
  // On a gap that is almost entirely one tool result, `delta` IS that result's
  // token count, so |chars/ratio - delta| / delta is the attribution error for
  // that result. The median over such gaps is the metric's real error bar.
  const errs = [];
  for (const g of gaps) {
    if (g.compacted || g.delta <= 0 || g.chars <= 500) continue;
    if (g.toolChars / g.chars < 0.95) continue;
    errs.push(Math.abs(g.toolChars / charsPerToken - g.delta) / g.delta);
  }
  errs.sort((a, b) => a - b);
  const dispersion = errs.length ? errs[(errs.length - 1) >> 1] : null;

  // ---- Pass 2: attribute gap tokens, then apply evictions FIFO. ------------
  const contributed = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  const resultChars = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  const resultCount = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  for (const t of timeline) if (t.kind === 'add' && t.family) { resultChars[t.family] += t.chars; resultCount[t.family]++; }

  let queue = [];        // resident contributions, oldest first
  let evicted = 0;
  const evict = (tokens) => {
    let left = tokens;
    while (left > 0 && queue.length) {
      const head = queue[0];
      if (head.tokens <= left) { left -= head.tokens; evicted += head.tokens; queue.shift(); }
      else { head.tokens -= left; evicted += left; left = 0; }
    }
  };

  for (const g of gaps) {
    if (g.compacted) {
      // Everything before the boundary is gone; the summary replaces it.
      evicted += queue.reduce((s, q) => s + q.tokens, 0);
      queue = [];
    }
    let toolTokens = 0;
    for (const [fam, ch] of Object.entries(g.byFamily)) {
      const tok = ch / charsPerToken;
      toolTokens += tok;
      contributed[fam] += tok;
      queue.push({ family: fam, tokens: tok });
    }
    // The gap grew by `delta`; the tool results account for `toolTokens` of it.
    // A shortfall means the window also shed content — micro-compaction drops
    // the OLDEST tool results first, so evict FIFO. The tolerance keeps
    // attribution noise (a run-level ratio priced against one gap's delta,
    // typically ±2%) from reading as an eviction; real shedding is thousands.
    const shortfall = toolTokens - g.delta;
    if (!g.compacted && shortfall > Math.max(200, toolTokens * 0.05)) evict(shortfall);
  }

  const residual = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  for (const q of queue) residual[q.family] += q.tokens;

  const ctxFinal = reqIdx.length ? timeline[reqIdx[reqIdx.length - 1]].ctx : 0;
  // The FIRST request's prompt is system + tool schemas + the question, before
  // any tool has answered. Differencing the arms' ctxBase prices codegraph's
  // FIXED occupancy — its tool schema and MCP `initialize` instructions — which
  // it pays whether or not the agent ever calls it.
  const ctxBase = reqIdx.length ? timeline[reqIdx[0]].ctx : 0;
  // Multi-turn: duration/cost/tokens are per-segment, so sum them. `result.usage`
  // is cumulative WITHIN a segment (verified: its in+cache+out equals the sum of
  // that segment's per-request prompts), so summing segments is correct and does
  // NOT double-count. It is a "tokens processed" figure — every request re-counts
  // the whole prefix — which is exactly why it can't answer the occupancy question.
  const sumUsage = (k) => results.reduce((s, r) => s + (r.usage?.[k] || 0), 0);
  const processed = sumUsage('input_tokens') + sumUsage('cache_read_input_tokens')
    + sumUsage('cache_creation_input_tokens') + sumUsage('output_tokens');

  return {
    files, toolCalls, counts, initTools, result, results, raced, cliCalls, cliContaminated,
    exploreTexts,
    // What the agent did after each explore — the free sufficiency signal (CG-8).
    sufficiency: classifySufficiency(events),
    // How much of what explore returned the answer actually drew on (CG-9).
    allocation: computeAllocation(exploreTexts, finalAnswerText(events)),
    ok: results.length > 0 && results.every((r) => r.subtype === 'success'),
    turns: reqIdx.length,
    tools: toolCalls.filter((t) => !t.startsWith('ToolSearch')).length,
    reads: counts.Read || 0,
    grep: (counts.Grep || 0) + (counts.Glob || 0),
    cg: Object.entries(counts).filter(([n]) => /codegraph/.test(n)).reduce((s, [, v]) => s + v, 0),
    dur: results.reduce((s, r) => s + (r.duration_ms || 0), 0) / 1000,
    cost: results.reduce((s, r) => s + (r.total_cost_usd || 0), 0),
    processed,
    occupancy: {
      ctxFinal, ctxBase, windowTokens: WINDOW_TOKENS,
      charsPerToken, calibrated, compactions, dispersion, evicted: Math.round(evicted),
      residual: Object.fromEntries(FAMILIES.map((f) => [f, Math.round(residual[f])])),
      contributed: Object.fromEntries(FAMILIES.map((f) => [f, Math.round(contributed[f])])),
      chars: resultChars, results: resultCount,
      residualFileAccess: Math.round(FILE_ACCESS.reduce((s, f) => s + residual[f], 0)),
      contributedFileAccess: Math.round(FILE_ACCESS.reduce((s, f) => s + contributed[f], 0)),
      charsFileAccess: FILE_ACCESS.reduce((s, f) => s + resultChars[f], 0),
    },
  };
}

/** The occupancy block, as printed under a run and reused by the aggregator. */
export function formatOccupancy(s, indent = '  ') {
  const o = s.occupancy;
  const n = (x) => x.toLocaleString('en-US');
  const pctCtx = (t) => (o.ctxFinal > 0 ? ((t / o.ctxFinal) * 100).toFixed(1) : '0.0');
  const pctWin = (t) => ((t / o.windowTokens) * 100).toFixed(1);
  const rows = [];
  const row = (label, tok, chars, results) => rows.push(
    `${indent}  ${label.padEnd(18)}${(n(tok) + ' tok').padStart(12)}  ${(pctCtx(tok) + '%').padStart(6)} of ctx  ` +
    `${(pctWin(tok) + '%').padStart(6)} of ${Math.round(o.windowTokens / 1000)}k win` +
    (chars !== undefined ? `   (${n(chars)} chars, ${results} result${results === 1 ? '' : 's'})` : '')
  );
  const out = [`${indent}Residual context occupancy at end of run:`];
  out.push(`${indent}  ${'final context'.padEnd(18)}${(n(o.ctxFinal) + ' tok').padStart(12)}  ${(pctWin(o.ctxFinal) + '%').padStart(6)} of ${Math.round(o.windowTokens / 1000)}k window`);
  row('codegraph', o.residual.codegraph, o.chars.codegraph, o.results.codegraph);
  row('Read', o.residual.read, o.chars.read, o.results.read);
  row('Grep/Glob', o.residual.search, o.chars.search, o.results.search);
  row('Bash', o.residual.bash, o.chars.bash, o.results.bash);
  row('→ file-access', o.residualFileAccess, o.charsFileAccess,
    o.results.read + o.results.search + o.results.bash);
  row('other tools', o.residual.other, o.chars.other, o.results.other);
  const toolTotal = Object.values(o.residual).reduce((a, b) => a + b, 0);
  row('base (prompt+prose)', Math.max(0, o.ctxFinal - toolTotal));
  out.push(`${indent}  ${'  of which fixed'.padEnd(18)}${(n(o.ctxBase) + ' tok').padStart(12)}  system + tool schemas + question, before any tool answered`);
  out.push(...rows);
  const dropped = o.contributed.codegraph + o.contributedFileAccess + o.contributed.other
    - (o.residual.codegraph + o.residualFileAccess + o.residual.other);
  out.push(
    `${indent}  measure: ${o.charsPerToken.toFixed(2)} chars/tok ${o.calibrated ? 'measured' : '(FALLBACK — no clean gap to calibrate on)'}` +
    (o.dispersion !== null ? ` ±${(o.dispersion * 100).toFixed(1)}%` : '') +
    ` · turns ${s.turns} · compactions ${o.compactions}` +
    (o.evicted > 0 || dropped > 1 ? ` · evicted ${n(o.evicted)} tok` : '')
  );
  return out.join('\n');
}

/**
 * One codegraph_explore response, split into the per-file source sections the
 * allocator divided its budget across.
 *
 * Parsed out of the RENDERED MARKDOWN, not the CG-4 diagnostic sidecar: the
 * sidecar only exists on a post-CG-4 build, so it cannot measure a baseline arm.
 * The markdown parse is the only instrument that measures both arms of a
 * new-vs-baseline A/B the same way. Both the envelope view and the allocation
 * metric key off this one parse.
 *
 * Returns `{ envelope, files: [{ path, chars, symbols }] }`, where `symbols` are
 * the names the section header lists — filtered to the ones the file DEFINES.
 * The header renders `name(kind)` for every node in the shipped clusters, and
 * that includes edge-kind pseudo-entries for call sites (`mutateElement(calls)`
 * on a file that merely calls it). Attributing a file from those would credit
 * every caller of a cited symbol — measured on a real excalidraw run, it marked
 * `dragElements.ts` used because the answer named `mutateElement`.
 */
/** NodeKind values that mean "this file defines it" (src/types.ts, less file/import/export). */
const DEFINING_KINDS = new Set([
  'module', 'class', 'struct', 'interface', 'trait', 'protocol', 'function', 'method',
  'property', 'field', 'variable', 'constant', 'enum', 'enum_member', 'type_alias',
  'namespace', 'route', 'component',
]);
export function parseExploreCall(text) {
  const src = String(text ?? '');
  const re = /^\*\*`([^`]+)`\*\*(.*)$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(src)) !== null) marks.push({ path: m[1], header: m[2] || '', at: m.index });
  if (!marks.length) return { envelope: 0, files: [] };
  // Sections run to the next header, or to the trailing guidance quote.
  const tail = src.indexOf('\n> ', marks[marks.length - 1].at);
  const end = tail === -1 ? src.length : tail;
  const files = marks.map((mark, i) => ({
    path: mark.path,
    chars: (i + 1 < marks.length ? marks[i + 1].at : end) - mark.at,
    // `mutateElement(calls), onFinished(variable), +32 more` → the defined ones.
    symbols: [...mark.header.matchAll(/([A-Za-z_$][\w$.]*)\(([a-z_]+)\)/g)]
      .filter((s) => DEFINING_KINDS.has(s[2]))
      .map((s) => ({ name: s[1], kind: s[2] })),
  }));
  return { envelope: files.reduce((s, f) => s + f.chars, 0), files };
}

/**
 * How the codegraph_explore responses the agent received were DIVIDED across
 * files — the per-file share of the source envelope (#1500 / epic CG-1).
 *
 * `answerGlobs` marks the files that actually answer the question; the summary
 * reports their combined share, which is bar 2 of the CG-1/CG-22 gate. That is
 * HAND-SPECIFIED ground truth; the allocation metric below infers the same
 * intersection from the agent's own answer instead.
 */
export function formatEnvelope(exploreTexts, answerGlobs = [], indent = '  ') {
  // `tools/cache/**` -> /^tools\/cache\/.*$/ . Same semantics as probe-allocation.
  // The `**` sentinel is written as an escape, never a literal NUL byte — a raw
  // one makes git treat this whole script as binary and costs every future diff.
  const glob2re = (glob) => {
    const S = '\\u0000';
    const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, S).replace(/\*/g, '[^/]*').replaceAll(S, '.*');
    return new RegExp(`^${body}$`);
  };
  const answerRes = answerGlobs.map(glob2re);
  const isAnswer = (p) => answerRes.some((re) => re.test(p));

  // Share is over the sum of the per-file sections, i.e. of the source envelope
  // the allocator divides.
  const pooled = new Map();
  let envelope = 0;
  for (const text of exploreTexts) {
    for (const f of parseExploreCall(text).files) {
      pooled.set(f.path, (pooled.get(f.path) ?? 0) + f.chars);
      envelope += f.chars;
    }
  }
  const ranked = [...pooled.entries()]
    .map(([path, chars]) => ({ path, chars, share: envelope ? chars / envelope : 0, answer: isAnswer(path) }))
    .sort((a, b) => b.chars - a.chars);
  const answerChars = ranked.filter((r) => r.answer).reduce((s, r) => s + r.chars, 0);
  const pct = (f) => `${(f * 100).toFixed(1)}%`;

  const out = [];
  out.push(`${indent}Explore envelope: ${envelope.toLocaleString('en-US')} chars over ${exploreTexts.length} response(s)`);
  if (answerGlobs.length) {
    out.push(`${indent}  answer-set share: ${pct(envelope ? answerChars / envelope : 0)} | top file answers: ${ranked[0]?.answer ?? false}`);
  }
  for (const f of ranked.slice(0, 12)) {
    out.push(`${indent}  ${f.answer ? '*' : ' '} ${pct(f.share).padStart(6)} ${String(f.chars).padStart(6)}  ${f.path}`);
  }
  if (ranked.length > 12) out.push(`${indent}    … ${ranked.length - 12} more files`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Explore allocation efficiency (CG-9)
// ---------------------------------------------------------------------------
// The envelope view above needs a human to say which files answer the question
// (`--answer <glob>`). This one reads that off the AGENT'S OWN FINAL ANSWER and
// reports a single number every run:
//
//   allocation efficiency = bytes explore returned for files the answer drew on
//                           ─────────────────────────────────────────────────
//                           all bytes explore returned
//
// That is the #1500 defect as a number. On the CG-1 baseline self-query it sat
// around 16–30%: one correct file, one marginal, three pure noise.
//
// ATTRIBUTION IS IMPERFECT AND THE ERROR IS ONE-SIDED. An agent can use a file's
// source to rule it out, or to build a mental model, and never cite it — that
// reads as waste. So this is a RELATIVE metric: valid for comparing two builds
// on the SAME question, not as an absolute claim about how much of an envelope
// earned its place. Quoting it as an absolute efficiency figure is a misuse.
//
// Two citation channels, deliberately ranked so the weaker one is separable:
//   * PATH — the answer names the file (`lib/response.js:126-220`, or the bare
//     `utils.js:225` agents drop into prose). Strong, and reported on its own as
//     the conservative floor.
//   * SYMBOL — the answer cites a symbol in a code span and only that file's
//     section header lists it. Catches answers written entirely in symbol names.
//     Guarded: a name carried by ≥3 of the returned files is too generic to
//     attribute and is dropped, or `send`/`get` would mark half the envelope
//     used and bias the metric optimistic — the one direction it must not lean.

/** Symbol tokens too common in prose/code spans to attribute a file from. */
const SYMBOL_STOPWORDS = new Set([
  'function', 'return', 'const', 'this', 'true', 'false', 'null', 'void', 'undefined',
  'string', 'object', 'number', 'boolean', 'array', 'class', 'import', 'export',
  'async', 'await', 'default', 'type', 'value', 'name', 'data', 'self', 'super',
  'else', 'then', 'case', 'from', 'with', 'when', 'where', 'that', 'they', 'this',
]);
/** A name on this many of the returned files stops identifying any one of them. */
const SYMBOL_AMBIGUITY_LIMIT = 3;
/** Below this length a token is far more likely prose than a symbol citation. */
const MIN_SYMBOL_LEN = 4;

/**
 * What the agent's final answer CITES: file paths, and the identifiers it puts
 * in code spans. `extensions` are the file extensions actually present in the
 * envelope — the gate that lets `utils.js:225` through as a file citation while
 * rejecting `res.send` and `mime.contentType`, which are the same token shape.
 */
export function answerCitations(text, extensions = new Set()) {
  const src = String(text ?? '');
  const paths = new Set();
  // Dotted path with at least one directory: `lib/response.js:126-220`.
  for (const m of src.matchAll(/(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z]\w*/g)) paths.add(m[0]);
  // Bare basename, only when its extension is one the envelope actually shipped.
  for (const m of src.matchAll(/\b[\w@+-]+\.[A-Za-z]\w*/g)) {
    const ext = m[0].slice(m[0].lastIndexOf('.') + 1).toLowerCase();
    if (extensions.has(ext)) paths.add(m[0]);
  }
  // Identifiers inside code spans. Prose mentions are excluded on purpose: a
  // backtick is the agent marking the token as code, which is the whole signal.
  const symbols = new Set();
  for (const span of src.matchAll(/`([^`\n]+)`/g)) {
    for (const t of span[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
      const tok = t[0];
      if (tok.length >= MIN_SYMBOL_LEN && !SYMBOL_STOPWORDS.has(tok.toLowerCase())) symbols.add(tok);
    }
  }
  return { paths: [...paths], symbols };
}

/**
 * Allocation efficiency over one session's explore responses and its final
 * answer(s). Per call AND pooled over the run — a run-level number alone hides
 * the common shape where call 1 is on target and call 3 is pure noise.
 */
export function computeAllocation(exploreTexts, answerText) {
  const calls = exploreTexts.map(parseExploreCall).filter((c) => c.files.length);
  const extensions = new Set();
  for (const c of calls) {
    for (const f of c.files) {
      const dot = f.path.lastIndexOf('.');
      if (dot > 0) extensions.add(f.path.slice(dot + 1).toLowerCase());
    }
  }
  const cited = answerCitations(answerText, extensions);

  // symbol -> the returned files whose header lists it as DEFINED. A `variable`
  // is usually an import binding (`var compileETag = require('./utils')…`), so
  // when the same name is also a real definition somewhere in the envelope, the
  // definition wins and the aliasing file is not credited.
  const symbolFiles = new Map();
  for (const c of calls) {
    for (const f of c.files) {
      for (const s of f.symbols) {
        if (!symbolFiles.has(s.name)) symbolFiles.set(s.name, { strong: new Set(), weak: new Set() });
        const owners = symbolFiles.get(s.name);
        (s.kind === 'variable' || s.kind === 'constant' ? owners.weak : owners.strong).add(f.path);
      }
    }
  }
  const ownersOf = (name) => {
    const o = symbolFiles.get(name);
    return o ? (o.strong.size ? o.strong : o.weak) : null;
  };

  // `lib/response.js` is cited by `lib/response.js`, by `response.js`, and by an
  // absolute path ending in it — samePath already encodes exactly that.
  const viaPath = (path) => cited.paths.some((p) => samePath(path, p));
  const viaSymbol = (path) => {
    for (const s of cited.symbols) {
      const owners = ownersOf(s);
      if (owners && owners.size < SYMBOL_AMBIGUITY_LIMIT && owners.has(path)) return s;
    }
    return null;
  };

  const verdict = new Map();  // path -> { via, symbol }
  const judge = (path) => {
    if (!verdict.has(path)) {
      if (viaPath(path)) verdict.set(path, { via: 'path' });
      else {
        const s = viaSymbol(path);
        verdict.set(path, s ? { via: 'symbol', symbol: s } : { via: null });
      }
    }
    return verdict.get(path);
  };

  const perCall = calls.map((c, i) => {
    const files = c.files.map((f) => ({ ...f, ...judge(f.path) }));
    const used = files.filter((f) => f.via).reduce((s, f) => s + f.chars, 0);
    const usedPath = files.filter((f) => f.via === 'path').reduce((s, f) => s + f.chars, 0);
    return {
      call: i + 1, envelope: c.envelope, used, usedPath, files,
      efficiency: c.envelope ? used / c.envelope : 0,
    };
  });

  // Pooled: a file returned twice is charged twice, because it occupied the
  // window twice. Same accounting as formatEnvelope.
  const pooled = new Map();
  let envelope = 0;
  for (const c of perCall) {
    for (const f of c.files) {
      const prev = pooled.get(f.path) ?? { path: f.path, chars: 0, calls: 0, via: f.via, symbol: f.symbol };
      prev.chars += f.chars; prev.calls++;
      pooled.set(f.path, prev);
      envelope += f.chars;
    }
  }
  const files = [...pooled.values()].sort((a, b) => b.chars - a.chars);
  const used = files.filter((f) => f.via).reduce((s, f) => s + f.chars, 0);
  const usedPath = files.filter((f) => f.via === 'path').reduce((s, f) => s + f.chars, 0);
  return {
    calls: perCall, files, envelope, used, usedPath,
    efficiency: envelope ? used / envelope : 0,
    efficiencyPath: envelope ? usedPath / envelope : 0,
    filesReturned: files.length,
    filesUsed: files.filter((f) => f.via).length,
    hasAnswer: String(answerText ?? '').trim().length > 0,
  };
}

/**
 * Every answered codegraph_explore response in a transcript, in call order.
 * parseSession collects these as it walks the timeline; this is the same list
 * for callers that only have the raw events (parse-session.mjs).
 */
export function collectExploreTexts(events) {
  const nameById = new Map();
  const texts = [];
  for (const ev of events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') nameById.set(b.id, b.name);
      else if (b.type === 'tool_result' && !b.is_error
        && /codegraph_explore/.test(nameById.get(b.tool_use_id) || '')) texts.push(textOf(b.content));
    }
  }
  return texts;
}

/**
 * The final answer a session produced. Headless stream-json carries it on the
 * `result` event (one per resumed segment, all of which are answers); an
 * interactive transcript has none, so fall back to the LAST assistant text of
 * the main thread — intermediate narration would flood the citation set.
 */
export function finalAnswerText(events) {
  const answers = events.filter((e) => e.type === 'result' && typeof e.result === 'string').map((e) => e.result);
  if (answers.length) return answers.join('\n\n');
  let last = '';
  for (const ev of events) {
    if (ev.type !== 'assistant' || (ev.parent_tool_use_id ?? null) !== null) continue;
    const text = (ev.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    if (text.trim()) last = text;
  }
  return last;
}

/** The allocation block, as printed under a run and reused by aggregators. */
export function formatAllocation(s, indent = '  ') {
  const a = s.allocation;
  if (!a || !a.calls.length) return `${indent}Explore allocation: no codegraph_explore responses with source sections`;
  const pct = (f) => `${(f * 100).toFixed(1)}%`;
  const n = (x) => x.toLocaleString('en-US');
  const out = [
    `${indent}Explore allocation — share of returned bytes the answer used ` +
    `(${a.calls.length} call${a.calls.length === 1 ? '' : 's'}, ${a.filesReturned} file${a.filesReturned === 1 ? '' : 's'}):`,
    `${indent}  efficiency ${pct(a.efficiency).padStart(6)}  ${n(a.used)} of ${n(a.envelope)} chars` +
    `   (${a.filesUsed}/${a.filesReturned} files cited; path-cited alone ${pct(a.efficiencyPath)})`,
  ];
  if (!a.hasAnswer) out.push(`${indent}  !! no final answer text found — efficiency is not meaningful for this run`);
  for (const c of a.calls) {
    out.push(`${indent}  call ${c.call}: ${pct(c.efficiency).padStart(6)}  ${n(c.used)}/${n(c.envelope)} chars` +
      `  ${c.files.filter((f) => f.via).length}/${c.files.length} files`);
  }
  for (const f of a.files.slice(0, 12)) {
    const share = a.envelope ? f.chars / a.envelope : 0;
    const why = f.via === 'symbol' ? `symbol \`${f.symbol}\`` : f.via === 'path' ? 'path' : '—';
    out.push(`${indent}  ${f.via ? '*' : ' '} ${pct(share).padStart(6)} ${String(f.chars).padStart(6)}  ${f.path}  ${why}`);
  }
  if (a.files.length > 12) out.push(`${indent}    … ${a.files.length - 12} more files`);
  out.push(`${indent}  note: relative metric — attribution is by citation, so compare builds on the same question, not absolutes.`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Explore sufficiency (CG-8)
// ---------------------------------------------------------------------------
// The agent's NEXT action after a codegraph_explore is free ground truth about
// whether that response was enough. The buckets are chosen so each one maps to
// a distinct fix:
//
//   another codegraph call      insufficient — the response did not answer
//   Read of a file we RETURNED  allocation bug — right file, wrong bytes
//   Read of a file we did NOT   recall bug — the file never surfaced
//   Grep/Glob                   recall bug (weaker: the agent is still hunting)
//   anything else / no tool     sufficient — the agent moved on
//
// Three rules keep this honest:
//   * Only a call issued in a LATER assistant message counts as a reaction. A
//     Read fired in the same message as the explore was issued before its
//     response existed, so it cannot be a verdict on it (those are counted
//     separately as `concurrent`).
//   * ToolSearch/TodoWrite are stepped over: loading a deferred tool schema or
//     ticking a checklist says nothing about the response.
//   * SUBAGENT CALLS ARE A SEPARATE THREAD. Claude Code interleaves a subagent's
//     tool calls into the same stream, tagged `parent_tool_use_id` — verified on
//     a real run where a delegated search's greps landed between the parent's
//     own calls. Reactions are matched within one thread, or the subagent's
//     first grep would be scored as the parent's verdict on an explore it never
//     saw.
//
// A delegation (`Agent`/`Task`) is judged by what the SUBAGENT did first, since
// that thread is right there in the transcript. Scoring the delegation itself as
// "moved on" would have called this run sufficient while the subagent was off
// grepping for the file — the one direction of error a tuning metric must not
// have. A delegation that never runs a tool stays "moved on".

/** Tools that carry no signal about whether the previous response was enough. */
const TRANSPARENT_TOOLS = new Set(['ToolSearch', 'TodoWrite']);
/** Tools that hand the work to a subagent whose thread we then judge instead. */
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);

/** Buckets, worst → best. Labels double as the summary rows. */
export const SUFFICIENCY = [
  ['explore_again', 'explore again', 'insufficient: did not answer'],
  ['read_returned', 'Read a file we returned', 'allocation: right file, wrong bytes'],
  ['read_missed', 'Read a file we did not return', 'recall: file never surfaced'],
  ['search', 'Grep/Glob', 'recall (weak): still hunting for the file'],
  ['sufficient', 'moved on / answered', 'sufficient'],
];
const SUFFICIENCY_KEYS = SUFFICIENCY.map(([k]) => k);

// Shell equivalents of Read and of Grep. Both arms have Bash, and on small
// repos an agent reaches for `sed -n 100,200p file` as readily as for Read —
// counting only the Read tool would score those explores as sufficient.
const BASH_READ_RE = /(?:^|[;&|]|\$\(|`)\s*(?:sudo\s+)?(?:cat|bat|head|tail|less|more|nl|sed|awk)\s+([^\n|;&]*)/;
const BASH_SEARCH_RE = /(?:^|[;&|]|\$\(|`)\s*(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ag|ack|find|fd|ls|tree)\b/;

/** What a Bash command is really doing, as far as retrieval is concerned. */
function bashIntent(cmd) {
  const c = String(cmd || '');
  // A heredoc or a redirect is WRITING a file — `cat <<EOF > x` must not read
  // as a Read.
  if (!/<</.test(c) && !/>\s*\S/.test(c)) {
    const m = BASH_READ_RE.exec(c);
    if (m) {
      // Drop flags and numeric arguments (`sed -n '100,200p' lib/x.js`), then
      // take the last path-shaped token.
      const args = m[1].split(/\s+/).filter((a) => a && !a.startsWith('-') && !/^['"]?\d/.test(a));
      const path = args.reverse().find((a) => /[/.]/.test(a));
      if (path) return { kind: 'read', path: path.replace(/^['"]|['"]$/g, '') };
    }
  }
  if (BASH_SEARCH_RE.test(c)) return { kind: 'search' };
  return null;
}

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
/** Same file, with either side repo-relative and the other absolute. */
function samePath(a, b) {
  const x = normPath(a), y = normPath(b);
  if (!x || !y) return false;
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}

/**
 * The files whose SOURCE an explore response returned — its per-file sections,
 * which start with the unique ``**` `` marker (FILE_SECTION_PREFIX in
 * src/mcp/tools.ts). formatEnvelope keys off the same marker; it needs the byte
 * offsets too, which is why it re-scans rather than calling this.
 */
export function exploreReturnedFiles(text) {
  return [...String(text ?? '').matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1]);
}

// Every path-shaped token anywhere in a response — flow steps, blast radius,
// symbol lists. A file in here but NOT in the returned set was POINTED AT and
// not delivered, which is a different (and more damning) miss than one the
// response never mentioned at all.
const PATH_TOKEN_RE = /(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z]\w*/g;

/**
 * The reaction one action represents, given what the explore had returned.
 * `earlier` is what PREVIOUS explores in the same thread returned: a re-read of
 * a file we already shipped is an allocation miss wherever it was shipped, and
 * filing it as recall would point the fix at the wrong end of the pipeline.
 */
function reactionOf(action, returned, mentioned, earlier = []) {
  const { name, input } = action;
  const readOf = (path, prefix) => {
    const base = normPath(path).split('/').pop() || String(path ?? '');
    if (returned.some((r) => samePath(path, r))) return { bucket: 'read_returned', next: `${prefix}Read ${base}` };
    if (earlier.some((r) => samePath(path, r))) return { bucket: 'read_returned', next: `${prefix}Read ${base} (returned by an earlier explore)` };
    const named = mentioned.some((m) => samePath(path, m));
    return { bucket: 'read_missed', next: `${prefix}Read ${base}${named ? ' (named, not returned)' : ''}`, named };
  };
  if (/codegraph/.test(name)) return { bucket: 'explore_again', next: name.replace(/^mcp__[^_]*__/, '') };
  if (name === 'Read' || name === 'NotebookRead') return readOf(input.file_path ?? input.notebook_path, '');
  if (name === 'Grep' || name === 'Glob') return { bucket: 'search', next: name };
  if (name === 'Bash') {
    const intent = bashIntent(input.command);
    if (intent?.kind === 'read') return readOf(intent.path, 'Bash ');
    if (intent?.kind === 'search') return { bucket: 'search', next: 'Bash search' };
  }
  return { bucket: 'sufficient', next: name };
}

/** Is this action one of the ways an agent gets file bytes into its head? */
const isFileAccess = (a) =>
  a.name === 'Read' || a.name === 'NotebookRead' || a.name === 'Grep' || a.name === 'Glob'
  || (a.name === 'Bash' && bashIntent(a.input?.command) !== null);

/**
 * Bucket every answered codegraph_explore call in a transcript by what the
 * agent did next. Takes the raw JSONL events so it serves both transcript
 * shapes: stream-json runs (parse-run.mjs) and interactive session logs
 * (parse-session.mjs) — both emit one assistant event per content block with
 * `message.id`, and tool results as `tool_result` blocks in user messages.
 */
export function classifySufficiency(events) {
  // One action list PER THREAD: 'main', plus one per subagent (keyed by the
  // delegating tool_use id, which is what `parent_tool_use_id` carries).
  const threads = new Map();
  const nameById = new Map();
  const textById = new Map();    // explore tool_use_id -> response text
  for (const ev of events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    const thread = ev.parent_tool_use_id ?? 'main';
    if (ev.type === 'assistant') {
      if (!threads.has(thread)) threads.set(thread, []);
      const list = threads.get(thread);
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        nameById.set(b.id, b.name);
        // No message.id (never seen on a real log) degrades to "every call is
        // its own message", i.e. same-message calls read as reactions.
        list.push({ msgId: ev.message.id || `#${thread}-${list.length}`, id: b.id, name: b.name, input: b.input || {} });
      }
    } else if (ev.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const name = nameById.get(b.tool_use_id) || '';
        if (/codegraph_explore/.test(name) && !b.is_error) textById.set(b.tool_use_id, textOf(b.content));
      }
    }
  }

  const calls = [];
  let errors = 0, concurrent = 0;
  // What a delegation really did: the subagent's first substantive call. A
  // nested delegation is skipped rather than followed, so a subagent that only
  // spawns another subagent leaves the call as "moved on".
  const throughDelegation = (action, returned, mentioned, earlier) => {
    const first = (threads.get(action.id) || []).find((x) => !TRANSPARENT_TOOLS.has(x.name) && !DELEGATION_TOOLS.has(x.name));
    if (!first) return { bucket: 'sufficient', next: action.name };
    const r = reactionOf(first, returned, mentioned, earlier);
    return { ...r, next: `${action.name} → ${r.next}` };
  };
  for (const [thread, actions] of threads) {
    const earlier = [];  // files previous explores in THIS thread already shipped
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (!/codegraph_explore/.test(a.name)) continue;
      const text = textById.get(a.id);
      // No response text = the call errored, or the run ended before it
      // returned. Nothing to judge the sufficiency of; count it and move on.
      if (text === undefined) { errors++; continue; }
      const returned = exploreReturnedFiles(text);
      const mentioned = text.match(PATH_TOKEN_RE) || [];
      let reaction = { bucket: 'sufficient', next: '(final answer)' };
      for (let j = i + 1; j < actions.length; j++) {
        const b = actions[j];
        if (b.msgId === a.msgId) { if (isFileAccess(b)) concurrent++; continue; }
        if (TRANSPARENT_TOOLS.has(b.name)) continue;
        reaction = DELEGATION_TOOLS.has(b.name)
          ? throughDelegation(b, returned, mentioned, earlier)
          : reactionOf(b, returned, mentioned, earlier);
        break;
      }
      earlier.push(...returned);
      calls.push({ thread, query: String(a.input.query ?? ''), files: returned.length, chars: text.length, ...reaction });
    }
  }

  const counts = Object.fromEntries(SUFFICIENCY_KEYS.map((k) => [k, 0]));
  for (const c of calls) counts[c.bucket]++;
  return { calls, counts, errors, concurrent, answered: calls.length };
}

/** The sufficiency block, as printed under a run and reused by aggregators. */
export function formatSufficiency(s, indent = '  ') {
  const f = s.sufficiency;
  if (!f.answered) {
    return `${indent}Explore sufficiency: no answered codegraph_explore calls`
      + (f.errors ? ` (${f.errors} errored or never returned)` : '');
  }
  const pct = (n) => ((n / f.answered) * 100).toFixed(0) + '%';
  const out = [`${indent}Explore sufficiency — what the agent did NEXT (${f.answered} answered call${f.answered === 1 ? '' : 's'}):`];
  for (const [key, label, meaning] of SUFFICIENCY) {
    out.push(`${indent}  ${String(f.counts[key]).padStart(3)} ${pct(f.counts[key]).padStart(4)}  ${label.padEnd(31)}${meaning}`);
  }
  f.calls.forEach((c, i) => {
    const q = c.query.length > 46 ? c.query.slice(0, 45) + '…' : c.query;
    const where = c.thread && c.thread !== 'main' ? ' [subagent]' : '';
    out.push(`${indent}  ${i + 1}.${where} "${q}" [${c.files} file${c.files === 1 ? '' : 's'}] → ${c.next}`);
  });
  const notes = [];
  if (f.errors) notes.push(`${f.errors} errored/unanswered call${f.errors === 1 ? '' : 's'} (not bucketed)`);
  if (f.concurrent) notes.push(`${f.concurrent} file-access call${f.concurrent === 1 ? '' : 's'} in the SAME message as an explore (not a reaction)`);
  if (notes.length) out.push(`${indent}  note: ${notes.join(' · ')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// `--selftest`: the occupancy math over synthetic transcripts with known
// answers. It lives here rather than in a test file on purpose — a new
// scripts/agent-eval/*.mjs scores into the self-query eval fixture's corpus.
function selftest() {
  const { writeFileSync, mkdtempSync } = require0('fs');
  const { join } = require0('path');
  const { tmpdir } = require0('os');
  const dir = mkdtempSync(join(tmpdir(), 'cg-occ-'));
  let n = 0, failures = 0;
  const check = (name, got, want, tol) => {
    n++;
    const ok = Math.abs(got - want) <= tol;
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}: got ${Math.round(got)}, want ${want} ±${tol}`);
  };
  // Builders for the event shapes Claude Code actually emits.
  const req = (ctx, id, blocks) => blocks.map((b) => JSON.stringify({
    type: 'assistant',
    message: { id, content: [b], usage: { input_tokens: ctx, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 } },
  }));
  const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
  const res = (id, chars) => JSON.stringify({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'x'.repeat(chars) }] }] },
  });
  const done = () => JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0.1, usage: {} });
  const write = (name, lines) => { const f = join(dir, name); writeFileSync(f, lines.join('\n') + '\n'); return f; };

  // 1. Attribution: ratio 2.5 chars/tok, two families, no shedding.
  //    10,000 explore chars over a 4,000-tok gap; 5,000 Read chars over 2,000.
  let f = write('basic.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [use('t2', 'Read')]),
    res('t2', 5000),
    ...req(16000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  let o = parseSession([f]).occupancy;
  check('chars/token', o.charsPerToken * 1000, 2500, 30);
  check('codegraph residual', o.residual.codegraph, 4000, 60);
  check('Read residual', o.residual.read, 2000, 40);
  check('file-access residual', o.residualFileAccess, 2000, 40);
  check('final context', o.ctxFinal, 16000, 0);
  check('fixed base', o.ctxBase, 10000, 0);
  check('nothing evicted', o.evicted, 0, 1);

  // 2. Dedupe: thinking + tool_use are two events sharing one id and one usage.
  //    Counting usage per event would report 5 requests instead of 3.
  f = write('dupe.jsonl', [
    ...req(10000, 'm1', [{ type: 'thinking', thinking: '' }, use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [{ type: 'thinking', thinking: '' }, use('t2', 'Read')]),
    res('t2', 5000),
    ...req(16000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  let s = parseSession([f]);
  check('turns deduped by message.id', s.turns, 3, 0);
  check('codegraph residual (deduped)', s.occupancy.residual.codegraph, 4000, 60);

  // 3. Compaction: the boundary clears everything resident before it.
  f = write('compact.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [use('t2', 'mcp__codegraph__codegraph_explore')]),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    res('t2', 5000),
    ...req(8000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  o = parseSession([f]).occupancy;
  check('post-compaction residual = last result only', o.residual.codegraph, 2000, 40);
  check('contributed still counts both', o.contributed.codegraph, 6000, 80);

  // 4. Micro-compaction: context grows less than the results added, so the
  //    oldest result is shed first (FIFO) — here explore, leaving Read.
  f = write('micro.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [use('t2', 'Read')]),
    res('t2', 10000),
    ...req(14500, 'm3', [{ type: 'text', text: 'done' }]),  // +500 for 4,000 tok of Read
    done(),
  ]);
  o = parseSession([f]).occupancy;
  check('FIFO evicted the older codegraph result', o.residual.codegraph, 500, 60);
  check('newer Read result survives', o.residual.read, 4000, 60);
  check('eviction recorded', o.evicted, 3500, 60);

  // 5. Multi-turn stitching: a resumed segment continues the same context, and
  //    a turn that calls no tool leaves the earlier residual in place.
  const a = write('seg1.jsonl', [
    ...req(10000, 'm1', [use('t1', 'mcp__codegraph__codegraph_explore')]),
    res('t1', 10000),
    ...req(14000, 'm2', [{ type: 'text', text: 'answer one' }]),
    done(),
  ]);
  const b = write('seg2.jsonl', [
    ...req(14600, 'm3', [{ type: 'text', text: 'answer two, from what is already here' }]),
    done(),
  ]);
  s = parseSession([a, b]);
  check('stitched turns', s.turns, 3, 0);
  check('residual carries into turn 2', s.occupancy.residual.codegraph, 4000, 60);
  check('stitched final context', s.occupancy.ctxFinal, 14600, 0);
  check('stitched cost sums segments', s.cost * 100, 20, 0.1);

  // ---- 6. Explore sufficiency: the bucket each explore call earns. --------
  const checkIs = (name, got, want) => {
    n++;
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const EXPLORE = 'mcp__codegraph__codegraph_explore';
  // An explore response's shape that matters here: one `**`path`**` section per
  // file whose source it returned, plus whatever else it named.
  const exploreRes = (id, paths, extra = '', isError = false) => JSON.stringify({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result', tool_use_id: id, ...(isError ? { is_error: true } : {}),
        content: [{ type: 'text', text: paths.map((p) => `**\`${p}\`** — fn(function)\n\n1\tcode here\n`).join('\n') + extra }],
      }],
    },
  });
  const suff = (lines) => classifySufficiency(lines.map((l) => JSON.parse(l)));

  // explore → explore is insufficient; the second explore → a Read of a file it
  // RETURNED is the allocation bucket (this is the CG-22 express baseline).
  let sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'res.send Content-Type ETag generation' })]),
    exploreRes('e1', ['lib/response.js', 'lib/utils.js']),
    ...req(12000, 'm2', [use('e2', EXPLORE, { query: 'response.js res.send function body' })]),
    exploreRes('e2', ['lib/response.js']),
    ...req(14000, 'm3', [use('r1', 'Read', { file_path: '/private/tmp/t-base/lib/response.js' })]),
    res('r1', 3722),
    ...req(15000, 'm4', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  check('two answered explore calls', sf.answered, 2, 0);
  checkIs('explore → explore = insufficient', sf.calls[0].bucket, 'explore_again');
  checkIs('explore → Read of a returned file (abs path)', sf.calls[1].bucket, 'read_returned');

  // A file the response NAMED but did not return is still a recall miss — and
  // is flagged as named, since pointing without delivering is its own failure.
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', ['lib/response.js'], '\n**Flow**\n1. lib/router/index.js:42 handle\n'),
    ...req(12000, 'm2', [use('r1', 'Read', { file_path: '/t/lib/router/index.js' })]),
    res('r1', 100),
    done(),
  ]);
  checkIs('explore → Read of a named-but-unreturned file', sf.calls[0].bucket, 'read_missed');
  checkIs('  …flagged as named', sf.calls[0].named, true);

  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', ['lib/response.js']),
    ...req(12000, 'm2', [use('r1', 'Read', { file_path: '/t/lib/never/mentioned.js' })]),
    res('r1', 100),
    done(),
  ]);
  checkIs('explore → Read of a file never surfaced', sf.calls[0].bucket, 'read_missed');
  checkIs('  …not flagged as named', sf.calls[0].named, false);

  // Grep, and the shell equivalents of Read and Grep.
  const oneShot = (next) => suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', ['lib/response.js']),
    ...req(12000, 'm2', [next]),
    res(next.id, 100),
    done(),
  ]).calls[0];
  checkIs('explore → Grep', oneShot(use('g1', 'Grep', { pattern: 'send' })).bucket, 'search');
  checkIs('explore → Glob', oneShot(use('g1', 'Glob', { pattern: '**/*.js' })).bucket, 'search');
  checkIs('explore → Bash sed of a returned file',
    oneShot(use('b1', 'Bash', { command: "sed -n '100,200p' lib/response.js" })).bucket, 'read_returned');
  checkIs('explore → Bash grep', oneShot(use('b1', 'Bash', { command: 'grep -rn send lib/' })).bucket, 'search');
  checkIs('explore → Bash that writes a file is not a read',
    oneShot(use('b1', 'Bash', { command: "cat > /tmp/note.md <<'EOF'\nx\nEOF" })).bucket, 'sufficient');
  checkIs('explore → Bash npm test = moved on',
    oneShot(use('b1', 'Bash', { command: 'npm test' })).bucket, 'sufficient');
  checkIs('explore → Edit = sufficient',
    oneShot(use('x1', 'Edit', { file_path: '/t/lib/response.js' })).bucket, 'sufficient');

  // No further tool call at all: the agent answered from the response.
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', ['lib/response.js']),
    ...req(12000, 'm2', [{ type: 'text', text: 'here is how it works' }]),
    done(),
  ]);
  checkIs('explore → final answer', sf.calls[0].bucket, 'sufficient');
  checkIs('  …labelled as the final answer', sf.calls[0].next, '(final answer)');

  // A Read issued in the SAME message as the explore predates its response, so
  // it is not a verdict on it — step past it and count it separately.
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' }), use('r1', 'Read', { file_path: '/t/lib/response.js' })]),
    exploreRes('e1', ['lib/response.js']),
    res('r1', 100),
    ...req(12000, 'm2', [use('x1', 'Edit', { file_path: '/t/lib/response.js' })]),
    res('x1', 20),
    done(),
  ]);
  checkIs('same-message Read is not a reaction', sf.calls[0].bucket, 'sufficient');
  check('  …counted as concurrent instead', sf.concurrent, 1, 0);

  // ToolSearch/TodoWrite carry no signal — the Read behind them is the verdict.
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', ['lib/response.js']),
    ...req(12000, 'm2', [use('t1', 'TodoWrite', {})]),
    res('t1', 20),
    ...req(13000, 'm3', [use('r1', 'Read', { file_path: '/t/lib/response.js' })]),
    res('r1', 100),
    done(),
  ]);
  checkIs('bookkeeping tools are stepped over', sf.calls[0].bucket, 'read_returned');

  // A re-read of a file an EARLIER explore shipped is still an allocation miss:
  // we returned it and clipped it wrong, just not on this call.
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'first' })]),
    exploreRes('e1', ['lib/response.js', 'lib/utils.js']),
    ...req(11000, 'm2', [use('e2', EXPLORE, { query: 'second' })]),
    exploreRes('e2', ['lib/response.js']),
    ...req(12000, 'm3', [use('r1', 'Read', { file_path: '/t/lib/utils.js' })]),
    res('r1', 400),
    done(),
  ]);
  checkIs('re-read of an earlier explore’s file is allocation, not recall',
    sf.calls[1].bucket, 'read_returned');
  checkIs('  …and says which explore returned it',
    sf.calls[1].next, 'Read utils.js (returned by an earlier explore)');

  // A subagent's calls are interleaved into the same stream under
  // `parent_tool_use_id` (verified on a real excalidraw run). They belong to
  // their own thread: the parent's verdict is the delegation, judged by what
  // the subagent actually did first — here, grepping for a file we never
  // returned.
  const sub = (parent, obj) => JSON.stringify({ ...JSON.parse(obj), parent_tool_use_id: parent });
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', ['lib/response.js']),
    ...req(12000, 'm2', [use('a1', 'Agent', { subagent_type: 'Explore' })]),
    ...req(0, 'sm1', [use('sb1', 'Bash', { command: 'grep -rn nonce lib/' })]).map((l) => sub('a1', l)),
    sub('a1', res('sb1', 400)),
    ...req(14000, 'm3', [{ type: 'text', text: 'done' }]),
    res('a1', 900),
    done(),
  ]);
  checkIs('delegation is judged by what the subagent did', sf.calls[0].bucket, 'search');
  checkIs('  …and says so', sf.calls[0].next, 'Agent → Bash search');

  // A subagent's Read must NOT be read as the parent's reaction to an explore
  // the subagent never saw: the parent moved on, the subagent's own explore is
  // judged inside its own thread.
  sf = suff([
    ...req(10000, 'm1', [use('a1', 'Agent', { subagent_type: 'Explore' })]),
    ...req(0, 'sm1', [use('e1', EXPLORE, { query: 'sub q' })]).map((l) => sub('a1', l)),
    sub('a1', exploreRes('e1', ['lib/response.js'])),
    ...req(11000, 'm2', [use('e2', EXPLORE, { query: 'parent q' })]),
    exploreRes('e2', ['lib/other.js']),
    ...req(0, 'sm2', [use('sr1', 'Read', { file_path: '/t/lib/response.js' })]).map((l) => sub('a1', l)),
    sub('a1', res('sr1', 400)),
    ...req(13000, 'm3', [{ type: 'text', text: 'done' }]),
    done(),
  ]);
  check('both threads bucketed', sf.answered, 2, 0);
  checkIs('parent explore is not blamed for a subagent Read',
    sf.calls.find((c) => c.query === 'parent q').bucket, 'sufficient');
  checkIs('subagent explore is judged in its own thread',
    sf.calls.find((c) => c.query === 'sub q').bucket, 'read_returned');

  // An errored explore has no response to judge; it is counted, not bucketed.
  sf = suff([
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    exploreRes('e1', [], 'not indexed', true),
    ...req(12000, 'm2', [use('r1', 'Read', { file_path: '/t/lib/response.js' })]),
    res('r1', 100),
    done(),
  ]);
  check('errored explore is not bucketed', sf.answered, 0, 0);
  check('  …but is counted', sf.errors, 1, 0);

  // ---- 7. Allocation efficiency: which returned bytes the answer used. ----
  // The response shape that matters here: a per-file section whose header lists
  // `name(kind)`, and a body big enough that the shares are readable.
  const alloc = (files, answer) => computeAllocation(
    [files.map(([p, syms, size]) =>
      `**\`${p}\`** — ${syms}\n\n\`\`\`js\n${'x'.repeat(size)}\n\`\`\`\n`).join('\n')
      + '\n> Treat the code above as already read.\n'],
    answer,
  );
  const round = (f) => Math.round(f * 1000) / 10;

  // The #1500 shape: one file answers, two are noise. The answer names it by
  // repo-relative path.
  let al = alloc(
    [['lib/response.js', 'send(function)', 4000], ['lib/express.js', 'app(variable)', 3000],
      ['lib/view.js', 'View(class)', 3000]],
    'The Content-Type is decided in `lib/response.js:126` by `res.send`.',
  );
  check('allocation: one of three files cited', round(al.efficiency), 40.1, 0.6);
  checkIs('  …cited file is flagged path', al.files.find((f) => /response/.test(f.path)).via, 'path');
  checkIs('  …noise file is not', al.files.find((f) => /view/.test(f.path)).via, null);
  check('  …files cited', al.filesUsed, 1, 0);

  // A bare basename is how agents actually cite in prose — but only when the
  // extension is one the envelope shipped, or `res.send` reads as a file too.
  al = alloc([['lib/response.js', 'send(function)', 4000], ['lib/view.js', 'View(class)', 4000]],
    'It happens in response.js:134, inside `res.send`.');
  check('bare basename counts as a path citation', round(al.efficiency), 50, 0.6);
  al = alloc([['lib/response.js', 'send(function)', 4000], ['lib/view.js', 'View(class)', 4000]],
    'The `res.send` and `mime.contentType` calls do it.');
  checkIs('a dotted expression is not a file citation', al.files.every((f) => f.via !== 'path'), true);

  // Symbol citations: a code span naming a symbol the file DEFINES counts; a
  // file that merely CALLS it does not (the excalidraw dragElements.ts case).
  al = alloc([['src/mutateElement.ts', 'mutateElement(function)', 4000],
    ['src/dragElements.ts', 'mutateElement(calls), updateCoords(function)', 4000]],
  'Mutation goes through `mutateElement`.');
  checkIs('symbol citation credits the definer', al.files.find((f) => /mutateElement.ts/.test(f.path)).via, 'symbol');
  checkIs('  …and not a caller of it', al.files.find((f) => /dragElements/.test(f.path)).via, null);

  // An import binding (`variable`) loses to the real definition of the name.
  al = alloc([['lib/utils.js', 'compileETag(function)', 4000],
    ['lib/application.js', 'compileETag(variable), set(calls)', 4000]],
  'The generator comes from `compileETag`.');
  checkIs('a definition beats an import alias of the same name',
    al.files.find((f) => /utils/.test(f.path)).via, 'symbol');
  checkIs('  …and the aliasing file is not credited',
    al.files.find((f) => /application/.test(f.path)).via, null);

  // A name carried by ≥3 returned files identifies none of them: crediting them
  // all would bias the metric optimistic, the one direction it must not lean.
  al = alloc([['a/one.js', 'handle(function)', 3000], ['a/two.js', 'handle(function)', 3000],
    ['a/three.js', 'handle(function)', 3000]],
  'It all runs through `handle`.');
  check('a symbol on 3 files attributes none of them', al.efficiency, 0, 0.001);

  // Prose is not a citation — only a code span is.
  al = alloc([['lib/response.js', 'sendResponse(function)', 4000], ['lib/view.js', 'View(class)', 4000]],
    'The sendResponse path handles it.');
  check('an unquoted symbol in prose does not count', al.efficiency, 0, 0.001);

  // Per-call: the run number pools, but call 2 being pure noise must still show.
  const twoCalls = computeAllocation([
    '**`lib/response.js`** — send(function)\n\n```js\n' + 'x'.repeat(4000) + '\n```\n\n> guidance\n',
    '**`lib/view.js`** — View(class)\n\n```js\n' + 'x'.repeat(4000) + '\n```\n\n> guidance\n',
  ], 'See `lib/response.js`.');
  check('per-call: call 1 fully used', round(twoCalls.calls[0].efficiency), 100, 0.1);
  check('per-call: call 2 fully wasted', round(twoCalls.calls[1].efficiency), 0, 0.1);
  check('run pools both calls', round(twoCalls.efficiency), 50, 0.6);

  // A file returned twice is charged twice — it occupied the window twice.
  const twice = computeAllocation([
    '**`lib/response.js`** — send(function)\n\n' + 'x'.repeat(4000) + '\n\n> g\n',
    '**`lib/response.js`** — send(function)\n\n' + 'x'.repeat(4000) + '\n\n> g\n',
  ], 'See `lib/response.js`.');
  check('a re-returned file is charged both times', twice.envelope, 8078, 120);
  check('  …and credited both times', round(twice.efficiency), 100, 0.1);

  // The answer text itself: the `result` event, and the interactive fallback.
  const ev = (l) => JSON.parse(l);
  checkIs('final answer comes from the result event',
    finalAnswerText([ev(done()), { type: 'result', result: 'the answer' }]), 'the answer');
  checkIs('…else the last main-thread assistant text', finalAnswerText([
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'let me look' }] } },
    { type: 'assistant', parent_tool_use_id: 'a1', message: { id: 's1', content: [{ type: 'text', text: 'subagent report' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'the answer' }] } },
  ]), 'the answer');

  // End to end through parseSession, on the transcript shape a run really has.
  f = write('alloc.jsonl', [
    ...req(10000, 'm1', [use('e1', EXPLORE, { query: 'q' })]),
    JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 'e1',
          content: [{
            type: 'text',
            text: '**`lib/response.js`** — send(function)\n\n' + 'x'.repeat(4000)
              + '\n\n**`lib/view.js`** — View(class)\n\n' + 'x'.repeat(4000) + '\n\n> guidance\n',
          }],
        }],
      },
    }),
    ...req(20000, 'm2', [{ type: 'text', text: 'done' }]),
    JSON.stringify({
      type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0.1, usage: {},
      result: 'It is decided in `lib/response.js` by `res.send`.',
    }),
  ]);
  s = parseSession([f]);
  check('parseSession reports allocation', round(s.allocation.efficiency), 50, 0.6);
  checkIs('  …and the block renders', /efficiency\s+50\.\d%/.test(formatAllocation(s)), true);
  checkIs('a run with no explore says so',
    formatAllocation({ allocation: computeAllocation([], 'answer') }).includes('no codegraph_explore responses'), true);

  console.log(`\n${n - failures}/${n} checks passed`);
  return failures;
}
// `--selftest` needs sync fs helpers the module path doesn't import at top level.
function require0(m) { return process.getBuiltinModule(m); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);
if (isMain) {
  // `--answer <glob>` is repeatable and implies `--envelope`. Its VALUE is not a
  // run file, so consume it here rather than letting the positional filter below
  // mistake a glob for a log path.
  const argv = process.argv.slice(2);
  const files = [];
  const answerGlobs = [];
  let wantEnvelope = false;
  let brief = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--envelope') wantEnvelope = true;
    else if (argv[i] === '--brief') brief = true;
    else if (argv[i] === '--answer') { answerGlobs.push(argv[++i]); wantEnvelope = true; }
    else if (!argv[i].startsWith('--')) files.push(argv[i]);
  }
  if (!files.length) { console.error('usage: parse-run.mjs <run.jsonl> [run.t2.jsonl ...] [--brief] [--envelope] [--answer <glob>]...  |  --selftest'); process.exit(1); }
  const s = parseSession(files);

  console.log(`\n=== ${files.map((f) => f.split('/').pop()).join(' + ')} ===`);
  console.log(`codegraph tools exposed: ${s.initTools ? s.initTools.length : '?'}${s.raced ? '  [MCP COLD-START RACE — tool call hit "No such tool available"]' : ''}`);
  if (s.cliContaminated) console.log(`!! ${s.cliContaminated} codegraph CLI call${s.cliContaminated === 1 ? '' : 's'} RETURNED OUTPUT via Bash — if this is a without-arm, the run is CONTAMINATED`);
  else if (s.cliCalls) console.log(`   (${s.cliCalls} codegraph CLI attempt${s.cliCalls === 1 ? '' : 's'} blocked — no output entered the window)`);
  console.log(`\nTool calls (${s.toolCalls.length}):`);
  console.log('  by type:', JSON.stringify(s.counts));
  if (!brief) s.toolCalls.forEach((tc, i) => console.log(`  ${i + 1}. ${tc}`));

  if (s.result) {
    const seg = s.results.length > 1 ? ` | ${s.results.length} segments (${s.results.map((r) => r.subtype).join(',')})` : '';
    console.log(`\nResult: ${s.result.subtype} | duration ${s.dur.toFixed(0)}s | turns ${s.turns}${seg}`);
    console.log(`  tokens processed: ${s.processed.toLocaleString('en-US')} | cost $${s.cost.toFixed(3)}`);
  }
  console.log('');
  console.log(formatOccupancy(s));
  console.log('');
  console.log(formatSufficiency(s));
  console.log('');
  console.log(formatAllocation(s));
  if (wantEnvelope) {
    console.log('');
    console.log(formatEnvelope(s.exploreTexts, answerGlobs));
  }
}
