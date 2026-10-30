/**
 * An Astro component is used in Astro markup, so the component name
 * heuristic applies to `.astro` files only: astrowind's `types.d.ts`
 * (`image?: Image`, `callToAction?: CallToAction`) and starlight's
 * Playwright `page: Page` went to `Image.astro`, `CallToAction.astro` and
 * `Page.astro`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-astro-markup-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'site', private: true, dependencies: { astro: '^5.0.0' }, devDependencies: { '@playwright/test': '^1.0.0' } }),
    'astro.config.mjs': 'export default {};\n',
    'src/components/Page.astro': `---
const { title } = Astro.props;
---
<main>{title}</main>
`,
    'tests/test-utils.ts': `import { type Page } from '@playwright/test';

export class StarlightPage {
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Astro components', () => {
  it('are never what a TypeScript type name means', () => {
    const ids = cg.getNodesInFile('tests/test-utils.ts').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).not.toContain('src/components/Page.astro');
  });
});
