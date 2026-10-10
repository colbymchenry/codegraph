import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodeGraph } from '../src';
import { resetDecisionConfig } from '../src/decision/config';
import { resetOverrides } from '../src/decision/overrides';
import { POINTS } from '../src/decision/questions';
import type { BuildContext, DecisionRecord } from '../src/decision/types';
import { getAllFrameworkResolvers } from '../src/resolution/frameworks';

// vite cannot resolve a `node:sqlite` import (no bare `sqlite` builtin); require it like the other suites do.
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  resetDecisionConfig();
  resetOverrides();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dhook-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

async function index(root: string, env: Record<string, string> = {}): Promise<void> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  resetDecisionConfig();
  resetOverrides();
  fs.rmSync(path.join(root, '.codegraph'), { recursive: true, force: true });
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  cg.close();
  vi.unstubAllEnvs();
  resetDecisionConfig();
  resetOverrides();
}

function edges(root: string): Array<{ src: string; tgt: string; tfile: string; kind: string; meta: string | null }> {
  const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
  const rows = db.prepare(`SELECT s.name AS src, t.name AS tgt, t.file_path AS tfile, e.kind AS kind, e.metadata AS meta
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target ORDER BY src, tgt, tfile, kind`).all() as any[];
  db.close();
  return rows;
}

const records = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// C: two global functions named `helper` in different directories → an ambiguous exact-name match (A1).
const C_FILES = {
  'a/util.c': 'int helper(void) { return 1; }\n',
  'b/util.c': 'int helper(void) { return 2; }\n',
  'src/main.c': 'int helper(void);\nint main(void) { return helper(); }\n',
};
// Python: an untyped receiver with two candidate owners (A2 Strategy 3).
const PY_FILES = {
  'pkg/alpha.py': 'class Alpha:\n    def run(self):\n        return 1\n',
  'pkg/beta.py': 'class Beta:\n    def run(self):\n        return 2\n',
  'pkg/use.py': 'def go(x):\n    return x.run()\n',
};
// C++: two `Logger::log` declarations; a typed receiver resolves through resolveMethodOnType (A3).
const CPP_FILES = {
  'a/svc.cpp': 'class Logger { public: void log() { int a = 1; } };\nvoid useA() { Logger lg; lg.log(); }\n',
  'b/svc.cpp': 'class Logger { public: void log() { int b = 2; } };\nvoid useB() { Logger lg; lg.log(); }\n',
};
// C++: A3 guesses between two `Logger::log`; the receiver `logger` also names the class, so Strategy 2 could re-link it.
const CPP_GUESS_FILES = {
  'a/log.cpp': 'class Logger { public: void log() { int a = 1; } };\n',
  'b/log.cpp': 'class Logger { public: void log() { int b = 2; } };\n',
  'c/use.cpp': 'void useC() { Logger logger; logger.log(); }\n',
};
// Python: an untyped receiver whose lone candidate the heuristic accepts (A2, lone).
const PY_LONE_FILES = {
  'lone/alpha.py': 'class Alpha:\n    def launch(self):\n        return 1\n',
  'lone/use.py': 'def go(myAlpha):\n    return myAlpha.launch()\n',
};
// Python: A2 picks AlphaRunner by receiver words (several owners); `x.run()` stays unlinked (A6).
const PY_MULTI_FILES = {
  'multi/alpha.py': 'class AlphaRunner:\n    def run(self):\n        return 1\n',
  'multi/beta.py': 'class BetaRunner:\n    def run(self):\n        return 2\n',
  'multi/use.py': 'def go2(myAlphaRunner):\n    return myAlphaRunner.run()\n\n\ndef go3(x):\n    return x.run()\n',
};
// C: a function and a same-named global — exact-name (A1) sees both, fuzzy only the function.
const C_VAR_FILES = {
  'a/util.c': 'int helper(void) { return 1; }\n',
  'b/util.c': 'int helper = 2;\n',
  'src/main.c': 'int main(void) { return helper(); }\n',
};
// TS: `this.handle` is inherited, so resolution queues it for the supertype pass.
const TS_DEFERRED_FILES = {
  'src/base.ts': 'export class Base {\n  handle(): void {}\n}\n',
  'src/other.ts': 'export class Other {\n  handle(): void {}\n}\n',
  'src/child.ts': "import { Base } from './base';\n\nexport class Child extends Base {\n  wire(): void {\n    setTimeout(this.handle, 1);\n  }\n}\n",
};

