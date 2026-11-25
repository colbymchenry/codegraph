/**
 * Which `package.json` files framework detection reads
 * (`src/resolution/frameworks/package-deps.ts`).
 *
 * The index lists source files, never manifests, so the candidates are
 * directories probed on disk. An ASP.NET solution keeps its single-page app
 * three levels down: jasontaylordev/CleanArchitecture's Angular app is
 * `src/Web/ClientApp/` and its React twin `src/Web/ClientApp-React/`.
 * prometheus keeps its React apps in `web/ui/mantine-ui/` and
 * `web/ui/react-app/`, under a workspace root at `web/ui/` that declares only
 * tooling. Read two levels deep, none of those manifests was read, so Angular
 * Router, the Angular template pass and React Router's navigation never ran,
 * and every template-bound handler was listed as dead code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { declaredDependencies, dependsOn } from '../src/resolution/frameworks/package-deps';
import type { ResolutionContext } from '../src/resolution/types';

/** A context over an indexed file list and the manifests on disk, recording every probe. */
function tree(files: string[], manifests: Record<string, Record<string, Record<string, string>>>) {
  const probes: string[] = [];
  const context = {
    getAllFiles: () => files,
    fileExists: (p: string) => {
      probes.push(p);
      return p in manifests;
    },
    readFile: (p: string) => (p in manifests ? JSON.stringify(manifests[p]) : null),
  } as unknown as ResolutionContext;
  return { context, probes };
}

