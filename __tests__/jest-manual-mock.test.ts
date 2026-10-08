/**
 * A Jest manual mock (`__mocks__/acme-shared.ts`) stands in for a package only
 * while a test runs, so production code that imports the package never means
 * the mock by name: `import { formatLabel } from 'acme-shared'` that the index
 * could not follow bound `formatLabel(…)` to the mock's function, and the real
 * one had no caller (#2455). A file that imports the mock by path still
 * reaches it, and so does a test.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jest-mock-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'acme-monorepo', private: true, workspaces: ['packages/*'] }),
    'packages/common/package.json': JSON.stringify({ name: 'acme-shared', version: '1.0.0' }),
    'packages/common/utils.ts': `export function formatLabel(name: string): string {
  return name.trim().toUpperCase();
}

export function isAdmin(role: string): boolean {
  return role === 'admin';
}
`,
    'packages/api/package.json': JSON.stringify({ name: 'acme-api', version: '1.0.0', dependencies: { 'acme-shared': 'workspace:*' } }),
    'packages/api/__mocks__/acme-shared.ts': `export function formatLabel(name: string): string {
  return 'mock-label';
}

export function isAdmin(role: string): boolean {
  return true;
}

export function resetLabels(): void {}
`,
    'packages/api/src/handler.ts': `import { formatLabel, isAdmin } from 'acme-shared';

export function handleRequest(name: string, role: string): string {
  if (!isAdmin(role)) {
    return 'forbidden';
  }
  return formatLabel(name);
}
`,
    'packages/api/src/preview.ts': `import { formatLabel } from '../__mocks__/acme-shared';

export function previewLabel(name: string): string {
  return formatLabel(name);
}
`,
    'packages/api/src/handler.test.ts': `export function setUp(): void {
  resetLabels();
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

const MOCK = 'packages/api/__mocks__/acme-shared.ts';

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.filePath);
};

describe('a Jest manual mock', () => {
  it('is not what production code importing the package calls', () => {
    expect(targetsFrom('packages/api/src/handler.ts')).not.toContain(MOCK);
  });

  it('is still reached by a file that imports it by path, and by a test', () => {
    expect(targetsFrom('packages/api/src/preview.ts')).toContain(MOCK);
    expect(targetsFrom('packages/api/src/handler.test.ts')).toContain(MOCK);
  });
});
