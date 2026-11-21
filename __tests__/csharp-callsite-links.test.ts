/** C# call evidence must name and point at the method token it actually links. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource, TreeSitterExtractor } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resetKernelForTests, tryKernelExtract } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';
import { callSiteInSource } from '../src/graph/branch-guards';

const kernelBuilt = fs.existsSync(path.join(
  __dirname, '..', 'codegraph-kernel', 'prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node',
));
const envKeys = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

function position(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') - 1 };
}

for (const mode of ['wasm', 'native'] as const) {
  describe.skipIf(mode === 'native' && !kernelBuilt)(`C# call-site links (${mode})`, () => {
    let savedEnv: Record<string, string | undefined>;
    const roots: string[] = [];

    beforeAll(async () => {
      await initGrammars();
      await loadGrammarsForLanguages(['csharp']);
    });
    beforeEach(() => {
      savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      process.env.CODEGRAPH_KERNEL = mode === 'wasm' ? '0' : '1';
      process.env.CODEGRAPH_KERNEL_LANGS = 'all';
      resetKernelForTests();
    });
    afterEach(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      resetKernelForTests();
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    function extract(source: string): ExtractionResult {
      if (mode === 'wasm') return new TreeSitterExtractor('Consumer.cs', source, 'csharp').extract();
      const result = tryKernelExtract('Consumer.cs', source, 'csharp');
      // A fallback would hide a broken native implementation behind the wasm fix.
      expect(result, 'native C# extraction must not defer').not.toBeNull();
      return result!;
    }

    async function index(files: Record<string, string>): Promise<CodeGraph> {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-callsite-'));
      roots.push(root);
      for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
      return CodeGraph.init(root, { index: true });
    }

    for (const newline of ['\n', '\r\n']) {
      for (const expression of [
        'Reader.Parse(input)',
        'Reader \t . \t Parse(input)',
        'Reader\n      .Parse(input)',
        'Reader\n      .\n      Parse(input)',
        'Reader /* receiver */\n      . /* member */ Parse(input)',
      ]) {
        it(`keeps the qualified name and method-token position: ${JSON.stringify(expression)} (${JSON.stringify(newline)})`, () => {
          const source = `class Consumer { string Read(string input) { /* 🧭 */ return ${expression}; } }`
            .replace(/\n/g, newline);
          const result = extract(source);
          const read = result.nodes.find((node) => node.name === 'Read')!;
          const calls = result.unresolvedReferences.filter((ref) => ref.fromNodeId === read.id && ref.referenceKind === 'calls');
          expect(calls).toEqual([expect.objectContaining({
            referenceName: 'Reader.Parse',
            ...position(source, source.indexOf('Parse')),
          })]);
        });
      }
    }

    it('normalizes dotted namespace paths without dropping their receiver', () => {
      const source = 'class Consumer { string Read(string input) => Tools /* ns */\n .Reader\n .Parse(input); }';
      const result = extract(source);
      expect(result.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls')).toEqual([
        expect.objectContaining({ referenceName: 'Tools.Reader.Parse', ...position(source, source.indexOf('Parse')) }),
      ]);
    });

    it('preserves field/property chains and multiline parameter declarations', async () => {
      const cg = await index({
        'Values.cs': `namespace Demo;
public class Service { public void Run() { } }
public class Builder { public Service Services { get; } }
public static class Extensions { public static void InstallEntries(this Service service) { } }
`,
        'Consumer.cs': `namespace Demo;
public class Consumer {
  private Builder _builder;
  public Builder Current { get; }
  public void Field() { _builder.Services.InstallEntries(); }
  public void Property() { Current.Services.Run(); }
  public void Parameter(Builder
    builder) { builder.Services.Run(); }
  public void Split() { _builder
    .Services
    .InstallEntries(); }
}
`,
      });
      try {
        for (const [name, target] of [
          ['Field', 'Demo::Extensions::InstallEntries'],
          ['Property', 'Demo::Service::Run'],
          ['Parameter', 'Demo::Service::Run'],
          ['Split', 'Demo::Extensions::InstallEntries'],
        ]) {
          const from = cg.getNodesByName(name!).find((node) => node.kind === 'method')!;
          const calls = cg.getOutgoingEdges(from.id).filter((edge) => edge.kind === 'calls');
          expect(calls.map((edge) => cg.getNode(edge.target)!.qualifiedName)).toEqual([target]);
        }
      } finally {
        cg.close();
      }
    });

    it('preserves calls with commented or multiline alias declarations', async () => {
      const cg = await index({
        'Reader.cs': 'namespace Tools; public static class Reader { public static void Parse() { } }',
        'Commented.cs': 'using Alias /* comment */ = Tools;\nnamespace Demo; public class Commented { public void ReadCommented() => Alias.Reader.Parse(); }',
        'Wrapped.cs': 'using Alias =\n Tools;\nnamespace Demo; public class Wrapped { public void ReadWrapped() => Alias.Reader\n .Parse(); }',
      });
      try {
        for (const name of ['ReadCommented', 'ReadWrapped']) {
          const from = cg.getNodesByName(name).find((node) => node.kind === 'method')!;
          const calls = cg.getOutgoingEdges(from.id).filter((edge) => edge.kind === 'calls');
          expect(calls.map((edge) => cg.getNode(edge.target)!.qualifiedName)).toEqual(['Tools::Reader::Parse']);
        }
      } finally {
        cg.close();
      }
    });

    it('preserves factory return lookup in the original caller context', async () => {
      const cg = await index({
        'A.cs': 'namespace Other; public class Parser { public string Parse(string input) => input; }',
        'Factory.cs': 'namespace Tools; public static class Factory { public static Parser Create() => new Parser(); }',
        'Consumer.cs': 'namespace Tools; public class Parser { public string Parse(string input) => input; } public class Consumer { public string Read(string input) => Tools.Factory\n .Create()\n .Parse(input); }',
      });
      try {
        const read = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const targets = cg.getOutgoingEdges(read.id).filter((edge) => edge.kind === 'calls').map((edge) => cg.getNode(edge.target)!.qualifiedName);
        expect(targets.sort()).toEqual(['Tools::Factory::Create', 'Tools::Parser::Parse']);
      } finally {
        cg.close();
      }
    });

    it('preserves existing value-member and extension-call handling', async () => {
      const cg = await index({
        'Values.cs': 'namespace Demo; public class Service { } public class Builder { public Service Services { get; } } public static class Extensions { public static void InstallEntries(this Service service) { } public static void InstallMode(this Mode mode) { } } public enum Mode { First } public class Checker { public void Check() { } } public static class Guard { public static Checker Against { get; } }',
        'Consumer.cs': 'namespace Demo; public class Consumer { public void Read(Builder builder) { builder\n .Services\n .InstallEntries(); Guard\n .Against\n .Check(); Demo\n .Guard\n .Against\n .Check(); Mode.First\n .InstallMode(); } }',
      });
      try {
        const read = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const targets = cg.getOutgoingEdges(read.id).filter((edge) => edge.kind === 'calls').map((edge) => cg.getNode(edge.target)!.name);
        expect(targets.sort()).toEqual(['Check', 'Check', 'InstallEntries', 'InstallMode']);
      } finally {
        cg.close();
      }
    });

    it('keeps factory-call inference, token positions and argument/span consumers', async () => {
      const source = 'class Consumer { string Read(string input) => Factory /* factory */\n .Create("a b")\n .Parse(input); }';
      const result = extract(source);
      const calls = result.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls');
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ referenceName: 'Factory.Create().Parse', ...position(source, source.indexOf('Parse')) }),
        expect.objectContaining({ referenceName: 'Factory.Create', ...position(source, source.indexOf('Create')) }),
      ]));
      expect(calls).toHaveLength(2);
      const outer = calls.find((ref) => ref.referenceName === 'Factory.Create().Parse')!;
      const inner = calls.find((ref) => ref.referenceName === 'Factory.Create')!;
      const outerSite = await callSiteInSource(source, 'csharp', outer.line, outer.column);
      const innerSite = await callSiteInSource(source, 'csharp', inner.line, inner.column);
      expect(outerSite?.argList).toEqual(['input']);
      expect(innerSite?.argList).toEqual(['"a b"']);
      // Evidence points at Parse, while ordering/nesting consumers retain the full call span.
      expect(outerSite?.span?.start).toEqual(position(source, source.indexOf('Factory')));
    });

    it('keeps distinct method tokens in repeated fluent calls', () => {
      const source = 'class Consumer { void Read() { builder\n .Configure(1)\n .Configure(2); } }';
      const calls = extract(source).unresolvedReferences.filter((ref) => ref.referenceKind === 'calls');
      expect(calls).toEqual([
        expect.objectContaining({ referenceName: 'builder.Configure().Configure', ...position(source, source.lastIndexOf('Configure')) }),
        expect.objectContaining({ referenceName: 'builder.Configure', ...position(source, source.indexOf('Configure')) }),
      ]);
    });

    it('preserves malformed member text through parser recovery and native fallback', async () => {
      for (const [expression, names] of [
        ['A.*B()', ['A.*B']],
        ['A.*Make().Run()', ['A.*Make().Run', 'A.*Make']],
      ] as const) {
        const source = `class Consumer { void Read() { ${expression}; } }`;
        if (mode === 'native') expect(tryKernelExtract('Recovery.cs', source, 'csharp')).toBeNull();
        const result = extractFromSource('Recovery.cs', source, 'csharp');
        expect(result.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls').map((ref) => ref.referenceName)).toEqual(names);
      }
      const cg = await index({
        'A.cs': 'public static class A { public static void B() { } }',
        'Consumer.cs': 'class Consumer { void Read() { A.*B(); } }',
      });
      try {
        const read = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        expect(cg.getOutgoingEdges(read.id).filter((edge) => edge.kind === 'calls')).toEqual([]);
      } finally {
        cg.close();
      }
    });

    it('does not reinterpret pointer-member operators as dots', async () => {
      for (const [expression, names] of [
        ['service->Run()', ['service->Run']],
        ['service /* . */ ->Run()', ['service /* . */ ->Run']],
        // Keep the existing factory encoding, without erasing -> in its inner callee.
        ['service->Next()->Run()', ['service->Next().Run', 'service->Next']],
        ['service->Value().Run()', ['service->Value().Run', 'service->Value']],
      ] as const) {
        const source = `unsafe class Consumer { void Read(Entry* service) { ${expression}; } }`;
        const calls = extract(source).unresolvedReferences.filter((ref) => ref.referenceKind === 'calls');
        expect(calls.map((ref) => ref.referenceName)).toEqual(names);
        expect(calls.find((ref) => ref.referenceName.endsWith('Run'))).toMatchObject(position(source, source.indexOf('Run')));
      }
      const cg = await index({
        'Entry.cs': 'namespace Demo; public unsafe struct Entry { public Entry* Next() => null; public Entry Value() => this; public void Run() { } }',
        'Service.cs': 'namespace Demo; public class Service { public Service Next() => this; public Service Value() => this; public void Run() { } }',
        'Consumer.cs': 'namespace Demo; public unsafe class Consumer { public void Read(Entry* service) { service->Run(); service->Next()->Run(); service->Value().Run(); } }',
      });
      try {
        const read = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        // No pointer binder is added here; never invent calls on the Service decoy.
        expect(cg.getOutgoingEdges(read.id).filter((edge) => edge.kind === 'calls')).toEqual([]);
      } finally {
        cg.close();
      }
    });

    it('never rewrites whitespace or arrow text inside literal receivers', () => {
      for (const literal of ['"a b"', '"a->b"']) {
        const source = `class Consumer { string Read() => ${literal}.ToString().Trim(); }`;
        const calls = extract(source).unresolvedReferences.filter((ref) => ref.referenceKind === 'calls');
        expect(calls.map((ref) => ref.referenceName)).toEqual([`${literal}.ToString().Trim`, `${literal}.ToString`]);
      }
    });

    it('persists direct, factory and repeated call sites for graph queries', async () => {
      const files: Record<string, string> = {
        'Reader.cs': 'namespace Demo; public static class Reader { public static string Parse(string input) => Sink.Store(input); }',
        'Sink.cs': 'namespace Demo; public static class Sink { public static string Store(string input) => input; }',
        'Other.cs': 'namespace Elsewhere; public static class Other { public static string Parse(string input) => input; }',
        'Parser.cs': 'namespace Demo; public class Parser { public string Parse(string input) => input; public Parser Configure(int value) => this; }',
        'Factory.cs': 'namespace Demo; public static class Factory { public static Parser Create(string label) => new Parser(); }',
        'Chain.cs': 'namespace Demo; public class Chain { public string FromFactory(string input) => Factory /* factory */\n .Create("a b")\n .Parse(input); public void Repeated(Parser parser) { parser\n .Configure(1); parser\n .Configure(2); } }',
        'Consumer.cs': 'namespace Demo; public class Consumer { public string Read(string input) => Reader\n .Parse(input); public string Missing(string input) => MissingReader\n .Parse(input); }',
      };
      const cg = await index(files);
      try {
        const read = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const parse = cg.getNodesByName('Parse').find((node) => node.filePath === 'Reader.cs')!;
        const store = cg.getNodesByName('Store').find((node) => node.kind === 'method')!;
        expect(cg.getCallees(read.id).map(({ node }) => node.id)).toEqual([parse.id]);
        expect(cg.getCallers(parse.id).map(({ node }) => node.id)).toContain(read.id);
        const missing = cg.getNodesByName('Missing').find((node) => node.kind === 'method')!;
        expect(cg.getCallees(missing.id)).toEqual([]);
        expect(cg.findPath(read.id, store.id, ['calls'])?.map(({ node }) => node.id)).toEqual([read.id, parse.id, store.id]);
        expect(cg.getImpactRadius(store.id).nodes.has(read.id)).toBe(true);
        const call = cg.getCallees(read.id)[0].edge;
        expect(call).toMatchObject(position(files['Consumer.cs']!, files['Consumer.cs']!.indexOf('Parse')));

        const factory = cg.getNodesByName('FromFactory').find((node) => node.kind === 'method')!;
        const create = cg.getNodesByName('Create').find((node) => node.kind === 'method')!;
        const instanceParse = cg.getNodesByName('Parse').find((node) => node.filePath === 'Parser.cs')!;
        const chain = files['Chain.cs']!;
        const callsFrom = (id: string) => cg.getOutgoingEdges(id).filter((edge) => edge.kind === 'calls');
        expect(callsFrom(factory.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ target: create.id, ...position(chain, chain.indexOf('Create(')) }),
          expect.objectContaining({ target: instanceParse.id, ...position(chain, chain.indexOf('Parse(input)')) }),
        ]));
        expect(callsFrom(factory.id)).toHaveLength(2);

        const repeated = cg.getNodesByName('Repeated').find((node) => node.kind === 'method')!;
        const configure = cg.getNodesByName('Configure').find((node) => node.kind === 'method')!;
        const occurrences = [...chain.matchAll(/Configure\(/g)].map((match) => position(chain, match.index!));
        expect(callsFrom(repeated.id).map((edge) => ({
          target: edge.target, line: edge.line, column: edge.column,
        }))).toEqual(occurrences.map((at) => ({ target: configure.id, ...at })));
      } finally {
        cg.close();
      }
    });
  });
}
