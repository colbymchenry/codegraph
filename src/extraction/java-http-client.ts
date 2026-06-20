import type { Language } from '../types';
import type { UnresolvedRef } from '../resolution/types';

export const JAVA_HTTP_CLIENT_REF_PREFIX = 'java-http-client:';

export interface JavaHttpClientCall {
  method: string;
  pathExpression: string;
}

/**
 * Extract outbound Java/Kotlin HTTP calls from one method-invocation subtree.
 *
 * This intentionally recognizes broad client shapes instead of one company
 * wrapper. A call like `RestClient.post(url)`, `restTemplate.postForObject(...)`,
 * `webClient.post().uri(...)`, `new HttpPost(...)`, or OkHttp
 * `.url(...).post(...)` all become the same logical POST + URL expression.
 */
export function extractJavaHttpClientCalls(callText: string): JavaHttpClientCall[] {
  const calls: JavaHttpClientCall[] = [];
  const seen = new Set<string>();

  const push = (method: string, expr: string | null | undefined) => {
    const pathExpression = cleanupExpression(expr ?? '');
    if (!pathExpression) return;
    const key = `${method}:${pathExpression}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ method, pathExpression });
  };

  const looksLikeOkHttpBuilder = /\.\s*url\s*\(/.test(callText) && /\.\s*post\s*\(/.test(callText);

  // Generic `.post(url)` / `post(url)` style clients. This covers custom
  // wrappers such as RestClient.post(...) as well as fluent request builders.
  // OkHttp is excluded here because its `.post(body)` argument is the request
  // body; the URL is handled by the dedicated `.url(...)` branch below.
  if (!looksLikeOkHttpBuilder) {
    for (const call of findCalls(callText, ['post'])) {
      const first = readArgument(callText, call.openParenIndex, 0);
      push('POST', first);
    }
  }

  // Spring RestTemplate convenience methods.
  for (const call of findCalls(callText, ['postForObject', 'postForEntity', 'postForLocation'])) {
    const first = readArgument(callText, call.openParenIndex, 0);
    push('POST', first);
  }

  // Methods that carry the HTTP verb as a separate argument.
  for (const call of findCalls(callText, ['exchange', 'execute'])) {
    const first = readArgument(callText, call.openParenIndex, 0);
    const second = readArgument(callText, call.openParenIndex, 1);
    if (isPostMethodExpression(second)) push('POST', first);
  }

  // Spring WebClient / RequestEntity: `.post().uri("/x")` or
  // `RequestEntity.post("/x")`.
  if (hasPostBuilder(callText)) {
    for (const call of findCalls(callText, ['uri'])) {
      const first = readArgument(callText, call.openParenIndex, 0);
      push('POST', first);
    }
  }

  // Java 11 HttpClient request builder: `.POST(bodyPublisher)` with the URL on
  // the surrounding `newBuilder(...)` call.
  if (/\.\s*POST\s*\(/.test(callText)) {
    for (const call of findCalls(callText, ['newBuilder'])) {
      const first = readArgument(callText, call.openParenIndex, 0);
      push('POST', first);
    }
  }

  // OkHttp style: `new Request.Builder().url(url).post(body).build()`.
  if (/\.\s*post\s*\(/.test(callText)) {
    for (const call of findCalls(callText, ['url'])) {
      const first = readArgument(callText, call.openParenIndex, 0);
      push('POST', first);
    }
  }

  // Apache HttpClient: `new HttpPost(url)`.
  for (const call of findConstructorCalls(callText, ['HttpPost'])) {
    const first = readArgument(callText, call.openParenIndex, 0);
    push('POST', first);
  }

  return calls;
}

export function isLikelyJavaHttpClientCallText(callText: string): boolean {
  return extractJavaHttpClientCalls(callText).length > 0;
}

export function encodeJavaHttpClientReference(method: string, pathExpression: string): string {
  return `${JAVA_HTTP_CLIENT_REF_PREFIX}${method.toUpperCase()}:${encodeURIComponent(pathExpression)}`;
}

export function parseJavaHttpClientReference(referenceName: string): JavaHttpClientCall | null {
  if (!referenceName.startsWith(JAVA_HTTP_CLIENT_REF_PREFIX)) return null;
  const rest = referenceName.slice(JAVA_HTTP_CLIENT_REF_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const method = rest.slice(0, colon).toUpperCase();
  const encoded = rest.slice(colon + 1);
  if (!method || !encoded) return null;
  try {
    return { method, pathExpression: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

export function makeJavaHttpClientRefs(
  callText: string,
  fromNodeId: string,
  line: number,
  column: number,
  filePath: string,
  language: Language,
): UnresolvedRef[] {
  if (language !== 'java' && language !== 'kotlin') return [];
  return extractJavaHttpClientCalls(callText).map((call) => ({
    fromNodeId,
    referenceName: encodeJavaHttpClientReference(call.method, call.pathExpression),
    referenceKind: 'calls',
    line,
    column,
    filePath,
    language,
  }));
}

interface FoundCall {
  name: string;
  openParenIndex: number;
}

function findCalls(text: string, names: string[]): FoundCall[] {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(^|[^\\w$])(${escaped})\\s*\\(`, 'g');
  const out: FoundCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[2]!;
    const openParenIndex = text.indexOf('(', m.index + m[1]!.length + name.length);
    if (openParenIndex >= 0) out.push({ name, openParenIndex });
  }
  return out;
}

function findConstructorCalls(text: string, names: string[]): FoundCall[] {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\bnew\\s+(${escaped})\\s*\\(`, 'g');
  const out: FoundCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    const openParenIndex = text.indexOf('(', m.index + m[0]!.lastIndexOf(name) + name.length);
    if (openParenIndex >= 0) out.push({ name, openParenIndex });
  }
  return out;
}

function readArgument(text: string, openParenIndex: number, argIndex: number): string | null {
  if (text[openParenIndex] !== '(') return null;
  let depth = 0;
  let quote: string | null = null;
  let start = openParenIndex + 1;
  let current = 0;

  for (let i = openParenIndex + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        return current === argIndex ? text.slice(start, i).trim() : null;
      }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      if (current === argIndex) return text.slice(start, i).trim();
      current++;
      start = i + 1;
    }
  }
  return null;
}

function cleanupExpression(expr: string): string {
  return expr
    .replace(/\s+/g, ' ')
    .replace(/^URI\.create\s*\((.*)\)$/s, '$1')
    .replace(/^java\.net\.URI\.create\s*\((.*)\)$/s, '$1')
    .trim();
}

function hasPostBuilder(text: string): boolean {
  return /(^|[^\w$])post\s*\(\s*\)/.test(text) || /\.\s*post\s*\(\s*\)/.test(text);
}

function isPostMethodExpression(expr: string | null): boolean {
  if (!expr) return false;
  return /\bPOST\b/.test(expr) || /HttpMethod\s*\.\s*POST/.test(expr) || /RequestMethod\s*\.\s*POST/.test(expr);
}
