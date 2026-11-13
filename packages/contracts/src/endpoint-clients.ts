import { z } from 'zod';

import { API_KEY_NAME_MAX_LENGTH } from './api-keys.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { NAME_KEY_PATTERN } from './project-file.js';
import { ToolOperationNameSchema } from './tool-connectors.js';

/**
 * What an endpoint client names (ADR-0134): an MCP project tool endpoint, one agent's A2A endpoint,
 * the Builder's MCP door (`/mcp/builder`, issue #1846), or an app's backend acting as the person
 * signed in to it (`app-backend`, ADR-0161). A credential is bound to exactly one client, so
 * revoking the client revokes everything that could reach the resource. A `builder` client binds no
 * agent: the member who consents to it is the principal of its tokens. An `app-backend` client binds
 * the agents its exchanged tokens may run, and names the app's OIDC `client_id` (`oidcAudience`).
 */
export const ENDPOINT_CLIENT_KINDS = [
  'mcp-project',
  'a2a-agent',
  'builder',
  'app-backend',
] as const;
export type EndpointClientKind = (typeof ENDPOINT_CLIENT_KINDS)[number];

/** The most agents one `mcp-project` client lists; equal to `TOOL_SANDBOX_TOOLS_MAX`. */
export const ENDPOINT_CLIENT_AGENTS_MAX = 64;

/** The most tool names one `mcp-project` client allows. */
export const ENDPOINT_CLIENT_TOOLS_MAX = 64;

/** The most OAuth redirect URIs one client registers (ADR-0134 part 3). */
export const ENDPOINT_CLIENT_REDIRECT_URIS_MAX = 10;

/** The longest redirect URI accepted. */
export const ENDPOINT_CLIENT_REDIRECT_URI_MAX_LENGTH = 2048;

/** The longest `oidcAudience` (the app's OIDC `client_id` at the issuer) accepted, ADR-0161 D4. */
export const ENDPOINT_CLIENT_OIDC_AUDIENCE_MAX_LENGTH = 255;

/**
 * The ID token audience an `app-backend` client accepts: the app's own `client_id` at the
 * deployment's OIDC issuer. Exactly the `aud` (or `azp`) the exchange compares, never normalised.
 */
export const OidcAudienceSchema = z
  .string()
  .min(1)
  .max(ENDPOINT_CLIENT_OIDC_AUDIENCE_MAX_LENGTH)
  .refine((value) => value.trim() === value, 'an OIDC audience has no surrounding whitespace');

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A registered OAuth redirect URI: absolute, `https` (or `http` on a loopback host), with no
 * fragment and no credentials. It is compared as an exact string, never normalised.
 */
export const RedirectUriSchema = z
  .string()
  .max(ENDPOINT_CLIENT_REDIRECT_URI_MAX_LENGTH)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    if (url.hash !== '' || value.includes('#')) return false;
    if (url.username !== '' || url.password !== '') return false;
    return (
      url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    );
  }, 'a redirect URI is https (or http on loopback) with no fragment');

const RedirectUrisSchema = z
  .array(RedirectUriSchema)
  .max(ENDPOINT_CLIENT_REDIRECT_URIS_MAX)
  .readonly();

const AgentIdsSchema = z.array(UuidSchema).min(1).max(ENDPOINT_CLIENT_AGENTS_MAX).readonly();
/** What a client lists: one to 64 agents, or none at all for a `builder` client. */
const BoundAgentIdsSchema = z.array(UuidSchema).max(ENDPOINT_CLIENT_AGENTS_MAX).readonly();
const ToolNamesSchema = z.array(ToolOperationNameSchema).max(ENDPOINT_CLIENT_TOOLS_MAX).readonly();

/** How many agents each kind of client lists, and how the refusal says it. */
const AGENT_COUNT = {
  'mcp-project': { fits: (n: number) => n >= 1, article: 'an', wanted: 'at least one agent' },
  'a2a-agent': { fits: (n: number) => n === 1, article: 'an', wanted: 'exactly one agent' },
  builder: { fits: (n: number) => n === 0, article: 'a', wanted: 'no agent' },
  'app-backend': { fits: (n: number) => n >= 1, article: 'an', wanted: 'at least one agent' },
} as const satisfies Record<EndpointClientKind, unknown>;

/**
 * One endpoint client as every item of `GET /api/endpoint-clients` and the body of the single
 * routes render it. `apiKeyIds` names the bound keys and never carries one; the key itself is
 * shown once, by the mint answer.
 */
export const EndpointClientResourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().regex(NAME_KEY_PATTERN),
    kind: z.enum(ENDPOINT_CLIENT_KINDS),
    agentIds: BoundAgentIdsSchema,
    toolNames: ToolNamesSchema.nullable(),
    redirectUris: RedirectUrisSchema,
    /** The ID token audience of an `app-backend` client; `null` for every other kind. */
    oidcAudience: OidcAudienceSchema.nullable(),
    hasClientSecret: z.boolean(),
    actsForPrincipalId: z.string().min(1),
    apiKeyIds: z.array(z.string().min(1)).readonly(),
    revokedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type EndpointClientResource = z.infer<typeof EndpointClientResourceSchema>;

