#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const CodeGraph = require('../../dist/index.js').default;
const { ToolHandler } = require('../../dist/mcp/tools.js');
const { scipStatus } = require('../../dist/scip/index.js');
const { scipVerdict } = require('../../dist/scip/notes.js');
const { SCIP_LANGUAGES, needsMerge, forgetMerges } = require('../../dist/scip/store.js');

function pickLang(root) {
  for (const lang of SCIP_LANGUAGES) {
    if (fs.existsSync(path.join(root, '.codegraph/scip', `${lang}.scip`))) return lang;
  }
  throw new Error('no installed scip index');
}

async function main() {
  const root = process.argv[2];
  const label = process.argv[3] || path.basename(root);
  if (!root) throw new Error('usage: verify-on-repo.js <projectRoot> [label]');

  const lang = pickLang(root);
  const cg = await CodeGraph.open(root);
  const db = cg.scipReadDb();
  const status0 = scipStatus(db, root);
  console.log(`[${label}] lang=${lang}`);
  console.log(`[${label}] STATUS`, JSON.stringify(status0.edges));

  const tgt = db.prepare(`
    SELECT t.id, t.qualified_name, t.name, COUNT(*) AS n
    FROM edges e JOIN nodes t ON t.id = e.target
    WHERE e.kind='calls' AND e.provenance='scip' AND e.line IS NOT NULL
      AND t.kind IN ('function','method')
    GROUP BY t.id ORDER BY n DESC LIMIT 1`).get();
  if (!tgt) {
    console.log(`[${label}] FAIL no scip call target`);
    cg.close();
    process.exitCode = 1;
    return;
  }
  console.log(`[${label}] TARGET ${tgt.qualified_name} (${tgt.n} scip callers)`);

  const q = `${tgt.qualified_name.replace(/::/g, ' ').replace(/\./g, ' ')} callers`;
  const th = new ToolHandler(cg);
  const text = (await th.execute('codegraph_explore', { query: q })).content[0].text;
  const has = text.includes('**Call sites of');
  console.log(`[${label}] HAS_CALL_SITES ${has}`);
  if (!has) {
    console.log(`[${label}] FAIL explore missing call-sites section`);
    cg.close();
    process.exitCode = 1;
    return;
  }

  const edge = db.prepare(`
    SELECT id FROM edges WHERE target=? AND kind='calls' AND provenance='scip' AND line IS NOT NULL
      AND (metadata IS NULL OR (metadata NOT LIKE '%"scipSilent":true%' AND metadata NOT LIKE '%"scipStale":true%'))
    LIMIT 1`).get(tgt.id);
  if (!edge) {
    console.log(`[${label}] FAIL no verified scip edge to plant`);
    cg.close();
    process.exitCode = 1;
    return;
  }
  db.prepare(`UPDATE edges SET metadata = json_set(COALESCE(metadata,'{}'), '$.scipStale', json('true')) WHERE id=?`).run(edge.id);
  const row = db.prepare('SELECT provenance, metadata FROM edges WHERE id=?').get(edge.id);
  const verdict = scipVerdict({ provenance: row.provenance, metadata: JSON.parse(row.metadata) });
  console.log(`[${label}] VERDICT_PLANTED ${verdict}`);

  const s2 = scipStatus(db, root);
  const deltaOk = s2.edges.stale === status0.edges.stale + 1 && s2.edges.scip === status0.edges.scip - 1;
  console.log(`[${label}] STATUS_AFTER`, JSON.stringify(s2.edges), 'deltaOk', deltaOk);

  const t2 = (await th.execute('codegraph_explore', { query: q })).content[0].text;
  const marked = /\[unverified\]/.test(t2) || /not \(marked\)/.test(t2);
  console.log(`[${label}] EXPLORE_UNVERIFIED_MARK ${marked}`);

  forgetMerges(db);
  const pending = needsMerge(db, root);
  console.log(`[${label}] FORGOT_MERGES needsMerge=${pending}`);

  cg.close();

  const results = {
    label, lang, hasCallSites: has, verdict, deltaOk, marked,
    needsMerge: pending,
  };
  fs.writeFileSync(path.join(root, '..', `${label}-probe.json`), JSON.stringify(results, null, 2));
  if (verdict !== 'unverified' || !deltaOk || !marked || !has) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
