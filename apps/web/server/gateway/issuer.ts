import {
  createRunTokenCodec,
  type RunTokenClaims,
  type RunTokenSubject,
} from '@agent-workspace/gateway/tokens';

export interface RunTokenIssuer {
  readonly baseUrl: string;
  issue(subject: RunTokenSubject): Promise<string>;
}

export type GatewayIssuerSettings = {
  readonly baseUrl: string;
  readonly signingSecret: string;
  readonly ttlSeconds: number;
};

export type GatewayIssuerSettingsResult =
  | { readonly ok: true; readonly settings: GatewayIssuerSettings }
  | { readonly ok: false; readonly reason: string };

export interface RunTokenRegistration {
  readonly claims: RunTokenClaims;
  /** Lowercase SHA-256 of the bearer token. The bearer itself is never persisted. */
  readonly tokenHash: string;
}

export type RegisterRunToken = (registration: RunTokenRegistration) => Promise<void>;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Read the two shared-service values needed to mint, but never redeem, a run token. */
export function readGatewayIssuerSettings(
  env: Readonly<Record<string, string | undefined>>,
): GatewayIssuerSettingsResult {
  const rawUrl = env['MODEL_GATEWAY_URL'];
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { ok: false, reason: 'MODEL_GATEWAY_URL is not set.' };
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'MODEL_GATEWAY_URL is not a parseable URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'MODEL_GATEWAY_URL must use http or https.' };
  }
  const signingSecret = env['GATEWAY_TOKEN_SECRET'];
  if (
    typeof signingSecret !== 'string' ||
    new TextEncoder().encode(signingSecret).byteLength < 32
  ) {
    return { ok: false, reason: 'GATEWAY_TOKEN_SECRET must contain at least 32 bytes.' };
  }
  const rawTtl = env['GATEWAY_TOKEN_TTL_SECONDS'];
  const ttlSeconds = rawTtl === undefined ? 300 : Number(rawTtl);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
    return {
      ok: false,
      reason: 'GATEWAY_TOKEN_TTL_SECONDS must be an integer from 1 through 3600.',
    };
  }
  return {
    ok: true,
    settings: {
      baseUrl: url.toString().replace(/\/$/, ''),
      signingSecret,
      ttlSeconds,
    },
  };
}

export function createRunTokenIssuer(
  settings: GatewayIssuerSettings,
  register?: RegisterRunToken,
): RunTokenIssuer {
  const tokens = createRunTokenCodec({
    secret: settings.signingSecret,
    ttlSeconds: settings.ttlSeconds,
  });
  return {
    baseUrl: settings.baseUrl,
    async issue(subject) {
      const token = await tokens.issue(subject);
      if (register !== undefined) {
        const verified = await tokens.verify(token);
        if (!verified.ok) throw new Error('A newly issued gateway token did not verify.');
        await register({ claims: verified.claims, tokenHash: await sha256(token) });
      }
      return token;
    },
  };
}

/**
 * Keep the run routes installed for honest lookup/status responses while refusing every launch
 * when the shared gateway configuration is absent. The rejected issue happens before a request
 * is sent to the runner, so this is fail-closed rather than a direct-provider fallback.
 */
export function createUnavailableRunTokenIssuer(reason: string): RunTokenIssuer {
  return {
    baseUrl: 'http://gateway-not-configured.invalid',
    issue() {
      return Promise.reject(new Error(`The model gateway is not configured: ${reason}`));
    },
  };
}
