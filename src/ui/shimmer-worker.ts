import { parentPort, workerData } from 'worker_threads';
import { writeSync } from 'fs';
import type { ShimmerWorkerMessage } from './types';

// Write directly to fd 1 (stdout) instead of writeStdout().
// In Node.js worker threads, process.stdout is proxied through the main
// thread's event loop — so if the main thread is blocked (e.g. SQLite),
// stdout writes from the worker queue up and the animation freezes.
// fs.writeSync(1, ...) is a direct kernel syscall that bypasses this.
function writeStdout(s: string): void {
  writeSync(1, s);
}

const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽'];
const ANIM_INTERVAL = 150;
const FRAMES_PER_GLYPH = 3;

const RST = '\x1b[0m';
const DM = '\x1b[2m';
const GRN = '\x1b[32m';
const BOLD = '\x1b[1m';

const startTime: number = workerData.startTime;

function animFrame(): number {
  return Math.floor((Date.now() - startTime) / ANIM_INTERVAL);
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function shimmerColor(frame: number): string {
  const t = (Math.sin(frame * 2 * Math.PI / 13) + 1) / 2;
  const r = lerp(160, 251, t);
  const g = lerp(100, 191, t);
  const b = lerp(9, 36, t);
  return `\x1b[38;2;${r};${g};${b}m${BOLD}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function renderBar(frame: number, filled: number, empty: number): string {
  if (filled === 0) return `${DM}${'░'.repeat(empty)}${RST}`;
  const cycleFrames = 24;
  const shimmerPos = ((frame % cycleFrames) / cycleFrames) * (filled + 6) - 3;
  const shimmerWidth = 3;
  let bar = '';
  for (let i = 0; i < filled; i++) {
    const dist = Math.abs(i - shimmerPos);
    const t = Math.max(0, 1 - dist / shimmerWidth);
    const r = lerp(160, 251, t);
    const g = lerp(100, 191, t);
    const b = lerp(9, 36, t);
    bar += `\x1b[38;2;${r};${g};${b}m${BOLD}█`;
  }
  bar += `${RST}${DM}${'░'.repeat(empty)}${RST}`;
  return bar;
}

// Mutable state
let currentMessage = '';
let currentPercent = -1;
let currentCount = 0;

function render(): void {
  if (!currentMessage) return;
  const frame = animFrame();
  const glyphIdx = Math.floor(frame / FRAMES_PER_GLYPH) % SPINNER_GLYPHS.length;
  const glyph = SPINNER_GLYPHS[glyphIdx] ?? '·';
  const color = shimmerColor(frame);

  let line: string;
  if (currentPercent >= 0) {
    const barWidth = 25;
    const filled = Math.round(barWidth * currentPercent / 100);
    const empty = barWidth - filled;
    line = `${DM}│${RST}  ${color}${glyph}${RST} ${currentMessage}  ${renderBar(frame, filled, empty)}  ${currentPercent}%`;
  } else if (currentCount > 0) {
    line = `${DM}│${RST}  ${color}${glyph}${RST} ${currentMessage}... ${formatNumber(currentCount)} found`;
  } else {
    line = `${DM}│${RST}  ${color}${glyph}${RST} ${currentMessage}...`;
  }

  writeStdout(`\r\x1b[K${line}`);
}

function finishPhase(): void {
  if (!currentMessage) return;
  writeStdout(`\r\x1b[K`);
  let detail = '';
  if (currentPercent >= 0) detail = ' — done';
  else if (currentCount > 0) detail = ` — ${formatNumber(currentCount)} found`;
  writeStdout(`${DM}│${RST}  ${GRN}◆${RST} ${currentMessage}${detail}\n`);
  currentMessage = '';
  currentPercent = -1;
  currentCount = 0;
}

// Render loop — independent of main thread
const tickInterval = setInterval(render, 50);

parentPort!.on('message', (msg: ShimmerWorkerMessage) => {
  if (msg.type === 'update') {
    currentMessage = msg.phaseName;
    currentPercent = msg.percent;
    currentCount = msg.count;
  } else if (msg.type === 'finish-phase') {
    finishPhase();
  } else if (msg.type === 'stop') {
    clearInterval(tickInterval);
    finishPhase();
    parentPort!.postMessage({ type: 'stopped' });
  }
});
