/**
 * How a server-rendered endpoint answers, in the Steps picture.
 *
 * A Spring MVC handler answers by what it RETURNS — a view name, a constant
 * holding one, `"redirect:/owners/" + id` — which is no call at all, and a
 * Laravel controller by `view(…)` / `redirect(…)`, bare function calls that
 * name-matching used to bind to a same-named method or field somewhere in the
 * project. Either way the page it renders and the redirect it sends were
 * missing from the picture; only a 404 (a thrown exception) showed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars } from '../src/extraction/grammars';
import { returnsInSource } from '../src/graph/branch-guards';

beforeAll(async () => {
  await initGrammars();
});

const lineOf = (src: string, needle: string): number => src.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('returnsInSource', () => {
  const SRC = `@Controller
class OwnerController {
    private static final String VIEWS_FORM = "owners/createOrUpdateOwnerForm";
    @PostMapping("/owners/new")
    public String processCreationForm(@Valid Owner owner, BindingResult result) {
        if (result.hasErrors()) {
            return VIEWS_FORM;
        }
        list.forEach(x -> { return; });
        Runnable r = () -> { return "not-mine"; };
        Object o = new Object() { public String toString() { return "nested"; } };
        this.owners.save(owner);
        return "redirect:/owners/" + owner.getId();
    }
}
`;

  it("lists a method's own returns, a constant's value included, and none from lambdas or nested classes", async () => {
    const returns = await returnsInSource(SRC, 'java', lineOf(SRC, '@PostMapping'));
    expect(returns.map((r) => [r.line, r.expression, r.value])).toEqual([
      [lineOf(SRC, 'return VIEWS_FORM'), 'VIEWS_FORM', 'owners/createOrUpdateOwnerForm'],
      [lineOf(SRC, 'return "redirect'), '"redirect:/owners/" + owner.getId()', undefined],
    ]);
  });
});

// ---------------------------------------------------------------------------
// End to end: the replies an endpoint's Steps picture draws.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll } from 'vitest';
import { CodeGraph } from '../src';
import { loadAllGrammars } from '../src/extraction/grammars';
import { buildSteps } from '../src/ui-server/api/steps';
import { classifyEffect, responseStatus, implicitResponseStatus } from '../src/ui-server/api/effects';

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<{ cg: CodeGraph; root: string }> {
  await loadAllGrammars();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-steps-replies-'));
  projects.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { cg: await CodeGraph.init(root, { index: true }), root };
}

/** Each reply the route's picture draws, as `status · text · when`. */
async function replies(cg: CodeGraph, root: string, routeName: string): Promise<string[]> {
  const route = cg.getNodesByKind('route').find((n) => n.name === routeName);
  if (!route) throw new Error(`no route ${routeName}: ${cg.getNodesByKind('route').map((n) => n.name).join(', ')}`);
  const payload = await buildSteps(cg, root, new URLSearchParams({ anchor: route.id }));
  const replyIds = new Set(payload.steps.filter((s) => s.effect?.category === 'response').map((s) => s.id));
  return payload.links
    .filter((l) => replyIds.has(l.to))
    .flatMap((l) => l.sites.map((site) => `${site.status ?? '—'} · ${site.text}${site.when ? ` · WHEN ${site.when}` : ''}`))
    .sort();
}

const SPRING_POM = '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>';

