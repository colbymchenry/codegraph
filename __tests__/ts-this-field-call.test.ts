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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  // (resolveMethodOnType matches within one language, so the JS wrapper gets a JS Mailer.)
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
});
