#!/usr/bin/env node
// Parse a Claude Code stream-json run log: tool-call sequence + token usage.
//
// With --envelope it also reports how the codegraph_explore responses the agent
// received were DIVIDED across files — the per-file share of the source envelope.
// That view is parsed out of the rendered markdown rather than the CG-4
// diagnostic sidecar, so it works on ANY build (the sidecar only exists post-CG-4)
// and is therefore the only way to measure both arms of a new-vs-baseline A/B the
// same way. `--answer <glob>` (repeatable) marks the files that actually answer
// the question, and the summary reports their combined share.
//
// Usage: parse-run.mjs <run.jsonl> [--envelope] [--answer <glob>]...
import { readFileSync } from 'fs';

const argv = process.argv.slice(2);
const answerGlobs = [];
let file = null;
let wantEnvelope = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--envelope') wantEnvelope = true;
  else if (argv[i] === '--answer') { answerGlobs.push(argv[++i]); wantEnvelope = true; }
  else if (!argv[i].startsWith('--') && file === null) file = argv[i];
}
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

const toolCalls = [];
let result = null;
let initTools = null;
const exploreQueries = new Map();   // tool_use id -> query
const exploreTexts = [];            // response text, in call order

for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'system' && ev.subtype === 'init') {
    initTools = (ev.tools || []).filter(t => /codegraph/.test(t));
  }
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        let detail = '';
        if (block.name === 'Task') detail = ` [subagent_type=${block.input?.subagent_type ?? '?'}] ${(block.input?.description ?? '').slice(0,40)}`;
        else if (/codegraph/.test(block.name)) detail = ` ${JSON.stringify(block.input?.query ?? block.input?.task ?? block.input?.symbol ?? '').slice(0,60)}`;
        else if (block.name === 'Bash') detail = ` ${(block.input?.command ?? '').slice(0,50)}`;
        else if (block.name === 'Read') detail = ` ${(block.input?.file_path ?? '').split('/').slice(-1)[0]}`;
        toolCalls.push(`${block.name}${detail}`);
        if (/codegraph_explore/.test(block.name)) exploreQueries.set(block.id, block.input?.query ?? '');
      }
    }
  }
  if (ev.type === 'user' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result' && exploreQueries.has(block.tool_use_id)) {
        exploreTexts.push(typeof block.content === 'string'
          ? block.content
          : (block.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
      }
    }
  }
  if (ev.type === 'result') result = ev;
}

console.log(`\n=== ${file.split('/').pop()} ===`);
console.log(`codegraph tools exposed: ${initTools ? initTools.length : '?'}`);
console.log(`\nTool calls (${toolCalls.length}):`);
const counts = {};
for (const tc of toolCalls) { const n = tc.split(' ')[0]; counts[n] = (counts[n]||0)+1; }
console.log('  by type:', JSON.stringify(counts));
toolCalls.forEach((tc, i) => console.log(`  ${i+1}. ${tc}`));

if (result) {
  const u = result.usage || {};
  const totalIn = (u.input_tokens||0) + (u.cache_read_input_tokens||0) + (u.cache_creation_input_tokens||0);
  console.log(`\nResult: ${result.subtype} | duration ${(result.duration_ms/1000).toFixed(0)}s | turns ${result.num_turns}`);
  console.log(`  tokens: in=${totalIn} out=${u.output_tokens||0} | cost $${(result.total_cost_usd||0).toFixed(3)}`);
}

// ---- envelope share (opt-in) ------------------------------------------------

if (wantEnvelope) {
  // `tools/cache/**` -> /^tools\/cache\/.*$/ . Same semantics as probe-allocation.
  // The `**` sentinel is written as an escape, never a literal NUL byte — a raw
  // one makes git treat this whole script as binary and costs every future diff.
  const glob2re = (glob) => {
    const S = '\u0000';
    const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, S).replace(/\*/g, '[^/]*').replaceAll(S, '.*');
    return new RegExp(`^${body}$`);
  };
  const answerRes = answerGlobs.map(glob2re);
  const isAnswer = (p) => answerRes.some(re => re.test(p));

  // Each rendered file section starts with **`path`** — its bytes run to the next
  // such header (or to the trailing guidance quote). Share is over the sum of the
  // sections, i.e. of the source envelope the allocator divides.
  const pooled = new Map();
  let envelope = 0;
  for (const text of exploreTexts) {
    const re = /^\*\*`([^`]+)`\*\*/gm;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) marks.push({ path: m[1], at: m.index });
    if (!marks.length) continue;
    const tail = text.indexOf('\n> ', marks[marks.length - 1].at);
    const end = tail === -1 ? text.length : tail;
    marks.forEach((mark, i) => {
      const chars = (i + 1 < marks.length ? marks[i + 1].at : end) - mark.at;
      pooled.set(mark.path, (pooled.get(mark.path) ?? 0) + chars);
      envelope += chars;
    });
  }
  const ranked = [...pooled.entries()]
    .map(([path, chars]) => ({ path, chars, share: envelope ? chars / envelope : 0, answer: isAnswer(path) }))
    .sort((a, b) => b.chars - a.chars);
  const answerChars = ranked.filter(r => r.answer).reduce((s, r) => s + r.chars, 0);
  const pct = (f) => `${(f * 100).toFixed(1)}%`;

  console.log(`\nExplore envelope: ${envelope.toLocaleString('en-US')} chars over ${exploreTexts.length} response(s)`);
  if (answerGlobs.length) {
    console.log(`  answer-set share: ${pct(envelope ? answerChars / envelope : 0)} | top file answers: ${ranked[0]?.answer ?? false}`);
  }
  for (const f of ranked.slice(0, 12)) {
    console.log(`  ${f.answer ? '*' : ' '} ${pct(f.share).padStart(6)} ${String(f.chars).padStart(6)}  ${f.path}`);
  }
  if (ranked.length > 12) console.log(`    … ${ranked.length - 12} more files`);
}
