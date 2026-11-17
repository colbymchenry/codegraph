/**
 * What `parent::`, `self::`, `static::` and `$this->` mean inside a PHP
 * anonymous class: that class, what it extends and the traits it uses, never
 * the named class whose method holds `new class …`. framework's
 * `parent::many($keys)` in `new class extends ArrayStore { … }` is
 * `RetrievesMultipleKeys::many`, a trait ArrayStore uses; it was judged by the
 * test class around it, whose parent comes from outside the project, and
 * linked nothing.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'src/Cache/TaggableStore.php': `<?php
namespace Illuminate\\Cache;

abstract class TaggableStore
{
    public function tags($names) { return $names; }
}
`,
  'src/Cache/RetrievesMultipleKeys.php': `<?php
namespace Illuminate\\Cache;

trait RetrievesMultipleKeys
{
    public function many(array $keys) { return []; }
}
`,
  'src/Support/InteractsWithTime.php': `<?php
namespace Illuminate\\Support;

trait InteractsWithTime
{
    protected function currentTime() { return 0; }
}
`,
  'src/Cache/ArrayStore.php': `<?php
namespace Illuminate\\Cache;

use Illuminate\\Support\\InteractsWithTime;

class ArrayStore extends TaggableStore
{
    use InteractsWithTime, RetrievesMultipleKeys;

    public function get($key) { return null; }
}
`,
  'src/Cache/RedisStore.php': `<?php
namespace Illuminate\\Cache;

class RedisStore extends TaggableStore
{
    public function many(array $keys) { return []; }
    public function helper() { return 1; }
}
`,
  'src/Cache/Repository.php': `<?php
namespace Illuminate\\Cache;

class Repository
{
    public function many(array $keys) { return []; }
}
`,
  'tests/Queue/QueuePauseResumeTest.php': `<?php
namespace Illuminate\\Tests\\Queue;

use Illuminate\\Cache\\ArrayStore;
use Illuminate\\Cache\\RetrievesMultipleKeys;
use Illuminate\\Cache\\RedisStore;
use PHPUnit\\Framework\\TestCase;

class QueuePauseResumeTest extends TestCase
{
    public function testParent()
    {
        $store = new class extends ArrayStore {
            public function many(array $keys)
            {
                return parent::many($keys);
            }

            public function stamp()
            {
                return $this->currentTime() . self::get('x') . static::tags([]);
            }
        };

        return $store;
    }

    public function testArguments($prefix)
    {
        return new class($prefix, "{$prefix}}") extends ArrayStore {
            public function __construct($a, $b) {}

            public function many(array $keys)
            {
                return parent::many($keys);
            }
        };
    }

    public function testTraitOnly()
    {
        return new class {
            use RetrievesMultipleKeys;

            public function all()
            {
                return $this->many(['a']);
            }
        };
    }

    public function testOuter()
    {
        $store = new class extends RedisStore {
        };

        return $this->helper() . parent::many([]);
    }

    public function helper() { return ''; }
}
`,
  'src/Queue/QueueManager.php': `<?php
namespace Illuminate\\Queue;

class QueueManager
{
    public function __construct($app) {}
}
`,
  'src/Testing/Fakes/QueueFake.php': `<?php
namespace Illuminate\\Support\\Testing\\Fakes;

use Illuminate\\Queue\\QueueManager;

class QueueFake extends QueueManager
{
    public function __construct($app, $jobsToFake = [])
    {
        parent::__construct($app);
    }
}
`,
  'tests/Cloud/QueueTest.php': `<?php
namespace Illuminate\\Tests\\Cloud;

use Illuminate\\Support\\Testing\\Fakes\\QueueFake;
use PHPUnit\\Framework\\TestCase;

class QueueTest extends TestCase
{
    public function testFake()
    {
        return new class($this->app) extends QueueFake {
            public function __construct($app)
            {
                parent::__construct($app);
            }

            public function pending()
            {
                return $this->helper();
            }

            public function helper()
            {
                return 2;
            }
        };
    }
}
`,
  'src/Cache/NestedStore.php': `<?php
namespace Illuminate\\Cache;

class NestedStore extends ArrayStore
{
    public function make()
    {
        return new class {
            public function many(array $keys)
            {
                return parent::many($keys);
            }

            public function first()
            {
                return $this->get('first');
            }
        };
    }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-anonymous-'));
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

/** What `calls` edges from `caller` reach, as `line target`. */
function callees(caller: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string; line: number }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.qualified_name q, e.line line FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ? ORDER BY e.line, t.qualified_name`).all(caller)
    .map((r) => `${r.line} ${r.q}`);
}

const TEST = 'Illuminate\\Tests\\Queue::QueuePauseResumeTest';

describe('inside a PHP anonymous class', () => {
  it('parent:: is the nearest parent that declares it, not the one it overrides', () => {
    expect(callees('Illuminate\\Tests\\Cloud::QueueTest::testFake')).toEqual(['14 Illuminate\\Support\\Testing\\Fakes::QueueFake::__construct']);
  });

  it('$this-> on a method the anonymous class declares itself links nothing', () => {
    // `helper()` is its own, which the index holds no node for; RedisStore has a namesake.
    expect(callees('Illuminate\\Tests\\Cloud::QueueTest::testFake').filter((c) => c.startsWith('19 '))).toEqual([]);
  });

  it('parent:: is what the class extends, through the traits that parent uses', () => {
    expect(callees(`${TEST}::testParent`)).toEqual([
      '16 Illuminate\\Cache::RetrievesMultipleKeys::many',
      '21 Illuminate\\Cache::ArrayStore::get',
      '21 Illuminate\\Cache::TaggableStore::tags',
      '21 Illuminate\\Support::InteractsWithTime::currentTime',
    ]);
  });

  it('is found past constructor arguments, braces in a string among them', () => {
    expect(callees(`${TEST}::testArguments`)).toEqual(['35 Illuminate\\Cache::RetrievesMultipleKeys::many']);
  });

  it('$this-> reaches a trait the anonymous class uses itself', () => {
    expect(callees(`${TEST}::testTraitOnly`)).toEqual(['47 Illuminate\\Cache::RetrievesMultipleKeys::many']);
  });

  it('extends nothing the named class around it extends', () => {
    // `new class { … }` has no parent, and none of NestedStore's methods.
    expect(callees('Illuminate\\Cache::NestedStore::make')).toEqual([]);
  });

  it('ends where its body ends: after it, the named class decides again', () => {
    // `$this->helper()` is the test's own; `parent::many()` is TestCase's, from outside.
    expect(callees(`${TEST}::testOuter`)).toEqual([`57 ${TEST}::helper`]);
  });
});
