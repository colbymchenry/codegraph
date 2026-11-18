/**
 * A C# call through a null-conditional or null-forgiving receiver —
 * `_maybe?.Send("b")`, `_maybe!.Send("c")` — calls the member a plain `.`
 * would (#2906). Both extractors kept the receiver's raw text, `_maybe?.Send`,
 * which no receiver rule reads, so every such call went unlinked: in the
 * issue's sample only `_mailer.Send("a")` reached `Mailer.Send`. The chain is
 * now spelled with plain dots, and the receiver is typed as `_maybe.Send` is:
 * a field, a property or a parameter declared `Mailer?`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

const CONSUMER = `public class Mailer
{
    public void Send(string to) { }
}

public class Queue
{
    public void Send(string to) { }
}

public class Consumer
{
    private readonly Mailer _mailer = new Mailer();
    private Mailer? _maybe;
    private Mailer? Maybe { get; set; }

    public void Plain() { _mailer.Send("a"); }
    public void NullConditional() { _maybe?.Send("b"); }
    public void NullForgiving() { _maybe!.Send("c"); }
    public void ThisNullConditional() { this._maybe?.Send("d"); }
    public void Property() { Maybe?.Send("e"); }
    public void Parameter(Mailer? m) { m?.Send("f"); }
    public void Wrapped()
    {
        _maybe
            ?.Send("g");
    }
}
`;

describe('C# null-conditional receivers are recorded with plain dots (#2906)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['csharp']);
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

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('Consumer.cs', source, 'csharp');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('Consumer.cs', source, 'csharp');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  it.each(backends)('%s', (backend) => {
    const names = extract(backend, CONSUMER).unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName.replace(/\s+/g, ''))
      .sort();
    expect(names).toEqual([
      'Maybe.Send',
      '_mailer.Send',
      '_maybe.Send',
      '_maybe.Send',
      '_maybe.Send',
      'm.Send',
      'this._maybe.Send',
    ]);
  });
});

describe.each(['default', 'wasm'])('C# null-conditional calls link the receiver type\'s method (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-nullcond-'));
    fs.writeFileSync(
      path.join(root, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>\n',
    );
    fs.writeFileSync(path.join(root, 'Consumer.cs'), CONSUMER);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `<caller> -> <callee>` for every call edge into a `Send`. */
  function sends(): string[] {
    const out: string[] = [];
    for (const target of cg!.getNodesInFile('Consumer.cs').filter((n) => n.name === 'Send')) {
      for (const e of cg!.getIncomingEdges(target.id).filter((x) => x.kind === 'calls')) {
        out.push(`${cg!.getNode(e.source)!.name} -> ${target.qualifiedName}`);
      }
    }
    return out.sort();
  }

  // (Wrapped's receiver sits alone on the line above `?.Send(…)`. It links no
  // better than the same call written with a plain `.`: the chain keeps its
  // line break.)
  it("links `_maybe?.Send(…)` and its kin to Mailer's Send, never Queue's", () => {
    expect(sends()).toEqual([
      'NullConditional -> Mailer::Send',
      'NullForgiving -> Mailer::Send',
      'Parameter -> Mailer::Send',
      'Plain -> Mailer::Send',
      'Property -> Mailer::Send',
      'ThisNullConditional -> Mailer::Send',
    ]);
  });
});
