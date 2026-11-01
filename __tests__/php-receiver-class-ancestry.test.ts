/**
 * What a PHP receiver reaches. A class a variable is named after is found the
 * way PHP finds a class: the calling file names it through its namespace or a
 * `use`, and its supertypes are read through the same names, its traits
 * before its parent. A class the file can't name is only a shared word.
 * Drupal's `$entity->access()` went to the views plugin `Entity`'s
 * `HandlerBase::access`, three classes up, in a namespace the file never
 * mentions.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  // Drupal's views handlers.
  'views/HandlerBase.php': `<?php
namespace Drupal\\views\\Plugin\\views;

abstract class HandlerBase
{
    public function access($account) { return true; }
    public function getEntityType() { return ''; }
}
`,
  'views/AreaPluginBase.php': `<?php
namespace Drupal\\views\\Plugin\\views\\area;

use Drupal\\views\\Plugin\\views\\HandlerBase;

abstract class AreaPluginBase extends HandlerBase
{
}
`,
  'views/TokenizeAreaPluginBase.php': `<?php
namespace Drupal\\views\\Plugin\\views\\area;

abstract class TokenizeAreaPluginBase extends AreaPluginBase
{
}
`,
  'views/Entity.php': `<?php
namespace Drupal\\views\\Plugin\\views\\area;

class Entity extends TokenizeAreaPluginBase
{
}
`,
  // Drupal's entities.
  'entity/AccessibleInterface.php': `<?php
namespace Drupal\\Core\\Access;

interface AccessibleInterface
{
    public function access($operation, $account = NULL);
}
`,
  'entity/EntityInterface.php': `<?php
namespace Drupal\\Core\\Entity;

use Drupal\\Core\\Access\\AccessibleInterface;

interface EntityInterface extends AccessibleInterface
{
    public function getEntityType();
}
`,
  'entity/ContentEntityBase.php': `<?php
namespace Drupal\\Core\\Entity;

abstract class ContentEntityBase implements EntityInterface
{
    public function access($operation, $account = NULL) { return true; }
    public function getEntityType() { return ''; }
}
`,
  'entity/Controller.php': `<?php
namespace Drupal\\comment\\Controller;

use Drupal\\Core\\Entity\\EntityInterface;

class CommentController
{
    public function permalink($comment)
    {
        $entity = $comment->getCommentedEntity();
        return $entity->access('view');
    }

    public function replyAccess(EntityInterface $entity)
    {
        return $entity->access('view');
    }

    public function typeOf(EntityInterface $entity)
    {
        return $entity->getEntityType();
    }
}
`,
  // A class a group `use` imports.
  'group/Page.php': `<?php
namespace App\\Models;

use App\\Concerns\\Saves;

class Page
{
    use Saves;
}
`,
  'group/OtherPage.php': `<?php
namespace App\\Legacy;

class Page
{
}
`,
  'group/Saves.php': `<?php
namespace App\\Concerns;

trait Saves
{
    public function persist() { return true; }
}
`,
  'group/Controller.php': `<?php
namespace App\\Http;

use App\\Models\\{Book, Page};

class PageController
{
    public function store($page)
    {
        return $page->persist();
    }
}
`,
  // A class the file imports: its own method, before a namesake's inherited one.
  'view/Renderable.php': `<?php
namespace Illuminate\\Contracts\\Support;

interface Renderable
{
    public function render();
}
`,
  'view/ContractView.php': `<?php
namespace Illuminate\\Contracts\\View;

use Illuminate\\Contracts\\Support\\Renderable;

interface View extends Renderable
{
}
`,
  'view/View.php': `<?php
namespace Illuminate\\View;

class View
{
    public function render() { return ''; }
}
`,
  'view/Compiler.php': `<?php
namespace Illuminate\\View\\Compilers;

use Illuminate\\View\\View;

class BladeCompiler
{
    public function compile($view)
    {
        return $view->render();
    }
}
`,
  // A trait before the parent.
  'pivot/Model.php': `<?php
namespace Illuminate\\Database\\Eloquent;

abstract class Model
{
    public function getForeignKey() { return ''; }
    public function getKey() { return 1; }
}
`,
  'pivot/AsPivot.php': `<?php
namespace Illuminate\\Database\\Eloquent\\Relations\\Concerns;

trait AsPivot
{
    public function getForeignKey() { return ''; }
}
`,
  'pivot/Pivot.php': `<?php
namespace Illuminate\\Database\\Eloquent\\Relations;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\Concerns\\AsPivot;

class Pivot extends Model
{
    use AsPivot;
}
`,
  'pivot/PivotTest.php': `<?php
namespace Illuminate\\Tests;

use Illuminate\\Database\\Eloquent\\Relations\\Pivot;

class PivotUser
{
    public function foreignKey($pivot)
    {
        return $pivot->getForeignKey();
    }

    public function key($pivot)
    {
        return $pivot->getKey();
    }
}
`,
  // A parent's name is the one the file imports.
  'collection/ASupportCollection.php': `<?php
namespace Illuminate\\Support;

class Collection
{
    public function pluck($value) { return $this; }
}
`,
  'collection/EloquentCollection.php': `<?php
namespace Illuminate\\Database\\Eloquent;

use Illuminate\\Support\\Collection as BaseCollection;

class Collection extends BaseCollection
{
    public function pluck($value) { return parent::pluck($value); }
}
`,
  'collection/Comments.php': `<?php
namespace Illuminate\\Types\\Model;

use Illuminate\\Database\\Eloquent\\Collection;

final class Comments extends Collection
{
    public function firstId($comments)
    {
        return $comments->pluck('id');
    }
}
`,
  // A facade hands on what it doesn't declare.
  'facade/Facade.php': `<?php
namespace Illuminate\\Support\\Facades;

abstract class Facade
{
    public static function __callStatic($method, $args) { return null; }
}
`,
  'facade/ParallelTestingFacade.php': `<?php
namespace Illuminate\\Support\\Facades;

class ParallelTesting extends Facade
{
    protected static function getFacadeAccessor()
    {
        return \\Illuminate\\Testing\\ParallelTesting::class;
    }
}
`,
  'facade/CacheFacade.php': `<?php
namespace Illuminate\\Support\\Facades;

class Cache extends Facade
{
    protected static function getFacadeAccessor()
    {
        return 'cache';
    }
}
`,
  'facade/Testing/ParallelTesting.php': `<?php
namespace Illuminate\\Testing;

class ParallelTesting
{
    public function token() { return 1; }
}
`,
  'facade/Storage.php': `<?php
namespace Illuminate\\Support\\Facades;

class Storage extends Facade
{
    public static function fake()
    {
        Cache::flushEverything();
        return ParallelTesting::token();
    }
}
`,
  'facade/Repository.php': `<?php
namespace App\\Store;

class Repository
{
    public function flushEverything() {}
}
`,
  // A model's static factory types the local.
  'models/Models.php': `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class Post extends Model
{
    public function tags() { return []; }
}

class PostStringPrimaryKey extends Model
{
    public function tags() { return []; }
}

class Str
{
    public static function find($x) { return ''; }
}
`,
  'models/PostTest.php': `<?php
namespace App\\Models;

class PostTest
{
    public function testStringKey()
    {
        $post = PostStringPrimaryKey::query()->create(['id' => 'a']);
        return $post->tags();
    }

    public function testNumericKey()
    {
        $post = Post::create([]);
        return $post->tags();
    }

    public function testOtherClass()
    {
        $post = Str::find('x');
        return $post->tags();
    }
}
`,
  // The one class of a name a word leads to, and its parent.
  'theme/Extension.php': `<?php
namespace Drupal\\Core\\Extension;

class Extension
{
    public function getName() { return ''; }
}

class Theme extends Extension
{
}
`,
  'theme/Controller.php': `<?php
namespace Drupal\\system\\Controller;

class SystemController
{
    public function page($theme)
    {
        return $theme->getName();
    }
}
`,
  // Further up from the one class of the name.
  'chapter/Models.php': `<?php
namespace BookStack\\Entities\\Models;

abstract class Entity
{
    public function getShortName() { return ''; }
}

abstract class BookChild extends Entity
{
}

class Chapter extends BookChild
{
}
`,
  'chapter/Controller.php': `<?php
namespace BookStack\\Entities\\Controllers;

class ChapterController
{
    public function show($chapter)
    {
        return $chapter->getShortName();
    }
}
`,
  // A declaration starts at its attributes.
  'attributes/EntityBase.php': `<?php
namespace Drupal\\Core\\Entity;

abstract class EntityBase
{
    public function id() { return 1; }
}
`,
  'attributes/Term.php': `<?php
namespace Drupal\\taxonomy\\Entity;

use Drupal\\Core\\Entity\\EntityBase;

#[ContentEntityType(
  id: 'taxonomy_term',
  label: 'Taxonomy term',
  handlers: [
    'storage' => 'TermStorage',
    'view_builder' => 'TermViewBuilder',
  ],
  entity_keys: [
    'id' => 'tid',
  ],
)]
class Term extends EntityBase
{
    public function ownId()
    {
        return $this->id();
    }
}
`,
  'attributes/Hooks.php': `<?php
namespace Drupal\\taxonomy\\Hook;

use Drupal\\taxonomy\\Entity\\Term;

class TaxonomyHooks
{
    public function deleted(Term $term)
    {
        return $term->id();
    }
}
`,
  // A parent the repository doesn't hold.
  'outside/BootsTrait.php': `<?php
namespace App\\Concerns;

trait BootsTrait
{
    public function boot() {}
}
`,
  'outside/Provider.php': `<?php
namespace App\\Providers;

use Vendor\\Foundation\\ServiceProvider;

class AppProvider extends ServiceProvider
{
    public function register()
    {
        parent::boot();
    }

    public function start()
    {
        $this->boot();
    }
}
`,
  // A same-file double, past namesakes the file can't name.
  'user/User.php': `<?php
namespace Illuminate\\Foundation\\Auth;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Auth\\Authenticatable;

class User extends Model
{
    use Authenticatable;
}
`,
  'user/Authenticatable.php': `<?php
namespace Illuminate\\Auth;

trait Authenticatable
{
    public function getAuthIdentifier() { return 1; }
}
`,
  'user/Contract.php': `<?php
namespace Illuminate\\Contracts\\Auth;

interface Authenticatable
{
    public function getAuthIdentifier();
}
`,
  'user/OtherUser.php': `<?php
namespace Illuminate\\Foundation\\Other;

use Illuminate\\Foundation\\Auth\\User as Authenticatable;

class User extends Authenticatable
{
}
`,
  'user/BroadcastTest.php': `<?php
namespace Illuminate\\Tests\\Broadcasting;

class BroadcasterTest
{
    public function testChannel($broadcaster)
    {
        return $broadcaster->channel('room', fn ($user) => $user->getAuthIdentifier());
    }
}

class GenericBroadcastingTestUser
{
    public function getAuthIdentifier() { return 1; }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-ancestry-'));
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

/** The qualified names `calls` edges from `caller` reach, at `file`'s `line` when given. */
function callees(caller: string, ref?: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string; m: string | null }> } } } }).db;
  const rows = db.getDb().prepare(`
    SELECT t.qualified_name q, e.metadata m FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ?`).all(caller);
  return rows
    .filter((r) => ref === undefined || JSON.parse(r.m ?? '{}').refName === ref)
    .map((r) => r.q);
}