function overrides(root: string, entries: Record<string, { pick: string | null; p: number }>): string {
  const file = path.join(root, 'ovr.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  return file;
}

function query(root: string, sql: string, ...params: string[]): any[] {
  const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
  const rows = db.prepare(sql).all(...params) as any[];
  db.close();
  return rows;
}

describe('decision hooks — resolution', () => {
  it.each(['off', 'auto'])('records A1 without changing the graph, and a %s override retargets the edge', async backend => {
    const root = project(C_FILES);
    await index(root);
    const plain = edges(root);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'all' });
    expect(edges(root)).toEqual(plain); // inert
    const a1 = records(rec).find((r) => r.point === 'A1');
    expect(a1).toBeDefined();
    expect(a1.payload.candidates.length).toBeGreaterThanOrEqual(2);
    const other = a1.payload.candidates.find((c: any) => c.id !== a1.heuristic.pick);
    const ovr = path.join(root, 'ovr.json');
    fs.writeFileSync(ovr, JSON.stringify({ [`A1|${a1.key}`]: { pick: other.id, p: 0.93 } }));
    await index(root, { CODEGRAPH_DECISIONS: backend, CODEGRAPH_DECISION_OVERRIDES: ovr });
    const call = edges(root).find((e) => e.src === 'main' && e.tgt === 'helper' && e.kind === 'calls');
    expect(call?.tfile).toBe(other.filePath);
    expect(JSON.parse(call!.meta!)).toMatchObject({ decision: 'A1', decisionP: 0.93, confidence: 0.93 });
  }, 120_000);

  it('records A2 for an untyped receiver, and an override links the chosen owner', async () => {
    const root = project(PY_FILES);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A2' });
    const a2 = records(rec).find((r) => r.point === 'A2');
    expect(a2).toBeDefined();
    const alpha = a2.payload.candidates.find((c: any) => c.qualifiedName.includes('Alpha'));
    const ovr = path.join(root, 'ovr.json');
    fs.writeFileSync(ovr, JSON.stringify({ [`A2|${a2.key}`]: { pick: alpha.id, p: 0.88 } }));
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: ovr });
    const call = edges(root).find((e) => e.src === 'go' && e.tgt === 'run');
    expect(call?.tfile).toBe('pkg/alpha.py');
  }, 120_000);

  it('records A3 for duplicate Type::method declarations, and an override retargets the edge', async () => {
    const root = project(CPP_FILES);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A3' });
    const a3 = records(rec).find((r) => r.point === 'A3' && r.payload.ref.filePath === 'a/svc.cpp');
    expect(a3).toBeDefined();
    expect(a3.payload).toMatchObject({ typeName: 'Logger', methodName: 'log', total: 2 });
    const other = a3.payload.candidates.find((c: any) => c.id !== a3.heuristic.pick);
    expect(other.filePath).toBe('b/svc.cpp');
    const ovr = path.join(root, 'ovr.json');
    fs.writeFileSync(ovr, JSON.stringify({ [`A3|${a3.key}`]: { pick: other.id, p: 0.81 } }));
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: ovr });
    const call = edges(root).find((e) => e.src === 'useA' && e.tgt === 'log' && e.kind === 'calls');
    expect(call?.tfile).toBe('b/svc.cpp');
    expect(JSON.parse(call!.meta!)).toMatchObject({ decision: 'A3', decisionP: 0.81, confidence: 0.81 });
  }, 120_000);

  it('records A6 for a reference every strategy declined; an override links it, and the gates still apply', async () => {
    const root = project({ ...PY_FILES, 'tool/run.go': 'package tool\n\nfunc run() int { return 3 }\n' });
    await index(root);
    const plain = edges(root);
    expect(plain.find((e) => e.src === 'go' && e.tgt === 'run')).toBeUndefined(); // the heuristic declines
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A6' });
    expect(edges(root)).toEqual(plain); // inert
    const a6 = records(rec).find((r) => r.point === 'A6' && r.payload.ref.filePath === 'pkg/use.py');
    expect(a6).toBeDefined();
    expect(a6.heuristic.pick).toBeNull();
    const alpha = a6.payload.candidates.find((c: any) => c.qualifiedName.includes('Alpha'));
    const goRun = a6.payload.candidates.find((c: any) => c.language === 'go');
    expect(goRun).toBeDefined();
    const ovr = path.join(root, 'ovr.json');
    fs.writeFileSync(ovr, JSON.stringify({ [`A6|${a6.key}`]: { pick: alpha.id, p: 0.91 } }));
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: ovr });
    const call = edges(root).find((e) => e.src === 'go' && e.tgt === 'run');
    expect(call?.tfile).toBe('pkg/alpha.py');
    expect(JSON.parse(call!.meta!)).toMatchObject({ decision: 'A6', decisionP: 0.91, confidence: 0.91 });
    // A cross-language pick still meets resolveOne's language gate: no edge.
    fs.writeFileSync(ovr, JSON.stringify({ [`A6|${a6.key}`]: { pick: goRun.id, p: 0.95 } }));
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: ovr });
    expect(edges(root).find((e) => e.src === 'go' && e.tgt === 'run')).toBeUndefined();
  }, 120_000);
});

