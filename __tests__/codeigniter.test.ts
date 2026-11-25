/**
 * CodeIgniter 3: routes by convention and from routes.php, and the calls that
 * go through the properties `$this->load` fills in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { codeigniterResolver } from '../src/resolution/frameworks/codeigniter';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import type { ResolutionContext } from '../src/resolution/types';

const extract = (file: string, source: string) => codeigniterResolver.extract!(file, source);
const routeNames = (file: string, source: string): string[] => extract(file, source).nodes.map((n) => n.name);

describe('routes from a controller', () => {
  const controller = `<?php
class Blog extends MY_Controller {
    public function __construct() { parent::__construct(); }
    public function index() {}
    public function view($id) {}
    function comments() {}
    public static function feed() {}
    protected function guard() {}
    private function load_post() {}
    public function _remap() {}
    public function _hidden() {}
}
`;

  it('takes every public method, an implicit one too, and keeps underscored ones off the web', () => {
    expect(routeNames('application/controllers/Blog.php', controller)).toEqual([
      'ANY /blog', 'ANY /blog/view', 'ANY /blog/comments', 'ANY /blog/feed',
    ]);
  });

  it('builds the URL from the folder and lower-cases it', () => {
    expect(routeNames('application/controllers/admin/Blog.php', controller)).toContain('ANY /admin/blog/view');
    expect(routeNames('sub/dir/application/controllers/Blog.php', controller)).toContain('ANY /blog/view');
  });

  it('reads HMVC modules, with the controller named after its module at the module\'s URL', () => {
    expect(routeNames('application/modules/blog/controllers/Blog.php', controller)).toContain('ANY /blog/view');
    expect(routeNames('application/modules/shop/controllers/Blog.php', controller)).toContain('ANY /shop/blog/view');
    expect(routeNames('bonfire/modules/shop/controllers/Blog.php', controller)).toContain('ANY /shop/blog/view');
  });

  it('skips a file whose class is not the one it is named after, and an abstract one', () => {
    expect(routeNames('application/controllers/Other.php', controller)).toEqual([]);
    expect(routeNames('application/controllers/Base.php', '<?php\nabstract class Base extends CI_Controller {\n  public function index() {}\n}\n')).toEqual([]);
  });

  it('ignores a method in a comment, and every other file', () => {
    expect(routeNames('application/controllers/Blog.php', '<?php\nclass Blog {\n  // public function gone() {}\n  /* public function older() {} */\n  public function kept() {}\n}\n')).toEqual(['ANY /blog/kept']);
    expect(routeNames('application/models/Blog.php', controller)).toEqual([]);
  });
});

describe('routes from routes.php', () => {
  const file = 'application/config/routes.php';

  it('reads a route, a verb-scoped one, and the default controller at /', () => {
    expect(routeNames(file, `<?php
$route['default_controller'] = 'welcome';
$route['404_override'] = 'errors/missing';
$route['translate_uri_dashes'] = FALSE;
$route['product/(:num)'] = 'catalog/lookup/$1';
$route['api/users']['post'] = 'api/users/create';
`)).toEqual(['ANY /', 'ANY /product/(:num)', 'POST /api/users']);
  });

  it('skips a route in a comment, and one a closure computes', () => {
    expect(routeNames(file, `<?php
// $route['old'] = 'old/index';
$route['drinks/(:any)'] = function ($type) { return 'catalog/drinks/' . strtolower($type); };
`)).toEqual([]);
  });

  it('reads a module\'s own routes file', () => {
    expect(routeNames('application/modules/shop/config/routes.php', "<?php\n$route['shop/sale'] = 'shop/items/sale';\n")).toEqual(['ANY /shop/sale']);
  });
});

describe('detecting a CodeIgniter project', () => {
  const context = (files: Record<string, string>): ResolutionContext =>
    ({
      fileExists: (f: string) => f in files,
      getAllFiles: () => Object.keys(files),
      readFile: (f: string) => files[f] ?? null,
    }) as unknown as ResolutionContext;

  it('goes by the framework\'s own file, or by a routes file that names a default controller', () => {
    expect(codeigniterResolver.detect(context({ 'system/core/CodeIgniter.php': '' }))).toBe(true);
    expect(codeigniterResolver.detect(context({ 'application/config/routes.php': "<?php\n$route['default_controller'] = 'welcome';\n" }))).toBe(true);
    expect(codeigniterResolver.detect(context({ 'htdocs/application/config/routes.php': '<?php\n$route["default_controller"] = "welcome";\n' }))).toBe(true);
  });

  it('takes no other project\'s routes file for one', () => {
    expect(codeigniterResolver.detect(context({ 'application/config/routes.php': "<?php\nreturn ['home' => 'index'];\n" }))).toBe(false);
    expect(codeigniterResolver.detect(context({ 'app/Config/Routes.php': "<?php\n$routes->get('/', 'Home::index');\n" }))).toBe(false);
    expect(codeigniterResolver.detect(context({ 'routes/web.php': '<?php\n' }))).toBe(false);
  });
});

