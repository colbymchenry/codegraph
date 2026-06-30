import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

describe('FrameworkResolver.extract interface', () => {
  it('extract() returns { nodes, references }', () => {
    const resolver: FrameworkResolver = {
      name: 'fake',
      detect: () => true,
      resolve: () => null,
      languages: ['python'],
      extract: (_filePath: string, _content: string) => ({
        nodes: [] as Node[],
        references: [] as UnresolvedRef[],
      }),
    };
    const result = resolver.extract!('foo.py', '');
    expect(result).toEqual({ nodes: [], references: [] });
  });
});

import { getApplicableFrameworks } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';

describe('getApplicableFrameworks', () => {
  const pyFw: FrameworkResolver = { name: 'py', languages: ['python'], detect: () => true, resolve: () => null };
  const jsFw: FrameworkResolver = { name: 'js', languages: ['javascript', 'typescript'], detect: () => true, resolve: () => null };
  const anyFw: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

  it('filters by language', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'python');
    expect(result.map(r => r.name)).toEqual(['py', 'any']);
  });

  it('returns anyFw-only when language has no matches', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'rust');
    expect(result.map(r => r.name)).toEqual(['any']);
  });
});

import { djangoResolver } from '../src/resolution/frameworks/python';

describe('djangoResolver.extract', () => {
  it('extracts route node and reference for path() with CBV.as_view()', () => {
    const src = `
from django.urls import path
from users.views import UserListView

urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]
`;
    const { nodes, references } = djangoResolver.extract!('users/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('users/');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
    expect(references[0].referenceKind).toBe('references');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts route for path() with dotted module.Class.as_view()', () => {
    const src = `from django.urls import path\nfrom api.v1 import views as api_v1_views\nurlpatterns = [path('api/', api_v1_views.UserListView.as_view())]\n`;
    const { nodes, references } = djangoResolver.extract!('api/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
  });

  it('extracts route for path() with bare function view', () => {
    const src = `from django.urls import path\nurlpatterns = [path('home/', home_view, name='home')]\n`;
    const { nodes, references } = djangoResolver.extract!('home/urls.py', src);
    expect(references[0].referenceName).toBe('home_view');
  });

  it('extracts route for path() with include()', () => {
    const src = `from django.urls import path, include\nurlpatterns = [path('api/', include('api.urls'))]\n`;
    const { nodes, references } = djangoResolver.extract!('root/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(references[0].referenceName).toBe('api.urls');
    expect(references[0].referenceKind).toBe('imports');
  });

  it('extracts routes for re_path and url', () => {
    const src = `from django.urls import re_path, url\nurlpatterns = [re_path(r'^users/$', UserView), url(r'^old/$', OldView)]\n`;
    const { nodes } = djangoResolver.extract!('legacy/urls.py', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['^users/$', '^old/$']);
  });

  it('returns empty result for a non-urls.py python file', () => {
    const src = `def foo(): return 1\n`;
    const { nodes, references } = djangoResolver.extract!('views.py', src);
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });
});

import { flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';

describe('flaskResolver.extract', () => {
  it('extracts route and reference from @app.route', () => {
    const src = `
@app.route('/users')
def list_users():
    return []
`;
    const { nodes, references } = flaskResolver.extract!('app.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts blueprint routes', () => {
    const src = `
@users_bp.route('/<id>', methods=['POST'])
def create_user(id):
    pass
`;
    const { nodes, references } = flaskResolver.extract!('routes.py', src);
    expect(nodes[0].name).toBe('POST /<id>');
    expect(references[0].referenceName).toBe('create_user');
  });

  it('resolves the handler across an intervening decorator (@login_required)', () => {
    const src = `
@bp.route('/profile')
@login_required
def profile():
    return render_template('profile.html')
`;
    const { nodes, references } = flaskResolver.extract!('routes.py', src);
    expect(nodes[0].name).toBe('GET /profile');
    expect(references[0].referenceName).toBe('profile');
  });

  it('extracts stacked @x.route decorators bound to one view', () => {
    const src = `
@bp.route('/', methods=['GET', 'POST'])
@bp.route('/index', methods=['GET', 'POST'])
@login_required
def index():
    return render_template('index.html')
`;
    const { nodes, references } = flaskResolver.extract!('routes.py', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /', 'GET /index']);
    expect(references.map((r) => r.referenceName)).toEqual(['index', 'index']);
  });

  it('extracts the method from a tuple methods=(...) (not just a list)', () => {
    const src = `
@blueprint.route('/api/articles', methods=('POST',))
def make_article():
    pass
`;
    const { nodes, references } = flaskResolver.extract!('views.py', src);
    expect(nodes[0].name).toBe('POST /api/articles');
    expect(references[0].referenceName).toBe('make_article');
  });

  it('extracts Flask-RESTful api.add_resource(Resource, paths) → the Resource class', () => {
    const src = `
api.add_resource(TodoResource, '/todos/<id>')
api.add_org_resource(AlertResource, '/api/alerts/<id>', endpoint='alert')
`;
    const { nodes, references } = flaskResolver.extract!('api.py', src);
    expect(nodes.map((n) => n.name)).toEqual(['ANY /todos/<id>', 'ANY /api/alerts/<id>']);
    expect(references.map((r) => r.referenceName)).toEqual(['TodoResource', 'AlertResource']);
  });
});

describe('fastapiResolver.extract', () => {
  it('extracts route and reference from @app.get', () => {
    const src = `
@app.get('/users')
async def list_users():
    return []
`;
    const { nodes, references } = fastapiResolver.extract!('main.py', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts route from router.post', () => {
    const src = `
@router.post('/items')
def create_item(item: Item):
    pass
`;
    const { nodes, references } = fastapiResolver.extract!('items.py', src);
    expect(nodes[0].name).toBe('POST /items');
    expect(references[0].referenceName).toBe('create_item');
  });

  it('extracts a route mounted at the router/prefix root (empty path)', () => {
    const src = `
@router.get("", response_model=ListOfArticles, name="articles:list")
async def list_articles():
    return []
`;
    const { nodes, references } = fastapiResolver.extract!('articles.py', src);
    expect(nodes[0].name).toBe('GET /');
    expect(references[0].referenceName).toBe('list_articles');
  });

  it('extracts a multi-line decorator with an empty path', () => {
    const src = `
@router.post(
    "",
    status_code=201,
    response_model=ArticleInResponse,
)
async def create_article():
    pass
`;
    const { nodes, references } = fastapiResolver.extract!('articles.py', src);
    expect(nodes[0].name).toBe('POST /');
    expect(references[0].referenceName).toBe('create_article');
  });
});

import { expressResolver } from '../src/resolution/frameworks/express';

describe('expressResolver.extract', () => {
  it('extracts route with inline handler reference', () => {
    const src = `app.get('/users', listUsers);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts route with router.post and middleware chain', () => {
    const src = `router.post('/items', auth, createItem);\n`;
    const { nodes, references } = expressResolver.extract!('items.ts', src);
    expect(nodes[0].name).toBe('POST /items');
    // Multiple handlers: prefer the LAST one (convention: middleware first, handler last)
    expect(references[0].referenceName).toBe('createItem');
  });

  it('extracts route with controller method reference', () => {
    const src = `app.get('/x', userController.list);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(references[0].referenceName).toBe('list');
  });
});

import { nestjsResolver } from '../src/resolution/frameworks/nestjs';

describe('nestjsResolver.extract — HTTP', () => {
  it('joins @Controller prefix with @Get and links the handler', () => {
    const src = `
@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }
}
`;
    const { nodes, references } = nestjsResolver.extract!('users.controller.ts', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('findAll');
    expect(references[0].referenceKind).toBe('references');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('joins controller prefix with a method-level path param', () => {
    const src = `
@Controller('cats')
export class CatsController {
  @Get(':id')
  findOne(@Param('id') id: string) { return id; }
}
`;
    const { nodes, references } = nestjsResolver.extract!('cats.controller.ts', src);
    expect(nodes[0].name).toBe('GET /cats/:id');
    expect(references[0].referenceName).toBe('findOne');
  });

  it('handles an empty @Controller() and empty @Post()', () => {
    const src = `
@Controller()
export class AppController {
  @Post()
  create() {}
}
`;
    const { nodes, references } = nestjsResolver.extract!('app.controller.ts', src);
    expect(nodes[0].name).toBe('POST /');
    expect(references[0].referenceName).toBe('create');
  });

  it('covers HTTP verbs and skips intervening method decorators', () => {
    const src = `
@Controller('todos')
export class TodosController {
  @Put(':id')
  @UseGuards(AuthGuard)
  update(@Param('id') id: string) {}

  @Delete(':id')
  async remove(@Param('id') id: string) {}
}
`;
    const { nodes, references } = nestjsResolver.extract!('todos.controller.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['PUT /todos/:id', 'DELETE /todos/:id']);
    expect(references.map((r) => r.referenceName)).toEqual(['update', 'remove']);
  });

  it('attributes methods to the right controller when a file has two', () => {
    const src = `
@Controller('a')
export class AController {
  @Get('x')
  ax() {}
}

@Controller('b')
export class BController {
  @Get('y')
  by() {}
}
`;
    const { nodes } = nestjsResolver.extract!('multi.controller.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /a/x', 'GET /b/y']);
  });
});

describe('nestjsResolver.extract — GraphQL', () => {
  it('emits QUERY/MUTATION nodes from a resolver, defaulting to the method name', () => {
    const src = `
@Resolver(() => User)
export class UsersResolver {
  @Query(() => [User])
  users() { return []; }

  @Mutation(() => User)
  createUser(@Args('input') input: CreateUserInput) {}
}
`;
    const { nodes, references } = nestjsResolver.extract!('users.resolver.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['QUERY users', 'MUTATION createUser']);
    expect(references.map((r) => r.referenceName)).toEqual(['users', 'createUser']);
  });

  it('uses an explicit operation name when given', () => {
    const src = `
@Resolver()
export class CatsResolver {
  @Query(() => Cat, { name: 'cat' })
  getCat() {}
}
`;
    const { nodes } = nestjsResolver.extract!('cats.resolver.ts', src);
    expect(nodes[0].name).toBe('QUERY cat');
  });

  it('does NOT treat the REST @Query() parameter decorator as a GraphQL op', () => {
    const src = `
@Controller('search')
export class SearchController {
  @Get()
  search(@Query() query: SearchDto) { return query; }
}
`;
    const { nodes } = nestjsResolver.extract!('search.controller.ts', src);
    // Only the HTTP route — the @Query() param decorator must be ignored.
    expect(nodes.map((n) => n.name)).toEqual(['GET /search']);
  });
});

describe('nestjsResolver.extract — microservices & websockets', () => {
  it('extracts @MessagePattern and @EventPattern handlers', () => {
    const src = `
@Controller()
export class MathController {
  @MessagePattern({ cmd: 'sum' })
  accumulate(data: number[]) {}

  @EventPattern('user.created')
  handleUserCreated(data: any) {}
}
`;
    const { nodes, references } = nestjsResolver.extract!('math.controller.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['MESSAGE sum', 'EVENT user.created']);
    expect(references.map((r) => r.referenceName)).toEqual(['accumulate', 'handleUserCreated']);
  });

  it('extracts @SubscribeMessage handlers with the gateway namespace', () => {
    const src = `
@WebSocketGateway({ namespace: 'chat' })
export class ChatGateway {
  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: string) {}
}
`;
    const { nodes, references } = nestjsResolver.extract!('chat.gateway.ts', src);
    expect(nodes[0].name).toBe('WS chat:message');
    expect(references[0].referenceName).toBe('handleMessage');
  });

  it('extracts @SubscribeMessage without a namespace', () => {
    const src = `
@WebSocketGateway()
export class EventsGateway {
  @SubscribeMessage('events')
  onEvent() {}
}
`;
    const { nodes } = nestjsResolver.extract!('events.gateway.ts', src);
    expect(nodes[0].name).toBe('WS events');
  });

  it('returns empty for a non-JS/TS file', () => {
    const { nodes, references } = nestjsResolver.extract!('thing.py', '@Controller("x")');
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });
});

describe('nestjsResolver.detect', () => {
  const baseContext = {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    getProjectRoot: () => '/test',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };

  it('detects @nestjs/* in package.json', () => {
    const context = {
      ...baseContext,
      readFile: (p: string) =>
        p === 'package.json'
          ? JSON.stringify({ dependencies: { '@nestjs/common': '^10.0.0' } })
          : null,
    };
    expect(nestjsResolver.detect(context as any)).toBe(true);
  });

  it('detects @Controller in a *.controller.ts file when package.json is absent', () => {
    const context = {
      ...baseContext,
      getAllFiles: () => ['src/users.controller.ts'],
      readFile: (p: string) =>
        p === 'src/users.controller.ts'
          ? `@Controller('users')\nexport class UsersController {}`
          : null,
    };
    expect(nestjsResolver.detect(context as any)).toBe(true);
  });

  it('returns false for a non-Nest project', () => {
    const context = {
      ...baseContext,
      readFile: (p: string) =>
        p === 'package.json' ? JSON.stringify({ dependencies: { express: '^4' } }) : null,
    };
    expect(nestjsResolver.detect(context as any)).toBe(false);
  });
});

describe('nestjsResolver.resolve', () => {
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

  it('resolves an injected *Service reference to the class in a *.service.ts file', () => {
    const svcNode: Node = {
      id: 'class:src/users/users.service.ts:UsersService:3',
      kind: 'class',
      name: 'UsersService',
      qualifiedName: 'src/users/users.service.ts::UsersService',
      filePath: 'src/users/users.service.ts',
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const context = {
      ...baseContext,
      getNodesByName: (n: string) => (n === 'UsersService' ? [svcNode] : []),
    };
    const ref = {
      fromNodeId: 'class:src/users/users.controller.ts:UsersController:5',
      referenceName: 'UsersService',
      referenceKind: 'references' as const,
      line: 6,
      column: 4,
      filePath: 'src/users/users.controller.ts',
      language: 'typescript' as const,
    };
    const result = nestjsResolver.resolve(ref, context as any);
    expect(result?.targetNodeId).toBe(svcNode.id);
    expect(result?.resolvedBy).toBe('framework');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('returns null for a name without a provider suffix', () => {
    const ref = {
      fromNodeId: 'x',
      referenceName: 'doThing',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'a.ts',
      language: 'typescript' as const,
    };
    expect(nestjsResolver.resolve(ref, baseContext as any)).toBeNull();
  });
});

describe('nestjsResolver.postExtract — RouterModule', () => {
  function mkClass(name: string, filePath: string, startLine: number, endLine: number): Node {
    return {
      id: `class:${filePath}:${startLine}:${name}`,
      kind: 'class',
      name,
      qualifiedName: `${filePath}::${name}`,
      filePath,
      language: 'typescript',
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
  }

  function mkRoute(
    filePath: string,
    line: number,
    method: string,
    path: string,
    nameOverride?: string
  ): Node {
    return {
      id: `route:${filePath}:${line}:${method}:${path}`,
      kind: 'route',
      name: nameOverride ?? `${method} ${path}`,
      qualifiedName: `${filePath}::${method}:${path}`,
      filePath,
      language: 'typescript',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
  }

  function makeContext(opts: {
    files?: Record<string, string>;
    nodes?: Node[];
  }) {
    const files = opts.files ?? {};
    const all = opts.nodes ?? [];
    return {
      getNodesInFile: (fp: string) => all.filter((n) => n.filePath === fp),
      getNodesByName: (name: string) => all.filter((n) => n.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: (kind: Node['kind']) => all.filter((n) => n.kind === kind),
      fileExists: (fp: string) => files[fp] !== undefined,
      readFile: (fp: string) => files[fp] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => Object.keys(files),
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    } as any;
  }

  it('prepends RouterModule prefix to a controller route (top-level register)', () => {
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          @Module({
            imports: [
              RouterModule.register([
                { path: 'admin', module: AdminModule },
              ]),
            ],
          })
          export class AppModule {}

          @Module({ controllers: [AdminController] })
          export class AdminModule {}
        `,
      },
      nodes: [
        mkClass('AdminController', 'src/admin/admin.controller.ts', 1, 10),
        mkRoute('src/admin/admin.controller.ts', 3, 'GET', '/'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.name).toBe('GET /admin');
    // id and qualifiedName must be preserved so existing route→handler edges
    // stay intact and the pass remains idempotent on a second run.
    expect(updates[0]!.id).toBe('route:src/admin/admin.controller.ts:3:GET:/');
    expect(updates[0]!.qualifiedName).toBe('src/admin/admin.controller.ts::GET:/');
  });

  it('resolves nested children — the issue #459 example', () => {
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          @Module({
            imports: [
              AdminModule,
              UsersModule,
              RouterModule.register([
                {
                  path: 'admin',
                  module: AdminModule,
                  children: [
                    { path: 'users', module: UsersModule },
                  ],
                },
              ]),
            ],
          })
          export class AppModule {}
        `,
        'src/users/users.module.ts': `
          @Module({ controllers: [UsersController] })
          export class UsersModule {}
        `,
      },
      nodes: [
        mkClass('UsersController', 'src/users/users.controller.ts', 1, 10),
        mkRoute('src/users/users.controller.ts', 3, 'GET', '/'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.name).toBe('GET /admin/users');
  });

  it('joins module prefix with a non-empty @Controller path and method params', () => {
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          RouterModule.register([{ path: 'admin', module: UsersModule }])

          @Module({ controllers: [UsersController] })
          export class UsersModule {}
        `,
      },
      nodes: [
        mkClass('UsersController', 'src/users.controller.ts', 1, 10),
        // Existing extract emitted GET /users/:id from @Controller('users') + @Get(':id')
        mkRoute('src/users.controller.ts', 3, 'GET', '/users/:id'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.name).toBe('GET /admin/users/:id');
  });

  it('is idempotent — a second run returns no updates', () => {
    // Simulate the state after one round of postExtract: name is already
    // 'GET /admin', but qualifiedName still encodes the original 'GET:/'.
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          RouterModule.register([{ path: 'admin', module: UsersModule }])
          @Module({ controllers: [UsersController] })
          export class UsersModule {}
        `,
      },
      nodes: [
        mkClass('UsersController', 'src/users.controller.ts', 1, 10),
        mkRoute('src/users.controller.ts', 3, 'GET', '/', 'GET /admin'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(0);
  });

  it('is a no-op when the project does not use RouterModule', () => {
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          @Module({ controllers: [UsersController] })
          export class AppModule {}
        `,
      },
      nodes: [
        mkClass('UsersController', 'src/users.controller.ts', 1, 10),
        mkRoute('src/users.controller.ts', 3, 'GET', '/'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(0);
  });

  it('attributes routes to the right controller when one file has two', () => {
    // Two controllers in one file, declared in two different modules with
    // two different module prefixes. The route's startLine has to match the
    // class scope, not just the file path.
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          RouterModule.register([
            { path: 'p1', module: AModule },
            { path: 'p2', module: BModule },
          ])
          @Module({ controllers: [AController] }) export class AModule {}
          @Module({ controllers: [BController] }) export class BModule {}
        `,
      },
      nodes: [
        mkClass('AController', 'src/multi.controller.ts', 1, 5),
        mkClass('BController', 'src/multi.controller.ts', 7, 12),
        mkRoute('src/multi.controller.ts', 3, 'GET', '/a/x'),
        mkRoute('src/multi.controller.ts', 9, 'GET', '/b/y'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(2);
    const byId = new Map(updates.map((u) => [u.id, u.name]));
    expect(byId.get('route:src/multi.controller.ts:3:GET:/a/x')).toBe('GET /p1/a/x');
    expect(byId.get('route:src/multi.controller.ts:9:GET:/b/y')).toBe('GET /p2/b/y');
  });

  it('merges RouterModule registrations spread across multiple module files', () => {
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          RouterModule.register([{ path: 'a', module: AModule }])
          @Module({ controllers: [AController] }) export class AModule {}
        `,
        'src/feature.module.ts': `
          RouterModule.forChild([{ path: 'b', module: BModule }])
          @Module({ controllers: [BController] }) export class BModule {}
        `,
      },
      nodes: [
        mkClass('AController', 'src/a.controller.ts', 1, 5),
        mkClass('BController', 'src/b.controller.ts', 1, 5),
        mkRoute('src/a.controller.ts', 3, 'GET', '/'),
        mkRoute('src/b.controller.ts', 3, 'GET', '/'),
      ],
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(2);
    const byId = new Map(updates.map((u) => [u.id, u.name]));
    expect(byId.get('route:src/a.controller.ts:3:GET:/')).toBe('GET /a');
    expect(byId.get('route:src/b.controller.ts:3:GET:/')).toBe('GET /b');
  });

  it('silently skips controllers whose class node is not in the graph', () => {
    // RouterModule declares a prefix for a module, but the @Module that
    // would link it to a controller is missing — common during partial
    // re-extraction. Must not throw.
    const ctx = makeContext({
      files: {
        'src/app.module.ts': `
          RouterModule.register([{ path: 'orphans', module: GhostModule }])
          @Module({ controllers: [GhostController] }) export class GhostModule {}
        `,
      },
      nodes: [], // no class or route nodes
    });

    const updates = nestjsResolver.postExtract!(ctx);
    expect(updates).toHaveLength(0);
  });
});

import { laravelResolver } from '../src/resolution/frameworks/laravel';

describe('laravelResolver.extract', () => {
  it('extracts route with controller tuple syntax', () => {
    const src = `Route::get('/users', [UserController::class, 'index']);\n`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('UserController@index');
  });

  it('extracts route with Controller@action syntax', () => {
    const src = `Route::post('/users', 'UserController@store');\n`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(references[0].referenceName).toBe('UserController@store');
  });

  it('extracts resource route', () => {
    const src = `Route::resource('users', UserController::class);\n`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(nodes[0].kind).toBe('route');
    expect(references[0].referenceName).toBe('UserController');
  });
});

import { railsResolver } from '../src/resolution/frameworks/ruby';

describe('railsResolver.extract', () => {
  it('extracts route with controller#action syntax', () => {
    const src = `get '/users', to: 'users#index'\n`;
    const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('users#index');
  });

  it('extracts route without to: keyword', () => {
    const src = `post '/items' => 'items#create'\n`;
    const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
    expect(references[0].referenceName).toBe('items#create');
  });
});

import { springResolver } from '../src/resolution/frameworks/java';

describe('springResolver.extract', () => {
  it('extracts route with @GetMapping and next method', () => {
    const src = `
@GetMapping("/users")
public List<User> listUsers() {
  return users;
}
`;
    const { nodes, references } = springResolver.extract!('UserController.java', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts a Kotlin @GetMapping with a fun handler', () => {
    const src = `
@GetMapping("/vets")
fun showVetList(model: MutableMap<String, Any>): String {
  return "vets"
}
`;
    const { nodes, references } = springResolver.extract!('VetController.kt', src);
    expect(nodes[0].name).toBe('GET /vets');
    expect(references[0].referenceName).toBe('showVetList');
    expect(nodes[0].language).toBe('kotlin');
  });

  it('joins a Kotlin class @RequestMapping prefix and skips a stacked annotation', () => {
    const src = `
@RestController
@RequestMapping("/owners")
class OwnerController {
  @GetMapping("/{ownerId}")
  @ResponseBody
  fun showOwner(@PathVariable ownerId: Int): String {
    return "owner"
  }
}
`;
    const { nodes, references } = springResolver.extract!('OwnerController.kt', src);
    expect(nodes[0].name).toBe('GET /owners/{ownerId}');
    expect(references[0].referenceName).toBe('showOwner');
  });
});

import { playResolver } from '../src/resolution/frameworks/play';
import { isSourceFile, isPlayRoutesFile } from '../src/extraction/grammars';

describe('playResolver.extract (conf/routes)', () => {
  it('extracts METHOD /path Controller.action routes, dropping the package + args', () => {
    const src = `# Routes
GET     /                    controllers.Application.index
GET     /computers           controllers.Application.list(p: Int ?= 0, s: Int ?= 2)
POST    /computers           controllers.Application.save
-> /v1/posts                 v1.post.PostRouter
`;
    const { nodes, references } = playResolver.extract!('conf/routes', src);
    expect(nodes.map((n) => n.name)).toEqual([
      'GET /',
      'GET /computers',
      'POST /computers',
    ]); // the `->` include is skipped
    expect(references.map((r) => r.referenceName)).toEqual([
      'Application.index',
      'Application.list',
      'Application.save',
    ]);
  });

  it('only runs on Play routes files', () => {
    expect(playResolver.extract!('app/Foo.scala', 'GET / controllers.X.y').nodes).toHaveLength(0);
  });
});

describe('Play routes file detection', () => {
  it('recognizes conf/routes (extensionless) and *.routes as source files', () => {
    expect(isPlayRoutesFile('conf/routes')).toBe(true);
    expect(isPlayRoutesFile('myapp/conf/routes')).toBe(true);
    expect(isPlayRoutesFile('conf/admin.routes')).toBe(true);
    expect(isSourceFile('conf/routes')).toBe(true);
    expect(isPlayRoutesFile('src/routes.ts')).toBe(false);
  });
});

import { goResolver } from '../src/resolution/frameworks/go';

describe('goResolver.extract', () => {
  it('extracts route from r.GET', () => {
    const src = `r.GET("/users", listUsers)\n`;
    const { nodes, references } = goResolver.extract!('main.go', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts route from router.HandleFunc', () => {
    const src = `router.HandleFunc("/items", createItem)\n`;
    const { nodes, references } = goResolver.extract!('main.go', src);
    expect(references[0].referenceName).toBe('createItem');
  });

  it('extracts gorilla/mux HandleFunc on a subrouter var, ignoring chained .Methods()', () => {
    // `s` is a PathPrefix().Subrouter() var — any receiver is matched; the
    // trailing .Methods("GET") doesn't break the handler capture.
    const src = `s.HandleFunc("/users/{id}", listUsers).Methods("GET")\n`;
    const { references } = goResolver.extract!('routes.go', src);
    expect(references[0].referenceName).toBe('listUsers');
  });
});

import { goframeResolver } from '../src/resolution/frameworks/goframe';

describe('goframeResolver', () => {
  it('detects GoFrame from a gogf/gf dependency in go.mod', () => {
    const ctx: any = {
      readFile: (f: string) =>
        f === 'go.mod' ? 'module example.com/app\nrequire github.com/gogf/gf/v2 v2.7.0\n' : null,
    };
    expect(goframeResolver.detect(ctx)).toBe(true);
    const noGf: any = { readFile: (f: string) => (f === 'go.mod' ? 'module example.com/app\n' : null) };
    expect(goframeResolver.detect(noGf)).toBe(false);
  });

  it('extracts a route node from a g.Meta request struct (method upper-cased)', () => {
    const src = `package v1
import "github.com/gogf/gf/v2/frame/g"
type SignInReq struct {
	g.Meta   \`path:"/user/sign-in" method:"post" tags:"User" summary:"Sign in"\`
	Passport string
}
type SignInRes struct{}
`;
    const { nodes } = goframeResolver.extract!('api/user/v1/user_sign_in.go', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('POST /user/sign-in');
    // The package-qualified request type is encoded for the synthesizer join.
    expect(nodes[0].qualifiedName).toContain('::goframe-route:v1.SignInReq');
  });

  it('is independent of g.Meta tag attribute order', () => {
    const src = `type DeptSearchReq struct {
	g.Meta \`path:"/dept/list" tags:"Dept" method:"get" summary:"列表"\`
}`;
    const { nodes } = goframeResolver.extract!('api/system/dept.go', src);
    expect(nodes[0].name).toBe('GET /dept/list');
    expect(nodes[0].qualifiedName).toContain('::goframe-route:DeptSearchReq');
  });

  it('skips a response g.Meta that has no path (mime-only) and other non-route metadata', () => {
    const src = `type ListRes struct {
	g.Meta \`mime:"application/json"\`
	Items []string
}`;
    const { nodes } = goframeResolver.extract!('api/x.go', src);
    expect(nodes).toHaveLength(0);
  });

  it('defaults method to ANY when method: is omitted', () => {
    const src = `type PingReq struct {
	g.Meta \`path:"/ping"\`
}`;
    const { nodes } = goframeResolver.extract!('api/ping.go', src);
    expect(nodes[0].name).toBe('ANY /ping');
  });

  it('extracts every request struct in a multi-route api file', () => {
    const src = `type DeptListReq struct { g.Meta \`path:"/dept/list" method:"get"\` }
type DeptListRes struct { g.Meta \`mime:"application/json"\` }
type DeptAddReq struct { g.Meta \`path:"/dept/add" method:"post"\` }
type DeptAddRes struct {}
`;
    const { nodes } = goframeResolver.extract!('api/dept.go', src);
    expect(nodes.map((n) => n.name).sort()).toEqual(['GET /dept/list', 'POST /dept/add']);
  });

  it('returns nothing for a non-go file or a file without g.Meta', () => {
    expect(goframeResolver.extract!('main.ts', 'const x = 1').nodes).toHaveLength(0);
    expect(goframeResolver.extract!('main.go', 'package main\nfunc main() {}\n').nodes).toHaveLength(0);
  });
});

import { rustResolver } from '../src/resolution/frameworks/rust';

describe('rustResolver.extract', () => {
  it('extracts route from axum .route with get()', () => {
    const src = `let app = Router::new().route("/users", get(list_users));\n`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts every method from a chained axum .route (get().put())', () => {
    const src = `let app = Router::new().route("/user", get(get_current_user).put(update_user));\n`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /user', 'PUT /user']);
    expect(references.map((r) => r.referenceName)).toEqual([
      'get_current_user',
      'update_user',
    ]);
  });

  it('extracts a multi-line axum .route with a namespaced handler', () => {
    const src = `
let app = Router::new()
    .route(
        "/articles/feed",
        get(listing::feed_articles),
    );
`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes[0].name).toBe('GET /articles/feed');
    expect(references[0].referenceName).toBe('feed_articles');
  });

  it('extracts actix web::resource().route(web::METHOD().to(handler))', () => {
    const src = `App::new().service(web::resource("/user/{id}").route(web::get().to(get_user)))\n`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes[0].name).toBe('GET /user/{id}');
    expect(references[0].referenceName).toBe('get_user');
  });

  it('extracts actix web::resource("/").to(handler) (all methods)', () => {
    const src = `App::new().service(web::resource("/").to(index))\n`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes[0].name).toBe('ANY /');
    expect(references[0].referenceName).toBe('index');
  });

  it('extracts actix App-level .route("/path", web::METHOD().to(handler))', () => {
    const src = `App::new().route("/health", web::get().to(health_check))\n`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes[0].name).toBe('GET /health');
    expect(references[0].referenceName).toBe('health_check');
  });
});

describe('rustResolver.resolve cargo workspace crates', () => {
  it('resolves crate name from workspace member lib.rs', () => {
    const workspaceCargo = `
[workspace]
members = ["crates/mytool-core", "crates/mytool-fetcher"]
`;
    const coreCargo = `
[package]
name = "mytool-core"
version = "0.1.0"
`;
    const libNode: Node = {
      id: 'module:crates/mytool-core/src/lib.rs:mytool_core:1',
      kind: 'module',
      name: 'mytool_core',
      qualifiedName: 'crates/mytool-core/src/lib.rs::mytool_core',
      filePath: 'crates/mytool-core/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const context = {
      getNodesInFile: (fp: string) => (fp === 'crates/mytool-core/src/lib.rs' ? [libNode] : []),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        p === 'Cargo.toml' ||
        p === 'crates/mytool-core/Cargo.toml' ||
        p === 'crates/mytool-core/src/lib.rs'
      ),
      readFile: (p: string) => {
        if (p === 'Cargo.toml') return workspaceCargo;
        if (p === 'crates/mytool-core/Cargo.toml') return coreCargo;
        return null;
      },
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        'crates/mytool-core/Cargo.toml',
        'crates/mytool-core/src/lib.rs',
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'fn:crates/mytool-fetcher/src/main.rs:main:1',
      referenceName: 'mytool_core',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-fetcher/src/main.rs',
      language: 'rust' as const,
    };

    const result = rustResolver.resolve(ref, context);
    expect(result?.targetNodeId).toBe(libNode.id);
    expect(result?.resolvedBy).toBe('framework');
    // Workspace-manifest hits are unambiguous and must beat name-matcher's
    // self-file matches (0.7) so cross-crate `imports` edges materialize.
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('resolves crate name from workspace member main.rs when lib.rs is absent', () => {
    const workspaceCargo = `
[workspace]
members = [
  "crates/mytool-runner",
]
`;
    const runnerCargo = `
[package]
name = "mytool-runner"
version = "0.1.0"
`;
    const mainNode: Node = {
      id: 'module:crates/mytool-runner/src/main.rs:mytool_runner:1',
      kind: 'module',
      name: 'mytool_runner',
      qualifiedName: 'crates/mytool-runner/src/main.rs::mytool_runner',
      filePath: 'crates/mytool-runner/src/main.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const context = {
      getNodesInFile: (fp: string) => (fp === 'crates/mytool-runner/src/main.rs' ? [mainNode] : []),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        p === 'Cargo.toml' ||
        p === 'crates/mytool-runner/Cargo.toml' ||
        p === 'crates/mytool-runner/src/main.rs'
      ),
      readFile: (p: string) => {
        if (p === 'Cargo.toml') return workspaceCargo;
        if (p === 'crates/mytool-runner/Cargo.toml') return runnerCargo;
        return null;
      },
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        'crates/mytool-runner/Cargo.toml',
        'crates/mytool-runner/src/main.rs',
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'fn:crates/mytool-runner/src/main.rs:main:1',
      referenceName: 'mytool_runner',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-runner/src/main.rs',
      language: 'rust' as const,
    };

    const result = rustResolver.resolve(ref, context);
    expect(result?.targetNodeId).toBe(mainNode.id);
    expect(result?.resolvedBy).toBe('framework');
  });

  it('resolves crate name when members uses a glob (crates/*)', () => {
    const workspaceCargo = `
[workspace]
members = ["crates/*"]
`;
    const fooCargo = `
[package]
name = "mytool-foo"
version = "0.1.0"
`;
    const barCargo = `
[package]
name = "mytool-bar"
version = "0.1.0"
`;
    const fooLib: Node = {
      id: 'module:crates/mytool-foo/src/lib.rs:mytool_foo:1',
      kind: 'module',
      name: 'mytool_foo',
      qualifiedName: 'crates/mytool-foo/src/lib.rs::mytool_foo',
      filePath: 'crates/mytool-foo/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const barLib: Node = {
      id: 'module:crates/mytool-bar/src/lib.rs:mytool_bar:1',
      kind: 'module',
      name: 'mytool_bar',
      qualifiedName: 'crates/mytool-bar/src/lib.rs::mytool_bar',
      filePath: 'crates/mytool-bar/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const filesByPath: Record<string, string> = {
      'Cargo.toml': workspaceCargo,
      'crates/mytool-foo/Cargo.toml': fooCargo,
      'crates/mytool-bar/Cargo.toml': barCargo,
    };
    const nodesByFile: Record<string, Node[]> = {
      'crates/mytool-foo/src/lib.rs': [fooLib],
      'crates/mytool-bar/src/lib.rs': [barLib],
    };
    const dirsByPath: Record<string, string[]> = {
      '.': ['crates'],
      crates: ['mytool-foo', 'mytool-bar'],
      'crates/mytool-foo': ['src'],
      'crates/mytool-bar': ['src'],
    };

    const context = {
      getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        Object.prototype.hasOwnProperty.call(filesByPath, p) ||
        Object.prototype.hasOwnProperty.call(nodesByFile, p)
      ),
      readFile: (p: string) => filesByPath[p] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
        ...Object.keys(nodesByFile),
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      listDirectories: (rel: string) => dirsByPath[rel] ?? [],
    };

    const fooRef = {
      fromNodeId: 'fn:crates/mytool-bar/src/lib.rs:other:1',
      referenceName: 'mytool_foo',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-bar/src/lib.rs',
      language: 'rust' as const,
    };
    const barRef = {
      fromNodeId: 'fn:crates/mytool-foo/src/lib.rs:other:1',
      referenceName: 'mytool_bar',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-foo/src/lib.rs',
      language: 'rust' as const,
    };

    expect(rustResolver.resolve(fooRef, context)?.targetNodeId).toBe(fooLib.id);
    expect(rustResolver.resolve(barRef, context)?.targetNodeId).toBe(barLib.id);
  });

  it('resolves crate name when members uses a name glob at root (helix-*)', () => {
    const workspaceCargo = `
[workspace]
members = ["helix-*"]
`;
    const coreCargo = `
[package]
name = "helix-core"
version = "0.1.0"
`;
    const coreLib: Node = {
      id: 'module:helix-core/src/lib.rs:helix_core:1',
      kind: 'module',
      name: 'helix_core',
      qualifiedName: 'helix-core/src/lib.rs::helix_core',
      filePath: 'helix-core/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const filesByPath: Record<string, string> = {
      'Cargo.toml': workspaceCargo,
      'helix-core/Cargo.toml': coreCargo,
    };
    const nodesByFile: Record<string, Node[]> = {
      'helix-core/src/lib.rs': [coreLib],
    };
    const dirsByPath: Record<string, string[]> = {
      '.': ['helix-core', 'docs', 'target'],
      'helix-core': ['src'],
    };

    const context = {
      getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        Object.prototype.hasOwnProperty.call(filesByPath, p) ||
        Object.prototype.hasOwnProperty.call(nodesByFile, p)
      ),
      readFile: (p: string) => filesByPath[p] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
        ...Object.keys(nodesByFile),
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      listDirectories: (rel: string) => dirsByPath[rel] ?? [],
    };

    const ref = {
      fromNodeId: 'fn:helix-core/src/lib.rs:other:1',
      referenceName: 'helix_core',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'helix-core/src/lib.rs',
      language: 'rust' as const,
    };

    expect(rustResolver.resolve(ref, context)?.targetNodeId).toBe(coreLib.id);
  });
});

import { aspnetResolver } from '../src/resolution/frameworks/csharp';

describe('aspnetResolver.extract', () => {
  it('extracts route from [HttpGet] attribute', () => {
    const src = `
[HttpGet("/users")]
public IActionResult ListUsers()
{
  return Ok();
}
`;
    const { nodes, references } = aspnetResolver.extract!('UserController.cs', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('ListUsers');
  });
});

import { vaporResolver } from '../src/resolution/frameworks/swift';

describe('vaporResolver.extract', () => {
  it('extracts route from app.get with use:', () => {
    const src = `app.get("users", use: listUsers)\n`;
    const { nodes, references } = vaporResolver.extract!('routes.swift', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts grouped RouteCollection routes with the group prefix and no path arg', () => {
    const src = `
func boot(routes: RoutesBuilder) throws {
    let todos = routes.grouped("todos")
    todos.get(use: index)
    todos.post(use: create)
    todos.group(":todoID") { todo in
        todo.delete(use: delete)
    }
}
`;
    const { nodes, references } = vaporResolver.extract!('TodoController.swift', src);
    expect(nodes.map((n) => n.name).sort()).toEqual([
      'DELETE /todos/:todoID',
      'GET /todos',
      'POST /todos',
    ]);
    expect(references.map((r) => r.referenceName).sort()).toEqual([
      'create',
      'delete',
      'index',
    ]);
  });

  it('handles use: self.handler and non-string path segments', () => {
    const src = `router.get("users", User.parameter, "edit", use: self.editUserHandler)\n`;
    const { nodes, references } = vaporResolver.extract!('UserController.swift', src);
    expect(nodes[0].name).toBe('GET /users/edit');
    expect(references[0].referenceName).toBe('editUserHandler');
  });

  it('ignores non-route .get calls that lack use: (e.g. Environment.get)', () => {
    const src = `let host = Environment.get("DATABASE_HOST") ?? "localhost"\n`;
    const { nodes } = vaporResolver.extract!('configure.swift', src);
    expect(nodes).toHaveLength(0);
  });
});

import { reactResolver } from '../src/resolution/frameworks/react';
import { svelteResolver } from '../src/resolution/frameworks/svelte';
import { astroResolver } from '../src/resolution/frameworks/astro';

describe('reactResolver.extract — React Router', () => {
  it('extracts a v6 <Route path element={<Comp/>}>', () => {
    const src = `<Route path="/users" element={<UsersPage/>}/>`;
    const { nodes, references } = reactResolver.extract!('App.tsx', src);
    const route = nodes.find((n) => n.kind === 'route');
    expect(route?.name).toBe('/users');
    expect(references[0]?.referenceName).toBe('UsersPage');
  });

  it('extracts a v5 <Route path component={Comp}> with attributes in any order', () => {
    const src = `<Route exact path="/login" component={Login} />`;
    const { nodes, references } = reactResolver.extract!('App.jsx', src);
    const route = nodes.find((n) => n.kind === 'route');
    expect(route?.name).toBe('/login');
    expect(references[0]?.referenceName).toBe('Login');
  });

  it('does not treat the <Routes> container as a route', () => {
    const src = `<Routes><Route path="/x" element={<X/>}/></Routes>`;
    const routes = reactResolver.extract!('App.tsx', src).nodes.filter((n) => n.kind === 'route');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.name).toBe('/x');
  });

  it('extracts createBrowserRouter object routes ({ path, element/Component })', () => {
    const src = `const router = createBrowserRouter([
      { path: "/dashboard", element: <Dashboard /> },
      { path: "/login", Component: Login },
    ]);`;
    const { nodes, references } = reactResolver.extract!('router.tsx', src);
    const routes = nodes.filter((n) => n.kind === 'route');
    expect(routes.map((n) => n.name).sort()).toEqual(['/dashboard', '/login']);
    expect(references.map((r) => r.referenceName).sort()).toEqual(['Dashboard', 'Login']);
  });

  it('does not treat config files or a nextjs-pages dir as Next.js routes', () => {
    const cfg = reactResolver.extract!('apps/nextjs-pages/next.config.mjs', 'export default {}');
    expect(cfg.nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
    const vite = reactResolver.extract!('src/pages/vite.config.ts', 'export default {}');
    expect(vite.nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
    // a real page still works
    const page = reactResolver.extract!('src/pages/about.tsx', 'export default function About(){return null}');
    expect(page.nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['/about']);
  });
});

describe('svelteResolver.extract (smoke)', () => {
  it('returns { nodes, references } shape', () => {
    const result = svelteResolver.extract!('+page.svelte', '');
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('references');
  });
});

describe('astroResolver.extract — src/pages file-based routing', () => {
  const routeNames = (filePath: string): string[] =>
    astroResolver.extract!(filePath, '').nodes.filter((n) => n.kind === 'route').map((n) => n.name);

  it('maps index.astro to /', () => {
    expect(routeNames('src/pages/index.astro')).toEqual(['/']);
  });

  it('maps nested index and plain pages', () => {
    expect(routeNames('src/pages/blog/index.astro')).toEqual(['/blog']);
    expect(routeNames('src/pages/about.astro')).toEqual(['/about']);
  });

  it('converts [param] and [...rest] syntax', () => {
    expect(routeNames('src/pages/blog/[slug].astro')).toEqual(['/blog/:slug']);
    expect(routeNames('src/pages/[...path].astro')).toEqual(['/*path']);
  });

  it('maps .ts endpoints under src/pages to routes', () => {
    expect(routeNames('src/pages/api/posts.ts')).toEqual(['/api/posts']);
    expect(routeNames('src/pages/rss.xml.js')).toEqual(['/rss.xml']);
  });

  it('excludes underscore-prefixed segments and config files', () => {
    expect(routeNames('src/pages/_partial.astro')).toEqual([]);
    expect(routeNames('src/pages/blog/_components/Card.astro')).toEqual([]);
    expect(routeNames('src/pages/vite.config.ts')).toEqual([]);
  });

  it('ignores .astro files outside src/pages', () => {
    expect(routeNames('src/components/Button.astro')).toEqual([]);
    expect(routeNames('docs/pages/guide.astro')).toEqual([]);
  });
});

describe('astroResolver.resolve — Astro global and virtual modules', () => {
  const ctx = {} as never;
  const baseRef = {
    fromNodeId: 'component:a',
    line: 1,
    column: 0,
    filePath: 'src/pages/index.astro',
    language: 'astro',
  };

  it('claims Astro.* global references as framework-provided', () => {
    const res = astroResolver.resolve(
      { ...baseRef, referenceName: 'Astro.props', referenceKind: 'references' } as never,
      ctx
    );
    expect(res?.resolvedBy).toBe('framework');
    expect(res?.confidence).toBe(1.0);
  });

  it('claims astro:content virtual module imports', () => {
    const res = astroResolver.resolve(
      { ...baseRef, referenceName: 'astro:content', referenceKind: 'imports' } as never,
      ctx
    );
    expect(res?.resolvedBy).toBe('framework');
  });

  it('leaves ordinary names alone', () => {
    const res = astroResolver.resolve(
      { ...baseRef, referenceName: 'astrolabe', referenceKind: 'calls' } as never,
      { getNodesByName: () => [] } as never
    );
    expect(res).toBeNull();
  });
});

// Regression tests: commented-out and docstring route examples must NOT
// surface as phantom route nodes. These would have failed before the
// strip-comments wiring (the regex would happily scan comments/docstrings).
describe('framework extractors ignore commented-out routes', () => {
  it('django: skips line-comment and docstring routes', () => {
    const src = `
# urls.py example:
# path('/admin/', AdminPanel.as_view())
"""
Other routing example:
    path('/users/', UserListView.as_view())
"""
urlpatterns = [path('/real/', RealView.as_view())]
`;
    const result = djangoResolver.extract!('app/urls.py', src);
    const urls = result.nodes.map((n) => n.name);
    expect(urls).toEqual(['/real/']);
  });

  it('flask: skips commented-out @app.route', () => {
    const src = `
# @app.route('/fake')
# def fake_view():
#     return ''

@app.route('/real')
def real_view():
    return ''
`;
    const { nodes, references } = flaskResolver.extract!('app.py', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['real_view']);
  });

  it('fastapi: skips docstring example routes', () => {
    const src = `
"""
Example:
    @app.get('/in-docstring')
    async def doc():
        pass
"""
@app.get('/real')
async def real_handler():
    return {}
`;
    const { nodes, references } = fastapiResolver.extract!('main.py', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['real_handler']);
  });

  it('express: skips // and /* */ commented routes', () => {
    const src = `
// app.get('/fake', fakeHandler);
/* router.post('/also-fake', otherHandler); */
app.get('/real', realHandler);
`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['realHandler']);
  });

  it('laravel: skips // # and /* */ commented Route::* calls', () => {
    const src = `<?php
// Route::get('/fake', [FakeController::class, 'index']);
# Route::get('/also-fake', 'FakeController@show');
/* Route::post('/another-fake', [X::class, 'y']); */
Route::get('/real', [RealController::class, 'index']);
`;
    const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['RealController@index']);
  });

  it('rails: skips =begin/=end and # commented routes', () => {
    const src = `
# get '/fake', to: 'fake#index'
=begin
get '/also-fake', to: 'fake#show'
=end
get '/real', to: 'real#index'
`;
    const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['real#index']);
  });

  it('spring: skips // and /* */ commented @GetMapping', () => {
    const src = `
// @GetMapping("/fake")
// public List<X> fake() { return null; }

/* @PostMapping("/also-fake")
   public void alsoFake() {} */

@GetMapping("/real")
public List<User> listUsers() { return users; }
`;
    const { nodes, references } = springResolver.extract!('UserController.java', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['listUsers']);
  });

  it('go: skips // and /* */ commented router.METHOD calls', () => {
    const src = `
// r.GET("/fake", fakeHandler)
/* r.POST("/also-fake", anotherHandler) */
r.GET("/real", listUsers)
`;
    const { nodes, references } = goResolver.extract!('main.go', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['listUsers']);
  });

  it('rust: skips // and nested /* */ commented .route() calls', () => {
    const src = `
// .route("/fake", get(fake_handler))
/* outer /* inner .route("/inner-fake", get(x)) */ still .route("/outer-fake", get(y)) */
let app = Router::new().route("/real", get(list_users));
`;
    const { nodes, references } = rustResolver.extract!('main.rs', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['list_users']);
  });

  it('aspnet: skips // and /* */ commented [HttpGet] attributes', () => {
    const src = `
// [HttpGet("/fake")]
// public IActionResult Fake() { return Ok(); }

/* [HttpPost("/also-fake")]
   public IActionResult AlsoFake() { return Ok(); } */

[HttpGet("/real")]
public IActionResult ListUsers() { return Ok(); }
`;
    const { nodes, references } = aspnetResolver.extract!('UserController.cs', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['ListUsers']);
  });

  it('vapor: skips // and /* */ commented app.METHOD calls', () => {
    const src = `
// app.get("fake", use: fakeHandler)
/* app.post("also-fake", use: anotherHandler) */
app.get("real", use: listUsers)
`;
    const { nodes, references } = vaporResolver.extract!('routes.swift', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
    expect(references.map((r) => r.referenceName)).toEqual(['listUsers']);
  });

  it('nestjs: skips // and /* */ commented decorators', () => {
    const src = `
@Controller('users')
export class UsersController {
  // @Get('fake')
  // fake() {}
  /* @Post('also-fake')
     alsoFake() {} */
  @Get('real')
  real() {}
}
`;
    const { nodes, references } = nestjsResolver.extract!('users.controller.ts', src);
    expect(nodes.map((n) => n.name)).toEqual(['GET /users/real']);
    expect(references.map((r) => r.referenceName)).toEqual(['real']);
  });
});