describe('decision hooks — override semantics', () => {
  it('an A1 none moves on to the next strategy', async () => {
    const root = project(C_VAR_FILES);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A1' });
    const a1 = records(rec).find((r) => r.point === 'A1');
    expect(a1.payload.candidates.map((c: any) => c.kind).sort()).toEqual(['function', 'variable']);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`A1|${a1.key}`]: { pick: null, p: 0.9 } }) });
    // Exact-name's answer is dropped; fuzzy, the next strategy, links the one callable `helper`.
    const call = edges(root).find((e) => e.src === 'main' && e.tgt === 'helper');
    expect(call?.tfile).toBe('a/util.c');
    const meta = JSON.parse(call!.meta!);
    expect(meta).toMatchObject({ resolvedBy: 'fuzzy', confidence: 0.5 });
    expect(meta.decision).toBeUndefined();
  }, 120_000);

  it('an A2 none drops the edge for good: no later strategy nor A6 pick re-links it', async () => {
    const root = project(PY_LONE_FILES);
    await index(root);
    expect(edges(root).find((e) => e.src === 'go' && e.tgt === 'launch')?.tfile).toBe('lone/alpha.py'); // the heuristic links it
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A2' });
    const a2 = records(rec).find((r) => r.point === 'A2');
    expect(a2.payload.candidates).toHaveLength(1);
    // A2 and A6 key the same reference by refKey.
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`A2|${a2.key}`]: { pick: null, p: 0.9 }, [`A6|${a2.key}`]: { pick: a2.payload.candidates[0].id, p: 0.95 } }) });
    expect(edges(root).find((e) => e.src === 'go' && e.tgt === 'launch')).toBeUndefined();
  }, 120_000);

  it('an A3 none is final for the reference: no later strategy nor A6 pick re-links it', async () => {
    const root = project(CPP_GUESS_FILES);
    await index(root);
    expect(edges(root).find((e) => e.src === 'useC' && e.tgt === 'log')).toBeDefined(); // the heuristic guesses one
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A3' });
    const a3 = records(rec).find((r) => r.point === 'A3' && r.payload.ref.filePath === 'c/use.cpp');
    expect(a3.key.endsWith(':Logger.log')).toBe(true);
    const none = { [`A3|${a3.key}`]: { pick: null, p: 0.9 } };
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, none) });
    expect(edges(root).find((e) => e.src === 'useC' && e.tgt === 'log')).toBeUndefined();
    const a6Key = a3.key.slice(0, -':Logger.log'.length); // the reference's refKey
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { ...none, [`A6|${a6Key}`]: { pick: a3.payload.candidates[1].id, p: 0.95 } }) });
    expect(edges(root).find((e) => e.src === 'useC' && e.tgt === 'log')).toBeUndefined();
  }, 120_000);

  it('an override pick that is no current candidate is ignored at every site', async () => {
    const root = project({ ...C_FILES, ...CPP_GUESS_FILES, ...PY_LONE_FILES, ...PY_MULTI_FILES });
    await index(root);
    const plain = edges(root);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'all' });
    const nameOf = (r: any) => r.payload.ref?.name ?? `${r.payload.call.receiver}.${r.payload.call.method}`;
    const sites: Array<[string, string]> = [['A1', 'helper'], ['A2', 'myAlpha.launch'], ['A2', 'myAlphaRunner.run'], ['A3', 'logger.log'], ['A6', 'x.run']];
    const unknown: Record<string, { pick: string; p: number }> = {};
    for (const [point, name] of sites) {
      const r = records(rec).find((x) => x.point === point && nameOf(x) === name);
      expect(r, `${point} ${name}`).toBeDefined();
      unknown[`${point}|${r.key}`] = { pick: 'method:not-a-candidate', p: 0.99 };
    }
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, unknown) });
    expect(edges(root)).toEqual(plain); // same targets, confidence and metadata
  }, 120_000);

  it('A6 leaves a reference queued for a later pass alone', async () => {
    const root = project(TS_DEFERRED_FILES);
    const wired = () => query(root, `SELECT e.source AS src, e.line AS line, e.col AS col, t.qualified_name AS tq
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE s.name = 'wire'`);
    await index(root);
    const plain = wired();
    expect(plain.map((e) => e.tq)).toEqual(['Base::handle']); // the supertype pass links the inherited member
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A6' });
    expect(records(rec).filter((r) => r.point === 'A6' && r.payload.ref.name === 'this.handle')).toEqual([]);
    // Even an A6 verdict for that reference cannot give it a second edge.
    const other = query(root, `SELECT id FROM nodes WHERE qualified_name = ?`, 'Other::handle')[0].id;
    const key = `${plain[0].src}:${plain[0].line}:${plain[0].col}:function_ref`;
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`A6|${key}`]: { pick: other, p: 0.95 } }) });
    expect(wired().map((e) => e.tq)).toEqual(['Base::handle']);
  }, 120_000);
});

