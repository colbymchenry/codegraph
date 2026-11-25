/**
 * A call through a name destructured from a call's result — a composable or
 * a custom hook — reaches the function that callee returns under that key:
 * `const { getDefaultActivityRoute } = useDefaultActivity()` (mealie, where the
 * function is a module-level one the composable returns), `const { t } =
 * useI18n()`, `const { login } = useAuth()` (declared in the hook's body).
 * The local binding used to rule out every cross-file candidate.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-destructured-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3' } }),
    'src/composables/use-default-activity.ts': `function getDefaultActivityRoute(key?: string): string {
  return key ?? '/';
}
export default function useDefaultActivity() {
  return { getDefaultActivityRoute };
}
`,
    'src/hooks/useAuth.ts': `export function useAuth() {
  function login(user: string) {
    return user;
  }
  const logout = () => null;
  return { login, signOut: logout };
}
`,
    'src/pages/index.ts': `import useDefaultActivity from '../composables/use-default-activity';
import { useAuth } from '../hooks/useAuth';
export function go() {
  const { getDefaultActivityRoute } = useDefaultActivity();
  const { login, signOut: leave } = useAuth();
  login('ada');
  leave();
  return getDefaultActivityRoute('x');
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

describe('names destructured from a call', () => {
  it('reach what the callee returns under that key', () => {
    const go = cg.getNodesInFile('src/pages/index.ts').find((n) => n.name === 'go')!;
    const targets = cg
      .getOutgoingEdges(go.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${cg.getNode(e.target)!.filePath}:${cg.getNode(e.target)!.name}`);
    expect(targets).toContain('src/composables/use-default-activity.ts:getDefaultActivityRoute');
    expect(targets).toContain('src/hooks/useAuth.ts:login');
  });
});
