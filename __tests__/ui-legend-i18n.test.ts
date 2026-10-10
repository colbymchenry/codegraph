import { describe, it, expect } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import MapKey from '../ui/src/components/map/MapKey.svelte';
import StepsKey from '../ui/src/components/steps/StepsKey.svelte';
import { i18n, localize } from '../ui/src/lib/i18n.svelte';

const cases = [
  {
    name: 'Map legend',
    render: (target: HTMLElement) => mount(MapKey, {
      target,
      props: { minWeight: 2, thinCount: 1, declaredBasis: true, open: true, onToggle() {} },
    }),
    english: [
      'A module — one directory, with the symbols and files in it',
      'The bar along the bottom is how much leans on it — files elsewhere that reference straight into it, against the most depended-on box here. The count is on the box',
      'Points back up — the lighter half of a mutual dependency, or a link with no import or declared type behind it. Drawn only while a module it touches is selected',
      'A module sits one layer above everything it depends on, so entry points end up at the top and the foundations — which depend on nothing below — at the bottom',
      'Selected: click a module to bring out its links and list its files; everything more than one hop away fades',
      'No link in the index arrives here — a script, a workflow, an unreferenced corner',
      'More than half its files are tests; off unless you turn tests on',
      'Every file in it is tool-generated — nobody wrote it and nobody edits it',
    ],
    chinese: [
      '模块——一个目录及其中的符号和文件',
      '底部横条表示依赖程度：其他位置直接引用该模块的文件数，相对于当前被依赖最多的模块。数量显示在方框上',
      '向上返回——相互依赖中较轻的一侧，或没有导入或声明类型依据的连接。仅在选中其关联模块时绘制',
      '模块位于其所有依赖的上一层，因此入口点在顶部，不依赖更下层模块的基础部分在底部',
      '选中：点击模块以突出显示其连接并列出文件；距离超过一跳的内容会淡化',
      '索引中没有连接到达这里——可能是脚本、工作流或未被引用的部分',
      '超过一半的文件是测试；只有开启测试显示后才可见',
      '其中每个文件均由工具生成，并非人工编写或编辑',
    ],
  },
  {
    name: 'Steps legend',
    render: (target: HTMLElement) => mount(StepsKey, {
      target,
      props: { project: 'web', order: false, flow: false, open: true, onToggle() {} },
    }),
    english: [
      'What a box leads to, or what reaches it (←), when the two are too far apart for a line to be followed — said in words under the box rather than drawn across the picture. Select the box and every one of its real lines draws',
    ],
    chinese: [
      '当两个方框距离太远、连线难以跟随时，在方框下方用文字说明它通向哪里，或谁到达它（←），而非横跨图形绘线。选中方框后会显示它的全部真实连线',
    ],
  },
];

describe('Complete bilingual graph legends', () => {
  for (const sample of cases) {
    it(`${sample.name} switches all restored descriptions zh-CN → en → zh-CN`, async () => {
      i18n.setLocale('zh-CN');
      const host = document.createElement('div');
      document.body.append(host);
      const instance = sample.render(host);
      const localization = localize(host);
      const content = () => (host.textContent ?? '').replace(/\s+/g, ' ').trim();
      try {
        await tick();
        for (const text of sample.chinese) expect(content()).toContain(text);
        for (const text of sample.english) expect(content()).not.toContain(text);
        i18n.setLocale('en');
        await tick();
        for (const text of sample.english) expect(content()).toContain(text);
        for (const text of sample.chinese) expect(content()).not.toContain(text);
        i18n.setLocale('zh-CN');
        await tick();
        for (const text of sample.chinese) expect(content()).toContain(text);
        for (const text of sample.english) expect(content()).not.toContain(text);
      } finally {
        localization.destroy();
        await unmount(instance);
        host.remove();
        i18n.setLocale('zh-CN');
      }
    });
  }
});