// TS: one `on('save', handleSave)` with two same-named handlers → B1 emitter site.
const EMITTER_FILES = {
  'src/bus.ts': "import { EventEmitter } from 'events';\nexport const bus = new EventEmitter();\nexport function fire() { bus.emit('save', 1); }\n",
  'src/a/handlers.ts': 'export function handleSave(x: number) { return x; }\n',
  'src/b/handlers.ts': 'export function handleSave(x: number) { return x + 1; }\n',
  'src/wire.ts': "import { bus } from './bus';\nimport { handleSave } from './a/handlers';\nbus.on('save', handleSave);\n",
};
// TS: seven handlers on one event, over EVENT_FANOUT_CAP (6) → B2 asks each dispatcher → handler pair.
const TICKS = Array.from({ length: 7 }, (_, i) => `onTick${i}`);
const OVERCAP_FILES = {
  'src/bus.ts': "import { EventEmitter } from 'events';\nexport const bus = new EventEmitter();\nexport function fire() { bus.emit('tick', 1); }\n",
  'src/handlers.ts': TICKS.map((n, i) => `export function ${n}(x: number) { return x + ${i}; }\n`).join(''),
  'src/wire.ts': `import { bus } from './bus';\nimport { ${TICKS.join(', ')} } from './handlers';\n${TICKS.map((n) => `bus.on('tick', ${n});\n`).join('')}`,
};
// JS: an Express app. Its two item routes match one client path equally well (B3 tie); `svc`,
// a receiver no client binding or name list vouches for, calls the third (B3 client).
const TIE_FILES = {
  'package.json': JSON.stringify({ name: 'tie', dependencies: { express: '4' } }),
  'server/app.js': "const express = require('express');\nconst app = express();\napp.get('/api/items/:id', function byId(req, res) { res.send('a'); });\napp.get('/api/items/:slug', function bySlug(req, res) { res.send('b'); });\napp.get('/api/things', function things(req, res) { res.send('c'); });\n",
  'web/client.js': 'export async function load(id) {\n  return fetch(`/api/items/${id}`);\n}\n',
  'web/things.js': "export async function loadThings(svc) {\n  return svc.get('/api/things');\n}\n",
};
// TSX: `<Card />` with two same-named components and no import or local one → B1 jsx.
const JSX_FILES = {
  'src/a/Card.tsx': 'export function Card() { return <div />; }\n',
  'src/b/Card.tsx': 'export function Card() { return <span />; }\n',
  'src/app/App.tsx': 'export function App() { return <Card />; }\n',
};
// Vue: `<base-button>` names two BaseButton.vue components (B1 vue); `components/base/Button.vue`
// is Nuxt's `BaseButton`, the fallback a "none" verdict must not reach.
const VUE_FILES = {
  'package.json': JSON.stringify({ name: 'vue-app', dependencies: { vue: '^3.4.0' } }),
  'components/a/BaseButton.vue': '<template><button>a</button></template>\n',
  'components/b/BaseButton.vue': '<template><button>b</button></template>\n',
  'components/base/Button.vue': '<template><button>nuxt</button></template>\n',
  'App.vue': '<template><div><base-button /></div></template>\n',
};
// TS: a command registry whose `AddCommand` names two classes → B1 registry over their `execute` entries.
const REGISTRY_FILES = {
  'src/a/commands.ts': "export class AddCommand { execute() { return 'a'; } }\nexport class RemoveCommand { execute() { return 'remove'; } }\n",
  'src/b/commands.ts': "export class AddCommand { execute() { return 'b'; } }\n",
  'src/manager.ts': "import { AddCommand, RemoveCommand } from './a/commands';\n\nexport class CommandManager {\n  commands = { add: AddCommand, remove: RemoveCommand };\n\n  run(command: string) {\n    return new this.commands[command]().execute();\n  }\n}\n",
};
// C: a command table registers `cmd_add`, defined in two other files → B1 cfnptr.
const CFN_FILES = {
  'a/add.c': 'int cmd_add(int argc) { return argc + 1; }\n',
  'b/add.c': 'int cmd_add(int argc) { return argc + 2; }\n',
  'cmd.c': 'struct cmd { const char *name; int (*fn)(int argc); };\nstatic int cmd_rm(int argc) { return argc - 1; }\nstatic struct cmd commands[] = {\n    { "add", cmd_add },\n    { "rm",  cmd_rm  },\n};\nint run_builtin(struct cmd *p, int argc) {\n    return p->fn(argc);\n}\n',
};