describe('a PHP receiver named after a class', () => {
  it('is no class the file cannot name, three classes up', () => {
    const permalink = 'Drupal\\comment\\Controller::CommentController::permalink';
    expect(callees(permalink, 'entity.access')).toEqual(['Drupal\\Core\\Entity::ContentEntityBase::access']);
  });

  it('with a declared type reaches what that type extends', () => {
    expect(callees('Drupal\\comment\\Controller::CommentController::replyAccess', 'entity.access'))
      .toEqual(['Drupal\\Core\\Access::AccessibleInterface::access']);
    expect(callees('Drupal\\comment\\Controller::CommentController::typeOf', 'entity.getEntityType'))
      .toEqual(['Drupal\\Core\\Entity::EntityInterface::getEntityType']);
  });

  it('is the class the file imports, before a namesake it would inherit through', () => {
    expect(callees('Illuminate\\View\\Compilers::BladeCompiler::compile', 'view.render')).toEqual(['Illuminate\\View::View::render']);
  });

  it('is a class a group use imports', () => {
    expect(callees('App\\Http::PageController::store', 'page.persist')).toEqual(['App\\Concerns::Saves::persist']);
  });

  it('takes a trait before the parent', () => {
    expect(callees('Illuminate\\Tests::PivotUser::foreignKey', 'pivot.getForeignKey'))
      .toEqual(['Illuminate\\Database\\Eloquent\\Relations\\Concerns::AsPivot::getForeignKey']);
    expect(callees('Illuminate\\Tests::PivotUser::key', 'pivot.getKey')).toEqual(['Illuminate\\Database\\Eloquent::Model::getKey']);
  });

  it('reads a parent through the name the file imports', () => {
    expect(callees('Illuminate\\Types\\Model::Comments::firstId', 'comments.pluck')).toEqual(['Illuminate\\Database\\Eloquent::Collection::pluck']);
  });

  it('reaches the parent of the one class of the name, even one the file cannot name', () => {
    expect(callees('Drupal\\system\\Controller::SystemController::page', 'theme.getName')).toEqual(['Drupal\\Core\\Extension::Extension::getName']);
  });

  it('reaches any ancestor of the one class of the name', () => {
    expect(callees('BookStack\\Entities\\Controllers::ChapterController::show', 'chapter.getShortName')).toEqual(['BookStack\\Entities\\Models::Entity::getShortName']);
  });

  it('leaves namesakes the file cannot name to the same-file class', () => {
    expect(callees('Illuminate\\Tests\\Broadcasting::BroadcasterTest::testChannel', 'user.getAuthIdentifier'))
      .toEqual(['Illuminate\\Tests\\Broadcasting::GenericBroadcastingTestUser::getAuthIdentifier']);
  });
});

