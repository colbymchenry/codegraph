/**
 * Tests for PHP @property PHPDoc synthesis.
 *
 * Unit tests cover phpPhpdocResolver.detect(), extract(), resolve(), and
 * claimsReference(). End-to-end tests use a real CodeGraph instance with
 * temporary PHP fixture projects to verify:
 *   - @property → references (heuristic) edges from the synthesizer
 *   - PHP interface override → calls (heuristic) edges from IFACE_OVERRIDE_LANGS
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { phpPhpdocResolver } from '../src/resolution/frameworks/php-phpdoc';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  overrides: Partial<ResolutionContext> = {},
): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  };
}

function makeRef(name: string, overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'class:abc123',
    referenceName: name,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'test.php',
    language: 'php',
    ...overrides,
  };
}

function makeNode(name: string, kind: Node['kind'] = 'class', language = 'php'): Node {
  return {
    id: `${kind}:${name.toLowerCase()}`,
    kind,
    name,
    qualifiedName: `test.php::${name}`,
    filePath: 'test.php',
    language: language as any,
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// phpPhpdocResolver.detect()
// ---------------------------------------------------------------------------

describe('phpPhpdocResolver.detect', () => {
  it('returns true when a PHP file contains @property', () => {
    const ctx = makeContext({
      getAllFiles: () => ['app/models/ctx.php'],
      readFile: (f) =>
        f === 'app/models/ctx.php'
          ? '<?php\n/** @property User_Factory $user_factory */\nclass Ctx {}'
          : null,
    });
    expect(phpPhpdocResolver.detect(ctx)).toBe(true);
  });

  it('returns false when no PHP files contain @property', () => {
    const ctx = makeContext({
      getAllFiles: () => ['app/models/user.php'],
      readFile: (f) =>
        f === 'app/models/user.php'
          ? '<?php\nclass User {}'
          : null,
    });
    expect(phpPhpdocResolver.detect(ctx)).toBe(false);
  });

  it('returns false when only non-PHP files contain @property', () => {
    const ctx = makeContext({
      getAllFiles: () => ['README.md'],
      readFile: () => '## @property annotations are documented here',
    });
    expect(phpPhpdocResolver.detect(ctx)).toBe(false);
  });

  it('returns false on an empty project', () => {
    const ctx = makeContext({ getAllFiles: () => [] });
    expect(phpPhpdocResolver.detect(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// phpPhpdocResolver.claimsReference()
// ---------------------------------------------------------------------------

describe('phpPhpdocResolver.claimsReference', () => {
  it('claims phpdoc-property: prefixed names', () => {
    expect(phpPhpdocResolver.claimsReference!('phpdoc-property:User_Factory')).toBe(true);
  });

  it('does not claim non-prefixed names', () => {
    expect(phpPhpdocResolver.claimsReference!('User_Factory')).toBe(false);
    expect(phpPhpdocResolver.claimsReference!('findByUid')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// phpPhpdocResolver.extract()
// ---------------------------------------------------------------------------

describe('phpPhpdocResolver.extract', () => {
  it('extracts @property references from a class docblock', () => {
    const content = `<?php
/**
 * @property User_Factory $user_factory
 * @property Friend_Service $friend_service
 */
class Ctx extends Mpf_Ctx {
    public function init() {}
}`;
    const { nodes, references } = phpPhpdocResolver.extract!('app/models/ctx.php', content);
    expect(nodes).toEqual([]);
    expect(references).toHaveLength(2);
    expect(references[0]!.referenceName).toBe('phpdoc-property:User_Factory');
    expect(references[1]!.referenceName).toBe('phpdoc-property:Friend_Service');
    expect(references[0]!.referenceKind).toBe('references');
    expect(references[0]!.language).toBe('php');
  });

  it('handles @property-read and @property-write variants', () => {
    const content = `<?php
/**
 * @property-read Cache_Manager $cache
 * @property-write Log_Service $logger
 */
class Container {}`;
    const { references } = phpPhpdocResolver.extract!('container.php', content);
    expect(references).toHaveLength(2);
    expect(references[0]!.referenceName).toBe('phpdoc-property:Cache_Manager');
    expect(references[1]!.referenceName).toBe('phpdoc-property:Log_Service');
  });

  it('filters out primitive types', () => {
    const content = `<?php
/**
 * @property string $name
 * @property int $age
 * @property bool $active
 * @property array $items
 * @property User_Model $user
 */
class Entity {}`;
    const { references } = phpPhpdocResolver.extract!('entity.php', content);
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe('phpdoc-property:User_Model');
  });

  it('handles union types (takes first non-primitive)', () => {
    const content = `<?php
/**
 * @property User_Model|null $user
 * @property string|int $id
 */
class Wrapper {}`;
    const { references } = phpPhpdocResolver.extract!('wrapper.php', content);
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe('phpdoc-property:User_Model');
  });

  it('handles namespaced types (extracts simple name)', () => {
    const content = `<?php
/**
 * @property App\\Models\\User $user
 * @property \\Vendor\\Cache\\Redis $redis
 */
class ServiceLocator {}`;
    const { references } = phpPhpdocResolver.extract!('locator.php', content);
    expect(references).toHaveLength(2);
    expect(references[0]!.referenceName).toBe('phpdoc-property:User');
    expect(references[1]!.referenceName).toBe('phpdoc-property:Redis');
  });

  it('extracts from interface and trait docblocks', () => {
    const content = `<?php
/**
 * @property Logger $logger
 */
interface HasLogger {}

/**
 * @property Db_Connection $db
 */
trait DatabaseAware {}`;
    const { references } = phpPhpdocResolver.extract!('contracts.php', content);
    expect(references).toHaveLength(2);
    expect(references[0]!.referenceName).toBe('phpdoc-property:Logger');
    expect(references[1]!.referenceName).toBe('phpdoc-property:Db_Connection');
  });

  it('handles abstract and final class modifiers', () => {
    const content = `<?php
/**
 * @property Redis_Client $redis
 */
abstract class Base_Model {}

/**
 * @property Config $config
 */
final class AppConfig {}`;
    const { references } = phpPhpdocResolver.extract!('base.php', content);
    expect(references).toHaveLength(2);
    expect(references[0]!.referenceName).toBe('phpdoc-property:Redis_Client');
    expect(references[1]!.referenceName).toBe('phpdoc-property:Config');
  });

  it('returns empty for non-PHP files', () => {
    const { nodes, references } = phpPhpdocResolver.extract!('readme.md', '# @property docs');
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });

  it('returns empty for PHP files without @property', () => {
    const { references } = phpPhpdocResolver.extract!(
      'plain.php',
      '<?php\nclass PlainClass { public function run() {} }',
    );
    expect(references).toEqual([]);
  });

  it('skips @property in method docblocks (only class-level)', () => {
    const content = `<?php
class Foo {
    /**
     * @property ShouldNotMatch $x
     */
    public function bar() {}
}`;
    const { references } = phpPhpdocResolver.extract!('foo.php', content);
    expect(references).toEqual([]);
  });

  it('handles multiple classes in one file', () => {
    const content = `<?php
/**
 * @property TypeA $a
 */
class First {}

/**
 * @property TypeB $b
 * @property TypeC $c
 */
class Second {}`;
    const { references } = phpPhpdocResolver.extract!('multi.php', content);
    expect(references).toHaveLength(3);
    const names = references.map((r) => r.referenceName);
    expect(names).toContain('phpdoc-property:TypeA');
    expect(names).toContain('phpdoc-property:TypeB');
    expect(names).toContain('phpdoc-property:TypeC');
  });
});

// ---------------------------------------------------------------------------
// phpPhpdocResolver.resolve()
// ---------------------------------------------------------------------------

describe('phpPhpdocResolver.resolve', () => {
  it('resolves phpdoc-property:TypeName to a PHP class node', () => {
    const target = makeNode('User_Factory', 'class');
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'User_Factory' ? [target] : []),
    });
    const ref = makeRef('phpdoc-property:User_Factory');
    const result = phpPhpdocResolver.resolve(ref, ctx);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe(target.id);
    expect(result!.confidence).toBe(0.85);
    expect(result!.resolvedBy).toBe('framework');
  });

  it('resolves to interface or trait nodes', () => {
    const iface = makeNode('Cacheable', 'interface');
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'Cacheable' ? [iface] : []),
    });
    const result = phpPhpdocResolver.resolve(makeRef('phpdoc-property:Cacheable'), ctx);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe(iface.id);
  });

  it('returns null for non-phpdoc-property references', () => {
    const ctx = makeContext();
    expect(phpPhpdocResolver.resolve(makeRef('findByUid'), ctx)).toBeNull();
    expect(phpPhpdocResolver.resolve(makeRef('User_Factory'), ctx)).toBeNull();
  });

  it('returns null when target type is not found', () => {
    const ctx = makeContext({ getNodesByName: () => [] });
    expect(phpPhpdocResolver.resolve(makeRef('phpdoc-property:Unknown_Type'), ctx)).toBeNull();
  });

  it('ignores non-PHP nodes with the same name', () => {
    const jsNode = makeNode('Logger', 'class', 'javascript');
    const ctx = makeContext({
      getNodesByName: () => [jsNode],
    });
    expect(phpPhpdocResolver.resolve(makeRef('phpdoc-property:Logger'), ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: phpPhpdocPropertyEdges synthesizer
// ---------------------------------------------------------------------------

describe('PHP @property PHPDoc synthesizer (end-to-end)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-phpdoc-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes references edges from @property annotations to target classes', async () => {
    fs.writeFileSync(
      path.join(dir, 'ctx.php'),
      `<?php
/**
 * @property User_Factory $user_factory
 * @property Order_Service $order_service
 */
class Ctx {
    public function __get($name) {
        return $this->services[$name];
    }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'user_factory.php'),
      `<?php
class User_Factory {
    public function findByUid($uid) {
        return null;
    }
    public function create($data) {
        return null;
    }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'order_service.php'),
      `<?php
class Order_Service {
    public function getOrders($uid) {
        return [];
    }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind, t.name target_name, t.kind target_kind,
                e.kind edge_kind, e.provenance,
                json_extract(e.metadata,'$.synthesizedBy') synthesizedBy,
                json_extract(e.metadata,'$.via') via
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'php-phpdoc-property'`,
      )
      .all();
    cg.close?.();

    expect(rows.length).toBeGreaterThanOrEqual(2);

    const targetNames = new Set(rows.map((r: any) => r.target_name));
    expect(targetNames).toContain('User_Factory');
    expect(targetNames).toContain('Order_Service');

    for (const row of rows as any[]) {
      expect(row.source_name).toBe('Ctx');
      expect(row.source_kind).toBe('class');
      expect(row.edge_kind).toBe('references');
      expect(row.provenance).toBe('heuristic');
      expect(row.via).toMatch(/@property/);
    }
  });

  it('skips primitive types and handles @property-read', async () => {
    fs.writeFileSync(
      path.join(dir, 'config.php'),
      `<?php
/**
 * @property string $name
 * @property int $port
 * @property-read Redis_Client $redis
 */
class Config {
    public function __get($key) { return null; }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'redis_client.php'),
      `<?php
class Redis_Client {
    public function get($key) { return null; }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT t.name target_name, json_extract(e.metadata,'$.via') via
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'php-phpdoc-property'`,
      )
      .all();
    cg.close?.();

    expect(rows).toHaveLength(1);
    expect((rows[0] as any).target_name).toBe('Redis_Client');
    expect((rows[0] as any).via).toMatch(/@property-read/);
  });

  it('produces no edges when @property targets have no matching class node', async () => {
    fs.writeFileSync(
      path.join(dir, 'orphan.php'),
      `<?php
/**
 * @property NonExistent_Service $svc
 */
class Orphan {
    public function __get($name) { return null; }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT COUNT(*) cnt FROM edges e
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'php-phpdoc-property'`,
      )
      .all();
    cg.close?.();

    expect((rows[0] as any).cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: phpPhpdocPropertyEdges — method→method calls edges
// ---------------------------------------------------------------------------

describe('PHP @property PHPDoc method→method calls edges (end-to-end)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-phpdoc-calls-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes calls edges when a method calls ->propName->method()', async () => {
    fs.writeFileSync(
      path.join(dir, 'ctx.php'),
      `<?php
/**
 * @property User_Factory $user_factory
 * @property Order_Service $order_service
 */
class Ctx {
    public function __get($name) {
        return $this->services[$name];
    }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'user_factory.php'),
      `<?php
class User_Factory {
    public function findByUid($uid) {
        return null;
    }
    public function create($data) {
        return null;
    }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'order_service.php'),
      `<?php
class Order_Service {
    public function getOrders($uid) {
        return [];
    }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'controller.php'),
      `<?php
class UserController {
    public function show($uid) {
        $user = $this->ctx->user_factory->findByUid($uid);
        return $user;
    }
    public function listOrders($uid) {
        return $this->ctx->order_service->getOrders($uid);
    }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const callsRows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind, t.name target_name, t.kind target_kind,
                e.kind edge_kind, e.provenance,
                json_extract(e.metadata,'$.synthesizedBy') synthesizedBy,
                json_extract(e.metadata,'$.via') via
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'php-phpdoc-property'
           AND e.kind = 'calls'`,
      )
      .all();
    cg.close?.();

    expect(callsRows.length).toBeGreaterThanOrEqual(2);

    const callPairs = callsRows.map((r: any) => `${r.source_name}->${r.target_name}`);
    expect(callPairs).toContain('show->findByUid');
    expect(callPairs).toContain('listOrders->getOrders');

    for (const row of callsRows as any[]) {
      expect(row.source_kind).toBe('method');
      expect(row.target_kind).toBe('method');
      expect(row.edge_kind).toBe('calls');
      expect(row.provenance).toBe('heuristic');
      expect(row.via).toMatch(/@property/);
    }
  });

  it('synthesizes calls edges for chained property access ($this->ctx->factory->method())', async () => {
    fs.writeFileSync(
      path.join(dir, 'pay.php'),
      `<?php
/**
 * @property Pay_Firstcharge $firstcharge
 */
class Pay {
    public function __get($name) { return null; }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'pay_firstcharge.php'),
      `<?php
class Pay_Firstcharge {
    public function showFirstCharge($uid) {
        return true;
    }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'controller.php'),
      `<?php
class ChargeController {
    public function charge($uid) {
        return $this->ctx->pay->firstcharge->showFirstCharge($uid);
    }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, t.name target_name, e.kind edge_kind,
                json_extract(e.metadata,'$.synthesizedBy') synthesizedBy
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'php-phpdoc-property'
           AND e.kind = 'calls'`,
      )
      .all();
    cg.close?.();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const match = (rows as any[]).find(
      (r) => r.source_name === 'charge' && r.target_name === 'showFirstCharge',
    );
    expect(match).toBeTruthy();
    expect(match.edge_kind).toBe('calls');
  });

  it('does not create calls edges when method name does not exist on target class', async () => {
    fs.writeFileSync(
      path.join(dir, 'ctx.php'),
      `<?php
/**
 * @property Cache_Service $cache
 */
class Ctx {
    public function __get($name) { return null; }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'cache_service.php'),
      `<?php
class Cache_Service {
    public function get($key) { return null; }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'controller.php'),
      `<?php
class MyController {
    public function action() {
        $this->cache->nonExistentMethod();
    }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT COUNT(*) cnt FROM edges e
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'php-phpdoc-property'
           AND e.kind = 'calls'`,
      )
      .all();
    cg.close?.();

    expect((rows[0] as any).cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: PHP interface override bridging (IFACE_OVERRIDE_LANGS)
// ---------------------------------------------------------------------------

describe('PHP interface override bridging (end-to-end)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-iface-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes calls edges from interface methods to implementing class methods', async () => {
    fs.writeFileSync(
      path.join(dir, 'user_repo_interface.php'),
      `<?php
interface UserRepositoryInterface {
    public function findByUid($uid);
    public function save($user);
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'mysql_user_repo.php'),
      `<?php
class MysqlUserRepository implements UserRepositoryInterface {
    public function findByUid($uid) {
        return null;
    }
    public function save($user) {
        return true;
    }
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind, t.name target_name, t.kind target_kind,
                e.provenance,
                json_extract(e.metadata,'$.synthesizedBy') synthesizedBy,
                json_extract(e.metadata,'$.via') via
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'interface-impl'
           AND s.language = 'php'`,
      )
      .all();
    cg.close?.();

    expect(rows.length).toBeGreaterThanOrEqual(2);

    const bridged = new Map(rows.map((r: any) => [r.via, r]));
    expect(bridged.has('findByUid')).toBe(true);
    expect(bridged.has('save')).toBe(true);

    for (const row of rows as any[]) {
      expect(row.source_kind).toBe('method');
      expect(row.target_kind).toBe('method');
      expect(row.provenance).toBe('heuristic');
    }
  });

  it('bridges abstract class methods to concrete subclass methods', async () => {
    fs.writeFileSync(
      path.join(dir, 'base_service.php'),
      `<?php
abstract class BaseService {
    abstract public function execute($params);
    public function validate($params) { return true; }
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'email_service.php'),
      `<?php
class EmailService extends BaseService {
    public function execute($params) {
        return $this->send($params);
    }
    public function validate($params) {
        return parent::validate($params);
    }
    private function send($params) {}
}
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, t.name target_name,
                json_extract(e.metadata,'$.synthesizedBy') synthesizedBy,
                json_extract(e.metadata,'$.via') via
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'interface-impl'
           AND s.language = 'php'`,
      )
      .all();
    cg.close?.();

    const viaNames = new Set(rows.map((r: any) => r.via));
    expect(viaNames.has('execute')).toBe(true);
    expect(viaNames.has('validate')).toBe(true);
  });
});
