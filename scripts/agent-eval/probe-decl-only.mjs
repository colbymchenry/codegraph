#!/usr/bin/env node
/**
 * CG-28 measurement probe — what a DECLARATION-ONLY file takes from an explore
 * envelope, with and without a generated banner.
 *
 * The issue was filed because a Wrangler `worker-configuration.d.ts` scored 49
 * at `pen 1.00` and took 60.7% of an envelope on generic identifier overlap
 * (`ReadableStream`, `Body`, `ImageMetadata`, `Message`, …) with a prose query.
 * CG-25 has since taught `GENERATED_CONTENT_PATTERNS` the Wrangler banner, so
 * the first thing to measure is whether that alone settles it — it does, and
 * this probe quantifies it. What CG-25 does NOT cover is a declaration-only file
 * that carries no banner at all: a hand-maintained ambient `.d.ts`, vendored
 * typings, module augmentation. This probe puts both shapes in ONE fixture
 * against ONE envelope so the banner is the only difference between them.
 * (`.pyi` is not an indexed extension, so Python stubs never enter the graph.)
 *
 * Findings and the full regression evidence:
 * `docs/benchmarks/explore-declaration-only-cg28.md`.
 *
 * Fixture: `__tests__/fixtures/ambient-decls-ts/` — an upload path (route →
 * stream → metadata → queue) competing with:
 *   types/worker-configuration.d.ts  declaration-only, Wrangler banner (CG-25)
 *   types/platform-shims.d.ts        declaration-only, hand-written, NO banner
 *   src/storage/types.ts             declaration-only but IMPORTED — the control
 *                                    that must never be damped
 *
 * Variants (`--variant`):
 *   both          as committed — the controlled comparison
 *   strip-banner  the banner is deleted from worker-configuration.d.ts, so the
 *                 two declaration files differ in NOTHING the ranker can see;
 *                 the delta against `both` is exactly what CG-25 buys
 *
 * Usage (needs a current `npm run build`):
 *   node scripts/agent-eval/probe-decl-only.mjs
 *   node scripts/agent-eval/probe-decl-only.mjs --variant strip-banner
 *   node scripts/agent-eval/probe-decl-only.mjs --json
 *   node scripts/agent-eval/probe-decl-only.mjs --query "..."
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const FIXTURE = join(REPO_ROOT, '__tests__/fixtures/ambient-decls-ts');

const GENERATED_DECL = 'types/worker-configuration.d.ts';
const HANDWRITTEN_DECL = 'types/platform-shims.d.ts';

/**
 * The query shapes. The flow ones are prose and name no symbol — the shape that
 * let the original file in. The last one is the counter-case the issue requires:
 * a question genuinely ABOUT a declared type must still reach the declaration.
 */
const QUERIES = [
  { id: 'flow-upload', kind: 'flow', text: 'how does an upload request stream the file body to storage and record image metadata' },
  { id: 'flow-pipe', kind: 'flow', text: 'where does the upload body get piped into the bucket and the metadata written' },
  { id: 'flow-generic', kind: 'flow', text: 'how are streams and messages and image metadata handled for uploads' },
  { id: 'flow-queue', kind: 'flow', text: 'what happens after an object is stored and the follow-up message is queued' },
  { id: 'type-shim', kind: 'type', text: 'UploadStorage StoredUploadObject ImageMetadataShim' },
  { id: 'type-prose', kind: 'type', text: 'what does the UploadStorage interface declare for putting an object' },
];

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const VARIANT = at('--variant') ?? 'both';
const ONE_QUERY = at('--query');
const ONE_ID = at('--only');

const say = (s = '') => { if (!asJson) console.log(s); };
const num = (n) => Math.round(n).toLocaleString('en-US');
const pct = (f) => `${(f * 100).toFixed(1)}%`;

if (!existsSync(join(REPO_ROOT, 'dist/index.js'))) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const load = (rel) => import(pathToFileURL(resolve(REPO_ROOT, rel)).href);
const idxMod = await load('dist/index.js');
const toolsMod = await load('dist/mcp/tools.js');
const CodeGraph = idxMod.default?.default ?? idxMod.default ?? idxMod.CodeGraph;
const ToolHandler = toolsMod.ToolHandler ?? toolsMod.default?.ToolHandler;

/** Copy the fixture, apply the variant, index it. Hermetic per run. */
function materialize(variant) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-decl-'));
  cpSync(FIXTURE, dir, { recursive: true });
  rmSync(join(dir, '.codegraph'), { recursive: true, force: true });
  if (variant === 'strip-banner') {
    const p = join(dir, GENERATED_DECL);
    // Drop only the banner comment lines; every declaration stays.
    const kept = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\/\/ .*(Generated by Wrangler|Runtime types generated)/.test(l));
    writeFileSync(p, kept.join('\n'));
  } else if (variant !== 'both') {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`unknown --variant ${variant} (both | strip-banner)`);
  }
  return dir;
}

