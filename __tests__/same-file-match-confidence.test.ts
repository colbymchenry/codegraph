/**
 * Confidence of an exact-name match the call site's own file decided.
 *
 * With several same-named candidates, the name-matcher ranks the one in the
 * call site's file first, then scored the winner by DIRECTORY proximity — the
 * number of leading folders its path shares with the caller's. A same-file
 * winner shares every folder, but a shallow file has few to share, so
 * `scripts/x.py` calling its own `main` got 0.4, the score of a guess across
 * unrelated modules. A lone same-file definition now scores like a lone
 * candidate; the matcher's pick itself never changes, and a pick the file
 * does not settle (two same-file candidates, a sibling class's method, the
 * caller itself) keeps the proximity score.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('same-file exact-match confidence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-file-conf-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  type CallEdge = { src: string; tgt: string; tgtQn: string; tgtFile: string; confidence: number };

  const calls = async (kind = 'calls'): Promise<CallEdge[]> => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows: CallEdge[] = db
      .prepare(
        `SELECT s.name src, t.name tgt, t.qualified_name tgtQn, t.file_path tgtFile,
                json_extract(e.metadata, '$.confidence') confidence
           FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE e.kind = ?`
      )
      .all(kind);
    cg.close?.();
    return rows;
  };

  it('scores a shallow-path call to its own file as a strong match', async () => {
    write('x.py', 'def helper():\n    return 1\n\ndef main():\n    return helper()\n');
    write('pkg/other.py', 'def helper():\n    return 2\n');
    const edge = (await calls()).find((e) => e.src === 'main' && e.tgt === 'helper');
    expect(edge?.tgtFile).toBe('x.py');
    expect(edge?.confidence).toBe(0.9);
  });

  it('keeps the same-file target when a sibling file defines the name too', async () => {
    write('a/b/c/x.py', 'def helper():\n    return 1\n\ndef main():\n    return helper()\n');
    write('a/b/c/y.py', 'def helper():\n    return 2\n');
    const edge = (await calls()).find((e) => e.src === 'main' && e.tgt === 'helper');
    expect(edge?.tgtFile).toBe('a/b/c/x.py');
    expect(edge?.confidence).toBe(0.9);
  });

  it('leaves the proximity score when the file holds several candidates', async () => {
    // Both branches of an `#ifdef` define `helper`: line distance picks one.
    write(
      'x.c',
      '#ifdef FAST\nstatic int helper(void) { return 1; }\n#else\nstatic int helper(void) { return 2; }\n#endif\n' +
        'int main(void) { return helper(); }\n'
    );
    write('lib/other.c', 'int helper(void) { return 3; }\n');
    const edge = (await calls()).find((e) => e.src === 'main' && e.tgt === 'helper');
    expect(edge?.tgtFile).toBe('x.c');
    expect(edge?.confidence).toBe(0.4);
  });

  it('leaves the proximity score when the match is the caller itself', async () => {
    // Recursion, or a receiver the call lost (`json.dumps` inside `dumps`).
    write('x.py', 'def walk(n):\n    return walk(n - 1)\n');
    write('pkg/other.py', 'def walk(n):\n    return 2\n');
    const edge = (await calls()).find((e) => e.src === 'walk' && e.tgt === 'walk');
    expect(edge?.tgtFile).toBe('x.py');
    expect(edge?.confidence).toBe(0.4);
  });

  it("leaves the proximity score for a sibling class's method", async () => {
    // The other `run` is one the file includes: C++ sees no other file's (#2684).
    write('x.cpp', '#include "pkg/other.h"\nstruct A {\n  int run() { return 1; }\n};\nint go() { return run(); }\n');
    write('pkg/other.h', 'inline int run() { return 2; }\n');
    const edge = (await calls()).find((e) => e.src === 'go' && e.tgt === 'run');
    expect(edge?.tgtQn).toBe('A::run');
    expect(edge?.confidence).toBe(0.4);
  });

  it("outranks a framework's naming guess that sends the name to another file", async () => {
    // ASP.NET's naming rule takes `ToastService` for the class in Services/,
    // but the component reads its own property named after that class, as
    // eShopOnWeb's Blazor ToastComponent does (C#'s "Color Color").
    write('Startup.cs', 'namespace App { public class Startup { } }\n');
    write('Services/ToastService.cs', 'namespace App.Services {\n  public class ToastService { public event System.Action OnShow; }\n}\n');
    write(
      'Helpers/ToastComponent.cs',
      'using App.Services;\nnamespace App.Helpers {\n  public class ToastComponent {\n    ToastService ToastService { get; set; }\n' +
        '    void OnInitialized() { ToastService.OnShow += Show; }\n    void Show() { }\n  }\n}\n'
    );
    const edge = (await calls('references')).find((e) => e.src === 'OnInitialized' && e.tgt === 'ToastService');
    expect(edge?.tgtQn).toBe('App.Helpers::ToastComponent::ToastService');
    expect(edge?.confidence).toBe(0.9);
  });

  it("does not raise a sibling type's member found by its bare name", async () => {
    // `Dns()` in one class is not the `Dns` entry of the enum beside it
    // (okhttp's InterceptorOverridesTest): no more settled by the file than
    // a sibling class's method.
    write('src/app/Overrides.kt', 'package app\n\nenum class Param { Dns }\n\nclass Override {\n  val value = Dns()\n}\n');
    write('src/app/Dns.kt', 'package app\n\nclass Dns\n');
    const raised = (await calls()).filter((e) => e.tgtQn === 'app::Param::Dns' && e.confidence >= 0.9);
    expect(raised).toEqual([]);
  });
});
