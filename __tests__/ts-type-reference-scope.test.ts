/**
 * A type an ES module names without importing it is the module's own or a
 * global one — never another module's type of that name.
 *
 *   // quickInput.ts
 *   export type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
 *   // picker.ts
 *   export function pick(options: Omit<IPickOptions, 'canPickMany'>) {}
 *
 * picker.ts's `Omit` is TypeScript's own, yet a type annotation's name went
 * to the name matcher like any other, which handed it the one project type
 * of that name: 336 of vscode's annotations reached quickInput.ts's `export
 * type Omit`. #2726 held a supertype to this rule; a type annotation, a type
 * argument and a type alias's value now follow it too. A type the file
 * declares, one a script's top level or a `declare global` block declares,
 * and the last name of a qualified type (`qi.IPickOptions`) link as before.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-type-scope-'));
  const files: Record<string, string> = {
    'src/quickInput.ts': `export type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
export interface IPickOptions { canPickMany?: boolean; title?: string }
`,
    'src/events.ts': 'export class Event { constructor(readonly type: string) {} }\n',
    'src/picker.ts': `import { IPickOptions } from './quickInput';
type Local = { id: string };
export function pick(options: Omit<IPickOptions, 'canPickMany'>): Local {
  return { id: options.title ?? '' };
}
export function onClick(handler: (e: Event) => void): void {
  void handler;
}
export type Picked = Omit<IPickOptions, 'title'>;
`,
    // An augmentation's names are the augmented module's own, imported or not.
    'src/react/reactInterfaces.ts': 'export type FCReactive<P, P2> = P & P2;\nexport interface IReactive { base?: string }\n',
    'src/types/reactive-native.d.ts': `import type { IReactive } from '../react/reactInterfaces';
declare module '../react/reactInterfaces' {
  interface IReactive {
    View: FCReactive<IReactive, { style?: string }>;
  }
}
`,
    // An `import X = ns.X` alias imports its name, as bitwarden's desktop code does napi's classes.
    'src/napi.d.ts': 'export declare namespace autofill {\n  export class IpcServer { listen(): void }\n}\n',
    'src/alias.ts': `import { autofill } from './napi';
import IpcServer = autofill.IpcServer;
export function serve(server: IpcServer): void {
  void server;
}
`,
    // Only the namespace is imported: `IPickOptions` is recorded alone, written qualified.
    'src/qualified.ts': `import * as qi from './quickInput';
export function qualified(options: qi.IPickOptions): void {
  void options;
}
`,
    // A script declaration file (no import or export): its declarations are global.
    'src/typings/globals.d.ts': 'interface GlobalThing { id: string }\n',
    // A module's `declare global` block, and a module-scoped namesake nearer the user.
    'src/env.ts': `export {};
declare global {
  interface AppConfig { debug: boolean }
}
`,
    'src/app/config.ts': 'export interface AppConfig { port: number }\n',
    'src/app/use.ts': `export function useGlobal(thing: GlobalThing): string {
  return thing.id;
}
export function useConfig(config: AppConfig): boolean {
  return config.debug;
}
export function useScripts(thing: LegacyThing, fixture: FixtureGlobal): number {
  return thing.id + fixture.x;
}
export const firstOf = <T>(items: T[]): T | undefined => items[0];
export function useShared(shape: SharedShape): string {
  return shape.id;
}
`,
    // A global both the project and a nearer fixture declare: the project's wins, ahead of the ranking.
    'types/shared.d.ts': 'interface SharedShape { id: string }\n',
    'src/app/__tests__/shared-fixture.d.ts': 'interface SharedShape { id: string; fixture: true }\n',
    // A script .ts is no declaration file: its top level is global to its own program only.
    'src/legacy/globals.ts': 'interface LegacyThing { id: number }\n',
    // A fixture's globals are its tests' — a declaration file's, and a colorize-style script's `type T`.
    'test/fixtures/fixture.d.ts': 'interface FixtureGlobal { x: number }\n',
    'test/fixtures/colorize.ts': 'const n = null;\ntype T = null | undefined;\n',
    'test/use-fixture.test.ts': `export function check(fixture: FixtureGlobal): number {
  return fixture.x;
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

/** `<file>:<qualified name>` of every type the named symbol in `file` references. */
const referencesFrom = (file: string, name: string): string[] => {
  const node = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'file')!;
  expect(node, `${file} ${name}`).toBeDefined();
  return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'references').map((e) => {
    const target = cg.getNode(e.target)!;
    return `${target.filePath}:${target.qualifiedName}`;
  });
};

describe('a type a TS module names without importing it', () => {
  it('is no other module’s type of that name: TypeScript’s Omit, the DOM’s Event', () => {
    const picked = referencesFrom('src/picker.ts', 'pick');
    expect(picked).not.toContain('src/quickInput.ts:Omit');
    expect(referencesFrom('src/picker.ts', 'onClick')).not.toContain('src/events.ts:Event');
    expect(referencesFrom('src/picker.ts', 'Picked')).not.toContain('src/quickInput.ts:Omit');
  });

  it('is the module’s own type, and an imported one still links through its import', () => {
    const picked = referencesFrom('src/picker.ts', 'pick');
    expect(picked).toContain('src/picker.ts:Local');
    expect(picked).toContain('src/quickInput.ts:IPickOptions');
    expect(referencesFrom('src/picker.ts', 'Picked')).toContain('src/quickInput.ts:IPickOptions');
  });

  it('is a global: a script’s top level or a declare global block, ahead of a nearer module’s namesake', () => {
    expect(referencesFrom('src/app/use.ts', 'useGlobal')).toContain('src/typings/globals.d.ts:GlobalThing');
    const config = referencesFrom('src/app/use.ts', 'useConfig');
    expect(config).toContain('src/env.ts:AppConfig');
    expect(config).not.toContain('src/app/config.ts:AppConfig');
  });

  it('leaves the last name of a qualified type to link as before', () => {
    expect(referencesFrom('src/qualified.ts', 'qualified')).toContain('src/quickInput.ts:IPickOptions');
  });

  it('leaves a name inside a declare module block to the module it declares', () => {
    expect(referencesFrom('src/types/reactive-native.d.ts', 'View')).toContain('src/react/reactInterfaces.ts:FCReactive');
  });

  it('is no script .ts’s top-level type, nor a fixture’s outside the tests', () => {
    expect(referencesFrom('src/app/use.ts', 'useScripts')).toEqual([]);
    expect(referencesFrom('src/app/use.ts', 'firstOf')).not.toContain('test/fixtures/colorize.ts:T');
    expect(referencesFrom('test/use-fixture.test.ts', 'check')).toContain('test/fixtures/fixture.d.ts:FixtureGlobal');
    expect(referencesFrom('src/app/use.ts', 'useShared')).toEqual(['types/shared.d.ts:SharedShape']);
  });

  it('counts an import X = ns.X alias as an import of its name', () => {
    expect(referencesFrom('src/alias.ts', 'serve').some((t) => t.startsWith('src/napi.d.ts:') && t.endsWith('IpcServer'))).toBe(true);
  });
});
