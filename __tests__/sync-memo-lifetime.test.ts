/**
 * A resolver lives as long as its CodeGraph, and a long-lived one (`serve --mcp`,
 * a watcher) syncs again and again. What it remembers per context has to go
 * with the caches it was read through, or an edit is resolved by what the
 * file said before it: and the answer goes into the index, where a restart
 * doesn't undo it until the file is edited again.
 *
 * Each case indexes the first tree, edits it and syncs on that one object, and
 * compares edges and unresolved references with a full index of the final tree
 * in a folder of its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';

type Files = Record<string, string>;

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-memo-lifetime-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

async function index(root: string): Promise<CodeGraph> {
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** Every edge by its ends' natural keys, and every reference left unresolved. */
function stateOf(root: string, graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = graph.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column}`);
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const refs = (db.getDb()
      .prepare('SELECT reference_name, reference_kind, file_path, line, col, status FROM unresolved_refs')
      .all() as Array<Record<string, unknown>>)
      .map((r) => `ref ${r.file_path}:${r.line}:${r.col} ${r.reference_kind} ${r.reference_name} ${r.status}`);
    return [...edges, ...refs].sort();
  } finally {
    db.close();
  }
}

/** Index `before`, write `after` over it, sync on the same object; the state, and a full index's of the final tree. */
async function syncEdit(before: Files, after: Files): Promise<{ state: string[]; full: string[] }> {
  const root = tempRoot();
  write(root, before);
  const graph = await index(root);
  write(root, after);
  await graph.sync();
  const fullRoot = tempRoot();
  write(fullRoot, { ...before, ...after });
  return { state: stateOf(root, graph), full: stateOf(fullRoot, await index(fullRoot)) };
}

const held = (state: string[], text: string): string[] => state.filter((line) => line.includes(text));

const goBuilt = (tag: string, value: string): string => `//go:build ${tag}\n\npackage app\n\nfunc sep() string { return "${value}" }\n`;
const GO_CALLER = 'package app\n\nfunc Join() string { return sep() }\n';
const GO_CALLER_EDITED = 'package app\n\n// edited\nfunc Join() string { return sep() }\n';

