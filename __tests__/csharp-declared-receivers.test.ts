/**
 * What a C# declaration says about a name. A name written with type arguments
 * means a type declaring as many: `new List<CatalogBrand>()` in the Blazor
 * page class `List` is the BCL's `List<T>`. A receiver declared with a keyword
 * type holds no project class, whatever a class named after it inherits:
 * jellyfin's `int year = 0` and its `year.ToString(…)` are no `Year : BaseItem`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'src/Pages/List.razor.cs': `using System.Collections.Generic;

namespace App.Pages;

public partial class List
{
    private List<Brand> brands = new List<Brand>();
    private List list;
}

public class Brand
{
}
`,
  'src/Pages/List.razor': `<h1>List</h1>
`,
  'src/Pages/Details.razor': `@page "/details"
@code {
    private List<Brand> _members = new List<Brand>();
}
`,
  'src/Probing/IProbe.cs': `namespace App.Probing;

public interface IProbe
{
}

public interface IProbe<T>
{
}

public class Poller
{
    public void Check(IProbe probe) { }
    public T Get<T>(IProbe<T> probe) { return default; }
    public void Pair(IProbe<int, string> probe) { }
}
`,
  'src/Entities/BaseItem.cs': `namespace App.Entities;

public class BaseItem
{
    public override string ToString() { return ""; }
    public string GetParent() { return ""; }
}

public class Year : BaseItem
{
}
`,
  'src/Clients/TmdbClient.cs': `using System.Globalization;
using App.Entities;

namespace App.Clients;

public class TmdbClient
{
    public string Search(string name, int year = 0)
    {
        return name + year.ToString(CultureInfo.InvariantCulture);
    }

    public void Loop(int[] years)
    {
        foreach (int year in years)
        {
            year.ToString(CultureInfo.InvariantCulture);
        }
    }

    public string Guess(object item)
    {
        var year = item as Year;
        return year.GetParent();
    }

    public string Named(Year year)
    {
        return year.GetParent();
    }
}
`,
  'src/Formatting/Formatter.cs': `using System.Globalization;

namespace App.Formatting;

public abstract class PropertyValue
{
    public abstract string ToString(string format);
}

public class Formatter
{
    public void Format(PropertyValue value)
    {
    }

    static string FormatDecimal(decimal value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    static string Text(string text)
    {
        return text.Shout();
    }
}

public static class StringExtensions
{
    public static string Shout(this string text)
    {
        return text;
    }
}
`,
  'src/Support/Extensions.cs': `using System.Collections.Generic;
using System.Linq;

namespace App.Support;

public class Value
{
    public List<Value> Elements;
}

public static class Extensions
{
    public static object Literal(this Value value)
    {
        return string.Join(",", value.Elements.Select(e => e.Literal()));
    }

    public static object Wrapped(this Value value, Holder holder)
    {
        return holder.Inner.Wrapped();
    }
}

public class Holder
{
    public object Inner;
}
`,
  'src/Support/Strings.cs': `using System;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Runtime.CompilerServices;

namespace App.Support;

public static class Strings
{
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string Inlined(this string text)
    {
        return text;
    }

    [Obsolete("Stray [ bracket")]
    // Kept for the old callers.
    [MethodImpl(MethodImplOptions.AggressiveInlining)] [DebuggerStepThrough]
    public static T Stacked<T>(this T text)
    {
        return text;
    }

    public static string Truncated(
        this string text,
        int length)
    {
        return text;
    }

    public static bool IsMissing([NotNullWhen(false)] this string? text)
    {
        return text == null;
    }

    public static void Bumped(ref this int number)
    {
    }

    public static (string First, string Rest) Cut(this string text)
    {
        return (text, text);
    }

    [Obsolete("Use Plain(this string text)")]
    public static string Plain(string text)
    {
        return text;
    }
}

public class Wrapper
{
    public string Self(string text) => Wrap(this as object);

    private string Wrap(object value) => "";
}

public class Caller
{
    public void Call(string text, int number)
    {
        text.Inlined();
        text.Stacked();
        text.Truncated(3);
        text.IsMissing();
        text.Cut();
        number.Bumped();
        text.Plain();
        text.Self();
    }
}

public static class Trees
{
    [DebuggerStepThrough]
    public static object Flattened(this Value value)
    {
        return value.Elements.Select(e => e.Flattened());
    }

    public static object Unwound(
        this Value value)
    {
        return value.Elements.Select(e => e.Unwound());
    }

    public static object Spread(this Value value)
    {
        return value.Elements.Select(e =>
            e.Spread());
    }
}
`,
  'src/Probing/Attributed.cs': `using System;
using System.ComponentModel;

namespace App.Probing;

[Serializable]
[Category("one")]
[Category("two")]
[Category("three")]
[Category("four")]
[Category("five")]
[Category("six")]
[Category("seven")]
public class Cache<T>
{
}

[Description("class Store<T>")]
public class Store
{
    // Not a class Store<T> of any kind.
}

public class Pool
{
    // See class Pool<T>.
}

public class Warehouse
{
    private Cache<int> cache = new Cache<int>();
    private Store<int> store = new Store<int>();
    private Pool<int> pool = new Pool<int>();
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-declared-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

type Row = { k: string; sq: string; q: string; tf: string; line: number; m: string | null };

function edges(): Row[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Row[] } } } }).db;
  return db.getDb().prepare(`
    SELECT e.kind k, s.qualified_name sq, t.qualified_name q, t.file_path tf, e.line line, e.metadata m FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`).all();
}

function callees(caller: string, ref: string): string[] {
  return edges().filter((e) => e.k === 'calls' && e.sq === caller && JSON.parse(e.m ?? '{}').refName === ref).map((e) => e.q);
}

describe('a C# name written with type arguments', () => {
  it('is no type that declares none', () => {
    const toList = edges().filter((e) => (e.k === 'references' || e.k === 'instantiates') && /(?:^|::)List$/.test(e.q));
    // The bare field type alone is the page class.
    expect(toList.map((e) => [e.k, e.sq, e.line])).toEqual([['references', 'App.Pages::List::list', 8]]);
  });

  it('picks the declaration of its arity', () => {
    const toProbe = edges().filter((e) => e.k === 'references' && e.q === 'App.Probing::IProbe');
    expect(toProbe.map((e) => e.sq).sort()).toEqual(['App.Probing::Poller::Check', 'App.Probing::Poller::Get'].sort());
    const lines = toProbe.map((e) => e.line).sort((a, b) => a - b);
    expect(lines).toEqual([13, 14]);
  });

  it('means nothing the project has when no type has its arity', () => {
    expect(edges().filter((e) => e.sq === 'App.Probing::Poller::Pair' && e.k === 'references')).toEqual([]);
  });
});

describe('a C# type with attributes above it', () => {
  const links = (type: string) => edges()
    .filter((e) => (e.k === 'references' || e.k === 'instantiates') && e.q === type)
    .map((e) => e.k).sort();

  it('declares its type parameters below them, however many there are', () => {
    expect(links('App.Probing::Cache')).toEqual(['instantiates', 'references']);
  });

  it('declares none in the text of an attribute', () => {
    expect(links('App.Probing::Store')).toEqual([]);
  });

  it('declares none in a comment of its body', () => {
    expect(links('App.Probing::Pool')).toEqual([]);
  });
});

describe('a C# receiver declared with a keyword type', () => {
  it('reaches no class named after it', () => {
    expect(callees('App.Clients::TmdbClient::Search', 'year.ToString')).toEqual([]);
  });

  it('reaches no class named after a loop variable', () => {
    expect(callees('App.Clients::TmdbClient::Loop', 'year.ToString')).toEqual([]);
  });

  it('reaches no project type another declaration of the name has', () => {
    expect(callees('App.Formatting::Formatter::FormatDecimal', 'value.ToString')).toEqual([]);
  });

  it('still reaches an extension method on it', () => {
    expect(callees('App.Formatting::Formatter::Text', 'text.Shout')).toEqual(['App.Formatting::StringExtensions::Shout']);
  });
});

describe('an extension method on a C# keyword receiver', () => {
  const called = (ref: string) => callees('App.Support::Caller::Call', ref);

  it('is found below an attribute line', () => {
    expect(called('text.Inlined')).toEqual(['App.Support::Strings::Inlined']);
  });

  it('is found below attributes that hold a bracket, a comment or a second list', () => {
    expect(called('text.Stacked')).toEqual(['App.Support::Strings::Stacked']);
  });

  it('is found when its parameter list wraps', () => {
    expect(called('text.Truncated')).toEqual(['App.Support::Strings::Truncated']);
  });

  it('is found when its first parameter has an attribute', () => {
    expect(called('text.IsMissing')).toEqual(['App.Support::Strings::IsMissing']);
  });

  it('is found when its first parameter is by reference', () => {
    expect(called('number.Bumped')).toEqual(['App.Support::Strings::Bumped']);
  });

  it('is found behind a tuple return type', () => {
    expect(called('text.Cut')).toEqual(['App.Support::Strings::Cut']);
  });

  it('is no method whose attribute or body has the words', () => {
    expect(called('text.Plain')).toEqual([]);
    expect(called('text.Self')).toEqual([]);
  });
});

describe('a C# receiver no keyword declares', () => {
  it('stays named after its class', () => {
    expect(callees('App.Clients::TmdbClient::Guess', 'year.GetParent')).toEqual(['App.Entities::BaseItem::GetParent']);
    expect(callees('App.Clients::TmdbClient::Named', 'year.GetParent')).toEqual(['App.Entities::BaseItem::GetParent']);
  });
});

describe('a C# extension method calling its own name', () => {
  it('recurses through an element a lambda receives', () => {
    expect(callees('App.Support::Extensions::Literal', 'e.Literal')).toEqual(['App.Support::Extensions::Literal']);
  });

  it('recurses when an attribute line stands above it', () => {
    expect(callees('App.Support::Trees::Flattened', 'e.Flattened')).toEqual(['App.Support::Trees::Flattened']);
  });

  it('recurses when its parameter list wraps', () => {
    expect(callees('App.Support::Trees::Unwound', 'e.Unwound')).toEqual(['App.Support::Trees::Unwound']);
  });

  it('recurses when the lambda wraps', () => {
    expect(callees('App.Support::Trees::Spread', 'e.Spread')).toEqual(['App.Support::Trees::Spread']);
  });

  it('hands a call on to another object otherwise', () => {
    expect(callees('App.Support::Extensions::Wrapped', 'holder.Inner.Wrapped')).toEqual([]);
  });
});
