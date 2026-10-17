// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Web UI theme preference', () => {
  let host: HTMLElement;
  let dispose: (() => Promise<void>) | undefined;
  let waitForUpdate: () => Promise<void>;
  let storage: Storage;
  let failOnSet = false;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    failOnSet = false;
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host')!;

    const values = new Map<string, string>();
    storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(key) {
        return values.get(key) ?? null;
      },
      key(index) {
        return [...values.keys()][index] ?? null;
      },
      removeItem(key) {
        values.delete(key);
      },
      setItem(key, value) {
        if (failOnSet) throw new Error('storage unavailable');
        values.set(key, value);
      },
    };
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    vi.unstubAllGlobals();
  });

  async function renderTopBar(): Promise<HTMLSelectElement> {
    const [{ mount, tick, unmount }, { default: TopBar }] = await Promise.all([
      import('svelte'),
      import('../ui/src/components/TopBar.svelte'),
    ]);
    const mounted = mount(TopBar, { target: host });
    dispose = () => unmount(mounted);
    waitForUpdate = tick;
    await waitForUpdate();
    const settings = host.querySelector<HTMLButtonElement>('.settings');
    expect(settings).not.toBeNull();
    settings!.click();
    await waitForUpdate();
    const select = host.querySelector<HTMLSelectElement>('.panel select');
    expect(select).not.toBeNull();
    return select!;
  }

  function choose(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('默认跟随系统，并可在三个主题间切换和保存', async () => {
    const group = await renderTopBar();

    expect(group.value).toBe('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();

    choose(group, 'light');
    await waitForUpdate();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(storage.getItem('codegraph.ui.theme')).toBe('light');
    expect(group.value).toBe('light');

    choose(group, 'dark');
    await waitForUpdate();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(storage.getItem('codegraph.ui.theme')).toBe('dark');

    choose(group, 'auto');
    await waitForUpdate();
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(storage.getItem('codegraph.ui.theme')).toBe('auto');
  });

  it('启动时恢复已保存的主题', async () => {
    storage.setItem('codegraph.ui.theme', 'dark');

    const group = await renderTopBar();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(group.value).toBe('dark');
  });

  it('保存失败时仍切换当前会话主题', async () => {
    const group = await renderTopBar();
    failOnSet = true;

    choose(group, 'dark');
    await waitForUpdate();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
