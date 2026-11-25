/**
 * A test suite is not linked into the program, so production code never
 * means one of its symbols by name: typeorm's `Record<string, …>` bound to a
 * test entity `Record`, okhttp's samples' `@Override` to a test's nested
 * `Override`. Test-support code a project ships (`testing/`) stays in reach,
 * and a test still reaches another test's helpers.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prod-test-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'orm', private: true }),
    'test/functional/entity/Record.ts': `export class Record {
  id = 0;
}
`,
    'test/functional/helpers.ts': `export function makeFixture(): number {
  return 1;
}
`,
    'test/functional/record.test.ts': `export function uses(): number {
  return makeFixture();
}
`,
    'src/testing/stub.ts': `export function stubConnection(): number {
  return 2;
}
`,
    'src/columns.ts': `export function toJson(values: Record<string, number>): string {
  return JSON.stringify(values);
}

export function connect(): number {
  return stubConnection();
}
`,
    'src/main/java/app/Service.java': `package app;

public class Service implements Runnable {
  @Override
  public void run() { }
}
`,
    'src/test/java/app/InterceptorTest.java': `package app;

public class InterceptorTest {
  @interface Override { }
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.filePath);
};

describe('production code and test suites', () => {
  it('production code never names a test suite’s symbol', () => {
    expect(targetsFrom('src/columns.ts')).not.toContain('test/functional/entity/Record.ts');
    expect(targetsFrom('src/main/java/app/Service.java')).not.toContain('src/test/java/app/InterceptorTest.java');
  });

  it('shipped test support stays in reach, and tests reach each other', () => {
    expect(targetsFrom('src/columns.ts')).toContain('src/testing/stub.ts');
    expect(targetsFrom('test/functional/record.test.ts')).toContain('test/functional/helpers.ts');
  });
});
