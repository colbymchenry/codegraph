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
});

// ---------------------------------------------------------------------------
// extract() — services.yml (DI container wiring)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — services.yml', () => {
  const services = `
services:

  # A custom service.
  weller_localization.domain_alias:
    class: Drupal\\weller_localization\\DomainAlias
    arguments: [ '@domain.negotiator' ]

  # Overrides a core service.
  path_alias.manager:
    class: Drupal\\weller_localization\\AliasManager
    arguments: ['@path_alias.repository', '@language_manager']
    tags:
      - { name: backend_overridable }
`;

  it('emits a component node for each service id', () => {
    const { nodes } = drupalResolver.extract!(
      'weller_localization/weller_localization.services.yml',
      services,
    );
    const names = nodes.map((n) => n.name);
    expect(names).toContain('weller_localization.domain_alias');
    expect(names).toContain('path_alias.manager');
    expect(nodes.every((n) => n.kind === 'component')).toBe(true);
  });

  it('sets qualifiedName to filePath::service:<id>', () => {
    const { nodes } = drupalResolver.extract!(
      'weller_localization/weller_localization.services.yml',
      services,
    );
    const node = nodes.find((n) => n.name === 'weller_localization.domain_alias');
    expect(node!.qualifiedName).toBe(
      'weller_localization/weller_localization.services.yml::service:weller_localization.domain_alias',
    );
  });

  it('emits a references edge from the service to its class FQCN', () => {
    const { nodes, references } = drupalResolver.extract!(
      'weller_localization/weller_localization.services.yml',
      services,
    );
    const svc = nodes.find((n) => n.name === 'weller_localization.domain_alias')!;
    const classRef = references.find(
      (r) => r.fromNodeId === svc.id && r.referenceName === 'Drupal\\weller_localization\\DomainAlias',
    );
    expect(classRef).toBeDefined();
    expect(classRef!.referenceKind).toBe('references');
  });

  it('emits service→service references for @arguments', () => {
    const { nodes, references } = drupalResolver.extract!(
      'weller_localization/weller_localization.services.yml',
      services,
    );
    const svc = nodes.find((n) => n.name === 'path_alias.manager')!;
    const argRefs = references.filter((r) => r.fromNodeId === svc.id);
    const argNames = argRefs.map((r) => r.referenceName);
    // class ref + the two @service args (without the @)
    expect(argNames).toContain('path_alias.repository');
    expect(argNames).toContain('language_manager');
  });

  it('does not treat the top-level "services" key as a service id', () => {
    const { nodes } = drupalResolver.extract!('m/m.services.yml', services);
    expect(nodes.map((n) => n.name)).not.toContain('services');
  });

  it('returns empty result for a services.yml with no services', () => {
    const { nodes, references } = drupalResolver.extract!(
      'm/m.services.yml',
      'services:\n',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

describe('drupalResolver.resolve — services', () => {
  it('resolves a bare service-class FQCN to the class node', () => {
    const classNode = {
      id: 'class:da',
      kind: 'class' as const,
      name: 'DomainAlias',
      qualifiedName: 'DomainAlias',
      filePath: 'weller_localization/src/DomainAlias.php',
      language: 'php' as const,
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'DomainAlias' ? [classNode] : []),
    });
    const ref = {
      fromNodeId: 'service:x',
      referenceName: 'Drupal\\weller_localization\\DomainAlias',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'weller_localization/weller_localization.services.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('class:da');
  });

  it('resolves a service-argument id to the referenced service node', () => {
    const svcNode = {
      id: 'component:svc-repo',
      kind: 'component' as const,
      name: 'path_alias.repository',
      qualifiedName: 'm/m.services.yml::service:path_alias.repository',
      filePath: 'm/m.services.yml',
      language: 'yaml' as const,
      startLine: 3,
      endLine: 3,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'path_alias.repository' ? [svcNode] : []),
    });
    const ref = {
      fromNodeId: 'component:svc-mgr',
      referenceName: 'path_alias.repository',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'm/m.services.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('component:svc-repo');
  });
});

// ---------------------------------------------------------------------------
// extract()/resolve() — services.yml edge cases (code-review regressions)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — services.yml edge cases', () => {
  it('parses @service arguments written as a multi-line block list', () => {
    const src = `
services:
  my.service:
    class: Drupal\\my\\Service
    arguments:
      - '@path_alias.repository'
      - '@language_manager'
`;
    const { nodes, references } = drupalResolver.extract!('m/m.services.yml', src);
    const svc = nodes.find((n) => n.name === 'my.service')!;
    const argNames = references.filter((r) => r.fromNodeId === svc.id).map((r) => r.referenceName);
    expect(argNames).toContain('path_alias.repository');
    expect(argNames).toContain('language_manager');
  });

  it('ignores Symfony/Drupal DI directive keys (_defaults, _instanceof)', () => {
    const src = `
services:
  _defaults:
    autowire: true
  _instanceof:
    Drupal\\Foo: ~
  my.service:
    class: Drupal\\my\\Service
`;
    const { nodes } = drupalResolver.extract!('m/m.services.yml', src);
    const names = nodes.map((n) => n.name);
    expect(names).toContain('my.service');
    expect(names).not.toContain('_defaults');
    expect(names).not.toContain('_instanceof');
  });

  it('recognizes a service id that carries a trailing comment', () => {
    const src = `
services:
  my.service: # the main service
    class: Drupal\\my\\Service
`;
    const { nodes } = drupalResolver.extract!('m/m.services.yml', src);
    expect(nodes.map((n) => n.name)).toContain('my.service');
  });

  it('does not capture @tokens from a trailing comment on the arguments line', () => {
    const src = `
services:
  my.service:
    class: Drupal\\my\\Service
    arguments: ['@real.dep'] # see @bogus.from.comment
`;
    const { nodes, references } = drupalResolver.extract!('m/m.services.yml', src);
    const svc = nodes.find((n) => n.name === 'my.service')!;
    const argNames = references.filter((r) => r.fromNodeId === svc.id).map((r) => r.referenceName);
    expect(argNames).toContain('real.dep');
    expect(argNames).not.toContain('bogus.from.comment');
  });
});

