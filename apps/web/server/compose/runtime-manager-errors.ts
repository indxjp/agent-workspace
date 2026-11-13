/** A manager answer that may echo the provider key must not carry it into a run's error. */
function redacted(text: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? text : text.split(secret).join('[redacted]');
}

const SAFE_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/u;

const TOOL_SANDBOX_UNAVAILABLE = 'tool_sandbox_unavailable';

/**
 * A manager call that failed. `status` and the two tokens are the only parts of the answer safe to
 * show a caller: `code` is the manager's typed error code (or a fixed-vocabulary platform token for
 * an answer that is not the manager's JSON) and `step` the Worker hop that threw (`forward`,
 * `container-binding`, ...); anything else in the body stays in `message`, which is for the
 * redacted server log. Status `0` means no answer arrived (`timeout` / `unreachable`); a 2xx
 * answer the client cannot use keeps its status and the code `invalid_answer`.
 *
 * `detail` is the manager's own `message`, kept only for `tool_sandbox_unavailable`: that code's
 * messages are fixed strings the runner writes (or a sanitized provider reason). It is not part of
 * `safeCause`; the caller redacts it of the run's secrets before showing it.
 */
export class RuntimeManagerError extends Error {
  override readonly name = 'RuntimeManagerError';
  readonly detail: string | undefined;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly step: string | undefined,
    options?: ErrorOptions & { detail?: string },
  ) {
    super(message, options);
    this.detail = options?.detail;
  }

  /** Which hop failed, without any body text. */
  get safeCause(): string {
    const parts = [
      this.status === 0
        ? 'runner manager did not answer'
        : `runner manager answered HTTP ${String(this.status)}`,
    ];
    if (this.code !== undefined) parts.push(this.code);
    if (this.step !== undefined) parts.push(`at ${this.step}`);
    return parts.join(' ');
  }
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

const PLATFORM_ERROR_HEADER = /^[A-Z][A-Z0-9_]{2,63}$/u;

const PLATFORM_ERROR_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u;

const PLATFORM_BODY_WINDOW = 4096;

/**
 * Names an answer that is not the manager's JSON from a fixed vocabulary only: the platform's own
 * `x-vercel-error` code (`FUNCTION_INVOCATION_FAILED`), else an `UPPER_SNAKE` token its error page
 * carries, else the kind of body. Never body text.
 */
function nonJsonCode(response: Response, text: string): string {
  const header = response.headers.get('x-vercel-error')?.trim() ?? '';
  const token = PLATFORM_ERROR_HEADER.test(header)
    ? header
    : PLATFORM_ERROR_TOKEN.exec(text.slice(0, PLATFORM_BODY_WINDOW))?.[0];
  if (token !== undefined) return token.toLowerCase();
  if (text.trim() === '') return 'non_json_empty';
  const html =
    (response.headers.get('content-type') ?? '').includes('html') ||
    text.trimStart().startsWith('<');
  return html ? 'non_json_html' : 'non_json_text';
}

/** The typed code and Worker step in a manager answer; the Worker's fixed 503 text is `manager_not_ready`. */
export async function managerFailure(
  what: string,
  response: Response,
  providerCredential: string | undefined,
): Promise<RuntimeManagerError> {
  const { status } = response;
  const text = await response.text().catch(() => '');
  let code: string | undefined;
  let step: string | undefined;
  let detail: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown } | null;
    const error = body?.error;
    if (typeof error === 'object' && error !== null) {
      code = safeToken((error as { code?: unknown }).code);
      step = safeToken((error as { step?: unknown }).step);
    } else code = safeToken(error);
    if (code === TOOL_SANDBOX_UNAVAILABLE && typeof body?.message === 'string') {
      detail = redacted(body.message, providerCredential);
    }
  } catch {
    code =
      status === 503 && text.startsWith('The runner manager ')
        ? 'manager_not_ready'
        : nonJsonCode(response, text);
  }
  return new RuntimeManagerError(
    `runtime manager ${what} failed with ${String(status)}: ${redacted(text, providerCredential)}`,
    status,
    code,
    step,
    detail === undefined ? undefined : { detail },
  );
}

/** A call that produced no answer: a timeout, or a connection the platform refused or dropped. */
export async function send(
  what: string,
  providerCredential: string | undefined,
  request: Promise<Response>,
): Promise<Response> {
  try {
    return await request;
  } catch (cause) {
    const timedOut =
      cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    throw new RuntimeManagerError(
      `runtime manager ${what} did not answer: ${redacted(reason, providerCredential)}`,
      0,
      timedOut ? 'timeout' : 'unreachable',
      undefined,
      { cause },
    );
  }
}

export function invalidAnswer(what: string, status: number, problem: string): RuntimeManagerError {
  return new RuntimeManagerError(
    `runtime manager ${what} ${problem}`,
    status,
    'invalid_answer',
    undefined,
  );
}

/** A 2xx answer the client cannot use is the manager's fault, so it is typed like any other hop failure. */
export async function jsonAnswer(what: string, response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw invalidAnswer(what, response.status, 'answered something that is not JSON');
  }
}

export function credentialHeader(providerCredential: string | undefined): Record<string, string> {
  return providerCredential === undefined ? {} : { 'X-Provider-Credential': providerCredential };
}
