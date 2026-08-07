import { describe, expect, it } from 'vitest';
import {
  STDIO_PROTOCOL_VERSION,
  STREAMABLE_HTTP_PROTOCOL_VERSION,
  SUPPORTED_STREAMABLE_HTTP_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
} from '../src/mcp/session';

describe('MCP protocol version negotiation', () => {
  it('defaults stdio sessions to the legacy protocol version', () => {
    expect(negotiateProtocolVersion(undefined)).toBe(STDIO_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion('2025-11-25')).toBe(STDIO_PROTOCOL_VERSION);
  });

  it('negotiates a supported newer protocol version for stdio', () => {
    expect(negotiateProtocolVersion(STREAMABLE_HTTP_PROTOCOL_VERSION)).toBe(STREAMABLE_HTTP_PROTOCOL_VERSION);
  });

  it('uses the Streamable HTTP protocol version for HTTP sessions', () => {
    expect(
      negotiateProtocolVersion(
        '2024-11-05',
        STREAMABLE_HTTP_PROTOCOL_VERSION,
        SUPPORTED_STREAMABLE_HTTP_PROTOCOL_VERSIONS,
      ),
    ).toBe(STREAMABLE_HTTP_PROTOCOL_VERSION);
  });
});
