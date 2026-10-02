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
import { Worker } from 'worker_threads';
import {
  claudeProjectSlug,
  claudeSessionsDir,
  transcriptDocs,
  transcriptTitle,
} from '../src/sessions/claude-code';
import {
  SessionsIndex,
  enterWalMode,
  ftsQuery,
  querySessions,
  sessionsSourceDir,
  NoSessionsError,
  formatSessionHits,
} from '../src/sessions';
import { clearProjectConfigCache } from '../src/project-config';
import { createDatabase } from '../src/db/sqlite-adapter';

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

  it('indexes a prompt sent mid-turn (a queued_command attachment) as the user', () => {
    const docs = transcriptDocs([
      {
        type: 'attachment',
        timestamp: at,
        attachment: {
          type: 'queued_command',
          prompt: [{ type: 'text', text: 'follow-up: retest Node vs Bun performance metrics' }],
        },
        rendered: [{ content: [{ type: 'text', text: '<system-reminder>The user sent a new message…' }] }],
      },
      { type: 'attachment', timestamp: at, attachment: { type: 'file', content: 'a file attachment is not prose' } },
    ]);
    expect(docs).toEqual([{ ts: at, role: 'user', text: 'follow-up: retest Node vs Bun performance metrics' }]);
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

  it('waits for another connection mid-write and skips a file it already indexed', async () => {
    // Parallel MCP calls run on worker threads, one connection each, and all
    // see the same changed transcript. Another thread holds the write lock and
    // indexes the file while this thread's refresh is under way: the refresh
    // must wait rather than throw "database is locked", then find the row the
    // other thread wrote and leave the file alone instead of indexing it twice.
    const dir = fixtureDir();
    const file = path.join(dir, 'aaaa-1111.jsonl');
    writeJsonl(file, [user('the pool sees one transcript from two threads')], 1_700_000_000);
    const dbPath = path.join(fixtureDir(), 'sessions.db');
    const index = SessionsIndex.open(dbPath);
    const st = fs.statSync(file);
    const other = new Worker(
      `const { workerData, parentPort } = require('worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.dbPath);
       db.exec('BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.prepare('INSERT INTO docs (text, file, role, ts) VALUES (?, ?, ?, ?)')
         .run('the pool sees one transcript from two threads', workerData.file, 'user', workerData.ts);
       db.prepare('INSERT OR REPLACE INTO files (path, session, title, mtime, size) VALUES (?, ?, ?, ?, ?)')
         .run(workerData.file, 'aaaa-1111', null, workerData.mtime, workerData.size);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { dbPath, file, ts: at, mtime: st.mtimeMs, size: st.size } },
    );
    await new Promise((resolve) => other.once('message', resolve));
    expect(index.refresh(dir)).toEqual({ files: 1, refreshed: 0, docs: 0 });
    await new Promise((resolve) => other.once('exit', resolve));
    expect(index.search('pool transcript threads')).toHaveLength(1);
    index.close();
  });

  it('opens a fresh database while another connection holds it, converting to WAL once free', async () => {
    // An ordinary lock wait on the conversion is covered by busy_timeout: the
    // holder commits and this open then converts, rather than throwing.
    const dbPath = path.join(fixtureDir(), 'sessions.db');
    const other = new Worker(
      `const { workerData, parentPort } = require('worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.dbPath);
       db.exec('BEGIN EXCLUSIVE');
       parentPort.postMessage('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       db.exec('COMMIT');
       db.close();`,
      { eval: true, workerData: { dbPath } },
    );
    await new Promise((resolve) => other.once('message', resolve));
    const index = SessionsIndex.open(dbPath);
    await new Promise((resolve) => other.once('exit', resolve));
    const db = createDatabase(dbPath).db;
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    db.close();
    index.close();
  });

  it('retries a WAL conversion that collides with another process converting the same fresh file', () => {
    // What busy_timeout does NOT cover: several processes converting one
    // brand-new database at the same moment collide inside the conversion
    // rather than queueing on a lock, and it surfaces as either of these two
    // transient errors. That collision only reproduces probabilistically, so
    // the retry is driven directly here.
    for (const message of ['database is locked', 'disk I/O error']) {
      let calls = 0;
      const db = {
        pragma(sql: string) {
          if (!/journal_mode\s*=/i.test(sql)) return 'delete';
          if (++calls < 3) throw new Error(message);
          return 'wal';
        },
      };
      expect(() => enterWalMode(db as never)).not.toThrow();
      expect(calls).toBe(3);
    }
  });

  it('gives up on a WAL conversion error that is not the transient collision', () => {
    const db = {
      pragma() {
        throw new Error('unable to open database file');
      },
    };
    expect(() => enterWalMode(db as never)).toThrow(/unable to open database file/);
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
    // Same reader version: the file is not re-read. An index written by an
    // older reader (user_version behind) is re-read once in full.
    expect(querySessions(project, 'deciding dedupe').index.refreshed).toBe(0);
    const { db } = createDatabase(path.join(project, '.codegraph', 'sessions.db'));
    db.exec('PRAGMA user_version = 1');
    db.close();
    expect(querySessions(project, 'deciding dedupe').index).toEqual({ files: 1, refreshed: 1, docs: 1 });
    expect(fs.existsSync(path.join(project, '.codegraph', 'sessions.db'))).toBe(true);
    expect(formatSessionHits('deciding dedupe', result)).toMatch(/^Sessions matching "deciding dedupe" — 1 hit across 1 transcript:/);
    expect(formatSessionHits('nothing', { index: result.index, hits: [] })).toMatch(/any=true/);

    fs.writeFileSync(path.join(project, 'codegraph.json'), JSON.stringify({ sessions: false }));
    clearProjectConfigCache();
    expect(sessionsSourceDir(project)).toBeNull();
    expect(() => querySessions(project, 'dedupe')).toThrow(NoSessionsError);
  });
});
