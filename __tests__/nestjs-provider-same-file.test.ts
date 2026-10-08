/**
 * The NestJS provider convention (`*Service`, `*Controller`, …) picks a
 * class by name only from the reference's own file in a TS/JS module —
 * another file's comes through an import, the import resolver's. Its
 * file-name preference (`*.service.ts`) beat name matching's proximity:
 * Nest's own specs' `TransientService` / `TestService` went to same-named
 * classes in unrelated integration apps.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nest-provider-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'nest', private: true, dependencies: { '@nestjs/common': '^10.0.0' } }),
    'integration/injector/src/app.module.ts': `import { Module } from '@nestjs/common';

@Module({})
export class AppModule {}
`,
    'integration/injector/src/scoped/transient.service.ts': `export class TransientService {}
`,
    'packages/core/test/scope/helpers.ts': `export class TransientService {}
`,
    'packages/core/test/scope/transient-scope.spec.ts': `class Holder {
  constructor(public transient: TransientService) {}
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

describe('NestJS provider names', () => {
  it('never prefer another file’s class for its file name over a nearer one', () => {
    const ids = cg.getNodesInFile('packages/core/test/scope/transient-scope.spec.ts').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).not.toContain('integration/injector/src/scoped/transient.service.ts');
  });
});
