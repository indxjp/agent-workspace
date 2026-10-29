import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { ConnectorIdentitySchema, type ConnectorIdentity } from './identity-assertion.js';
import { SecretReferenceSchema } from './secret-reference.js';
import {
  OPENAPI_DOCUMENT_MAX_BYTES,
  OpenApiToolConfigSchema,
  PostgresToolConfigSchema,
  TOOL_CONNECTOR_PROBLEM_CODES,
} from './tool-connectors.js';
import { urlCarriesCredential } from './url-credential.js';

/**
 * What a connector is (ADR-0113 SD1, C15). `mcp` is an MCP server the run reaches directly; the
 * tool kinds `openapi` and `postgres` run in the gateway (`@indx-workspace/contracts/tool-connectors`).
 * A resource without `kind` is `mcp` ({@link connectorKindOf}).
 */
export const CONNECTOR_KINDS = ['mcp', 'openapi', 'postgres'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/**
 * How the control plane reaches an MCP server. `stdio` launches a command inside a runtime;
 * `http` and `sse` connect to a URL. Matches `mcp_servers.transport`.
 */
export const CONNECTOR_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

/** How a credential is presented to the server. `none` carries no credential at all. */
export const CONNECTOR_AUTH_TYPES = ['none', 'api-key', 'bearer', 'oauth'] as const;
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/** The transports that connect to a URL: {@link CONNECTOR_TRANSPORTS} without `stdio`. */
export const REMOTE_CONNECTOR_TRANSPORTS = [
  'http',
  'sse',
] as const satisfies readonly ConnectorTransport[];

/** The auth types that carry a credential: {@link CONNECTOR_AUTH_TYPES} without `none`. */
export const CREDENTIALED_CONNECTOR_AUTH_TYPES = [
  'api-key',
  'bearer',
  'oauth',
] as const satisfies readonly ConnectorAuthType[];

/**
 * A connector's name is 1–200 code points with no line terminator (the route matches it against
 * `/^.{1,200}$/u`). The database column is unbounded text; the route refuses a longer name as
 * `400 invalid_body`. Measured in code points, not string code units, which is why the response
 * schema does not restate it.
 */
export const CONNECTOR_NAME_MAX_LENGTH = 200;

/**
 * The largest request body the connector routes read for an `mcp` connector, in bytes
 * (`413 request_body_too_large` above it). The one field this bounds in practice is the
 * credential. Each kind's cap is in {@link CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND}.
 */
export const CONNECTOR_REQUEST_BODY_MAX_BYTES = 64 * 1024;

/**
 * The largest `openapi` create body, in bytes: twice the 1 MiB document plus a 64 KiB envelope
 * (C15). The document travels as a JSON string, and escaping `"`, `\` and newlines can double its
 * size, so a document within the 1 MiB bound written as ordinary JSON or YAML still fits. A
 * document dense in other control characters (escaped as `\u00XX`, six bytes each) can reach
 * `413` first.
 */
export const OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES = 2 * OPENAPI_DOCUMENT_MAX_BYTES + 64 * 1024;

/**
 * The request body cap for each connector kind (C15). The route reads up to the largest cap, then
 * applies the cap for the body's kind.
 */
export const CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND: Readonly<Record<ConnectorKind, number>> =
  Object.freeze({
    mcp: CONNECTOR_REQUEST_BODY_MAX_BYTES,
    openapi: OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES,
    postgres: CONNECTOR_REQUEST_BODY_MAX_BYTES,
  });

/** The keys a tool connector (`openapi`, `postgres`) renders as `null`. */
const TOOL_KIND_NULL_KEYS = ['transport', 'command', 'args', 'url', 'authType'] as const;

/**
 * One connector as the `201` of `POST /api/connectors`, `GET /api/connectors/:id`, the `200` of
 * `PATCH /api/connectors/:id` (all bare, not wrapped) and every item of `GET /api/connectors`
 * render it.
 *
 * `kind` says what the connector is; a resource without it is `mcp` ({@link connectorKindOf}).
 * The server may omit `kind`, `openapi` and `postgres` for an MCP connector, so a 0.2 client,
 * whose schema is strict and knows none of them, keeps parsing every MCP-only list.
 *
 * - `mcp`: `command` and `args` belong to a `stdio` connector and `url` to an `http`/`sse` one; the
 *   others are `null`. `transport` and `authType` are set; `openapi` and `postgres` are absent.
 * - `openapi` and `postgres` (ADR-0113 SD1, C15): `transport`, `command`, `args`, `url` and
 *   `authType` are all `null`; the kind's own half (`openapi` or `postgres`) is present and the
 *   other is absent. `hasCredential` is `true` for a `postgres` connector (its connection URL)
 *   and for an `openapi` one whose `auth` is not `none`, and `false` for `auth: 'none'`.
 *
 * `kind` is optional rather than defaulted to `mcp` (a deliberate deviation from the plan's
 * wording): a default would add `kind` to every re-serialised MCP resource, which a 0.2 client's
 * strict schema refuses. Read it through {@link connectorKindOf}.
 *
 * Each inconsistency is refused at its own key. The credential is write-only: `hasCredential`
 * says whether one is on file and `.strict()` refuses a body that carries the value under any key.
 */
export const ConnectorResourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(CONNECTOR_KINDS).optional(),
    transport: z.enum(CONNECTOR_TRANSPORTS).nullable(),
    command: z.string().nullable(),
    args: z.array(z.string()).readonly().nullable(),
    url: z.string().nullable(),
    authType: z.enum(CONNECTOR_AUTH_TYPES).nullable(),
    /** Whether a credential is on file — never the credential itself. */
    hasCredential: z.boolean(),
    enabled: z.boolean(),
    /** Legacy human creator attribution, or `null` when an API-key principal created the row. */
    createdBy: z.string().min(1).nullable(),
    ownerPrincipalId: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    /** An `openapi` connector's document summary, base URL, rules and operations. */
    openapi: OpenApiToolConfigSchema.optional(),
    /** A `postgres` connector's tables, `readOnly` and `maxRows`. */
    postgres: PostgresToolConfigSchema.optional(),
    /**
     * Opt-in to the signed identity assertion (ADR-0142 D1): the reference to the signing secret,
     * never its value. Present only on an `http`/`sse` MCP connector or an `openapi` connector.
     * A response is not refused for a `STORAGE_CONNECTION_` name, which only a connector stored
     * before inputs refused it can carry; the server never reads that secret.
     */
    identity: SecretReferenceSchema.optional(),
  })
  .strict()
  .superRefine((resource, context) => {
    const refuse = (key: string, message: string): void => {
      context.addIssue({ code: 'custom', message, path: [key] });
    };
    const kind = connectorKindOf(resource);
    if (kind === 'mcp') {
      if (resource.transport === null) refuse('transport', 'an mcp connector has a transport');
      if (resource.authType === null) refuse('authType', 'an mcp connector has an auth type');
      if (resource.openapi !== undefined) refuse('openapi', 'only an openapi connector has this');
      if (resource.postgres !== undefined) refuse('postgres', 'only a postgres connector has this');
      return;
    }
    for (const key of TOOL_KIND_NULL_KEYS) {
      if (resource[key] !== null) refuse(key, `a ${kind} connector has none`);
    }
    const other = kind === 'openapi' ? 'postgres' : 'openapi';
    if (resource[kind] === undefined) refuse(kind, `a ${kind} connector has this`);
    if (resource[other] !== undefined) refuse(other, `only a ${other} connector has this`);
    const credentialExpected = toolCredentialExpected(resource);
    if (credentialExpected !== null && resource.hasCredential !== credentialExpected) {
      refuse(
        'hasCredential',
        credentialExpected ? 'this connector has a credential' : 'auth none has no credential',
      );
    }
  })
  .readonly();

