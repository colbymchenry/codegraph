/**
 * A Laravel route's `[UserController::class, 'show']` handler resolves on the
 * route file's own `use` imports (#2975): the written name is what the file
 * imported — by short name or by an `as` alias — and the class that import
 * names is the handler, wherever it sits. Before, the written name was read
 * by its short form alone and `app/Http/Controllers/<Name>.php` was tried
 * first, so `use App\Http\Controllers\Admin\UserController;` still linked the
 * top-level `UserController`, and an aliased import (`as AdminUsers`) — whose
 * short name matches no file — linked nothing. A route file that imports
 * nothing keeps the `app/Http/Controllers/<Name>.php` convention.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('a Laravel route handler resolves through the route file use imports (#2975)', () => {
  let dir: string;
  let cg: CodeGraph;

  const controller = (ns: string, body: string) => `<?php

namespace ${ns};

class UserController {
    public function show($id) { ${body} }
}
`;

  const routeFile = (imports: string, handler: string) => `<?php

${imports}
use Illuminate\\Support\\Facades\\Route;

Route::get('/admin/users/{id}', ${handler});
`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-laravel-route-import-'));
    fs.mkdirSync(path.join(dir, 'app', 'Http', 'Controllers', 'Admin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n<?php\n');
    fs.writeFileSync(
      path.join(dir, 'app', 'Http', 'Controllers', 'UserController.php'),
      controller('App\\Http\\Controllers', 'return "top";'),
    );
    fs.writeFileSync(
      path.join(dir, 'app', 'Http', 'Controllers', 'Admin', 'UserController.php'),
      controller('App\\Http\\Controllers\\Admin', 'return "admin";'),
    );
    // The issue's repro: the route file imports the Admin controller.
    fs.writeFileSync(
      path.join(dir, 'routes', 'api.php'),
      routeFile('use App\\Http\\Controllers\\Admin\\UserController;', "[UserController::class, 'show']"),
    );
    // The audit's alias case: the same import, under an alias.
    fs.writeFileSync(
      path.join(dir, 'routes', 'web.php'),
      routeFile('use App\\Http\\Controllers\\Admin\\UserController as AdminUsers;', "[AdminUsers::class, 'show']"),
    );
    // The top-level controller imported: the import decides, and agrees with
    // the convention path.
    fs.writeFileSync(
      path.join(dir, 'routes', 'console.php'),
      routeFile('use App\\Http\\Controllers\\UserController;', "[UserController::class, 'show']"),
    );
    // No use import of the controller at all: the convention holds.
    fs.writeFileSync(
      path.join(dir, 'routes', 'channels.php'),
      `<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('/users/{id}', [UserController::class, 'show']);
`,
    );
    cg = await CodeGraph.init(dir, { index: true });
  }, 120_000);

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The `show` methods the route named `inFile` reaches, by file. */
  function handlerTargets(routePath: string): string[] {
    const route = cg
      .getNodesByKind('route')
      .find((n) => n.qualifiedName.startsWith(`${routePath}::route:`))!;
    expect(route, `a route in ${routePath} should be in the index`).toBeDefined();
    return cg
      .getOutgoingEdges(route.id)
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n && n.name === 'show')
      .map((n) => n.filePath.replace(/\\/g, '/'))
      .sort();
  }

  it("the issue's repro: the route links the Admin controller its use import names", () => {
    expect(handlerTargets('routes/api.php')).toEqual([
      'app/Http/Controllers/Admin/UserController.php',
    ]);
  });

  it('an aliased use import reaches the aliased class, which before linked nothing', () => {
    expect(handlerTargets('routes/web.php')).toEqual([
      'app/Http/Controllers/Admin/UserController.php',
    ]);
  });

  it('an import of the top-level controller links it, as the convention did', () => {
    expect(handlerTargets('routes/console.php')).toEqual([
      'app/Http/Controllers/UserController.php',
    ]);
  });

  it('a route file that imports no controller keeps the app/Http/Controllers convention', () => {
    expect(handlerTargets('routes/channels.php')).toEqual([
      'app/Http/Controllers/UserController.php',
    ]);
  });
});
