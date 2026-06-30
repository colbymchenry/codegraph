/**
 * Managed-login device flow for `codegraph login`.
 *
 * Opens the user's browser to the CodeGraph dashboard, where they authorize with
 * their account; the CLI meanwhile polls for the minted, org-scoped token and
 * stores it (see ./credentials + ./config) to turn on managed reasoning.
 *
 * This talks to the DASHBOARD (app.getcodegraph.com), not the metered gateway —
 * it's a plain OAuth-style device handshake (RFC 8628 shape), nothing proprietary.
 * The resulting token is what authenticates the managed reasoning calls (./reasoner).
 */
import { spawn } from 'child_process';

const DEFAULT_BASE = 'https://app.getcodegraph.com';

/** Dashboard base for the device-login endpoints; override for testing via CODEGRAPH_LOGIN_URL. */
export function loginBaseUrl(): string {
  const raw = process.env.CODEGRAPH_LOGIN_URL?.trim() || DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

/** The dashboard's response to a device-authorization start request. */
export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** Same URL with the code prefilled, for one-click open. */
  verification_uri_complete?: string;
  /** Seconds the CLI should wait between polls. */
  interval?: number;
  /** Seconds until the request expires. */
  expires_in?: number;
}

/** Begin a device-authorization request. */
export async function startDeviceLogin(): Promise<DeviceStart> {
  const base = loginBaseUrl();
  const res = await fetch(`${base}/api/cli/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  if (!res) throw new Error(`couldn't reach ${base} — check your connection`);
  if (!res.ok) throw new Error(`couldn't start login (HTTP ${res.status})`);
  const j = (await res.json().catch(() => null)) as DeviceStart | null;
  if (!j?.device_code || !j.user_code) throw new Error('login start returned an unexpected response');
  return j;
}

/** Poll until the user approves in the browser; resolves with the org token. */
export async function pollForToken(deviceCode: string, intervalSec: number, expiresInSec: number): Promise<string> {
  const deadline = Date.now() + Math.max(30, expiresInSec || 600) * 1000;
  let waitMs = Math.max(2, intervalSec || 5) * 1000;
  const base = loginBaseUrl();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, waitMs));
    const res = await fetch(`${base}/api/cli/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    }).catch(() => null);
    if (!res) continue; // transient network blip — keep polling until the deadline
    if (res.status === 200) {
      const j = (await res.json().catch(() => null)) as { token?: string } | null;
      if (j?.token) return j.token;
    } else if (res.status === 429) {
      waitMs += 2000; // server asked us to slow down
    } else if (res.status === 404 || res.status === 410) {
      throw new Error('the login request expired — run `codegraph login` again');
    }
    // 202 (authorization pending) → keep waiting
  }
  throw new Error('login timed out before you approved — run `codegraph login` again');
}

/** Best-effort: open a URL in the default browser. Never throws — the URL is also printed. */
export async function openBrowser(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL is printed for manual open */
  }
}
