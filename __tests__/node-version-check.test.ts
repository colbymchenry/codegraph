/**
 * Pin the unsafe Node block banner content. The banner replaced a soft
 * `console.warn` because the warning was scrolling off-screen before
 * the OOM crash 30 seconds later, generating duplicate bug reports
 * (#54, #81, #140). The recipe and override env var below are
 * load-bearing — if any of them get edited away, this test catches it.
 */

import { describe, it, expect } from 'vitest';
import {
  assertSupportedNodeVersion,
  buildUnsupportedNodeBlockBanner,
  getNodeMajor,
  isUnsupportedNodeVersion,
  shouldBlockUnsupportedNodeVersion,
} from '../src/bin/node-version-check';

describe('getNodeMajor', () => {
  it('parses the major from a Node version string', () => {
    expect(getNodeMajor('24.13.0')).toBe(24);
  });

  it('returns null for malformed versions', () => {
    expect(getNodeMajor('not-a-version')).toBeNull();
  });
});

describe('isUnsupportedNodeVersion', () => {
  it('allows supported LTS Node versions', () => {
    expect(isUnsupportedNodeVersion('18.20.0')).toBe(false);
    expect(isUnsupportedNodeVersion('20.19.4')).toBe(false);
    expect(isUnsupportedNodeVersion('22.11.0')).toBe(false);
  });

  it('blocks Node 24 and newer before WASM compilation can crash', () => {
    expect(isUnsupportedNodeVersion('24.13.0')).toBe(true);
    expect(isUnsupportedNodeVersion('25.0.0')).toBe(true);
  });
});

describe('shouldBlockUnsupportedNodeVersion', () => {
  it('honors the explicit unsafe override', () => {
    expect(shouldBlockUnsupportedNodeVersion('24.13.0', false)).toBe(true);
    expect(shouldBlockUnsupportedNodeVersion('24.13.0', true)).toBe(false);
  });
});

describe('assertSupportedNodeVersion', () => {
  it('throws a recovery banner before unsafe runtimes can compile WASM', () => {
    expect(() => assertSupportedNodeVersion('24.13.0', false)).toThrow(
      /Unsupported Node.js version: 24\.13\.0/
    );
  });

  it('allows unsafe runtimes when the override is active', () => {
    expect(() => assertSupportedNodeVersion('24.13.0', true)).not.toThrow();
  });
});

describe('buildUnsupportedNodeBlockBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildUnsupportedNodeBlockBanner('24.13.0')).toContain(
      'Unsupported Node.js version: 24.13.0'
    );
  });

  it('names the V8 turboshaft WASM root cause and the OOM symptom', () => {
    const banner = buildUnsupportedNodeBlockBanner('24.13.0');
    expect(banner).toContain('V8 WASM JIT');
    expect(banner).toContain('turboshaft');
    expect(banner).toContain('Fatal process out of memory: Zone');
    expect(banner).toContain('Node.js 24.x and 25.x');
  });

  it('points users to Node 22 LTS via nvm and Homebrew', () => {
    const banner = buildUnsupportedNodeBlockBanner('24.13.0');
    expect(banner).toContain('Node.js 22 LTS');
    expect(banner).toContain('nvm install 22');
    expect(banner).toContain('brew install node@22');
  });

  it('documents the CODEGRAPH_ALLOW_UNSAFE_NODE override', () => {
    const banner = buildUnsupportedNodeBlockBanner('24.13.0');
    expect(banner).toContain('CODEGRAPH_ALLOW_UNSAFE_NODE=1');
  });

  it('links to issue #81 for the root-cause writeup', () => {
    expect(buildUnsupportedNodeBlockBanner('24.13.0')).toContain(
      'github.com/colbymchenry/codegraph/issues/81'
    );
  });
});
