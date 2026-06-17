#!/usr/bin/env node
// Parse a Claude Code stream-json run log: tool-call sequence + token usage.
import { readFileSync } from 'fs';
const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

const toolCalls = [];
let result = null;
let initTools = null;

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
