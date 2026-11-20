/** The development issuer's answers, independent of the HTTP adapter. */
import { contentSecurityPolicy } from './issuer-form.js';

export interface IssuerAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-type': 'text/html; charset=utf-8',
} as const;

export function htmlAnswer(
  status: number,
  body: string,
  options: {
    readonly clientOrigin?: string;
    readonly script?: boolean;
    readonly headers?: Record<string, string>;
  } = {},
): IssuerAnswer {
  return {
    status,
    headers: {
      ...PAGE_HEADERS,
      'content-security-policy': contentSecurityPolicy(
        options.clientOrigin,
        options.script === true,
      ),
      ...options.headers,
    },
    body,
  };
}

export function jsonAnswer(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): IssuerAnswer {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

export function oauthError(
  status: number,
  error: string,
  headers: Record<string, string> = {},
): IssuerAnswer {
  return jsonAnswer(status, { error }, headers);
}

/** The origin of `uri`, which the client registered and so parses. */
export function originOf(uri: string): string {
  return new URL(uri).origin;
}
