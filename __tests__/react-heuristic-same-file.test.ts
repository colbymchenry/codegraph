/**
 * In a JS/TS module another file's binding is reached only through an
 * import — the import resolver's to follow — so the React resolver's hook
 * and context heuristics pick from the reference's own file alone. trpc's
 * WebSocket adapter's `createContext?.(…)` (an option) went to an example
 * app's `createContext`, and bulletproof-react's per-app `useUser()` to
 * another app's hook.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-react-heur-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'trpc', private: true, dependencies: { react: '^18.0.0' } }),
    'examples/next-app/src/server/context.ts': `export async function createContext() {
  return {};
}
`,
    'apps/nextjs-app/src/lib/auth.tsx': `export function useUser() {
  return null;
}
`,
    'packages/server/src/adapters/ws.ts': `export function getHandler(opts: any) {
  const { createContext } = opts;
  return createContext?.({});
}
`,
    'apps/react-vite/src/lib/auth.tsx': `const { useUser } = configureAuth({});

export function AuthLoader() {
  const user = useUser();
  return user;
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

const targetFilesFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.filePath);
};

describe('React name heuristics in JS/TS', () => {
  it('never reach another file’s hook or context by name', () => {
    expect(targetFilesFrom('packages/server/src/adapters/ws.ts')).not.toContain('examples/next-app/src/server/context.ts');
    expect(targetFilesFrom('apps/react-vite/src/lib/auth.tsx')).not.toContain('apps/nextjs-app/src/lib/auth.tsx');
  });
});