describe('a PHP class written below its attributes', () => {
  it('extends what its head says, through a declared type and on $this', () => {
    expect(callees('Drupal\\taxonomy\\Hook::TaxonomyHooks::deleted', 'term.id')).toEqual(['Drupal\\Core\\Entity::EntityBase::id']);
    expect(callees('Drupal\\taxonomy\\Entity::Term::ownId')).toEqual(['Drupal\\Core\\Entity::EntityBase::id']);
  });
});

describe('past a parent outside the repository', () => {
  it('a call on $this may be a trait of the repository', () => {
    expect(callees('App\\Providers::AppProvider::start')).toEqual(['App\\Concerns::BootsTrait::boot']);
  });

  it('a call on parent is that parent\'s', () => {
    expect(callees('App\\Providers::AppProvider::register')).toEqual([]);
  });
});

describe('a Laravel facade', () => {
  it('hands a static call to the class its accessor names', () => {
    expect(callees('Illuminate\\Support\\Facades::Storage::fake', 'ParallelTesting.token')).toEqual(['Illuminate\\Testing::ParallelTesting::token']);
  });

  it('names no class through a container key', () => {
    expect(callees('Illuminate\\Support\\Facades::Storage::fake', 'Cache.flushEverything')).toEqual([]);
  });
});

describe('a local a static call gives', () => {
  it('holds the model an Eloquent factory makes', () => {
    expect(callees('App\\Models::PostTest::testStringKey', 'post.tags')).toEqual(['App\\Models::PostStringPrimaryKey::tags']);
    expect(callees('App\\Models::PostTest::testNumericKey', 'post.tags')).toEqual(['App\\Models::Post::tags']);
  });

  it('is typed by no class that is not a model', () => {
    expect(callees('App\\Models::PostTest::testOtherClass', 'post.tags')).toEqual(['App\\Models::Post::tags']);
  });
});
