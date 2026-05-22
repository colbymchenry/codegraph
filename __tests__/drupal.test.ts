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
    const { nodes } = drupalResolver.extract!(
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
});

// ---------------------------------------------------------------------------
// extract() — #[Hook] attribute detection (OOP hooks, Drupal 10.2+)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — #[Hook] attribute (OOP hooks)', () => {
  it('detects a hook implemented as a class method via #[Hook] attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule;

class MyModuleHooks {
  #[Hook('entity_presave')]
  public function entityPresave(EntityInterface $entity): void {
    // ...
  }
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyModuleHooks.php',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_entity_presave');
    expect(hookRef).toBeDefined();
    expect(hookRef!.referenceKind).toBe('references');
  });

  it('detects multiple OOP hooks in the same class', () => {
    const src = `<?php
class MyHooks {
  #[Hook('form_alter')]
  public function formAlter(&$form, $form_state, $form_id): void {}

  #[Hook('node_presave')]
  public function nodePresave($node): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyHooks.php',
      src,
    );
    const hookNames = references.map((r) => r.referenceName);
    expect(hookNames).toContain('hook_form_alter');
    expect(hookNames).toContain('hook_node_presave');
  });

  it('handles stacked attributes — preserves #[Hook] when another attribute follows', () => {
    const src = `<?php
class MyHooks {
  #[Hook('user_login')]
  #[SomeOtherAttribute]
  public function userLogin($account): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyHooks.php',
      src,
    );
    const hookRef = references.find((r) => r.referenceName === 'hook_user_login');
    expect(hookRef).toBeDefined();
  });

  it('emits refs for ALL hooks when multiple #[Hook] are stacked on one method', () => {
    const src = `<?php
class MyHooks {
  #[Hook('comment_insert')]
  #[Hook('comment_update')]
  public function commentSave(CommentInterface $comment): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyHooks.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'hook_comment_insert')).toBeDefined();
    expect(references.find((r) => r.referenceName === 'hook_comment_update')).toBeDefined();
  });

  it('detects class-level #[Hook] with method: parameter', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Hook;

#[Hook('form_alter', method: 'formAlter')]
class FormHooks {
  public function formAlter(array &$form, FormStateInterface $form_state, string $form_id): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hook/FormHooks.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'hook_form_alter')).toBeDefined();
  });

  it('detects class-level #[Hook] targeting __invoke()', () => {
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
    expect(references.find((r) => r.referenceName === 'hook_cron')).toBeDefined();
  });

  it('detects multiple class-level #[Hook] attributes stacked on a class', () => {
    const src = `<?php
#[Hook('node_insert', method: 'onSave')]
#[Hook('node_update', method: 'onSave')]
class NodeSaveHooks {
  public function onSave(NodeInterface $node): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hook/NodeSaveHooks.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'hook_node_insert')).toBeDefined();
    expect(references.find((r) => r.referenceName === 'hook_node_update')).toBeDefined();
  });

  it('handles blank line between #[Hook] and method definition', () => {
    const src = `<?php
class MyHooks {
  #[Hook('cron')]

  public function cron(): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyHooks.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'hook_cron')).toBeDefined();
  });

  it('detects OOP hook in a plain .php file (not just .module)', () => {
    const src = `<?php
class Hooks {
  #[Hook('views_data')]
  public static function viewsData(): array { return []; }
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Hooks.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'hook_views_data')).toBeDefined();
  });

  it('does not emit a hook ref for #[Hook] without a following function', () => {
    const src = `<?php
// Incomplete — attribute with no method
class Broken {
  #[Hook('missing')]
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Broken.php',
      src,
    );
    expect(references.filter((r) => r.referenceName === 'hook_missing')).toHaveLength(0);
  });

  it('does not confuse #[Hook] with other #[] attributes on classes', () => {
    const src = `<?php
#[SomeClassAttribute]
class MyClass {
  public function doSomething(): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyClass.php',
      src,
    );
    // No hook refs should be emitted for class-level attributes
    expect(references.filter((r) => r.referenceName.startsWith('hook_'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extract() — plugin annotation detection (pre-10.2 docblock style)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — plugin annotations (@PluginType)', () => {
  it('detects a Block plugin via docblock annotation', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Block;

use Drupal\\Core\\Block\\BlockBase;

/**
 * Provides a custom block.
 *
 * @Block(
 *   id = "my_custom_block",
 *   admin_label = @Translation("My Custom Block"),
 * )
 */
class MyCustomBlock extends BlockBase {
  public function build() { return []; }
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Block/MyCustomBlock.php',
      src,
    );
    const pluginRef = references.find((r) => r.referenceName === 'drupal:plugin:Block');
    expect(pluginRef).toBeDefined();
    expect(pluginRef!.referenceKind).toBe('decorates');
  });

  it('detects a QueueWorker plugin via docblock annotation', () => {
    const src = `<?php
/**
 * @QueueWorker(
 *   id = "mymodule_import",
 *   title = @Translation("Import"),
 *   cron = {"time" = 60}
 * )
 */
class ImportWorker extends QueueWorkerBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/QueueWorker/ImportWorker.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:QueueWorker')).toBeDefined();
  });

  it('detects a Filter plugin via docblock annotation', () => {
    const src = `<?php
/**
 * @Filter(
 *   id = "mymodule_filter",
 *   title = @Translation("My filter"),
 *   type = \Drupal\filter\Plugin\FilterInterface::TYPE_TRANSFORM_IRREVERSIBLE,
 * )
 */
class MyFilter extends FilterBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Filter/MyFilter.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:Filter')).toBeDefined();
  });

  it('does not emit a plugin ref for unrecognised docblock annotations', () => {
    const src = `<?php
/**
 * @param string $foo
 * @return array
 * @deprecated Use something else.
 */
class NotAPlugin {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/NotAPlugin.php',
      src,
    );
    expect(references.filter((r) => r.referenceName.startsWith('drupal:plugin:'))).toHaveLength(0);
  });

  it('does not emit duplicate plugin refs when annotation is inside a long docblock', () => {
    const src = `<?php
/**
 * My block plugin.
 *
 * This is a long description.
 *
 * @Block(
 *   id = "my_block",
 * )
 */
class MyBlock extends BlockBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Block/MyBlock.php',
      src,
    );
    const pluginRefs = references.filter((r) => r.referenceName === 'drupal:plugin:Block');
    expect(pluginRefs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extract() — PHP 8 attribute-style plugin detection (Drupal 10.2+)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — PHP 8 attribute-style plugins (#[PluginType])', () => {
  it('detects a Block plugin via PHP 8 attribute', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Plugin\\Block;

use Drupal\\Core\\Block\\BlockBase;
use Drupal\\Core\\StringTranslation\\TranslatableMarkup;

#[Block(
  id: 'my_custom_block',
  admin_label: new TranslatableMarkup('My Custom Block'),
)]
class MyCustomBlock extends BlockBase {
  public function build(): array { return []; }
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Block/MyCustomBlock.php',
      src,
    );
    const pluginRef = references.find((r) => r.referenceName === 'drupal:plugin:Block');
    expect(pluginRef).toBeDefined();
    expect(pluginRef!.referenceKind).toBe('decorates');
  });

  it('detects an Action plugin via PHP 8 attribute', () => {
    const src = `<?php
#[Action(
  id: 'mymodule_publish_node',
  label: new TranslatableMarkup('Publish node'),
  type: 'node',
)]
class PublishNode extends ActionBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Action/PublishNode.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:Action')).toBeDefined();
  });

  it('handles PHP 8 attribute on a single line', () => {
    const src = `<?php
#[Block(id: 'simple', admin_label: new TranslatableMarkup('Simple'))]
class SimpleBlock extends BlockBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Block/SimpleBlock.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:Block')).toBeDefined();
  });

  it('does not confuse PHP 8 hook attributes with plugin attributes', () => {
    const src = `<?php
class MyHooks {
  #[Hook('entity_presave')]
  public function entityPresave(): void {}
}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/MyHooks.php',
      src,
    );
    // Should have a hook ref but NO plugin ref
    expect(references.find((r) => r.referenceName === 'hook_entity_presave')).toBeDefined();
    expect(references.filter((r) => r.referenceName.startsWith('drupal:plugin:'))).toHaveLength(0);
  });

  it('detects ContentEntityType plugin (Drupal 11.1+ entity definition)', () => {
    const src = `<?php
namespace Drupal\\mymodule\\Entity;

use Drupal\\Core\\Entity\\ContentEntityBase;

#[ContentEntityType(
  id: 'my_entity',
  label: new TranslatableMarkup('My Entity'),
  base_table: 'my_entity',
)]
class MyEntity extends ContentEntityBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Entity/MyEntity.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:ContentEntityType')).toBeDefined();
  });

  it('detects RestResource plugin', () => {
    const src = `<?php
#[RestResource(
  id: 'my_resource',
  label: new TranslatableMarkup('My Resource'),
  uri_paths: ['canonical' => '/api/my-resource'],
)]
class MyResource extends ResourceBase {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/rest/resource/MyResource.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:RestResource')).toBeDefined();
  });

  it('detects Layout plugin via docblock annotation', () => {
    const src = `<?php
/**
 * @Layout(
 *   id = "my_layout",
 *   label = @Translation("My Layout"),
 *   category = @Translation("Custom"),
 *   template = "templates/my-layout",
 *   regions = {
 *     "main" = {"label" = @Translation("Main")}
 *   }
 * )
 */
class MyLayout extends LayoutDefault {}
`;
    const { references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/src/Plugin/Layout/MyLayout.php',
      src,
    );
    expect(references.find((r) => r.referenceName === 'drupal:plugin:Layout')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// extract() — Symfony event subscriber detection (*.services.yml)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — event subscribers (*.services.yml)', () => {
  it('emits a component node and references edge for an event_subscriber service', () => {
    const src = `
services:
  mymodule.event_subscriber:
    class: Drupal\\mymodule\\EventSubscriber\\MyEventSubscriber
    tags:
      - { name: event_subscriber }
`;
    const { nodes, references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('component');
    expect(nodes[0]!.name).toBe('mymodule.event_subscriber');
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe(
      'Drupal\\mymodule\\EventSubscriber\\MyEventSubscriber',
    );
    expect(references[0]!.referenceKind).toBe('references');
  });

  it('handles multiple event subscribers in one services.yml', () => {
    const src = `
services:
  mymodule.subscriber_a:
    class: Drupal\\mymodule\\EventSubscriber\\SubscriberA
    tags:
      - { name: event_subscriber }

  mymodule.subscriber_b:
    class: Drupal\\mymodule\\EventSubscriber\\SubscriberB
    tags:
      - { name: event_subscriber }
`;
    const { nodes } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name)).toContain('mymodule.subscriber_a');
    expect(nodes.map((n) => n.name)).toContain('mymodule.subscriber_b');
  });

  it('ignores services that are not tagged event_subscriber', () => {
    const src = `
services:
  mymodule.some_service:
    class: Drupal\\mymodule\\SomeService
    tags:
      - { name: cache_context }

  mymodule.subscriber:
    class: Drupal\\mymodule\\EventSubscriber\\Sub
    tags:
      - { name: event_subscriber }
`;
    const { nodes } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('mymodule.subscriber');
  });

  it('ignores services without a class key', () => {
    const src = `
services:
  mymodule.abstract_subscriber:
    abstract: true
    tags:
      - { name: event_subscriber }
`;
    const { nodes } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(0);
  });

  it('returns empty results for a routing.yml passed as services.yml', () => {
    const src = `
mymodule.page:
  path: '/page'
  defaults:
    _controller: '\\Drupal\\mymodule\\Controller\\PageController::build'
`;
    const { nodes, references } = drupalResolver.extract!(
      'web/modules/custom/mymodule/mymodule.services.yml',
      src,
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolve() — plugin and event subscriber resolution
// ---------------------------------------------------------------------------

describe('drupalResolver.resolve — plugin and subscriber resolution', () => {
  it('resolves drupal:plugin:Block to a BlockBase class when indexed', () => {
    const blockBase = {
      id: 'class:blockbase',
      kind: 'class' as const,
      name: 'BlockBase',
      qualifiedName: 'Drupal\\Core\\Block\\BlockBase',
      filePath: 'core/lib/Drupal/Core/Block/BlockBase.php',
      language: 'php' as const,
      startLine: 1, endLine: 100, startColumn: 0, endColumn: 0, updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'BlockBase' ? [blockBase] : []),
    });
    const ref = {
      fromNodeId: 'class:myplugin',
      referenceName: 'drupal:plugin:Block',
      referenceKind: 'decorates' as const,
      line: 10, column: 0,
      filePath: 'mymodule/src/Plugin/Block/MyBlock.php',
      language: 'php' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:blockbase');
    expect(resolved!.confidence).toBeGreaterThan(0.5);
  });

  it('returns null for drupal:plugin:Block when no base class is indexed', () => {
    const ctx = makeContext({ getNodesByName: () => [], getNodesByKind: () => [] });
    const ref = {
      fromNodeId: 'class:myplugin',
      referenceName: 'drupal:plugin:Block',
      referenceKind: 'decorates' as const,
      line: 10, column: 0,
      filePath: 'mymodule/src/Plugin/Block/MyBlock.php',
      language: 'php' as const,
    };
    expect(drupalResolver.resolve(ref, ctx)).toBeNull();
  });

  it('resolves an event subscriber FQCN to the PHP class node', () => {
    const subscriberClass = {
      id: 'class:subscriber',
      kind: 'class' as const,
      name: 'MyEventSubscriber',
      qualifiedName: 'Drupal\\mymodule\\EventSubscriber\\MyEventSubscriber',
      filePath: 'web/modules/custom/mymodule/src/EventSubscriber/MyEventSubscriber.php',
      language: 'php' as const,
      startLine: 1, endLine: 50, startColumn: 0, endColumn: 0, updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'MyEventSubscriber' ? [subscriberClass] : []),
    });
    const ref = {
      fromNodeId: 'component:services',
      referenceName: 'Drupal\\mymodule\\EventSubscriber\\MyEventSubscriber',
      referenceKind: 'references' as const,
      line: 3, column: 0,
      filePath: 'mymodule.services.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:subscriber');
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
});
