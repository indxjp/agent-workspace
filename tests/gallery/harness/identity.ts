/**
 * The platform's side of ADR-0142 D1 for the gallery: what a connector's server is configured with
 * (`identityEnv`) and the signed `x-aw-identity` header the platform would send it (`signedHeaders`).
 */
import {
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_TTL_SECONDS,
  signIdentity,
  type IdentityPrincipalKind,
} from '@indx-workspace/contracts/identity-assertion';

/** The workspace id every scripted assertion names; the server under test expects the same. */
export const GALLERY_WORKSPACE_ID = 'ws_gallery';

/** The environment that makes a gallery MCP server verify assertions signed with `key` for `connectorId`. */
export function identityEnv(key: string, connectorId: string): Record<string, string> {
  return {
    IDENTITY_SECRET: key,
    IDENTITY_AUDIENCE: connectorId,
    IDENTITY_WORKSPACE: GALLERY_WORKSPACE_ID,
  };
}

export interface SignedHeadersInput {
  readonly key: string;
  readonly connectorId: string;
  readonly subject: string;
  readonly runId?: string;
  readonly principalKind?: IdentityPrincipalKind;
  /** Seconds since the epoch; a test passes a past time to get an expired assertion. */
  readonly exp?: number;
  readonly workspace?: string;
}

/** The request headers an opted-in connector receives for a run started with `subject`. */
export async function signedHeaders(input: SignedHeadersInput): Promise<Record<string, string>> {
  return {
    [IDENTITY_ASSERTION_HEADER]: await signIdentity(
      {
        sub: input.subject,
        principalKind: input.principalKind ?? 'api-key',
        workspace: input.workspace ?? GALLERY_WORKSPACE_ID,
        runId: input.runId ?? 'run_gallery',
        aud: input.connectorId,
        exp: input.exp ?? Math.floor(Date.now() / 1000) + IDENTITY_ASSERTION_TTL_SECONDS,
      },
      input.key,
    ),
  };
}
