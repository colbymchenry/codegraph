/**
 * A qualified symbol query names its scope whole (#2908).
 *
 * `codegraph callers Format.Price` also selected `LegacyFormat::Price`, and
 * merged its callers into the answer: the matcher accepted the query anywhere
 * inside the qualifiedName, so `Format::Price` matched the tail of
 * `LegacyFormat::Price`. A file named `Format.cs` holding `LegacyFormat` let it
 * in a second way, since a path qualifier could stand for any scope. The same
 * matcher serves the CLI's callers/callees/impact, `codegraph_node` and
 * `codegraph_explore`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { matchesSymbol } from '../src/graph/symbol-lookup';
import type { Node } from '../src/types';

function node(over: Partial<Node>): Node {
  return {
    id: 'n1', kind: 'method', name: 'Price', qualifiedName: 'Format::Price',
    filePath: 'Pricing.cs', language: 'csharp',
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 0, updatedAt: 0,
    ...over,
  } as Node;
}

describe('matchesSymbol — a qualifier names a whole scope', () => {
  const format = node({});
  const legacy = node({ qualifiedName: 'LegacyFormat::Price' });

  it('does not match a class whose name only ends with the qualifier', () => {
    for (const query of ['Format.Price', 'Format::Price']) {
      expect(matchesSymbol(format, query)).toBe(true);
      expect(matchesSymbol(legacy, query)).toBe(false);
    }
    expect(matchesSymbol(legacy, 'LegacyFormat.Price')).toBe(true);
    // Nor one that holds it in the middle of an outer scope's name.
    expect(matchesSymbol(node({ qualifiedName: 'OldFormat::Inner::Price' }), 'Format::Inner::Price')).toBe(false);
    expect(matchesSymbol(node({ qualifiedName: 'Outer::Format::Price' }), 'Format.Price')).toBe(true);
  });

  it('does not let a file named for one type stand for another type the file holds', () => {
    expect(matchesSymbol(node({ qualifiedName: 'LegacyFormat::Price', filePath: 'src/Format.cs' }), 'Format.Price')).toBe(false);
    expect(matchesSymbol(node({ qualifiedName: 'Helpers::Price', filePath: 'src/Format.cs' }), 'Format.Price')).toBe(false);
    // The file named for the type itself still reads as that type.
    expect(matchesSymbol(node({ qualifiedName: 'Format::Price', filePath: 'src/Format.cs' }), 'Format.Price')).toBe(true);
  });

  it('still lets a file or folder name the module where a language keeps it there', () => {
    // Rust, Python and Go put a type's module in its path, never its name.
    const reformat = { name: 'price', qualifiedName: 'Reformat::price' };
    expect(matchesSymbol(node({ ...reformat, filePath: 'format/pricing.go', language: 'go' }), 'format.price')).toBe(true);
    expect(matchesSymbol(node({ ...reformat, filePath: 'src/format.py', language: 'python' }), 'format.price')).toBe(true);
    expect(matchesSymbol(node({ ...reformat, filePath: 'src/format.rs', language: 'rust' }), 'format::price')).toBe(true);
    // A function outside any type is the module's in every language.
    const fn = node({ kind: 'function', name: 'formatDate', qualifiedName: 'formatDate', filePath: 'src/utils.ts', language: 'typescript' });
    expect(matchesSymbol(fn, 'utils.formatDate')).toBe(true);
  });

  it('reads a PHP namespace written with backslashes', () => {
    const price = node({ name: 'price', qualifiedName: 'App\\Models\\Billing::Format::price', filePath: 'q.php', language: 'php' });
    for (const query of ['Format::price', 'Format.price', 'Billing\\Format::price', 'App\\Models\\Billing\\Format::price']) {
      expect(matchesSymbol(price, query)).toBe(true);
    }
    expect(matchesSymbol(price, 'illing\\Format::price')).toBe(false);
    const legacyPrice = node({ name: 'price', qualifiedName: 'App\\Models\\Billing::LegacyFormat::price', filePath: 'q.php', language: 'php' });
    expect(matchesSymbol(legacyPrice, 'Format::price')).toBe(false);
  });

  it('reads an Erlang name past its arity', () => {
    const start = node({ kind: 'function', name: 'start', qualifiedName: 'my_server::start/0', filePath: 'src/my_server.erl', language: 'erlang' });
    expect(matchesSymbol(start, 'my_server::start')).toBe(true);
    expect(matchesSymbol(start, 'my_server::start/0')).toBe(true);
    expect(matchesSymbol(start, 'my_server::start/1')).toBe(false);
    expect(matchesSymbol(node({ ...start, qualifiedName: 'old_my_server::start/0', filePath: 'src/old_my_server.erl' }), 'my_server::start')).toBe(false);
  });
});

describe('the #2908 repro through the CLI and codegraph_node', () => {
  const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qualified-boundary-'));
    fs.writeFileSync(
      path.join(root, 'Pricing.cs'),
      [
        'public static class Format',
        '{',
        '    public static string Price(decimal value) => value.ToString("0.00");',
        '}',
        '',
        'public static class LegacyFormat',
        '{',
        '    public static string Price(decimal value) => value.ToString();',
        '}',
        '',
        'public class Invoice',
        '{',
        '    public string Total(decimal value) => Format.Price(value);',
        '',
        '    public string OldTotal(decimal value) => LegacyFormat.Price(value);',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(root, { index: true });
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('`callers Format.Price` names one definition and only its caller', () => {
    const result = spawnSync(process.execPath, [BIN, 'callers', '-p', root, '--json', '--', 'Format.Price'], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    const text = JSON.stringify(out);
    expect(text).toContain('Format::Price');
    expect(text).not.toContain('LegacyFormat');
    expect(text).toContain('Total');
    expect(text).not.toContain('OldTotal');
  });

  it('codegraph_node on `Format.Price` or `Format::Price` returns that method alone', async () => {
    // Format::Price is declared on line 3, LegacyFormat::Price on line 8.
    for (const symbol of ['Format.Price', 'Format::Price']) {
      const text = (await handler.execute('codegraph_node', { symbol })).content[0]?.text ?? '';
      expect(text, symbol).toContain('Pricing.cs:3');
      expect(text, symbol).not.toContain('Pricing.cs:8');
      expect(text, symbol).not.toContain('OldTotal');
    }
  });
});
