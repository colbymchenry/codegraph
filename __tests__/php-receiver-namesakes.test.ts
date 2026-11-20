/**
 * A PHP variable named after a class is guessed to hold one, by its name. A
 * name the file's `use` imports means that class there, so a namesake with
 * another fully qualified name is none: Drupal's `$url` under `use
 * Drupal\Core\Url;` (a class outside a sparse checkout) is no views field
 * plugin `Url`, and so reaches no `HandlerBase::access` three classes up. Nor
 * does a variable named after the class around the call take what that class
 * inherits, as `$this` would: `$view` inside the views area plugin `View`
 * holds the `ViewExecutable` it was handed.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'core/lib/Drupal/Core/Entity/EntityBase.php': `<?php
namespace Drupal\\Core\\Entity;

abstract class EntityBase
{
    public function access($operation) { return TRUE; }
}
`,
  'core/modules/views/src/Plugin/views/HandlerBase.php': `<?php
namespace Drupal\\views\\Plugin\\views;

abstract class HandlerBase
{
    public function access($account) { return TRUE; }
}
`,
  'core/modules/views/src/Plugin/views/field/FieldPluginBase.php': `<?php
namespace Drupal\\views\\Plugin\\views\\field;

use Drupal\\views\\Plugin\\views\\HandlerBase;

abstract class FieldPluginBase extends HandlerBase
{
    public function label() { return 'x'; }
}
`,
  'core/modules/views/src/Plugin/views/field/Url.php': `<?php
namespace Drupal\\views\\Plugin\\views\\field;

class Url extends FieldPluginBase
{
    public function render($values) { return $values; }
}
`,
  'core/modules/node/src/Hook/NodeRequirements.php': `<?php
namespace Drupal\\node\\Hook;

use Drupal\\Core\\Url;
use function Drupal\\node\\helper;

class NodeRequirements
{
    public function runtime()
    {
        $url = Url::fromRoute('system.status');
        if ($url->access()) {
            return 1;
        }
        return 0;
    }
}
`,
  'core/modules/views/src/Plugin/views/field/LinkBase.php': `<?php
namespace Drupal\\views\\Plugin\\views\\field;

use Drupal\\views\\Plugin\\views\\field\\Url as UrlField;
use function Drupal\\views\\url;

class LinkBase
{
    public function check()
    {
        $url = $this->makeUrl();
        return $url->access(1);
    }
}
`,
  'core/modules/views/src/ViewExecutable.php': `<?php
namespace Drupal\\views;

class ViewExecutable
{
    public function access($displays = NULL) { return TRUE; }
}
`,
  'core/modules/views/src/Plugin/views/area/AreaPluginBase.php': `<?php
namespace Drupal\\views\\Plugin\\views\\area;

use Drupal\\views\\Plugin\\views\\HandlerBase;

abstract class AreaPluginBase extends HandlerBase
{
}
`,
  'core/modules/views/src/Plugin/views/area/View.php': `<?php
namespace Drupal\\views\\Plugin\\views\\area;

class View extends AreaPluginBase
{
    protected $viewStorage;

    public function render($empty = FALSE)
    {
        $view = $this->viewStorage->load('x')->getExecutable();
        if (empty($view) || !$view->access(1)) {
            return [];
        }
        return [];
    }

    public function own()
    {
        return $this->access(1);
    }
}
`,
  'src/Support/Facades/Facade.php': `<?php
namespace Illuminate\\Support\\Facades;

abstract class Facade
{
}
`,
  'src/Support/Facades/Validator.php': `<?php
namespace Illuminate\\Support\\Facades;

class Validator extends Facade
{
    protected static function getFacadeAccessor() { return 'validator'; }
}
`,
  'src/Validation/Validator.php': `<?php
namespace Illuminate\\Validation;

class Validator
{
    public function fails() { return false; }
}
`,
  'src/Validation/Rules/Email.php': `<?php
namespace Illuminate\\Validation\\Rules;

use Illuminate\\Support\\Facades\\Validator;

class Email
{
    public function passes($value)
    {
        $validator = Validator::make(['value' => $value]);
        return ! $validator->fails();
    }
}
`,
  'src/Database/Model.php': `<?php
namespace Illuminate\\Database\\Eloquent;

abstract class Model
{
    public function fill(array $attributes) { return $this; }

    public function replicate()
    {
        $model = $this->newInstance();
        return $model->fill([]);
    }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-namesakes-'));
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

/** The qualified names `calls` edges from `caller` reach for `ref`. */
function callees(caller: string, ref: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string; m: string | null }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.qualified_name q, e.metadata m FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ?`).all(caller)
    .filter((r) => JSON.parse(r.m ?? '{}').refName === ref)
    .map((r) => r.q);
}

describe('a PHP variable named after a class', () => {
  it('is the class its file imports, not a namesake the index holds', () => {
    expect(callees('Drupal\\node\\Hook::NodeRequirements::runtime', 'url.access')).toEqual([]);
  });

  it('is what a Laravel facade the file imports hands out, not the facade', () => {
    expect(callees('Illuminate\\Validation\\Rules::Email::passes', 'validator.fails')).toEqual(['Illuminate\\Validation::Validator::fails']);
  });

  it('is still the one class of the name when the file imports none of it', () => {
    // `Url as UrlField` gives the name `UrlField`, and `use function` names no class.
    expect(callees('Drupal\\views\\Plugin\\views\\field::LinkBase::check', 'url.access')).toEqual(['Drupal\\views\\Plugin\\views::HandlerBase::access']);
  });

  it('inside the class it is named after, reaches what that class declares, not what it inherits', () => {
    expect(callees('Drupal\\views\\Plugin\\views\\area::View::render', 'view.access')).toEqual(['Drupal\\views::ViewExecutable::access']);
    expect(callees('Drupal\\views\\Plugin\\views\\area::View::own', 'access')).toEqual(['Drupal\\views\\Plugin\\views::HandlerBase::access']);
    expect(callees('Illuminate\\Database\\Eloquent::Model::replicate', 'model.fill')).toEqual(['Illuminate\\Database\\Eloquent::Model::fill']);
  });
});
