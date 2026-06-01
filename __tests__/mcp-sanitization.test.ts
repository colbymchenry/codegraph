import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolHandler } from '../src/mcp/tools';
import { sanitizeText } from '../src/mcp/sanitization';

const ENV_SANITIZE = 'CODEGRAPH_SANITIZE';
const ENV_HOOK = 'CODEGRAPH_SANITIZE_HOOK';
const ORIGINAL_SANITIZE = process.env[ENV_SANITIZE];
const ORIGINAL_HOOK = process.env[ENV_HOOK];

afterEach(() => {
  if (ORIGINAL_SANITIZE === undefined) delete process.env[ENV_SANITIZE];
  else process.env[ENV_SANITIZE] = ORIGINAL_SANITIZE;
  if (ORIGINAL_HOOK === undefined) delete process.env[ENV_HOOK];
  else process.env[ENV_HOOK] = ORIGINAL_HOOK;
});

describe('MCP sanitization', () => {
  it('redacts common PII/secrets with built-in sanitizer', () => {
    const input = [
      'Contact: jane.doe@example.com',
      'Phone: +1 (415) 555-2671',
      'SSN: 123-45-6789',
      'Card: 4111 1111 1111 1111',
      'OpenAI key: sk-abcdefghijklmnopqrstuvwxyzABCDE12345',
      'AWS key: AKIA1234567890ABCDEF',
    ].join('\n');
    const out = sanitizeText(input);

    expect(out.replacements).toBeGreaterThanOrEqual(6);
    expect(out.text).toContain('[REDACTED_EMAIL]');
    expect(out.text).toContain('[REDACTED_PHONE]');
    expect(out.text).toContain('[REDACTED_SSN]');
    expect(out.text).toContain('[REDACTED_CREDIT_CARD]');
    expect(out.text).toContain('[REDACTED_API_KEY]');
    expect(out.text).not.toContain('jane.doe@example.com');
  });

  it('applies built-in sanitization to MCP tool responses when CODEGRAPH_SANITIZE=1', async () => {
    process.env[ENV_SANITIZE] = '1';
    delete process.env[ENV_HOOK];
    const handler = new ToolHandler({
      buildContext: async () => 'User email alice@example.com',
    } as any);

    const result = await handler.execute('codegraph_context', { task: 'summarize auth' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('[REDACTED_EMAIL]');
    expect(result.content[0]?.text).not.toContain('alice@example.com');
  });

  it('leaves tool output unchanged when built-in sanitization is disabled', async () => {
    delete process.env[ENV_SANITIZE];
    delete process.env[ENV_HOOK];
    const handler = new ToolHandler({
      buildContext: async () => 'User email bob@example.com',
    } as any);

    const result = await handler.execute('codegraph_context', { task: 'summarize auth' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('bob@example.com');
  });

  it('applies a custom sanitize hook from CODEGRAPH_SANITIZE_HOOK', async () => {
    delete process.env[ENV_SANITIZE];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sanitize-hook-'));
    const hookPath = path.join(tmp, 'hook.cjs');
    fs.writeFileSync(
      hookPath,
      'module.exports = (text) => text.replace(/customer_id:\\s*\\d+/g, "customer_id: [REDACTED_CUSTOMER_ID]");\n',
      'utf-8'
    );
    process.env[ENV_HOOK] = hookPath;

    try {
      const handler = new ToolHandler({
        buildContext: async () => 'payload customer_id: 42',
      } as any);
      const result = await handler.execute('codegraph_context', { task: 'inspect payload' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain('[REDACTED_CUSTOMER_ID]');
      expect(result.content[0]?.text).not.toContain('customer_id: 42');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
