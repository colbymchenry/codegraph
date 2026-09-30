/**
 * In a monorepo, a file-based router reads only its own app's files.
 *
 * create-t3-turbo, tamagui's starter and react-native-reusables keep an Expo
 * app beside a Next.js app. Expo Router read the Next app's `app/` folder as
 * its own: `app/layout.tsx` became a `/layout` screen, `app/page.tsx` a
 * `/page` one, a `_components/posts.tsx` a `/_components/posts` screen, and
 * `app/api/auth/[...all]/route.ts` a screen named after the file.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-app-frameworks-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const routesIn = (cg: CodeGraph, dir: string): string[] =>
  cg
    .getNodesByKind('route')
    .filter((n) => n.filePath.startsWith(dir))
    .map((n) => n.name)
    .sort();

describe('file-based routers in a monorepo', () => {
  it('Expo Router reads the Expo app, Next.js the Next app', async () => {
    const cg = await project({
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }),
      'apps/mobile/package.json': JSON.stringify({ name: 'mobile', dependencies: { expo: '*', 'expo-router': '*', react: '*' } }),
      'apps/mobile/app/_layout.tsx': `export default function Layout() { return null; }
`,
      'apps/mobile/app/index.tsx': `export default function Home() { return null; }
`,
      'apps/mobile/app/user/[id].tsx': `export default function User() { return null; }
`,
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '*', react: '*' } }),
      'apps/web/app/layout.tsx': `export default function RootLayout({ children }: { children: unknown }) { return children; }
`,
      'apps/web/app/page.tsx': `export default function Page() { return null; }
`,
      'apps/web/app/user/[id]/page.tsx': `export default function UserPage() { return null; }
`,
      'apps/web/app/_components/posts.tsx': `export default function Posts() { return null; }
`,
      'apps/web/app/api/auth/[...all]/route.ts': `export async function GET() { return new Response('ok'); }
`,
    });
    try {
      expect(routesIn(cg, 'apps/mobile/')).toEqual(['/', '/user/[id]']);
      const web = routesIn(cg, 'apps/web/');
      expect(web).toContain('/');
      expect(web).toContain('/user/:id');
      for (const bogus of ['/layout', '/page', '/_components/posts', '/api/auth/[...all]/route', '/user/[id]/page']) {
        expect(web).not.toContain(bogus);
      }
    } finally {
      cg.close();
    }
  });

  it('a single Expo app at the repository root keeps its routes', async () => {
    const cg = await project({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { expo: '*', 'expo-router': '*' } }),
      'app/_layout.tsx': `export default function Layout() { return null; }
`,
      'app/settings.tsx': `export default function Settings() { return null; }
`,
    });
    try {
      expect(routesIn(cg, 'app/')).toEqual(['/settings']);
    } finally {
      cg.close();
    }
  });
});
