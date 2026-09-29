/**
 * A Spring or Laravel test reaches a controller by URL, never by a call —
 * MockMvc's `perform(post("/owners/new"))`, Laravel's `$this->postJson('api/me')`
 * — so every controller those suites exercise used to read as untested: the
 * viewer's "No test reaches this" and explore's `tests:` line both walk
 * callers. The test-request pass links each test's request to the route it
 * reaches, and the route's own edge reaches the handler.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';
import { buildNode } from '../src/ui-server/api/node';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<{ cg: CodeGraph; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-requests-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { cg: await CodeGraph.init(root, { index: true }), root };
}

/** Every test-request edge as `test → route`. */
function requests(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const route of cg.getNodesByKind('route')) {
    for (const { node, edge } of cg.getCallers(route.id)) {
      if ((edge.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'test-request') {
        out.push(`${node.name} → ${route.name}`);
      }
    }
  }
  return out.sort();
}

const method = (cg: CodeGraph, name: string): Node => {
  const n = cg.getNodesByKind('method').find((m) => m.name === name);
  if (!n) throw new Error(`no method ${name}`);
  return n;
};

const SPRING_POM = '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>';

const SPRING_CONTROLLER = `package app.owner;
import org.springframework.web.bind.annotation.*;
@Controller
class OwnerController {
    @GetMapping("/owners/new")
    public String initCreationForm() { return "owners/form"; }
    @PostMapping("/owners/new")
    public String processCreationForm() { return "redirect:/owners"; }
    @GetMapping("/owners/{ownerId}/edit")
    public String initUpdateOwnerForm(@PathVariable int ownerId) { return "owners/form"; }
    @GetMapping("/owners")
    public String processFindForm() { return "owners/list"; }
}
`;

