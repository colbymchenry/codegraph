import { describe, expect, it } from 'vitest';
import { createProjectNavigation } from '../ui/src/lib/navigation';
describe('项目作用域链接', () => {
  it('保留不透明节点 ID 和查询条件', () => {
    const nav = createProjectNavigation('project /甲');
    expect(nav.symbolHref('function:src/a.ts', { line: 9 })).toBe('#/p/project%20%2F%E7%94%B2/s/function%3Asrc/a.ts?hl=9');
    expect(nav.mapHref()).toBe('#/p/project%20%2F%E7%94%B2/map');
  });
});

import { createHttpAdapter } from '../ui/src/lib/adapter';
it('项目请求使用自己的 API 前缀和取消信号', async () => {
  const controller = new AbortController();
  let observed: RequestInit | undefined;
  let url = '';
  const adapter = createHttpAdapter({
    apiBase: '/api/projects/alpha', signal: controller.signal,
    fetch: (async (input, init) => { url = String(input); observed = init; return new Response(JSON.stringify({})); }) as typeof fetch,
  });
  await adapter.node('function:abc');
  expect(url).toBe('/api/projects/alpha/node/function%3Aabc');
  expect(observed?.signal?.aborted).toBe(false);
  controller.abort();
  expect(observed?.signal?.aborted).toBe(true);
});
