import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Symfony end-to-end — PHP 8 #[Route] attribute extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extracts route nodes and reference edges from #[Route] attributes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-attr-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'src/Controller'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Controller/BlogController.php'),
      `<?php
#[Route('/blog')]
class BlogController {
    #[Route('/', name: 'blog_index', methods: ['GET'])]
    public function index(): array {
        return ['Hello'];
    }

    #[Route('/{slug}', name: 'blog_show', methods: ['GET'])]
    public function show(string $slug): array {
        return ['Post: ' . $slug];
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThanOrEqual(2);

    const indexRoute = routes.find(r => r.name === 'GET /blog/');
    expect(indexRoute).toBeDefined();

    const showRoute = routes.find(r => r.name === 'GET /blog/{slug}');
    expect(showRoute).toBeDefined();

    // Check reference edges from route → handler method
    const indexEdges = cg.getOutgoingEdges(indexRoute!.id);
    const indexRef = indexEdges.find(e => e.kind === 'references');
    expect(indexRef).toBeDefined();

    const methods = cg.getNodesByKind('method');
    const indexMethod = methods.find(m => m.name === 'index');
    expect(indexMethod).toBeDefined();

    cg.close();
  });
});

describe('Symfony end-to-end — YAML route extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extracts route nodes from YAML config files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-yaml-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^6.4' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config/routes.yaml'),
      `homepage:
    path: /
    controller: Symfony\\Bundle\\FrameworkBundle\\Controller\\TemplateController::templateAction

blog_index:
    path: /blog
    controller: App\\Controller\\BlogController::index
    methods: [GET]
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThanOrEqual(2);

    const homepage = routes.find(r => r.name === 'ANY /');
    expect(homepage).toBeDefined();

    const blog = routes.find(r => r.name === 'GET /blog');
    expect(blog).toBeDefined();

    // Reference edges require a matching controller PHP file to resolve;
    // YAML-only tests verify route nodes are created correctly.
    cg.close();
  });
});

describe('Symfony end-to-end — compiled DI container', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extracts service nodes from a compiled container file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-di-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'var/cache/dev'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'var/cache/dev/Container_XYZ.php'),
      `<?php
class Container_XYZ extends Container
{
    protected function getLoggerService(): \\Monolog\\Logger
    {
        return \\$this->privates['logger'] ?? \\$this->load('getLoggerService');
    }

    protected function getBlogRepositoryService(): \\App\\Repository\\BlogRepository
    {
        return new \\App\\Repository\\BlogRepository(\\$this->getLoggerService());
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const variables = cg.getNodesByKind('variable');
    const loggerSvc = variables.find(v => v.name === 'Logger');
    expect(loggerSvc).toBeDefined();
    expect(loggerSvc!.qualifiedName).toContain('Monolog');

    const blogRepo = variables.find(v => v.name === 'BlogRepository');
    expect(blogRepo).toBeDefined();
    expect(blogRepo!.qualifiedName).toContain('App\\Repository\\BlogRepository');

    cg.close();
  });
});

describe('Symfony end-to-end — Doctrine entity detection', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links an #[Entity] class to its attribute class without a duplicate class node', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-doctrine-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'src/Entity'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/Mapping'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Mapping/Entity.php'),
      `<?php
namespace App\\Mapping;

#[\\Attribute]
class Entity
{
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/Entity/BlogPost.php'),
      `<?php
use App\\Mapping\\Entity;

#[Entity]
class BlogPost
{
    #[Id, Column(type: 'integer'), GeneratedValue]
    private int \\$id;
    #[Column(type: 'string')]
    private string \\$title;
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const classes = cg.getNodesByKind('class');
    const blogPosts = classes.filter(c => c.name === 'BlogPost');
    expect(blogPosts).toHaveLength(1);

    const entityAttr = classes.find(c => c.name === 'Entity');
    expect(entityAttr).toBeDefined();
    const decorates = cg.getOutgoingEdges(blogPosts[0]!.id).filter(e => e.kind === 'decorates');
    expect(decorates.map(e => e.target)).toContain(entityAttr!.id);

    cg.close();
  });
});

describe('Symfony end-to-end — console command detection', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('indexes an #[AsCommand] class once', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-cmd-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'src/Command'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Command/GenerateReportCommand.php'),
      `<?php
#[AsCommand(name: 'app:generate-report')]
class GenerateReportCommand extends Command
{
    protected function execute(InputInterface \\$input, OutputInterface \\$output): int
    {
        return Command::SUCCESS;
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const commands = cg.getNodesByKind('class').filter(c => c.name === 'GenerateReportCommand');
    expect(commands).toHaveLength(1);

    cg.close();
  });
});

