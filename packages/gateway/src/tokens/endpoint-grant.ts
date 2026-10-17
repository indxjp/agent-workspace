import { z } from 'zod';

import { base64Url, decodeBase64Url } from './base64url.js';

/** `POST /v1/tool-sandbox/endpoint/mcp` (ADR-0134 part 2): where the control plane posts an endpoint grant. */
export const GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE = {
  method: 'POST',
  path: '/v1/tool-sandbox/endpoint/mcp',
} as const;

/** The run id an endpoint tool sandbox is keyed by: its bearer is `toolSandboxRunToken(secret, id)`. */
export function endpointSandboxRunId(clientId: string): string {
  return `endpoint-${clientId}`;
}

const NonBlankStringSchema = z.string().refine((value) => value.trim().length > 0);

/** A grant is a request-scoped permission, not a session: it never lives longer than this. */
export const ENDPOINT_GRANT_MAX_TTL_SECONDS = 60;
const PREFIX = 'awg.';

const EndpointGrantClaimsSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('tool-endpoint'),
    workspaceId: NonBlankStringSchema,
    clientId: NonBlankStringSchema,
    origin: NonBlankStringSchema,
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict()
  .readonly()
  .refine(
    (claims) =>
      claims.expiresAt > claims.issuedAt &&
      claims.expiresAt - claims.issuedAt <= ENDPOINT_GRANT_MAX_TTL_SECONDS,
  );

export type EndpointGrantClaims = z.infer<typeof EndpointGrantClaimsSchema>;

export type EndpointGrantSubject = Pick<EndpointGrantClaims, 'workspaceId' | 'clientId' | 'origin'>;

export type EndpointGrantVerification =
  | { readonly ok: true; readonly claims: EndpointGrantClaims }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export interface EndpointGrantCodec {
  issue(subject: EndpointGrantSubject): Promise<string>;
  verify(token: string): Promise<EndpointGrantVerification>;
}

export type EndpointGrantCodecOptions = {
  readonly secret: string | Uint8Array;
  readonly ttlSeconds?: number;
  readonly now?: () => number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The 60-second grant the control plane signs for one tool endpoint call (ADR-0134 part 2). It
 * carries the sandbox origin the gateway dials, so the origin is trusted only because the control
 * plane signed it. The `awg.` prefix and the `kind` claim keep it from ever verifying as a run token
 * (and a run token from verifying as a grant) although both are HMACs under one secret.
 */
export function createEndpointGrantCodec(options: EndpointGrantCodecOptions): EndpointGrantCodec {
  const secret =
    typeof options.secret === 'string' ? encoder.encode(options.secret) : options.secret.slice();
  if (secret.byteLength < 32) {
    throw new Error('Gateway token signing secret must contain at least 32 bytes.');
  }
  const ttlSeconds = options.ttlSeconds ?? ENDPOINT_GRANT_MAX_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > ENDPOINT_GRANT_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `Endpoint grant TTL must be an integer from 1 through ${ENDPOINT_GRANT_MAX_TTL_SECONDS} seconds.`,
    );
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const key = crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

  return {
    async issue(subject) {
      const issuedAt = now();
      const claims = EndpointGrantClaimsSchema.parse({
        version: 1,
        kind: 'tool-endpoint',
        workspaceId: subject.workspaceId,
        clientId: subject.clientId,
        origin: subject.origin,
        issuedAt,
        expiresAt: issuedAt + ttlSeconds,
      });
      const payload = base64Url(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign('HMAC', await key, encoder.encode(payload));
      return `${PREFIX}${payload}.${base64Url(new Uint8Array(signature))}`;
    },
    async verify(token) {
      if (!token.startsWith(PREFIX)) return { ok: false, reason: 'invalid' };
      const segments = token.slice(PREFIX.length).split('.');
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
      let parsed: ReturnType<typeof EndpointGrantClaimsSchema.safeParse>;
      try {
        parsed = EndpointGrantClaimsSchema.safeParse(JSON.parse(decoder.decode(payloadBytes)));
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      if (!parsed.success) return { ok: false, reason: 'invalid' };
      if (now() >= parsed.data.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true, claims: parsed.data };
    },
  };
}
