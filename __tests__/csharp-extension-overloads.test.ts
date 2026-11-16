/**
 * Which of a C# extension method's overloads a call binds to. The `this`
 * parameter is the receiver in `path.NormalizePath('/')`, not an argument, so
 * that call is the overload taking a `char`, not the one taking nothing; an
 * `out` or `ref` written at the call site picks the overload that declares it.
 * jellyfin's seven `NormalizePath` calls with an argument all went to the
 * overload without one.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'src/Library/PathExtensions.cs': `using System;
using System.Diagnostics.CodeAnalysis;
using System.IO;

namespace App.Library
{
    public static class PathExtensions
    {
        [return: NotNullIfNotNull(nameof(path))]
        public static string? NormalizePath(this string? path)
        {
            return path.NormalizePath(Path.DirectorySeparatorChar);
        }

        [return: NotNullIfNotNull(nameof(path))]
        public static string? NormalizePath(this string? path, [NotNullWhen(true)] out char separator)
        {
            separator = '/';
            return path.NormalizePath(separator);
        }

        public static string? NormalizePath(this string? path, char newSeparator)
        {
            return path;
        }

        public static string Joined(string path, char separator)
        {
            return NormalizePath(path, separator) + NormalizePath(path, out var used);
        }
    }
}
`,
  'src/Library/Rules.cs': `namespace App.Library
{
    public class Rules
    {
        public string Check(string path, bool normalize)
        {
            return normalize ? path.NormalizePath('/') : path;
        }

        public string Split(string subPath)
        {
            return subPath.NormalizePath(out var sep) + sep;
        }

        public string Plain(string path) => path.NormalizePath();

        public string Named(string path) => path.NormalizePath(separator: out var s);

        public string Static(string path) => PathExtensions.NormalizePath(path, '/');
    }

    public class Plugin
    {
        public string Path = "";
    }

    public class Manager
    {
        public bool Under(Plugin plugin, string full) => full.StartsWith(plugin.Path.NormalizePath('/'));

        public bool Same(Plugin plugin, string full) => full == plugin.Path.NormalizePath();
    }
}
`,
  'src/Library/StreamExtensions.cs': `using System.Collections.Generic;
using System.IO;
using System.Text;

namespace App.Library
{
    public static class StreamExtensions
    {
        public static string[] ReadAllLines(this Stream stream) => ReadAllLines(stream, Encoding.UTF8);

        public static string[] ReadAllLines(this Stream stream, Encoding encoding)
        {
            using var reader = new StreamReader(stream, encoding);
            return new List<string>(ReadAllLines(reader)).ToArray();
        }

        public static IEnumerable<string> ReadAllLines(this TextReader reader)
        {
            yield break;
        }
    }
}
`,
  'src/Users/UserExtensions.cs': `namespace App.Users
{
    public class User
    {
    }

    public static class UserExtensions
    {
        public static void SetPreference(this User user, int kind, string[] values)
        {
        }

        public static void SetPreference<T>(this User user, int kind, T[] values)
        {
        }
    }

    public class Service
    {
        public void Save(User user, string[] views)
        {
            user.SetPreference(1, views);
        }
    }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-ext-overloads-'));
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

type Row = { k: string; sq: string; q: string; tl: number; line: number; m: string | null };

function edges(): Row[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Row[] } } } }).db;
  return db.getDb().prepare(`
    SELECT e.kind k, s.qualified_name sq, t.qualified_name q, t.start_line tl, e.line line, e.metadata m FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`).all();
}

/** The overloads (by declaration line) a caller's calls of `ref` reach, with the line of each call. */
function overloads(caller: string, ref: string): Array<[number, number]> {
  return edges()
    .filter((e) => e.k === 'calls' && e.sq === caller && JSON.parse(e.m ?? '{}').refName === ref)
    .map((e): [number, number] => [e.line, e.tl])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// Declaration lines in PathExtensions.cs: no argument 9, `out char` 15, `char` 22. In
// StreamExtensions.cs: (Stream) 9, (Stream, Encoding) 11, (TextReader) 17.
const PATH = 'App.Library::PathExtensions::NormalizePath';

describe('a C# call of an overloaded extension method', () => {
  it('passes no `this` argument: one argument is the overload taking one past the receiver', () => {
    expect(overloads('App.Library::Rules::Check', 'path.NormalizePath')).toEqual([[7, 22]]);
  });

  it('takes the overload declaring `out` when the call writes it, named or not', () => {
    expect(overloads('App.Library::Rules::Split', 'subPath.NormalizePath')).toEqual([[12, 15]]);
    expect(overloads('App.Library::Rules::Named', 'path.NormalizePath')).toEqual([[17, 15]]);
  });

  it('with no argument, is the overload taking none', () => {
    expect(overloads('App.Library::Rules::Plain', 'path.NormalizePath')).toEqual([[15, 9]]);
    expect(overloads('App.Library::Manager::Same', 'plugin.Path.NormalizePath')).toEqual([[31, 9]]);
  });

  it('decides the same on a receiver guessed by its name', () => {
    expect(overloads('App.Library::Manager::Under', 'plugin.Path.NormalizePath')).toEqual([[29, 22]]);
  });

  it('from inside one of the overloads is another overload, not the caller', () => {
    expect(overloads(PATH, 'path.NormalizePath')).toEqual([[12, 22], [19, 22]]);
  });

  it('counts the `this` parameter when called through its class or bare in it', () => {
    expect(overloads('App.Library::Rules::Static', 'PathExtensions.NormalizePath')).toEqual([[19, 22]]);
    expect(overloads('App.Library::PathExtensions::Joined', 'NormalizePath')).toEqual([[29, 15], [29, 22]]);
  });

  it('links nothing when the overloads the arguments fit leave out the one picked', () => {
    // `ReadAllLines(reader)` fits the (Stream) and the (TextReader) overloads alike, by
    // count; the method making the call takes two.
    const calls = overloads('App.Library::StreamExtensions::ReadAllLines', 'ReadAllLines');
    expect(calls).toEqual([[9, 11]]);
  });

  it('keeps the one picked when it is among several the arguments fit', () => {
    // Both overloads take a kind and an array: nothing at the call site tells them apart.
    expect(overloads('App.Users::Service::Save', 'user.SetPreference')).toEqual([[22, 9]]);
  });
});
