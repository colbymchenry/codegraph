/**
 * Chinese, Japanese and Korean names in explore and context queries (#516, #1262).
 *
 * The index already stores a name in any script as one full-text token, and
 * `codegraph query 로그인` found it, but every query tokenizer between a
 * question and the index knew only ASCII: `extractSearchTerms` split on
 * `[^a-zA-Z0-9]`, context's symbol extraction matched ASCII patterns only, and
 * explore's named-symbol and Flow tokens had to start with `[A-Za-z_$]` and run
 * three characters. So `codegraph_explore 寻路服务` said "No relevant code
 * found", `codegraph context 로그인` printed only its header, and `入口 末端`
 * had no Flow. Words in any script are now taken whole; Han, kana and Hangul
 * count from two characters and are cut from a neighbouring script
 * (`NavMeshAgent类型`). An ASCII query reads exactly as it did: the reference
 * copies of the old tokenizers at the bottom of this file pin that.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, exploreQueryTokens } from '../src/mcp/tools';
import { flowTokens } from '../src/graph/named-symbol-flow';
import { extractSymbolsFromQuery } from '../src/context';
import { LOW_CONFIDENCE_MARKER } from '../src/context/markers';
import {
  extractSearchTerms, splitAtCjkSwitches, isQueryNameToken, STOP_WORDS, getStemVariants,
} from '../src/search/query-utils';

describe('query words in any script (#516, #1262)', () => {
  it('keeps Han, kana and Hangul words whole, from two characters', () => {
    expect(extractSearchTerms('寻路服务')).toEqual(['寻路服务']);
    expect(extractSearchTerms('入口 末端')).toEqual(['入口', '末端']);
    expect(extractSearchTerms('로그인 인증확인')).toEqual(['로그인', '인증확인']);
    // The prolonged sound mark ー belongs to the katakana around it.
    expect(extractSearchTerms('ユーザー取得')).toEqual(['ユーザー取得']);
    expect(extractSearchTerms('类 的')).toEqual([]);
  });

  it('cuts a name where Han, kana or Hangul meets another script', () => {
    expect(splitAtCjkSwitches('NavMeshAgent类型')).toEqual(['NavMeshAgent', '类型']);
    expect(splitAtCjkSwitches('用户ID')).toEqual(['用户', 'ID']);
    expect(splitAtCjkSwitches('寻路服务.计算路径')).toEqual(['寻路服务.计算路径']);
    expect(splitAtCjkSwitches('get_用户')).toEqual(['get_用户']);
    const terms = extractSearchTerms('NavMeshAgent类型');
    expect(terms).toEqual(expect.arrayContaining(['navmeshagent', 'nav', 'mesh', 'agent', '类型']));
    expect(terms).not.toContain('agent类型');
  });

  it('keeps other scripts whole at three characters', () => {
    // main: `état` became `tat`, and `größe` nothing at all.
    expect(extractSearchTerms('état machine', { stems: false })).toEqual(['état', 'machine']);
    expect(extractSearchTerms('größe', { stems: false })).toEqual(['größe']);
    // Russian `на` (on) stays out, like English `is`.
    expect(extractSearchTerms('получить данные на сервере', { stems: false }))
      .toEqual(['получить', 'данные', 'сервере']);
  });

  it('gives context the names in other scripts, whole', () => {
    expect(extractSymbolsFromQuery('寻路服务 计算路径')).toEqual(['寻路服务', '计算路径']);
    expect(extractSymbolsFromQuery('로그인')).toEqual(['로그인']);
    expect(extractSymbolsFromQuery('état machine')).toEqual(['machine', 'état']);
    expect(extractSymbolsFromQuery('NavMeshAgent类型')).toEqual(['NavMeshAgent', 'NavMeshAgent类型', '类型']);
    expect(extractSymbolsFromQuery('get用户信息')).toEqual(['get用户信息', '用户信息']);
  });

  it('reads names in any script as explore and Flow tokens', () => {
    for (const tokens of [exploreQueryTokens, flowTokens]) {
      expect(tokens('入口 末端')).toEqual(['入口', '末端']);
      expect(tokens('寻路服务.计算路径 로그인')).toEqual(['寻路服务.计算路径', '로그인']);
      expect(tokens('NavMeshAgent类型 类')).toEqual(['NavMeshAgent', '类型']);
      expect(tokens('auth.ts état на')).toEqual(['auth', 'état']);
    }
    expect(isQueryNameToken('入口')).toBe(true);
    expect(isQueryNameToken('на')).toBe(false);
  });
});

describe('an ASCII query reads exactly as before (#516, #1262)', () => {
  const words = [
    'how', 'does', 'the', 'auth', 'flow', 'reach', 'the', 'database', 'scrapeLoop', 'run', 'UserService',
    'getCallGraph', 'build_report', 'MAX_RETRIES', 'REST', 'HTTP2', 'app.isPackaged', 'Session.request',
    'pkg::run', 'src/auth/session.ts', 'Program.cs', 'caching', 'eviction', 'handlers', 'x', 'is', 'to',
    'refreshTokenService', 'tokio', 'poll', 'Harness::poll', 'fn/3', 'mod:fn', 'v2', 'IOStream', 'XMLHttpRequest',
    '$state', 'items$', '_private', '__init__', 'a1b2c3', 'TODO:', '(foo)', '[bar]', 'baz,', 'qux;', '"quoted"',
    "it's", 'e2e/*.spec.ts', 'stage_apply::run', 'C++', 'node.js', '--flag', 'snake_Case_Mixed', 'ABCDef',
  ];
  const corpus: string[] = [
    ...words,
    'how does the order state machine work',
    'DataRequest task validate',
    'entryPoint middleStep tailStep',
    'Engine.execEvalStmt Queryable.Querier fanout.Querier NewMergeQuerier',
    'why does getUserName return null when the cache is cold?',
    'trace triggerRender -> triggerUpdate in App.tsx',
    'what calls build_report and MAX_RETRIES (see utils/report.py:120)',
  ];
  // Every 3-word window of the word list, so words meet each other's punctuation.
  for (let i = 0; i + 3 <= words.length; i++) corpus.push(words.slice(i, i + 3).join(' '));

  it('gives the same search terms', () => {
    for (const q of corpus) {
      expect(extractSearchTerms(q), q).toEqual(oldExtractSearchTerms(q));
      expect(extractSearchTerms(q, { stems: false }), q).toEqual(oldExtractSearchTerms(q, { stems: false }));
    }
  });

  it('gives the same context symbols', () => {
    for (const q of corpus) expect(extractSymbolsFromQuery(q), q).toEqual(oldExtractSymbolsFromQuery(q));
  });

  it('gives the same explore and Flow tokens', () => {
    for (const q of corpus) {
      expect(exploreQueryTokens(q), q).toEqual(oldNameTokens(q).slice(0, 16));
      expect(flowTokens(q), q).toEqual(oldNameTokens(q).slice(0, 16));
    }
  });
});

describe('explore and context on Korean, Chinese and Japanese names (#516, #1262)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const explore = async (query: string): Promise<string> => {
    const res = await handler.execute('codegraph_explore', { query });
    expect(res.isError).toBeFalsy();
    return res.content?.[0]?.text ?? '';
  };
  const context = async (query: string): Promise<string> =>
    String(await cg.buildContext(query, { format: 'markdown' }));

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cjk-query-'));
    // #516's Korean fixture.
    write('src/auth.ts', [
      'export function 로그인(사용자명: string): boolean {',
      '  return 인증확인(사용자명);',
      '}',
      '',
      'export function 인증확인(사용자명: string): boolean {',
      '  return 사용자명.length > 0;',
      '}',
      '',
    ].join('\n'));
    // #1262's Chinese fixture.
    write('src/nav.ts', [
      'export class 寻路服务 {',
      '  计算路径(起点: number, 终点: number): number[] {',
      '    return [起点, 终点];',
      '  }',
      '}',
      '',
      'export class NavMeshAgent {',
      '  move(): void {',
      '    new 寻路服务().计算路径(1, 2);',
      '  }',
      '}',
      '',
    ].join('\n'));
    // A Chinese call chain across three files, for the Flow.
    write('src/flow/a.ts', 'import { 中间 } from "./b";\nexport function 入口(): number {\n  return 中间() + 1;\n}\n');
    write('src/flow/b.ts', 'import { 末端 } from "./c";\nexport function 中间(): number {\n  return 末端() * 2;\n}\n');
    write('src/flow/c.ts', 'export function 末端(): number {\n  return 42;\n}\n');
    // Japanese: kanji, katakana and the prolonged sound mark.
    write('src/order.ts', [
      'export function 注文処理(注文番号: string): boolean {',
      '  return 在庫確認(注文番号);',
      '}',
      '',
      'export function 在庫確認(番号: string): boolean {',
      '  return 番号.length > 0;',
      '}',
      '',
      'export class ユーザー管理 {',
      '  ユーザー取得(名前: string): string {',
      '    return 名前;',
      '  }',
      '}',
      '',
    ].join('\n'));
    write('src/other.ts', 'export function unrelatedHelper(): number {\n  return 42;\n}\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 60_000);

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('explores a Korean, a Chinese and a Japanese name', async () => {
    // main: "No relevant code found" for all three.
    const korean = await explore('로그인');
    expect(korean).not.toContain('No relevant code found');
    expect(korean).toContain('export function 로그인(사용자명: string): boolean {');
    const chinese = await explore('寻路服务');
    expect(chinese).not.toContain('No relevant code found');
    expect(chinese).toContain('export class 寻路服务 {');
    const japanese = await explore('ユーザー取得');
    expect(japanese).not.toContain('No relevant code found');
    expect(japanese).toContain('ユーザー取得(名前: string): string {');
  });

  it('leads a Chinese call chain with its Flow', async () => {
    // main: "No relevant code found"; the ASCII twin of this query leads with the Flow.
    const text = await explore('入口 末端');
    expect(text.startsWith('**Flow (call path among the symbols you queried)**')).toBe(true);
    expect(text).toMatch(/1\. 入口 \(src\/flow\/a\.ts:2\)[\s\S]*2\. 中间 \(src\/flow\/b\.ts:2\)[\s\S]*3\. 末端 \(src\/flow\/c\.ts:1\)/);
  });

  it('finds the English name beside a Chinese word without calling it missing', async () => {
    const text = await explore('NavMeshAgent类型');
    expect(text).toContain('export class NavMeshAgent {');
    expect(text).not.toContain('Not in the index');
  });

  it('builds context for names in each script', async () => {
    // main: the header and the query, nothing else.
    expect(await context('로그인')).toContain('- **로그인** (function) - src/auth.ts:1');
    const japanese = await context('注文処理 在庫確認');
    expect(japanese).toContain('- **注文処理** (function) - src/order.ts:1');
    expect(japanese).toContain('- **在庫確認** (function) - src/order.ts:5');
    // Names the user wrote out are not "common words".
    expect(japanese).not.toContain(LOW_CONFIDENCE_MARKER);
    expect(await context('寻路服务 计算路径')).not.toContain(LOW_CONFIDENCE_MARKER);
  });
});

// ---------------------------------------------------------------------------
// The ASCII-only tokenizers as they were before #516 / #1262, kept verbatim as
// the reference an ASCII query must still match.
// ---------------------------------------------------------------------------

function oldExtractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();
  const compoundPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = compoundPattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) tokens.add(match[1].toLowerCase());
  }
  const snakePattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
  while ((match = snakePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) tokens.add(match[1].toLowerCase());
  }
  const camelSplit = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const normalised = camelSplit.replace(/[_.]+/g, ' ');
  const words = normalised.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }
  if (includeStems) {
    const stems = new Set<string>();
    for (const token of tokens) {
      for (const variant of getStemVariants(token)) {
        if (!tokens.has(variant) && !STOP_WORDS.has(variant)) stems.add(variant);
      }
    }
    for (const stem of stems) tokens.add(stem);
  }
  return [...tokens];
}

function oldExtractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 2) symbols.add(match[1]);
  }
  const snakeCasePattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) symbols.add(match[1]);
  }
  const screamingPattern = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((match = screamingPattern.exec(query)) !== null) {
    if (match[1]) symbols.add(match[1]);
  }
  const acronymPattern = /\b([A-Z]{2,})\b/g;
  while ((match = acronymPattern.exec(query)) !== null) {
    if (match[1]) symbols.add(match[1]);
  }
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
      for (const part of match[1].split('.')) if (part.length >= 2) symbols.add(part);
    }
  }
  const lowercasePattern = /\b([a-z][a-z0-9]{2,})\b/g;
  while ((match = lowercasePattern.exec(query)) !== null) {
    if (match[1]) symbols.add(match[1]);
  }
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been',
    'will', 'would', 'could', 'should', 'does', 'done', 'make', 'made',
    'use', 'used', 'using', 'work', 'works', 'find', 'found', 'show',
    'call', 'called', 'calling', 'get', 'set', 'add', 'all', 'any',
    'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'not', 'but', 'are', 'was', 'were', 'has', 'had', 'its',
    'can', 'did', 'may', 'also', 'into', 'than', 'then', 'them',
    'each', 'other', 'some', 'such', 'only', 'same', 'about',
    'after', 'before', 'between', 'through', 'during', 'without',
    'again', 'further', 'once', 'here', 'there', 'both', 'just',
    'more', 'most', 'very', 'being', 'having', 'doing',
    'system', 'need', 'needs', 'want', 'wants', 'like', 'look',
    'change', 'changes', 'changed', 'changing',
    'layer', 'handle', 'handles', 'handling', 'incoming', 'outgoing',
    'data', 'flow', 'flows', 'level', 'levels', 'request', 'requests',
    'response', 'responses', 'implement', 'implements', 'implementation',
    'interface', 'interfaces', 'class', 'classes', 'method', 'methods',
    'trigger', 'triggers', 'affected', 'affect', 'affects',
    'else', 'code', 'failing', 'failed', 'silently', 'decide', 'decides',
    'return', 'returns', 'returned', 'take', 'takes', 'taken',
    'check', 'checks', 'checked', 'create', 'creates', 'created',
    'read', 'reads', 'write', 'writes', 'written',
    'start', 'starts', 'stop', 'stops', 'run', 'runs', 'running',
  ]);
  return Array.from(symbols).filter((s) => !commonWords.has(s.toLowerCase()));
}

/** explore's and the Flow's token filter before #1262, uncapped. */
function oldNameTokens(query: string): string[] {
  const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;
  return [...new Set(
    query.split(/[\s,()[\]]+/)
      .map((t) => t.replace(FILE_EXT, '').trim())
      .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t)),
  )];
}
