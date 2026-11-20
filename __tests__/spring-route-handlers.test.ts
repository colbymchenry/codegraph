/**
 * A Spring route links the method its mapping annotation is written on (#851).
 *
 * The handler used to be found by a pattern that wanted `public`, `private` or
 * `protected` (or Kotlin's `fun`) before the name, so a package-private
 * method was skipped and the next method with a modifier took its route:
 * realworld-java21's controllers, which declare no modifiers, had most routes
 * pointing at the wrong method or at nothing. A method-level
 * `@RequestMapping(value = …, method = GET)` on such a method made no route.
 *
 * The route is also bound by position: of two overloads, the one the
 * annotation sits on, even when a tall annotation stack above it leaves the
 * other overload's declaration nearer the annotation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel, resetKernelForTests } from '../src/extraction/kernel';

const kernelBuilt = fs.existsSync(path.join(__dirname, '../codegraph-kernel/prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));

const POM = '<project><dependencies><dependency><groupId>org.springframework.boot</groupId>'
  + '<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n';

const ARTICLES = 'src/main/java/com/example/ArticleController.java';
const ARTICLES_SRC = `package com.example;

import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/articles")
class ArticleController {

    @GetMapping
    List<String> list() {
        return List.of();
    }

    @GetMapping("/{slug}")
    String get(@PathVariable String slug) {
        return slug;
    }

    @PostMapping
    void create(@RequestBody String body) {
    }

    @DeleteMapping("/{slug}")
    public void delete(@PathVariable String slug) {
    }

    @RequestMapping(value = "/feed", method = RequestMethod.GET)
    ResponseEntity<String> feed() {
        return null;
    }
}
`;

const SEARCH = 'src/main/java/com/example/SearchController.java';
const SEARCH_SRC = `package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
public class SearchController {
    @Operation(summary = "Find all")
    @ApiResponses({
        @ApiResponse(responseCode = "200"),
        @ApiResponse(responseCode = "404")
    })
    @GetMapping("/find")
    public String find() {
        return "all";
    }
    @GetMapping("/find/{id}")
    public String find(@PathVariable int id) {
        return "one";
    }
}
`;

const OWNERS = 'src/main/kotlin/com/example/OwnerController.kt';
const OWNERS_SRC = `package com.example

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/owners")
class OwnerController {
    @GetMapping("/{ownerId}")
    @ResponseBody
    fun showOwner(@PathVariable ownerId: Int): String = "owner"

    @GetMapping("/find")
    fun <T> find(): List<T> = emptyList()

    @PostMapping
    internal fun create(@RequestBody body: String): String {
        return body
    }
}
`;

/** The 1-based line of the first line of `src` that contains `needle`. */
function lineOf(src: string, needle: string): number {
  const at = src.split(/\r?\n/).findIndex((l) => l.includes(needle));
  expect(at, needle).toBeGreaterThanOrEqual(0);
  return at + 1;
}

describe.each(['native', 'wasm'].filter((backend) => backend === 'wasm' || kernelBuilt))(
  'Spring routes link the method they annotate (%s, #851)', (backend) => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_KERNEL', backend === 'wasm' ? '0' : '1');
    vi.stubEnv('CODEGRAPH_KERNEL_LANGS', 'all');
    resetKernelForTests();
    if (backend === 'native') expect(getKernel()).not.toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-851-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetKernelForTests();
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    cg = await CodeGraph.init(dir, { index: true });
    return cg;
  }

  /** Each route of `file` → its handler, as `name@startLine` (`-` for none). */
  function handlers(g: CodeGraph, file: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const route of g.getNodesInFile(file).filter((n) => n.kind === 'route')) {
      const targets = g.getOutgoingEdges(route.id)
        .filter((e) => e.kind === 'references')
        .map((e) => g.getNode(e.target)!)
        .map((t) => `${t.kind}:${t.name}@${t.startLine}`);
      out[route.name] = targets.length > 0 ? targets.join(',') : '-';
    }
    return out;
  }

  it('binds every route of a package-private controller to its own method', async () => {
    const g = await index({ 'pom.xml': POM, [ARTICLES]: ARTICLES_SRC });
    expect(handlers(g, ARTICLES)).toEqual({
      'GET /api/articles': `method:list@${lineOf(ARTICLES_SRC, 'List<String> list()') - 1}`,
      'GET /api/articles/{slug}': `method:get@${lineOf(ARTICLES_SRC, '@GetMapping("/{slug}")')}`,
      'POST /api/articles': `method:create@${lineOf(ARTICLES_SRC, '@PostMapping')}`,
      'DELETE /api/articles/{slug}': `method:delete@${lineOf(ARTICLES_SRC, '@DeleteMapping')}`,
      'GET /api/articles/feed': `method:feed@${lineOf(ARTICLES_SRC, '@RequestMapping(value = "/feed"')}`,
    });
  });

  it('binds each overload to the route written on it, under a tall annotation stack', async () => {
    const g = await index({ 'pom.xml': POM, [SEARCH]: SEARCH_SRC });
    expect(handlers(g, SEARCH)).toEqual({
      'GET /find': `method:find@${lineOf(SEARCH_SRC, '@Operation')}`,
      'GET /find/{id}': `method:find@${lineOf(SEARCH_SRC, '@GetMapping("/find/{id}")')}`,
    });
  });

  it('binds Kotlin handlers, generic and with modifiers', async () => {
    const g = await index({ 'pom.xml': POM, [OWNERS]: OWNERS_SRC });
    expect(handlers(g, OWNERS)).toEqual({
      'GET /owners/{ownerId}': `method:showOwner@${lineOf(OWNERS_SRC, '@GetMapping("/{ownerId}")')}`,
      'GET /owners/find': `method:find@${lineOf(OWNERS_SRC, '@GetMapping("/find")')}`,
      'POST /owners': `method:create@${lineOf(OWNERS_SRC, '@PostMapping')}`,
    });
  });
});