export type ConnectorResource = z.infer<typeof ConnectorResourceSchema>;

/**
 * Whether a tool connector resource must have a credential on file: always for `postgres`, and for
 * `openapi` unless its `auth` is `none`. `null` when the resource carries neither half.
 */
function toolCredentialExpected(resource: {
  readonly openapi?: { readonly auth: unknown } | undefined;
  readonly postgres?: unknown;
}): boolean | null {
  if (resource.postgres !== undefined) return true;
  if (resource.openapi !== undefined) return resource.openapi.auth !== 'none';
  return null;
}

/** What a connector resource is: its `kind`, or `mcp` when it has none. */
export function connectorKindOf(resource: {
  readonly kind?: ConnectorKind | undefined;
}): ConnectorKind {
  return resource.kind ?? 'mcp';
}

/**
 * An MCP connector resource: `kind` absent or `mcp`, `transport` and `authType` set, and neither
 * tool half. The shape every MCP-only consumer reads.
 */
export type McpConnectorResource = ConnectorResource & {
  readonly kind?: 'mcp';
  readonly transport: ConnectorTransport;
  readonly authType: ConnectorAuthType;
  readonly openapi?: undefined;
  readonly postgres?: undefined;
};

/** Whether a parsed connector resource is an MCP one ({@link McpConnectorResource}). */
export function isMcpConnectorResource(
  resource: ConnectorResource,
): resource is McpConnectorResource {
  return (
    connectorKindOf(resource) === 'mcp' &&
    resource.transport !== null &&
    resource.authType !== null &&
    resource.openapi === undefined &&
    resource.postgres === undefined
  );
}

