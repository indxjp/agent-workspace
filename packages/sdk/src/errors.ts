import { CONTRACTS_VERSION, type ApiProblem } from '@indx-workspace/contracts';

/** The base of every failure this SDK raises, so a caller can catch the family in one clause. */
export abstract class AgentWorkspaceError extends Error {
  public abstract readonly kind: 'problem' | 'contract' | 'transport' | 'argument';

  protected constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
  }
}

/**
 * The server answered with a non-2xx status. When the body is the platform's error envelope,
 * `code` and `message` are exactly what it said; when it is not — a proxy page, an empty body —
 * `code` is `unrecognised_error_body` and `status` is still the fact to branch on.
 */
export class ApiProblemError extends AgentWorkspaceError {
  public readonly kind = 'problem';
  public readonly status: number;
  public readonly code: string;
  public readonly details: readonly string[];
  /** Seconds the server asked the client to wait, from `Retry-After`, when it sent one. */
  public readonly retryAfterSeconds: number | null;

  public constructor(input: {
    readonly status: number;
    readonly problem: ApiProblem['error'];
    readonly retryAfterSeconds?: number | null;
    /** The failure this problem reports on, when the SDK raised it itself around another one. */
    readonly cause?: unknown;
  }) {
    super(input.problem.message, { cause: input.cause });
    this.status = input.status;
    this.code = input.problem.code;
    this.details = input.problem.details ?? [];
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

/**
 * Where a client and a server stand when the server does not serve the client's contracts version
 * (issue #244, S-7). `upgrade` names the side that must move: `client` when the client is older
 * than the oldest version the server serves, `server` when it is newer than the server.
 */
export interface ContractsVersionSkew {
  /** The contracts version this client was built against. */
  readonly clientVersion: string;
  /** The server's current contracts version. */
  readonly serverVersion: string;
  /** The oldest contracts version the server still serves. */
  readonly servedMinimum: string;
  readonly upgrade: 'client' | 'server';
}

/**
 * The server refused this client's contracts version: `426 contracts_version_unsupported`. It is an
 * {@link ApiProblemError}, so a handler that already branches on `status`/`code` keeps working;
 * `skew` adds both versions and the side to upgrade, read from the served-range response headers.
 * `skew` is `null` when the `426` carries no readable served range (the headers are missing or
 * unparsable), or one that, by this client's reading, serves it — something between the client and
 * the control plane answered, or the two disagree. `null` does not mean "not the control plane".
 */
export class ContractsVersionUnsupportedError extends ApiProblemError {
  public readonly skew: ContractsVersionSkew | null;

  public constructor(input: {
    readonly problem: ApiProblem['error'];
    readonly skew: ContractsVersionSkew | null;
  }) {
    super({ status: 426, problem: input.problem });
    this.skew = input.skew;
  }
}

/**
 * The server answered successfully but the body does not satisfy the contract this SDK was built
 * against. Either side has drifted; the response is refused rather than half-read. The message and
 * `contractsVersion` name the contracts version this SDK was built against.
 */
export class ContractViolationError extends AgentWorkspaceError {
  public readonly kind = 'contract';
  public readonly status: number;
  public readonly issues: readonly string[];
  public readonly contractsVersion: string = CONTRACTS_VERSION;

  public constructor(input: {
    readonly operation: string;
    readonly status: number;
    readonly issues: readonly string[];
  }) {
    super(
      `${input.operation}: the server's ${String(input.status)} response does not match the contract (${input.issues.join('; ')}); this client was built against contracts ${CONTRACTS_VERSION}`,
    );
    this.status = input.status;
    this.issues = input.issues;
  }
}

/** The request never produced a response: network failure, abort, or timeout. */
export class TransportError extends AgentWorkspaceError {
  public readonly kind = 'transport';
  public readonly aborted: boolean;

  public constructor(input: {
    readonly operation: string;
    readonly aborted: boolean;
    readonly cause: unknown;
  }) {
    super(
      `${input.operation}: ${input.aborted ? 'the request was aborted' : `the request could not be completed${describeCause(input.cause)}`}`,
      { cause: input.cause },
    );
    this.aborted = input.aborted;
  }
}

/**
 * The network failure behind a transport error, as ` (fetch failed: connect ECONNREFUSED …)`, so
 * the reason is in the message instead of two `cause` levels down (BH061-039). An error with no
 * message (Node's `AggregateError` for a refused connection) contributes its `code`.
 */
function describeCause(cause: unknown): string {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code: unknown = (current as { readonly code?: unknown }).code;
    const text = current.message !== '' ? current.message : typeof code === 'string' ? code : '';
    if (text !== '' && !parts.includes(text)) parts.push(text);
    current = current.cause;
  }
  return parts.length === 0 ? '' : ` (${parts.join(': ')})`;
}

/**
 * The SDK refused an argument before making any request, so the server never saw it. Retrying
 * cannot help: fix the argument. `code` names the rule it broke — `invalid_path_segment` for an id
 * that is empty, `.` or `..`, which would otherwise address a different route (issue #488), or
 * that holds a lone UTF-16 surrogate, which cannot be percent-encoded.
 */
export class InvalidArgumentError extends AgentWorkspaceError {
  public readonly kind = 'argument';
  public readonly code: 'invalid_path_segment';
  /** The refused value: `''`, `'.'`, `'..'` or a string holding a lone surrogate. */
  public readonly value: string;

  public constructor(input: { readonly code: 'invalid_path_segment'; readonly value: string }) {
    super(
      `a path segment must not be empty, "." or ".." or hold a lone surrogate (got ${JSON.stringify(input.value)})`,
    );
    this.code = input.code;
    this.value = input.value;
  }
}
