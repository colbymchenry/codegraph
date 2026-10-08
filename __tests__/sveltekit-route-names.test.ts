/**
 * SvelteKit route names are the URL a browser asks for.
 *
 * - A `(group)` directory organizes layouts and never appears in the URL:
 *   shadcn-svelte's `src/routes/(app)/(layout)/blocks/+page.svelte` is `/blocks`.
 * - `[param=matcher]` is a parameter whose value a matcher checks: `/view/:view`.
 *
 * Named with the groups, no `goto('/blocks')` or `<a href="/blocks">` ever
 * matched its page.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('SvelteKit route names', () => {
  it('drop (group) directories and parameter matchers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sveltekit-groups-'));
    roots.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'site', devDependencies: { '@sveltejs/kit': '*', svelte: '*' } }),
      'src/routes/(app)/(layout)/blocks/+page.svelte': `<h1>Blocks</h1>
`,
      'src/routes/(app)/(layout)/+page.svelte': `<script>
  import { goto } from '$app/navigation';
</script>
<button on:click={() => goto('/blocks')}>Blocks</button>
<a href="/view/card">Card</a>
`,
      'src/routes/(view)/view/[view=view]/+page.svelte': `<p>view</p>
`,
      'src/routes/docs/[...slug=doc]/+page.svelte': `<p>doc</p>
`,
      'src/params/view.ts': `export function match(p: string) { return p.length > 0; }
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const routes = cg.getNodesByKind('route').map((n) => n.name).sort();
      expect(routes).toEqual(['/', '/blocks', '/docs/*slug', '/view/:view']);
      const home = cg.getNodesByKind('route').find((n) => n.name === '/')!;
      const navigates = cg
        .getOutgoingEdgesFrom(cg.getNodesInFile(home.filePath).map((n) => n.id), ['navigates' as never])
        .map((e) => cg.getNode(e.target)!.name)
        .sort();
      expect(navigates).toEqual(['/blocks', '/view/:view']);
    } finally {
      cg.close();
    }
  });
});
