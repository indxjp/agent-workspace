import {
  DomainError,
  InfrastructureError,
  toInfrastructureError,
  type InfrastructureErrorOptions,
} from '../errors';

const DOMAIN_STATUS: Readonly<Record<DomainError['category'], number>> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'rate-limit': 429,
};

const INFRASTRUCTURE_RESPONSE = {
  internal: {
    status: 500,
    code: 'internal_error',
    message: 'The request could not be completed.',
  },
  unavailable: {
    status: 503,
    code: 'service_unavailable',
    message: 'A required service is temporarily unavailable.',
  },
  upstream: {
    status: 502,
    code: 'upstream_failure',
    message: 'An upstream service could not complete the request.',
  },
} as const;

export type ErrorResponseContext = Omit<InfrastructureErrorOptions, 'cause'> &
  Readonly<{
    log?: (message: string, error: InfrastructureError) => void;
  }>;

function domainErrorResponse(error: DomainError): Response {
  const headers =
    error.category === 'rate-limit' && error.retryAfterSeconds !== undefined
      ? { 'Retry-After': String(error.retryAfterSeconds) }
      : undefined;
  return Response.json(
    { error: { code: error.code, message: error.publicMessage } },
    {
      status: DOMAIN_STATUS[error.category],
      ...(headers === undefined ? {} : { headers }),
    },
  );
}

/** Map typed failures to safe API problems and wrap every unknown failure as infrastructure. */
export function errorResponse(error: unknown, context: ErrorResponseContext): Response {
  const classified = toInfrastructureError(error, context);
  if (classified instanceof DomainError) return domainErrorResponse(classified);

  const response = INFRASTRUCTURE_RESPONSE[classified.failureKind];
  const log =
    context.log ??
    ((message: string, failure: InfrastructureError) => console.error(message, failure));
  log(`[${classified.component}] ${classified.operation} failed`, classified);
  return Response.json(
    { error: { code: response.code, message: response.message } },
    { status: response.status },
  );
}