// Django: `ItemView()` with two ItemView classes in views modules → B1 at the framework name heuristic.
const DJANGO_FILES = {
  'manage.py': '',
  'alpha/views.py': 'class ItemView:\n    pass\n',
  'beta/views.py': 'class ItemView:\n    pass\n',
  'gamma/routes.py': 'def route():\n    return ItemView()\n',
};

describe('decision hooks — synthesis', () => {
  it('records B1 at the emitter site without changing the graph', async () => {
    const root = project(EMITTER_FILES);
    await index(root);
    const plain = edges(root);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'all' });
    expect(edges(root)).toEqual(plain);
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'emitter');
    expect(b1?.payload.candidates.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('a B1 override retargets the emitter edge, a none drops it, an unknown pick changes nothing', async () => {
    const root = project(EMITTER_FILES);
    await index(root);
    const plain = edges(root);
    const saves = () => edges(root).filter((e) => e.src === 'fire' && e.tgt === 'handleSave' && e.kind === 'calls');
    expect(saves()).toHaveLength(1);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B1' });
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'emitter');
    expect(saves()[0]!.tfile).toBe(b1.payload.candidates.find((c: any) => c.id === b1.heuristic.pick).filePath);
    const other = b1.payload.candidates.find((c: any) => c.id !== b1.heuristic.pick);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: other.id, p: 0.87 } }) });
    expect(saves().map((e) => e.tfile)).toEqual([other.filePath]);
    expect(JSON.parse(saves()[0]!.meta!)).toMatchObject({ synthesizedBy: 'event-emitter', event: 'save', decision: 'B1', decisionP: 0.87 });
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: null, p: 0.9 } }) });
    expect(saves()).toEqual([]);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: 'function:not-a-candidate', p: 0.99 } }) });
    expect(edges(root)).toEqual(plain);
  }, 120_000);

  it('B2 links a pair of an over-cap event only on a "true" verdict', async () => {
    const root = project(OVERCAP_FILES);
    await index(root);
    const ticks = () => edges(root).filter((e) => e.src === 'fire' && e.tgt.startsWith('onTick'));
    expect(ticks()).toEqual([]); // seven handlers: over the fan-out cap, so the heuristic links none
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B2' });
    expect(ticks()).toEqual([]); // inert
    const b2 = records(rec).filter((r) => r.point === 'B2' && r.key.startsWith('emitter:tick:'));
    expect(b2).toHaveLength(7);
    expect(b2[0].heuristic.pick).toBe('false');
    expect(b2[0].payload).toMatchObject({ event: 'tick', dispatcher: { filePath: 'src/bus.ts', line: 3 }, handler: { filePath: 'src/wire.ts' } });
    const [yes, no] = b2;
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B2|${yes.key}`]: { pick: 'true', p: 0.8 }, [`B2|${no.key}`]: { pick: 'false', p: 0.9 } }) });
    const linked = ticks();
    expect(linked).toHaveLength(1);
    expect(JSON.parse(linked[0]!.meta!)).toEqual({
      synthesizedBy: 'event-emitter', event: 'tick', registeredAt: `src/wire.ts:${yes.payload.handler.line}`, decision: 'B2', decisionP: 0.8,
    });
  }, 120_000);

  it('B3: a tie override links the chosen route, a "true" client verdict makes a receiver a client; both edges carry it', async () => {
    const root = project(TIE_FILES);
    const httpCalls = (src: string) => edges(root).filter((e) => e.src === src && e.kind === 'calls');
    await index(root);
    expect(httpCalls('load')).toEqual([]); // a tie
    expect(httpCalls('loadThings')).toEqual([]); // `svc` is no client by name
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B3' });
    const tie = records(rec).find((r) => r.point === 'B3' && r.payload.kind === 'tie');
    expect(tie.heuristic.pick).toBeNull();
    expect(tie.payload.routes.map((r: any) => r.name).sort()).toEqual(['GET /api/items/:id', 'GET /api/items/:slug']);
    const client = records(rec).find((r) => r.point === 'B3' && r.payload.kind === 'client' && r.payload.call.receiver === 'svc');
    expect(client.heuristic.pick).toBe('false');
    const route = tie.payload.routes.find((r: any) => r.name === 'GET /api/items/:slug');
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B3|${tie.key}`]: { pick: route.id, p: 0.9 }, [`B3|${client.key}`]: { pick: 'true', p: 0.75 } }) });
    expect(httpCalls('load').map((e) => e.tgt)).toEqual(['GET /api/items/:slug']);
    expect(JSON.parse(httpCalls('load')[0]!.meta!)).toMatchObject({ synthesizedBy: 'http-client', decision: 'B3', decisionP: 0.9 });
    expect(httpCalls('loadThings').map((e) => e.tgt)).toEqual(['GET /api/things']);
    expect(JSON.parse(httpCalls('loadThings')[0]!.meta!)).toMatchObject({ synthesizedBy: 'http-client', decision: 'B3', decisionP: 0.75 });
  }, 120_000);

  it('a B1 jsx override retargets the child edge with its marker; a none drops it', async () => {
    const root = project(JSX_FILES);
    const cards = () => edges(root).filter((e) => e.src === 'App' && e.tgt === 'Card');
    await index(root);
    expect(cards()).toHaveLength(1);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B1' });
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'jsx');
    const other = b1.payload.candidates.find((c: any) => c.id !== b1.heuristic.pick);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: other.id, p: 0.86 } }) });
    expect(cards().map((e) => e.tfile)).toEqual([other.filePath]);
    expect(JSON.parse(cards()[0]!.meta!)).toEqual({ synthesizedBy: 'jsx-render', via: 'Card', decision: 'B1', decisionP: 0.86 });
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: null, p: 0.9 } }) });
    expect(cards()).toEqual([]);
  }, 120_000);

  it('a B1 vue none leaves the tag unlinked, without the Nuxt fallback; a pick carries its marker', async () => {
    const root = project(VUE_FILES);
    const fromApp = () => edges(root).filter((e) => e.src === 'App' && e.kind === 'calls');
    await index(root);
    expect(fromApp().map((e) => e.tgt)).toEqual(['BaseButton']);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B1' });
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'vue');
    expect(b1.payload.candidates.map((c: any) => c.filePath).sort()).toEqual(['components/a/BaseButton.vue', 'components/b/BaseButton.vue']);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: null, p: 0.9 } }) });
    expect(fromApp()).toEqual([]); // not components/base/Button.vue either
    const other = b1.payload.candidates.find((c: any) => c.id !== b1.heuristic.pick);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: other.id, p: 0.82 } }) });
    expect(fromApp().map((e) => e.tfile)).toEqual([other.filePath]);
    expect(JSON.parse(fromApp()[0]!.meta!)).toEqual({ synthesizedBy: 'jsx-render', via: 'base-button', decision: 'B1', decisionP: 0.82 });
  }, 120_000);

  it('B1 at a registry asks between the handler classes’ entries; a pick links that class’s execute', async () => {
    const root = project(REGISTRY_FILES);
    const runs = () => edges(root).filter((e) => e.src === 'run' && e.tgt === 'execute' && JSON.parse(e.meta!).synthesizedBy === 'object-registry');
    await index(root);
    expect(runs().map((e) => e.tfile)).toEqual(['src/a/commands.ts', 'src/a/commands.ts']); // AddCommand's first class, and RemoveCommand
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B1' });
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'registry');
    expect(b1.payload.candidates.map((c: any) => `${c.qualifiedName}@${c.filePath}`).sort()).toEqual(['AddCommand::execute@src/a/commands.ts', 'AddCommand::execute@src/b/commands.ts']);
    expect(b1.payload.candidates.map((c: any) => c.id)).toContain(b1.heuristic.pick);
    const other = b1.payload.candidates.find((c: any) => c.filePath === 'src/b/commands.ts');
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: other.id, p: 0.84 } }) });
    const picked = runs().find((e) => e.tfile === 'src/b/commands.ts');
    expect(JSON.parse(picked!.meta!)).toMatchObject({ synthesizedBy: 'object-registry', via: 'AddCommand', decision: 'B1', decisionP: 0.84 });
  }, 120_000);

  it('a B1 C function-pointer override retargets the dispatch edge with its marker; a none drops it', async () => {
    const root = project(CFN_FILES);
    const adds = () => edges(root).filter((e) => e.src === 'run_builtin' && e.tgt === 'cmd_add' && JSON.parse(e.meta!).synthesizedBy === 'fn-pointer-dispatch');
    await index(root);
    expect(adds()).toHaveLength(1);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B1' });
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'cfnptr');
    const other = b1.payload.candidates.find((c: any) => c.id !== b1.heuristic.pick);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: other.id, p: 0.83 } }) });
    expect(adds().map((e) => e.tfile)).toEqual([other.filePath]);
    expect(JSON.parse(adds()[0]!.meta!)).toMatchObject({ via: 'cmd.fn', decision: 'B1', decisionP: 0.83 });
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: null, p: 0.9 } }) });
    expect(adds()).toEqual([]);
  }, 120_000);

  it('a B1 none at a framework name heuristic is final for the reference; a pick carries the verdict', async () => {
    const root = project(DJANGO_FILES);
    const views = () => edges(root).filter((e) => e.src === 'route' && e.tgt === 'ItemView');
    await index(root);
    expect(views()).toHaveLength(1);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B1' });
    const b1 = records(rec).find((r) => r.point === 'B1' && r.payload.site.kind === 'name-heuristic');
    expect(b1.payload.candidates.map((c: any) => c.filePath).sort()).toEqual(['alpha/views.py', 'beta/views.py']);
    // No later strategy (name matching, import resolution, A6) may link it either.
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: null, p: 0.9 } }) });
    expect(views()).toEqual([]);
    const other = b1.payload.candidates.find((c: any) => c.id !== b1.heuristic.pick);
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { [`B1|${b1.key}`]: { pick: other.id, p: 0.81 } }) });
    expect(views().map((e) => e.tfile)).toEqual([other.filePath]);
    expect(JSON.parse(views()[0]!.meta!)).toMatchObject({ decision: 'B1', decisionP: 0.81, confidence: 0.81, resolvedBy: 'framework' });
  }, 120_000);

  it('each indexAll() and sync() starts with no vetoes left from the previous run', async () => {
    const root = project(CPP_GUESS_FILES);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'A3' });
    const a3 = records(rec).find((r) => r.point === 'A3' && r.payload.ref.filePath === 'c/use.cpp');
    const none = overrides(root, { [`A3|${a3.key}`]: { pick: null, p: 0.9 } });
    const empty = path.join(root, 'empty.json');
    fs.writeFileSync(empty, '{}');
    // Runs in one process with no reset in between, as a long-lived server does.
    const use = (ovr: string) => { vi.stubEnv('CODEGRAPH_DECISION_OVERRIDES', ovr); resetDecisionConfig(); };
    const fresh = async (ovr: string) => {
      use(ovr);
      fs.rmSync(path.join(root, '.codegraph'), { recursive: true, force: true });
      const cg = CodeGraph.initSync(root);
      await cg.indexAll();
      return cg;
    };
    const useC = () => edges(root).find((e) => e.src === 'useC' && e.tgt === 'log');
    (await fresh(none)).close();
    expect(useC()).toBeUndefined();
    (await fresh(empty)).close(); // no verdict for the reference now: only a stale veto could still drop it
    expect(useC()).toBeDefined();
    const cg = await fresh(none);
    expect(useC()).toBeUndefined();
    use(empty);
    fs.appendFileSync(path.join(root, 'c/use.cpp'), '// touched\n');
    await cg.sync(); // re-resolves c/use.cpp
    cg.close();
    expect(useC()).toBeDefined();
  }, 120_000);
});
// Django, with and without a signal that detects it (B5): `path('items/', …)` is a route node only when the framework is on.
const DJANGO_URLS = {
  'shop/urls.py': "from django.urls import path\nfrom . import views\n\nurlpatterns = [path('items/', views.ItemView.as_view())]\n",
  'shop/views.py': 'class ItemView:\n    pass\n',
};

