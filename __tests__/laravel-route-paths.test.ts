/**
 * Laravel routes are named by the path a request takes.
 *
 * Route files write paths without a leading slash (`Route::get('pages', …)`),
 * nest them in prefix groups (`Route::prefix('api')->group(…)`), and are
 * mounted under a prefix by the framework — `routes/api.php` is served under
 * `/api`. Names used to be the bare literal (`GET pages`, `GET ping`), which
 * was wrong on screen and kept a front-end `fetch('/api/pages')` from ever
 * pairing with its route.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { laravelResolver } from '../src/resolution/frameworks/laravel';

const extractNames = (src: string, file = 'routes/web.php') =>
  laravelResolver.extract!(file, `<?php\n${src}`).nodes.map((n) => n.name);

describe('Laravel route paths inside a routes file', () => {
  it('names a path written without a leading slash from the root', () => {
    expect(extractNames(`Route::get('pages', [PageController::class, 'index']);`)).toEqual(['GET /pages']);
    expect(extractNames(`Route::get('/', [HomeController::class, 'index']);`)).toEqual(['GET /']);
  });

  it('applies prefix groups, nested ones in order, and only inside the group', () => {
    const src = `
Route::prefix('api')->middleware('auth:sanctum')->group(static function (): void {
    Route::get('ping', static fn () => null);
    Route::prefix('v1/')->group(function () {
        Route::post('/songs', [SongController::class, 'store']);
    });
    Route::get('me', [ProfileController::class, 'show']);
});
Route::get('/after', [HomeController::class, 'after']);
`;
    expect(extractNames(src)).toEqual(['GET /api/ping', 'POST /api/v1/songs', 'GET /api/me', 'GET /after']);
  });

  it("reads a prefix from Route::group's array, and adds nothing for a middleware-only group", () => {
    const src = `
Route::group(['middleware' => 'auth', 'prefix' => 'admin'], function () {
    Route::get('/', [AdminController::class, 'index']);
    Route::middleware('can:manage')->group(fn () => Route::get('users', [UserController::class, 'index']));
});
`;
    expect(extractNames(src)).toEqual(['GET /admin', 'GET /admin/users']);
  });

  it('keeps a computed prefix as a {prefix} segment instead of dropping it', () => {
    const src = `
Route::group(['prefix' => LaravelLocalization::setLocale()], function () {
    Route::get('about', [PageController::class, 'about']);
});
`;
    expect(extractNames(src)).toEqual(['GET /{prefix}/about']);
  });

  it('prefixes a resource route, and records the in-file path in qualifiedName', () => {
    const { nodes } = laravelResolver.extract!('routes/web.php', `<?php
Route::prefix('admin')->group(function () {
    Route::resource('photos', PhotoController::class);
    Route::get('stats', [StatsController::class, 'index']);
});
`);
    expect(nodes.map((n) => n.name)).toEqual(['GET /admin/stats', 'resource:admin/photos']);
    expect(nodes.map((n) => n.qualifiedName)).toEqual(['routes/web.php::route:/admin/stats', 'routes/web.php::route:/admin/photos']);
  });

  it('ignores a group opened inside a comment', () => {
    const src = `
// Route::prefix('old')->group(function () {
Route::get('kept', [X::class, 'y']);
`;
    expect(extractNames(src)).toEqual(['GET /kept']);
  });
});

describe('Laravel route paths across files (the mount a routes file is served under)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  function project(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-laravel-paths-'));
    roots.push(root);
    const all: Record<string, string> = {
      artisan: '#!/usr/bin/env php\n<?php\n',
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      'app/Http/Controllers/PageController.php': '<?php\nclass PageController { public function list() {} public function login() {} }\n',
      ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
  }

  async function routeNames(root: string): Promise<string[]> {
    const cg = await CodeGraph.init(root, { index: true });
    try {
      return cg.getNodesByKind('route').map((n) => n.name).sort();
    } finally {
      cg.close();
    }
  }

  const API = "<?php\nRoute::get('pages', [PageController::class, 'list']);\n";
  const WEB = "<?php\nRoute::get('/login', [PageController::class, 'login']);\n";

  it('serves routes/api.php under /api when nothing says otherwise', async () => {
    const root = project({ 'routes/api.php': API, 'routes/web.php': WEB });
    expect(await routeNames(root)).toEqual(['GET /api/pages', 'GET /login']);
  });

  it("reads the RouteServiceProvider's prefix (Laravel ≤10)", async () => {
    const root = project({
      'routes/api.php': API,
      'routes/web.php': WEB,
      'app/Providers/RouteServiceProvider.php': `<?php
class RouteServiceProvider {
    public function boot() {
        Route::middleware('api')->prefix('api/v1')->group(base_path('routes/api.php'));
        Route::middleware('web')->group(base_path('routes/web.php'));
    }
}
`,
    });
    expect(await routeNames(root)).toEqual(['GET /api/v1/pages', 'GET /login']);
  });

  it("reads a Route::group(['prefix' => …]) that requires the file (BookStack's shape)", async () => {
    const root = project({
      'routes/api.php': API,
      'app/App/Providers/RouteServiceProvider.php': `<?php
class RouteServiceProvider {
    protected function mapApiRoutes() {
        Route::group(['middleware' => 'api', 'prefix' => 'api'], function ($router) {
            require base_path('routes/api.php');
        });
    }
}
`,
    });
    expect(await routeNames(root)).toEqual(['GET /api/pages']);
  });

  it("reads Laravel 11's withRouting(api:, apiPrefix:)", async () => {
    const root = project({
      'routes/api.php': API,
      'routes/web.php': WEB,
      'bootstrap/app.php': `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        apiPrefix: 'api/v2',
        health: '/up',
    )
    ->create();
`,
    });
    expect(await routeNames(root)).toEqual(['GET /api/v2/pages', 'GET /login']);
  });

  it('composes prefixes down an include tree: a group mounting a file, and a plain require', async () => {
    const root = project({
      'routes/api.php': `<?php
Route::get('pages', [PageController::class, 'list']);
Route::prefix('v1')->group(base_path('routes/api/v1.php'));
`,
      'routes/api/v1.php': "<?php\nRoute::get('songs', [PageController::class, 'list']);\n",
      'routes/web.php': `<?php\nRoute::get('/', [PageController::class, 'list']);\nrequire __DIR__.'/auth.php';\n`,
      'routes/auth.php': "<?php\nRoute::get('login', [PageController::class, 'login']);\n",
    });
    expect(await routeNames(root)).toEqual(['GET /', 'GET /api/pages', 'GET /api/v1/songs', 'GET /login']);
  });

  it('leaves routes/api.php alone when withRouting(using:) loads routes by code it cannot read', async () => {
    const root = project({
      'routes/api.php': API,
      'bootstrap/app.php': `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(using: static function (): void { RouteLoader::load('api'); })
    ->create();
`,
    });
    expect(await routeNames(root)).toEqual(['GET /pages']);
  });

  it('leaves a file mounted at two different prefixes at its in-file path', async () => {
    const root = project({
      'routes/shared.php': "<?php\nRoute::get('status', [PageController::class, 'list']);\n",
      'app/Providers/RouteServiceProvider.php': `<?php
Route::prefix('a')->group(base_path('routes/shared.php'));
Route::prefix('b')->group(base_path('routes/shared.php'));
`,
    });
    expect(await routeNames(root)).toEqual(['GET /status']);
  });

  it('is idempotent across syncs, and undoes a mount that is removed', async () => {
    const provider = 'app/Providers/RouteServiceProvider.php';
    const root = project({
      'routes/admin.php': "<?php\nRoute::get('users', [PageController::class, 'list']);\n",
      [provider]: "<?php\nRoute::prefix('admin')->group(base_path('routes/admin.php'));\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const names = () => cg.getNodesByKind('route').map((n) => n.name);
      expect(names()).toEqual(['GET /admin/users']);
      fs.appendFileSync(path.join(root, 'app/Http/Controllers/PageController.php'), '// touched\n');
      await cg.sync();
      expect(names()).toEqual(['GET /admin/users']);
      fs.writeFileSync(path.join(root, provider), "<?php\nRoute::group([], base_path('routes/admin.php'));\n");
      await cg.sync();
      expect(names()).toEqual(['GET /users']);
    } finally {
      cg.close();
    }
  });

  it("pairs a front-end fetch('/api/pages') with the api.php route it reaches", async () => {
    const root = project({
      'routes/api.php': API,
      'resources/js/pages.js': "export async function loadPages() {\n  return await fetch('/api/pages');\n}\n",
      'package.json': JSON.stringify({ dependencies: { vue: '^3.0.0' } }),
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const route = cg.getNodesByKind('route').find((n) => n.name === 'GET /api/pages');
      expect(route).toBeDefined();
      const loadPages = cg.getNodesByKind('function').find((n) => n.name === 'loadPages')!;
      const hops = cg.getCallees(loadPages.id).filter((c) => c.node.id === route!.id);
      expect(hops).toHaveLength(1);
      expect((hops[0]!.edge.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe('http-client');
    } finally {
      cg.close();
    }
  });
});