/**
 * The body of `POST /api/endpoint-clients`. An `a2a-agent` client lists exactly one agent and no
 * `toolNames`; an `mcp-project` client lists 1 to {@link ENDPOINT_CLIENT_AGENTS_MAX} agents and may
 * narrow the tools with `toolNames` (`null` or absent means every code tool of those agents); a
 * `builder` client lists no agent and no `toolNames`; an `app-backend` client lists 1 to
 * {@link ENDPOINT_CLIENT_AGENTS_MAX} agents, no `toolNames`, and requires `oidcAudience`, which
 * every other kind refuses.
 */
export const CreateEndpointClientRequestSchema = z
  .object({
    name: z.string().regex(NAME_KEY_PATTERN),
    kind: z.enum(ENDPOINT_CLIENT_KINDS),
    agentIds: BoundAgentIdsSchema,
    toolNames: ToolNamesSchema.nullable().optional(),
    oidcAudience: OidcAudienceSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const rule = AGENT_COUNT[request.kind];
    if (!rule.fits(request.agentIds.length)) {
      context.addIssue({
        code: 'custom',
        path: ['agentIds'],
        message: `${rule.article} ${request.kind} client names ${rule.wanted}`,
      });
    }
    if (
      request.kind !== 'mcp-project' &&
      request.toolNames !== undefined &&
      request.toolNames !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['toolNames'],
        message: 'toolNames applies to mcp-project clients only',
      });
    }
    if ((request.kind === 'app-backend') !== (request.oidcAudience !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['oidcAudience'],
        message:
          'oidcAudience is required for an app-backend client and refused for every other kind',
      });
    }
  })
  .readonly();

export type CreateEndpointClientRequest = z.infer<typeof CreateEndpointClientRequestSchema>;

/**
 * The body of `PATCH /api/endpoint-clients/:id`: the agents, the tool allow-list, the OAuth
 * redirect URIs and/or an `app-backend` client's `oidcAudience`. Whether the change fits the
 * client's kind (one agent for `a2a-agent`, no `toolNames`, `oidcAudience` and no redirect URIs
 * for `app-backend` only) depends on the stored client, so the server checks that and answers
 * `400 endpoint_client_invalid`.
 */
export const UpdateEndpointClientRequestSchema = z
  .object({
    agentIds: AgentIdsSchema.optional(),
    toolNames: ToolNamesSchema.nullable().optional(),
    redirectUris: RedirectUrisSchema.optional(),
    oidcAudience: OidcAudienceSchema.optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.agentIds !== undefined ||
      patch.toolNames !== undefined ||
      patch.redirectUris !== undefined ||
      patch.oidcAudience !== undefined,
    { message: 'send agentIds, toolNames, redirectUris, oidcAudience or any of them' },
  )
  .readonly();

export type UpdateEndpointClientRequest = z.infer<typeof UpdateEndpointClientRequestSchema>;

export const EndpointClientResponseSchema = z
  .object({ endpointClient: EndpointClientResourceSchema })
  .strict()
  .readonly();

export type EndpointClientResponse = z.infer<typeof EndpointClientResponseSchema>;

export const EndpointClientListResponseSchema = z
  .object({ endpointClients: z.array(EndpointClientResourceSchema).readonly() })
  .strict()
  .readonly();

export type EndpointClientListResponse = z.infer<typeof EndpointClientListResponseSchema>;

/**
 * The body of `POST /api/endpoint-clients/:id/keys`. The answer is `MintedApiKeyResponseSchema`
 * unchanged: the key is the only response in the platform that carries the plaintext.
 */
export const MintEndpointKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH),
    expiresAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict()
  .readonly();

export type MintEndpointKeyRequest = z.infer<typeof MintEndpointKeyRequestSchema>;

/**
 * The answer of `POST /api/endpoint-clients/:id/secret` (ADR-0134 part 3): the OAuth `client_id`
 * (the client's id) and its secret, shown once. The old secret stops working at once.
 */
export const RotateEndpointClientSecretResponseSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    warning: z.string().min(1),
  })
  .strict()
  .readonly();

export type RotateEndpointClientSecretResponse = z.infer<
  typeof RotateEndpointClientSecretResponseSchema
>;

/** Domain problem codes of the endpoint-client routes, with the status each travels under. */
export const ENDPOINT_CLIENT_PROBLEM_CODES = {
  endpoint_client_not_found: 404,
  endpoint_client_name_taken: 409,
  endpoint_client_revoked: 409,
  endpoint_client_agent_not_runnable: 403,
  endpoint_client_invalid: 400,
} as const;

export type EndpointClientProblemCode = keyof typeof ENDPOINT_CLIENT_PROBLEM_CODES;