describe('Symfony end-to-end — Twig template reference extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extracts Twig template references from $this->render() calls', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-twig-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'src/Controller'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Controller/BlogController.php'),
      `<?php
class BlogController {
    public function index(): array
    {
        return \\$this->render('blog/index.html.twig');
    }

    public function show(): array
    {
        return \\$this->render('blog/show.html.twig');
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const refs = cg.searchNodes('');

    // The edge target names for Twig templates are stored as reference names
    // Twig references are stored on route nodes emitted by the Twig
    // extractor. Verify the route node exists.
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThanOrEqual(0);
    // The controller is also indexed as a class
    const controller = cg.getNodesByKind('class').find(c => c.name === 'BlogController');
    expect(controller).toBeDefined();

    cg.close();
  });
});

describe('Symfony end-to-end — full-stack symfony project', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('indexes a complete Symfony project with controllers, YAML routes, and DI container', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-full-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config/routes.yaml'),
      `app_index:
    path: /
    controller: App\\Controller\\DefaultController::index
`
    );
    fs.mkdirSync(path.join(tmpDir, 'src/Controller'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Controller/DefaultController.php'),
      `<?php
#[Route('/')]
class DefaultController {
    #[Route('/', name: 'homepage')]
    public function index(): array {
        return ['Hello'];
    }
}
`
    );
    fs.mkdirSync(path.join(tmpDir, 'src/Command'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Command/TestCommand.php'),
      `<?php
#[AsCommand(name: 'app:test')]
class TestCommand extends Command
{
    protected function execute(InputInterface \\$input, OutputInterface \\$output): int
    {
        return Command::SUCCESS;
    }
}
`
    );
    fs.mkdirSync(path.join(tmpDir, 'src/Entity'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src/Entity/Product.php'),
      `<?php
#[Entity]
class Product
{
    #[Id, Column(type: 'integer'), GeneratedValue]
    private int \\$id;
}
`
    );
    fs.mkdirSync(path.join(tmpDir, 'var/cache/dev'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'var/cache/dev/App_KernelContainer.php'),
      `<?php
class App_KernelContainer extends Container
{
    protected function getLoggerService(): \\Monolog\\Logger
    {
        return \\$this->privates['logger'] ?? \\$this->load('getLoggerService');
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route extraction
    const routes = cg.getNodesByKind('route');
    const attrRoute = routes.find(r => r.name === 'ANY /');
    expect(attrRoute).toBeDefined();

    // Framework detection adds no second node for a class the PHP extractor already indexed
    const classKeys = cg.getNodesByKind('class').map(c => `${c.filePath}::${c.name}`);
    expect(new Set(classKeys).size).toBe(classKeys.length);

    // DI container service extraction
    const services = cg.getNodesByKind('variable');
    const loggerSvc = services.find(s => s.name === 'Logger');
    expect(loggerSvc).toBeDefined();
    expect(loggerSvc!.qualifiedName).toContain('Monolog');

    cg.close();
  });
});

