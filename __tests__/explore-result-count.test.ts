/**
 * codegraph_explore — the "Found N symbols across M files." header reflects the
 * CURATED answer actually rendered, not the raw candidate gather (#1046).
 *
 * A broad natural-language query FTS-matches a huge pool of symbols ("status",
 * "publish", "api" hit a large fraction of any API-heavy repo), but only a
 * handful of files clear the relevance gate + budget and render with source.
 * The header used to report `subgraph.nodes.size` / `fileGroups.size` — the raw
 * pool (260 symbols / 124 files on a 636-file repo) — which read as "wade
 * through 260 results" even though the correctly-ranked answer was the few files
 * below. It now reports only the files whose source survives in the output.
 *
 * The locked invariant: the header's file count EQUALS the number of rendered
 * `**`<path>`**` source sections. Pre-fix that failed whenever the gather
 * exceeded what rendered (here: 8 disconnected "noise" files are gathered but
 * gated out), so this fixture discriminates the fix from the old behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** Files explore rendered as ``**`<path>`**`` source sections (issue #778: bold
 *  labels, not ATX headings). */
function renderedSourceFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*`(.+?)`\*\*/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function headerFileCount(text: string): number | null {
  const m = text.match(/Found \d+ symbols? across (\d+) files?\./);
  return m ? parseInt(m[1], 10) : null;
}

describe('codegraph_explore — curated result count (#1046)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-count-'));

    // The real, connected flow — its symbols call each other, so it clears the
    // relevance gate and renders. snake_case so FTS tokenizes "status" out of
    // the names (camelCase would leave one unmatchable token).
    fs.writeFileSync(path.join(testDir, 'flow.ts'),
      `export function publish_status() { return build_status(); }\n` +
      `export function build_status() { return send_status(); }\n` +
      `export function send_status() { return 'ok'; }\n`);

    // Disconnected "noise" files: each defines ONE symbol that text-matches the
    // query word "status" but calls nothing in the flow. They ARE gathered into
    // the subgraph by FTS (so the OLD header counted them), but score too low to
    // render — exactly the breadth that inflated the count.
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(testDir, `status_widget_${i}.ts`),
        `export function status_widget_${i}() { return ${i}; }\n`);
    }

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('header file count equals the number of rendered source sections', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'publish status' });
    const text = res.content[0].text;

    const headerFiles = headerFileCount(text);
    const rendered = renderedSourceFiles(text);

    expect(headerFiles).not.toBeNull();
    // The core honesty invariant — the header counts what's shown, not the gather.
    expect(headerFiles).toBe(rendered.length);
    // The flow file is the answer and must be among the rendered files.
    expect(rendered).toContain('flow.ts');
    // Curation actually happened: far fewer than the 9 gathered files (1 flow +
    // 8 noise) are reported. Pre-fix this was the inflated gather count.
    expect(headerFiles!).toBeLessThan(5);
    // And the sentinel placeholder never leaks into the rendered header.
    expect(text).not.toContain('codegraph-explore-summary');
  });
});
