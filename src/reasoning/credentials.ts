/**
 * Managed-offload credentials: the CodeGraph org token that authenticates the
 * managed reasoning tier against `codegraph-ai` (the metered gateway).
 *
 * Unlike a BYO provider key (which is never persisted — the config stores only the
 * NAME of an env var), the org token IS a revocable, org-scoped auth token issued
 * to this machine — like the token `gh auth` or `npm login` stores. So it lives in
 * its own file, `~/.codegraph/credentials.json`, written `0600`, kept out of the
 * shareable `config.json`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function credentialsPath(): string {
  return path.join(os.homedir(), '.codegraph', 'credentials.json');
}

function read(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The stored managed-offload org token, if the machine is logged in. */
export function readOffloadToken(): string | undefined {
  const t = read().offloadToken;
  return typeof t === 'string' && t.trim() ? t.trim() : undefined;
}

/** Persist (or, with `null`, clear) the managed-offload org token at `0600`. */
export function writeOffloadToken(token: string | null): void {
  const p = credentialsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const creds = read();
  if (token === null) delete creds.offloadToken;
  else creds.offloadToken = token;
  // Write restrictively: create at 0600, and tighten an existing file too.
  fs.writeFileSync(p, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
}
