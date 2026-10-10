// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const themeCss = readFileSync(
  join(import.meta.dirname, '..', 'ui', 'src', 'lib', 'theme.css'),
  'utf8'
);

function mountTheme(theme?: 'light' | 'dark'): HTMLElement {
  const style = document.createElement('style');
  style.textContent = themeCss;
  document.head.append(style);

  const host = document.createElement('div');
  if (theme) host.dataset.theme = theme;
  document.body.append(host);
  return host;
}

function token(host: HTMLElement, name: string): string {
  return getComputedStyle(host).getPropertyValue(name).trim();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

describe('CodeGraph route theme', () => {
  it('exposes the complete light route palette alongside the legacy public tokens', () => {
    const host = mountTheme('light');

    expect(token(host, '--route-main')).toBe('#3867a8');
    expect(token(host, '--route-branch')).toBe('#147c98');
    expect(token(host, '--route-return')).toBe('#b8443e');
    expect(token(host, '--route-muted')).toBe('#8390a1');
    expect(token(host, '--route-grid')).toBe('#e3e8ef');
    expect(token(host, '--route-band')).toBe('#eef1f5');

    for (const legacy of ['--paper', '--ink', '--accent', '--rule-soft', '--amber']) {
      expect(token(host, legacy), legacy).not.toBe('');
    }
  });

  it('switches every route token on an explicitly dark component host', () => {
    const host = mountTheme('dark');

    expect(token(host, '--route-main')).toBe('#87ace2');
    expect(token(host, '--route-branch')).toBe('#49afc7');
    expect(token(host, '--route-return')).toBe('#e06a63');
    expect(token(host, '--route-muted')).toBe('#668087');
    expect(token(host, '--route-grid')).toBe('#183039');
    expect(token(host, '--route-band')).toBe('#102129');
  });

  it('keeps secondary body text AA-readable on every text-bearing surface', () => {
    for (const theme of ['light', 'dark'] as const) {
      const host = mountTheme(theme);
      const foreground = token(host, '--ink-3');

      for (const surface of ['--paper', '--paper-2', '--accent-soft']) {
        expect(contrast(foreground, token(host, surface)), `${theme} ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
