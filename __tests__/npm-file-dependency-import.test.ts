/**
 * A sibling package declared as `"acme-shared": "file:../common"` is in the
 * repository, so `import { formatLabel } from 'acme-shared/utils'` is an
 * import of `packages/common/utils.ts` — with no root `workspaces` to say so.
 * Before, the import failed and the call was matched by name: right while the
 * name was unique, the nearest same-named function otherwise (#2456).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-npm-file-dep-'));
  const files: Record<string, string> = {
    'packages/common/package.json': JSON.stringify({ name: 'acme-shared', version: '1.0.0' }),
    'packages/common/utils.ts': `export function formatLabel(name: string): string {
  return name.trim().toUpperCase();
}
`,
    'packages/api/package.json': JSON.stringify({ name: 'acme-api', version: '1.0.0', dependencies: { 'acme-shared': 'file:../common' } }),
    // A same-named function next to the caller: what name matching would pick.
    'packages/api/src/labels.ts': `export function formatLabel(name: string): string {
  return name;
}
`,
    'packages/api/src/handler.ts': `import { formatLabel } from 'acme-shared/utils';

export function handleRequest(name: string): string {
  return formatLabel(name);
}
`,
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
    'packages/ui/button.ts': `export function renderButton(text: string): string {
  return text;
}
`,
    'packages/web/package.json': JSON.stringify({ name: 'acme-web', version: '1.0.0', devDependencies: { '@acme/ui': 'link:../ui' } }),
    'packages/web/src/page.ts': `import { renderButton } from '@acme/ui/button';

export function renderPage(): string {
  return renderButton('ok');
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

/** `kind -> file (resolvedBy)` of what `name` in `file` calls, and of what `file` imports. */
const edgesOf = (file: string, name: string) => {
  const nodes = cg.getNodesInFile(file).filter((n) => n.name === name || n.kind === 'file');
  return cg.getOutgoingEdgesFrom(nodes.map((n) => n.id)).filter((e) => e.kind === 'calls' || e.kind === 'imports')
    .map((e) => `${e.kind} -> ${cg.getNode(e.target)!.filePath} (${String(e.metadata?.resolvedBy)})`);
};

describe('an npm dependency on a sibling directory', () => {
  it('file: — the package-name import is the sibling package\'s file', () => {
    const edges = edgesOf('packages/api/src/handler.ts', 'handleRequest');
    expect(edges).toContain('calls -> packages/common/utils.ts (import)');
    expect(edges).toContain('imports -> packages/common/utils.ts (import)');
    expect(edges.filter((e) => e.includes('packages/api/src/labels.ts'))).toEqual([]);
  });

  it('link: in devDependencies, a scoped name', () => {
    expect(edgesOf('packages/web/src/page.ts', 'renderPage')).toContain('calls -> packages/ui/button.ts (import)');
  });
});
