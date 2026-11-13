const MAX_REASON_LENGTH = 160;

export function failure(operation: string, status?: number, reason?: string): Error {
  return new Error(
    `external runtime: provider e2b ${operation} failed${status === undefined ? '' : ` with status ${String(status)}`}${reason === undefined ? '' : `: ${reason}`}.`,
  );
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

export function sanitizedReason(body: unknown, secrets: readonly string[]): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as Record<string, unknown>)['message'];
  if (typeof message !== 'string') return undefined;
  let text = message;
  for (const secret of secrets) if (secret.length > 0) text = text.split(secret).join('[redacted]');
  text = text.replace(/e2b_[A-Za-z0-9_]+/gu, '[redacted]');
  text = Array.from(text, (char) => (isControl(char) ? ' ' : char))
    .join('')
    .trim();
  if (text.length > MAX_REASON_LENGTH) text = `${text.slice(0, MAX_REASON_LENGTH)}...`;
  return text.length === 0 ? undefined : text;
}

async function reasonOf(
  response: Response,
  secrets: readonly string[],
): Promise<string | undefined> {
  try {
    return sanitizedReason(JSON.parse(await response.text()) as unknown, secrets);
  } catch {
    return undefined;
  }
}

export async function rejected(
  operation: string,
  response: Response,
  secrets: readonly string[],
): Promise<Error> {
  const reason = await reasonOf(response, secrets);
  // A create answered 429 is the account's concurrent-sandbox cap: say so, so an operator reads a
  // full account and not a bad request. It is never retried here; waiting cannot free a leak.
  return failure(
    operation,
    response.status,
    operation === 'create' && response.status === 429
      ? `the provider's concurrency limit was reached${reason === undefined ? '' : ` (${reason.replace(/\.$/u, '')})`}`
      : reason,
  );
}

export async function json(operation: string, response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw failure(operation);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
