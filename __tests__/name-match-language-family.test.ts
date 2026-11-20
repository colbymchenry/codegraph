/**
 * Name matching weighed candidates by their raw language tag, so a `.tsx`
 * file's call to the one `.ts` helper of its name was a cross-language guess
 * (0.5) and an Objective-C or C++ file's call into C found nothing at all:
 *
 *   app/window.m          setTls(slot);          // defined in two .c files
 *   app/main.cpp          getTime();             // app/clock.c, or win/clock_win.c
 *   ui/Row.tsx            formatDate(d);         // the one in lib/fmt.ts
 *
 * The one candidate of a name is now judged by language family (TypeScript and
 * TSX, Java and Kotlin, C and C++ and Objective-C are one each), and C, C++
 * and Objective-C — whose files share one table of names, and whose `.h` files
 * are told apart only by sniffing — are ranked as one language. Other
 * families keep the language itself for ranking: a `.ts` file's
 * `this.app.store.scheduleCapture()` still means the `.ts` Store's method, not
 * the `.tsx` App's beside it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  // A TSX component calling the one `.ts` helper of the name (a classic
  // script: no import or export), and a `.ts` file calling a method of a
  // `.ts` class while a `.tsx` class beside it has one of the same name.
  'web/ui/Row.tsx': 'export function Row() { return <div>{formatDate(new Date())}</div>; }\n',
  'web/lib/fmt.ts': 'function formatDate(d: Date) { return d.toISOString(); }\n',
  'web/components/App.tsx': [
    'export class App {',
    '  store = new Store();',
    '  scheduleCapture() { return 1; }',
    '  render() { return <div />; }',
    '}',
    '',
  ].join('\n'),
  'web/components/App.clipboard.ts': [
    'export class AppClipboard {',
    '  constructor(private app: any) {}',
    '  paste() {',
    '    this.app.store.scheduleCapture();',
    '  }',
    '}',
    '',
  ].join('\n'),
  'web/store/store.ts': [
    'export class Store {',
    '  scheduleCapture() { return 2; }',
    '}',
    '',
  ].join('\n'),
  // C, C++ and Objective-C: one table of names.
  'native/app/init.c': 'void inputError(int code) { (void)code; }\n',
  'native/app/posix_thread.c': 'void setTls(int *slot) { (void)slot; }\n',
  'native/win/win32_thread.c': 'void setTls(int *slot) { (void)slot; }\n',
  'native/app/window.m': [
    '#import <Foundation/Foundation.h>',
    '',
    'void makeCurrent(int *slot) {',
    '  setTls(slot);',
    '  inputError(1);',
    '}',
    '',
  ].join('\n'),
  'native/app/clock.c': 'long getTime(void) { return 1; }\n',
  'native/win/clock_win.c': 'long getTime(void) { return 2; }\n',
  'native/app/main.cpp': [
    'long run() {',
    '  return getTime();',
    '}',
    '',
  ].join('\n'),
};

describe.each(['default', 'wasm'])('name matching reads language families (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lang-family-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `target file:name@confidence` of each call out of `name` in `file`, sorted. */
  const callsFrom = (file: string, name: string): string[] => {
    const from = cg!.getNodesInFile(file).filter((n) => n.name === name && (n.kind === 'function' || n.kind === 'method'));
    expect(from, `${name} in ${file}`).toHaveLength(1);
    return cg!.getOutgoingEdgesFrom([from[0]!.id])
      .filter((e) => e.kind === 'calls')
      .map((e) => {
        const t = cg!.getNode(e.target)!;
        return `${t.filePath}:${t.name}@${(e.metadata as { confidence?: number } | undefined)?.confidence}`;
      })
      .sort();
  };

  const withoutConfidence = (call: string): string => call.replace(/@.*$/, '');

  it('a TSX file calling the one TypeScript function of the name is a same-family match', () => {
    expect(callsFrom('web/ui/Row.tsx', 'Row')).toEqual(['web/lib/fmt.ts:formatDate@0.9']);
  });

  it('TypeScript and TSX are still ranked by their own language', () => {
    expect(callsFrom('web/components/App.clipboard.ts', 'paste').map(withoutConfidence)).toEqual(['web/store/store.ts:scheduleCapture']);
  });

  it('Objective-C calls into C: the one function, and the nearer of two', () => {
    const calls = callsFrom('native/app/window.m', 'makeCurrent');
    expect(calls.map(withoutConfidence)).toEqual(['native/app/init.c:inputError', 'native/app/posix_thread.c:setTls']);
    expect(calls).toContain('native/app/init.c:inputError@0.9');
  });

  it('C++ calls into C: the nearer of two definitions', () => {
    expect(callsFrom('native/app/main.cpp', 'run').map(withoutConfidence)).toEqual(['native/app/clock.c:getTime']);
  });
});
