/** Categories of expected failures that a caller can act on. */
export type DomainErrorCategory =
  'validation' | 'unauthenticated' | 'forbidden' | 'not-found' | 'conflict' | 'rate-limit';

export type DomainErrorOptions = Readonly<{
  category: DomainErrorCategory;
  code: string;
  /** Deliberately public text. Never derive this from an unknown exception. */
  publicMessage: string;
  retryAfterSeconds?: number;
  cause?: unknown;
}>;

/** An expected domain refusal with an explicitly safe HTTP-facing description. */
export class DomainError extends Error {
  public readonly kind = 'domain';
  public readonly category: DomainErrorCategory;
  public readonly code: string;
  public readonly publicMessage: string;
  public readonly retryAfterSeconds: number | undefined;

  public constructor(options: DomainErrorOptions) {
    super(
      options.publicMessage,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DomainError';
    this.category = options.category;
    this.code = options.code;
    this.publicMessage = options.publicMessage;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** How an infrastructure failure relates to the current service boundary. */
export type InfrastructureFailureKind = 'internal' | 'unavailable' | 'upstream';

export type InfrastructureErrorOptions = Readonly<{
  component: string;
  operation: string;
  failureKind?: InfrastructureFailureKind;
  retryable?: boolean;
  cause: unknown;
}>;

/**
 * An unexpected adapter or dependency failure.
 *
 * It intentionally has no caller-controlled public message. HTTP boundaries map only
 * `failureKind` to fixed text and keep `cause` in server-side diagnostics.
 */
export class InfrastructureError extends Error {
  public readonly kind = 'infrastructure';
  public readonly component: string;
  public readonly operation: string;
  public readonly failureKind: InfrastructureFailureKind;
  public readonly retryable: boolean;

  public constructor(options: InfrastructureErrorOptions) {
    super(`${options.component}.${options.operation} failed`, { cause: options.cause });
    this.name = 'InfrastructureError';
    this.component = options.component;
    this.operation = options.operation;
    this.failureKind = options.failureKind ?? 'internal';
    this.retryable = options.retryable ?? false;
  }
}

/** Preserve typed failures and add operation context to an otherwise unknown exception. */
export function toInfrastructureError(
  error: unknown,
  context: Omit<InfrastructureErrorOptions, 'cause'>,
): DomainError | InfrastructureError {
  if (error instanceof DomainError || error instanceof InfrastructureError) return error;
  return new InfrastructureError({ ...context, cause: error });
}
