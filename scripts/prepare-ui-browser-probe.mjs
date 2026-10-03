/** 生成仅用于本地浏览器验收的探针页面；不修改正式入口。先执行 npm run build。 */
import fs from 'node:fs';
import path from 'node:path';
const out = path.resolve('dist/viewer');
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
fs.writeFileSync(path.join(out, 'ui-perf.html'), html.replace('</body>', '<script src="./ui-perf.js"></script></body>'));
fs.writeFileSync(path.join(out, 'ui-perf.js'), `
(() => {
  const state = { userAgent: navigator.userAgent, firstInteractiveMs: null, events: [], frames: [], memory: [], resources: [], longTasks: [], eventTimings: [], longFrames: [], visibility: [] };
  const visibility = () => state.visibility.push({ start: performance.now(), state: document.visibilityState, focused: document.hasFocus() });
  visibility(); document.addEventListener('visibilitychange', visibility);
  window.addEventListener('focus', visibility); window.addEventListener('blur', visibility);
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, ms: entry.duration });
    state.longTasks = state.longTasks.slice(-200);
  }).observe({ type: 'longtask', buffered: true });
  if (PerformanceObserver.supportedEntryTypes.includes('event')) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.eventTimings.push({ type: entry.name, start: entry.startTime, ms: entry.duration, inputDelay: entry.processingStart-entry.startTime, processing: entry.processingEnd-entry.processingStart });
    state.eventTimings = state.eventTimings.slice(-200);
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longFrames.push({ start: entry.startTime, ms: entry.duration, renderStart: entry.renderStart, styleAndLayoutStart: entry.styleAndLayoutStart, scripts: entry.scripts.map(script => ({ ms: script.duration, invoker: script.invoker, sourceURL: script.sourceURL, sourceFunctionName: script.sourceFunctionName, sourceCharPosition: script.sourceCharPosition, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration })) });
    state.longFrames = state.longFrames.slice(-100);
  }).observe({ type: 'long-animation-frame', buffered: true });
  let activeUntil = 0, lastFrame = 0;
  const panel = document.createElement('details');
  panel.style.cssText = 'position:fixed;right:4px;bottom:4px;z-index:99999;background:#fff;color:#111;font:12px monospace;max-height:180px;overflow:auto;max-width:600px';
  const heading = document.createElement('summary'); heading.textContent = '浏览器验收记录'; panel.append(heading);
  const pre = document.createElement('pre'); pre.id = 'ui-perf-report'; panel.append(pre); document.body.append(panel);
  const percentile = values => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1] : null;
  function report() {
    state.resources = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).map(e => ({url:e.name,ms:e.duration}));
    pre.textContent = JSON.stringify({...state, eventP95Ms:percentile(state.events.map(e=>e.ms)), movingAverageFPS:state.frames.length ? 1000/(state.frames.reduce((a,b)=>a+b,0)/state.frames.length) : null},null,2);
  }
  function frame(now) {
    if (lastFrame && now < activeUntil) state.frames.push(now-lastFrame);
    lastFrame = now;
    if (state.firstInteractiveMs === null && (location.hash.includes('/map') ? document.querySelector('.svelte-flow__node') : document.querySelector('main h1,.overview h1')) && !document.querySelector('main')?.textContent.includes('正在加载工作区'))  { state.firstInteractiveMs = now; report(); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  for (const name of ['pointerup','click','input','change']) document.addEventListener(name, event => {
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => { state.events.push({type:name,start,ms:performance.now()-start,hash:location.hash}); report(); }));
  },true);
  for (const name of ['pointermove','wheel']) document.addEventListener(name, event => { if (name === 'wheel' || event.buttons) activeUntil = performance.now()+100; },{passive:true});
  setInterval(() => { if (performance.memory) state.memory.push({ms:performance.now(),heap:performance.memory.usedJSHeapSize,hash:location.hash}); if (state.memory.length>200) state.memory.shift(); report(); },1000);
})();
`);
console.log('探针已生成，打开本地服务的 /ui-perf.html。指标写入 #ui-perf-report；仅探针页启用。');
