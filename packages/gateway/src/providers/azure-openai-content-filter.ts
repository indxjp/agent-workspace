function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The operator-facing reason Azure's content filter blocked a response. */
function contentFilterExplanation(value: unknown): string {
  const outer = object(value);
  const error = object(outer['error']);
  if (typeof error['message'] === 'string') return error['message'];
  const filters = Array.isArray(outer['content_filters']) ? outer['content_filters'] : [];
  return filters.length > 0
    ? `Azure content filter blocked this response: ${JSON.stringify(filters)}`
    : 'Azure content filter blocked this response.';
}

function isContentFilterBlock(status: number, value: unknown): boolean {
  const outer = object(value);
  const error = object(outer['error']);
  if (status === 400 && error['code'] === 'content_filter') return true;
  return (
    Array.isArray(outer['content_filters']) &&
    outer['content_filters'].some((entry) => object(entry)['blocked'] === true)
  );
}

/**
 * An Anthropic `refusal` message when Azure's content filter blocked the answer, otherwise
 * `undefined` so the caller carries on with the ordinary response.
 */
export function contentFilterRefusal(
  status: number,
  value: unknown,
  model: string,
  requestId: string,
): Response | undefined {
  if (!isContentFilterBlock(status, value)) return undefined;
  return Response.json({
    id: requestId,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: 'refusal',
    stop_sequence: null,
    stop_details: {
      type: 'refusal',
      category: null,
      explanation: contentFilterExplanation(value),
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}
