/**
 * A TypeScript interface is linked to the interfaces it extends.
 *
 *   interface Repo<T> { find(id: string): T }
 *   interface UserRepo extends Repo<User>, Named {}
 *
 * The grammar holds an interface's supertypes in an `extends_type_clause`,
 * which neither the wasm extractor nor the native kernel read: a class's
 * `extends` and `implements` became edges, an interface's `extends` nothing.
 * So an interface had no place in the type hierarchy — a class implementing
 * `UserRepo` showed nothing above it — and an interface that is only ever
 * extended had no dependents. Now each supertype is an `extends` reference,
 * resolved like a class's: a plain name, a qualified one (`shapes.Shape`), or
 * a parameterized one by its name alone (`Repo`, never `Repo<User>`). It goes
 * through the file's imports first, so a package's type (`ButtonProps` from
 * '@mui/material') never reaches a project namesake.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const SOURCE = `interface A extends B, ns.C, Repo<T>, ns.D<string> {}
interface E<T extends object> extends F<T> {}
export default interface P extends Q {}
declare module 'pkg' {
  interface N extends O {}
}
declare global {
  interface Window extends Gadget {}
}
class G extends H implements L, ns.M {}
interface Commented extends B /* not a type */, C {}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe("an interface's extends clause is read", () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  /** `<from> <kind> <name>@<line>:<column>` for every supertype reference. */
  const supertypeRefs = (result: ExtractionResult): string[] => {
    const names = new Map(result.nodes.map((n) => [n.id, n.name]));
    return result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends' || r.referenceKind === 'implements')
      .map((r) => `${names.get(r.fromNodeId)} ${r.referenceKind} ${r.referenceName}@${r.line}:${r.column}`);
  };

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`each supertype is a reference, a parameterized one by its name: %s${label}`, (backend) => {
      expect(supertypeRefs(extract(backend, 'src/types.ts', eol(SOURCE), 'typescript'))).toEqual([
        'A extends B@1:20',
        'A extends ns.C@1:23',
        'A extends Repo@1:29',
        'A extends ns.D@1:38',
        // A type parameter's constraint is not a supertype.
        'E extends F@2:38',
        'P extends Q@3:35',
        'N extends O@5:22',
        'Window extends Gadget@8:27',
        // A class's clauses are read as before.
        'G extends H@10:16',
        'G implements L@10:29',
        'G implements ns.M@10:32',
        // A comment in the clause is not a supertype.
        'Commented extends B@11:28',
        'Commented extends C@11:48',
      ]);
    });

    it.each(backends)(`in a tsx file too: %s${label}`, (backend) => {
      const source = eol('interface Props extends Base<string> {}\nexport const App = (p: Props) => <main />;\n');
      expect(supertypeRefs(extract(backend, 'src/App.tsx', source, 'tsx'))).toEqual(['Props extends Base@1:24']);
    });
  }

  it.runIf(kernelAvailable)('the kernel and the wasm extractor agree on every node and reference', () => {
    const canon = (r: ExtractionResult) => [
      ...r.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())),
      ...r.unresolvedReferences.map((ref) => JSON.stringify(ref, Object.keys(ref).sort())),
    ].sort();
    expect(canon(extract('kernel', 'src/types.ts', SOURCE, 'typescript'))).toEqual(
      canon(extract('wasm', 'src/types.ts', SOURCE, 'typescript'))
    );
  });
});