describe('declaredDependencies: manifests below the first two levels', () => {
  it.each([
    ['src/Web/ClientApp/', 'an ASP.NET solution'],
    ['src/Presentation/Web/ClientApp/', 'a solution folder deeper still'],
  ])('reads %s, where %s keeps its app', (app) => {
    const { context } = tree(
      ['src/Web/Program.cs', `${app}karma.conf.js`, `${app}src/main.ts`, `${app}src/app/app.module.ts`],
      { [`${app}package.json`]: { dependencies: { '@angular/core': '^21.1.5', '@angular/router': '^21.1.5' } } }
    );
    expect(dependsOn(context, '@angular/router')).toBe(true);
  });

  it('reads a workspace root two levels down and the apps a level below it', () => {
    const { context } = tree(
      ['cmd/prometheus/main.go', 'web/ui/mantine-ui/src/main.tsx', 'web/ui/react-app/src/App.tsx', 'web/ui/module/lezer-promql/src/index.ts'],
      {
        'web/ui/package.json': { devDependencies: { typescript: '*', vite: '*' } },
        'web/ui/mantine-ui/package.json': { dependencies: { react: '*', 'react-router-dom': '*' } },
        'web/ui/react-app/package.json': { dependencies: { react: '*', 'react-router': '*' } },
      }
    );
    const names = declaredDependencies(context);
    expect([...names].sort()).toEqual(['react', 'react-router', 'react-router-dom', 'typescript', 'vite']);
  });

  it('never reads a manifest inside node_modules', () => {
    const { context, probes } = tree(
      ['tools/site/node_modules/framework/dist/index.js', 'tools/site/src/index.ts'],
      { 'tools/site/node_modules/framework/package.json': { dependencies: { next: '*' } } }
    );
    expect(dependsOn(context, 'next')).toBe(false);
    expect(probes.filter((p) => p.includes('node_modules'))).toEqual([]);
  });

  it('probes only above JS/TS code, and a bounded number of directories however many hold it', () => {
    const files = ['src/Api/Tools/Generator.cs'];
    for (let i = 0; i < 3000; i++) files.push(`src/app/feature${i}/parts/widget.component.ts`);
    const { context, probes } = tree(files, { 'src/Api/Tools/package.json': { dependencies: { express: '*' } } });
    expect(dependsOn(context, 'express')).toBe(false);
    // `src/`, `src/Api/`, `src/app/` from the first two levels; the rest below them.
    expect(probes.length).toBeLessThanOrEqual(3 + 192);
  });

  it('reads the same manifests whatever order the files are listed in', () => {
    const files: string[] = [];
    const manifests: Record<string, Record<string, Record<string, string>>> = {};
    for (let i = 0; i < 40; i++) {
      files.push(`clients/web/app${i}/src/index.ts`);
      manifests[`clients/web/app${i}/package.json`] = { dependencies: { [`dep-${i}`]: '*' } };
    }
    const scanned = declaredDependencies(tree(files, manifests).context);
    const reversed = declaredDependencies(tree([...files].reverse(), manifests).context);
    expect([...reversed].sort()).toEqual([...scanned].sort());
    // A sample, as above two levels: the root and 24 more.
    expect(scanned.size).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// End to end: CleanArchitecture's shape
// ---------------------------------------------------------------------------

const ngComponent = (name: string, selector: string, templateUrl: string, body = '', imports = '') => `import { Component } from '@angular/core';
${imports}
@Component({
  standalone: false,
  selector: '${selector}',
  templateUrl: '${templateUrl}'
})
export class ${name} {
${body}
}
`;

describe('an ASP.NET solution with its single-page apps three levels down, indexed', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deep-manifest-'));
    const files: Record<string, string> = {
      'src/Web/Program.cs': 'var app = WebApplication.CreateBuilder(args).Build();\napp.Run();\n',
      'src/Web/ClientApp/package.json': JSON.stringify({ dependencies: { '@angular/core': '^21.1.5', '@angular/router': '^21.1.5' } }),
      'src/Web/ClientApp/angular.json': '{}',
      'src/Web/ClientApp/src/app/app.module.ts': `import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { HomeComponent } from './home/home.component';
import { CounterComponent } from './counter/counter.component';
import { LoginComponent } from './login/login.component';

@NgModule({
  imports: [
    RouterModule.forRoot([
      { path: '', component: HomeComponent, pathMatch: 'full' },
      { path: 'counter', component: CounterComponent },
      { path: 'login', component: LoginComponent }
    ])
  ]
})
export class AppModule {}
`,
      'src/Web/ClientApp/src/app/home/home.component.ts': ngComponent('HomeComponent', 'app-home', './home.component.html'),
      'src/Web/ClientApp/src/app/home/home.component.html': '<h1>Hello, world!</h1>\n',
      'src/Web/ClientApp/src/app/login/login.component.ts': ngComponent('LoginComponent', 'app-login', './login.component.html'),
      'src/Web/ClientApp/src/app/login/login.component.html': '<h1>Log in</h1>\n',
      'src/Web/ClientApp/src/app/counter/counter.component.ts': ngComponent(
        'CounterComponent',
        'app-counter-component',
        './counter.component.html',
        '  public currentCount = 0;\n\n  public incrementCounter() {\n    this.currentCount++;\n  }'
      ),
      'src/Web/ClientApp/src/app/counter/counter.component.html': '<p>Current count: {{ currentCount }}</p>\n<button (click)="incrementCounter()">Increment</button>\n',
      'src/Web/ClientApp/src/app/nav-menu/nav-menu.component.ts': ngComponent(
        'NavMenuComponent',
        'app-nav-menu',
        './nav-menu.component.html',
        "  constructor(private router: Router) {}\n\n  logout(): void {\n    this.router.navigate(['/login']);\n  }",
        "import { Router } from '@angular/router';"
      ),
      'src/Web/ClientApp/src/app/nav-menu/nav-menu.component.html': `<a [routerLink]="['/counter']">Counter</a>
<a href="#" (click)="logout()">Log out</a>
`,
      'src/Web/ClientApp-React/package.json': JSON.stringify({ dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0', 'react-router-dom': '^7.6.1' } }),
      'src/Web/ClientApp-React/src/App.jsx': `import { Routes, Route } from 'react-router-dom';
import { Home } from './components/Home';
import { Counter } from './components/Counter';
import { LoginPage } from './components/LoginPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/counter" element={<Counter />} />
      <Route path="/login" element={<LoginPage />} />
    </Routes>
  );
}
`,
      'src/Web/ClientApp-React/src/components/Home.jsx': 'export function Home() {\n  return <h1>Hello, world!</h1>;\n}\n',
      'src/Web/ClientApp-React/src/components/Counter.jsx': 'export function Counter() {\n  return <h1>Counter</h1>;\n}\n',
      'src/Web/ClientApp-React/src/components/LoginPage.jsx': 'export function LoginPage() {\n  return <h1>Log in</h1>;\n}\n',
      'src/Web/ClientApp-React/src/components/NavMenu.jsx': `import { Link, useNavigate } from 'react-router-dom';

export function NavMenu() {
  const navigate = useNavigate();
  const handleLogout = (e) => {
    e.preventDefault();
    navigate('/login');
  };
  return (
    <nav>
      <Link to="/counter">Counter</Link>
      <a href="#" onClick={handleLogout}>Log out</a>
    </nav>
  );
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  const routesUnder = (dir: string) => cg.getNodesByKind('route').filter((r) => r.filePath.startsWith(dir));
  const navigations = (dir: string) =>
    routesUnder(dir)
      .flatMap((r) =>
        cg.getIncomingEdgesTo([r.id], ['navigates']).map((e) => `${cg.getNode(e.source)?.name} -> ${r.name} (${(e.metadata as Record<string, unknown>).navMethod})`)
      )
      .sort();

  it('detects the frameworks the nested manifests declare', () => {
    expect(cg.getDetectedFrameworks()).toEqual(expect.arrayContaining(['angular-router', 'react-router']));
  });

  it("reads the Angular app's routes, bound to their components", () => {
    const routes = routesUnder('src/Web/ClientApp/')
      .map((r) => `${r.name} -> ${cg.getOutgoingEdgesFrom([r.id], ['references']).map((e) => cg.getNode(e.target)?.name).join(', ')}`)
      .sort();
    expect(routes).toEqual(['/ -> HomeComponent', '/counter -> CounterComponent', '/login -> LoginComponent']);
  });

  it("draws the Angular app's navigation from routerLink and router.navigate", () => {
    expect(navigations('src/Web/ClientApp/')).toEqual(['NavMenuComponent -> /counter (routerLink)', 'logout -> /login (navigate)']);
  });

  it("links a template's event binding to its handler, so the handler is not dead code", () => {
    const counter = cg.getNodesByKind('class').find((c) => c.name === 'CounterComponent')!;
    const handlers = cg
      .getOutgoingEdgesFrom([counter.id], ['calls'])
      .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'angular-event')
      .map((e) => cg.getNode(e.target)?.name);
    expect(handlers).toEqual(['incrementCounter']);
    const dead = buildDeadCodeReport(cg, { limit: 1000 }).entries.map((e) => e.node.name);
    expect(dead).not.toContain('incrementCounter');
    expect(dead).not.toContain('logout');
  });

  it("resolves the React twin's navigate() as well as its <Link to>", () => {
    expect(navigations('src/Web/ClientApp-React/')).toEqual(['NavMenu -> /counter (link)', 'handleLogout -> /login (navigate)']);
  });
});