describe('a CodeIgniter project, indexed', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const calls = (from: string, inFile: string): string[] => {
    const node = cg.getNodesInFile(inFile).find((n) => n.name === from && n.kind === 'method');
    if (!node) throw new Error(`no ${from} in ${inFile}`);
    return cg.getCallees(node.id).map((c) => `${c.node.qualifiedName} @${c.node.filePath}`).sort();
  };

  const routeTarget = (name: string): string | undefined => {
    const route = cg.getNodesByKind('route').find((n) => n.name === name);
    if (!route) throw new Error(`no route ${name}`);
    return cg.getOutgoingEdges(route.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)?.qualifiedName)[0];
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codeigniter-'));
    write('application/config/routes.php', `<?php
$route['default_controller'] = 'welcome';
$route['profile/(:num)'] = 'users/show/$1';
$route['reports/(summary_:any)'] = 'admin/reports/$1';
$route['sale'] = 'shop/items/sale';
$route['board'] = 'dashboard';
$route['gone'] = 'nowhere/index';
`);
    write('application/controllers/Welcome.php', '<?php\nclass Welcome extends CI_Controller {\n  public function index() {}\n}\n');
    write('application/controllers/Users.php', `<?php
class Users extends MY_Controller {
    public function __construct() {
        parent::__construct();
        $this->load->model('user_model');
        $this->load->model('Order_model');
        $this->load->model('shop/mdl_items', 'items');
        $this->load->library('mailer');
    }
    public function show($id) {
        $user = $this->user_model->find($id);
        $this->user_model->save($user);
        $this->Order_model->find($id);
        $this->items->price($id);
        $this->mailer->welcome($user);
        $this->load->view('users/show', ['user' => $user]);
    }
    public function missing() {
        $this->user_model->no_such_method();
        $this->nothing_loaded->find();
        $this->db->get('users');
    }
}
`);
    write('application/controllers/admin/Reports.php', '<?php\nclass Reports extends MY_Controller {\n  public function index() {}\n}\n');
    write('application/core/MY_Model.php', '<?php\nclass MY_Model extends CI_Model {\n  public function save($row) { return $row; }\n}\n');
    write('application/models/User_model.php', '<?php\nclass User_model extends MY_Model {\n  public function find($id) { return $id; }\n}\n');
    write('application/models/Order_model.php', '<?php\nclass Order_model extends MY_Model {\n  public function find($id) { return $id; }\n}\n');
    write('application/libraries/Mailer.php', `<?php
class Mailer {
    protected $CI;
    public function __construct() { $this->CI =& get_instance(); }
    public function welcome($user) {
        $this->CI->user_model->find($user);
        $CI =& get_instance();
        $CI->user_model->save($user);
    }
}
`);
    write('application/views/users/show.php', "<?php echo $this->mailer->welcome('x'); ?>\n");
    write('application/modules/shop/controllers/Items.php', `<?php
class Items extends MX_Controller {
    public function sale() { return $this->mdl_items->price(1); }
}
`);
    write('application/modules/shop/models/Mdl_items.php', '<?php\nclass Mdl_Items extends MY_Model {\n  public function price($id) { return $id; }\n}\n');
    write('application/modules/dashboard/controllers/Dashboard.php', '<?php\nclass Dashboard extends MX_Controller {\n  public function index() {\n    $this->load->view(\'overview\');\n  }\n}\n');
    write('application/modules/dashboard/views/overview.php', '<p>overview</p>\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binds a convention route to its method, and a routes.php one to what it names', () => {
    expect(routeTarget('ANY /users/show')).toBe('Users::show');
    expect(routeTarget('ANY /shop/items/sale')).toBe('Items::sale');
    expect(routeTarget('ANY /dashboard')).toBe('Dashboard::index');
    expect(routeTarget('ANY /')).toBe('Welcome::index');
    expect(routeTarget('ANY /profile/(:num)')).toBe('Users::show');
    expect(routeTarget('ANY /sale')).toBe('Items::sale');
    expect(routeTarget('ANY /board')).toBe('Dashboard::index');
  });

  it('binds a route whose method is a variable to the controller, and leaves one with no controller alone', () => {
    expect(routeTarget('ANY /reports/(summary_:any)')).toBe('Reports');
    expect(routeTarget('ANY /gone')).toBeUndefined();
  });

  it('links a call through a property to that class\'s method, not to any method of that name', () => {
    expect(calls('show', 'application/controllers/Users.php')).toEqual(expect.arrayContaining([
      'User_model::find @application/models/User_model.php',
      'Order_model::find @application/models/Order_model.php',
    ]));
  });

  it('follows a method up to the class it is inherited from', () => {
    expect(calls('show', 'application/controllers/Users.php')).toContain('MY_Model::save @application/core/MY_Model.php');
  });

  it('reads a library\'s property, and a class whose case differs from its file', () => {
    expect(calls('show', 'application/controllers/Users.php')).toContain('Mailer::welcome @application/libraries/Mailer.php');
    expect(calls('sale', 'application/modules/shop/controllers/Items.php')).toEqual(['Mdl_Items::price @application/modules/shop/models/Mdl_items.php']);
  });

  it('reads an alias from the load that gives it', () => {
    expect(calls('show', 'application/controllers/Users.php')).toContain('Mdl_Items::price @application/modules/shop/models/Mdl_items.php');
  });

  it('reads a library\'s way to the controller, through get_instance()', () => {
    expect(calls('welcome', 'application/libraries/Mailer.php')).toEqual([
      'MY_Model::save @application/core/MY_Model.php',
      'User_model::find @application/models/User_model.php',
    ]);
  });

  it('links nothing for a method the class does not have, or a property nothing fills', () => {
    expect(calls('missing', 'application/controllers/Users.php')).toEqual([]);
  });

  it('links a loaded view to its file, in the app or the caller\'s module, and on to what the view calls', () => {
    const show = cg.getNodesInFile('application/controllers/Users.php').find((n) => n.name === 'show')!;
    const view = cg.getCallees(show.id).find((c) => c.node.kind === 'file');
    expect(view?.node.filePath).toBe('application/views/users/show.php');
    expect(cg.getCallees(view!.node.id).map((c) => c.node.name)).toContain('welcome');

    const index = cg.getNodesInFile('application/modules/dashboard/controllers/Dashboard.php').find((n) => n.name === 'index')!;
    expect(cg.getCallees(index.id).map((c) => c.node.filePath)).toEqual(['application/modules/dashboard/views/overview.php']);
  });

  it('connects a request end to end for a question in the app\'s own names', () => {
    const flow = resolveNamedSymbolFlow(cg, 'Users.show Mailer.welcome User_model.find');
    expect(flow.chains[0]?.steps.map((step) => step.node.qualifiedName)).toEqual(['Users::show', 'Mailer::welcome', 'User_model::find']);
  });
});

