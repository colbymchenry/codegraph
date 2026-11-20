/**
 * A C# method group through a receiver — `Task.Run(worker.Run)`, `Action
 * later = worker.Run;` — names a method as a value (#2906). Both extractors
 * kept such a value only when the receiver was `this`, so `callers` and
 * `impact` on `Worker.Run` said nothing used it. The value now keeps its
 * receiver, as Go's and Python's member values do, and links the method of
 * the receiver's declared type (or of the type it names), or nothing: a
 * property read is captured the same way and links nothing.
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

const CONSUMER = `using System;
using System.Threading.Tasks;

namespace App;

public class Worker
{
    public string Name { get; set; } = "";
    public void Run() { }
    public static void Tick() { }
}

public class Runner
{
    public void Run() { }
}

public class Consumer
{
    private readonly Worker _worker = new Worker();

    public Task MethodGroupArgument()
    {
        var worker = new Worker();
        return Task.Run(worker.Run);
    }

    public Action MethodGroupAssignment()
    {
        var worker = new Worker();
        Action later = worker.Run;
        return later;
    }

    public void Field() { Task.Run(this._worker.Run); }

    public void Static() { Task.Run(Worker.Tick); }

    public string Property(Worker w) { var name = w.Name; return name; }

    public void Keyword(string s) { Func<string> f = s.Trim; }
}
`;

describe('C# method groups through a receiver are recorded with it (#2906)', () => {
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
    const refs = extract(backend, CONSUMER).unresolvedReferences
      .filter((r) => r.referenceKind === 'function_ref')
      .map((r) => `${r.referenceName} ${r.line}:${r.column}`)
      .sort();
    expect(refs).toEqual([
      'Worker.Tick 37:43',
      '_worker.Run 35:48',
      'w.Name 39:52',
      'worker.Run 25:31',
      'worker.Run 31:30',
      's.Trim 41:55',
    ].sort());
  });
});

describe.each(['default', 'wasm'])('C# method groups link the method of the receiver\'s type (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-groups-'));
    fs.writeFileSync(
      path.join(root, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
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

  /** `<caller> -> <target>` for every `references` edge out of Consumer's methods. */
  function references(): string[] {
    const out: string[] = [];
    for (const m of cg!.getNodesInFile('Consumer.cs').filter((n) => n.kind === 'method' && n.qualifiedName.includes('Consumer::'))) {
      for (const e of cg!.getOutgoingEdges(m.id).filter((x) => x.kind === 'references')) {
        const t = cg!.getNode(e.target)!;
        if (t.kind === 'method') out.push(`${m.name} -> ${t.qualifiedName}`);
      }
    }
    return out.sort();
  }

  it("links `worker.Run` to Worker's Run, never Runner's, and a property read or a string's method to nothing", () => {
    expect(references()).toEqual([
      'Field -> App::Worker::Run',
      'MethodGroupArgument -> App::Worker::Run',
      'MethodGroupAssignment -> App::Worker::Run',
      'Static -> App::Worker::Tick',
    ]);
  });
});
