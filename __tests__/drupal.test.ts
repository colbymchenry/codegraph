/**
 * Tests for Drupal framework resolver.
 *
 * Unit tests cover drupalResolver.detect(), extract() (routes + hooks), and resolve().
 * Integration tests use a real CodeGraph instance with a temporary Drupal project layout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { drupalResolver } from '../src/resolution/frameworks/drupal';
import type { ResolutionContext } from '../src/resolution/types';

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

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

describe('drupalResolver.detect', () => {
  it('returns true when composer.json has a drupal/ dependency', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({
              require: {
                'drupal/core-recommended': '~10.5',
                'drush/drush': '^13',
              },
            })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns true when drupal/ dependency is in require-dev', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({ 'require-dev': { 'drupal/core': '^10' } })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns false when composer.json has no drupal/ dependencies', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({
              require: { 'laravel/framework': '^10', php: '>=8.1' },
            })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });

  it('returns false when composer.json is absent', () => {
    const ctx = makeContext({ readFile: () => null });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });

  it('returns false when composer.json is malformed JSON', () => {
    const ctx = makeContext({ readFile: () => '{ bad json' });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });

  it('returns true for a contrib module with empty require (composer name/type)', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({
              name: 'drupal/admin_toolbar',
              type: 'drupal-module',
              require: {},
            })
          : null,
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns true via the *.info.yml fallback when composer.json is absent', () => {
    const ctx = makeContext({
      readFile: () => null,
      getAllFiles: () => [
        'mymodule/mymodule.info.yml',
        'mymodule/mymodule.routing.yml',
      ],
    });
    expect(drupalResolver.detect(ctx)).toBe(true);
  });

  it('returns false for a stray *.info.yml with no Drupal PHP/route file', () => {
    const ctx = makeContext({
      readFile: () => null,
      getAllFiles: () => ['some/unrelated.info.yml'],
    });
    expect(drupalResolver.detect(ctx)).toBe(false);
  });
});

describe('drupalResolver.claimsReference', () => {
  it('claims FQCN handler refs and hook names the pre-filter would drop', () => {
    expect(drupalResolver.claimsReference!('\\Drupal\\m\\Form\\SettingsForm')).toBe(true);
    expect(drupalResolver.claimsReference!('\\Drupal\\m\\Controller\\C:setNoJsCookie')).toBe(true);
    expect(drupalResolver.claimsReference!('hook_form_alter')).toBe(true);
  });

  it('does not claim ordinary identifiers or entity-handler dotted refs', () => {
    expect(drupalResolver.claimsReference!('someHelperFunction')).toBe(false);
    expect(drupalResolver.claimsReference!('comment.default')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extract() — routing.yml
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — routing.yml', () => {
  const routing = `
mymodule.example:
  path: '/mymodule/example'
  defaults:
    _controller: '\\Drupal\\mymodule\\Controller\\MyController::build'
    _title: 'Example page'
  requirements:
    _permission: 'access content'
`;

  it('emits a route node for each YAML route', () => {
    const { nodes } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      routing,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('/mymodule/example');
  });

  it('sets qualifiedName to filePath::routeName', () => {
    const { nodes } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      routing,
    );
    expect(nodes[0]!.qualifiedName).toBe(
      'mymodule/mymodule.routing.yml::mymodule.example',
    );
  });

  it('emits a references edge to the controller FQCN', () => {
    const { references } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      routing,
    );
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe(
      '\\Drupal\\mymodule\\Controller\\MyController::build',
    );
    expect(references[0]!.referenceKind).toBe('references');
  });

  it('emits a references edge to a _form handler', () => {
    const src = `
mymodule.settings_form:
  path: '/admin/config/mymodule'
  defaults:
    _form: '\\Drupal\\mymodule\\Form\\SettingsForm'
    _title: 'MyModule settings'
  requirements:
    _permission: 'administer site configuration'
`;
    const { nodes, references } = drupalResolver.extract!(
      'mymodule/mymodule.routing.yml',
      src,
    );
    expect(nodes).toHaveLength(1);
    expect(references[0]!.referenceName).toBe(
      '\\Drupal\\mymodule\\Form\\SettingsForm',
    );
  });

  it('handles multiple routes in one file', () => {
    const src = `
mod.page_one:
  path: '/page-one'
  defaults:
    _controller: '\\Drupal\\mod\\Controller\\PageController::one'
  requirements:
    _permission: 'access content'

mod.page_two:
  path: '/page-two'
  defaults:
    _controller: '\\Drupal\\mod\\Controller\\PageController::two'
  requirements:
    _permission: 'access content'
`;
    const { nodes, references } = drupalResolver.extract!(
      'mod/mod.routing.yml',
      src,
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name)).toContain('/page-one');
    expect(nodes.map((n) => n.name)).toContain('/page-two');
    expect(references).toHaveLength(2);
  });

  it('skips commented-out lines', () => {
    const src = `
mod.page:
  path: '/page'
  defaults:
    #_controller: '\\Drupal\\mod\\Controller\\Old::build'
    _controller: '\\Drupal\\mod\\Controller\\New::build'
  requirements:
    _permission: 'access content'
`;
    const { references } = drupalResolver.extract!('mod/mod.routing.yml', src);
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toContain('New');
  });

  it('includes HTTP methods in the route node name when present', () => {
    const src = `
mod.api:
  path: '/api/resource'
  defaults:
    _controller: '\\Drupal\\mod\\Controller\\ApiController::get'
  methods: [GET, POST]
  requirements:
    _permission: 'access content'
`;
    const { nodes } = drupalResolver.extract!('mod/mod.routing.yml', src);
    expect(nodes[0]!.name).toContain('GET');
    expect(nodes[0]!.name).toContain('POST');
  });

  it('returns empty result for non-routing-yml files', () => {
    const { nodes, references } = drupalResolver.extract!(
      'mymodule.module',
      '<?php\n',
    );
    // Module files go through hook detection, not route extraction
    expect(nodes).toHaveLength(0);
  });

  it('returns empty result for files with no valid routes', () => {
    const { nodes, references } = drupalResolver.extract!(
      'some.routing.yml',
      '# empty\n',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extract() — hook detection in .module files
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — hook detection', () => {
  it('detects hook implementation via docblock (Strategy A)', () => {
    const src = `<?php

/**
 * Implements hook_form_alter().
 */
