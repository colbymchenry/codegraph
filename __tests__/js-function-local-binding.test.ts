/**
 * A JS/TS name the calling function binds itself — a parameter, or a `var` /
 * `let` / `const` above the reference — is that local, never a same-named
 * function declared elsewhere in the file. Every lodash helper lives inside
 * `runInContext`, so `baseHas(object, key)`'s `object` and `mixin`'s
 * `object(this.__wrapped__)` reached a `function object() {}` an IIFE declares
 * there. A function that calls itself through its own `const` still does, and
 * `if (handler) handler()` is not a parameter list.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-local-'));
  const files: Record<string, string> = {
    'lodash.js': `function runInContext(context) {
  var baseCreate = (function() {
    function object() {}
    return function(proto) {
      object.prototype = proto;
      return new object;
    };
  }());

  function baseHas(object, key) {
    return object != null && hasOwnProperty.call(object, key);
  }

  function mixin(object, source) {
    var result = object(this.__wrapped__);
    return result;
  }

  function handler() {}

  function run() {
    if (handler) {
      handler();
    }
    const walk = (node) => (node ? walk(node.next) : null);
    return walk(context);
  }

  return { baseCreate, baseHas, mixin, run };
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const targetsFrom = (qualifiedName: string) => {
  const ids = cg.getNodesInFile('lodash.js').filter((n) => n.qualifiedName === qualifiedName).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('JS names the calling function binds', () => {
  it('are its parameters, not a same-named function elsewhere in the file', () => {
    expect(targetsFrom('runInContext::baseHas')).not.toContain('runInContext::object');
    expect(targetsFrom('runInContext::mixin')).not.toContain('runInContext::object');
  });

  it('leave unbound names and a const’s own recursion alone', () => {
    expect(targetsFrom('runInContext::run')).toContain('runInContext::handler');
    expect(targetsFrom('runInContext::run::walk')).toContain('runInContext::run::walk');
  });
});

/**
 * The same holds for a TypeScript parameter whose type or default holds
 * parentheses, generics or braces, and across files: bitwarden's
 * `isAvailable(f)` on a callback parameter typed `(f: string) => boolean`
 * reached the napi `isAvailable` another file exports, and vscode's merge
 * editor's `compare(a, b)` on a comparator parameter a `strings.ts`
 * `compare`. A parameter shadows the file's own import of the name too, but
 * only where it is in scope: inside its function's or arrow's body, never
 * after it. Neither does `const syncState$` declare `syncState`, nor `const
 * X = require('./x').default` hide the import it is.
 */