describe('drupalResolver.resolve — services edge cases', () => {
  const svcNode = {
    id: 'component:svc-db',
    kind: 'component' as const,
    name: 'database',
    qualifiedName: 'm/m.services.yml::service:database',
    filePath: 'm/m.services.yml',
    language: 'yaml' as const,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };

  it('resolves a dotless core-service argument id (e.g. "database")', () => {
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'database' ? [svcNode] : []),
    });
    const ref = {
      fromNodeId: 'component:caller',
      referenceName: 'database',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'm/m.services.yml',
      language: 'yaml' as const,
    };
    const resolved = drupalResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('component:svc-db');
  });

  it('does NOT hijack a dotted entity-handler route ref to a same-named service', () => {
    // A route's `_entity_form: node.default` previously stayed unresolved; it must not
    // now mis-resolve to a DI service component that happens to share the dotted name.
    const svc = { ...svcNode, id: 'component:nd', name: 'node.default', qualifiedName: 'm/m.services.yml::service:node.default' };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'node.default' ? [svc] : []),
    });
    const ref = {
      fromNodeId: 'route:x',
      referenceName: 'node.default',
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'mymodule/mymodule.routing.yml', // NOT a services.yml
      language: 'yaml' as const,
    };
    expect(drupalResolver.resolve(ref, ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extract() — plugin definitions (PHP 8 attributes + legacy annotations)
// ---------------------------------------------------------------------------

describe('drupalResolver.extract — plugin attributes (Drupal 11)', () => {
  it('emits a plugin component for a multi-line #[Block(...)] attribute', () => {
    const src = `<?php

namespace Drupal\\shortcut\\Plugin\\Block;

use Drupal\\Core\\Block\\BlockBase;

/**
 * Provides a 'Shortcut' block.
 */
#[Block(
  id: "shortcuts",
  admin_label: new TranslatableMarkup("Shortcuts"),
  category: new TranslatableMarkup("Menus")
)]
class ShortcutsBlock extends BlockBase {
}
`;
    const { nodes, references } = drupalResolver.extract!(
      'shortcut/src/Plugin/Block/ShortcutsBlock.php',
      src,
    );
    const plugin = nodes.find((n) => n.name === 'shortcuts');
    expect(plugin).toBeDefined();
    expect(plugin!.kind).toBe('component');
    expect(plugin!.qualifiedName).toContain('plugin:Block:shortcuts');
    // references edge plugin → annotated class
    const ref = references.find(
      (r) => r.fromNodeId === plugin!.id && r.referenceName === 'ShortcutsBlock',
    );
    expect(ref).toBeDefined();
  });

  it('emits a plugin component for a single-line attribute with single quotes', () => {
    const src = `<?php
#[SectionStorage(id: 'layout_builder_test_state')]
class TestState {
}
`;
    const { nodes } = drupalResolver.extract!('m/src/Plugin/X/TestState.php', src);
    const plugin = nodes.find((n) => n.name === 'layout_builder_test_state');
    expect(plugin).toBeDefined();
    expect(plugin!.qualifiedName).toContain('plugin:SectionStorage:layout_builder_test_state');
  });

  it('emits a plugin component for a #[FieldType(...)] attribute', () => {
    const src = `<?php
#[FieldType(
  id: "list_string",
  label: new TranslatableMarkup("List (text)"),
)]
class ListStringItem {
}
`;
    const { nodes, references } = drupalResolver.extract!(
      'options/src/Plugin/Field/FieldType/ListStringItem.php',
      src,
    );
    const plugin = nodes.find((n) => n.name === 'list_string')!;
    expect(plugin.qualifiedName).toContain('plugin:FieldType:list_string');
    expect(
      references.some((r) => r.fromNodeId === plugin.id && r.referenceName === 'ListStringItem'),
    ).toBe(true);
  });

  it('ignores non-plugin attributes like #[DataProvider(...)]', () => {
    const src = `<?php
class FooTest {
  #[DataProvider('provide')]
  public function testThing() {}
}
`;
    const { nodes } = drupalResolver.extract!('m/tests/FooTest.php', src);
    expect(nodes).toHaveLength(0);
  });
});

describe('drupalResolver.extract — plugin annotations (legacy)', () => {
  it('emits a plugin component for an @Block(...) annotation', () => {
    const src = `<?php

namespace Drupal\\weller_theme_components\\Plugin\\Block;

use Drupal\\Core\\Block\\BlockBase;

/**
 * Provides a 'Hero' block based on the basic page hero field.
 *
 * @Block(
 *   id = "weller_hero",
 *   admin_label = @Translation("Weller Hero"),
 * )
 */
class Hero extends BlockBase {
}
`;
    const { nodes, references } = drupalResolver.extract!(
      'weller_theme_components/src/Plugin/Block/Hero.php',
      src,
    );
    const plugin = nodes.find((n) => n.name === 'weller_hero');
    expect(plugin).toBeDefined();
    expect(plugin!.kind).toBe('component');
    expect(plugin!.qualifiedName).toContain('plugin:Block:weller_hero');
    expect(
      references.some((r) => r.fromNodeId === plugin!.id && r.referenceName === 'Hero'),
    ).toBe(true);
  });

  it('emits a plugin component for an @FieldType(...) annotation', () => {
    const src = `<?php
/**
 * Plugin implementation of the 'social_links_field' field type.
 *
 * @FieldType(
 *   id = "social_links_field",
 *   label = @Translation("Social Media Links Field"),
 *   default_widget = "social_links_field_default",
 * )
 */
class SocialMediaLinksFieldItem extends FieldItemBase {
}
`;
    const { nodes } = drupalResolver.extract!(
      'social_links_field/src/Plugin/Field/FieldType/SocialMediaLinksFieldItem.php',
      src,
    );
    const plugin = nodes.find((n) => n.name === 'social_links_field');
    expect(plugin).toBeDefined();
    expect(plugin!.qualifiedName).toContain('plugin:FieldType:social_links_field');
  });

  it('does not treat the nested @Translation() as a plugin', () => {
    const src = `<?php
/**
 * @Block(
 *   id = "weller_hero",
 *   admin_label = @Translation("Weller Hero"),
 * )
 */
class Hero {}
`;
    const { nodes } = drupalResolver.extract!('m/src/Plugin/Block/Hero.php', src);
    expect(nodes.map((n) => n.name)).not.toContain('Translation');
    expect(nodes).toHaveLength(1);
  });

  it('captures the id when it appears AFTER a nested annotation (label first)', () => {
    // Drupal core commonly orders `label = @Translation(...)` before `id = ...`.
    const src = `<?php
/**
 * @FieldType(
 *   label = @Translation("List (text)"),
 *   id = "list_string",
 * )
 */
class ListStringItem {}
`;
    const { nodes } = drupalResolver.extract!(
      'options/src/Plugin/Field/FieldType/ListStringItem.php',
      src,
    );
    const plugin = nodes.find((n) => n.name === 'list_string');
    expect(plugin).toBeDefined();
    expect(plugin!.qualifiedName).toContain('plugin:FieldType:list_string');
  });

  it('does not bind a stray plugin-type token to a far-away class', () => {
    // A plugin-shaped token deep in a method body, with the next class far below it,
    // must not produce a plugin edge (the proximity bound rejects the distant class).
    const filler = '\n    // padding padding padding padding padding padding\n'.repeat(20);
    const src = `<?php
class Helper {
  public function describe() {
    $msg = 'mentions @Block(id = "fake")';${filler}
    return $msg;
  }
}

class UnrelatedLater {}
`;
    const { nodes } = drupalResolver.extract!('m/src/Helper.php', src);
    expect(nodes).toHaveLength(0);
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
