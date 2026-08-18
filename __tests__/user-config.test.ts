/**
 * Global user-level config (`~/.codegraph/config.json`) — currently one
 * field, `autoInit`. Modeled directly on the beta-signup choice file
 * (src/installer/beta-signup.ts): same state dir, same fail-silent /
 * corrupted-file-means-default behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAutoInit, setAutoInit } from '../src/installer/user-config';

describe('global auto-init config', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-user-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to false on a fresh machine', () => {
    expect(getAutoInit({ dir })).toBe(false);
  });

  it('persists true after setAutoInit(true)', () => {
    setAutoInit(true, { dir });
    expect(getAutoInit({ dir })).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(raw.autoInit).toBe(true);
  });

  it('persists false after setAutoInit(false)', () => {
    setAutoInit(true, { dir });
    setAutoInit(false, { dir });
    expect(getAutoInit({ dir })).toBe(false);
  });

  it('creates the state dir when missing', () => {
    const nested = path.join(dir, 'not', 'yet', 'there');
    setAutoInit(true, { dir: nested });
    expect(getAutoInit({ dir: nested })).toBe(true);
  });

  it('treats a corrupted config file as the default (false), never throws', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json');
    expect(getAutoInit({ dir })).toBe(false);
  });

  it('preserves unrelated fields already in config.json when writing', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ somethingElse: 'keep-me' }));
    setAutoInit(true, { dir });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(raw.somethingElse).toBe('keep-me');
    expect(raw.autoInit).toBe(true);
  });
});
