import {
  IDENTITY_PRINCIPAL_KINDS,
  IDENTITY_SUBJECT_MAX_LENGTH,
} from '@indx-workspace/contracts/identity-assertion';
import { POLICY_CEILING_MAX_COST_PER_DAY_USD } from '@indx-workspace/contracts/policy-ceiling';
import { z } from 'zod';

import { base64Url, decodeBase64Url } from './base64url.js';

export * from './endpoint-grant.js';

const NonBlankStringSchema = z.string().refine((value) => value.trim().length > 0);

const RunTokenClaimsSchema = z
  .object({
    version: z.literal(1),
    tokenId: NonBlankStringSchema,
    runId: NonBlankStringSchema,
    sessionId: NonBlankStringSchema,
    workspaceId: NonBlankStringSchema,
    agentId: NonBlankStringSchema,
    modelConnectionId: NonBlankStringSchema,
    /** Who the run acts for (ADR-0142 D2); absent when no caller identity can be asserted. */
    caller: z
      .strictObject({
        sub: z.string().min(1).max(IDENTITY_SUBJECT_MAX_LENGTH),
        principalKind: z.enum(IDENTITY_PRINCIPAL_KINDS),
      })
      .readonly()
      .optional(),
    /**
     * The deployment's `maxCostPerDayUsd` when it sets one (issue #1851), signed here so the
     * sandbox cannot change it; absent exactly when no cap is set. Bounded as the policy bounds it.
     */
    dailyCostCapUsd: z.number().positive().max(POLICY_CEILING_MAX_COST_PER_DAY_USD).optional(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict()
  .readonly()
  .refine((claims) => claims.expiresAt > claims.issuedAt);

export type RunTokenClaims = z.infer<typeof RunTokenClaimsSchema>;

export type RunTokenSubject = Pick<
  RunTokenClaims,
  | 'runId'
  | 'sessionId'
  | 'workspaceId'
  | 'agentId'
  | 'modelConnectionId'
  | 'caller'
  | 'dailyCostCapUsd'
>;

export type RunTokenVerification =
  | { readonly ok: true; readonly claims: RunTokenClaims }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export interface RunTokenCodec {
  issue(subject: RunTokenSubject): Promise<string>;
  verify(token: string): Promise<RunTokenVerification>;
}

export type RunTokenCodecOptions = {
  readonly secret: string | Uint8Array;
  readonly ttlSeconds?: number;
  readonly now?: () => number;
  readonly randomId?: () => string;
};

const DEFAULT_TTL_SECONDS = 300;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseClaims(value: unknown): RunTokenClaims | null {
  const parsed = RunTokenClaimsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Web-Crypto HMAC codec, usable by both the Node gateway and Next.js Edge instrumentation. */
export function createRunTokenCodec(options: RunTokenCodecOptions): RunTokenCodec {
  const secret =
    typeof options.secret === 'string' ? encoder.encode(options.secret) : options.secret.slice();
  if (secret.byteLength < 32) {
    throw new Error('Gateway token signing secret must contain at least 32 bytes.');
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
    throw new Error('Gateway run token TTL must be an integer from 1 through 3600 seconds.');
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const key = crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

  return {
    async issue(subject) {
      for (const [name, value] of Object.entries(subject)) {
        if (name !== 'caller' && name !== 'dailyCostCapUsd' && !nonBlank(value))
          throw new Error(`Run token ${name} must not be blank.`);
      }
      const issuedAt = now();
      const claims: RunTokenClaims = {
        version: 1,
        tokenId: randomId(),
        ...subject,
        issuedAt,
        expiresAt: issuedAt + ttlSeconds,
      };
      const payload = base64Url(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign('HMAC', await key, encoder.encode(payload));
      return `${payload}.${base64Url(new Uint8Array(signature))}`;
    },
    async verify(token) {
      const segments = token.split('.');
      if (segments.length !== 2) return { ok: false, reason: 'invalid' };
      const [payload, signature] = segments;
      if (payload === undefined || signature === undefined || !payload || !signature) {
        return { ok: false, reason: 'invalid' };
      }
      const signatureBytes = decodeBase64Url(signature);
      const payloadBytes = decodeBase64Url(payload);
      if (signatureBytes === null || payloadBytes === null) {
        return { ok: false, reason: 'invalid' };
      }
      const valid = await crypto.subtle.verify(
        'HMAC',
        await key,
        signatureBytes,
        encoder.encode(payload),
      );
      if (!valid) return { ok: false, reason: 'invalid' };
      const claims: RunTokenClaims | null = (() => {
        try {
          return parseClaims(JSON.parse(decoder.decode(payloadBytes)));
        } catch {
          return null;
        }
      })();
      if (claims === null) return { ok: false, reason: 'invalid' };
      if (now() >= claims.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true, claims };
    },
  };
}

/**
 * The bearer a session's tool sandbox accepts for one run (ADR-0118 TS3): the HMAC-SHA256 of the
 * run id under the gateway signing secret, in hex, domain-separated from the run token. The web
 * service hands it to the runner and the gateway recomputes it per request, so it never travels
 * in a run request and the agent sandbox cannot learn it.
 */
export async function toolSandboxRunToken(
  secret: string | Uint8Array,
  runId: string,
): Promise<string> {
  const keyBytes = typeof secret === 'string' ? encoder.encode(secret) : secret.slice();
  if (keyBytes.byteLength < 32) {
    throw new Error('Gateway token signing secret must contain at least 32 bytes.');
  }
  if (!nonBlank(runId)) throw new Error('A tool sandbox run token needs a run id.');
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`aw-tool-sandbox-run:${runId}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
