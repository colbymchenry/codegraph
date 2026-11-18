/**
 * A C# call of a method the receiver's type doesn't declare is a call of the
 * extension method whose `this` parameter takes that type (#2906). A literal
 * receiver — `"hi".Shout()` — was never typed, so the call went unlinked; a
 * typed one reached an extension by its name alone, whichever type its
 * `this` took: `s.Shout()` on a `string` and `_mailer.Shout()` on a `Mailer`
 * could each land on the other's `Shout`, or on nothing when both existed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'App.csproj':
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>\n',
  'Ext.cs': `using System.Collections.Generic;

namespace App;

public interface IMailer { }

public class Mailer : IMailer { }

public class Queue { }

public static class TextExtensions
{
    public static string Shout(this string text) => text;
    public static int Twice(this int n) => n * 2;
}

public static class MailerExtensions
{
    public static void Shout(this Mailer mailer) { }
    public static void Drain(this Queue queue) { }
    public static void Drain(this Mailer mailer, int n) { }
    public static void Ping(this IMailer mailer) { }
    public static void Tag<T>(this T item, string tag) { }
}
`,
  'Other/Hidden.cs': `namespace Other;

public static class HiddenExtensions
{
    public static void Ping(this App.Mailer mailer, int times) { }
}
`,
  'Consumer.cs': `namespace App;

public class Consumer
{
    private readonly Mailer _mailer = new Mailer();

    public string Literal() => "hi".Shout();
    public int Number() => 21.Twice();
    public string Local() { string s = "x"; return s.Shout(); }
    public void OnMailer() { _mailer.Shout(); }
    public void DrainQueue(Queue q) { q.Drain(); }
    public void DrainMailer() { _mailer.Drain(3); }
    public void Interface() { _mailer.Ping(); }
    public void Generic() { _mailer.Tag("x"); }
    public string Trim(string s) => s.Trim();
}
`,
};

describe.each(['default', 'wasm'])('C# extension methods match the receiver by the `this` type (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-ext-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `<line> <owner>::<method>` for every call the Consumer method `name` makes. */
  function calls(name: string): string[] {
    const fn = cg!.getNodesInFile('Consumer.cs').find((n) => n.name === name && n.kind === 'method');
    expect(fn, name).toBeDefined();
    return cg!
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => {
        const t = cg!.getNode(e.target)!;
        return `${t.startLine} ${t.qualifiedName}`;
      })
      .sort();
  }

  it('links a call on a literal to the extension that takes its type', () => {
    expect(calls('Literal')).toEqual(['13 App::TextExtensions::Shout']);
    expect(calls('Number')).toEqual(['14 App::TextExtensions::Twice']);
  });

  it("picks the extension by the receiver's declared type, not by its name alone", () => {
    expect(calls('Local')).toEqual(['13 App::TextExtensions::Shout']);
    expect(calls('OnMailer')).toEqual(['19 App::MailerExtensions::Shout']);
    expect(calls('DrainQueue')).toEqual(['20 App::MailerExtensions::Drain']);
    expect(calls('DrainMailer')).toEqual(['21 App::MailerExtensions::Drain']);
  });

  it("reaches one that takes an interface the type implements, or any type, but not one in a namespace the file doesn't use", () => {
    expect(calls('Interface')).toEqual(['22 App::MailerExtensions::Ping']);
    expect(calls('Generic')).toEqual(['23 App::MailerExtensions::Tag']);
  });

  it("links nothing for a string's own method", () => {
    expect(calls('Trim')).toEqual([]);
  });
});

/** One extension class copied into two projects, as .NET Aspire's ServiceDefaults template leaves it. */
const SERVICE_DEFAULTS = `namespace Microsoft.Extensions.Hosting;

public static class Extensions
{
    public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder
    {
        builder.ConfigureTelemetry();
        return builder;
    }

    public static TBuilder ConfigureTelemetry<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder => builder;
}
`;

const COPIES: Record<string, string> = {
  'A/A.ServiceDefaults/Extensions.cs': SERVICE_DEFAULTS,
  'B/B.ServiceDefaults/Extensions.cs': SERVICE_DEFAULTS,
  'B/B.Web/Program.cs': `using Microsoft.Extensions.Hosting;

namespace B.Web;

public class Builder { }

public static class Program
{
    public static void Main(Builder builder)
    {
        builder.AddServiceDefaults();
    }
}
`,
};

describe('C# extension methods copied into several projects (#2906)', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-ext-copies-'));
    for (const [rel, content] of Object.entries(COPIES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `<target file>::<name>` for every call the method `name` in `file` makes. */
  function callsIn(file: string, name: string): string[] {
    const fn = cg!.getNodesInFile(file).find((n) => n.name === name && n.kind === 'method');
    expect(fn, `${file} ${name}`).toBeDefined();
    return cg!
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${cg!.getNode(e.target)!.filePath}::${cg!.getNode(e.target)!.name}`)
      .sort();
  }

  it("links each call to its own project's copy", () => {
    expect(callsIn('A/A.ServiceDefaults/Extensions.cs', 'AddServiceDefaults')).toEqual(['A/A.ServiceDefaults/Extensions.cs::ConfigureTelemetry']);
    expect(callsIn('B/B.ServiceDefaults/Extensions.cs', 'AddServiceDefaults')).toEqual(['B/B.ServiceDefaults/Extensions.cs::ConfigureTelemetry']);
    expect(callsIn('B/B.Web/Program.cs', 'Main')).toEqual(['B/B.ServiceDefaults/Extensions.cs::AddServiceDefaults']);
  });
});
