/**
 * A framework resolves only the references written in its own languages.
 * Express is detected in etcd by a file-content scan, and its `logger`
 * middleware rule (a same-file declaration named `logger`) took a Go method's
 * `*zap.Logger` result type for the method itself. A resolver that reads more
 * languages than it extracts from lists them: a SvelteKit `+page.server.ts`
 * still resolves its `$lib/…` imports, and a Razor page's `@model` its
 * PageModel.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getResolvingFrameworks } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';

function writeProject(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('getResolvingFrameworks', () => {
  const go: FrameworkResolver = { name: 'go', languages: ['go'], detect: () => true, resolve: () => null };
  const svelte: FrameworkResolver = {
    name: 'svelte', languages: ['svelte'], resolveLanguages: ['svelte', 'typescript'], detect: () => true, resolve: () => null,
  };
  const any: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

  it('keeps the frameworks that list the language, and those that list none', () => {
    expect(getResolvingFrameworks([go, svelte, any], 'go').map((f) => f.name)).toEqual(['go', 'any']);
    expect(getResolvingFrameworks([go, svelte, any], 'python').map((f) => f.name)).toEqual(['any']);
  });

  it('reads resolveLanguages before languages', () => {
    expect(getResolvingFrameworks([go, svelte, any], 'typescript').map((f) => f.name)).toEqual(['svelte', 'any']);
    expect(getResolvingFrameworks([go, svelte, any], 'svelte').map((f) => f.name)).toEqual(['svelte', 'any']);
  });
});

describe('Express beside Go code (etcd)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-fw-lang-go-', {
      'package.json': JSON.stringify({ name: 'dashboard', dependencies: { express: '^4.19.0' } }),
      'web/server.js': `const express = require('express');
const app = express();

function logger(req, res, next) {
  next();
}

app.use(logger);
app.get('/health', (req, res) => res.json({ ok: true }));
`,
      'go.mod': 'module example.com/kv\n\ngo 1.22\n',
      'server/read/read_test.go': `package read

import "go.uber.org/zap"

type mockServer struct {
	lg *zap.Logger
}

func (s *mockServer) Logger() *zap.Logger { return s.lg }
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves no Go reference', () => {
    const ids = cg.getNodesInFile('server/read/read_test.go').map((n) => n.id);
    const byExpress = cg.getOutgoingEdgesFrom(ids).filter((e) => (e.metadata as { framework?: string } | undefined)?.framework === 'express');
    expect(byExpress).toEqual([]);
  });

  it('does not take a method’s `*zap.Logger` result for the method itself', () => {
    const logger = cg.getNodesInFile('server/read/read_test.go').find((n) => n.kind === 'method' && n.name === 'Logger')!;
    expect(logger).toBeDefined();
    expect(cg.getOutgoingEdges(logger.id).map((e) => e.target)).not.toContain(logger.id);
  });
});

describe('Svelte in a SvelteKit app', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-fw-lang-svelte-', {
      'package.json': JSON.stringify({ name: 'web', devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' } }),
      'src/lib/api.ts': `export async function get(path: string) {
  return fetch(path);
}
`,
      'src/routes/+page.server.ts': `import * as api from '$lib/api';

export async function load() {
  return { articles: await api.get('/articles') };
}
`,
      'src/routes/+page.svelte': `<script>
  let { data } = $props();
</script>

<p>{data.articles}</p>
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('still resolves a `$lib/…` import written in a .ts module', () => {
    const ids = cg.getNodesInFile('src/routes/+page.server.ts').map((n) => n.id);
    const imported = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)!);
    expect(imported.map((n) => n.filePath)).toContain('src/lib/api.ts');
  });
});

describe('ASP.NET in a Razor Pages app (eShopOnWeb)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = writeProject('cg-fw-lang-razor-', {
      'Program.cs': `var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
var app = builder.Build();
app.MapRazorPages();
app.Run();
`,
      'Pages/_ViewImports.cshtml': `@namespace Shop.Web.Pages
@addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers
`,
      'Pages/Index.cshtml': `@page
@model IndexModel
<h1>Catalog</h1>
`,
      'Pages/Index.cshtml.cs': `using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Shop.Web.Pages;

public class IndexModel : PageModel
{
}
`,
      'Pages/Basket/Index.cshtml': `@page
@model IndexModel
<h1>Basket</h1>
`,
      'Pages/Basket/Index.cshtml.cs': `using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Shop.Web.Pages.Basket;

public class IndexModel : PageModel
{
}
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('still links each page’s `@model` to the PageModel beside it', () => {
    const modelOf = (page: string) => {
      const ids = cg.getNodesInFile(page).map((n) => n.id);
      return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.filePath);
    };
    expect(modelOf('Pages/Index.cshtml')).toEqual(['Pages/Index.cshtml.cs']);
    expect(modelOf('Pages/Basket/Index.cshtml')).toEqual(['Pages/Basket/Index.cshtml.cs']);
  });
});
