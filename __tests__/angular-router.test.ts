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
import { readMicrosyntax, templateMemberUses } from '../src/resolution/angular-template-synthesizer';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { buildScreens } from '../src/ui-server/api/screens';
import { buildSteps } from '../src/ui-server/api/steps';

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

describe('what a template reads at render', () => {
  const uses = (template: string) => templateMemberUses(template).map((u) => `${u.name}${u.call ? '()' : ''} ${u.via}`);

  it('reads property bindings, interpolations, structural directives, control flow and @let', () => {
    expect(uses(`<button (click)="cycle()" [attr.aria-label]="label()"><i [name]="icon()"></i></button>`)).toEqual([
      'label() [attr.aria-label]',
      'icon() [name]',
    ]);
    expect(uses(`<p *ngIf="isOpen(); else closed">{{ count() }} {{ total }}</p><ng-template #closed></ng-template>`)).toEqual([
      'isOpen() *ngIf',
      'count() {{ }}',
      'total {{ }}',
    ]);
    expect(uses(`@if (loading()) { x } @else if (failed()) { y } @switch (mode()) { @case (Mode.A) { a } }`)).toEqual([
      'loading() @if',
      'failed() @else if',
      'mode() @switch',
      'Mode @case',
    ]);
    // `on timer(5s)` is a trigger, not a call.
    expect(uses(`@defer (on viewport; when ready(); prefetch on timer(5s)) { x }`)).toEqual(['ready() @defer']);
    expect(uses(`@let total = price() * quantity; <input [(ngModel)]="title">`)).toEqual(['price() @let', 'quantity @let', 'title [(ngModel)]']);
  });

  it("leaves out a pipe, an object key, another object's member, a string, a comment and an event binding", () => {
    expect(uses(`{{ total | currency: code() }} <i [ngClass]="{ active: isActive() }" [x]="form.reset() || this.own()"></i>`)).toEqual([
      'total {{ }}',
      'code() {{ }}',
      'isActive() [ngClass]',
      'form [x]',
      'own() [x]',
    ]);
    expect(uses(`<!-- {{ legacy() }} <b [x]="old()"></b> --> {{ 'quoted()' }} <b (click)="save()"></b>`)).toEqual([]);
    // A template literal's text is a string; its holes are expressions.
    expect(uses('<td [class.today]="isToday(`${key}-${formatDay(day)}`)" [title]="`quoted()`"></td>')).toEqual([
      'isToday() [class.today]',
      'key [class.today]',
      'formatDay() [class.today]',
      'day [class.today]',
    ]);
  });

  it('leaves out the names the template declares, where they are visible', () => {
    // A microsyntax's locals, keys and context names belong to the directive.
    expect(uses(`<li *ngFor="let item of items(); let i = index; trackBy: trackById" [title]="item.name">{{ i }}</li>`)).toEqual([
      'items() *ngFor',
      'trackById *ngFor',
    ]);
    // An alias belongs to the body, not to the condition that names it.
    expect(uses(`@if (user(); as user) { {{ user.name }} }`)).toEqual(['user() @if']);
    expect(uses(`<div *ngIf="user() as user">{{ user.name }}</div>`)).toEqual(['user() *ngIf']);
    // `track` sees the loop's own names.
    expect(uses(`@for (item of items(); track item.id; let odd = $odd) { {{ item.name }} {{ odd }} }`)).toEqual(['items() @for']);
    expect(uses(`@let total = price(); {{ total }}`)).toEqual(['price() @let']);
    // A reference variable is seen across the template, even before it is declared.
    expect(uses(`<b [x]="input.value"></b><input #input>`)).toEqual([]);
    expect(uses(`<ng-template let-row let-i="index">{{ row.name }} {{ i }}</ng-template>`)).toEqual([]);
  });

  it('splits a microsyntax into its expressions and its locals', () => {
    expect(readMicrosyntax('let item of items | async; index as i; trackBy: trackFn')).toEqual({
      expressions: [
        { at: 12, text: 'items | async' },
        { at: 48, text: 'trackFn' },
      ],
      locals: ['item', 'i'],
    });
    expect(readMicrosyntax('user$ | async as user; else loading')).toEqual({
      expressions: [
        { at: 0, text: 'user$ | async ' },
        { at: 28, text: 'loading' },
      ],
      locals: ['user'],
    });
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
      'src/app/shared/card.component.ts': component(
        'CardComponent',
        'app-card',
        `<button (click)="save()">Save</button><input [(ngModel)]="name" /><a (click)="closed.emit(true)">x</a>`,
        `  name = '';
  save() { this.router.navigate(internalRoutes.account.subRoutes.access.routerLink('me')); }`
      ).replace(
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

  it("links a template's event bindings to the component's own methods, the binding as the trigger", async () => {
    const bindings = cg
      .getNodesByKind('class')
      .flatMap((c) =>
        cg
          .getOutgoingEdgesFrom([c.id], ['calls'])
          .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'angular-event')
          .map((e) => {
            const meta = e.metadata as Record<string, unknown>;
            return `${c.name} -> ${cg.getNode(e.target)?.name} ${JSON.stringify(meta.trigger)}`;
          })
      );
    // `[(ngModel)]` is a two-way binding and `closed.emit()` raises the component's own output: neither calls a method.
    expect(bindings).toEqual(['CardComponent -> save {"kind":"prop","name":"(click)","of":"button"}']);

    const home = cg.getNodesByKind('route').find((r) => r.name === '/home')!;
    const payload = await buildSteps(cg, root, new URLSearchParams({ anchor: home.id }));
    const save = payload.steps.find((st) => st.label === 'save');
    expect(save?.trigger).toMatchObject({ kind: 'prop', name: '(click)', of: 'button', in: 'CardComponent' });
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

describe("an Angular template's bindings, indexed", () => {
  let cg: CodeGraph;
  let root: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-bindings-'));
    projects.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^19.0.0', '@angular/router': '^19.0.0' } }),
      'src/app/app.routes.ts': `import { Routes } from '@angular/router';
import { TasksComponent } from './tasks/tasks.component';
export const routes: Routes = [{ path: 'tasks', component: TasksComponent }];
`,
      // An inline template: its bindings are written in the class's own file.
      'src/app/nav/nav.component.ts': `import { Component, signal } from '@angular/core';
@Component({
  selector: 'app-nav',
  template: \`<nav>
    <app-theme-toggle [class.open]="isOpen()" />
  </nav>\`,
})
export class NavComponent {
  isOpen = signal(false);
}
`,
      'src/app/theme-toggle/theme-toggle.component.ts': `import { Component, computed, signal } from '@angular/core';
@Component({ selector: 'app-theme-toggle', templateUrl: './theme-toggle.component.html' })
export class ThemeToggleComponent {
  private readonly theme = signal<'light' | 'dark'>('light');
  icon = computed(() => (this.theme() === 'dark' ? 'moon' : 'sun'));
  label = computed(() => (this.theme() === 'dark' ? 'Dark' : 'Light'));
  cycle(): void {
    this.theme.set(this.theme() === 'dark' ? 'light' : 'dark');
  }
  unused(): void {}
}
`,
      'src/app/theme-toggle/theme-toggle.component.html': `<button (click)="cycle()" [attr.aria-label]="label()">
  <lucide-icon [name]="icon()"></lucide-icon>
</button>
`,
      'src/app/tasks/tasks.component.ts': `import { Component, computed, signal } from '@angular/core';
@Component({ selector: 'app-tasks', templateUrl: './tasks.component.html' })
export class TasksComponent {
  lists = signal<{ id: number; title: string; items: { done: boolean }[] }[]>([]);
  selectedListId = signal<number | null>(null);
  selected = computed(() => this.lists().find((l) => l.id === this.selectedListId()));
  editing = signal(false);
  title = 'Tasks';
  form = { reset() {} };
  days = Array.from({ length: 3 }, (_, i) => i + 1);
  row = computed(() => 0);
  nameInput = (value: string) => value;

  get canSave(): boolean {
    return this.lists().length > 0;
  }
  remainingItems(list: { items: { done: boolean }[] }): number {
    return list.items.filter((i) => !i.done).length;
  }
  trackById(index: number, list: { id: number }): number {
    return list.id;
  }
  displayFn(list: { title: string }): string {
    return list.title;
  }
  format(value: string): string {
    return value;
  }
  reset(): void {}
  set(): void {}
  legacy(): string {
    return '';
  }
  quoted(): string {
    return '';
  }
  save(): void {}
}
`,
      'src/app/tasks/tasks.component.html': `<!-- {{ legacy() }} -->
<h1 [title]="title">{{ 'quoted()' }}</h1>
<input #nameInput [value]="nameInput.value" (blur)="selected() && save()" />
@if (editing()) {
  <span>editing</span>
}
<ul>
  @for (list of lists(); track trackById($index, list)) {
    <li [class.active]="list.id === selectedListId()" (click)="selectedListId.set(list.id)">
      {{ list.title | format }} <small>{{ remainingItems(list) }}</small>
    </li>
  }
</ul>
@for (row of [selected()]; track row) {
  <b>{{ row?.title }}</b>
}
@for (day of days; track day) {
  <i>{{ day }}</i>
}
<mat-autocomplete [displayWith]="displayFn"></mat-autocomplete>
<button [disabled]="!canSave" (click)="form.reset()">Reset</button>
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => cg.close());

  /** `Source -> target [kind] via @ file:line` for every template edge of one mechanism. */
  const templateEdges = (synthesizedBy: string) =>
    cg
      .getNodesByKind('class')
      .flatMap((c) =>
        cg
          .getOutgoingEdgesFrom([c.id], ['calls', 'references'])
          .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === synthesizedBy)
          .map((e) => {
            const meta = e.metadata as Record<string, unknown>;
            const target = cg.getNode(e.target)!;
            return `${c.name} -> ${target.kind} ${target.name} [${e.kind}${meta.fnRef ? ' fnRef' : ''}] ${String(meta.via)} @ ${String(meta.registeredAt)}`;
          })
      )
      .sort();

  it("links each binding's own-member call — and a callable it only reads — to the component, at the binding's line", () => {
    expect(templateEdges('angular-binding')).toEqual([
      'NavComponent -> property isOpen [calls] [class.open] @ src/app/nav/nav.component.ts:5',
      // A getter runs when it is read.
      'TasksComponent -> method canSave [calls] [disabled] @ src/app/tasks/tasks.component.html:21',
      // A field a call filled is read, not called.
      'TasksComponent -> method days [references] @for @ src/app/tasks/tasks.component.html:17',
      // A function handed to a child is a function reference.
      'TasksComponent -> method displayFn [references fnRef] [displayWith] @ src/app/tasks/tasks.component.html:20',
      'TasksComponent -> method remainingItems [calls] {{ }} @ src/app/tasks/tasks.component.html:10',
      'TasksComponent -> method trackById [calls] @for @ src/app/tasks/tasks.component.html:8',
      // A signal is a field, and calling it reads it.
      'TasksComponent -> property editing [calls] @if @ src/app/tasks/tasks.component.html:4',
      'TasksComponent -> property lists [calls] @for @ src/app/tasks/tasks.component.html:8',
      'TasksComponent -> property selectedListId [calls] [class.active] @ src/app/tasks/tasks.component.html:9',
      'ThemeToggleComponent -> method icon [calls] [name] @ src/app/theme-toggle/theme-toggle.component.html:2',
      'ThemeToggleComponent -> method label [calls] [attr.aria-label] @ src/app/theme-toggle/theme-toggle.component.html:1',
    ]);
    // An inline template's edge sits on its own line of the class's file.
    const nav = cg.getNodesByKind('class').find((c) => c.name === 'NavComponent')!;
    expect(cg.getOutgoingEdgesFrom([nav.id], ['calls']).find((e) => cg.getNode(e.target)?.name === 'isOpen')?.line).toBe(5);
  });

  it('links nothing for a field read, a pipe, a member of another object, a comment, a string or a name the template declares', () => {
    const tasks = cg.getNodesByKind('class').find((c) => c.name === 'TasksComponent')!;
    const linked = cg.getOutgoingEdgesFrom([tasks.id], ['calls', 'references']).map((e) => cg.getNode(e.target)?.name);
    for (const name of ['title', 'format', 'reset', 'set', 'legacy', 'quoted', 'row', 'nameInput']) expect(linked).not.toContain(name);
    // A member the event bindings already link keeps that edge: `selected()` is both.
    expect(templateEdges('angular-event')).toEqual([
      'TasksComponent -> method save [calls] (blur) @ src/app/tasks/tasks.component.html:3',
      'TasksComponent -> method selected [calls] (blur) @ src/app/tasks/tasks.component.html:3',
      'ThemeToggleComponent -> method cycle [calls] (click) @ src/app/theme-toggle/theme-toggle.component.html:1',
    ]);
  });

  it('takes members a template uses off the dead-code list, and keeps the ones it does not', () => {
    const listed = buildDeadCodeReport(cg, { limit: 100 }).entries.map((e) => e.node.name);
    expect(listed).toContain('unused');
    expect(listed).not.toContain('icon');
    expect(listed).not.toContain('label');
    expect(listed).not.toContain('remainingItems');
    expect(listed).not.toContain('canSave');
  });

  it('draws a binding as render-time work in Steps, not as something the user triggers', async () => {
    const screen = cg.getNodesByKind('route').find((r) => r.name === '/tasks')!;
    const payload = await buildSteps(cg, root, new URLSearchParams({ anchor: screen.id }));
    const labels = payload.steps.map((s) => s.label);
    expect(payload.steps.find((s) => s.label === 'save')?.trigger).toMatchObject({ kind: 'prop', name: '(blur)', of: 'input' });
    for (const name of ['remainingItems', 'canSave', 'trackById', 'lists']) expect(labels).not.toContain(name);
  });
});

describe('an Angular workspace split across libraries', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  async function project(files: Record<string, string>): Promise<CodeGraph> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-angular-ws-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return CodeGraph.init(root, { index: true });
  }
  const routeNames = (cg: CodeGraph) => cg.getNodesByKind('route').map((n) => n.name).sort();
  const navs = (cg: CodeGraph) =>
    cg
      .getNodesByKind('route')
      .flatMap((r) => cg.getIncomingEdges(r.id).filter((e) => e.kind === 'navigates').map((e) => `${cg.getNode(e.source)!.name} -> ${r.name}`))
      .sort();
  const component = (name: string, selector: string, template: string) => `import { Component } from '@angular/core';
@Component({ selector: '${selector}', template: \`${template}\` })
export class ${name} {}
`;

  it('angular-spotify: Nx libraries behind barrels, `(await import(…)).M`, a class-static path constant', async () => {
    const cg = await project({
      'package.json': JSON.stringify({ name: 'ws', dependencies: { '@angular/core': '*', '@angular/router': '*' } }),
      'nx.json': '{}',
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@ws/home': ['libs/home/src/index.ts'],
            '@ws/lyrics': ['libs/lyrics/src/index.ts'],
            '@ws/utils': ['libs/utils/src/index.ts'],
          },
        },
      }),
      'libs/utils/src/index.ts': `export * from './lib/router-util';\n`,
      'libs/utils/src/lib/router-util.ts': `export class RouterUtil {
  static Configuration = { Lyrics: 'lyrics' };
}
`,
      'libs/shell/src/lib/shell.routes.ts': `import { Route } from '@angular/router';
import { RouterUtil } from '@ws/utils';

export const shellRoutes: Route[] = [
  { path: '', loadChildren: async () => (await import('@ws/home')).HomeModule },
  { path: RouterUtil.Configuration.Lyrics, loadChildren: async () => (await import('@ws/lyrics')).LyricsModule },
];
`,
      'libs/home/src/index.ts': `export * from './lib/home.module';\n`,
      'libs/home/src/lib/home.module.ts': `import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { HomeComponent } from './home.component';
@NgModule({ imports: [RouterModule.forChild([{ path: '', component: HomeComponent }])] })
export class HomeModule {}
`,
      'libs/home/src/lib/home.component.ts': component('HomeComponent', 'as-home', '<a routerLink="/lyrics">Lyrics</a>'),
      'libs/lyrics/src/index.ts': `export * from './lib/lyrics.module';\n`,
      'libs/lyrics/src/lib/lyrics.module.ts': `import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { LyricsComponent } from './lyrics.component';
@NgModule({ imports: [RouterModule.forChild([{ path: '', component: LyricsComponent }])] })
export class LyricsModule {}
`,
      'libs/lyrics/src/lib/lyrics.component.ts': component('LyricsComponent', 'as-lyrics', '<a routerLink="/">Home</a>'),
    });
    try {
      expect(routeNames(cg)).toEqual(['/', '/lyrics']);
      // A template in one library links to a screen another library declares.
      expect(navs(cg)).toEqual(['HomeComponent -> /lyrics', 'LyricsComponent -> /']);
    } finally {
      cg.close();
    }
  });

  it('jira-clone: a template-literal path, a redirect in a file that only mounts, navigate() from the root', async () => {
    const cg = await project({
      'package.json': JSON.stringify({ name: 'jira', dependencies: { '@angular/core': '*', '@angular/router': '*' } }),
      'angular.json': '{}',
      'src/app/app.routes.ts': `import { Routes } from '@angular/router';
export const appRoutes: Routes = [
  { path: 'project', loadChildren: () => import('./project/project.routes').then((m) => m.PROJECT_ROUTES) },
  { path: '', redirectTo: 'project', pathMatch: 'full' },
];
`,
      'src/app/project/config/const.ts': `export class ProjectConst {
  static readonly IssueId = 'issueId';
}
`,
      'src/app/project/project.routes.ts': `import { Routes } from '@angular/router';
import { ProjectComponent } from './project.component';
import { BoardComponent } from './board.component';
import { IssueComponent } from './issue.component';
import { ProjectConst } from './config/const';
export const PROJECT_ROUTES: Routes = [
  {
    path: '',
    component: ProjectComponent,
    children: [
      { path: 'board', component: BoardComponent },
      { path: \`issue/:\${ProjectConst.IssueId}\`, component: IssueComponent },
      { path: '', redirectTo: 'board', pathMatch: 'full' },
    ],
  },
];
`,
      'src/app/project/project.component.ts': component('ProjectComponent', 'j-project', '<router-outlet></router-outlet>'),
      'src/app/project/board.component.ts': `import { Component } from '@angular/core';
import { Router } from '@angular/router';
@Component({ selector: 'j-board', template: '<div></div>' })
export class BoardComponent {
  constructor(private _router: Router) {}
  openIssuePage(issueId: string) {
    this._router.navigate(['project', 'issue', issueId]);
  }
}
`,
      'src/app/project/issue.component.ts': `import { Component } from '@angular/core';
import { Router } from '@angular/router';
@Component({ selector: 'j-issue', template: '<div></div>' })
export class IssueComponent {
  constructor(private _router: Router) {}
  backHome() {
    this._router.navigate(['/']);
  }
}
`,
    });
    try {
      expect(routeNames(cg)).toEqual(['/project/board', '/project/issue/:issueId']);
      expect(navs(cg)).toEqual(['backHome -> /project/board', 'openIssuePage -> /project/issue/:issueId']);
    } finally {
      cg.close();
    }
  });
});