describe('Spring tests reach their controllers', () => {
  it('links MockMvc requests to their routes, URI templates and query strings included', async () => {
    const { cg } = await indexed({
      'pom.xml': SPRING_POM,
      'src/main/java/app/owner/OwnerController.java': SPRING_CONTROLLER,
      'src/test/java/app/owner/OwnerControllerTests.java': `package app.owner;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
class OwnerControllerTests {
    private MockMvc mockMvc;
    void testProcessCreationFormSuccess() throws Exception {
        mockMvc.perform(post("/owners/new").param("firstName", "Joe")).andExpect(status().is3xxRedirection());
    }
    void testInitUpdateOwnerForm() throws Exception {
        mockMvc.perform(get("/owners/{ownerId}/edit", 1)).andExpect(status().isOk());
    }
    void testFindByPage() throws Exception {
        mockMvc.perform(get("/owners?page=1")).andExpect(status().isOk());
    }
}
`,
    });
    try {
      expect(requests(cg)).toEqual([
        'testFindByPage → GET /owners',
        'testInitUpdateOwnerForm → GET /owners/{ownerId}/edit',
        'testProcessCreationFormSuccess → POST /owners/new',
      ]);
    } finally {
      cg.close();
    }
  });

  it('turns the badge: the handler is reached by the test file, two hops up', async () => {
    const { cg, root } = await indexed({
      'pom.xml': SPRING_POM,
      'src/main/java/app/owner/OwnerController.java': SPRING_CONTROLLER,
      'src/test/java/app/owner/OwnerControllerTests.java': `package app.owner;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
class OwnerControllerTests {
    void creates() throws Exception { mockMvc.perform(post("/owners/new")); }
}
`,
    });
    try {
      const view = (await buildNode(cg, root, method(cg, 'processCreationForm').id)) as {
        tests: { reached: boolean; hops: number; files: string[] };
      };
      expect(view.tests.reached).toBe(true);
      expect(view.tests.hops).toBe(2);
      expect(view.tests.files).toEqual(['src/test/java/app/owner/OwnerControllerTests.java']);
      // An untested handler still says so.
      const untested = (await buildNode(cg, root, method(cg, 'processFindForm').id)) as { tests: { reached: boolean } };
      expect(untested.tests.reached).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('reads WebTestClient, TestRestTemplate, RestAssured and the Kotlin MockMvc DSL', async () => {
    const { cg } = await indexed({
      'pom.xml': SPRING_POM,
      'src/main/java/app/owner/OwnerController.java': SPRING_CONTROLLER,
      'src/test/java/app/owner/ClientTests.java': `package app.owner;
class ClientTests {
    void viaWebTestClient() { webTestClient.get().uri("/owners/{ownerId}/edit", 7).exchange(); }
    void viaRestTemplate() { restTemplate.getForEntity("/owners", String.class); }
    void viaExchange() { restTemplate.exchange("/owners/new", HttpMethod.POST, entity, String.class); }
    void viaRestAssured() { given().contentType("json").when().get("/owners/new").then().statusCode(200); }
}
`,
      'src/test/kotlin/app/owner/OwnerDslTests.kt': `package app.owner
class OwnerDslTests {
    fun viaKotlinDsl() { mockMvc.post("/owners/new") { param("name", "x") } }
}
`,
    });
    try {
      expect(requests(cg)).toEqual([
        'viaExchange → POST /owners/new',
        'viaKotlinDsl → POST /owners/new',
        'viaRestAssured → GET /owners/new',
        'viaRestTemplate → GET /owners',
        'viaWebTestClient → GET /owners/{ownerId}/edit',
      ]);
    } finally {
      cg.close();
    }
  });

  it('reads nothing without MockMvc builders, outside tests, or where a hole would stand for a literal', async () => {
    const { cg } = await indexed({
      'pom.xml': SPRING_POM,
      'src/main/java/app/owner/OwnerController.java': SPRING_CONTROLLER,
      // A test helper that happens to be called get(): no MockMvcRequestBuilders import.
      'src/test/java/app/owner/HelperTests.java': `package app.owner;
class HelperTests {
    String get(String key) { return key; }
    void usesHelper() { get("/owners/new"); }
}
`,
      // Production code is never a test source, whatever it calls.
      'src/main/java/app/owner/Client.java': `package app.owner;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
class Client { void send() { mockMvc.perform(post("/owners/new")); } }
`,
      // `{ownerId}` is a hole: it fills a parameter, never the literal `new`.
      'src/test/java/app/owner/HoleTests.java': `package app.owner;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
class HoleTests { void showsOwner() { mockMvc.perform(get("/owners/{ownerId}", 1)); } }
`,
    });
    try {
      expect(requests(cg)).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

const LARAVEL = {
  artisan: '#!/usr/bin/env php\n<?php\n',
  'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
  'routes/api.php': `<?php
Route::post('me', [AuthController::class, 'login']);
Route::delete('songs/{song}', [SongController::class, 'destroy']);
Route::put('songs/{song}/rating', [SongController::class, 'rate']);
Route::get('settings', [SettingController::class, 'show']);
`,
  'routes/web.php': `<?php
Route::get('/books/{slug}', [BookController::class, 'show']);
Route::get('/about', [PageController::class, 'about']);
`,
  'app/Http/Controllers/AuthController.php': '<?php\nclass AuthController { public function login() {} }\n',
  'app/Http/Controllers/SongController.php': '<?php\nclass SongController { public function destroy() {} public function rate() {} }\n',
  'app/Http/Controllers/BookController.php': '<?php\nclass BookController { public function show() {} }\n',
  'app/Http/Controllers/PageController.php': '<?php\nclass PageController { public function about() {} }\n',
  'app/Http/Controllers/SettingController.php': '<?php\nclass SettingController { public function show() {} }\n',
};

describe('Laravel tests reach their controllers', () => {
  it("links $this requests — Json, chained helpers, json() / call(), interpolation and concatenation", async () => {
    const { cg } = await indexed({
      ...LARAVEL,
      'tests/Feature/SongTest.php': `<?php
class SongTest extends TestCase {
    public function testLogin() { $this->postJson('api/me', ['email' => 'a@b.c']); }
    public function testDelete() { $this->actingAs($user)->json('DELETE', 'api/songs/1'); }
    public function testRate() { $this->withToken($t)->put("api/songs/{$song->id}/rating", []); }
    public function testRateAgain() { $this->put("api/songs/$song->public_id/rating", []); }
    public function testBook() { $this->get('/books/' . $book->slug)->assertOk(); }
}
`,
    });
    try {
      expect(requests(cg)).toEqual([
        'testBook → GET /books/{slug}',
        'testDelete → DELETE /api/songs/{song}',
        'testLogin → POST /api/me',
        'testRate → PUT /api/songs/{song}/rating',
        'testRateAgain → PUT /api/songs/{song}/rating',
      ]);
    } finally {
      cg.close();
    }
  });

  it("follows the project's own request helpers (koel's getAs → jsonAs → $this->json), and nothing else named for a verb", async () => {
    const { cg } = await indexed({
      ...LARAVEL,
      'tests/Concerns/MakesHttpRequests.php': `<?php
trait MakesHttpRequests {
    private function jsonAs($user, string $method, $uri, array $data = []) {
        return $this->withToken('t')->json($method, $uri, $data);
    }
    protected function postAs(string $url, array $data, $user = null) { return $this->jsonAs($user, 'post', $url, $data); }
    protected function getFixture(string $name) { return file_get_contents(__DIR__ . '/' . $name); }
}
`,
      'tests/Feature/AuthTest.php': `<?php
class AuthTest extends TestCase {
    use MakesHttpRequests;
    public function testLoginViaHelper() { $this->postAs('api/me', []); }
    public function testFixtureIsNotARequest() { $this->getFixture('settings'); }
}
`,
    });
    try {
      expect(requests(cg)).toEqual(['testLoginViaHelper → POST /api/me']);
    } finally {
      cg.close();
    }
  });

  it("links Pest's helpers from the test file, and ignores container lookups, route() names and app code", async () => {
    const { cg } = await indexed({
      ...LARAVEL,
      'tests/Feature/AboutTest.php': `<?php
use function Pest\\Laravel\\{get};
it('shows the about page', function () {
    get('/about')->assertOk();
});
`,
      'tests/Feature/NotRequestsTest.php': `<?php
class NotRequestsTest extends TestCase {
    public function testContainer() { $this->app->get('settings'); }
    public function testNamedRoute() { $this->get(route('about')); }
}
`,
      'app/Services/Proxy.php': "<?php\nclass Proxy { public function run() { $this->get('/about'); } }\n",
    });
    try {
      expect(requests(cg)).toEqual(['AboutTest.php → GET /about']);
    } finally {
      cg.close();
    }
  });

  it("keeps test requests out of a route's fan-in, so a well-tested endpoint is never a hub", async () => {
    const tests = Array.from({ length: 45 }, (_, i) => `    public function testAbout${i}() { $this->get('/about'); }`).join('\n');
    const { cg } = await indexed({
      ...LARAVEL,
      'tests/Feature/ManyTest.php': `<?php\nclass ManyTest extends TestCase {\n${tests}\n}\n`,
    });
    try {
      const route = cg.getNodesByKind('route').find((n) => n.name === 'GET /about')!;
      expect(requests(cg).filter((r) => r.endsWith('GET /about'))).toHaveLength(45);
      expect(cg.getFanIn([route.id]).get(route.id) ?? 0).toBeLessThan(5);
    } finally {
      cg.close();
    }
  });
});
