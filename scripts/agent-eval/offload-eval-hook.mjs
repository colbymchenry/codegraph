#!/usr/bin/env node
// UserPromptSubmit hook — APPROACH 1: additive context-injection.
// Front-loads codegraph's structural answer for flow/impact/"how/where" prompts so the
// agent's reflex grep/read has nothing left to find. Strictly additive (never blocks),
// gated to structural prompts (no cost otherwise), and uses RAW explore (offload disabled)
// so the injected context is accurate — never the (currently low-fidelity) synthesis.
//
// Reads {prompt, cwd} as JSON on stdin; prints the explore result to stdout (which Claude
// Code injects into the agent's context). Any failure -> silent exit 0 (degradable).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';

// Resolve the engine repo from this script's own location (scripts/agent-eval/ -> ../..),
// overridable with CG_ENGINE. The hook ships inside the repo, so it finds its own dist.
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.CG_ENGINE || resolve(HERE, '..', '..');
const BUDGET = Number(process.env.CG_FRONTLOAD_BUDGET || 16000);

// Debug log only when CG_FRONTLOAD_DEBUG is set to a file path (the harness points it at a
// log to count injections); off by default so the shipped hook writes nothing extra.
const DBG = process.env.CG_FRONTLOAD_DEBUG;
const dbg = (m) => { if (!DBG) return; try { appendFileSync(DBG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch (e) { dbg('stdin parse fail: ' + e.message); }
const prompt = String(input.prompt || '');
const cwd = String(input.cwd || process.cwd());
dbg(`invoked: promptLen=${prompt.length} cwd=${cwd}`);

// Gate: only structural / flow / impact / where-how questions. Cheap regex; silent no-op
// otherwise so non-structural prompts ("fix this typo") cost nothing.
const STRUCTURAL = /\b(how|where|trace|flow|path|reach(es|ed)?|call(s|ed|er|ers|ee)?|depend|impact|affect|wire[ds]?|connect|implement|architect|structure|breaks?|what calls|why does)\b/i;
if (!prompt || !STRUCTURAL.test(prompt)) { dbg('gate: non-structural, no-op'); process.exit(0); }
dbg('gate: structural PASS');

// Find the index: cwd, then walk up a few levels.
let root = cwd, found = null;
for (let i = 0; i < 6 && root; i++) {
  if (existsSync(join(root, '.codegraph'))) { found = root; break; }
  const parent = resolve(root, '..'); if (parent === root) break; root = parent;
}
if (!found) { dbg(`no .codegraph found from cwd=${cwd}`); process.exit(0); }
dbg(`found index at ${found}`);

try {
  process.env.CODEGRAPH_OFFLOAD_DISABLE = '1'; // raw, accurate — never the unfixed offload
  process.env.CODEGRAPH_TELEMETRY = '0'; process.env.DO_NOT_TRACK = '1';
  const load = async (rel) => import(pathToFileURL(resolve(ENGINE, rel)).href);
  const idx = await load('dist/index.js');
  const tools = await load('dist/mcp/tools.js');
  const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
  const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;
  if (typeof CodeGraph?.openSync !== 'function' || typeof ToolHandler !== 'function') process.exit(0);

  // Retry once on a transient busy/locked index (the hook's openSync can race a
  // freshly-warming daemon on the first prompt of a session).
  let text = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cg = CodeGraph.openSync(found);
      const h = new ToolHandler(cg);
      const res = await h.execute('codegraph_explore', { query: prompt });
      text = res?.content?.[0]?.text ?? '';
      try { cg.close?.(); } catch { /* ignore */ }
      dbg(`explore attempt ${attempt} returned ${text.length} chars`);
      break;
    } catch (e) {
      dbg(`explore attempt ${attempt} failed: ${e?.message || e}`);
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!text.trim()) { dbg('empty explore result, no-op'); process.exit(0); }
  if (text.length > BUDGET) text = text.slice(0, BUDGET) + '\n…[front-load truncated to budget]';

  process.stdout.write(
    `## CodeGraph structural context (auto-retrieved for this question)\n` +
    `The code graph was queried for your question; the relevant symbols, source, and call flow are below. ` +
    `Treat the quoted source as already read. If you need more, call codegraph_explore with specific symbol names rather than grepping or reading files.\n\n` +
    text + '\n'
  );
  dbg(`INJECTED ${text.length} chars`);
} catch (e) { dbg('ERROR: ' + (e?.stack || e?.message || e)); process.exit(0); } // degradable
