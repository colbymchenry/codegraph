/**
 * Dead code and islands (CG-59).
 *
 * Two halves, both against a real indexed fixture: the derivation in
 * `src/graph/dead-code.ts`, and the `/api/deadcode` endpoint that renders it
 * over a real loopback server, like the rest of the viewer's API suite.
 *
 * The fixture is shaped to produce, deliberately, one of each thing the report
 * has to get RIGHT BY NOT CLAIMING IT:
 *
 * - a genuinely unreferenced helper (the only row that should survive);
 * - a same-name pair where the resolver attaches the call to the wrong one —
 *   the mis-resolution that makes a used method look unreached;
 * - a method that overrides a base's, reached only through the base;
 * - a decorated method, registered by a framework the graph cannot see;
 * - a helper only a template mentions, so no edge records the use but the file
 *   text does;
 * - an exported function nothing here calls, which an outside caller may.
 *
 * Every one of those must be OFF the list, and the reason must be counted.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import {
  buildDeadCodeReport,
  isHeaderFile,
  isImplicitEntryName,
  isTestScope,
  isVendoredPath,
  mentionCount,
  DEAD_CODE_KINDS,
} from '../src/graph/dead-code';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;
let cg: CodeGraph;

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function request(requestPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: requestPath,
        method: 'GET',
        headers: { Host: `127.0.0.1:${server.port}` },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            type: res.headers['content-type'],
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getDeadCode(query = ''): Promise<any> {
  const res = await request(`/api/deadcode${query}`);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(200);
  return JSON.parse(res.body);
}

const names = (report: { entries: Array<{ node: { name: string } }> }): string[] =>
  report.entries.map((entry) => entry.node.name);

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deadcode-'));
  projectRoot = path.join(tempDir, 'project');

  // The one genuinely dead symbol, plus a live one beside it so the file is
  // reached and the island rule does not swallow the whole thing.
  write(
    projectRoot,
    'src/util.ts',
    `export function used(value: string): string {
  return value.trim();
}

function neverCalledAnywhere(value: string): string {
  return value.toUpperCase();
}

function alsoDeadButSmaller(): number {
  return 1;
}

// Exported and never called here — an outside caller may import it, so the
// default list must not claim it. It lives in a REACHED file on purpose: an
// unreached file is an island, which is a different exclusion.
export function publicEntryPoint(): string {
  return 'hello';
}
`
  );

  // The mis-resolution: \`Facade.load\` calls \`this.inner.load()\`, and the
  // resolver prefers a same-name definition in the call site's own file. One of
  // the two ends up with no incoming edge and neither is unreferenced.
  write(
    projectRoot,
    'src/inner.ts',
    `export class Inner {
  load(): string {
    return 'inner';
  }
}
`
  );

  // A base and an override: calls land on \`Base.run\`, never on \`Child.run\`.
  write(
    projectRoot,
    'src/base.ts',
    `export class Base {
  run(): string {
    return 'base';
  }
}
`
  );
  write(
    projectRoot,
    'src/child.ts',
    `import { Base } from './base';

export class Child extends Base {
  run(): string {
    return 'child';
  }
}
`
  );

  write(
    projectRoot,
    'src/facade.ts',
    `import { Inner } from './inner';
import { Base } from './base';
import { Child } from './child';
import { used } from './util';

function register(target: unknown, key: string): void {
  void target;
  void key;
}

export class Facade {
  inner = new Inner();
  child = new Child();

  load(): string {
    return this.inner.load();
  }

  go(): string {
    const base: Base = this.child;
    return used(base.run()) + this.load();
  }

  @register
  onEvent(): void {
    void 0;
  }
}
`
  );

  // Mentioned in a template but never called anywhere the graph can see: the
  // corroboration pass has to find the second mention in this file's own text.
  write(
    projectRoot,
    'src/handlers.ts',
    `export function mountHandlers(): string {
  return TEMPLATE;
}

function onSubmit(): void {
  void 0;
}

const TEMPLATE = '<form onsubmit="onSubmit()"></form>';
`
  );

  // Nothing imports this file at all: its symbols' zero fan-in describes the
  // file, not the symbol. That is the island rule, and it is the Map's job.
  write(
    projectRoot,
    'src/orphan.ts',
    `function strandedHelper(): string {
  return 'nobody imports this file';
}

function alsoStranded(): number {
  return strandedHelper().length;
}
`
  );

  write(
    projectRoot,
    'src/index.ts',
    `import { Facade } from './facade';
import { mountHandlers } from './handlers';

export function start(): string {
  return new Facade().go() + mountHandlers();
}
`
  );

  // A test helper file with a dependent, so `includeTests` is what decides
  // whether its dead symbol shows — not the island rule.
  write(
    projectRoot,
    'tests/helpers.ts',
    `export function sharedHelper(): string {
  return 'shared';
}

function helperNothingCalls(): void {
  void 0;
}
`
  );
  write(
    projectRoot,
    'tests/facade.test.ts',
    `import { Facade } from '../src/facade';
import { sharedHelper } from './helpers';

export function testFacade(): string {
  return new Facade().go() + sharedHelper();
}
`
  );

  const init = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', 'tests/**/*.ts'], exclude: [] },
  });
  await init.indexAll();
  init.resolveReferences();
  init.close();

  cg = CodeGraph.openSync(projectRoot);

  const viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });
}, 120_000);

