import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Node } from '../src/types';
import { symfonyResolver } from '../src/resolution/frameworks/symfony';

// The Symfony #[Route] extractor reads the PHP AST
beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['php']);
});

describe('symfonyResolver.extract — PHP 8 attributes', () => {
  it('extracts route from #[Route] attribute with path and method', () => {
    const src = `<?php
#[Route('/blog')]
class BlogController {
    #[Route('/', name: 'blog_index', methods: ['GET'])]
    public function index(): Response {
        return \$this->render('blog/index.html.twig');
    }
}
`;
    const { nodes, references } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /blog/');
    expect(references[0].referenceName).toBe('index');
    expect(references[0].referenceKind).toBe('references');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('joins class-level #[Route] prefix with method path', () => {
    const src = `<?php
#[Route('/admin/post')]
class BlogController {
    #[Route('/', name: 'admin_index', methods: ['GET'])]
    public function index(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/Admin/BlogController.php', src);
    expect(nodes[0].name).toBe('GET /admin/post/');
  });

  it('extracts multiple routes per controller with distinct paths', () => {
    const src = `<?php
#[Route('/blog')]
class BlogController {
    #[Route('/{slug}', name: 'blog_post', methods: ['GET'])]
    public function postShow(): Response {}

    #[Route('/search', name: 'blog_search', methods: ['GET'])]
    public function search(): Response {}
}
`;
    const { nodes, references } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['GET /blog/{slug}', 'GET /blog/search']);
    expect(references.map(r => r.referenceName)).toEqual(['postShow', 'search']);
  });

  it('defaults method to ANY when no methods attribute specified', () => {
    const src = `<?php
#[Route('/login')]
class SecurityController {
    #[Route('/login', name: 'security_login')]
    public function login(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/SecurityController.php', src);
    expect(nodes[0].name).toBe('ANY /login/login');
  });

  it('handles multiple HTTP methods', () => {
    const src = `<?php
#[Route('/admin/post')]
class BlogController {
    #[Route('/new', name: 'admin_post_new', methods: ['GET', 'POST'])]
    public function new(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/Admin/BlogController.php', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['GET /admin/post/new', 'POST /admin/post/new']);
  });

  it('extracts with no class-level prefix (bare #[Route] on methods)', () => {
    const src = `<?php
class DefaultController {
    #[Route('/', name: 'homepage')]
    public function index(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/DefaultController.php', src);
    expect(nodes[0].name).toBe('ANY /');
  });

  it('handles methods: with PHP constant refs like Request::METHOD_GET', () => {
    const src = `<?php
#[Route('/api')]
class ApiController {
    #[Route('/entries', name: 'api_entries', methods: [Request::METHOD_GET])]
    public function list(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/ApiController.php', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /api/entries');
  });

  it('handles mixed methods: with strings and PHP constants', () => {
    const src = `<?php
#[Route('/api')]
class MixedController {
    #[Route('/items/{id}', name: 'api_item', methods: ['GET', Request::METHOD_HEAD])]
    public function item(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/MixedController.php', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['GET /api/items/{id}', 'HEAD /api/items/{id}']);
  });
});

describe('symfonyResolver.detect', () => {
  const baseContext = {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/test',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };

  it('detects symfony/framework-bundle in composer.json require', () => {
    const context = {
      ...baseContext,
      readFile: (p: string) =>
        p === 'composer.json'
          ? JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
          : null,
    };
    expect(symfonyResolver.detect(context as any)).toBe(true);
  });

  it('detects a Shopware plugin, which requires only shopware/core and has no bin/console', () => {
    const context = {
      ...baseContext,
      readFile: (p: string) =>
        p === 'composer.json'
          ? JSON.stringify({ type: 'shopware-platform-plugin', require: { 'shopware/core': '~6.6.0' } })
          : null,
    };
    expect(symfonyResolver.detect(context as any)).toBe(true);
  });

  it('detects symfony/symfony in composer.json require-dev', () => {
    const context = {
      ...baseContext,
      readFile: (p: string) =>
        p === 'composer.json'
          ? JSON.stringify({ 'require-dev': { 'symfony/symfony': '^5.4' } })
          : null,
    };
    expect(symfonyResolver.detect(context as any)).toBe(true);
  });

  it('detects by bin/console + config/ fallback', () => {
    const context = {
      ...baseContext,
      fileExists: (p: string) => p === 'bin/console' || p === 'config/',
    };
    expect(symfonyResolver.detect(context as any)).toBe(true);
  });

  it('returns false for non-Symfony project', () => {
    const context = {
      ...baseContext,
      readFile: (p: string) =>
        p === 'composer.json'
          ? JSON.stringify({ require: { 'laravel/framework': '^10.0' } })
          : null,
    };
    expect(symfonyResolver.detect(context as any)).toBe(false);
  });
});

describe('symfonyResolver.resolve', () => {
  const baseContext = {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/test',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };

  it('resolves Controller::method reference', () => {
    const classNode: Node = {
      id: 'class:src/Controller/BlogController.php:10:BlogController:50',
      kind: 'class',
      name: 'BlogController',
      qualifiedName: 'App\\Controller::BlogController',
      filePath: 'src/Controller/BlogController.php',
      language: 'php',
      startLine: 10,
      endLine: 60,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const methodNode: Node = {
      id: 'method:src/Controller/BlogController.php:50:index:50',
      kind: 'method',
      name: 'index',
      qualifiedName: 'src/Controller/BlogController.php::index',
      filePath: 'src/Controller/BlogController.php',
      language: 'php',
      startLine: 50,
      endLine: 50,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const context = {
      ...baseContext,
      fileExists: (p: string) => p === 'src/Controller/BlogController.php',
      getNodesInFile: (p: string) => p === 'src/Controller/BlogController.php' ? [methodNode] : [],
      getNodesByName: (name: string) => name === 'BlogController' ? [classNode] : [],
      // The class comes from the name index; scanning every class is not needed.
      getNodesByKind: () => { throw new Error('getNodesByKind must not be called'); },
    };
    const ref = {
      fromNodeId: 'route:config/routes.yaml:15:GET:/blog',
      referenceName: 'App\\Controller\\BlogController::index',
      referenceKind: 'references' as const,
      line: 15,
      column: 0,
      filePath: 'config/routes.yaml',
      language: 'yaml' as const,
    };
    const result = symfonyResolver.resolve(ref, context as any);
    expect(result?.targetNodeId).toBe(methodNode.id);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result?.resolvedBy).toBe('framework');
  });

  it('leaves a FQCN unresolved when only another namespace has a class of that name', () => {
    const other: Node = {
      id: 'class:src/Other/Logger.php:3:Logger:0',
      kind: 'class',
      name: 'Logger',
      qualifiedName: 'Other::Logger',
      filePath: 'src/Other/Logger.php',
      language: 'php',
      startLine: 3,
      endLine: 9,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const context = { ...baseContext, getNodesByName: (name: string) => (name === 'Logger' ? [other] : []) };
    const ref = {
      fromNodeId: 'file:config/services.yaml',
      referenceName: 'External\\Logger',
      referenceKind: 'references' as const,
      line: 3,
      column: 0,
      filePath: 'config/services.yaml',
      language: 'yaml' as const,
    };
    expect(symfonyResolver.resolve(ref, context as any)).toBeNull();
    expect(symfonyResolver.resolve({ ...ref, referenceName: 'Other\\Logger' }, context as any)?.targetNodeId).toBe(other.id);
  });

  it('returns null for unresolvable reference', () => {
    const ref = {
      fromNodeId: 'x',
      referenceName: 'SomeNonExistentClass::method',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'a.yaml',
      language: 'yaml' as const,
    };
    expect(symfonyResolver.resolve(ref, baseContext as any)).toBeNull();
  });
});

describe('symfonyResolver.extract — YAML routes', () => {
  it('extracts route from YAML config with controller reference', () => {
    const src = `homepage:
    path: /
    controller: Symfony\\Bundle\\FrameworkBundle\\Controller\\TemplateController::templateAction
    defaults:
        template: default/homepage.html.twig
`;
    const { nodes, references } = symfonyResolver.extract!('config/routes.yaml', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('ANY /');
    expect(references[0].referenceName).toBe('Symfony\\Bundle\\FrameworkBundle\\Controller\\TemplateController::templateAction');
  });

  it('extracts YAML route with methods specified', () => {
    const src = `api_index:
    path: /api
    controller: App\\Controller\\ApiController::index
    methods: [GET, POST]
`;
    const { nodes, references } = symfonyResolver.extract!('config/routes/api.yaml', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['GET /api', 'POST /api']);
    expect(references[0].referenceName).toBe('App\\Controller\\ApiController::index');
  });

  it('returns empty for non-route YAML files', () => {
    const src = `framework:
    secret: '%env(APP_SECRET)%'
    test: true
`;
    const { nodes, references } = symfonyResolver.extract!('config/packages/framework.yaml', src);
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });
});

describe('symfonyResolver — comment stripping regression', () => {
  it('skips commented-out #[Route] attributes', () => {
    const src = `<?php
class TestController {
    // #[Route('/fake', name: 'fake')]
    // public function fake(): Response {}

    /* #[Route('/also-fake')]
    public function alsoFake(): Response {} */

    #[Route('/real', name: 'real', methods: ['GET'])]
    public function real(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/TestController.php', src);
    expect(nodes.map(n => n.name)).toEqual(['GET /real']);
  });

  it('skips commented-out YAML routes', () => {
    const src = `# fake_route:
    #     path: /fake
    #     controller: App\\Controller\\FakeController::index

real_route:
    path: /real
    controller: App\\Controller\\RealController::index
`;
    const { nodes } = symfonyResolver.extract!('config/routes.yaml', src);
    expect(nodes.map(n => n.name)).toEqual(['ANY /real']);
  });
});

describe('symfonyResolver — DI container', () => {
  it('extracts services from compiled container PHP', () => {
    const src = `<?php
class Container_XYZ extends Container
{
    protected function getDoctrineService(): \\Doctrine\\ORM\\EntityManager
    {
        return \$this->privates['doctrine'] ?? \$this->load('getDoctrineService');
    }

    protected function getBlogRepositoryService(): \\App\\Repository\\BlogRepository
    {
        return new \\App\\Repository\\BlogRepository(\$this->getDoctrineService());
    }
}
`;
    const { nodes, references } = symfonyResolver.extract!('var/cache/dev/Container_XYZ.php', src);
    const svcNames = nodes.filter(n => n.kind === 'variable').map(n => n.name);
    expect(svcNames).toContain('Doctrine');
    expect(svcNames).toContain('BlogRepository');
    const fqcns = references.map(r => r.referenceName);
    expect(fqcns).toContain('\\Doctrine\\ORM\\EntityManager');
    expect(fqcns).toContain('\\App\\Repository\\BlogRepository');
  });

  it('extracts service references from config/services.yaml', () => {
    const src = `services:
    App\\Repository\\PostRepository:
        arguments:
            - '@doctrine'

    App\\Service\\MailerService:
        autowire: true
`;
    const { references } = symfonyResolver.extract!('config/services.yaml', src);
    const fqcns = references.map(r => r.referenceName);
    expect(fqcns).toContain('App\\Repository\\PostRepository');
    expect(fqcns).toContain('App\\Service\\MailerService');
  });
});

describe('symfonyResolver.extract — Phase 2.6 attribute params', () => {
  function parseMeta(nodes: any[]): Record<string, unknown> | null {
    const sig = nodes[0]?.signature;
    return sig ? JSON.parse(sig) : null;
  }

  it('extracts defaults from #[Route] and stores as signature', () => {
    const src = `<?php
#[Route('/blog')]
class BlogController {
    #[Route('/{page}', name: 'blog_page', defaults: ['page' => 1])]
    public function page(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    const meta = parseMeta(nodes);
    expect(meta).not.toBeNull();
    expect(meta!.defaults).toEqual({ page: '1' });
  });

  it('extracts requirements from #[Route] and stores as signature', () => {
    const src = `<?php
#[Route('/blog')]
class BlogController {
    #[Route('/{slug}', name: 'blog_show', requirements: ['slug' => '[a-z]+'])]
    public function show(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    const meta = parseMeta(nodes);
    expect(meta).not.toBeNull();
    expect(meta!.requirements).toEqual({ slug: '[a-z]+' });
  });

  it('extracts host from #[Route] and stores as signature', () => {
    const src = `<?php
#[Route('/admin')]
class AdminController {
    #[Route('/dashboard', name: 'admin_dash', host: 'admin.example.com')]
    public function dashboard(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/AdminController.php', src);
    const meta = parseMeta(nodes);
    expect(meta).not.toBeNull();
    expect(meta!.host).toBe('admin.example.com');
  });

  it('extracts schemes from #[Route] and stores as signature', () => {
    const src = `<?php
#[Route('/api')]
class ApiController {
    #[Route('/secure', name: 'api_secure', schemes: ['HTTPS'])]
    public function secure(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/ApiController.php', src);
    const meta = parseMeta(nodes);
    expect(meta).not.toBeNull();
    expect(meta!.schemes).toEqual(['HTTPS']);
  });

  it('extracts all extra params together', () => {
    const src = `<?php
class LocaleController {
    #[Route('/{locale}/app', name: 'locale_app', defaults: ['locale' => 'en'], requirements: ['locale' => 'en|fr|de'], host: 'example.com', schemes: ['HTTPS'])]
    public function app(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/LocaleController.php', src);
    const meta = parseMeta(nodes);
    expect(meta).not.toBeNull();
    expect(meta!.defaults).toEqual({ locale: 'en' });
    expect(meta!.requirements).toEqual({ locale: 'en|fr|de' });
    expect(meta!.host).toBe('example.com');
    expect(meta!.schemes).toEqual(['HTTPS']);
  });

  it('leaves signature empty when no extra params are present', () => {
    const src = `<?php
#[Route('/blog')]
class BlogController {
    #[Route('/', name: 'blog_index', methods: ['GET'])]
    public function index(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    expect(nodes[0].signature).toBeUndefined();
  });

  it('extracts defaults from PHP short array syntax [key => val]', () => {
    const src = `<?php
class LocaleController {
    #[Route('/{locale}/app', name: 'locale_app', defaults: ['locale' => 'en'])]
    public function app(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/LocaleController.php', src);
    const sig = nodes[0]?.signature;
    expect(sig).toBeDefined();
    const meta = JSON.parse(sig);
    expect(meta.defaults).toEqual({ locale: 'en' });
  });

  it('extracts requirements from PHP short array syntax [key => val]', () => {
    const src = `<?php
class SlugController {
    #[Route('/{slug}', name: 'slug_show', requirements: ['slug' => '[a-z]+'])]
    public function show(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/SlugController.php', src);
    const sig = nodes[0]?.signature;
    expect(sig).toBeDefined();
    const meta = JSON.parse(sig);
    expect(meta.requirements).toEqual({ slug: '[a-z]+' });
  });

  it('keeps defaults and requirements apart when both are arrays', () => {
    const src = `<?php
class MixedController {
    #[Route('/{locale}/{slug}', name: 'mixed', defaults: ['locale' => 'en'], requirements: ['slug' => '[a-z]+'])]
    public function app(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/MixedController.php', src);
    const sig = nodes[0]?.signature;
    expect(sig).toBeDefined();
    const meta = JSON.parse(sig);
    expect(meta.defaults).toEqual({ locale: 'en' });
    expect(meta.requirements).toEqual({ slug: '[a-z]+' });
  });
});

describe('symfonyResolver.extract — broader container path', () => {
  it('detects compiled container in var/cache path', () => {
    const src = `<?php
class Container_XYZ extends Container
{
    protected function getLoggerService(): \\Monolog\\Logger
    {
        return \$this->privates['logger'] ?? \$this->load('getLoggerService');
    }
}
`;
    const { nodes } = symfonyResolver.extract!('var/cache/dev/Container_XYZ.php', src);
    expect(nodes.filter(n => n.kind === 'variable').map(n => n.name)).toContain('Logger');
  });

  it('detects compiled container in .symfony cache path', () => {
    const src = `<?php
class App_KernelContainer extends Container
{
    protected function getCacheService(): \\Symfony\\Component\\Cache\\Adapter\\AdapterInterface
    {
        return \$this->privates['cache'] ?? \$this->load('getCacheService');
    }
}
`;
    const { nodes } = symfonyResolver.extract!('.symfony/cache/App_KernelContainer.php', src);
    expect(nodes.filter(n => n.kind === 'variable').map(n => n.name)).toContain('Cache');
  });

  it('does not read a Cache source folder as the compiled container', () => {
    const src = `<?php
class ContainerXYZ extends Container
{
    protected function getMailerService(): \\App\\Service\\MailerService
    {
        return new \\App\\Service\\MailerService();
    }
}
`;
    const { nodes } = symfonyResolver.extract!('src/Cache/ContainerXYZ.php', src);
    expect(nodes.filter(n => n.kind === 'variable')).toEqual([]);
  });
});

describe('symfonyResolver.extract — YAML prefix detection', () => {
  it('detects prefix from resource import (prefix not applied to sibling routes)', () => {
    const src = `app_controllers:
    resource: ../src/Controller/
    type: attribute
    prefix: /app

app_index:
    path: /
    controller: App\\Controller\\DefaultController::index
`;
    const { nodes } = symfonyResolver.extract!('config/routes.yaml', src);
    // prefix on a resource import does NOT apply to sibling routes
    // prefix would be applied via postExtract to routes from the imported resource
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('ANY /');
  });

  it('prefixed route with resource is not emitted (no path)', () => {
    const src = `admin_pages:
    resource: ../src/Admin/
    prefix: /admin

admin_dashboard:
    path: /dashboard
    controller: App\\Controller\\Admin\\DashboardController::index
`;
    const { nodes } = symfonyResolver.extract!('config/routes/admin.yaml', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('ANY /dashboard');
  });
});

describe('symfonyResolver.extract — Shopware-style controllers', () => {
  it('keeps the first method route after a path-less class-level #[Route]', () => {
    const src = `<?php
#[Route(defaults: ['_routeScope' => ['storefront']])]
#[Package('storefront')]
class AuthController extends StorefrontController
{
    #[Route(path: '/account/login', name: 'frontend.account.login.page', methods: ['GET'])]
    public function loginPage(): Response {}

    #[Route(path: '/account/register', name: 'frontend.account.register.page', methods: ['GET'])]
    public function accountRegisterPage(): Response {}
}
`;
    const { nodes, references } = symfonyResolver.extract!('src/Controller/AuthController.php', src);
    expect(nodes.map(n => n.name)).toEqual(['GET /account/login', 'GET /account/register']);
    expect(references.map(r => r.referenceName)).toEqual(['loginPage', 'accountRegisterPage']);
  });

  it('emits every stacked #[Route] of one action', () => {
    const src = `<?php
class AddressController
{
    #[Route(path: '/account/address/create', name: 'frontend.account.address.create', methods: ['POST'])]
    #[Route(path: '/account/address/{addressId}', name: 'frontend.account.address.edit.save', methods: ['POST'])]
    public function saveAddress(): Response {}
}
`;
    const { nodes, references } = symfonyResolver.extract!('src/Controller/AddressController.php', src);
    expect(nodes.map(n => n.name)).toEqual(['POST /account/address/create', 'POST /account/address/{addressId}']);
    expect(references.every(r => r.referenceName === 'saveAddress')).toBe(true);
  });

  it('reads a multi-line #[Route] with nested defaults', () => {
    const src = `<?php
class CheckoutController
{
    #[Route(
        path: '/checkout/update-phone',
        name: 'frontend.checkout.update-phone',
        defaults: [
            'XmlHttpRequest' => true,
            '_loginRequired' => true,
            '_template' => 'checkout/phone.html.twig',
        ],
        methods: ['POST']
    )]
    public function updatePhone(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/CheckoutController.php', src);
    expect(nodes.map(n => n.name)).toEqual(['POST /checkout/update-phone']);
    expect(JSON.parse(nodes[0]!.signature!).defaults).toEqual({
      XmlHttpRequest: 'true',
      _loginRequired: 'true',
      _template: 'checkout/phone.html.twig',
    });
  });

  it('does not read the directory of a nested resource import as a route', () => {
    const src = `controllers:
    resource:
        path: ../src/Controller/
        namespace: App\\Controller
    type: attribute

app_index:
    path: /
    controller: App\\Controller\\DefaultController::index
`;
    const { nodes } = symfonyResolver.extract!('config/routes.yaml', src);
    expect(nodes.map(n => n.name)).toEqual(['ANY /']);
  });
});

describe('symfonyResolver.extract — bundle service YAML', () => {
  it('extracts service references from vendor bundle services.yaml', () => {
    const src = `services:
    Acme\\BlogBundle\\Controller\\PostController:
        tags: ['controller.service_arguments']

    Acme\\BlogBundle\\Repository\\PostRepository:
        arguments:
            - '@doctrine'
`;
    const { references } = symfonyResolver.extract!('vendor/acme/blog-bundle/Resources/config/services.yaml', src);
    const fqcns = references.map(r => r.referenceName);
    expect(fqcns).toContain('Acme\\BlogBundle\\Controller\\PostController');
    expect(fqcns).toContain('Acme\\BlogBundle\\Repository\\PostRepository');
  });
});

describe('symfonyResolver.extract — no duplicate class nodes', () => {
  it('leaves entity, repository, subscriber and command classes to the PHP extractor', () => {
    const src = `<?php
#[ORM\\Entity(repositoryClass: PostRepository::class)]
class Post {}

class PostRepository extends ServiceEntityRepository {}

class PostSubscriber implements EventSubscriberInterface {}

#[AsCommand(name: 'app:posts')]
class PostCommand extends Command {}
`;
    const { nodes } = symfonyResolver.extract!('src/Post.php', src);
    expect(nodes.filter(n => n.kind === 'class')).toEqual([]);
  });
});

describe('symfonyResolver.extract — Twig template references', () => {
  it('extracts Twig template reference from $this->render()', () => {
    const src = `<?php
class BlogController extends AbstractController
{
    #[Route('/', name: 'blog_index', methods: ['GET'])]
    public function index(): Response
    {
        return \$this->render('blog/index.html.twig');
    }
}
`;
    const { references } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    const twigRef = references.find(r => r.referenceName === 'blog/index.html.twig');
    expect(twigRef).toBeDefined();
    expect(twigRef!.referenceKind).toBe('references');
  });

  it('extracts multiple Twig template references', () => {
    const src = `<?php
class BlogController extends AbstractController
{
    public function index(): Response
    {
        return \$this->render('blog/index.html.twig');
    }

    public function show(): Response
    {
        return \$this->render('blog/show.html.twig');
    }
}
`;
    const { references } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    const templates = references.filter(r => r.referenceName.endsWith('.twig')).map(r => r.referenceName);
    expect(templates).toContain('blog/index.html.twig');
    expect(templates).toContain('blog/show.html.twig');
  });
});

describe('symfonyResolver.extract — pathological input', () => {
  // `#[Route(…)]` followed by whitespace-only lines and no `class` took the
  // former `(?:\s*\n\s*)*` class-route regex seconds at 16 lines, doubling per line.
  it('reads a Route attribute followed by thousands of blank lines in linear time', () => {
    const src = `<?php\n#[Route('/x')]${' \n'.repeat(20000)}!\n#[Route(defaults: [${"'k' => [".repeat(2000)}`;
    const started = performance.now();
    const { nodes } = symfonyResolver.extract!('src/Controller/Slow.php', src);
    expect(nodes).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('symfonyResolver.extract — empty paths and compiled route arguments', () => {
  it('keeps a method route with an empty path under the class prefix', () => {
    const src = `<?php
#[Route('/blog')]
class BlogController {
    #[Route('', name: 'blog')]
    public function index(): Response {}
}
`;
    const { nodes } = symfonyResolver.extract!('src/Controller/BlogController.php', src);
    expect(nodes.map((n) => n.name)).toEqual(['ANY /blog']);
  });

  it('reads HTTP methods from the seventh Route argument, not the schemes', () => {
    const src = `<?php
class Container_XYZ extends Container {
    private function getRoutes() {
        \$routes->add('a', new Route('/a', ['_controller' => 'App\\\\C::a'], [], [], '', [], ['POST']));
        \$routes->add('b', new Route('/b', ['_controller' => 'App\\\\C::b'], [], [], '', ['https'], []));
    }
}
`;
    const { nodes } = symfonyResolver.extract!('var/cache/prod/Container_XYZ.php', src);
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name).sort()).toEqual(['ANY /b', 'POST /a']);
  });
});
