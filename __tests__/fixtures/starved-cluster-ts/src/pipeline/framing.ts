import type { PipelineRequest } from './types';

export function encodeFrame(request: PipelineRequest): Uint8Array {
  const head = `${request.method} ${request.path}\n`;
  const headers = Object.entries(request.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  const text = `${head}${headers}\n\n`;
  const body = request.body ?? new Uint8Array();
  const out = new Uint8Array(text.length + body.length);
  out.set(new TextEncoder().encode(text), 0);
  out.set(body, text.length);
  return out;
}

export function decodeFrame(raw: Uint8Array): { status: number; headers: Record<string, string>; body: Uint8Array } {
  const text = new TextDecoder().decode(raw);
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const lines = head.split('\n');
  const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '0', 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(': ');
    if (at > 0) headers[line.slice(0, at)] = line.slice(at + 2);
  }
  return { status, headers, body: raw.slice(split < 0 ? raw.length : split + 2) };
}
