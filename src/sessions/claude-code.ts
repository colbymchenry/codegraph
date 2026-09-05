/**
 * Reader for Claude Code's session transcripts — the first agent host the
 * session index knows how to read. One reader per host; a second host (Cursor's
 * chat store, Codex's) is a sibling module with the same `SessionDoc` output.
 *
 * Claude Code keeps one JSONL file per session under
 * `~/.claude/projects/<slug>/` (subagent transcripts in subdirectories,
 * `memory/` holds notes rather than sessions), one JSON entry per line. The
 * slug is the project's absolute path with every non-alphanumeric character
 * replaced by `-`; on Windows the drive letter may be stored lowercased, so
 * the lookup tries both spellings and takes the one that exists.
 *
 * What counts as prose: the user's prompts, the assistant's text blocks and
 * compaction summaries. Tool calls, tool results and thinking blocks are not
 * text blocks and stay out, as do meta entries and anything shorter than
 * `MIN_DOC_CHARS` ("ok").
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SessionDoc {
  /** ISO timestamp of the entry. */
  ts: string;
  role: 'user' | 'assistant' | 'summary';
  text: string;
}

interface Entry {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  customTitle?: string;
  message?: { content?: unknown };
}

/** Shorter text is a "yes"/"ok" turn — noise in a prose index. */
export const MIN_DOC_CHARS = 20;

/** Claude Code's config dir: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The slug Claude Code derives from a project path. */
export function claudeProjectSlug(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The transcript directory for a project, or null when Claude Code has never
 * run there. Tries the exact-case slug first, then the lowercased one (Windows
 * drive letters).
 */
export function claudeSessionsDir(projectRoot: string): string | null {
  const projects = path.join(claudeConfigDir(), 'projects');
  const slug = claudeProjectSlug(projectRoot);
  for (const candidate of [slug, slug.toLowerCase()]) {
    const dir = path.join(projects, candidate);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

/** Every `.jsonl` under `dir`, recursively, skipping `memory/`. */
export function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'memory') out.push(...walkJsonl(full));
    } else if (entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** Parse a JSONL transcript; a truncated trailing line from a live session is skipped. */
export function parseEntries(file: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // A partially written line from a session still running.
    }
  }
  return entries;
}

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text?: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
    )
    .map((b) => b.text ?? '')
    .join('\n');
}

/** The prose of a transcript, one doc per prompt, reply or compaction summary. */
export function transcriptDocs(entries: Entry[]): SessionDoc[] {
  const docs: SessionDoc[] = [];
  for (const e of entries) {
    if (!e.timestamp || e.isMeta || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const text = textBlocks(e.message?.content).trim();
    if (text.length < MIN_DOC_CHARS) continue;
    docs.push({ ts: e.timestamp, role: e.isCompactSummary ? 'summary' : e.type, text });
  }
  return docs;
}

/** The session title Claude Code stored last, if any. */
export function transcriptTitle(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const title = entries[i]?.customTitle;
    if (title) return title;
  }
  return null;
}

/** The session id is the file's basename; subagent transcripts nest under their parent's id. */
export function sessionIdOf(file: string): string {
  return path.basename(file, '.jsonl');
}
