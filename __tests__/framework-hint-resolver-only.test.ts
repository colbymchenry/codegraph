/**
 * `codegraph status` recommends a re-index when a framework arrives or leaves
 * through `package.json` alone.
 *
 * #2516 records the frameworks a full index extracted with, and a sync that
 * detects a different set says the files indexed before it lack the change. A
 * sync detects again only when it extracts a file, though: add `@sveltejs/kit`
 * (or `express`) to `package.json` with no source file edited and nothing is
 * recorded, so status stayed silent while `goto('/login')` in an unchanged
 * `+layout.svelte` (or an unchanged Express app's routes) stayed unlinked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const KIT = JSON.stringify({ name: 'app', devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^4.0.0' } });
const NO_KIT = JSON.stringify({ name: 'app', devDependencies: { svelte: '^4.0.0' } });

describe('framework changes since the last full index, from package.json alone', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const navigates = (): number => {
    const nodes = cg!.getNodesInFile('src/routes/+layout.svelte');
    return cg!.getOutgoingEdgesFrom(nodes.map((n) => n.id)).filter((e) => e.kind === 'navigates').length;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fw-hint-'));
    write('src/routes/+layout.svelte', '<script>\n  import { goto } from "$app/navigation";\n  function out() { goto("/login"); }\n</script>\n');
    write('src/routes/login/+page.svelte', '<h1>login</h1>\n');
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names the SvelteKit router when @sveltejs/kit is added after the index', async () => {
    write('package.json', NO_KIT);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();

    write('package.json', KIT);
    cg.close();
    cg = CodeGraph.openSync(root);
    await cg.sync();
    // The unchanged layout's goto is still unlinked: only a re-index links it...
    expect(navigates()).toBe(0);
    // ...which is what status must now say.
    expect(cg.getFrameworkChangesSinceIndex()?.added).toContain('sveltekit-router');

    cg.close();
    cg = await CodeGraph.recreate(root);
    await cg.indexAll();
    expect(navigates()).toBe(1);
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();
  });

  it('names it as removed when the dependency goes', async () => {
    write('package.json', KIT);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(navigates()).toBe(1);

    write('package.json', NO_KIT);
    cg.close();
    cg = CodeGraph.openSync(root);
    expect(cg.getFrameworkChangesSinceIndex()?.removed).toContain('sveltekit-router');
  });

  it('names Express when it is added with no source file changed', async () => {
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    write('src/server.js', "const express = require('express');\nconst app = express();\napp.get('/hello', (req, res) => res.send('hi'));\n");
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();

    write('package.json', JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0' } }));
    cg.close();
    cg = CodeGraph.openSync(root);
    await cg.sync();
    expect(cg.getFrameworkChangesSinceIndex()?.added).toContain('express');
  });

  it('says nothing when the project is as it was indexed', async () => {
    write('package.json', KIT);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    cg.close();
    cg = CodeGraph.openSync(root);
    await cg.sync();
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();
  });
});
