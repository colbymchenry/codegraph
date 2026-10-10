import { calculateRenderLayout } from './graph-layout-runner';
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ result: await calculateRenderLayout(data.kind, data.payload, data.options) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
