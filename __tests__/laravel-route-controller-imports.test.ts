/**
 * A Laravel route written `[UserController::class, 'show']` (or
 * `UserController::class` for an invokable or resource controller) names the
 * class PHP resolves the written name to in the routes file: through its `use`
 * imports, `as` aliases, group uses (`use App\Http\Controllers\{Admin\X}`), a
 * namespace import (`use App\Http\Controllers\Admin;` with
 * `Admin\UserController::class`) or a leading `\` (#2975, #3292). The written
 * name used to be cut to its last segment, so an admin-area
 * `App\Http\Controllers\Admin\UserController` beside a top-level
 * `UserController` linked the top-level one, and an alias linked nothing. A
 * name the file doesn't import keeps the `app/Http/Controllers/<Name>.php`
 * convention.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const controller = (ns: string, name: string, methods: string[]) => `<?php

namespace ${ns};

class ${name}
{
${methods.map((m) => `    public function ${m}($id = null) { return '${ns}'; }`).join('\n')}
}
`;

const routes = (head: string, body: string) => `<?php

${head}
use Illuminate\\Support\\Facades\\Route;

${body}
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-laravel-route-imports-'));
  const files: Record<string, string> = {
    'artisan': '#!/usr/bin/env php\n',
    'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
    'app/Http/Controllers/UserController.php': controller('App\\Http\\Controllers', 'UserController', ['show', 'index']),
    'app/Http/Controllers/Admin/UserController.php': controller('App\\Http\\Controllers\\Admin', 'UserController', ['show', 'index']),
    'app/Http/Controllers/ShowDashboard.php': controller('App\\Http\\Controllers', 'ShowDashboard', ['__invoke']),
    'app/Http/Controllers/Admin/ShowDashboard.php': controller('App\\Http\\Controllers\\Admin', 'ShowDashboard', ['__invoke']),
    // #2975: a plain use, and an alias.
    'routes/plain.php': routes('use App\\Http\\Controllers\\Admin\\UserController;',
      "Route::get('/plain/{id}', [UserController::class, 'show']);\nRoute::resource('plain-users', UserController::class);"),
    'routes/alias.php': routes('use App\\Http\\Controllers\\Admin\\UserController as AdminUsers;',
      "Route::get('/alias/{id}', [AdminUsers::class, 'show']);"),
    // #3292: a group use, a namespace use and a fully qualified name.
    'routes/group.php': routes('use App\\Http\\Controllers\\{Admin\\UserController, Admin\\ShowDashboard as Dashboard};',
      "Route::get('/group/{id}', [UserController::class, 'show']);\nRoute::get('/group-dashboard', Dashboard::class);"),
    'routes/nsuse.php': routes('use App\\Http\\Controllers\\Admin;',
      "Route::get('/nsuse/{id}', [Admin\\UserController::class, 'show']);"),
    'routes/fq.php': routes('',
      "Route::get('/fq/{id}', [\\App\\Http\\Controllers\\Admin\\UserController::class, 'show']);\nRoute::resource('fq-users', \\App\\Http\\Controllers\\Admin\\UserController::class);"),
    // A comma list of uses.
    'routes/listed.php': `<?php

use App\\Http\\Controllers\\Admin\\UserController, Illuminate\\Support\\Facades\\Route;

Route::get('/listed/{id}', [UserController::class, 'index']);
`,
    // The top-level controller imported, and no import at all: the convention.
    'routes/top.php': routes('use App\\Http\\Controllers\\UserController;',
      "Route::get('/imported-top/{id}', [UserController::class, 'show']);"),
    'routes/web.php': routes('',
      "Route::get('/top/{id}', [UserController::class, 'show']);\nRoute::get('/rel/{id}', [Admin\\UserController::class, 'index']);\nRoute::get('/str/{id}', 'Admin\\UserController@show');"),
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

const servedBy = (routeName: string) => {
  const route = cg.getNodesByKind('route').find((r) => r.name === routeName);
  expect(route, routeName).toBeDefined();
  return cg.getOutgoingEdgesFrom([route!.id]).map((e) => cg.getNode(e.target)!).map((n) => `${n.name} ${n.filePath}`);
};

const ADMIN = 'app/Http/Controllers/Admin/UserController.php';
const TOP = 'app/Http/Controllers/UserController.php';

describe('a Laravel route controller named through the routes file imports', () => {
  it('#2975: a plain use and an aliased use reach the class they import', () => {
    expect(servedBy('GET /plain/{id}')).toEqual([`show ${ADMIN}`]);
    expect(servedBy('GET /alias/{id}')).toEqual([`show ${ADMIN}`]);
  });

  it('#3292: a group use, a namespace use and a fully qualified name reach that class', () => {
    expect(servedBy('GET /group/{id}')).toEqual([`show ${ADMIN}`]);
    expect(servedBy('GET /nsuse/{id}')).toEqual([`show ${ADMIN}`]);
    expect(servedBy('GET /fq/{id}')).toEqual([`show ${ADMIN}`]);
    expect(servedBy('GET /listed/{id}')).toEqual([`index ${ADMIN}`]);
  });

  it('an invokable or resource controller named by its class reaches the imported class', () => {
    expect(servedBy('GET /group-dashboard')).toEqual(['ShowDashboard app/Http/Controllers/Admin/ShowDashboard.php']);
    expect(servedBy('resource:plain-users')).toEqual([`UserController ${ADMIN}`]);
    expect(servedBy('resource:fq-users')).toEqual([`UserController ${ADMIN}`]);
  });

  it('keeps the controllers-root convention for a name the file does not import', () => {
    expect(servedBy('GET /imported-top/{id}')).toEqual([`show ${TOP}`]);
    expect(servedBy('GET /top/{id}')).toEqual([`show ${TOP}`]);
    expect(servedBy('GET /rel/{id}')).toEqual([`index ${ADMIN}`]);
    expect(servedBy('GET /str/{id}')).toEqual([`show ${ADMIN}`]);
  });
});
