/**
 * The React resolver's hook (`use…`) and context (`…Context` / `…Provider`)
 * rules are a script's, never another language's: in halo — a Spring app
 * with a React-detected UI package — Java imports of `SecurityContext` or
 * `ObjectProvider` were taken by the context rule, and a Java test's own
 * `responseContext()` helper went unresolved.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-react-lang-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18' } }),
    'ui/src/ThemeContext.tsx': `import { createContext } from 'react';

export const responseContext = createContext(null);
`,
    'src/main/java/app/Filter.java': `package app;

import org.springframework.security.core.context.SecurityContext;

public class Filter {
  Object responseContext() {
    return null;
  }

  void filter() {
    responseContext();
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

describe('the React resolver', () => {
  it('does not take a Java import of a …Context class', () => {
    const ids = cg.getNodesInFile('src/main/java/app/Filter.java').map((n) => n.id);
    const byReact = cg.getOutgoingEdgesFrom(ids).filter((e) => (e.metadata as { framework?: string } | undefined)?.framework === 'react');
    expect(byReact).toEqual([]);
  });

  it('leaves a Java call named like a context to Java', () => {
    const filter = cg.getNodesInFile('src/main/java/app/Filter.java').find((n) => n.name === 'filter')!;
    const targets = cg.getOutgoingEdges(filter.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!);
    expect(targets.map((t) => t.filePath)).not.toContain('ui/src/ThemeContext.tsx');
    expect(targets.map((t) => t.qualifiedName)).toContain('app::Filter::responseContext');
  });
});