describe('a sync of a CodeIgniter project', () => {
  it('binds a route when its controller arrives, and a call when its model does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codeigniter-sync-'));
    const write = (rel: string, content: string): void => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    write('application/config/routes.php', "<?php\n$route['default_controller'] = 'welcome';\n$route['read/(:num)'] = 'blog/view/$1';\n");
    write('application/controllers/Welcome.php', `<?php
class Welcome extends CI_Controller {
    public function index() { $this->post_model->latest(); }
}
`);
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const route = (): string | undefined => {
      const node = cg.getNodesByKind('route').find((n) => n.name === 'ANY /read/(:num)')!;
      return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)?.qualifiedName)[0];
    };
    const index = (): string[] => {
      const node = cg.getNodesInFile('application/controllers/Welcome.php').find((n) => n.name === 'index')!;
      return cg.getCallees(node.id).map((c) => c.node.qualifiedName);
    };
    expect(route()).toBeUndefined();
    expect(index()).toEqual([]);

    write('application/controllers/Blog.php', '<?php\nclass Blog extends CI_Controller {\n  public function view($id) {}\n}\n');
    write('application/models/Post_model.php', '<?php\nclass Post_model extends CI_Model {\n  public function latest() {}\n}\n');
    await cg.sync();
    expect(route()).toBe('Blog::view');
    expect(index()).toEqual(['Post_model::latest']);

    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