describe('Spring MVC: a handler answers by what it returns', () => {
  it('draws the view it renders and the redirect it sends, each under its condition', async () => {
    const { cg, root } = await project({
      'pom.xml': SPRING_POM,
      'src/main/java/app/owner/OwnerController.java': `package app.owner;
@Controller
class OwnerController {
    private static final String VIEWS_FORM = "owners/createOrUpdateOwnerForm";
    @PostMapping("/owners/new")
    public String processCreationForm(Owner owner, BindingResult result) {
        if (result.hasErrors()) {
            return VIEWS_FORM;
        }
        return "redirect:/owners/" + owner.getId();
    }
    @GetMapping("/owners/{ownerId}")
    public ModelAndView showOwner(@PathVariable int ownerId) {
        ModelAndView mav = new ModelAndView("owners/ownerDetails");
        return mav;
    }
    @GetMapping("/owners/legacy")
    public RedirectView legacy() {
        return new RedirectView("/owners");
    }
}
`,
      'src/main/java/app/owner/StatusController.java': `package app.owner;
@RestController
class StatusController {
    @GetMapping("/status")
    public String status() { return "ok"; }
}
`,
    });
    try {
      expect(await replies(cg, root, 'POST /owners/new')).toEqual([
        '200 · view owners/createOrUpdateOwnerForm · WHEN result.hasErrors()',
        '302 · redirect:/owners/${…} · WHEN !result.hasErrors()',
      ]);
      expect((await replies(cg, root, 'GET /owners/{ownerId}')).map((r) => r.split(' · ')[0])).toEqual(['200']);
      expect((await replies(cg, root, 'GET /owners/legacy')).map((r) => r.split(' · ')[0])).toEqual(['302']);
      // A @RestController's String is its body, not a view name: nothing is read into it.
      expect(await replies(cg, root, 'GET /status')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe('Laravel: view() and redirect() are replies, not calls into the project', () => {
  it("draws the page a controller renders and the redirect it sends — and binds neither to a same-named member", async () => {
    const { cg, root } = await project({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
      'routes/web.php': "<?php\nRoute::get('/books/{slug}', [BookController::class, 'show']);\nRoute::post('/books', [BookController::class, 'store']);\n",
      'app/Http/Controllers/BookController.php': `<?php
class BookController {
    public function show(string $slug) {
        $book = Book::findBySlug($slug);
        if (is_null($book)) {
            return redirect('/books');
        }
        return view('books.show', ['book' => $book]);
    }
    public function store() {
        return redirect()->back()->withErrors(['name' => 'required']);
    }
}
`,
      // Same-named members elsewhere: name matching used to bind the helpers to these.
      'app/Http/Controllers/DocsController.php': '<?php\nclass DocsController { public function redirect() { return 1; } }\n',
      'app/Views/Block.php': '<?php\nclass Block { public $view; }\n',
      'app/Models/View.php': '<?php\nclass View { public static function incrementFor($x) {} }\n',
    });
    try {
      // (PHP has no condition rules yet, so the replies carry no WHEN.)
      expect(await replies(cg, root, 'GET /books/{slug}')).toEqual(['200 · view', '302 · redirect']);
      expect((await replies(cg, root, 'POST /books')).map((r) => r.split(' · ')[0])).toEqual(['302']);
      const show = cg.getNodesByKind('method').find((n) => n.name === 'show')!;
      const bound = cg.getCallees(show.id).map((c) => `${c.node.kind} ${c.node.name}`);
      expect(bound).not.toContain('method redirect');
      expect(bound).not.toContain('field view');
      expect(bound).not.toContain('class View');
    } finally {
      cg.close();
    }
  });

  it('still binds $this->method() and a project helper function', async () => {
    const { cg } = await project({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
      'app/helpers.php': '<?php\nfunction format_title($t) { return ucfirst($t); }\n',
      'app/Http/Controllers/PageController.php': `<?php
class PageController {
    public function show() {
        $this->setTitle(format_title('x'));
    }
    protected function setTitle($t) {}
}
`,
    });
    try {
      const show = cg.getNodesByKind('method').find((n) => n.name === 'show')!;
      expect(cg.getCallees(show.id).map((c) => `${c.node.kind} ${c.node.name}`).sort()).toEqual(['function format_title', 'method setTitle']);
    } finally {
      cg.close();
    }
  });
});

describe('reply classification', () => {
  const php = (text: string) => classifyEffect({ text, kind: 'calls', language: 'php', project: 'api' })?.category ?? null;
  const status = (text: string, args: string | null = null) => responseStatus(text, args) ?? implicitResponseStatus(text);

  it("reads Laravel's reply chains with their argument lists stripped, and their statuses", () => {
    for (const t of ['view', 'redirect', 'redirect()->route', 'redirect()->back()->withErrors', 'back', 'to_route', 'response()->json', 'response()->noContent']) {
      expect([t, php(t)]).toEqual([t, 'response']);
    }
    expect(['redirect()->route', 'redirect()->back()->withErrors', 'back()->with', 'to_route'].map((t) => status(t))).toEqual([302, 302, 302, 302]);
    expect(status('view')).toBe(200);
    expect(status('response()->json')).toBe(200);
    expect(php('$this->view')).toBeNull();
  });

  it("keeps PHP's programming-error exceptions out of the replies, namespaced or not, and namespaced HTTP ones in", () => {
    const thrown = (text: string) => classifyEffect({ text, kind: 'instantiates', language: 'php', project: 'api' })?.category ?? null;
    expect(thrown('InvalidArgumentException')).toBeNull();
    expect(thrown('\\InvalidArgumentException')).toBeNull();
    expect(thrown('\\LogicException')).toBeNull();
    expect(thrown('NotFoundException')).toBe('response');
    expect(thrown('\\Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException')).toBe('response');
  });

  it("reads Spring's ModelAndView and RedirectView", () => {
    const jvm = (text: string) => classifyEffect({ text, kind: 'instantiates', language: 'java', project: 'api' })?.category ?? null;
    expect(jvm('ModelAndView')).toBe('response');
    expect(jvm('RedirectView')).toBe('response');
    expect(status('ModelAndView', '"owners/ownerDetails"')).toBe(200);
    expect(status('ModelAndView', '"redirect:/owners"')).toBe(302);
    expect(status('RedirectView', '"/owners"')).toBe(302);
  });
});
