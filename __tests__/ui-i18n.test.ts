import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function svelteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? svelteFiles(path) : path.endsWith('.svelte') ? [path] : [];
  }));
  return nested.flat();
}

describe('Web UI i18n', () => {
  let storage: Storage;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
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
        values.set(key, value);
      },
    };
    vi.stubGlobal('localStorage', storage);
  });

  it('默认以中文显示固定文案', async () => {
    const { i18n } = await import('../ui/src/lib/i18n.svelte');

    expect(i18n.locale).toBe('zh-CN');
    expect(i18n.t('nav.map')).toBe('地图');
  });

  it('读取已保存的英文偏好', async () => {
    storage.setItem('codegraph.ui.locale', 'en');

    const { i18n } = await import('../ui/src/lib/i18n.svelte');

    expect(i18n.locale).toBe('en');
    expect(i18n.t('nav.map')).toBe('Map');
  });

  it('切换语言后更新翻译并保存偏好', async () => {
    const { i18n } = await import('../ui/src/lib/i18n.svelte');

    i18n.setLocale('en');

    expect(i18n.t('outline.showing', { shown: 2, total: 5 })).toBe('Showing 2 of 5 symbols.');
    expect(storage.getItem('codegraph.ui.locale')).toBe('en');
  });

  it('保存偏好失败时仍切换当前会话语言', async () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const { i18n } = await import('../ui/src/lib/i18n.svelte');

    i18n.setLocale('en');

    expect(i18n.locale).toBe('en');
    expect(i18n.t('nav.map')).toBe('Map');
  });

  it('为中文界面翻译嵌入模板的固定文案', async () => {
    const { translateVisibleText } = await import('../ui/src/lib/i18n.svelte');

    expect(translateVisibleText('Nothing selected', 'zh-CN')).toBe('未选择任何内容');
    expect(translateVisibleText('Nothing selected', 'en')).toBe('Nothing selected');
    expect(translateVisibleText('13 symbols · 46 edges · 593 files indexed', 'zh-CN')).toBe(
      '13 个符号 · 46 条边 · 已索引 593 个文件'
    );
  });

  it('提供搜索与步骤空状态的中文文案', async () => {
    const { i18n } = await import('../ui/src/lib/i18n.svelte');

    expect(i18n.t('search.placeholder')).toBe('搜索符号或文件，或询问“execute 如何到达 getFile”——按 / 聚焦');
    expect(i18n.t('steps.pickScreen')).toContain('选择一个界面');
    expect(i18n.t('steps.noTargets')).toContain('此图谱中没有界面或端点');
  });

  it('翻译带换行、插值边界和内联标签的固定短语', async () => {
    const { translateVisibleText } = await import('../ui/src/lib/i18n.svelte');

    expect(translateVisibleText('\n  Search for a symbol or a file to start reading in ', 'zh-CN')).toBe(
      '\n  搜索符号或文件，开始阅读 '
    );
    expect(translateVisibleText(' — every list below is read out of the graph, not guessed from a filename.', 'zh-CN')).toBe(
      '——下面的每个列表都直接读取自图谱，而非根据文件名猜测。'
    );
    expect(translateVisibleText(' — every list below is read out of the\n  graph, not guessed from a filename.', 'zh-CN')).toBe(
      '——下面的每个列表都直接读取自图谱，而非根据文件名猜测。'
    );
  });

  it('通过插值生成首页和入口点的完整中文句子', async () => {
    const { i18n } = await import('../ui/src/lib/i18n.svelte');

    expect(i18n.t('home.startReading', { project: 'weixin-work' })).toBe(
      '在 weixin-work 中搜索符号或文件以开始阅读。按'
    );
    expect(i18n.t('entry.intro', { project: 'weixin-work' })).toContain('调用流从 weixin-work 开始');
  });

  it('翻译模型生成的数量摘要', async () => {
    const { translateVisibleText } = await import('../ui/src/lib/i18n.svelte');

    expect(translateVisibleText('2 symbols in 1 file · 10 lines', 'zh-CN')).toBe('2 个符号，位于 1 个文件 · 10 行');
    expect(translateVisibleText('3 calls stay within this file', 'zh-CN')).toBe('3 个调用保留在此文件内');
  });

  it('本地化操作不会修改源代码文本', async () => {
    const { localize } = await import('../ui/src/lib/i18n.svelte');
    const root = document.createElement('main');
    root.innerHTML = '<div class="code"><span>Flow</span></div><h1>Flow</h1><p>Flow</p>';
    document.body.append(root);

    const action = localize(root);

    expect(root.querySelector('.code')?.textContent).toBe('Flow');
    expect(root.querySelector('h1')?.textContent).toBe('Flow');
    expect(root.querySelector('p')?.textContent).toBe('调用流');
    action.destroy();
    root.remove();
  });

  it('完整翻译二级页面的固定说明和本地提示', async () => {
    const { translateVisibleText } = await import('../ui/src/lib/i18n.svelte');
    const cases: Array<[string, string]> = [
      ['Saved trails', '已保存路径'],
      [
        'Nothing in the index reaches into this file. It is either an entry point, or nothing depends on it yet.',
        '索引中没有内容进入此文件。它可能是入口点，或尚未被任何内容依赖。',
      ],
      [
        'This file reaches nothing else in the index — it depends on nothing the graph holds.',
        '此文件未到达索引中的其他内容——它不依赖图谱中的任何内容。',
      ],
      ['The codegraph ui server is not answering.', 'CodeGraph UI 服务器未响应。'],
      ['Where the picture starts; each row down is one more step away', '图示的起点；每向下一行就多经过一个步骤'],
      ['Widget chooses its next call at runtime.', 'Widget 在运行时选择下一个调用。'],
      [
        'Every one of the 12 symbols with no incoming reference has a reason to be reachable anyway — see the list of exclusions below.',
        '没有入向引用的 12 个符号均有其他可达理由——请查看下方的排除列表。',
      ],
    ];

    for (const [source, target] of cases) {
      expect(translateVisibleText(source, 'zh-CN')).toBe(target);
    }
  });

  it('所有页面模板中的可见英文短语都有中文翻译', async () => {
    const { translateVisibleText } = await import('../ui/src/lib/i18n.svelte');
    const failures: string[] = [];
    for (const file of await svelteFiles('ui/src')) {
      const source = await readFile(file, 'utf8');
      const markup = source.slice(source.lastIndexOf('</script>') + 9).split('<style>')[0] ?? '';
      const candidates = [
        ...[...markup.matchAll(/>([^<{]*[A-Za-z][^<{]*)</g)].map((match) => match[1]),
        ...[
          ...markup.matchAll(/(?:aria-label|placeholder|title|emptyNote|note|caption|detail|hint)="([^"]*[A-Za-z][^"]*)"/g),
        ].map((match) => match[1]),
      ];
      for (const raw of candidates) {
        const text = raw.replace(/\s+/g, ' ').trim();
        if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text)) continue;
        if (/=>|===|\?\.|\.length|\.id|\.name|onclick|onhover|onToggle|class:/.test(text)) continue;
        const translated = translateVisibleText(text, 'zh-CN');
        if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(translated)) failures.push(`${file}: ${translated}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('增量本地化', () => {
  it('新增单个结果不重新读取已有400个图节点', async () => {
    const { i18n, localize } = await import('../ui/src/lib/i18n.svelte');
    i18n.setLocale('zh-CN');
    const root = document.createElement('main');
    root.innerHTML = Array.from({ length: 400 }, () => '<div title="Flow"><span>Flow</span></div>').join('');
    document.body.append(root);
    const action = localize(root);
    await new Promise(resolve => setTimeout(resolve, 0));
    const readExisting = vi.spyOn(root.firstElementChild!, 'getAttribute');
    const result = document.createElement('p'); result.textContent = 'Searching…';
    root.append(result);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(result.textContent).toBe('正在搜索…');
    expect(readExisting).not.toHaveBeenCalled();
    action.destroy(); root.remove(); readExisting.mockRestore();
  });

  it('动态计数和属性采用最新原文，并能往返切换语言', async () => {
    const { i18n, localize } = await import('../ui/src/lib/i18n.svelte');
    i18n.setLocale('zh-CN');
    const root = document.createElement('main');
    root.innerHTML = '<p title="Flow">2 symbols in 1 file · 10 lines</p><code>Flow</code>';
    document.body.append(root);
    const action = localize(root);
    const text = root.querySelector('p')!.firstChild as Text;
    text.data = '3 symbols in 2 files · 11 lines';
    root.querySelector('p')!.setAttribute('title', 'Search results');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text.data).toBe('3 个符号，位于 2 个文件 · 11 行');
    expect(root.querySelector('p')!.title).toBe('搜索结果');
    i18n.setLocale('en');
    expect(text.data).toBe('3 symbols in 2 files · 11 lines');
    expect(root.querySelector('p')!.title).toBe('Search results');
    i18n.setLocale('zh-CN');
    expect(text.data).toBe('3 个符号，位于 2 个文件 · 11 行');
    expect(root.querySelector('code')!.textContent).toBe('Flow');
    action.destroy(); root.remove();
  });
});
