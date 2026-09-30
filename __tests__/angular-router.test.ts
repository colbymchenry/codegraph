/**
 * Angular Router: screens from `Routes` arrays, navigation from command
 * arrays and `routerLink`, the component tree from templates.
 *
 * Validated on angular-realworld-example-app (standalone components, lazy
 * `loadComponent`, a `loadChildren` routes file), ngx-admin (NgModule
 * `loadChildren` through a routing module, layouts, redirects) and Ghostfolio
 * (route constants with `$localize` paths, destructured locals, function
 * constants, a `**` redirect home).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { commandsHref, localizeDefault, parseAngularRoutes, staticString } from '../src/resolution/frameworks/angular-router';
import { buildScreens } from '../src/ui-server/api/screens';

describe('parseAngularRoutes', () => {
  const file = (body: string) => `import { Routes } from '@angular/router';\n${body}`;

  it('reads screens, joining children to their parents, and skips what is not a screen', () => {
    const { routes, mounts, redirects } = parseAngularRoutes(
      file(`export const routes: Routes = [
  { path: '', loadComponent: () => import('./home/home.component') },
  { path: 'login', component: AuthComponent, canActivate: [guard] },
  { path: 'editor', children: [
      { path: '', loadComponent: () => import('./editor.component').then((m) => m.EditorComponent) },
      { path: ':slug', loadComponent: () => import('./editor.component').then((m) => m.EditorComponent) },
  ] },
  { path: 'profile', loadChildren: () => import('./profile/profile.routes') },
  { path: 'users', matcher: usersMatcher, component: UsersComponent },
  { path: 'old', redirectTo: 'login' },
  { path: '**', component: NotFoundComponent },
];`)
    );
    expect(routes.map((r) => [r.path, r.component])).toEqual([
      ['/', { name: null, spec: './home/home.component' }],
      ['/login', { name: 'AuthComponent', spec: null }],
      ['/editor', { name: 'EditorComponent', spec: './editor.component' }],
      ['/editor/:slug', { name: 'EditorComponent', spec: './editor.component' }],
    ]);
    expect(mounts.map((m) => [m.prefix, m.spec])).toEqual([['/profile', './profile/profile.routes']]);
    expect(redirects).toEqual([{ from: '/old', to: '/login', absolute: false }]);
  });

  it('treats a route with children as a layout: a screen only where no child claims its address', () => {
    const { routes } = parseAngularRoutes(
      file(`const routes: Routes = [
  { path: ':username', component: ProfileComponent, children: [
      { path: '', loadComponent: () => import('./articles.component') },
      { path: 'favorites', loadComponent: () => import('./favorites.component') },
  ] },
  { path: 'pages', component: PagesComponent, children: [{ path: 'dashboard', component: DashboardComponent }] },
];
export default routes;`)
    );
    expect(routes.map((r) => [r.path, r.component?.spec ?? r.component?.name, r.layouts.map((l) => l.name)])).toEqual([
      ['/:username', './articles.component', ['ProfileComponent']],
      ['/:username/favorites', './favorites.component', ['ProfileComponent']],
      ['/pages/dashboard', 'DashboardComponent', ['PagesComponent']],
      ['/pages', 'PagesComponent', []],
    ]);
  });

  it('finds the arrays forRoot, forChild, provideRouter and a typed default export hold', () => {
    for (const body of [
      `RouterModule.forRoot([{ path: 'a', component: A }])`,
      `RouterModule.forChild([{ path: 'a', component: A }])`,
      `bootstrapApplication(App, { providers: [provideRouter([{ path: 'a', component: A }])] })`,
      `export default [{ path: 'a', component: A }] satisfies Routes;`,
      `const table = [{ path: 'a', component: A }] as Routes;`,
    ]) {
      expect(parseAngularRoutes(file(body)).routes.map((r) => r.path)).toEqual(['/a']);
    }
    // An array that is not a routes array, in a file that imports the router.
    expect(parseAngularRoutes(file(`const tabs = [{ path: 'a', component: A }];`)).routes).toEqual([]);
    // No router import, no routes.
    expect(parseAngularRoutes(`export const routes = [{ path: 'a', component: A }];`).routes).toEqual([]);
  });

  it('keeps a constant path as a placeholder for the cross-file pass, and reads $localize defaults', () => {
    const { routes, redirects } = parseAngularRoutes(
      file(`export const routes: Routes = [
  { path: internalRoutes.account.path, component: AccountComponent },
  { path: $localize\`:kebab-case@@routes.about:about\`, component: AboutComponent },
  { path: '**', redirectTo: 'home', pathMatch: 'full' },
];`)
    );
    expect(routes.map((r) => r.path)).toEqual(['/{internalRoutes.account.path}', '/about']);
    expect(redirects).toEqual([{ from: '/**', to: '/home', absolute: false }]);
  });
});

describe('Angular destinations', () => {
  it('reads a static string: literals, $localize defaults and + between them', () => {
    expect(staticString(`'/' + $localize\`:kebab-case@@routes.about:about\``)).toBe('/about');
    expect(staticString(`'/editor/' + slug`)).toBeNull();
    expect(localizeDefault('$localize`Access`')).toBe('Access');
  });

  it('reads an absolute command array, holes for what is computed, and nothing for a relative or all-hole one', () => {
    expect(commandsHref(`['/article', article.slug]`)?.display).toBe('/article/${…}');
    expect(commandsHref(`['/profile', p.username, 'favorites']`)?.display).toBe('/profile/${…}/favorites');
    expect(commandsHref(`['/']`)?.display).toBe('/');
    expect(commandsHref(`['../', id]`)).toBeNull();
    expect(commandsHref(`['edit']`)).toBeNull();
    // Nothing static: it would match any route of its length.
    expect(commandsHref('[`/${a}`, b, c]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

const component = (name: string, selector: string, template: string, body = '') => `import { Component } from '@angular/core';
import { Router } from '@angular/router';
@Component({
  selector: '${selector}',
  ${template.startsWith('./') ? `templateUrl: '${template}'` : `template: \`${template}\``},
})
export class ${name} {
  constructor(private readonly router: Router) {}
${body}
}
`;

describe('an Angular app, indexed', () => {
  let cg: CodeGraph;
  let root: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-'));
    projects.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^19.0.0', '@angular/router': '^19.0.0' } }),
      'src/app/routes.constants.ts': `export const internalRoutes = {
  account: { path: 'account', routerLink: ['/account'], subRoutes: { access: { path: 'access', routerLink: (id: string) => ['/account', 'access', id] } } },
  about: { path: $localize\`:kebab-case@@routes.about:about\`, routerLink: ['/' + $localize\`:kebab-case@@routes.about:about\`] },
};
`,
      'src/app/app.routes.ts': `import { Routes } from '@angular/router';
import { AuthComponent } from './auth/auth.component';
import { internalRoutes } from './routes.constants';
const { about } = internalRoutes;
export const routes: Routes = [
  { path: 'home', loadComponent: () => import('./home/home.component') },
  { path: 'login', component: AuthComponent },
  { path: about.path, loadComponent: () => import('./about/about.component').then((m) => m.AboutComponent) },
  { path: internalRoutes.account.path, loadChildren: () => import('./account/account.routes') },
  { path: 'admin', loadChildren: () => import('./admin/admin.module').then((m) => m.AdminModule) },
  { path: '**', redirectTo: 'home' },
];
`,
      'src/app/account/account.routes.ts': `import { Routes } from '@angular/router';
import { AccountComponent } from './account.component';
import { AccessComponent } from './access.component';
import { internalRoutes } from '../routes.constants';
export default [
  { path: '', component: AccountComponent, children: [
      { path: '', loadComponent: () => import('./overview.component') },
      { path: internalRoutes.account.subRoutes.access.path + '/:id', component: AccessComponent },
  ] },
] satisfies Routes;
`,
      // An NgModule's routes live in the routing module it imports.
      'src/app/admin/admin.module.ts': `import { NgModule } from '@angular/core';
import { AdminRoutingModule } from './admin-routing.module';
@NgModule({ imports: [AdminRoutingModule] })
export class AdminModule {}
`,
      'src/app/admin/admin-routing.module.ts': `import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminUsersComponent } from './admin-users.component';
const routes: Routes = [{ path: '', redirectTo: 'users', pathMatch: 'full' }, { path: 'users', component: AdminUsersComponent }];
@NgModule({ imports: [RouterModule.forChild(routes)], exports: [RouterModule] })
export class AdminRoutingModule {}
`,
      'src/app/home/home.component.ts': component('HomeComponent', 'app-home', './home.component.html', `  open(slug: string) { this.router.navigate(['/login']); }
  more() { this.router.navigate([], { queryParams: { page: 2 } }); }`).replace('export class', 'export default class'),
      'src/app/home/home.component.html': `<app-card></app-card>
<a routerLink="/login">Sign in</a>
<a [routerLink]="routerLinkAbout">About</a>
<a [routerLink]="['/account', 'access', 7]">Access</a>
<a routerLink="relative">Relative</a>
`,
      'src/app/shared/card.component.ts': component('CardComponent', 'app-card', `<button (click)="save()">Save</button>`, `  save() { this.router.navigate(internalRoutes.account.subRoutes.access.routerLink('me')); }`).replace(
        "import { Router } from '@angular/router';",
        "import { Router } from '@angular/router';\nimport { internalRoutes } from '../routes.constants';"
      ),
      'src/app/auth/auth.component.ts': component('AuthComponent', 'app-auth', `<a routerLink="/home">Home</a>`, `  done() { this.router.navigate(['/']); }`),
      'src/app/about/about.component.ts': component('AboutComponent', 'app-about', `<p>About</p>`),
      // A tab bar built in the class, handed to a tabs component that binds each `tab.routerLink`.
      'src/app/account/account.component.ts': component(
        'AccountComponent',
        'app-account',
        `<a [routerLink]="['/login']">Log out</a><app-tabs [tabs]="tabs"></app-tabs><router-outlet></router-outlet>`,
        `  tabs = [{ label: 'Access', routerLink: internalRoutes.account.subRoutes.access.routerLink('me') }];`
      ).replace("import { Router } from '@angular/router';", "import { Router } from '@angular/router';\nimport { internalRoutes } from '../routes.constants';"),
      'src/app/account/overview.component.ts': component('OverviewComponent', 'app-overview', `<p>Overview</p>`).replace('export class', 'export default class'),
      'src/app/account/access.component.ts': component('AccessComponent', 'app-access', `<p>Access</p>`),
      'src/app/admin/admin-users.component.ts': component('AdminUsersComponent', 'app-admin-users', `<p>Users</p>`),
    };
    files['src/app/home/home.component.ts'] = files['src/app/home/home.component.ts']!.replace(
      "import { Router } from '@angular/router';",
      "import { Router } from '@angular/router';\nimport { internalRoutes } from '../routes.constants';"
    ).replace('  constructor(', '  protected readonly routerLinkAbout = internalRoutes.about.routerLink;\n  constructor(');
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg.close());

  const routeOf = (id: string) => cg.getNode(id)?.name;

  it('names each screen by the path a user takes to it, bound to its component', () => {
    const routes = cg
      .getNodesByKind('route')
      .map((r) => {
        const bound = cg.getOutgoingEdgesFrom([r.id], ['references']).map((e) => `${(e.metadata as Record<string, unknown>)?.layout ? 'layout ' : ''}${cg.getNode(e.target)?.name}`);
        return `${r.name} -> ${bound.sort().join(', ')}`;
      })
      .sort();
    expect(routes).toEqual([
      '/about -> AboutComponent',
      '/account -> OverviewComponent, layout AccountComponent',
      '/account/access/:id -> AccessComponent, layout AccountComponent',
      '/admin/users -> AdminUsersComponent',
      '/home -> HomeComponent',
      '/login -> AuthComponent',
    ]);
  });

  it('draws navigation from calls and routerLink, through constants, properties and redirects', () => {
    const navigations = cg
      .getNodesByKind('route')
      .flatMap((r) => cg.getIncomingEdgesTo([r.id], ['navigates']).map((e) => `${cg.getNode(e.source)?.name} -> ${r.name} (${(e.metadata as Record<string, unknown>).navMethod})`))
      .sort();
    expect(navigations).toEqual([
      // `navigate(['/'])`: `/` matches no route, and the root `**` redirect sends it home.
      'AccountComponent -> /account/access/:id (routerLink)',
      'AccountComponent -> /login (routerLink)',
      'AuthComponent -> /home (routerLink)',
      'HomeComponent -> /about (routerLink)',
      'HomeComponent -> /account/access/:id (routerLink)',
      'HomeComponent -> /login (routerLink)',
      'done -> /home (navigate)',
      'open -> /login (navigate)',
      // A route constant that builds its commands: `access.routerLink('me')`.
      'save -> /account/access/:id (navigate)',
    ]);
  });

  it('links a template to the components it renders', () => {
    const renders = cg
      .getNodesByKind('class')
      .flatMap((c) =>
        cg
          .getOutgoingEdgesFrom([c.id], ['calls'])
          .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'angular-template')
          .map((e) => `${c.name} -> ${cg.getNode(e.target)?.name} <${(e.metadata as Record<string, unknown>).via}>`)
      );
    expect(renders).toEqual(['HomeComponent -> CardComponent <app-card>']);
  });

  it("draws the Screens picture: a child component's navigation on its screen, a layout's on each screen inside it", async () => {
    const payload = await buildScreens(cg, root);
    expect(payload.routed).toBe(true);
    const links = payload.links.map((l) => `${routeOf(l.from) ?? cg.getNode(l.from)?.name} -> ${routeOf(l.to)}${l.via.length ? ` via ${l.via.map((v) => v.name).join('>')}` : ''}`).sort();
    expect(links).toEqual([
      '/account -> /account/access/:id',
      '/account -> /login',
      '/account/access/:id -> /account/access/:id',
      '/account/access/:id -> /login',
      '/home -> /about',
      '/home -> /account/access/:id',
      '/home -> /account/access/:id via CardComponent>save',
      '/home -> /login',
      '/home -> /login via open',
      '/login -> /home',
      '/login -> /home via done',
    ]);
  });
});