// What building a model question needs to read: nothing, to prove a recorded payload is well-formed.
const noSource: BuildContext = { readLines: () => [] };
const asks = (r: DecisionRecord): boolean => POINTS[r.point]!.build(r, noSource) !== null;
const routes = (root: string): string[] => query(root, `SELECT name FROM nodes WHERE kind = 'route' ORDER BY name`).map((r) => r.name);

describe('decision hooks — frameworks', () => {
  it('B5 records each framework detection; an override switches a detected framework off and an undetected one on, and only "true" / "false" count', async () => {
    const detected = project({ 'manage.py': '', ...DJANGO_URLS });
    await index(detected);
    expect(routes(detected)).toEqual(['items/']);
    const plain = edges(detected);
    const rec = path.join(detected, 'rec.jsonl');
    await index(detected, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'B5' });
    expect(edges(detected)).toEqual(plain); // inert
    expect(routes(detected)).toEqual(['items/']);
    const b5 = records(rec).filter((r) => r.point === 'B5');
    expect(b5).toHaveLength(getAllFrameworkResolvers().length); // one per resolver, whatever its verdict
    expect(b5.find((r) => r.key === 'django')).toMatchObject({ payload: { framework: 'django', detected: true }, heuristic: { pick: 'true' } });
    expect(b5.find((r) => r.key === 'flask')).toMatchObject({ payload: { framework: 'flask', detected: false }, heuristic: { pick: 'false' } });
    expect(b5.every(asks)).toBe(true);
    await index(detected, { CODEGRAPH_DECISION_OVERRIDES: overrides(detected, { 'B5|django': { pick: 'false', p: 0.9 } }) });
    expect(routes(detected)).toEqual([]); // the framework that extracts the route is off
    for (const pick of ['maybe', null]) {
      await index(detected, { CODEGRAPH_DECISION_OVERRIDES: overrides(detected, { 'B5|django': { pick, p: 0.9 } }) });
      expect(edges(detected)).toEqual(plain);
    }
    const undetected = project(DJANGO_URLS);
    await index(undetected);
    expect(routes(undetected)).toEqual([]);
    await index(undetected, { CODEGRAPH_DECISION_OVERRIDES: overrides(undetected, { 'B5|django': { pick: 'true', p: 0.8 } }) });
    expect(routes(undetected)).toEqual(['items/']);
  }, 120_000);
});