function mymodule_form_alter(&$form, $form_state, $form_id) {
  // ...
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const hookRef = references.find(
      (r) => r.referenceName === 'hook_form_alter',
    );
    expect(hookRef).toBeDefined();
    expect(hookRef!.referenceKind).toBe('references');
  });

  it('detects hook implementation via name pattern (Strategy B)', () => {
    const src = `<?php

function mymodule_views_data() {
  return [];
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const hookRef = references.find(
      (r) => r.referenceName === 'hook_views_data',
    );
    expect(hookRef).toBeDefined();
  });

  it('does not emit a hook ref for non-hook helper functions', () => {
    // 'other_module_helper' doesn't start with 'mymodule_', so no hook ref
    const src = `<?php
function other_module_helper() {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    expect(references).toHaveLength(0);
  });

  it('detects hooks in .install files', () => {
    const src = `<?php
/**
 * Implements hook_schema().
 */
function mymodule_schema() {
  return [];
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.install',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_schema');
    expect(hookRef).toBeDefined();
  });

  it('detects hooks in .theme files', () => {
    const src = `<?php
/**
 * Implements hook_preprocess_node().
 */
function mytheme_preprocess_node(&$variables) {}
`;
    const { references } = drupalResolver.extract!(
      'web/themes/custom/mytheme/mytheme.theme',
      src,
    );
    const hookRef = references.find(
      (r) => r.referenceName === 'hook_preprocess_node',
    );
    expect(hookRef).toBeDefined();
  });

  it('does not duplicate refs when both docblock and name pattern match', () => {
    // Strategy A matches first and adds to docblockMatched set;
    // Strategy B skips already-matched functions.
    const src = `<?php
/**
 * Implements hook_form_alter().
 */
function mymodule_form_alter(&$form, $form_state, $form_id) {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const hookRefs = references.filter(
      (r) => r.referenceName === 'hook_form_alter',
    );
    expect(hookRefs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extract() — OOP hooks (#[Hook], Drupal 10.2+)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — OOP hooks', () => {
  it('detects a method-level #[Hook] attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Hook;

use Drupal\\Core\\Entity\\EntityInterface;

class MyHooks {
  #[Hook('entity_presave')]
  public function entityPresave(EntityInterface $entity): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hook/MyHooks.php',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_entity_presave');
    expect(hookRef).toBeDefined();
    expect(hookRef!.fromNodeId.startsWith('method:')).toBe(true);
  });

  it('detects a class-level #[Hook] with a method: parameter', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Hook;

#[Hook('form_alter', method: 'formAlter')]
class FormHooks {
  public function formAlter(array &$form, &$form_state): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hook/FormHooks.php',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_form_alter');
    expect(hookRef).toBeDefined();
    expect(hookRef!.fromNodeId.startsWith('method:')).toBe(true);
  });

  it('detects a class-level #[Hook] implemented via __invoke()', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Hook;

#[Hook('cron')]
class CronHandler {
  public function __invoke(): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hook/CronHandler.php',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_cron');
    expect(hookRef).toBeDefined();
    expect(hookRef!.fromNodeId.startsWith('method:')).toBe(true);
  });

  it('detects every hook in a stack of attributes on one method', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Hook;

class CommentHooks {
  #[Hook('comment_insert')]
  #[Hook('comment_update')]
  public function commentSave($comment): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hook/CommentHooks.php',
      src,
    );
    const names = references.map((r) => r.referenceName);
    expect(names).toContain('hook_comment_insert');
    expect(names).toContain('hook_comment_update');
  });

  it('does not emit hook refs for unrelated attributes', () => {
    const src = `<?php
namespace Drupal\\mymodule;

class Foo {
  #[SomeOtherAttr('x')]
  public function bar(): void {}
}
`;
    const { references } = drupalResolver.extract!('foo/foo.php', src);
    expect(references.filter((r) => r.referenceName.startsWith('hook_'))).toHaveLength(0);
  });

  it('detects OOP hooks in a .module file alongside procedural hooks', () => {
    const src = `<?php
use Drupal\\Core\\Entity\\EntityInterface;

/**
 * Implements hook_node_insert().
 */
function mymodule_node_insert($node) {}

class MyHooks {
  #[Hook('entity_presave')]
  public function entityPresave(EntityInterface $entity): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.module',
      src,
    );
    const names = references.map((r) => r.referenceName);
    expect(names).toContain('hook_node_insert');
    expect(names).toContain('hook_entity_presave');
  });
});

// ---------------------------------------------------------------------------
// extract() — plugin declarations (annotations + attributes)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — plugins', () => {
  it('detects a @Block docblock annotation (pre-10.2)', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Block;

use Drupal\\Core\\Block\\BlockBase;

/**
 * @Block(
 *   id = "my_block",
 *   admin_label = @Translation("My block")
 * )
 */
class MyBlock extends BlockBase {}
`;
    const { references } = drupalResolver.extract!( 'mymodule/src/Plugin/Block/MyBlock.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:Block' }));
  });

  it('detects a #[Block] PHP 8 attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Block;

use Drupal\\Core\\Block\\BlockBase;

#[Block(id: 'my_block', admin_label: 'My block')]
class MyBlock extends BlockBase {}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/Block/MyBlock.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:Block' }));
  });

  it('detects an [QueueWorker docblock annotation', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\QueueWorker;

use Drupal\\Core\\Queue\\QueueWorkerBase;

/**
 * @QueueWorker(
 *   id = "my_queue_worker",
 *   title = @Translation("My queue worker")
 * )
 */
class MyQueueWorker extends QueueWorkerBase {
  public function processItem($item) {}
}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/QueueWorker/MyQueueWorker.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:QueueWorker' }));
  });

  it('detects a #[Action] PHP 8 attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Action;

use Drupal\\Core\\Action\\ActionBase;

#[Action(id: 'my_action', label: 'My action')]
class MyAction extends ActionBase {
  public function execute($entity = null) {}
}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/Action/MyAction.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:Action' }));
  });

  it('detects a @Filter docblock annotation', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Filter;

use Drupal\\filter\\Plugin\\FilterBase;

/**
 * @Filter(
 *   id = "my_filter",
 *   title = @Translation("My filter")
 * )
 */
class MyFilter extends FilterBase {
  public function process($text, $langcode) {}
}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/Filter/MyFilter.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:Filter' }));
  });

  it('detects a @ViewsField docblock annotation', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\views\\field;

use Drupal\\views\\Plugin\\views\\field\\FieldPluginBase;

/**
 * @ViewsField(
 *   id = "my_field",
 *   title = @Translation("My field")
 * )
 */
class MyField extends FieldPluginBase {
  public function render($values) {}
}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/views/field/MyField.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:ViewsField' }));
  });

  it('detects a #[ViewsField] PHP 8 attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\views\\field;

use Drupal\\views\\Plugin\\views\\field\\FieldPluginBase;

#[ViewsField(id: 'my_field', title: 'My field')]
class MyField extends FieldPluginBase {
  public function render($values) {}
}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/views/field/MyField.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:ViewsField' }));
  });

  it('detects a #[ContentEntityType] PHP 8 attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Entity;

use Drupal\\Core\\Entity\\ContentEntityBase;

#[ContentEntityType(id: 'my_entity', label: 'My entity')]
class MyEntity extends ContentEntityBase {}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Entity/MyEntity.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:ContentEntityType' }));
  });

  it('detects a #[RestResource] PHP 8 attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\rest\\resource;

use Drupal\\rest\\Plugin\\ResourceBase;

#[RestResource(id: 'my_resource', label: 'My resource')]
class MyResource extends ResourceBase {}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/rest/resource/MyResource.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:RestResource' }));
  });

  it('detects a @Layout docblock annotation', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Layout;

use Drupal\\Core\\Layout\\LayoutDefault;

/**
 * @Layout(
 *   id = "my_layout",
 *   label = @Translation("My layout")
 * )
 */
class MyLayout extends LayoutDefault {}
`;
    const { references } = drupalResolver.extract!('mymodule/src/Plugin/Layout/MyLayout.php', src);
    expect(references).toContainEqual(expect.objectContaining({ referenceName: 'drupal:plugin:Layout' }));
  });

  it('does not emit plugin refs for plain classes', () => {
    const src = `<?php
namespace Drupal\\mymodule;

class PlainHelper {
  public function help(): void {}
}
`;
    const { references } = drupalResolver.extract!('mymodule/src/PlainHelper.php', src);
    expect(references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extract() — event subscribers (services.yml)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — event subscribers', () => {
  it('emits a component node + class reference for one subscriber service', () => {
    const src = `services:
  mymodule.event_subscriber:
    class: Drupal\\mymodule\\EventSubscriber\\MySubscriber
    tags:
      - { name: event_subscriber }
`;
    const { nodes, references } = drupalResolver.extract!(
      'mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('component');
    expect(nodes[0]!.name).toBe('mymodule.event_subscriber');
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe(
      'Drupal\\mymodule\\EventSubscriber\\MySubscriber',
    );
    expect(references[0]!.fromNodeId).toBe(nodes[0]!.id);
  });

  it('emits separate component nodes for multiple subscriber services', () => {
    const src = `services:
  custom.event_subscriber:
    class: Drupal\\custom\\EventSubscriber\\One
    tags:
      - { name: event_subscriber }
  custom.another_subscriber:
    class: Drupal\\custom\\EventSubscriber\\Two
    tags:
      - { name: event_subscriber }
`;
    const { nodes, references } = drupalResolver.extract!('custom/custom.services.yml', src);
    expect(nodes).toHaveLength(2);
    expect(references).toHaveLength(2);
  });

  it('ignores services not tagged event_subscriber', () => {
    const src = `services:
  mymodule.plain_service:
    class: Drupal\\mymodule\\Service\\Foo
    tags:
      - { name: foo }
  mymodule.subscriber:
    class: Drupal\\mymodule\\EventSubscriber\\MySubscriber
    tags:
      - { name: event_subscriber }
`;
    const { nodes, references } = drupalResolver.extract!(
      'mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('mymodule.subscriber');
    expect(references).toHaveLength(1);
  });

  it('ignores services without a class', () => {
    const src = `services:
  mymodule.abstract_subscriber:
    class: Drupal\\mymodule\\EventSubscriber\\Base
    abstract: true
    tags:
      - { name: event_subscriber }
`;
    const { nodes, references } = drupalResolver.extract!(
      'mymodule/mymodule.services.yml',
      src,
    );
    // abstract service has a class but no concrete use — still tagged; keep it.
    // A service with NO class at all must be ignored:
    const src2 = `services:
  mymodule.no_class:
    tags:
      - { name: event_subscriber }
`;
    const r = drupalResolver.extract!('mymodule/mymodule.services.yml', src2);
    expect(r.nodes).toHaveLength(0);
    expect(r.references).toHaveLength(0);
    expect(nodes).toHaveLength(1);
  });

  it('returns empty for a yml file with no services block', () => {
    const { nodes, references } = drupalResolver.extract!(
      'mymodule/mymodule.libraries.yml',
      'mymodule.core:\n  css:\n    base:\n      css/base.css: {}\n',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

describe('drupalResolver.resolve', () => {
  it('resolves a _controller FQCN with ::method to the method node', () => {
    const methodNode = {
      id: 'method:abc123',
      kind: 'method' as const,
      name: 'build',
      qualifiedName: 'MyController::build',
      filePath: 'web/modules/custom/mymodule/src/Controller/MyController.php',
      language: 'php' as const,
      startLine: 10,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const classNode = {
      id: 'class:def456',
      kind: 'class' as const,
      name: 'MyController',
      qualifiedName: 'MyController',
      filePath: 'web/modules/custom/mymodule/src/Controller/MyController.php',
      language: 'php' as const,
      startLine: 5,
      endLine: 30,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'MyController' ? [classNode] : []),
      getNodesInFile: () => [classNode, methodNode],
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\mymodule\\Controller\\MyController::build',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule.routing.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('method:abc123');
    expect(resolved!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('resolves a _form FQCN (no ::method) to the class node', () => {
    const classNode = {
      id: 'class:form123',
      kind: 'class' as const,
      name: 'SettingsForm',
      qualifiedName: 'SettingsForm',
      filePath: 'web/modules/custom/mymodule/src/Form/SettingsForm.php',
      language: 'php' as const,
      startLine: 1,
      endLine: 50,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'SettingsForm' ? [classNode] : []),
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\mymodule\\Form\\SettingsForm',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule.routing.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:form123');
  });

  it('returns null when the target class cannot be found', () => {
    const ctx = makeContext({ getNodesByName: () => [] });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\mymodule\\Controller\\Missing::method',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule.routing.yml',
      language: 'yaml' as const,
    };
    expect(drupalResolver.resolve(ref, ctx)).toBeNull();
  });

  it('resolves a single-colon controller-service ref (Class:method)', () => {
    const methodNode = {
      id: 'method:nojs1',
      kind: 'method' as const,
      name: 'setNoJsCookie',
      qualifiedName: 'BigPipeController::setNoJsCookie',
      filePath: 'core/modules/big_pipe/src/Controller/BigPipeController.php',
      language: 'php' as const,
      startLine: 10,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const classNode = {
      id: 'class:nojs2',
      kind: 'class' as const,
      name: 'BigPipeController',
      qualifiedName: 'BigPipeController',
      filePath: 'core/modules/big_pipe/src/Controller/BigPipeController.php',
      language: 'php' as const,
      startLine: 5,
      endLine: 30,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'BigPipeController' ? [classNode] : []),
      getNodesInFile: () => [classNode, methodNode],
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: '\\Drupal\\big_pipe\\Controller\\BigPipeController:setNoJsCookie',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'big_pipe.routing.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('method:nojs1');
  });

  it('resolves a plugin base-class FQCN to the class node', () => {
    const baseNode = {
      id: 'class:base1',
      kind: 'class' as const,
      name: 'BlockBase',
      qualifiedName: 'BlockBase',
      filePath: 'core/lib/Drupal/Core/Block/BlockBase.php',
      language: 'php' as const,
      startLine: 1,
      endLine: 100,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'BlockBase' ? [baseNode] : []),
    });
    const ref = {
      fromNodeId: 'class:plugin1',
      referenceName: '\\Drupal\\Core\\Block\\BlockBase',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule/src/Plugin/Block/MyBlock.php',
      language: 'php' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:base1');
    expect(resolved!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('resolves an event-subscriber class FQCN to the subscriber class', () => {
    const subNode = {
      id: 'class:sub1',
      kind: 'class' as const,
      name: 'MySubscriber',
      qualifiedName: 'MySubscriber',
      filePath: 'mymodule/src/EventSubscriber/MySubscriber.php',
      language: 'php' as const,
      startLine: 1,
      endLine: 40,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'MySubscriber' ? [subNode] : []),
    });
    const ref = {
      fromNodeId: 'drupal-service:x',
      referenceName: 'Drupal\\mymodule\\EventSubscriber\\MySubscriber',
      referenceKind: 'references' as const,
      line: 2,
      column: 0,
      filePath: 'mymodule/mymodule.services.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:sub1');
  });

  it('claims canonical drupal:plugin: references', () => {
    expect(drupalResolver.claimsReference!('drupal:plugin:Block')).toBe(true);
    expect(drupalResolver.claimsReference!('drupal:plugin:ViewsField')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end integration test
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Drupal end-to-end — route node linked to controller method', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route→controller edge from routing.yml to PHP class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-'));

    // Minimal composer.json to trigger Drupal detection
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );

    // Module directory structure
    const modDir = path.join(tmpDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(path.join(modDir, 'src', 'Controller'), { recursive: true });

    // routing.yml
    fs.writeFileSync(
      path.join(modDir, 'my_module.routing.yml'),
      [
        'my_module.hello:',
        "  path: '/hello'",
        '  defaults:',
        "    _controller: '\\Drupal\\my_module\\Controller\\HelloController::build'",
        "    _title: 'Hello'",
        '  requirements:',
        "    _permission: 'access content'",
      ].join('\n') + '\n',
    );

    // PHP controller
    fs.writeFileSync(
      path.join(modDir, 'src', 'Controller', 'HelloController.php'),
      [
        '<?php',
        'namespace Drupal\\my_module\\Controller;',
        'use Drupal\\Core\\Controller\\ControllerBase;',
        'class HelloController extends ControllerBase {',
        '  public function build() {',
        "    return ['#markup' => 'Hello'];",
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node must exist
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name.includes('/hello'));
    expect(route).toBeDefined();

    // Controller method must be indexed
    const methods = cg.getNodesByKind('method');
    const buildMethod = methods.find((n) => n.name === 'build');
    expect(buildMethod).toBeDefined();

    // Edge: route → build method (or class fallback)
    const edges = cg.getOutgoingEdges(route!.id);
    expect(edges.length).toBeGreaterThan(0);

    cg.close();
  });

  it('creates an event-subscriber component → class edge and indexes OOP hooks/plugins', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-svc-'));

    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );

    const modDir = path.join(tmpDir, 'web', 'modules', 'custom', 'my_module');
    const subDir = path.join(modDir, 'src', 'EventSubscriber');
    const hookDir = path.join(modDir, 'src', 'Hook');
    const blockDir = path.join(modDir, 'src', 'Plugin', 'Block');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(blockDir, { recursive: true });

    // services.yml with one event subscriber.
    fs.writeFileSync(
      path.join(modDir, 'my_module.services.yml'),
      [
        'services:',
        '  my_module.event_subscriber:',
        '    class: Drupal\\my_module\\EventSubscriber\\MySubscriber',
        '    tags:',
        '      - { name: event_subscriber }',
      ].join('\n') + '\n',
    );

    // Subscriber class.
    fs.writeFileSync(
      path.join(subDir, 'MySubscriber.php'),
      [
        '<?php',
        'namespace Drupal\\my_module\\EventSubscriber;',
        'use Symfony\\Component\\EventDispatcher\\EventSubscriberInterface;',
        'class MySubscriber implements EventSubscriberInterface {',
        '  public static function getSubscribedEvents() { return []; }',
        '}',
      ].join('\n') + '\n',
    );

    // OOP hook + plugin attribute classes.
    fs.writeFileSync(
      path.join(hookDir, 'CronHandler.php'),
      [
        '<?php',
        'namespace Drupal\\my_module\\Hook;',
        '#[Hook(\'cron\')]',
        'class CronHandler {',
        '  public function __invoke(): void {}',
        '}',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(blockDir, 'MyBlock.php'),
      [
        '<?php',
        'namespace Drupal\\my_module\\Plugin\\Block;',
        'use Drupal\\Core\\Block\\BlockBase;',
        '#[Block(id: \'my_block\')]',
        'class MyBlock extends BlockBase {}',
      ].join('\n') + '\n',
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Event-subscriber component node exists.
    const components = cg.getNodesByKind('component');
    expect(components.length).toBeGreaterThan(0);
    const subscriber = components.find((n) => n.name === 'my_module.event_subscriber');
    expect(subscriber).toBeDefined();

    // Component → subscriber class edge exists.
    const compEdges = cg.getOutgoingEdges(subscriber!.id).filter((e) => e.kind === 'references');
    const reachesClass = compEdges.some((e) => cg.getNode(e.target)?.kind === 'class');
    expect(reachesClass).toBe(true);

    // OOP hook method and plugin class are indexed.
    const methods = cg.getNodesByKind('method');
    expect(methods.some((n) => n.name === '__invoke')).toBe(true);
    const classes = cg.getNodesByKind('class');
    expect(classes.some((n) => n.name === 'MyBlock')).toBe(true);
    expect(classes.some((n) => n.name === 'CronHandler')).toBe(true);

    cg.close();
  });
});
