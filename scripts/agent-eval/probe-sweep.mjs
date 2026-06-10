#!/usr/bin/env node
// probe-sweep — direct MCP test across N repos × N tools, no claude needed.
//
// Measures response characteristics (size, sections present, signals fired)
// for each (repo, query) pair against the built dist/. Sub-second per probe;
// the full sweep below runs in ~10-30s vs hours for a real claude audit.
//
// Use this to iterate on backend changes rapidly: change tools.ts /
// context-builder, npm run build, re-run probe-sweep, compare. Once a
// change looks good on probe metrics, run a focused claude audit for the
// few repos that matter to confirm end-to-end cost behavior.
//
// Usage: node scripts/agent-eval/probe-sweep.mjs [--tool=context|explore|trace] [--repos=a,b,c]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.startsWith('--') ? a.slice(2).split('=') : [a, true])
);
const TOOL = args.tool ?? 'context';

const load = (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

// Each entry: repo, query, optional 2nd arg for trace (from, to).
// The query is the same prompt used in the real claude audits, so probe
// output is directly comparable to the agent's would-be input.
const SWEEP = [
  // Small realworld template repos (the loss cases from the cross-language sweep)
  { id: 'gin-rw',        repo: '/tmp/codegraph-corpus/gin-realworld',         q: 'How does this Gin app route a request through its middleware chain to a handler?' },
  { id: 'go-mux',        repo: '/tmp/codegraph-corpus/go-mux',                q: 'How does this gorilla/mux app route a request to its handler?' },
  { id: 'fastapi-rw',    repo: '/tmp/codegraph-corpus/fastapi-realworld',     q: 'How does FastAPI route a request through its dependencies to a handler?' },
  { id: 'spring-pc',     repo: '/tmp/codegraph-corpus/spring-petclinic',      q: 'How does Spring route an HTTP request to a controller method?' },
  { id: 'axum-rw',       repo: '/tmp/codegraph-corpus/rust-axum-realworld',   q: 'How does Axum route a request to its handler in this app?' },
  { id: 'express-rw',    repo: '/tmp/codegraph-corpus/express-realworld',     q: 'How does this Express app route a request through middleware to a handler?' },
  { id: 'kotlin-pc',     repo: '/tmp/codegraph-corpus/kotlin-petclinic',      q: 'How does the Kotlin Spring app route an HTTP request to its handler?' },
  { id: 'flask-mb',      repo: '/tmp/codegraph-corpus/flask-microblog',       q: 'How does this Flask app route a request to a view function?' },
  { id: 'vapor-tpl',     repo: '/tmp/codegraph-corpus/vapor-template',        q: 'How does Vapor route an HTTP request to its handler?' },
  { id: 'cpp-leveldb',   repo: '/tmp/codegraph-corpus/cpp-leveldb',           q: 'How does LevelDB handle a Put operation through to disk?' },
  { id: 'lualine',       repo: '/tmp/codegraph-corpus/lualine.nvim',          q: 'How does lualine assemble and render the statusline?' },
  { id: 'drupal-admin',  repo: '/tmp/codegraph-corpus/drupal-admintoolbar',   q: 'How does the Drupal admin toolbar module render its toolbar?' },
  { id: 'svelte-rw',     repo: '/tmp/codegraph-corpus/svelte-realworld',      q: 'How does this SvelteKit app route a request to a handler?' },
  { id: 'react-rw',      repo: '/tmp/codegraph-corpus/react-realworld',       q: 'How does this React app fetch and display articles?' },
  { id: 'rails-rw',      repo: '/tmp/codegraph-corpus/rails-realworld',       q: 'How does Rails route a request to a controller action?' },
  { id: 'flask-rest',    repo: '/tmp/codegraph-corpus/flask-restful-realworld', q: 'How does Flask-RESTful route a request to a resource method?' },
  { id: 'laravel-rw',    repo: '/tmp/codegraph-corpus/laravel-realworld',     q: 'How does Laravel route a request to the controller method?' },
  { id: 'aspnet-rw',     repo: '/tmp/codegraph-corpus/aspnet-realworld',      q: 'How does ASP.NET route a request to the controller action?' },
  // The iter7 wins/ties (to make sure we don't regress)
  { id: 'cobra',         repo: '/tmp/codegraph-corpus/cobra',                 q: 'How does cobra parse commands and flags?' },
  { id: 'sinatra',       repo: '/tmp/codegraph-corpus/sinatra',               q: 'How does sinatra route a request to its handler?' },
  { id: 'slim',          repo: '/tmp/codegraph-corpus/slim',                  q: 'How does slim route a request and apply middleware?' },
];

// Detect signals in response text — these are the levers we've added that
// otherwise only show up via "agent ran X more tool calls" downstream.
const detect = (text) => ({
  hasEntryPoints: /^### Entry Points/m.test(text),
  hasRelatedSymbols: /^### Related Symbols/m.test(text),
  hasFlowTrace: /^## Inline flow trace/m.test(text),
  hasRouteManifest: /^## Routing manifest/m.test(text),
  hasTopHandler: /^### Top handler file/m.test(text),
  hasSmallRepoTail: /This project is small/.test(text),
});

const filterRepos = args.repos ? new Set(String(args.repos).split(',')) : null;
const subjects = SWEEP.filter(s => !filterRepos || filterRepos.has(s.id));

const t0 = Date.now();
const rows = [];
for (const s of subjects) {
  try {
    const cg = CodeGraph.openSync(s.repo);
    const handler = new ToolHandler(cg);
    const t1 = Date.now();
    const res = await handler.execute('codegraph_' + TOOL,
      TOOL === 'context' ? { task: s.q } :
      TOOL === 'explore' ? { query: s.q } : { from: 'main', to: 'main' });
    const text = res.content?.[0]?.text ?? '';
    const signals = detect(text);
    rows.push({
      id: s.id,
      ms: Date.now() - t1,
      chars: text.length,
      lines: text.split('\n').length,
      ...signals,
    });
    try { cg.close?.(); } catch {}
  } catch (e) {
    rows.push({ id: s.id, error: String(e).slice(0, 80) });
  }
}

// Pretty-print as a compact table.
const fmt = (r) =>
  r.error
    ? `  ${r.id.padEnd(13)} ERROR: ${r.error}`
    : `  ${r.id.padEnd(13)} ${String(r.chars).padStart(6)}c ${String(r.lines).padStart(4)}L ${String(r.ms).padStart(4)}ms` +
      ` ${r.hasEntryPoints ? 'EP ' : '   '}` +
      `${r.hasFlowTrace ? 'TRC ' : '    '}` +
      `${r.hasRouteManifest ? 'MAN ' : '    '}` +
      `${r.hasTopHandler ? 'HND ' : '    '}` +
      `${r.hasSmallRepoTail ? 'TAIL' : '    '}`;
console.log(`=== probe-sweep tool=${TOOL} n=${subjects.length} (${Date.now() - t0}ms total) ===`);
console.log('  id            chars  lines    ms signals');
console.log('  ' + '-'.repeat(56));
for (const r of rows) console.log(fmt(r));

// Sum + medians for the size pillar
const sizes = rows.filter(r => !r.error).map(r => r.chars);
sizes.sort((a, b) => a - b);
const median = sizes[Math.floor(sizes.length / 2)];
const sum = sizes.reduce((a, b) => a + b, 0);
console.log(`  ${'-'.repeat(64)}`);
console.log(`  median=${median}c  total=${sum}c  ` +
  `manifest=${rows.filter(r => r.hasRouteManifest).length}/${rows.filter(r => !r.error).length}  ` +
  `top-handler=${rows.filter(r => r.hasTopHandler).length}/${rows.filter(r => !r.error).length}`);
