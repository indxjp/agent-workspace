/** The development issuer's pure core: discovery, keys, the code flow and the token endpoint. */
import { generateKeyPairSync } from 'node:crypto';

import { jsonAnswer, type IssuerAnswer } from './issuer-answer.js';
import { authorize, type AuthorizeInput } from './issuer-authorize.js';
import { randomToken, sha256, signer, thumbprint, type PublicJwk } from './issuer-crypto.js';
import { failureLimiter, type IssuerContext } from './issuer-state.js';
import { token } from './issuer-token.js';

/** The pure issuer: discovery, keys, the code flow and the token endpoint, with no I/O of its own. */
export interface DevIssuerCore {
  readonly issuer: string;
  /** Register (or replace) a client with one redirect URI; returns its secret, never printed. */
  registerClient(clientId: string, redirectUri: string): string;
  discovery(): IssuerAnswer;
  jwks(): IssuerAnswer;
  authorize(input: AuthorizeInput): Promise<IssuerAnswer>;
  token(
    authorization: string | undefined,
    parameters: Readonly<Record<string, string>>,
  ): IssuerAnswer;
}

interface DevIssuerCoreOptions {
  /** `http://127.0.0.1:<port>`. */
  readonly issuer: string;
  /** The email the form is prefilled with: the project's bootstrap Owner. */
  readonly defaultEmail: string;
  /** The local console password, read when the form is posted; `undefined` when none is set. */
  readonly readPassword: () => Promise<string | undefined>;
  readonly now?: () => number;
}

function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'form_post'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['EdDSA'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'profile', 'email'],
  };
}

/** The issuer's pure core (DI3 to DI7). */
export function createDevIssuerCore(options: DevIssuerCoreOptions): DevIssuerCore {
  const { issuer } = options;
  const now = options.now ?? Date.now;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as PublicJwk;
  const kid = thumbprint(jwk);
  const context: IssuerContext = {
    issuer,
    now,
    defaultEmail: options.defaultEmail,
    readPassword: options.readPassword,
    clients: new Map(),
    codes: new Map(),
    sessions: new Map(),
    limiter: failureLimiter(now),
    signIdToken: signer(privateKey, kid),
  };

  return {
    issuer,
    registerClient(clientId, redirectUri) {
      const secret = randomToken();
      context.clients.set(clientId, { clientId, secretDigest: sha256(secret), redirectUri });
      return secret;
    },
    discovery: () => jsonAnswer(200, discoveryDocument(issuer)),
    jwks: () => jsonAnswer(200, { keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] }),
    authorize: (input) => authorize(context, input),
    token: (authorization, parameters) => token(context, authorization, parameters),
  };
}
