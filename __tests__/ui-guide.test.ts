import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickStart from '../ui/src/components/QuickStart.svelte';
import HelpDialog from '../ui/src/components/HelpDialog.svelte';
import ViewHelp from '../ui/src/components/ViewHelp.svelte';
import { guide } from '../ui/src/lib/guide.svelte';
import { i18n } from '../ui/src/lib/i18n.svelte';
import { createProjectNavigation, setNavigationDriver } from '../ui/src/lib/navigation';

const data = vi.hoisted(() => ({ entries: null as any, ensureEntries: vi.fn() }));
vi.mock('../ui/src/lib/palette.svelte', () => ({ palette: {
  get entries() { return data.entries; },
  entriesSettled: true,
  ensureEntries: data.ensureEntries,
} }));

let host: HTMLElement;
let mounted: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  document.body.innerHTML = '<button id="opener">使用帮助</button><div id="host"></div>';
  host = document.getElementById('host')!;
  guide.setDismissed(false);
  i18n.setLocale('zh-CN');
  setNavigationDriver(createProjectNavigation('project a'));
  data.entries = null;
  vi.clearAllMocks();
});
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  setNavigationDriver(null);
  vi.restoreAllMocks();
});

describe('快速上手', () => {
  it('为选中的真实入口生成同项目的步骤和源码链接，并跳过未解析入口', async () => {
    data.entries = {
      routes: { items: { items: [
        { url:'/missing', handler:'unknown', handlerId:null, file:'routes.ts' },
        { url:'/first', handler:'first', handlerId:'function:first/a', file:'first.ts' },
        { url:'/second', handler:'second', handlerId:'function:second/b', file:'second.ts' },
      ] } },
      hubs: { items: [] },
    };
    mounted = mount(QuickStart, { target:host, props:{ onsearch:vi.fn() } });
    await tick();
    expect(host.querySelectorAll('option')).toHaveLength(2);
    const links = () => [...host.querySelectorAll('li a')].map(link => link.getAttribute('href'));
    expect(links()).toEqual([
      '#/p/project%20a/entry',
      '#/p/project%20a/steps?anchor=function%3Afirst%2Fa',
      '#/p/project%20a/s/function%3Afirst/a',
    ]);
    const select = host.querySelector('select')!;
    select.value = 'function:second/b';
    select.dispatchEvent(new Event('change', { bubbles:true }));
    await tick();
    expect(links()[1]).toContain('anchor=function%3Asecond%2Fb');
    expect(links()[2]).toContain('/s/function%3Asecond/b');
  });

  it('没有推荐入口时仍可浏览入口并通过搜索开始阅读', async () => {
    const onsearch = vi.fn();
    mounted = mount(QuickStart, { target:host, props:{ onsearch } });
    await tick();
    expect(host.textContent).toContain('暂时没有可推荐的函数');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('#/p/project%20a/entry');
    host.querySelector<HTMLButtonElement>('.search-step')!.click();
    expect(onsearch).toHaveBeenCalledOnce();
  });

  it('收起状态会保存，并可在同一会话重新打开', async () => {
    mounted = mount(QuickStart, { target:host, props:{ onsearch:vi.fn() } });
    await tick();
    host.querySelector<HTMLButtonElement>('.heading button')!.click();
    await tick();
    expect(host.querySelector('section')).toBeNull();
    expect(localStorage.getItem('codegraph.ui.quickStartDismissed')).toBe('1');
    guide.setDismissed(false);
    await tick();
    expect(host.querySelector('section')).not.toBeNull();
    expect(localStorage.getItem('codegraph.ui.quickStartDismissed')).toBe('0');
  });

  it('浏览器拒绝保存偏好时仍能收起引导', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('不可存储'); });
    mounted = mount(QuickStart, { target:host, props:{ onsearch:vi.fn() } });
    await tick();
    host.querySelector<HTMLButtonElement>('.heading button')!.click();
    await tick();
    expect(host.querySelector('section')).toBeNull();
  });
});

describe('按需帮助', () => {
  it('帮助窗口隔离页面快捷键，支持重新引导、关闭回调和焦点恢复', async () => {
    const opener = document.getElementById('opener')!;
    opener.focus();
    // jsdom 不实现原生模态窗口；浏览器验收另外覆盖 Esc 和焦点限制。
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable:true,
      value() { this.open = true; },
    });
    const onclose = vi.fn();
    const onstart = vi.fn();
    const pageKey = vi.fn();
    window.addEventListener('keydown', pageKey);
    try {
      mounted = mount(HelpDialog, { target:host, props:{ onclose, onstart, hasProject:false } });
      await tick();
      const dialog = host.querySelector('dialog')!;
      expect(dialog.open).toBe(true);
      expect(dialog.textContent).toContain('先在工作区选择一个可用项目');
      dialog.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key:'m', bubbles:true }));
      expect(pageKey).not.toHaveBeenCalled();
      host.querySelector<HTMLButtonElement>('.start button')!.click();
      expect(onstart).toHaveBeenCalledOnce();
      dialog.dispatchEvent(new Event('close'));
      expect(onclose).toHaveBeenCalledOnce();
      await unmount(mounted);
      mounted = undefined;
      expect(document.activeElement).toBe(opener);
    } finally {
      window.removeEventListener('keydown', pageKey);
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
  });

  it('图页说明随语言切换，图例默认折叠', async () => {
    mounted = mount(ViewHelp, { target:host, props:{ view:'steps' } });
    await tick();
    expect(host.textContent).toContain('看一个入口启动后会发生什么');
    expect(host.querySelector('details')!.open).toBe(false);
    i18n.setLocale('en');
    await tick();
    expect(host.textContent).toContain('See what an entry sets in motion');
    expect(host.textContent).not.toContain('如何阅读此图');
  });
});