/** The body of `GET /api/connectors`: every connector of the caller's workspace. */
export const ConnectorListResponseSchema = z
  .object({ connectors: z.array(ConnectorResourceSchema).readonly() })
  .strict()
  .readonly();

export type ConnectorListResponse = z.infer<typeof ConnectorListResponseSchema>;

/**
 * Every way a connection test can fail, as the probe classifies it. `stdio-probe-unavailable` is
 * not a probe result at all: the control plane never launches a caller-supplied command itself
 * (ADR-0045), so a `stdio` test answers this declared refusal until a sandboxed runner exists.
 */
export const TEST_CONNECTION_FAILURE_KINDS = [
  'auth-required',
  'credential-rejected',
  'credential-insufficient-scope',
  'unreachable',
  'endpoint-not-mcp',
  'tls-error',
  'command-not-found',
  'process-died',
  'timeout',
  'protocol-version-unsupported',
  'server-error',
  'rate-limited',
  'http-error',
  'server-refused',
  'sse-stream-failed',
  'unknown-failure',
  'stdio-probe-unavailable',
] as const;
export type TestConnectionFailureKind = (typeof TEST_CONNECTION_FAILURE_KINDS)[number];

/**
 * The `200` body of `POST /api/connectors/:id/test-connection` and of a dry-run
 * `POST /api/connectors`. A failed probe is still a `200`: the request succeeded, the connection
 * did not. `ok` is the discriminant; `message` is a sentence for a person and never quotes the
 * credential or anything a `stdio` command wrote.
 */
export const TestConnectionOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('ok'),
      message: z.string(),
      serverName: z.string().nullable(),
      serverVersion: z.string().nullable(),
      toolCount: z.number().int().nonnegative(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ok: z.literal(false),
      kind: z.enum(TEST_CONNECTION_FAILURE_KINDS),
      message: z.string(),
    })
    .strict()
    .readonly(),
]);

export type TestConnectionOutcome = z.infer<typeof TestConnectionOutcomeSchema>;

/**
 * The authentication half of a create body. `authType` defaults to `none` on the server; every
 * other type requires a non-blank `credential`, and `none` refuses one. The credential is sent
 * once, sealed as a secret, and never returned.
 */
export interface ConnectorCredentialInput {
  readonly authType?: ConnectorAuthType;
  readonly credential?: string;
  /**
   * Opt in to the signed identity assertion (ADR-0142 D1). `422 connector_identity_unsupported`
   * on a `stdio` connector, which cannot set a request header.
   */
  readonly identity?: ConnectorIdentity;
}

/** A `stdio` connector: a non-blank command and, optionally, its arguments. Never a `url`. */
export interface CreateStdioConnectorInput extends ConnectorCredentialInput {
  readonly name: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
}

/** An `http` or `sse` connector: an absolute `http(s)` URL. Never a `command` or `args`. */
export interface CreateRemoteConnectorInput extends ConnectorCredentialInput {
  readonly name: string;
  readonly transport: (typeof REMOTE_CONNECTOR_TRANSPORTS)[number];
  readonly url: string;
}

/**
 * The body of `POST /api/connectors`. The two shapes are exclusive: the route refuses a `url` on
 * a `stdio` connector and a `command` or `args` on a remote one as `400 invalid_body`, naming
 * each field in `details`. `409 connector_name_conflict` when the workspace already holds the
 * name.
 */
export type CreateConnectorInput = CreateStdioConnectorInput | CreateRemoteConnectorInput;

/**
 * The body of `PATCH /api/connectors/:id` sent as `{ credential }` alone: the replacement
 * credential, rotated in place. `409 credential_not_configured` when the connector's `authType`
 * is `none`. A special case of {@link ConnectorUpdateRequestSchema}.
 */
export interface RotateConnectorCredentialInput {
  readonly credential: string;
}

const NON_BLANK = (value: string): boolean => value.trim() !== '';

/**
 * The stored URL's shape, exactly as the `mcp_servers_url_shape` check constraint reads it: a
 * lower-case `http://` or `https://` prefix. `z.url` alone accepts `HTTPS://x` and keeps it as sent,
 * which the constraint then refuses.
 */
