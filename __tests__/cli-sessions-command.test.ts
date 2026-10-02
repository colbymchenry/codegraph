/**
 * `codegraph sessions` CLI command — the shell face of codegraph_sessions.
 *
 * Exercised end-to-end against the built binary, mirroring
 * cli-query-command.test.ts: an initialized project, a transcript directory
 * handed in through CODEGRAPH_SESSIONS_DIR, human and --json output, the
 * filters, and the guidance (not an error) when a project has no transcripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function sessions(cwd: string, transcripts: string | undefined, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };
  if (transcripts) env.CODEGRAPH_SESSIONS_DIR = transcripts;
  else env.CLAUDE_CONFIG_DIR = path.join(cwd, 'no-claude-here');
  return execFileSync(process.execPath, [BIN, 'sessions', ...args, '-p', cwd], {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'], // drop stderr (SQLite experimental warning)
  });
}

const at = '2026-09-04T20:00:00.000Z';
const entry = (type: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, timestamp: at, message: { content: text }, ...extra });

describe('codegraph sessions — CLI command', () => {
  let tempDir: string;
  let transcripts: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sessions-cmd-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src/auth.ts'), 'export function parseToken(t: string){ return t.trim(); }\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
    transcripts = path.join(tempDir, 'transcripts');
    fs.mkdirSync(transcripts);
    fs.writeFileSync(
      path.join(transcripts, 'abcd-0001.jsonl'),
      [
        JSON.stringify({ type: 'custom-title', customTitle: 'token parsing' }),
        entry('user', 'why does parseToken trim before validating the signature?'),
        entry('assistant', 'Trimming first keeps a trailing newline from failing the signature check.'),
      ].join('\n') + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints ranked hits with session id, title, role and a marked snippet', () => {
    // "trailing" and "newline" appear only in the reply; porter would also let
    // "trim" reach both docs, so the words are chosen to keep the prompt out.
    const out = sessions(tempDir, transcripts, ['trailing', 'newlines']);
    expect(out).toContain('## abcd-0001 · token parsing');
    expect(out).toContain('assistant · ' + at);
    expect(out).toMatch(/\[trailing\] \[newline\]/);
    expect(out).not.toContain('user · ');
  });

  it('--json carries the index stats and the raw hits; --role and --any filter and widen', () => {
    const parsed = JSON.parse(sessions(tempDir, transcripts, ['trim', '--json']));
    expect(parsed.index).toEqual({ files: 1, refreshed: 1, docs: 2 });
    expect(parsed.hits.map((h: { role: string }) => h.role).sort()).toEqual(['assistant', 'user']);
    const users = JSON.parse(sessions(tempDir, transcripts, ['trim', '--role', 'user', '--json']));
    expect(users.hits.map((h: { role: string }) => h.role)).toEqual(['user']);
    // Second run: nothing re-read.
    expect(users.index.refreshed).toBe(0);
    expect(JSON.parse(sessions(tempDir, transcripts, ['newline', 'nonexistentword', '--json'])).hits).toEqual([]);
    expect(JSON.parse(sessions(tempDir, transcripts, ['newline', 'nonexistentword', '--any', '--json'])).hits).toHaveLength(1);
  });

  it('a project without transcripts gets guidance, not an error', () => {
    const out = sessions(tempDir, undefined, ['anything']);
    expect(out).toMatch(/No agent-session transcripts to index/);
  });
});
