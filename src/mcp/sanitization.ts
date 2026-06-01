import * as path from 'path';

export interface SanitizableToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface SanitizationResult {
  text: string;
  replacements: number;
}

type SanitizerHook = (text: string) => string | Promise<string>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const REDACTED_PHONE = '[REDACTED_PHONE]';
const REDACTED_SSN = '[REDACTED_SSN]';
const REDACTED_CREDIT_CARD = '[REDACTED_CREDIT_CARD]';
const REDACTED_API_KEY = '[REDACTED_API_KEY]';

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]?){13,19}\b/g;
const OPENAI_KEY_REGEX = /\bsk-[A-Za-z0-9]{20,}\b/g;
const AWS_KEY_REGEX = /\bAKIA[0-9A-Z]{16}\b/g;

let cachedHookSpec: string | null = null;
let cachedHook: SanitizerHook | null = null;
let hookLoadErrorLogged = false;
let hookRuntimeErrorLogged = false;

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

function sanitizeHookSpec(): string | null {
  const raw = process.env.CODEGRAPH_SANITIZE_HOOK?.trim();
  return raw ? raw : null;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i] ?? '0');
    if (doubleDigit) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function shouldRedactPhone(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function replaceWithCount(
  input: string,
  regex: RegExp,
  replacement: string,
  predicate?: (match: string) => boolean,
): SanitizationResult {
  let replacements = 0;
  const text = input.replace(regex, (match) => {
    if (predicate && !predicate(match)) {
      return match;
    }
    replacements++;
    return replacement;
  });
  return { text, replacements };
}

export function builtInSanitizationEnabled(): boolean {
  return isTruthy(process.env.CODEGRAPH_SANITIZE);
}

export function sanitizeText(text: string): SanitizationResult {
  let output = text;
  let replacements = 0;
  const email = replaceWithCount(output, EMAIL_REGEX, REDACTED_EMAIL);
  output = email.text;
  replacements += email.replacements;

  const ssn = replaceWithCount(output, SSN_REGEX, REDACTED_SSN);
  output = ssn.text;
  replacements += ssn.replacements;

  const phone = replaceWithCount(output, PHONE_REGEX, REDACTED_PHONE, shouldRedactPhone);
  output = phone.text;
  replacements += phone.replacements;

  const card = replaceWithCount(output, CREDIT_CARD_REGEX, REDACTED_CREDIT_CARD, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
  output = card.text;
  replacements += card.replacements;

  const openAiKey = replaceWithCount(output, OPENAI_KEY_REGEX, REDACTED_API_KEY);
  output = openAiKey.text;
  replacements += openAiKey.replacements;

  const awsKey = replaceWithCount(output, AWS_KEY_REGEX, REDACTED_API_KEY);
  output = awsKey.text;
  replacements += awsKey.replacements;

  return { text: output, replacements };
}

function loadSanitizeHook(): SanitizerHook | null {
  const spec = sanitizeHookSpec();
  if (spec === cachedHookSpec) {
    return cachedHook;
  }

  cachedHookSpec = spec;
  cachedHook = null;
  hookLoadErrorLogged = false;
  hookRuntimeErrorLogged = false;

  if (!spec) return null;

  try {
    const resolved = path.isAbsolute(spec) ? spec : path.resolve(spec);
    const loaded = require(resolved) as unknown;
    const candidate =
      typeof loaded === 'function'
        ? loaded
        : (loaded as { default?: unknown; sanitize?: unknown })?.default ??
          (loaded as { sanitize?: unknown })?.sanitize;
    if (typeof candidate !== 'function') {
      throw new Error('module must export a function (default export or named "sanitize")');
    }
    cachedHook = candidate as SanitizerHook;
  } catch (err) {
    if (!hookLoadErrorLogged) {
      hookLoadErrorLogged = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Failed to load CODEGRAPH_SANITIZE_HOOK: ${msg}\n`);
    }
    cachedHook = null;
  }

  return cachedHook;
}

export async function sanitizeToolResult(result: SanitizableToolResult): Promise<SanitizableToolResult> {
  const useBuiltIn = builtInSanitizationEnabled();
  const hook = loadSanitizeHook();
  if (!useBuiltIn && !hook) return result;

  let changed = false;
  const content: Array<{ type: 'text'; text: string }> = [];

  for (const block of result.content) {
    let text = block.text;

    if (useBuiltIn) {
      const sanitized = sanitizeText(text);
      if (sanitized.replacements > 0) changed = true;
      text = sanitized.text;
    }

    if (hook) {
      try {
        const hooked = await Promise.resolve(hook(text));
        if (typeof hooked === 'string') {
          if (hooked !== text) changed = true;
          text = hooked;
        }
      } catch (err) {
        if (!hookRuntimeErrorLogged) {
          hookRuntimeErrorLogged = true;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[CodeGraph MCP] CODEGRAPH_SANITIZE_HOOK execution failed: ${msg}\n`);
        }
      }
    }

    content.push(text === block.text ? block : { ...block, text });
  }

  if (!changed) return result;
  return { ...result, content };
}