afterAll(async () => {
  cg?.close();
  api?.close();
  await server?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('buildDeadCodeReport', () => {
  it('finds the symbol nothing references', () => {
    const report = buildDeadCodeReport(cg);
    expect(names(report)).toContain('neverCalledAnywhere');
  });

  it('leaves nothing on the list that anything reaches', () => {
    const report = buildDeadCodeReport(cg);
    // `used`, `start`, `go` and `mountHandlers` are all called; `Inner.load`
    // and `Facade.load` are the same-name pair; `Child.run` is an override.
    for (const name of ['used', 'start', 'go', 'mountHandlers', 'load', 'run']) {
      expect(names(report)).not.toContain(name);
    }
  });

  it('excludes a symbol only its own file mentions, and counts it', () => {
    const report = buildDeadCodeReport(cg);
    expect(names(report)).not.toContain('onSubmit');
    expect(report.excluded.mentioned).toBeGreaterThan(0);
    expect(report.corroborated).toBe(true);
  });

  it('makes the claim when corroboration is switched off', () => {
    // The rule that catches `onSubmit` is the only one that reads a file, so
    // turning it off has to be visible in BOTH the list and the flag.
    const report = buildDeadCodeReport(cg, { readSource: null });
    expect(report.corroborated).toBe(false);
    expect(report.excluded.mentioned).toBe(0);
    expect(names(report)).toContain('onSubmit');
  });

  it('excludes exported symbols by default and includes them on request', () => {
    const strict = buildDeadCodeReport(cg);
    expect(names(strict)).not.toContain('publicEntryPoint');
    expect(strict.excluded.exported).toBeGreaterThan(0);
    expect(strict.includeExported).toBe(false);

    const wide = buildDeadCodeReport(cg, { includeExported: true });
    expect(names(wide)).toContain('publicEntryPoint');
    expect(wide.includeExported).toBe(true);
    expect(wide.excluded.exported).toBe(0);
  });

  it('excludes test files by default and includes them on request', () => {
    expect(names(buildDeadCodeReport(cg))).not.toContain('helperNothingCalls');
    expect(buildDeadCodeReport(cg).excluded.tests).toBeGreaterThan(0);
    expect(names(buildDeadCodeReport(cg, { includeTests: true }))).toContain(
      'helperNothingCalls'
    );
  });

  it('says nothing about a file nothing in the index reaches', () => {
    // An island's symbols have zero fan-in because the FILE is unreached, which
    // is a fact about the file — the Map draws it, this list does not claim it.
    const report = buildDeadCodeReport(cg, { includeExported: true });
    expect(names(report)).not.toContain('strandedHelper');
    expect(report.excluded.unreachableFile).toBeGreaterThan(0);
  });

  it('excludes a decorated member — a framework registers it', () => {
    const report = buildDeadCodeReport(cg);
    expect(names(report)).not.toContain('onEvent');
    expect(report.excluded.decorated).toBeGreaterThan(0);
  });

  it('ranks by size and reports the real total when capped', () => {
    const full = buildDeadCodeReport(cg);
    const sizes = full.entries.map((entry) => entry.lines);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);

    const capped = buildDeadCodeReport(cg, { limit: 1 });
    expect(capped.entries).toHaveLength(1);
    expect(capped.total).toBe(full.total);
    // The cap trims the tail, not the head: the biggest finding survives.
    expect(capped.entries[0]?.node.name).toBe(full.entries[0]?.node.name);
  });

  it('every exclusion count is a number of candidates, and they add up', () => {
    const report = buildDeadCodeReport(cg);
    const excluded = Object.values(report.excluded).reduce((sum, n) => sum + n, 0);
    expect(report.candidates).toBeGreaterThan(0);
    expect(excluded + report.entries.length).toBeLessThanOrEqual(report.candidates);
    expect(report.bounded).toBe(false);
  });

  it('restricts to the kinds asked for, and ignores nonsense', () => {
    const classesOnly = buildDeadCodeReport(cg, { kinds: ['class'] });
    expect(classesOnly.kinds).toEqual(['class']);
    for (const entry of classesOnly.entries) expect(entry.node.kind).toBe('class');

    // An unknown kind is not a 500 and not an empty list: it falls back to the
    // default set, which is the answer the caller meant.
    const nonsense = buildDeadCodeReport(cg, { kinds: ['banana' as never] });
    expect(nonsense.kinds).toEqual([...DEAD_CODE_KINDS]);
  });
});

describe('the rules that are pure', () => {
  it('counts whole-identifier mentions only', () => {
    expect(mentionCount('const load = 1; loader(); reload();', 'load')).toBe(1);
    expect(mentionCount('a.load(); load();', 'load')).toBe(2);
    expect(mentionCount('nothing here', 'load')).toBe(0);
    // Stops early: the caller only ever needs to know "one, or more than one".
    expect(mentionCount('x x x x x', 'x', 2)).toBe(2);
  });

  it('matches vendored directories as whole segments', () => {
    expect(isVendoredPath('vendor/lib/a.go')).toBe(true);
    expect(isVendoredPath('a/node_modules/b/c.js')).toBe(true);
    expect(isVendoredPath('src/vendored-parser.ts')).toBe(false);
  });

  it('recognises headers as declaration surfaces', () => {
    expect(isHeaderFile('src/tree_sitter/parser.h')).toBe(true);
    expect(isHeaderFile('types/global.d.ts')).toBe(true);
    expect(isHeaderFile('src/parser.c')).toBe(false);
  });

  it('recognises a test scope inside a file', () => {
    expect(isTestScope('tests::row_sizes_match')).toBe(true);
    expect(isTestScope('Fixtures.Tests.Helper')).toBe(true);
    expect(isTestScope('Latest.value')).toBe(false);
  });

  it('recognises names the language calls by itself', () => {
    expect(isImplicitEntryName('constructor')).toBe(true);
    expect(isImplicitEntryName('__enter__')).toBe(true);
    expect(isImplicitEntryName('ToString')).toBe(true);
    expect(isImplicitEntryName('mainHandler')).toBe(false);
  });
});

describe('GET /api/deadcode', () => {
  it('groups the rows by file and keeps the totals honest', async () => {
    const payload = await getDeadCode();
    expect(payload.rows.total).toBe(payload.rows.items.length);
    expect(payload.rows.shown).toBe(payload.rows.items.length);

    // Every count equals a list length in the same payload.
    const grouped = payload.groups.reduce((sum: number, g: any) => sum + g.rows.length, 0);
    expect(grouped).toBe(payload.rows.shown);

    const files = payload.groups.map((g: any) => g.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain('src/util.ts');
  });

  it('carries the exclusions with their own wording', async () => {
    const payload = await getDeadCode();
    expect(payload.excluded.length).toBeGreaterThan(0);
    for (const entry of payload.excluded) {
      expect(entry.count).toBeGreaterThan(0);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
    }
    const sum = payload.excluded.reduce((n: number, e: any) => n + e.count, 0);
    expect(payload.excludedTotal).toBe(sum);
    expect(payload.candidates).toBeGreaterThanOrEqual(payload.excludedTotal);
    expect(payload.corroborated).toBe(true);
  });

  it('widens on ?exported=1 and says which list it answered', async () => {
    const strict = await getDeadCode();
    const wide = await getDeadCode('?exported=1');
    expect(strict.includeExported).toBe(false);
    expect(wide.includeExported).toBe(true);
    expect(wide.rows.total).toBeGreaterThan(strict.rows.total);
    expect(wide.rows.items.some((r: any) => r.name === 'publicEntryPoint')).toBe(true);
  });

  it('honours ?limit= without lying about the total', async () => {
    const full = await getDeadCode();
    const capped = await getDeadCode('?limit=1');
    expect(capped.rows.items).toHaveLength(1);
    expect(capped.rows.total).toBe(full.rows.total);
    expect(capped.rows.truncated).toBe(full.rows.total > 1);
  });

  it('is listed on the API index', async () => {
    const res = await request('/api');
    const body = JSON.parse(res.body);
    expect(body.endpoints.some((e: any) => e.path === '/api/deadcode')).toBe(true);
  });
});

describe('GET /api/map — generated files and islands', () => {
  it('reports how many of a module’s files are tool-generated', async () => {
    const res = await request('/api/map');
    const payload = JSON.parse(res.body);
    for (const module of payload.modules) {
      expect(typeof module.generated).toBe('number');
      expect(module.generated).toBeLessThanOrEqual(module.files);
      // The dimmed rows are drawn from `fileList.items`, so the generated
      // subset has to be a subset of exactly that list.
      for (const file of module.generatedFiles) {
        expect(module.fileList.items).toContain(file);
      }
    }
  });
});

describe('an ancestor outside the index (#1973)', () => {
  let root: string;
  let graph: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deadcode-external-'));
    write(
      root,
      'src/clock.tsx',
      `import React from 'react';
import { Transform } from 'stream';
import { OnModuleInit } from '@nestjs/common';
export class Clock extends React.Component { componentDidMount() {} render() { return null; } }
export class Upper extends Transform { _transform(c, e, cb) { cb(null, c); } }
export class Boot implements OnModuleInit { onModuleInit() {} }
export class Ticker extends Clock { componentDidUpdate() {} }
export class Third extends Ticker { componentWillUnmount() {} componentDidCatch() {} }
export class Plain { neverCalledMember() {} }
function reallyUnused() {}
`
    );
    write(root, 'src/main.ts', `import { Clock, Upper, Boot, Ticker, Third, Plain } from './clock';\nexport const all = [Clock, Upper, Boot, Ticker, Third, Plain];\n`);
    graph = CodeGraph.initSync(root, { config: { include: ['src/**/*.ts', 'src/**/*.tsx'], exclude: [] } });
    await graph.indexAll();
  }, 60_000);

  afterEach(() => {
    graph?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not list members a framework base class calls', () => {
    const report = buildDeadCodeReport(graph);
    for (const name of ['componentDidMount', 'componentWillUnmount', 'render', '_transform', 'onModuleInit']) {
      expect(names(report)).not.toContain(name);
    }
    // A project class whose own ancestor extends an external base inherits the doubt.
    expect(names(report)).not.toContain('componentDidUpdate');
    expect(names(report)).not.toContain('componentDidCatch');
    expect(report.excluded.overriding).toBeGreaterThanOrEqual(7);
  });

  it('still lists what nothing reaches outside such a class', () => {
    const report = buildDeadCodeReport(graph);
    expect(names(report)).toContain('reallyUnused');
    expect(names(report)).toContain('neverCalledMember');
  });
});

