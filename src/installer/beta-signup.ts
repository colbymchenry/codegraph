/**
 * CodeGraph Pro beta opt-in — the installer's one-time offer to join the
 * beta-access waitlist (the same list the getcodegraph.com homepage form
 * feeds). Strictly opt-in: the user must answer yes AND type their email;
 * nothing is ever sent otherwise, and `--yes` / non-interactive runs never
 * see the prompt.
 *
 * The choice (subscribed or declined) is stored once in the user-level
 * state dir (~/.codegraph) so re-installs and upgrades never re-ask —
 * mirroring the telemetry consent pattern. A failed submit stores nothing,
 * so a later install can offer again.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** JSON waitlist endpoint on the landing page (see its /api/waitlist route). */
export const BETA_SIGNUP_ENDPOINT = 'https://getcodegraph.com/api/waitlist';
export const BETA_SIGNUP_URL = 'https://getcodegraph.com';

/** Same shape the landing-page form validates against. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SUBMIT_TIMEOUT_MS = 8_000;

interface BetaSignupChoiceFile {
  status: 'subscribed' | 'declined';
  updated_at: string;
}

export interface BetaSignupDeps {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Where the signup came from, recorded with the email. */
  source?: 'cli-install' | 'cli-upgrade';
  /** TTY probes; default to the real process streams. Tests inject. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

function choicePath(deps: BetaSignupDeps = {}): string {
  return path.join(deps.dir ?? path.join(os.homedir(), '.codegraph'), 'beta-signup.json');
}

/** True once the user has answered (either way) on this machine. */
export function hasBetaSignupChoice(deps: BetaSignupDeps = {}): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(choicePath(deps), 'utf8')) as BetaSignupChoiceFile;
    return raw.status === 'subscribed' || raw.status === 'declined';
  } catch {
    return false;
  }
}

/** Persist the answer so no future install re-asks. Fail silent. */
export function recordBetaSignupChoice(
  subscribed: boolean,
  deps: BetaSignupDeps = {},
): void {
  try {
    const file = choicePath(deps);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const choice: BetaSignupChoiceFile = {
      status: subscribed ? 'subscribed' : 'declined',
      updated_at: (deps.now?.() ?? new Date()).toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(choice, null, 2) + '\n');
  } catch {
    /* a full disk must not break the installer */
  }
}

/**
 * Submit one email to the beta waitlist. Returns true on success, false on
 * any failure (bad response, offline, timeout) — never throws, never retries.
 */
export async function submitBetaSignup(
  email: string,
  deps: BetaSignupDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(BETA_SIGNUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: deps.source ?? 'cli-install' }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The one gate every ask site shares: offer only on a real terminal, and
 * never once ANY prior ask (install or upgrade) has been answered on this
 * machine. Exported separately so the no-spam rule is unit-testable.
 */
export function shouldOfferBetaSignup(deps: BetaSignupDeps = {}): boolean {
  const stdinTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
  if (!stdinTTY || !stdoutTTY) return false;
  return !hasBetaSignupChoice(deps);
}

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages (same trick as installer/index.ts).
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

/**
 * The full interactive offer: confirm → email → submit → remember. Shared by
 * `codegraph install` (end of a successful install) and `codegraph upgrade`
 * (after a successful binary update). Silently does nothing when the gate
 * says no; never throws — a marketing question must not fail the command
 * that hosts it. Cancel (Ctrl-C) and a failed submit store nothing, so a
 * later install/upgrade may offer again; an explicit yes or no is stored
 * forever.
 */
export async function maybeOfferBetaSignup(deps: BetaSignupDeps = {}): Promise<void> {
  try {
    if (!shouldOfferBetaSignup(deps)) return;
    const clack = await importESM('@clack/prompts');

    const wantsBeta = await clack.confirm({
      message:
        'Want early access to CodeGraph Pro? Join the beta waitlist — we’ll only email you about CodeGraph, never share your address.',
      initialValue: true,
    });
    if (clack.isCancel(wantsBeta)) {
      clack.log.info(`Skipped — you can join anytime at ${BETA_SIGNUP_URL}.`);
      return;
    }
    if (!wantsBeta) {
      recordBetaSignupChoice(false, deps);
      clack.log.info(`No problem — you can join anytime at ${BETA_SIGNUP_URL}.`);
      return;
    }

    const email = await clack.text({
      message: 'What email should we send beta access to?',
      placeholder: 'you@company.com',
      validate: (value) =>
        EMAIL_RE.test((value ?? '').trim()) ? undefined : 'That email address doesn’t look right.',
    });
    if (clack.isCancel(email)) {
      clack.log.info(`Skipped — you can join anytime at ${BETA_SIGNUP_URL}.`);
      return;
    }

    const s = clack.spinner();
    s.start('Joining the beta waitlist...');
    const ok = await submitBetaSignup(email.trim(), deps);
    if (ok) {
      s.stop('You’re on the list — we’ll email you when beta access opens.');
      recordBetaSignupChoice(true, deps);
    } else {
      s.stop('Couldn’t reach the waitlist right now.');
      clack.log.warn(`No worries — you can join anytime at ${BETA_SIGNUP_URL}.`);
    }
  } catch {
    /* never let the beta question break an install or upgrade */
  }
}
