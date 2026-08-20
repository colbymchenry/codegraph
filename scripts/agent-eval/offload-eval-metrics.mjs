#!/usr/bin/env node
// Extract one eval run's metrics from its Claude stream-json transcript + the
// offload usage sidecar log, emit ONE merged JSON line.
//
// Usage: extract-metrics.mjs --run <run.jsonl> --usage <usage.jsonl|-> \
//          --arm <a> --rep <n> --repo <r> --tier <t> --q <question>
import { readFileSync, existsSync } from 'fs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const runFile = args.run;
const lines = existsSync(runFile) ? readFileSync(runFile, 'utf8').split('\n').filter(Boolean) : [];

const toolCounts = {};
let result = null;
const tok = { gen: 0, fresh: 0, cached: 0 };
const offloadAnswers = [];
let exploreResults = 0; // tool_results from explore (offload or raw)
let lastAssistantText = '';

for (const line of lines) {
  let ev; try { ev = JSON.parse(line); } catch { continue; }

  // per-turn token usage (authoritative token measure; result.usage is last-turn only)
  const u = ev.message?.usage;
  if (u) {
    tok.gen += u.output_tokens || 0;
    tok.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    tok.cached += u.cache_read_input_tokens || 0;
  }

  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'tool_use') toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
      if (b.type === 'text' && b.text?.trim()) lastAssistantText = b.text.trim();
    }
  }
  // tool_results arrive in user messages
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const text = Array.isArray(b.content)
        ? b.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('')
        : (typeof b.content === 'string' ? b.content : '');
      // An offload answer is either the 'plain'/'report' synthesis (carries the
      // "Synthesized by CodeGraph" footer) or a 'refs' answer (carries the re-expanded
      // "### Referenced source — verbatim" appendix). A refs call that cited nothing
      // valid falls back to RAW source, which is correctly counted as a raw explore below.
      if (/Synthesized by CodeGraph|### Referenced source — verbatim/.test(text)) { offloadAnswers.push(text); exploreResults++; }
      else if (/Found \d+ symbols? across|\*\*Exploration:/.test(text)) exploreResults++;
    }
  }
  if (ev.type === 'result') result = ev;
}

// offload usage sidecar (CodeGraph AI tokens + cost) — one JSON line per offload call
const ai = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, credits: 0, costUsd: 0, ms: 0 };
if (args.usage && args.usage !== '-' && existsSync(args.usage)) {
  for (const line of readFileSync(args.usage, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    ai.calls++;
    ai.promptTokens += e.promptTokens || 0;
    ai.completionTokens += e.completionTokens || 0;
    ai.totalTokens += e.totalTokens || 0;
    ai.credits += e.creditsCharged || 0;
    ai.costUsd += e.costUsd || 0;
    ai.ms += e.ms || 0;
  }
}

// front-load hook fired iff its injected header appears in the transcript
const frontload = lines.some(l => l.includes('auto-retrieved for this question'));
const get = (n) => toolCounts[n] || 0;
const read = get('Read');
const grep = get('Grep') + get('Bash') + get('Glob');
const explore = get('mcp__codegraph__codegraph_explore');
const cgAny = Object.keys(toolCounts).filter(k => /mcp__codegraph__/.test(k)).reduce((s, k) => s + toolCounts[k], 0);

const out = {
  repo: args.repo, tier: args.tier, arm: args.arm, rep: Number(args.rep), question: args.q,
  ok: result?.subtype === 'success',
  durationSec: result ? +(result.duration_ms / 1000).toFixed(1) : null,
  numTurns: result?.num_turns ?? null,
  costUsdMain: result ? +(result.total_cost_usd || 0).toFixed(4) : null,
  tokGen: tok.gen, tokFresh: tok.fresh, tokCached: tok.cached, tokBillable: tok.gen + tok.fresh,
  read, grep, explore, cgAny, frontload,
  offloadFired: offloadAnswers.length,
  ai,
  // text payloads for the accuracy judge (kept separate; large)
  finalAnswer: (result?.result || lastAssistantText || '').slice(0, 8000),
  offloadAnswers: offloadAnswers.map(a => a.slice(0, 6000)),
};
process.stdout.write(JSON.stringify(out) + '\n');
