const JSON_MEDIA_TYPE = 'application/json';
const JSON_RESPONSE_TYPE = 'application/json; charset=utf-8';

export type TransportProblemFactory<TResult> = (
  status: number,
  code: string,
  message: string,
) => TResult;

export type BoundedJsonResult<TResult> =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly result: TResult };

/** {@link BoundedJsonResult} with the body's length in bytes, for a cap that depends on the body. */
export type SizedJsonResult<TResult> =
  | { readonly ok: true; readonly value: unknown; readonly bytes: number }
  | { readonly ok: false; readonly result: TResult };

type TransportFailure<TResult> = { readonly ok: false; readonly result: TResult };

export interface BoundedJsonOptions<TResult> {
  readonly maxBytes: number;
  readonly problem: TransportProblemFactory<TResult>;
}

function rejected<TResult>(
  options: BoundedJsonOptions<TResult>,
  status: number,
  code: string,
  message: string,
): TransportFailure<TResult> {
  return { ok: false, result: options.problem(status, code, message) };
}

async function readBytes<TResult>(
  request: Request,
  options: BoundedJsonOptions<TResult>,
): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | TransportFailure<TResult>> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      return rejected(
        options,
        400,
        'malformed_body',
        `The Content-Length header is ${JSON.stringify(declared)}, which is not a byte count.`,
      );
    }
    if (length > options.maxBytes) {
      return rejected(
        options,
        413,
        'request_body_too_large',
        `This route reads at most ${String(options.maxBytes)} bytes of request body; the request declared a Content-Length of ${String(length)}.`,
      );
    }
  }

  const body = request.body;
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > options.maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The body is being abandoned either way.
        }
        return rejected(
          options,
          413,
          'request_body_too_large',
          `This route reads at most ${String(options.maxBytes)} bytes of request body; the request sent more than that and was not read to the end.`,
        );
      }
      chunks.push(value);
    }
  } catch {
    return rejected(options, 400, 'malformed_body', 'The request body could not be read.');
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: joined };
}

/** Parse a strictly identified JSON body without buffering beyond the domain-owned byte limit. */
export async function readBoundedJson<TResult>(
  request: Request,
  options: BoundedJsonOptions<TResult>,
): Promise<BoundedJsonResult<TResult>> {
  const read = await readSizedJson(request, options);
  return read.ok ? { ok: true, value: read.value } : read;
}

/** {@link readBoundedJson}, also reporting how many bytes the body was. */
export async function readSizedJson<TResult>(
  request: Request,
  options: BoundedJsonOptions<TResult>,
): Promise<SizedJsonResult<TResult>> {
  const contentType = request.headers.get('content-type');
  const mediaType =
    contentType === null ? '' : (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    return rejected(
      options,
      415,
      'unsupported_media_type',
      `This route accepts ${JSON_MEDIA_TYPE}; the request declared ${
        mediaType === '' ? 'no Content-Type' : JSON.stringify(mediaType)
      }.`,
    );
  }

  const bounded = await readBytes(request, options);
  if (!bounded.ok) return bounded;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bounded.bytes);
  } catch {
    return rejected(options, 400, 'malformed_body', 'The request body is not valid UTF-8.');
  }
  if (text.trim() === '') {
    return rejected(
      options,
      400,
      'malformed_body',
      'The request body is empty; a JSON object is required.',
    );
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown, bytes: bounded.bytes.byteLength };
  } catch {
    return rejected(options, 400, 'malformed_body', 'The request body is not valid JSON.');
  }
}

/** Build a JSON response while letting a domain add security headers at its own boundary. */
export function jsonBodyResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': JSON_RESPONSE_TYPE },
  });
}

/** Convert the common `{ status, body }` result, preserving the body's intentional empty arm. */
export function apiResultResponse(result: {
  readonly status: number;
  readonly body: unknown;
}): Response {
  if (result.status === 204 || result.body === null) {
    return new Response(null, { status: result.status });
  }
  return jsonBodyResponse(result.status, result.body);
}

/** Read one promised dynamic-route parameter without trusting the resolved object shape. */
export async function readRouteParam(
  context: { readonly params: Promise<unknown> },
  name: string,
): Promise<unknown> {
  const params = await context.params;
  if (typeof params !== 'object' || params === null) return undefined;
  return (params as Record<string, unknown>)[name];
}
