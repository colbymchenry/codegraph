/**
 * A TS/JS call through a field of the enclosing class resolves on the field's
 * declared type, never by bare name (#1496).
 *
 * `this.mailer.send(msg)` inside `Notifier.send()` used to be emitted as the
 * bare `send`, which exact-matched the nearest same-named method — the
 * calling method itself. The stored self-edge `Notifier::send → Notifier::send`
 * made callers, callees, impact and trace silently wrong on exactly the
 * shape a delegating wrapper takes. The identical call resolved correctly
 * whenever the wrapper had any other name.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1496-'));
  fs.mkdirSync(path.join(dir, 'src'));
  const w = (rel: string, body: string) => fs.writeFileSync(path.join(dir, 'src', rel), body);
  w('mailer.ts', 'export class Mailer {\n  send(msg: string): string { return msg; }\n}\n');
  w(
    'notifier.ts',
    "import { Mailer } from './mailer';\n" +
      'export class Notifier {\n' +
      '  constructor(private readonly mailer: Mailer, private items: string[]) {}\n' +
      '  send(msg: string): string { return this.mailer.send(msg); }\n' +
      '  other(msg: string): string { return this.mailer.send(msg); }\n' +
      '  push(msg: string): void { this.items.push(msg); }\n' +
      '}\n'
  );
  // Plain JS: the field's type is only known from its `new` initializer.
  // Its sibling-extension cases are covered by release-main-regressions.test.ts.
  w('legacy-mailer.js', 'class LegacyMailer {\n  send(msg) { return msg; }\n}\nmodule.exports = { LegacyMailer };\n');
  w(
    'legacy.js',
    "const { LegacyMailer } = require('./legacy-mailer');\n" +
      'class LegacyNotifier {\n' +
      '  constructor() { this.mailer = new LegacyMailer(); }\n' +
      '  send(msg) { return this.mailer.send(msg); }\n' +
      '}\n' +
      'module.exports = { LegacyNotifier };\n'
  );
  // A field typed as the type OF a value: an object literal used as a namespace.
  w(
    'storage.ts',
    'export const DraftHubStorage = {\n' +
      '  async get(key: string): Promise<string> { return key; },\n' +
      '  async getSettings(): Promise<object> { return {}; },\n' +
      '};\n'
  );
  w(
    'keeper.ts',
    "import { DraftHubStorage } from './storage';\n" +
      'export class Keeper {\n' +
      '  constructor(private readonly storage: typeof DraftHubStorage) {}\n' +
      '  async get(key: string): Promise<string> { return this.storage.get(key); }\n' +
      '  async settings(): Promise<object> { return this.storage.getSettings(); }\n' +
      '}\n'
  );
  // Two apps declare the same service; the caller is equally near both.
  // Code-unit order and locale collation disagree on `Beta` vs `alpha`.
  for (const app of ['Beta', 'alpha']) {
    fs.mkdirSync(path.join(dir, 'src', 'apps', app), { recursive: true });
    w(`apps/${app}/service.ts`, 'export class UserService {\n  load(): string { return "x"; }\n}\n');
  }
  fs.mkdirSync(path.join(dir, 'src', 'shared'));
  w(
    'shared/hub.ts',
    'export class Hub {\n' +
      '  constructor(private readonly users: UserService) {}\n' +
      '  run(): string { return this.users.load(); }\n' +
      '}\n'
  );
  // ES private fields (#1987). `Outbox::send` and `Cart::add` sit in the same
  // file, so a bare-name guess would pick them over the field's real type.
  w(
    'vault.ts',
    "import { Mailer } from './mailer';\n" +
      'export class Outbox {\n  send(msg: string): string { return msg; }\n}\n' +
      'export class Cart {\n  add(item: string): void {}\n}\n' +
      'export class Vault {\n' +
      '  #mailer: Mailer;\n' +
      '  #backup = new Mailer();\n' +
      '  #items = new Set<string>();\n' +
      '  constructor(m: Mailer) { this.#mailer = m; }\n' +
      '  notify(msg: string): string { return this.#mailer.send(msg); }\n' +
      '  fallback(msg: string): string { return this.#backup.send(msg); }\n' +
      '  put(x: string): void { this.#items.add(x); }\n' +
      '}\n'
  );
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const method = (qn: string) => cg.getNodesByKind('method').find((n) => n.qualifiedName === qn)!;
const calleesOf = (qn: string) => cg.getCallees(method(qn).id).map(({ node }) => node.qualifiedName).sort();

describe('this.<field>.<method>() (#1496)', () => {
  it('resolves on the field\'s declared type even when the wrapper shares the method name', () => {
    expect(calleesOf('Notifier::send')).toEqual(['Mailer::send']);
    expect(calleesOf('Notifier::other')).toEqual(['Mailer::send']);
    // No self-edge anywhere.
    const self = cg.getCallers(method('Notifier::send').id).some(({ node }) => node.id === method('Notifier::send').id);
    expect(self).toBe(false);
  });

  it('reads a JS field initialized in the constructor', () => {
    expect(calleesOf('LegacyNotifier::send')).toEqual(['LegacyMailer::send']);
  });

  it('leaves a builtin-typed field unresolved rather than guessing a same-named method', () => {
    // `this.items.push()` — `string[]` names no project type; the wrapper `push`
    // must not become its own callee.
    expect(calleesOf('Notifier::push')).toEqual([]);
  });

  it('breaks an equal-proximity tie by code-unit path order, the same on every host locale', () => {
    // localeCompare depends on the host's ICU locale (en puts `alpha` first);
    // code-unit order puts `Beta` first everywhere.
    const callee = cg.getCallees(method('Hub::run').id).map(({ node }) => node.filePath);
    expect(callee).toEqual(['src/apps/Beta/service.ts']);
  });

  it('resolves a field typed `typeof <objectLiteral>` onto the literal\'s member', () => {
    // The members are bare-named functions inside the constant's extent (#1573).
    expect(calleesOf('Keeper::settings')).toEqual(['getSettings']);
    expect(calleesOf('Keeper::get')).toEqual(['get']);
    const self = cg.getCallers(method('Keeper::get').id).some(({ node }) => node.id === method('Keeper::get').id);
    expect(self).toBe(false);
  });

  it('resolves an ES private field on its declared or constructed type (#1987)', () => {
    expect(calleesOf('Vault::notify')).toEqual(['Mailer::send']);
    expect(calleesOf('Vault::fallback')).toEqual(['Mailer::send']);
  });

  it('leaves a builtin-typed ES private field unresolved (#1987)', () => {
    // `this.#items.add()` on a Set must not bind to the project's `Cart::add`.
    expect(calleesOf('Vault::put')).toEqual([]);
  });
});

describe.each(['ts', 'tsx', 'js', 'jsx'])('private field receivers in %s (#1987)', (ext) => {
  let temp: string;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it.each(['LF', 'CRLF'])('keeps optional receivers distinct from public fields (%s)', async (ending) => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-private-1987-'));
    const source = `
export class Mailer { send() {} }
export class Cart { add() {} }
export class Vault {
  #mailer = new Mailer();
  #items = new Set();
  items = new Cart();
  notify() { this.#mailer?.send(); }
  optional() { this.#mailer.send?.(); }
  put() { this.#items?.add('x'); }
  publicPut() { this.items.add('x'); }
}
`;
    fs.writeFileSync(path.join(temp, `vault.${ext}`), ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source);
    graph = await CodeGraph.init(temp, { index: true });
    const callees = (name: string) => {
      const caller = graph!.getNodesByKind('method').find(n => n.qualifiedName === `Vault::${name}`)!;
      expect(caller).toBeDefined();
      return graph!.getCallees(caller.id).map(c => c.node.qualifiedName);
    };
    expect(callees('notify')).toEqual(['Mailer::send']);
    expect(callees('optional')).toEqual(['Mailer::send']);
    expect(callees('put')).toEqual([]);
    expect(callees('publicPut')).toEqual(['Cart::add']);
  });
});