describe('TS parameters of any type are the calling function’s, in any file', () => {
  let tsRoot = '';
  let ts: CodeGraph;

  beforeAll(async () => {
    tsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-local-ts-'));
    const files: Record<string, string> = {
      'src/sdk.ts': 'export function isAvailable(format: string): boolean { return format.length > 0; }\n',
      'src/strings.ts': 'export function compare(a: number, b: number): number { return a - b; }\n',
      'src/use.ts': `import { isAvailable } from './sdk';
export function check(format: string): boolean {
  return isAvailable(format);
}
export function pick(formats: string[], isAvailable: (f: string) => boolean): string[] {
  return formats.filter((f) => isAvailable(f));
}
export function pickDefault(formats: string[], isAvailable = (f: string) => f.length > 0): string[] {
  return formats.filter((f) => isAvailable(f));
}
`,
      'src/sort.ts': `export const compareAll = (items: number[], compare: (a: number, b: number) => number) =>
  items.sort((a, b) => compare(a, b));
export function later(cb: () => void, options: Map<string, number>, compare: unknown): void {
  cb();
  (compare as (a: number, b: number) => number)(options.size, 0);
}
export class Sorter {
  constructor(private readonly compare: (a: number, b: number) => number) {
    compare(1, 2);
  }
}
`,
      'src/other.ts': `export function sortAll(items: number[]): number[] {
  return items.sort((a, b) => compare(a, b));
}
`,
      'src/state.ts': 'export function syncState(obs: object): object { return obs; }\n',
      'src/sync.ts': `import { syncState } from './state';
export function syncObservable(obs$: object): object {
  const syncState$ = syncState(obs$);
  return syncState$;
}
export function syncLater(items: object[]): object {
  items.forEach((syncState) => console.log(syncState));
  return syncState(items);
}
export function syncInside(items: object[]): void {
  items.forEach((syncState: (o: object) => object) => {
    syncState(items);
  });
}
`,
      'src/paths.ts': 'export function resolve(...parts: string[]): string { return parts.join("/"); }\n',
      // No semicolons after the arrow in fmtAll, as a project formatted without them writes it.
      'src/run.ts': `import { resolve } from './paths';
export function run(file: string): Promise<void> {
  return new Promise((resolve) => {
    resolve(file);
  });
}
export function runThen(file: string): string {
  new Promise<void>((resolve) => setTimeout(resolve, 0));
  return resolve(file, 'out');
}
export function fmtAll(items: string[]): string {
  const fmt = (resolve: string) => resolve.trim()
  return resolve(fmt(items[0]))
}
export function eachInLoop(files: string[]): void {
  for (const resolve of [String]) resolve(files[0]);
}
export function eachAfterLoop(files: string[]): string {
  for (const resolve of [String]) String(resolve);
  return resolve(files[1]);
}
export function bare(): Promise<void> {
  return new Promise<void>(resolve => {
    resolve();
  });
}
export function bareThen(file: string): string {
  new Promise<void>(resolve => setTimeout(resolve, 0));
  return resolve(file);
}
export function nested(file: string): string {
  function resolve(p: string): string { return p; }
  return resolve(file);
}
`,
      'src/widget.ts': 'export class Widget {}\nexport type Size = { width: number };\n',
      // A return type's name is no lone arrow parameter, and a value never hides a type.
      'src/build.ts': `import { Widget, type Size } from './widget';
export const buildWidget = (name: string): Widget => {
  return new Widget();
};
export function measure(Size: number): number {
  const size: Size = { width: Size };
  return size.width;
}
`,
      // The object type a function returns is no body: withShape's own one still holds its parameter.
      'src/shape.ts': `import { compare } from './strings';
export function withShape(compare: (a: number, b: number) => number): { sorted: number[]; size: number } {
  return { sorted: [compare(1, 2)], size: 1 };
}
export function plain(a: number, b: number): number {
  return compare(a, b);
}
`,
      'src/biometrics.ts': `export default class OsBiometrics {
  constructor(readonly name: string) {}
}
`,
      // describeBiometrics binds the name too, so the file's bindings alone don't settle init's.
      'src/service.ts': `export class BiometricsService {
  private service: object | undefined;
  init(platform: string): void {
    if (platform === 'darwin') {
      const OsBiometrics = require('./biometrics').default;
      this.service = new OsBiometrics('mac');
    }
  }
}
export function describeBiometrics(OsBiometrics: unknown): string {
  return String(OsBiometrics);
}
`,
      // An anonymous IIFE's calls are the file's own: only the file's view of
      // its bindings sees the parameter, after a function-typed one.
      'src/iife.ts': `((done: () => void, compare: (a: number, b: number) => number) => {
  compare(1, 2);
  done();
})(() => {}, (a, b) => a - b);
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tsRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(tsRoot, rel), content);
    }
    ts = await CodeGraph.init(tsRoot, { index: true });
  });

  afterAll(() => {
    ts?.close();
    if (tsRoot) fs.rmSync(tsRoot, { recursive: true, force: true });
  });

  /** `<file>:<qualified name>` of every call (or edge of `kind`) the named symbol in `file` makes. */
  const callsFrom = (file: string, name: string, kind = 'calls'): string[] => {
    const node = ts.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'file')!;
    expect(node, `${file} ${name}`).toBeDefined();
    return ts.getOutgoingEdges(node.id).filter((e) => e.kind === kind).map((e) => {
      const target = ts.getNode(e.target)!;
      return `${target.filePath}:${target.qualifiedName}`;
    });
  };

  it('a parameter typed as a function, or defaulted to one, calls what it is given', () => {
    expect(callsFrom('src/use.ts', 'pick')).toEqual([]);
    expect(callsFrom('src/use.ts', 'pickDefault')).toEqual([]);
    expect(callsFrom('src/sort.ts', 'compareAll')).toEqual([]);
  });

  it('after earlier parameters with function and generic types, and as a parameter property', () => {
    expect(callsFrom('src/sort.ts', 'later')).toEqual([]);
    expect(callsFrom('src/sort.ts', 'constructor')).toEqual([]);
  });

  it('shadows the file’s import of the name, which a function binding nothing still calls', () => {
    expect(callsFrom('src/use.ts', 'check')).toEqual(['src/sdk.ts:isAvailable']);
  });

  it('in code no function node holds, the parameter list the call sits in', () => {
    const file = ts.getNodesInFile('src/iife.ts').find((n) => n.kind === 'file')!;
    const calls = ts.getOutgoingEdges(file.id).filter((e) => e.kind === 'calls').map((e) => ts.getNode(e.target)!.filePath);
    expect(calls).not.toContain('src/strings.ts');
  });

  it('leaves a name no function binds to the matcher', () => {
    expect(callsFrom('src/other.ts', 'sortAll')).toEqual(['src/strings.ts:compare']);
  });

  it('shadows an import only inside the body that binds the name', () => {
    expect(callsFrom('src/sync.ts', 'syncInside')).toEqual([]);
    expect(callsFrom('src/run.ts', 'run')).toEqual([]);
    expect(callsFrom('src/run.ts', 'eachInLoop')).toEqual([]);
    expect(callsFrom('src/sync.ts', 'syncLater')).toEqual(['src/state.ts:syncState']);
    expect(callsFrom('src/run.ts', 'runThen')).toEqual(['src/paths.ts:resolve']);
    expect(callsFrom('src/run.ts', 'eachAfterLoop')).toEqual(['src/paths.ts:resolve']);
  });

  it('ends an arrow’s expression body at a line that starts the next statement', () => {
    expect(callsFrom('src/run.ts', 'fmtAll')).toContain('src/paths.ts:resolve');
  });

  it('reads a lone arrow parameter, a nested function and a body after an object return type', () => {
    expect(callsFrom('src/run.ts', 'bare')).toEqual([]);
    expect(callsFrom('src/run.ts', 'bareThen')).toEqual(['src/paths.ts:resolve']);
    expect(callsFrom('src/run.ts', 'nested')).not.toContain('src/paths.ts:resolve');
    expect(callsFrom('src/shape.ts', 'withShape')).toEqual([]);
    expect(callsFrom('src/shape.ts', 'plain')).toEqual(['src/strings.ts:compare']);
  });

  it('takes no return type for a parameter, and lets no value hide a type', () => {
    expect(callsFrom('src/build.ts', 'buildWidget', 'instantiates')).toEqual(['src/widget.ts:Widget']);
    expect(callsFrom('src/build.ts', 'measure', 'references')).toContain('src/widget.ts:Size');
  });

  it('reads `syncState$` as no declaration of `syncState`, and a required local as the import', () => {
    expect(callsFrom('src/sync.ts', 'syncObservable')).toEqual(['src/state.ts:syncState']);
    expect(callsFrom('src/service.ts', 'init', 'instantiates')).toEqual(['src/biometrics.ts:OsBiometrics']);
  });
});