const REMOTE_URL_PREFIX = /^https?:\/\//u;

/**
 * Where an `http`/`sse` connector is reached: an absolute `http` or `https` URL with a host, at
 * most 2048 characters, and no credential in it — no user name or password and no credential
 * query parameter such as `api_key` (`url-credential`). The URL is stored and echoed in every
 * {@link ConnectorResourceSchema}, so a credential belongs in the write-only `credential`.
 */
export const ConnectorUrlSchema = z
  .url({ protocol: /^https?$/u, error: 'must be an absolute http:// or https:// URL', abort: true })
  .regex(REMOTE_URL_PREFIX, {
    error: 'must start with a lower-case http:// or https://',
    abort: true,
  })
  .max(2048, { abort: true })
  .refine((value) => !urlCarriesCredential(new URL(value)), {
    message: 'must not carry a credential; send it as the write-only credential',
  });

/**
 * The body of `PATCH /api/connectors/:id` as a field update. Every field is optional and
 * at least one is required; any other key — `transport`, `ownerPrincipalId`, `workspaceId`,
 * `createdBy` — is `400 invalid_body`, which is how an update can never move a connector's owner
 * or change its transport (recreate it instead).
 *
 * - `url` belongs to an `http`/`sse` connector, `command` and `args` to a `stdio` one; the other
 *   transport's fields are `400 invalid_body`. `args: null` clears the argument list.
 * - `authType` to `none` drops the saved credential and refuses a `credential`; from `none` to an
 *   authenticated type requires one. Between two authenticated types the saved credential is kept
 *   unless a new one is sent.
 * - `credential` alone rotates the saved value (`409 credential_not_configured` on `none`).
 * - A patch that changes where a saved credential is sent — `url`, `command` or `args` to a new
 *   value — must carry a new `credential` in the same body, or it is
 *   `409 credential_required_on_retarget`. The saved value never follows the connector to a
 *   destination its owner did not choose. `authType` to `none` drops the credential, so it needs
 *   none.
 * - `enabled: false` keeps the connector but makes a run of an agent it is assigned to, or of a
 *   session in a project it is associated with, fail to compose with `connector_disabled`.
 *
 * The response is the updated {@link ConnectorResourceSchema}: `hasCredential`, never the value.
 */
export const ConnectorUpdateRequestSchema = z
  .object({
    name: z
      .string()
      .regex(/^.{1,200}$/u)
      .optional(),
    enabled: z.boolean().optional(),
    url: ConnectorUrlSchema.optional(),
    command: z.string().refine(NON_BLANK).optional(),
    args: z.array(z.string()).readonly().nullable().optional(),
    authType: z.enum(CONNECTOR_AUTH_TYPES).optional(),
    credential: z.string().refine(NON_BLANK).optional(),
    /** `null` removes the opt-in (ADR-0142 D1). */
    identity: ConnectorIdentitySchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' })
  .readonly();

export type UpdateConnectorInput = z.infer<typeof ConnectorUpdateRequestSchema>;

/**
 * Problem codes the connector routes own, with the status each one travels under. The tool
 * connector codes (`connector_spec_invalid`, `connector_tool_name_collision`,
 * `connector_kind_unsupported`) come from
 * `TOOL_CONNECTOR_PROBLEM_CODES` (ADR-0113 SD4, C15, C17).
 */
export const CONNECTORS_PROBLEM_CODES = {
  ...TOOL_CONNECTOR_PROBLEM_CODES,
  invalid_body: 400,
  invalid_credential: 400,
  connector_not_found: 404,
  connector_name_conflict: 409,
  credential_not_configured: 409,
  credential_required_on_retarget: 409,
  connectors_runtime_not_configured: 503,
  /**
   * The connector declares `identity` but cannot carry it (ADR-0142 D1): a `stdio` connector sets
   * no request header. Refused at the connector write; and at run compose when a connector that
   * opted in has no caller to assert or no resolvable signing secret. Never ignored.
   */
  connector_identity_unsupported: 422,
} as const;

export type ConnectorsProblemCode = keyof typeof CONNECTORS_PROBLEM_CODES;

/**
 * The stable code a run fails with when the agent it runs has a disabled connector assigned, or its
 * project brings one in: the run's public error begins `connector_disabled: `. Enable the
 * connector, or remove it from the agent or the project.
 */
export const CONNECTOR_DISABLED_RUN_ERROR_CODE = 'connector_disabled';