// TS: only a file whose head mentions "generat…" is a G1 instance — a banner (true) and an ordinary comment (false).
const GEN_FILES = {
  'src/handwritten.ts': '// Utility that generates ids for the app.\nexport function makeId() { return 1; }\n',
  'src/banner.ts': '// Code generated by hand-rolled script. DO NOT EDIT.\nexport const x = 1;\n',
  'src/plain.ts': 'export const y = 2;\n',
};

describe('decision hooks — index input', () => {
  it('G1 records the files whose head mentions "generat…"; an override flips the verdict, anything but "true" / "false" is ignored', async () => {
    const root = project(GEN_FILES);
    const flags = () => Object.fromEntries(query(root, `SELECT path, generated FROM files WHERE path LIKE 'src/%' ORDER BY path`).map((r) => [r.path, r.generated]));
    await index(root);
    const plain = { 'src/banner.ts': 1, 'src/handwritten.ts': 0, 'src/plain.ts': 0 };
    expect(flags()).toEqual(plain);
    const rec = path.join(root, 'rec.jsonl');
    await index(root, { CODEGRAPH_DECISION_RECORD: rec, CODEGRAPH_DECISION_POINTS: 'G1' });
    expect(flags()).toEqual(plain); // inert
    const g1 = records(rec).filter((r) => r.point === 'G1');
    // plain.ts says nothing of generation in its head: clear-cut, never asked.
    expect(Object.fromEntries(g1.map((r) => [r.key, r.heuristic.pick]))).toEqual({ 'src/banner.ts': 'true', 'src/handwritten.ts': 'false' });
    for (const r of g1) expect(r.payload).toEqual({ filePath: r.key });
    expect(g1.every(asks)).toBe(true);
    const flip = { 'G1|src/handwritten.ts': { pick: 'true', p: 0.9 }, 'G1|src/banner.ts': { pick: 'false', p: 0.9 }, 'G1|src/plain.ts': { pick: 'true', p: 0.99 } };
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, flip) });
    expect(flags()).toEqual({ 'src/banner.ts': 0, 'src/handwritten.ts': 1, 'src/plain.ts': 0 }); // plain.ts was no instance: its entry is moot
    await index(root, { CODEGRAPH_DECISION_OVERRIDES: overrides(root, { 'G1|src/handwritten.ts': { pick: 'maybe', p: 0.9 }, 'G1|src/banner.ts': { pick: null, p: 0.9 } }) });
    expect(flags()).toEqual(plain);
  }, 120_000);
});
