/**
 * Session index — FTS5 over agent-session transcripts (src/sessions).
 *
 * Covers the reader (which entries become prose docs), the query quoting that
 * keeps flags and paths out of FTS5 syntax, porter stemming, the role / since /
 * session / any filters, incremental refresh (unchanged files are not re-read,
 * a rewritten file is replaced rather than duplicated, a deleted file is
 * forgotten), and the project-level switches: `CODEGRAPH_SESSIONS_DIR`, the
 * Claude Code slug lookup, and `"sessions": false` in codegraph.json.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  claudeProjectSlug,
  claudeSessionsDir,
  transcriptDocs,
  transcriptTitle,
} from '../src/sessions/claude-code';
import {
  SessionsIndex,
  ftsQuery,
  querySessions,
  sessionsSourceDir,
  NoSessionsError,
  formatSessionHits,
} from '../src/sessions';
import { clearProjectConfigCache } from '../src/project-config';

const at = '2026-09-04T20:00:00.000Z';
const user = (text: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: at,
  message: { content: text },
  ...extra,
});
const assistant = (blocks: unknown[]) => ({ type: 'assistant', timestamp: at, message: { content: blocks } });

const dirs: string[] = [];
const fixtureDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sessions-'));
  dirs.push(d);
  return d;
};
const writeJsonl = (file: string, entries: unknown[], mtimeSec: number): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
};
const savedEnv = { ...process.env };
afterEach(() => {
  // Under Bun (a contributor running vitest on it), node:sqlite keeps the file
  // handle of a prepared statement until GC even after `close()`, so the temp
  // dir holding sessions.db is EBUSY without this. A no-op on Node.
  (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const k of ['CODEGRAPH_SESSIONS_DIR', 'CLAUDE_CONFIG_DIR']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearProjectConfigCache();
});

describe('Claude Code reader', () => {
  it('keeps prompts, replies and compaction summaries; drops tool traffic, thinking, meta and short text', () => {
    const docs = transcriptDocs([
      user('please merge the two dedupe paths into one'),
      user('ok'),
      user('<meta prompt that is long enough to index>', { isMeta: true }),
      user('Summary: the ring is deduped at write time only', { isCompactSummary: true }),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'a long tool result payload here' }]),
      assistant([
        { type: 'thinking', thinking: 'private reasoning that is long enough to index' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'text', text: 'Merged: aggregateTurnReady now reads the ring as booked.' },
      ]),
      { type: 'queue-operation', timestamp: at },
      { type: 'user', message: { content: 'no timestamp so this one is skipped entirely' } },
    ]);
    expect(docs.map((d) => d.role)).toEqual(['user', 'summary', 'assistant']);
    expect(docs[2]!.text).toMatch(/^Merged:/);
  });

  it('transcriptTitle returns the last stored title or null', () => {
    expect(transcriptTitle([{ customTitle: 'a' }, { customTitle: 'b' }])).toBe('b');
    expect(transcriptTitle([user('x')])).toBeNull();
  });

  it('derives the project slug the way Claude Code does and finds either drive-letter case', () => {
    const root = fixtureDir();
    expect(claudeProjectSlug(root)).toBe(path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-'));
    const config = fixtureDir();
    process.env.CLAUDE_CONFIG_DIR = config;
    expect(claudeSessionsDir(root)).toBeNull();
    const lower = path.join(config, 'projects', claudeProjectSlug(root).toLowerCase());
    fs.mkdirSync(lower, { recursive: true });
    // A case-insensitive filesystem answers the exact-case probe with the same directory.
    expect(claudeSessionsDir(root)?.toLowerCase()).toBe(lower.toLowerCase());
  });
});

describe('ftsQuery', () => {
  it('quotes every word so flags, paths and punctuation cannot break the MATCH syntax', () => {
    expect(ftsQuery('turn-readiness dedupe --limit "5" scripts/cg-probe.ts')).toBe(
      '"turn" "readiness" "dedupe" "limit" "5" "scripts" "cg" "probe" "ts"',
    );
    expect(ftsQuery('  ')).toBe('');
    expect(ftsQuery('ring cap', true)).toBe('"ring" OR "cap"');
  });
});

describe('SessionsIndex', () => {
  it('stems, ranks, filters, and re-reads only files that moved', () => {
    const dir = fixtureDir();
    const a = path.join(dir, 'aaaa-1111.jsonl');
    writeJsonl(
      a,
      [
        { type: 'custom-title', customTitle: 'ponytail sweep' },
        user('we merged the two dedupe paths in turnReadiness'),
        assistant([{ type: 'text', text: 'The merge kept the write-time dedupe and dropped the read-time one.' }]),
      ],
      1_700_000_000,
    );
    // A subagent transcript nests under its parent's directory and is indexed too.
    const b = path.join(dir, 'aaaa-1111', 'subagents', 'agent-1.jsonl');
    writeJsonl(b, [user('the subagent found the ring cap at forty rows')], 1_700_000_000);
    const index = SessionsIndex.open(':memory:');
    expect(index.refresh(dir)).toEqual({ files: 2, refreshed: 2, docs: 3 });

    // Porter: "merging" reaches "merged" and "merge".
    const hits = index.search('merging dedupe');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ session: 'aaaa-1111', title: 'ponytail sweep' });
    expect(hits.every((h) => h.snippet.includes('['))).toBe(true);
    expect(index.search('merging', { role: 'assistant' }).map((h) => h.role)).toEqual(['assistant']);
    expect(index.search('merging', { sinceIso: '2027-01-01T00:00:00.000Z' })).toEqual([]);
    expect(index.search('unrelatedword kept')).toEqual([]);
    expect(index.search('unrelatedword kept', { any: true })).toHaveLength(1);
    expect(index.search('ring cap', { session: 'agent' })).toHaveLength(1);
    expect(index.search('merging', { session: 'bbbb' })).toEqual([]);

    // Unchanged: nothing re-read. Rewritten: replaced, not duplicated. Deleted: forgotten.
    expect(index.refresh(dir).refreshed).toBe(0);
    writeJsonl(a, [user('only this prompt remains after the rewrite')], 1_700_000_100);
    expect(index.refresh(dir)).toEqual({ files: 2, refreshed: 1, docs: 1 });
    expect(index.search('merging')).toEqual([]);
    expect(index.search('rewrite')).toHaveLength(1);
    fs.rmSync(b);
    expect(index.refresh(dir)).toEqual({ files: 1, refreshed: 0, docs: 0 });
    expect(index.search('ring cap')).toEqual([]);
    index.close();
  });
});

describe('querySessions (project entry point)', () => {
  it('indexes into .codegraph/sessions.db from CODEGRAPH_SESSIONS_DIR and honors "sessions": false', () => {
    const project = fixtureDir();
    fs.mkdirSync(path.join(project, '.codegraph'));
    const transcripts = fixtureDir();
    writeJsonl(path.join(transcripts, 's1.jsonl'), [user('decided to keep the write-time dedupe')], 1_700_000_000);
    process.env.CODEGRAPH_SESSIONS_DIR = transcripts;

    const result = querySessions(project, 'deciding dedupe');
    expect(result.index).toEqual({ files: 1, refreshed: 1, docs: 1 });
    expect(result.hits.map((h) => h.session)).toEqual(['s1']);
    expect(fs.existsSync(path.join(project, '.codegraph', 'sessions.db'))).toBe(true);
    expect(formatSessionHits('deciding dedupe', result)).toMatch(/^Sessions matching "deciding dedupe" — 1 hit across 1 transcript:/);
    expect(formatSessionHits('nothing', { index: result.index, hits: [] })).toMatch(/any=true/);

    fs.writeFileSync(path.join(project, 'codegraph.json'), JSON.stringify({ sessions: false }));
    clearProjectConfigCache();
    expect(sessionsSourceDir(project)).toBeNull();
    expect(() => querySessions(project, 'dedupe')).toThrow(NoSessionsError);
  });
});
