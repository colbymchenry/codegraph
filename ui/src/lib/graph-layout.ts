import { calculateRenderLayout } from './graph-layout-runner';
export function requestLayout<T>(kind: 'map' | 'map-compact' | 'steps' | 'screens' | 'flow' | 'scene-routes' | 'relationships', payload: unknown, options: unknown, done: (result: T) => void, fail: (error: string) => void): () => void {
  if (typeof Worker === 'undefined') {
    // 嵌入式宿主与测试环境没有 Worker，输入仍由调用方先做预算检查。
    let active = true;
    void calculateRenderLayout(kind, payload, options as Record<string, unknown>).then(result => { if (active) done(result as T); }, error => { if (active) fail(String(error)); });
    return () => { active = false; };
  }
  const worker = new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' });
  let active = true;
  worker.onmessage = ({ data }) => {
    if (!active) return;
    if (data.error) fail(data.error);
    else done(data.result as T);
    worker.terminate();
  };
  worker.onerror = (event) => { if (active) fail(event.message || '布局计算失败'); worker.terminate(); };
  worker.postMessage({ kind, payload, options });
  return () => { active = false; worker.terminate(); };
}