describe('an interface links the interfaces it extends', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-interface-extends-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@mui/material': '^5.0.0', lib: '^1.0.0' } }),
      'src/shapes.ts': `export interface Shape {
  area(): number;
}
export interface Named {
  name: string;
}
`,
      'src/repo.ts': `export interface Repo<T> {
  find(id: string): T;
}
`,
      // Namesakes of the package's ButtonProps and of the global Error.
      'src/legacy/button.ts': `export interface ButtonProps {
  legacy: true;
}
export class Error {}
`,
      // The repository declares the package 'lib' itself (#2718).
      'typings/lib.d.ts': `declare module 'lib' {
  export interface Options { verbose: boolean }
}
`,
      // A module's own `Omit`, a namespace's `Function`, and two globals: a
      // script's top level and a module's `declare global`.
      'src/legacy/quick.ts': `export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
`,
      'typings/fig.d.ts': `declare namespace Fig {
  type Function<T = void, R = void> = (param: T) => R;
}
`,
      'typings/globals.d.ts': `interface GlobalShape {
  id: string;
}
`,
      'src/globals.ts': `export const appName = 'app';
declare global {
  interface Window {
    appName: string;
  }
}
`,
      'src/model.ts': `import { Shape, Named } from './shapes';
import * as shapes from './shapes';
import { Repo } from './repo';
import { ButtonProps } from '@mui/material';
import { Options } from 'lib';

interface Base {
  a(): void;
}
interface Other {
  b(): void;
}
export interface Sub extends Base {}
export interface Both extends Base, Other {}
export interface Circle extends Shape, Named {}
export interface Square extends shapes.Shape {}
export interface User { id: string }
export interface UserRepo extends Repo<User> {}
export interface MyButtonProps extends ButtonProps {}
export interface MyOptions extends Options {}
export interface MyError extends Error {}
export interface Picked extends Omit<Base, 'a'> {}
export interface Callable extends Function {}
export interface Located extends GlobalShape {}
export interface WindowWithApp extends Window {}
class BaseImpl {}
export class Impl extends BaseImpl implements Sub {
  a(): void {}
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

  const nodeOf = (file: string, name: string) => {
    const node = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'file' && n.kind !== 'import');
    expect(node, `${file} ${name}`).toBeDefined();
    return node!;
  };

  /** `<kind> <file>:<qualified name>` of the supertype edges `name` in model.ts declares. */
  const supertypes = (name: string): string[] =>
    cg.getOutgoingEdges(nodeOf('src/model.ts', name).id)
      .filter((e) => e.kind === 'extends' || e.kind === 'implements')
      .map((e) => {
        const target = cg.getNode(e.target)!;
        return `${e.kind} ${target.filePath}:${target.qualifiedName}`;
      })
      .sort();

  it('a same-file supertype, and several', () => {
    expect(supertypes('Sub')).toEqual(['extends src/model.ts:Base']);
    expect(supertypes('Both')).toEqual(['extends src/model.ts:Base', 'extends src/model.ts:Other']);
  });

  it('an imported supertype, through a named import and a namespace import', () => {
    expect(supertypes('Circle')).toEqual(['extends src/shapes.ts:Named', 'extends src/shapes.ts:Shape']);
    expect(supertypes('Square')).toEqual(['extends src/shapes.ts:Shape']);
  });

  it('a parameterized supertype, by its name', () => {
    expect(supertypes('UserRepo')).toEqual(['extends src/repo.ts:Repo']);
  });

  it("the repository's own declaration of a package's type", () => {
    expect(supertypes('MyOptions')).toEqual(['extends typings/lib.d.ts:Options']);
  });

  it("a package's type or a global never reaches a project namesake", () => {
    expect(supertypes('MyButtonProps')).toEqual([]);
    expect(supertypes('MyError')).toEqual([]);
  });

  it("a name the module doesn't import is its own or a global, never another module's or a namespace's", () => {
    expect(supertypes('Picked')).toEqual([]);
    expect(supertypes('Callable')).toEqual([]);
    expect(supertypes('Located')).toEqual(['extends typings/globals.d.ts:GlobalShape']);
    expect(supertypes('WindowWithApp')).toEqual(['extends src/globals.ts:Window']);
  });

  it("a class's extends and implements are unchanged", () => {
    expect(supertypes('Impl')).toEqual(['extends src/model.ts:BaseImpl', 'implements src/model.ts:Sub']);
  });

  it('the type hierarchy runs through the interface: above a class implementing it, and below its supertype', () => {
    const above = buildTypeHierarchy(cg, nodeOf('src/model.ts', 'Impl'))!;
    expect(above.ancestors.map((a) => `${a.depth} ${a.relation} ${a.node.name}`)).toEqual([
      '1 extends BaseImpl',
      '1 implements Sub',
      '2 extends Base',
    ]);
    const below = buildTypeHierarchy(cg, nodeOf('src/model.ts', 'Base'))!;
    expect(below.descendants.map((d) => `${d.depth} ${d.relation} ${d.node.name}`).sort()).toEqual([
      '1 extends Both',
      '1 extends Sub',
      '2 implements Impl',
    ]);
  });

  it("a change to an interface reaches the interfaces built on it, and their implementers", () => {
    const impact = cg.getImpactRadius(nodeOf('src/model.ts', 'Base').id);
    const reached = [...impact.nodes.values()].filter((n) => n.kind === 'interface' || n.kind === 'class').map((n) => n.name);
    expect(reached.sort()).toEqual(['Base', 'Both', 'Impl', 'Sub']);
  });
});

/**
 * A call on a value typed by an interface that only inherits the method
 * reaches the declaration in the interface's own supertype: home-assistant's
 * `hass.formatEntityName(…)` on a `HomeAssistant`, which extends seven
 * interfaces over a head too long to read from its source text, and vscode's
 * `receiver.dispose()` on an `ILocalOtlpHttpReceiver extends IDisposable`
 * while another app in the repository declares an `IDisposable` of its own.
 */
describe('a call through an interface reaches the method its supertype declares', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-interface-extends-calls-'));
    const files: Record<string, string> = {
      'src/types.ts': `export interface HomeAssistantRegistries { entities: string[] }
export interface HomeAssistantInternationalization { language: string }
export interface HomeAssistantApi {
  callService(domain: string): void;
}
export interface HomeAssistantFormatters {
  formatEntityName(entity: string): string;
}
export interface HomeAssistantConnection { connected: boolean }
export interface HomeAssistantUI { themes: string[] }
export interface HomeAssistantConfig { config: string }
export interface HomeAssistant
  extends
    HomeAssistantRegistries,
    HomeAssistantInternationalization,
    HomeAssistantApi,
    HomeAssistantFormatters,
    HomeAssistantConnection,
    HomeAssistantUI,
    HomeAssistantConfig {
  user: string;
}
`,
      // A namesake method in an unrelated file.
      'src/resources/completions.ts': `export interface HassArgHoverContext {
  formatEntityName(entity: string): string;
}
`,
      'src/data/describe.ts': `import type { HomeAssistant } from '../types';
export function describe(hass: HomeAssistant): string {
  hass.callService('light');
  return hass.formatEntityName('light.kitchen');
}
`,
      // Another app's IDisposable, ahead of the project's own in the index.
      'extensions/copilot/src/util/lifecycle.ts': `export interface IDisposable {
  dispose(): void;
}
`,
      'src/base/lifecycle.ts': `export interface IDisposable {
  dispose(): void;
}
`,
      'src/otel/receiver.ts': `import { IDisposable } from '../base/lifecycle';
export interface ILocalReceiver extends IDisposable {
  readonly port: number;
}
export async function startReceiver(port: number): Promise<ILocalReceiver> {
  return { port, dispose() {} };
}
`,
      'src/otel/run.ts': `import { startReceiver } from './receiver';
export async function run(): Promise<void> {
  const receiver = await startReceiver(0);
  receiver.dispose();
}
`,
      // A project interface named like Node's `NodeJS.ReadableStream`.
      'src/base/stream.ts': `export interface ReadableStreamEvents<T> {
  on(event: 'data', listener: (data: T) => void): void;
}
export interface ReadableStream<T> extends ReadableStreamEvents<T> {
  pause(): void;
}
`,
      'src/shim/runner.ts': `export function listen(stream: NodeJS.ReadableStream, listener: (chunk: string) => void): void {
  stream.on('data', listener);
}
`,
      // Two supertypes that both have the method, one through its own
      // supertype, again over a head too long to read.
      'src/widgets.ts': `export interface IBase {
  render(): void;
}
export interface IMiddle extends IBase {}
export interface IRenderable {
  render(): void;
}
export interface ISized { width: number }
export interface IPositioned { x: number }
export interface IStyled { color: string }
export interface INamed { name: string }
export interface IVisible { visible: boolean }
export interface IWidget
  extends
    IMiddle,
    ISized,
    IPositioned,
    IStyled,
    INamed,
    IVisible,
    IRenderable {}
export function draw(widget: IWidget): void {
  widget.render();
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

  /** `<file>:<qualified name>` of every call `fn` in `file` makes. */
  const callees = (file: string, fn: string): string[] => {
    const node = cg.getNodesInFile(file).find((n) => n.name === fn && n.kind === 'function')!;
    expect(node, `${file} ${fn}`).toBeDefined();
    return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'calls').map((e) => {
      const target = cg.getNode(e.target)!;
      return `${target.filePath}:${target.qualifiedName}`;
    }).sort();
  };

  it("through a composite interface, the member of the supertype that declares it, not a namesake's", () => {
    expect(callees('src/data/describe.ts', 'describe')).toEqual([
      'src/types.ts:HomeAssistantApi::callService',
      'src/types.ts:HomeAssistantFormatters::formatEntityName',
    ]);
  });

  it('the supertype the interface extends, not a same-named one elsewhere', () => {
    expect(callees('src/otel/run.ts', 'run')).toEqual([
      'src/base/lifecycle.ts:IDisposable::dispose',
      'src/otel/receiver.ts:startReceiver',
    ]);
  });

  it("a type from outside the project reaches none of a project namesake's supertypes", () => {
    expect(callees('src/shim/runner.ts', 'listen')).toEqual([]);
  });

  it('each supertype, and then its own supertypes, in the order they are written', () => {
    expect(callees('src/widgets.ts', 'draw')).toEqual(['src/widgets.ts:IBase::render']);
  });
});