describe('a framework that calls members by name', () => {
  let root: string;
  let graph: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deadcode-by-name-'));
    // Three components that write the interface out: together they are the
    // index's own record of what Angular's `OnInit` carries. The third inherits
    // `ngOnInit` rather than declaring it, and lacks the `refresh` the other
    // two happen to share.
    write(
      root,
      'src/app/first.component.ts',
      `import { Component, OnInit } from '@angular/core';

@Component({ selector: 'app-first', template: '' })
export class FirstComponent implements OnInit {
  ngOnInit(): void {}
  refresh(): void {}
}
`
    );
    write(
      root,
      'src/app/second.component.ts',
      `import { AfterViewInit, Component, OnInit } from '@angular/core';

@Component({ selector: 'app-second', template: '' })
export class SecondComponent implements OnInit, AfterViewInit {
  ngOnInit(): void {}
  ngAfterViewInit(): void {}
  reload(): void {}
  refresh(): void {}
}
`
    );
    write(
      root,
      'src/app/base-page.ts',
      `import { Directive } from '@angular/core';

@Directive()
export abstract class BasePage {
  ngOnInit(): void {
    void 0;
  }
}
`
    );
    write(
      root,
      'src/app/third.component.ts',
      `import { Component, OnInit } from '@angular/core';
import { BasePage } from './base-page';

@Component({ selector: 'app-third', template: '' })
export class ThirdComponent extends BasePage implements OnInit {}
`
    );
    // Writes no `implements` clause. Angular calls `ngOnInit` all the same.
    write(
      root,
      'src/app/demo.component.ts',
      `import { Component, HostListener } from '@angular/core';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  ngOnInit(): void {
    void 0;
  }

  @HostListener('window:keyup', ['$event'])
  keyEvent(event: KeyboardEvent): void {
    void event;
  }

  reload(): void {
    void 0;
  }

  refresh(): void {
    void 0;
  }

  unusedHelper(): number {
    return 1;
  }
}
`
    );
    // No decorator, so no framework registers it: the name alone is no evidence.
    write(root, 'src/app/plain.ts', `export class Plain {\n  ngOnInit(): void {\n    void 0;\n  }\n}\n`);
    write(
      root,
      'src/api/cron.service.ts',
      `import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class CronService {
  @Cron('0 * * * *')
  runEveryHour(): void {
    void 0;
  }

  @OnEvent('portfolio.changed')
  handlePortfolioChanged(): void {
    void 0;
  }

  hasCurrencyPair(): boolean {
    return false;
  }
}
`
    );
    write(
      root,
      'src/main.ts',
      `import { FirstComponent } from './app/first.component';
import { SecondComponent } from './app/second.component';
import { ThirdComponent } from './app/third.component';
import { DemoComponent } from './app/demo.component';
import { Plain } from './app/plain';
import { CronService } from './api/cron.service';

export const declarations = [FirstComponent, SecondComponent, ThirdComponent, DemoComponent, Plain, CronService];
`
    );
    // Java checks the interface itself: Spring calls `afterPropertiesSet` on a
    // bean that implements InitializingBean, never on one that only has the name.
    for (const bean of ['FirstBean', 'SecondBean']) {
      write(
        root,
        `src/main/java/demo/${bean}.java`,
        `package demo;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.stereotype.Component;

@Component
public class ${bean} implements InitializingBean {
  public void afterPropertiesSet() {}
}
`
      );
    }
    write(
      root,
      'src/main/java/demo/LooseBean.java',
      `package demo;

import org.springframework.stereotype.Component;

@Component
public class LooseBean {
  public void afterPropertiesSet() {}
}
`
    );
    write(
      root,
      'src/main/java/demo/App.java',
      `package demo;

public class App {
  public static void main(String[] args) {
    new FirstBean();
    new SecondBean();
    new LooseBean();
  }
}
`
    );
    graph = CodeGraph.initSync(root, {
      config: { include: ['src/**/*.ts', 'src/**/*.java'], exclude: [] },
    });
    await graph.indexAll();
  }, 60_000);

  afterAll(() => {
    graph?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const listed = (report: ReturnType<typeof buildDeadCodeReport>, qualifiedName: string): boolean =>
    report.entries.some((entry) => entry.node.qualifiedName === qualifiedName);

  it('does not list a method whose decorator resolves outside the index', () => {
    for (const readSource of [undefined, null] as const) {
      const report = buildDeadCodeReport(graph, readSource === null ? { readSource } : {});
      expect(listed(report, 'DemoComponent::keyEvent')).toBe(false);
      expect(listed(report, 'CronService::runEveryHour')).toBe(false);
      expect(listed(report, 'CronService::handlePortfolioChanged')).toBe(false);
      expect(report.excluded.decorated).toBeGreaterThanOrEqual(3);
    }
  });

  it('does not list a hook its class fills by name, without writing the interface', () => {
    for (const readSource of [undefined, null] as const) {
      const report = buildDeadCodeReport(graph, readSource === null ? { readSource } : {});
      expect(listed(report, 'DemoComponent::ngOnInit')).toBe(false);
      // The base a component inherits the hook from is reached the same way.
      expect(listed(report, 'BasePage::ngOnInit')).toBe(false);
      expect(report.excluded.hooks).toBe(2);
    }
  });

  it('still lists what nothing reaches in a class a framework registers', () => {
    const report = buildDeadCodeReport(graph);
    // A decorator on the class is not evidence for each of its members.
    expect(listed(report, 'DemoComponent::unusedHelper')).toBe(true);
    expect(listed(report, 'CronService::hasCurrencyPair')).toBe(true);
    // One implementer is not a contract: `reload` is only SecondComponent's.
    expect(listed(report, 'DemoComponent::reload')).toBe(true);
    // Two implementers sharing a method is no contract while a third lacks it.
    expect(listed(report, 'DemoComponent::refresh')).toBe(true);
    // Nothing registers an undecorated class.
    expect(listed(report, 'Plain::ngOnInit')).toBe(true);
  });

  it('infers a contract only where the interface has no runtime effect', () => {
    // Java has no export marker in the index, so ask for the exported list,
    // where every other rule still runs.
    const report = buildDeadCodeReport(graph, { includeExported: true });
    expect(listed(report, 'demo::LooseBean::afterPropertiesSet')).toBe(true);
    expect(listed(report, 'DemoComponent::ngOnInit')).toBe(false);
  });
});

