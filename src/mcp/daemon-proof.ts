/**
 * Lets a client tell this user's daemon from a stand-in another user put where
 * the daemon listens, before it sends anything the daemon should not see: the
 * prompt hook's prompt (#3284), and every MCP session the proxy pipes through,
 * whose tool calls go to the daemon and whose answers go into the agent's
 * context.
 *
 * Where the daemon listens is open to others in two cases: the socket fallback
 * in the system temp folder on macOS and Linux, and on Windows the named pipe,
 * whose name lives in one namespace every user can create in. Node can read
 * neither the peer's user on a socket nor a pipe's owner. What a stand-in can't
 * do is read a file only this user can read. So the client sends a fresh random
 * challenge in its client-hello, and this user's daemon answers with an HMAC of
 * it, and of the path it listens on, under a key kept in that file. A proof
 * from the real daemon for another path, relayed, does not match.
 *
 * The key is per user, `~/.codegraph/daemon.key`, made on first use with mode
 * 0600. On macOS and Linux a key another user owns, or that others can read,
 * is refused; one of this user's that others can read is replaced, since it
 * may have been read. On Windows the file takes the user profile's ACL, which
 * admits the user, SYSTEM and Administrators.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const KEY_BYTES = 32;
const PROOF_CONTEXT = 'codegraph-daemon-proof-v1';

/** Longest challenge a daemon answers; a client sends 44 characters. */
export const MAX_CHALLENGE_LENGTH = 256;

// `crypto` is the slowest builtin to load; only the paths that prove load it.
function crypto(): typeof import('crypto') {
  return require('crypto') as typeof import('crypto');
}

/** Where this user's daemon key lives. */
export function daemonKeyPath(): string {
  return path.join(os.homedir(), '.codegraph', 'daemon.key');
}

/** The key, when the file holds one that only this user can read; null otherwise. Never creates. */
export function readDaemonKey(file: string = daemonKeyPath()): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    if (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) return null;
    const key = fs.readFileSync(file);
    return key.length >= KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * The key, made on first use; the daemon calls this when a client asks for a
 * proof. Null when no key only this user can read can be had: then the daemon
 * proves nothing, and the client treats it as no daemon.
 */
export function daemonKey(file: string = daemonKeyPath()): Buffer | null {
  const key = readDaemonKey(file);
  if (key) return key;
  let replace = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    if (process.platform !== 'win32' && stat.uid !== process.getuid?.()) return null;
    // This user's, but others can read it, or it is too short to be a key.
    replace = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  const { randomBytes } = crypto();
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.daemon.key.${process.pid}.${randomBytes(6).toString('hex')}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' });
    if (replace) {
      fs.renameSync(tmp, file);
    } else {
      // Publish without overwriting: of two daemons making it at once, the
      // first one's key stands, and the other reads it below.
      try {
        fs.linkSync(tmp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') fs.renameSync(tmp, file);
      }
    }
  } catch {
    /* read below: whatever is there now decides */
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed away, or never written */ }
  }
  return readDaemonKey(file);
}

/** A fresh random challenge for one connection. */
export function newDaemonChallenge(): string {
  return crypto().randomBytes(32).toString('base64');
}

/** The daemon's answer to `challenge` on the socket or pipe at `socketPath`. */
export function daemonProof(key: Buffer, challenge: string, socketPath: string): string {
  return crypto().createHmac('sha256', key).update(`${PROOF_CONTEXT}\0${challenge}\0${socketPath}`).digest('hex');
}

/** Whether `proof` is this user's daemon answering `challenge` at `socketPath`. */
export function daemonProofMatches(key: Buffer, challenge: string, socketPath: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return crypto().timingSafeEqual(Buffer.from(daemonProof(key, challenge, socketPath), 'hex'), Buffer.from(proof, 'hex'));
}
