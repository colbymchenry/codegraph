/**
 * A C# call written on what a bare call returns — `GetMailer().Send("c")` —
 * calls a method of the type the bare call's method is declared to return
 * (#2906). The chain arrives as `GetMailer().Send`, and the chain resolver,
 * which reads a call's return type only through a class name written before
 * it (`Factory.Create().Send()`), left a bare one unlinked: C# needs `new` to
 * construct, so a bare `GetMailer()` is no constructor. C# reads it as a call
 * of a method of the types around it or their bases, or of a `using static`
 * type; the receiver is what that method returns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'App.csproj':
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>\n',
  'Mail.cs': `namespace App;

public interface IMailer
{
    void Send(string to);
}

public class Mailer : IMailer
{
    public void Send(string to) { }
}

public class Queue
{
    public void Send(string to) { }
}

public static class Factory
{
    public static Mailer Create() => new Mailer();
}

public class Other
{
    public Queue GetMailer() => new Queue();
}
`,
  'Consumer.cs': `using static App.Factory;

namespace App;

public class BaseConsumer
{
    protected Mailer Make() => new Mailer();
}

public class Consumer : BaseConsumer
{
    private readonly Mailer _mailer = new Mailer();

    private Mailer GetMailer() => _mailer;

    private IMailer Pick() => _mailer;

    private T Get<T>() where T : new() => new T();

    public void Chained() { GetMailer().Send("c"); }

    public void ThisChained() { this.GetMailer().Send("d"); }

    public void Inherited() { Make().Send("e"); }

    public void BaseChained() { base.Make().Send("f"); }

    public void StaticUsing() { Create().Send("g"); }

    public void Interface() { Pick().Send("h"); }

    public void Generic() { Get<Mailer>().Send("j"); }
}

public class Unrelated
{
    public void Elsewhere() { GetMailer().Send("k"); }
}
`,
};

describe.each(['default', 'wasm'])('C# calls on a bare call link the declared return type\'s method (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-callresult-'));
    for (const [rel, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `<caller> -> <callee>` for every call edge from Consumer.cs into a `Send`. */
  function sends(): string[] {
    const out: string[] = [];
    for (const target of cg!.getNodesInFile('Mail.cs').filter((n) => n.name === 'Send')) {
      for (const e of cg!.getIncomingEdges(target.id).filter((x) => x.kind === 'calls')) {
        if (cg!.getNode(e.source)!.filePath !== 'Consumer.cs') continue;
        out.push(`${cg!.getNode(e.source)!.name} -> ${target.qualifiedName}`);
      }
    }
    return out.sort();
  }

  it("links `GetMailer().Send(…)` and its kin to the returned type's Send", () => {
    expect(sends()).toEqual([
      'BaseChained -> App::Mailer::Send',
      'Chained -> App::Mailer::Send',
      'Inherited -> App::Mailer::Send',
      'Interface -> App::IMailer::Send',
      'StaticUsing -> App::Mailer::Send',
      'ThisChained -> App::Mailer::Send',
    ]);
  });

  it("links nothing for a generic method's type parameter, or a method of a type the call is not in", () => {
    // `Get<Mailer>()` returns its `T`; `Unrelated` can't call Consumer's or Other's `GetMailer` bare.
    expect(sends().filter((e) => e.startsWith('Generic ') || e.startsWith('Elsewhere '))).toEqual([]);
  });
});
