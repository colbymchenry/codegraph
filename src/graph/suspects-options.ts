/** Shared scalar option validation for the CLI and MCP suspect reports. */
export function parseSuspectCount(value: unknown, allowAll: boolean, minimum: number): number | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    if (allowAll && text.toLowerCase() === 'all') return undefined;
    if (!/^\d+$/.test(text)) throw new Error('Expected an integer.');
    value = Number(text);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error('Expected an integer within the supported range.');
  }
  return value;
}
