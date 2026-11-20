/** The development issuer's in-memory state: clients, codes, sessions and the sign-in limiter. */
/** A client registered at the issuer for this process (DI5). */
export interface RegisteredClient {
  readonly clientId: string;
  /** The SHA-256 of its secret: the secret itself is held only by whoever registered it. */
  readonly secretDigest: Buffer;
  readonly redirectUri: string;
}

export interface IssuedCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string | undefined;
  readonly email: string;
  readonly authTime: number;
  readonly expiresAt: number;
}

export interface IssuerSession {
  readonly email: string;
  readonly authTime: number;
  readonly expiresAt: number;
}

const FAILED_SIGN_INS_PER_MINUTE = 10;
const LIMIT_WINDOW_MS = 60_000;

interface FailureLimiter {
  /** Seconds to wait when the limit is reached, else `undefined`. */
  retryAfter(): number | undefined;
  fail(): void;
}

/** A per-minute counter of failed sign-ins: the issuer has one user, so one counter. */
export function failureLimiter(now: () => number): FailureLimiter {
  let windowStart = 0;
  let failures = 0;
  const roll = (): void => {
    if (now() - windowStart >= LIMIT_WINDOW_MS) {
      windowStart = now();
      failures = 0;
    }
  };
  return {
    retryAfter(): number | undefined {
      roll();
      return failures >= FAILED_SIGN_INS_PER_MINUTE
        ? Math.max(1, Math.ceil((windowStart + LIMIT_WINDOW_MS - now()) / 1000))
        : undefined;
    },
    fail(): void {
      roll();
      failures += 1;
    },
  };
}

/** Everything the `/authorize` and `/token` handlers share. */
export interface IssuerContext {
  readonly issuer: string;
  readonly now: () => number;
  /** The email the form is prefilled with: the project's bootstrap Owner. */
  readonly defaultEmail: string;
  /** The local console password, read when the form is posted; `undefined` when none is set. */
  readonly readPassword: () => Promise<string | undefined>;
  readonly clients: Map<string, RegisteredClient>;
  readonly codes: Map<string, IssuedCode>;
  readonly sessions: Map<string, IssuerSession>;
  readonly limiter: FailureLimiter;
  readonly signIdToken: (claims: Readonly<Record<string, unknown>>) => string;
}