describe('a sync on one object resolves an edit as a fresh index does', () => {
  it('Go: a file changes the targets it builds for', async () => {
    const { state, full } = await syncEdit(
      { 'go.mod': 'module example.com/app\n\ngo 1.22\n', 'sep_a.go': goBuilt('unix', '/'), 'sep_b.go': goBuilt('!unix', 'x'), 'main.go': GO_CALLER },
      { 'sep_a.go': goBuilt('!unix', '/'), 'sep_b.go': goBuilt('unix', 'x'), 'main.go': GO_CALLER_EDITED }
    );
    expect(held(state, 'calls function main.go:Join')[0]).toContain('sep_b.go');
    expect(state).toEqual(full);
  }, 120_000);

  it('Go: a twin for another target appears', async () => {
    const { state, full } = await syncEdit(
      { 'go.mod': 'module example.com/app\n\ngo 1.22\n', 'sep_a.go': goBuilt('!unix', 'x'), 'main.go': GO_CALLER },
      { 'sep_b.go': goBuilt('unix', '/'), 'main.go': GO_CALLER_EDITED }
    );
    expect(held(state, 'calls function main.go:Join')[0]).toContain('sep_b.go');
    expect(state).toEqual(full);
  }, 120_000);

  it('Vue: a component\'s `<script setup>` becomes a `<script>` that exports', async () => {
    const { state, full } = await syncEdit(
      {
        'package.json': '{"name":"app"}',
        'Comp.vue': '<script setup lang="ts">\nfunction helper() { return 1; }\n</script>\n<template><div/></template>\n',
        'use.ts': 'export function run() { return helper(); }\n',
      },
      {
        'Comp.vue': '<script lang="ts">\nexport function helper() { return 1; }\n</script>\n<template><div/></template>\n',
        'use.ts': '// edited\nexport function run() { return helper(); }\n',
      }
    );
    expect(held(state, 'Comp.vue:helper').some((line) => line.startsWith('calls'))).toBe(true);
    expect(state).toEqual(full);
  }, 120_000);

  it('Objective-C: a property changes its class', async () => {
    const FOO = '@interface Foo : NSObject\n- (void)run;\n@end\n';
    const BAZ = '@interface Baz : NSObject\n- (void)run;\n@end\n';
    const holder = (type: string): string => `#import "Foo.h"\n#import "Baz.h"\n@interface Holder : NSObject\n@property (nonatomic) ${type} *thing;\n@end\n`;
    const { state, full } = await syncEdit(
      {
        'Foo.h': FOO,
        'Foo.m': '#import "Foo.h"\n@implementation Foo\n- (void)run {}\n@end\n',
        'Baz.h': BAZ,
        'Baz.m': '#import "Baz.h"\n@implementation Baz\n- (void)run {}\n@end\n',
        'Holder.h': holder('Foo'),
        'Holder.m': '#import "Holder.h"\n@implementation Holder\n- (void)go { [self.thing run]; }\n@end\n',
      },
      {
        'Holder.h': holder('Baz'),
        'Holder.m': '#import "Holder.h"\n// edited\n@implementation Holder\n- (void)go { [self.thing run]; }\n@end\n',
      }
    );
    expect(held(state, 'calls method Holder.m').some((line) => line.includes('Baz'))).toBe(true);
    expect(state).toEqual(full);
  }, 120_000);

  it('Objective-C: a namesake class appears beside the caller', async () => {
    const declares = (type: string): string =>
      `#import "Gadgets.h"\n@interface ViewController : OFObject\n@property (weak, nonatomic) ${type} *view1;\n@end\n`;
    const caller = (extra: string): string =>
      `#import "ViewController.h"\n${extra}@implementation ViewController\n- (void)load\n{\n\t[self.view1 refresh];\n}\n@end\n`;
    const { state, full } = await syncEdit(
      {
        'Shared/Gadgets.h': '@interface Widget : OFObject\n- (void)refresh;\n@end\n@interface Gadget : OFObject\n- (void)refresh;\n@end\n',
        'Shared/Gadgets.m': '#import "Gadgets.h"\n@implementation Widget\n- (void)refresh { }\n@end\n@implementation Gadget\n- (void)refresh { }\n@end\n',
        'A/ViewController.h': declares('Widget'),
        'B/ViewController.m': caller(''),
      },
      { 'B/ViewController.h': declares('Gadget'), 'B/ViewController.m': caller('// edited\n') }
    );
    expect(held(state, 'B/ViewController.m:ViewController::load').some((line) => line.includes('Gadget::refresh'))).toBe(true);
    expect(state).toEqual(full);
  }, 120_000);

  it('a file binds a browser global it used to read', async () => {
    const { state, full } = await syncEdit(
      {
        'package.json': '{"name":"app"}',
        'a.js': 'export function f() { return history.back(); }\n',
        'hist.js': 'export class History { back() { return 1; } }\n',
      },
      { 'a.js': 'export function f(history) { return history.back(); }\n' }
    );
    expect(state).toEqual(full);
  }, 120_000);

  it('C++: a function template\'s specializations trade places', async () => {
    const head = (first: string, second: string): string =>
      `template <typename T> int read();\ntemplate <> int read<${first}>() { return 1; }\ntemplate <> int read<${second}>() { return 2; }\n`;
    const { state, full } = await syncEdit(
      { 'a.h': head('int', 'long'), 'use.cpp': '#include "a.h"\nint go() { return read<long>(); }\n' },
      { 'a.h': head('long', 'int'), 'use.cpp': '#include "a.h"\nint go() { return read<long>() + 0; }\n' }
    );
    expect(state).toEqual(full);
  }, 120_000);

  it('C++: a member is defined for another specialization of its class', async () => {
    const member = (type: string): string => `#include "base.h"
struct one {};
struct two {};
namespace fmt { template <> struct formatter<${type}> { int format(int& ctx) const; }; }
int fmt::formatter<${type}>::format(int& ctx) const { return ctx; }
`;
    const { state, full } = await syncEdit(
      {
        'base.h': 'namespace fmt {\ntemplate <typename T> struct formatter {};\n}\n',
        'member.cc': member('one'),
        'use.cc': '#include "base.h"\nstruct two;\nnamespace fmt {\nint Use(int& ctx) { return formatter<two>::format(ctx); }\n}\n',
      },
      {
        'member.cc': member('two'),
        'use.cc': '#include "base.h"\nstruct two;\nnamespace fmt {\nint Use(int& ctx) { return formatter<two>::format(ctx) + 0; }\n}\n',
      }
    );
    expect(state).toEqual(full);
  }, 120_000);

  it('COBOL: a transaction id moves to another program', async () => {
    const program = (name: string, value: string): string => [
      'IDENTIFICATION DIVISION.',
      `PROGRAM-ID. ${name}.`,
      'DATA DIVISION.',
      'WORKING-STORAGE SECTION.',
      `01  WS-TRANID                PIC X(04) VALUE '${value}'.`,
      'PROCEDURE DIVISION.',
      'P1.',
      '    DISPLAY "HI".',
      '',
    ].map((line) => (line ? `       ${line}` : line)).join('\n');
    const caller = (extra: string): string => [
      'IDENTIFICATION DIVISION.',
      'PROGRAM-ID. CALLER.',
      'PROCEDURE DIVISION.',
      'P1.',
      `    EXEC CICS RETURN TRANSID('CC00') COMMAREA(WS-X) END-EXEC.`,
      extra,
      '',
    ].map((line) => (line ? `       ${line}` : line)).join('\n');
    const { state, full } = await syncEdit(
      { 'ONE.cbl': program('ONE', 'CC00'), 'TWO.cbl': program('TWO', 'CB00'), 'CALLER.cbl': caller('') },
      { 'ONE.cbl': program('ONE', 'CB00'), 'TWO.cbl': program('TWO', 'CC00'), 'CALLER.cbl': caller('    DISPLAY "EDITED".') }
    );
    expect(state).toEqual(full);
  }, 120_000);

  it('Expo: a value is bound to another native module', async () => {
    const native = (name: string): string => `import ExpoModulesCore
public class ${name}Module: Module {
  public func definition() -> ModuleDefinition {
    Name("${name}")
    AsyncFunction("ping") { in /* … */ }
  }
}
`;
    const caller = (module: string): string => `import { requireNativeModule } from 'expo-modules-core';
const Native = requireNativeModule('${module}');
export async function go() {
  return await Native.ping();
}
`;
    const { state, full } = await syncEdit(
      {
        'package.json': '{"dependencies":{"expo-modules-core":"^1.0.0"}}',
        'ios/One.swift': native('ExpoOne'),
        'ios/Two.swift': native('ExpoTwo'),
        'src/index.ts': caller('ExpoOne'),
      },
      { 'src/index.ts': caller('ExpoTwo') }
    );
    expect(state).toEqual(full);
  }, 120_000);

  it('Angular: an Nx workspace appears around two libraries', async () => {
    const home = (extra: string): string => `import { Component } from '@angular/core';
import { Router } from '@angular/router';
@Component({ selector: 'as-home', template: '<p>home</p>' })
export class HomeComponent {
  constructor(private readonly router: Router) {}
  go() { this.router.navigate(['/lyrics']); }
}
${extra}`;
    const { state, full } = await syncEdit(
      {
        'package.json': JSON.stringify({ name: 'ws', dependencies: { '@angular/core': '*', '@angular/router': '*' } }),
        'libs/shell/src/lib/shell.routes.ts': `import { Route } from '@angular/router';
export const shellRoutes: Route[] = [{ path: 'lyrics', loadComponent: () => import('./lyrics.component') }];
`,
        'libs/shell/src/lib/lyrics.component.ts': `import { Component } from '@angular/core';
@Component({ selector: 'as-lyrics', template: '<p>lyrics</p>' })
export default class LyricsComponent {}
`,
        'libs/home/src/lib/home.component.ts': home(''),
        'libs/home/src/lib/home.routes.ts': `import { Route } from '@angular/router';
import { HomeComponent } from './home.component';
export const homeRoutes: Route[] = [{ path: 'home', component: HomeComponent }];
`,
      },
      { 'nx.json': '{}', 'libs/home/src/lib/home.component.ts': home('// edited\n') }
    );
    expect(state).toEqual(full);
  }, 120_000);
});