describe('a declaration that merges into a type outside the index', () => {
  let root: string;
  let graph: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deadcode-ambient-'));
    // ghostfolio's chart.registry.ts: chart.js reads both interfaces through
    // the types they extend, and nothing in the repository names either.
    write(
      root,
      'src/chart.registry.ts',
      `import { Chart, Tooltip, type ChartType } from 'chart.js';

interface VerticalHoverLinePluginOptions {
  color?: string;
}

declare module 'chart.js' {
  interface PluginOptionsByType<TType extends ChartType> {
    verticalHoverLine: TType extends 'line' ? VerticalHoverLinePluginOptions : never;
  }
  interface TooltipPositionerMap {
    top: (items: unknown[]) => { x: number; y: number };
  }
}

export function registerChartConfiguration(): void {
  Chart.register(Tooltip);
}

function unusedChartHelper(): void {}
`
    );
    // angular-realworld's app.config.ts, with a Node.js augmentation beside it.
    write(
      root,
      'src/app.config.ts',
      `declare global {
  interface Window {
    __conduit_debug__?: { token(): string | null };
  }
  namespace NodeJS {
    interface ProcessEnv {
      API_URL?: string;
    }
  }
}

// In a module file this namespace is the file's own: it merges with nothing.
declare namespace Settings {
  interface NotMergedAnywhere {
    retries: number;
  }
}

export const appConfig = { providers: [] };
`
    );
    write(
      root,
      'src/main.ts',
      `import { registerChartConfiguration } from './chart.registry';
import { appConfig } from './app.config';

registerChartConfiguration();
export const config = appConfig;
`
    );
    graph = CodeGraph.initSync(root, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await graph.indexAll();
  }, 60_000);

  afterAll(() => {
    graph?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const merged = ['PluginOptionsByType', 'TooltipPositionerMap', 'Window', 'ProcessEnv'];

  it('does not list what a declare module or declare global block declares', () => {
    for (const readSource of [undefined, null] as const) {
      const report = buildDeadCodeReport(graph, readSource === null ? { readSource } : {});
      for (const name of merged) expect(names(report)).not.toContain(name);
      // TypeScript exports them without the keyword, so the exported rule
      // takes them, and counts them.
      expect(report.excluded.exported).toBe(merged.length);
    }
  });

  it('lists them with the outside-reach caveat when exported symbols are asked for', () => {
    const report = buildDeadCodeReport(graph, { includeExported: true });
    for (const name of merged) {
      expect(report.entries.find((entry) => entry.node.name === name)?.exported).toBe(true);
    }
  });

  it('still lists what nothing reaches beside them', () => {
    const report = buildDeadCodeReport(graph);
    expect(names(report)).toContain('unusedChartHelper');
    expect(names(report)).toContain('NotMergedAnywhere');
  });
});
