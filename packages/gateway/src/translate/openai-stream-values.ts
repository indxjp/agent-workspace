export type OpenAIEvent = Record<string, unknown>;

export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function responseContainsFunctionCall(response: Record<string, unknown>): boolean {
  return (
    Array.isArray(response['output']) &&
    response['output'].some((item) => record(item)['type'] === 'function_call')
  );
}

/** OpenAI's input_tokens include the cached prefix; Anthropic's exclude it (priced additively). */
export function streamUsage(usage: Record<string, unknown>): Record<string, number> {
  const cached = Number(record(usage['input_tokens_details'])['cached_tokens'] ?? 0);
  return {
    input_tokens: Math.max(0, Number(usage['input_tokens'] ?? 0) - cached),
    output_tokens: Number(usage['output_tokens'] ?? 0),
    cache_read_input_tokens: cached,
  };
}
