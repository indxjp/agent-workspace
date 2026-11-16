export function failure(operation: string, status?: number, detail?: string): Error {
  return new Error(
    `vercel-sandbox runtime: provider vercel ${operation} failed${status === undefined ? '' : ` with status ${String(status)}`}${detail === undefined ? '' : ` (${detail})`}.`,
  );
}

const DETAIL_MAX_BYTES = 4_096;

const DETAIL_REASON_MAX = 160;

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

async function providerDetail(response: Response, token: string): Promise<string | undefined> {
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < DETAIL_MAX_BYTES) {
      const next = await reader.read();
      const value: unknown = next.value;
      if (next.done || !(value instanceof Uint8Array)) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel();
    const error = asRecord(
      asRecord(
        JSON.parse(
          new TextDecoder().decode(Buffer.concat(chunks).subarray(0, DETAIL_MAX_BYTES)),
        ) as unknown,
      )['error'],
    );
    return sanitizedDetail(error, token);
  } catch {
    return undefined;
  }
}

export async function failed(operation: string, response: Response, token: string): Promise<Error> {
  return failure(operation, response.status, await providerDetail(response, token));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizedDetail(error: Record<string, unknown>, token: string): string | undefined {
  const code = error['code'];
  const message = error['message'];
  const reason =
    typeof message === 'string'
      ? message
          .split(token)
          .join('[redacted]')
          .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
          .replace(/[A-Za-z0-9_~+=-]{20,}/gu, '[redacted]')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, DETAIL_REASON_MAX)
      : '';
  const codePart = typeof code === 'string' && ERROR_CODE.test(code) ? `code ${code}` : '';
  if (codePart === '') return reason === '' ? undefined : reason;
  return reason === '' ? codePart : `${codePart}: ${reason}`;
}
