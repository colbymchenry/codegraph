/**
 * CodeGraph Pro beta opt-in (installer Step 5½).
 *
 * Covers the module the interactive prompt drives:
 *   - ask-once persistence in the user-level state dir (temp dir injected —
 *     no real ~/.codegraph ever touched)
 *   - the submit request shape (endpoint, method, JSON body)
 *   - fail-soft behavior: bad responses and network errors return false,
 *     never throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  BETA_SIGNUP_ENDPOINT,
  EMAIL_RE,
  hasBetaSignupChoice,
  recordBetaSignupChoice,
  shouldOfferBetaSignup,
  submitBetaSignup,
} from '../src/installer/beta-signup';

describe('beta signup choice persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-beta-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports no choice on a fresh machine', () => {
    expect(hasBetaSignupChoice({ dir })).toBe(false);
  });

  it('remembers a subscribed choice so no future install re-asks', () => {
    recordBetaSignupChoice(true, { dir });
    expect(hasBetaSignupChoice({ dir })).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'beta-signup.json'), 'utf8'));
    expect(raw.status).toBe('subscribed');
    expect(raw.updated_at).toBeTruthy();
  });

  it('remembers a declined choice too — declining is also asked-once', () => {
    recordBetaSignupChoice(false, { dir });
    expect(hasBetaSignupChoice({ dir })).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'beta-signup.json'), 'utf8'));
    expect(raw.status).toBe('declined');
  });

  it('creates the state dir when missing', () => {
    const nested = path.join(dir, 'not', 'yet', 'there');
    recordBetaSignupChoice(true, { dir: nested });
    expect(hasBetaSignupChoice({ dir: nested })).toBe(true);
  });

  it('treats a corrupted choice file as no choice', () => {
    fs.writeFileSync(path.join(dir, 'beta-signup.json'), 'not json');
    expect(hasBetaSignupChoice({ dir })).toBe(false);
    fs.writeFileSync(path.join(dir, 'beta-signup.json'), JSON.stringify({ status: 'maybe' }));
    expect(hasBetaSignupChoice({ dir })).toBe(false);
  });
});

describe('shouldOfferBetaSignup — the shared no-spam gate', () => {
  let dir: string;
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-beta-gate-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('offers on a fresh machine with a real terminal', () => {
    expect(shouldOfferBetaSignup({ dir, ...tty })).toBe(true);
  });

  it('never offers again once subscribed — from install OR upgrade', () => {
    recordBetaSignupChoice(true, { dir });
    expect(shouldOfferBetaSignup({ dir, ...tty, source: 'cli-install' })).toBe(false);
    expect(shouldOfferBetaSignup({ dir, ...tty, source: 'cli-upgrade' })).toBe(false);
  });

  it('never offers again once declined either', () => {
    recordBetaSignupChoice(false, { dir });
    expect(shouldOfferBetaSignup({ dir, ...tty, source: 'cli-install' })).toBe(false);
    expect(shouldOfferBetaSignup({ dir, ...tty, source: 'cli-upgrade' })).toBe(false);
  });

  it('never offers without a terminal (scripts, CI, piped output)', () => {
    expect(shouldOfferBetaSignup({ dir, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(shouldOfferBetaSignup({ dir, stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
  });
});

describe('submitBetaSignup', () => {
  it('POSTs the email as JSON to the waitlist endpoint', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    const ok = await submitBetaSignup('dev@example.com', { fetchImpl });

    expect(ok).toBe(true);
    expect(captured!.url).toBe(BETA_SIGNUP_ENDPOINT);
    expect(captured!.init.method).toBe('POST');
    expect((captured!.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({ email: 'dev@example.com', source: 'cli-install' });
  });

  it('records where the signup came from (install vs upgrade)', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    await submitBetaSignup('dev@example.com', { fetchImpl, source: 'cli-upgrade' });
    expect(body.source).toBe('cli-upgrade');
  });

  it('returns false on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      new Response('{"ok":false}', { status: 502 })) as typeof fetch;
    expect(await submitBetaSignup('dev@example.com', { fetchImpl })).toBe(false);
  });

  it('returns false (never throws) when the network fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await submitBetaSignup('dev@example.com', { fetchImpl })).toBe(false);
  });
});

describe('EMAIL_RE', () => {
  it('matches the landing-page validation shape', () => {
    expect(EMAIL_RE.test('you@company.com')).toBe(true);
    expect(EMAIL_RE.test('first.last+tag@sub.domain.io')).toBe(true);
    expect(EMAIL_RE.test('nope')).toBe(false);
    expect(EMAIL_RE.test('nope@nodot')).toBe(false);
    expect(EMAIL_RE.test('spaces in@mail.com')).toBe(false);
    expect(EMAIL_RE.test('')).toBe(false);
  });
});