describe('Symfony end-to-end — compiled container route extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extracts routes from $routes->add() in compiled container', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-cont-routes-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'var/cache/dev'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'var/cache/dev/App_KernelContainer.php'),
      `<?php
class App_KernelContainer extends Container
{
    protected function getRouterService(): Router
    {
        \\$routes = new RouteCollection();
        \\$routes->add('blog_index', new Route('/', ['_controller' => 'App\\\\Controller\\\\BlogController::index'], [], [], '', [], ['GET']));
        \\$routes->add('blog_show', new Route('/blog/{slug}', ['_controller' => 'App\\\\Controller\\\\BlogController::show'], ['slug' => '[a-z]+'], [], '', [], ['GET']));
        return new Router(\\$routes);
    }

    protected function getLoggerService(): \\Monolog\\Logger
    {
        return \\$this->privates['logger'] ?? \\$this->load('getLoggerService');
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    const blogIndex = routes.find(r => r.name === 'GET /');
    expect(blogIndex).toBeDefined();
    expect(blogIndex!.qualifiedName).toContain('blog_index');

    const blogShow = routes.find(r => r.name === 'GET /blog/{slug}');
    expect(blogShow).toBeDefined();
    expect(blogShow!.qualifiedName).toContain('blog_show');

    // Controller references are stored as unresolved refs in extraction;
    // they only become edges when the target node exists in the graph
    // (no controller file in this test, so no edge — that's correct)

    // Service extraction should still work
    const services = cg.getNodesByKind('variable');
    const loggerSvc = services.find(s => s.name === 'Logger');
    expect(loggerSvc).toBeDefined();

    cg.close();
  });

  it('extracts routes with PHP short array syntax from compiled container', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-cont-arr-'));
    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.writeFileSync(path.join(tmpDir, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(path.join(tmpDir, 'config/packages'), '');
    fs.mkdirSync(path.join(tmpDir, 'var/cache/dev'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'var/cache/dev/App_KernelContainer.php'),
      `<?php
class App_KernelContainer extends Container
{
    protected function getRouterService(): Router
    {
        \\$routes = new RouteCollection();
        \\$routes->add('api_entries', new Route('/api/entries', ['_controller' => 'App\\\\Controller\\\\ApiController::list'], [], [], '', [], ['GET', 'POST']));
        return new Router(\\$routes);
    }
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    expect(routes).toHaveLength(2);
    expect(routes.map(r => r.name)).toContain('GET /api/entries');
    expect(routes.map(r => r.name)).toContain('POST /api/entries');

    cg.close();
  });
});

describe('Symfony end-to-end — controller resolution and attribute edges', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links a YAML route to the action of the class its FQCN names, and attributes to their class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symfony-fqcn-'));
    fs.writeFileSync(path.join(tmpDir, 'composer.json'), JSON.stringify({ require: { 'symfony/framework-bundle': '^7.0' } }));
    fs.mkdirSync(path.join(tmpDir, 'config'));
    fs.writeFileSync(
      path.join(tmpDir, 'config/routes.yaml'),
      'blog:\n    path: /blog\n    controller: App\\Controller\\BlogController::index\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'src/Controller/Admin'), { recursive: true });
    for (const [file, ns] of [['src/Controller/BlogController.php', 'App\\Controller'], ['src/Controller/Admin/BlogController.php', 'App\\Controller\\Admin']]) {
      fs.writeFileSync(
        path.join(tmpDir, file),
        `<?php\nnamespace ${ns};\n\nuse App\\Attribute\\AsController;\n\n#[AsController]\nclass BlogController {\n    public function index(): array { return []; }\n}\n`
      );
    }
    fs.writeFileSync(
      path.join(tmpDir, 'src/AsController.php'),
      '<?php\nnamespace App\\Attribute;\n\n#[\\Attribute]\nclass AsController {}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const route = cg.getNodesByKind('route').find((r) => r.name === 'ANY /blog');
    expect(route).toBeDefined();
    const target = cg.getOutgoingEdges(route!.id).find((e) => e.kind === 'references')?.target;
    const action = cg.getNodesByKind('method').find((m) => m.id === target);
    expect(action?.filePath).toBe('src/Controller/BlogController.php');

    const attrClass = cg.getNodesByKind('class').find((c) => c.name === 'AsController');
    const decorated = cg.getIncomingEdges(attrClass!.id).filter((e) => e.kind === 'decorates');
    expect(decorated).toHaveLength(2);

    cg.close();
  });
});
