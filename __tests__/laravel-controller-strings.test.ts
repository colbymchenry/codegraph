/**
 * A Laravel route names its controller however the app writes it: akaunting
 * writes `'Common\Uploads@inline'` — no `Controller` suffix, a namespace below
 * App\Http\Controllers — and `Route::resource('companies', 'Common\Companies',
 * [...options])`. Only `XController@action` was read, so 304 of akaunting's
 * 313 routes bound to nothing. Same-named controllers in two namespaces are
 * told apart by the written path.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const controller = (ns: string, name: string, methods: string[]) => `<?php

namespace App\\Http\\Controllers\\${ns};

class ${name}
{
${methods.map((m) => `    public function ${m}() { return 1; }`).join('\n')}
}
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-laravel-strings-'));
  const files: Record<string, string> = {
    'artisan': '#!/usr/bin/env php\n',
    'composer.json': JSON.stringify({ require: { 'laravel/framework': '^10.0' } }),
    'routes/admin.php': `<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('uploads/{id}/inline', 'Common\\Uploads@inline')->name('inline');
Route::delete('uploads/{id}', 'Common\\Uploads@destroy');
Route::get('portal/uploads/{id}', 'Portal\\Uploads@inline');
Route::resource('companies', 'Common\\Companies', ['middleware' => ['dropzone']]);
`,
    'app/Http/Controllers/Common/Uploads.php': controller('Common', 'Uploads', ['inline', 'destroy']),
    'app/Http/Controllers/Portal/Uploads.php': controller('Portal', 'Uploads', ['inline']),
    'app/Http/Controllers/Common/Companies.php': controller('Common', 'Companies', ['index', 'store']),
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

describe('Laravel string controllers', () => {
  it('resolve without a Controller suffix, by their namespace path', () => {
    expect(servedBy('GET /uploads/{id}/inline')).toEqual(['inline app/Http/Controllers/Common/Uploads.php']);
    expect(servedBy('DELETE /uploads/{id}')).toEqual(['destroy app/Http/Controllers/Common/Uploads.php']);
    expect(servedBy('GET /portal/uploads/{id}')).toEqual(['inline app/Http/Controllers/Portal/Uploads.php']);
  });

  it('read a resource controller named by string, past its options', () => {
    expect(servedBy('resource:companies')).toEqual(['Companies app/Http/Controllers/Common/Companies.php']);
  });
});
