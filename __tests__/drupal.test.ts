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