const queries = ONE_QUERY
  ? [{ id: 'custom', kind: 'flow', text: ONE_QUERY }]
  : QUERIES.filter((q) => !ONE_ID || q.id === ONE_ID);

const dir = materialize(VARIANT);
let rows;
try {
  let cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close?.();

  const sidecar = join(dir, 'diag.jsonl');
  rows = [];
  for (const q of queries) {
    rmSync(sidecar, { force: true });
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    cg = CodeGraph.openSync(dir);
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: q.text });
    const text = res.content?.[0]?.text ?? '';
    cg.close?.();
    delete process.env.CODEGRAPH_EXPLORE_DEBUG;
    const report = JSON.parse(readFileSync(sidecar, 'utf8').trim().split('\n').pop());

    const pick = (path) => {
      const f = report.files.find((x) => x.path === path);
      if (!f) return null;
      return {
        path, rank: f.rank, score: f.score, graph: f.graphScore, hits: f.termHits,
        penalty: f.penalty, generated: f.generated, render: f.render,
        named: f.named, entry: f.entry, central: f.central,
        allocatedShare: f.allocatedShare, share: f.share,
        emitted: f.emittedChars, final: f.finalChars, skipped: f.skipped,
      };
    };
    const declPaths = new Set([GENERATED_DECL, HANDWRITTEN_DECL]);
    const totalSource = report.files.reduce((a, f) => a + f.finalChars, 0);
    const declSource = report.files
      .filter((f) => declPaths.has(f.path))
      .reduce((a, f) => a + f.finalChars, 0);
    // "Named in the response but carrying no source" is the correct outcome for
    // a cliffed declaration file — the agent can still fetch it in one call.
    const namedInResponse = (p) => text.includes(p);

    rows.push({
      query: q.id, kind: q.kind, text: q.text,
      envelope: report.envelope,
      generatedDecl: pick(GENERATED_DECL),
      handwrittenDecl: pick(HANDWRITTEN_DECL),
      declSourceShare: totalSource > 0 ? declSource / totalSource : 0,
      implSourceShare: totalSource > 0 ? (totalSource - declSource) / totalSource : 0,
      topFile: report.files.filter((f) => f.finalChars > 0).sort((a, b) => b.finalChars - a.finalChars)[0]?.path ?? null,
      generatedNamed: namedInResponse(GENERATED_DECL),
      handwrittenNamed: namedInResponse(HANDWRITTEN_DECL),
      files: report.files
        .filter((f) => f.emittedChars > 0 || f.finalChars > 0)
        .map((f) => ({ rank: f.rank, path: f.path, score: f.score, graph: f.graphScore, hits: f.termHits, penalty: f.penalty, generated: f.generated, declOnly: f.ambientDeclaration, named: f.named, entry: f.entry, central: f.central, render: f.render, final: f.finalChars, share: f.share })),
    });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify({ variant: VARIANT, rows }, null, 2));
} else {
  say(`variant  ${VARIANT}`);
  say('');
  for (const r of rows) {
    say(`── ${r.query} [${r.kind}]  "${r.text}"`);
    say(`   envelope ${num(r.envelope.chars)} chars · decl-only files hold ${pct(r.declSourceShare)} of delivered source`);
    say('    #  deliv%    bytes  score    graph  hits  pen   gen  flags               render     file');
    for (const f of r.files) {
      const flags = [f.named && "named", f.entry && "entry", f.central && "central", f.declOnly && "decl-only"].filter(Boolean).join(" ") || "-";
      say(
        '   ' + String(f.rank).padStart(2) + '  ' +
        pct(f.share).padStart(6) + '  ' +
        num(f.final).padStart(7) + '  ' +
        Number(f.score).toFixed(1).padStart(5) + '  ' +
        f.graph.toFixed(5).padStart(7) + '  ' +
        String(f.hits).padStart(4) + '  ' +
        f.penalty.toFixed(2).padStart(4) + '  ' +
        (f.generated ? ' ✓ ' : '   ') + '  ' +
        flags.padEnd(18) + '  ' +
        (f.render ?? '-').padEnd(9) + '  ' +
        f.path,
      );
    }
    for (const [label, d, named] of [
      ['generated  ', r.generatedDecl, r.generatedNamed],
      ['handwritten', r.handwrittenDecl, r.handwrittenNamed],
    ]) {
      say(`   ${label} ${d ? `rank #${d.rank}, score ${Number(d.score).toFixed(1)}, pen ${d.penalty.toFixed(2)}, ${num(d.final)} chars (${pct(d.share)})${d.final === 0 ? ` — ${d.skipped ?? d.render ?? 'not rendered'}` : ''}` : 'not a candidate'}${named ? ' · named in response' : ''}`);
    }
    say('');
  }
}
