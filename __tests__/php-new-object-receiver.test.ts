/**
 * A PHP call on a freshly built object, `(new SettingClient())->getSet(1)`,
 * reaches the method of the class the written name means where the call is
 * written: through the file's namespace and `use` imports, or the class around
 * the call for `new self` / `new static`, its own method or one it inherits
 * (#3244). Before, such a call linked nothing at all, even with one class of
 * the name, so the method lost every caller written this way.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const client = (ns: string) => `<?php
namespace App\\${ns}\\Client;

class SettingClient
{
    public function getSet($id) { return $id; }
}
`;

const FILES: Record<string, string> = {
  'src/A/Client/SettingClient.php': client('A'),
  'src/B/Client/SettingClient.php': client('B'),
  'src/C/Client/SettingClient.php': client('C'),
  // The issue's three callers.
  'src/A/Api/FooApi.php': `<?php
namespace App\\A\\Api;
use App\\A\\Client\\SettingClient;
class FooApi { public function run() { return (new SettingClient())->getSet(1); } }
`,
  'src/B/Api/BarApi.php': `<?php
namespace App\\B\\Api;
use App\\B\\Client\\SettingClient;
class BarApi { public function run() { $client = new SettingClient(); return $client->getSet(2); } }
`,
  'src/C/Api/BazApi.php': `<?php
namespace App\\C\\Api;
use App\\C\\Client\\SettingClient;
class BazApi {
    private $client;
    public function __construct() { $this->client = new SettingClient(); }
    public function run() { return $this->client->getSet(3); }
}
`,
  // The other spellings of the construction.
  'src/B/Api/Forms.php': `<?php
namespace App\\B\\Api;
use App\\B\\Client\\SettingClient;
class Forms
{
    public function bare() { return (new SettingClient)->getSet(1); }
    public function withArgs($x) { return (new SettingClient($x, 'a(b'))->getSet(1); }
    public function qualified() { return (new \\App\\C\\Client\\SettingClient())->getSet(1); }
}
function helper() { return (new SettingClient())->getSet(1); }
`,
  // A method the class inherits, and `new self` / `new static` inside a class.
  'src/A/Client/BaseClient.php': `<?php
namespace App\\A\\Client;

abstract class BaseClient
{
    public function ping() { return true; }
}
`,
  'src/A/Client/ChildClient.php': `<?php
namespace App\\A\\Client;

class ChildClient extends BaseClient
{
}
`,
  'src/A/Client/Builder.php': `<?php
namespace App\\A\\Client;

class Builder
{
    public function make() { return (new static)->fresh(); }
    public function again() { return (new self())->fresh(); }
    public function fresh() { return $this; }
}
`,
  'src/A/Client/ChildBuilder.php': `<?php
namespace App\\A\\Client;

class ChildBuilder extends Builder
{
    public function up() { return (new parent())->fresh(); }
    public function down() { return (new static())->fresh(); }
    public function fresh() { return $this; }
}
`,
  'src/C/Client/Other.php': `<?php
namespace App\\C\\Client;

class Other
{
    public function fresh() { return $this; }
    public function getParameters() { return []; }
}
`,
  'src/A/Api/Inherited.php': `<?php
namespace App\\A\\Api;
use App\\A\\Client\\ChildClient;
class Inherited
{
    public function run() { return (new ChildClient())->ping(); }
    // A class from outside the project: no project method is it.
    public function reflect($f) { return (new \\ReflectionFunction($f))->getParameters(); }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-new-receiver-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The qualified names of what `calls` edges from `caller` reach. */
function callees(caller: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.qualified_name q FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ?`).all(caller).map((r) => r.q).sort();
}

describe('a PHP call on a freshly built object (#3244)', () => {
  it("the issue's repro: each caller reaches the client its file imports", () => {
    expect(callees('App\\A\\Api::FooApi::run')).toEqual(['App\\A\\Client::SettingClient::getSet']);
    expect(callees('App\\B\\Api::BarApi::run')).toEqual(['App\\B\\Client::SettingClient::getSet']);
    expect(callees('App\\C\\Api::BazApi::run')).toEqual(['App\\C\\Client::SettingClient::getSet']);
  });

  it('links the construction without parentheses, with arguments, fully qualified and in a function', () => {
    expect(callees('App\\B\\Api::Forms::bare')).toEqual(['App\\B\\Client::SettingClient::getSet']);
    expect(callees('App\\B\\Api::Forms::withArgs')).toEqual(['App\\B\\Client::SettingClient::getSet']);
    expect(callees('App\\B\\Api::Forms::qualified')).toEqual(['App\\C\\Client::SettingClient::getSet']);
    expect(callees('App\\B\\Api::helper')).toEqual(['App\\B\\Client::SettingClient::getSet']);
  });

  it('reaches a method the class inherits, and the class around the call for new self and new static', () => {
    expect(callees('App\\A\\Api::Inherited::run')).toEqual(['App\\A\\Client::BaseClient::ping']);
    expect(callees('App\\A\\Client::Builder::make')).toEqual(['App\\A\\Client::Builder::fresh']);
    expect(callees('App\\A\\Client::Builder::again')).toEqual(['App\\A\\Client::Builder::fresh']);
    expect(callees('App\\A\\Client::ChildBuilder::up')).toEqual(['App\\A\\Client::Builder::fresh']);
    expect(callees('App\\A\\Client::ChildBuilder::down')).toEqual(['App\\A\\Client::ChildBuilder::fresh']);
  });

  it('links nothing for a class from outside the project', () => {
    expect(callees('App\\A\\Api::Inherited::reflect')).toEqual([]);
  });
});
