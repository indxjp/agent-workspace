/** `/token` of the development issuer: `client_secret_basic`, single-use codes, one ID token. */
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { jsonAnswer, oauthError, type IssuerAnswer } from './issuer-answer.js';
import { Field } from './issuer-authorize.js';
import { base64url, devIssuerSubject, randomToken, sha256 } from './issuer-crypto.js';
import type { IssuedCode, IssuerContext, RegisteredClient } from './issuer-state.js';

const ID_TOKEN_TTL_SECONDS = 600;

/** The `/token` body (DI4). */
const TokenRequestSchema = z
  .object({
    grant_type: Field,
    code: Field.min(1),
    redirect_uri: Field.min(1),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
    client_id: Field.optional(),
  })
  .strict();
type TokenRequest = z.infer<typeof TokenRequestSchema>;

/** Parse `Authorization: Basic …` as RFC 6749 §2.3.1 encodes it, or `undefined`. */
function basicCredentials(
  authorization: string | undefined,
): { readonly id: string; readonly secret: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(authorization ?? '');
  if (match?.[1] === undefined) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, colon).replaceAll('+', ' ')),
      secret: decodeURIComponent(decoded.slice(colon + 1).replaceAll('+', ' ')),
    };
  } catch {
    return undefined;
  }
}

/** The registered client the `Authorization` header proves, or `undefined`. */
function authenticatedClient(
  context: IssuerContext,
  authorization: string | undefined,
): RegisteredClient | undefined {
  const credentials = basicCredentials(authorization);
  if (credentials === undefined) return undefined;
  const client = context.clients.get(credentials.id);
  if (client === undefined) return undefined;
  return timingSafeEqual(sha256(credentials.secret), client.secretDigest) ? client : undefined;
}

/** Whether `code`, presented by `client` in `request`, may be exchanged now. */
function codeIsRedeemable(
  code: IssuedCode | undefined,
  client: RegisteredClient,
  request: TokenRequest,
  now: number,
): code is IssuedCode {
  if (code === undefined || code.expiresAt <= now) return false;
  const namesAnotherClient =
    code.clientId !== client.clientId ||
    (request.client_id !== undefined && request.client_id !== client.clientId);
  const verifierChallenge = base64url(sha256(request.code_verifier));
  return (
    !namesAnotherClient &&
    code.redirectUri === request.redirect_uri &&
    verifierChallenge === code.challenge
  );
}

function tokenResponse(
  context: IssuerContext,
  client: RegisteredClient,
  code: IssuedCode,
): IssuerAnswer {
  const iat = Math.floor(context.now() / 1000);
  const idToken = context.signIdToken({
    iss: context.issuer,
    sub: devIssuerSubject(code.email),
    aud: client.clientId,
    azp: client.clientId,
    email: code.email,
    email_verified: true,
    iat,
    auth_time: code.authTime,
    exp: iat + ID_TOKEN_TTL_SECONDS,
    ...(code.nonce === undefined ? {} : { nonce: code.nonce }),
  });
  return jsonAnswer(200, {
    access_token: randomToken(),
    token_type: 'Bearer',
    expires_in: ID_TOKEN_TTL_SECONDS,
    id_token: idToken,
  });
}

export function token(
  context: IssuerContext,
  authorization: string | undefined,
  parameters: Readonly<Record<string, string>>,
): IssuerAnswer {
  const client = authenticatedClient(context, authorization);
  if (client === undefined) {
    return oauthError(401, 'invalid_client', { 'www-authenticate': 'Basic realm="aw dev"' });
  }
  const grantType = parameters['grant_type'];
  if (grantType !== 'authorization_code') {
    return oauthError(400, grantType === undefined ? 'invalid_request' : 'unsupported_grant_type');
  }
  const parsed = TokenRequestSchema.safeParse(parameters);
  if (!parsed.success) return oauthError(400, 'invalid_request');
  const request = parsed.data;
  const code = context.codes.get(request.code);
  // Single use: a code is gone once presented, whatever the outcome.
  context.codes.delete(request.code);
  if (!codeIsRedeemable(code, client, request, context.now())) {
    return oauthError(400, 'invalid_grant');
  }
  return tokenResponse(context, client, code);
}
