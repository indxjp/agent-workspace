/**
 * The connector resource's shape — spec §8, §23, §27 — and the parsing that turns a request body
 * into a validated create input, or a list of field errors.
 *
 * ## The credential field name is fixed, not user-chosen, and that is a declared simplification
 *
 * The mockup's "API Key" row (`ui/connector-new.html`) lets the user name the header a key is
 * sent under ("Sent as a header you name"). `packages/core/src/db/schema/mcp-servers.ts` — owned
 * by W2-DB-01, not this task — has no column to store that name: its columns are `transport`,
 * `command`, `args`, `url`, `authType` and `credentialSecretId`, and adding one is a migration this
 * task's `Owns:` globs do not cover. So every authenticated connector uses a FIXED field name per
 * `(transport, authType)` pair — {@link credentialFieldFor} — declared here as a gap rather than
 * worked around with a migration this task does not own. A future task that adds the column can
 * widen this without changing the wire shape `test-connection.ts` and the routes already agree on.
 *
 * ## What never appears here
 *
 * {@link ConnectorResource} — what every route hands back — has no field a raw credential value
 * could occupy, the same "the type cannot hold it" shape `apps/web/server/secrets/contract.ts`
 * uses for `SecretResource`. The raw value lives only in {@link ParsedCreateConnectorInput.credential}
 * for the single moment between reading the request body and sealing it as a secret.
 */
import {
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_KINDS,
  CONNECTOR_TRANSPORTS,
  ConnectorUrlSchema,
  type ConnectorAuthType,
  type ConnectorTransport,
} from '@indx-workspace/contracts/connectors';
import {
  ConnectorIdentitySchema,
  type ConnectorIdentity,
} from '@indx-workspace/contracts/identity-assertion';
import {
  OpenApiToolConfigSchema,
  PostgresToolConfigSchema,
  type OpenApiToolConfig,
  type PostgresToolConfig,
  type ToolConnectorKind,
} from '@indx-workspace/contracts/tool-connectors';

export type McpAuthType = ConnectorAuthType;
export type McpTransport = ConnectorTransport;

/** The field a resolved credential is placed under, for one `(transport, authType)` pair. `null`
 *  for `authType: 'none'`, which carries no credential at all. See this file's header. */
export function credentialFieldFor(
  transport: McpTransport,
  authType: McpAuthType,
):
  | { readonly kind: 'header'; readonly name: string }
  | { readonly kind: 'env'; readonly name: string }
  | null {
  if (authType === 'none') return null;
  if (transport === 'stdio') return { kind: 'env', name: 'MCP_CREDENTIAL' };
  if (authType === 'bearer' || authType === 'oauth')
    return { kind: 'header', name: 'Authorization' };
  return { kind: 'header', name: 'X-Api-Key' };
}

/** The header VALUE a credential is sent as, given the raw secret value. Bearer/OAuth prefix the
 *  token; an API key header carries the raw value verbatim. */
export function credentialHeaderValue(authType: McpAuthType, rawValue: string): string {
  return authType === 'bearer' || authType === 'oauth' ? `Bearer ${rawValue}` : rawValue;
}

/** One MCP connector, as every route hands it back. No field a credential VALUE could occupy.
 *  It omits `kind`, so a 0.2 client's strict schema keeps parsing it (`ConnectorResourceSchema`). */
export interface ConnectorResource {
  readonly kind?: 'mcp';
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly url: string | null;
  readonly authType: McpAuthType;
  /** Whether a credential is on file — never the credential itself. */
  readonly hasCredential: boolean;
  readonly enabled: boolean;
  /** Legacy human creator attribution, or `null` when an API-key principal created the row. */
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The identity opt-in (ADR-0142 D1): the signing secret's name, never its value. */
  readonly identity?: ConnectorIdentity | undefined;
}

/**
 * One tool connector (ADR-0113 C15), as every route hands it back: the MCP-only keys are `null`
 * and the kind's own half is present. `hasCredential` says whether a credential is on file, never
 * what it is.
 */
export interface ToolConnectorResource {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: ToolConnectorKind;
  readonly transport: null;
  readonly command: null;
  readonly args: null;
  readonly url: null;
  readonly authType: null;
  readonly hasCredential: boolean;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly openapi?: OpenApiToolConfig;
  readonly postgres?: PostgresToolConfig;
  readonly identity?: ConnectorIdentity | undefined;
}

/** Any connector a route hands back: narrow on `kind` (absent for MCP). */
export type AnyConnectorResource = ConnectorResource | ToolConnectorResource;

/** The fields of a tool connector row the resource is rendered from. */
export interface ToolConnectorRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: ToolConnectorKind;
  readonly toolConfig: Readonly<Record<string, unknown>>;
  readonly credentialSecretId: string | null;
  readonly identitySecretName: string | null;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The resource's `identity` member for a stored secret name, or nothing when not opted in. */
export function identityOf(secretName: string | null): { readonly identity?: ConnectorIdentity } {
  return secretName === null ? {} : { identity: { secret: secretName } };
}

/**
 * Render a tool connector row. `tool_config` is `jsonb`, so its kind's half is parsed here, at the
 * trust boundary; a row that does not parse is a defect and throws.
 */
export function toToolConnectorResource(row: ToolConnectorRow): ToolConnectorResource {
  const half =
    row.kind === 'openapi'
      ? { openapi: OpenApiToolConfigSchema.parse(row.toolConfig['openapi']) }
      : { postgres: PostgresToolConfigSchema.parse(row.toolConfig['postgres']) };
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    kind: row.kind,
    transport: null,
    command: null,
    args: null,
    url: null,
    authType: null,
    hasCredential: row.credentialSecretId !== null,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ownerPrincipalId: row.ownerPrincipalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...half,
    ...identityOf(row.identitySecretName),
  };
}

/** What `POST /api/connectors` and `POST /api/connectors/test-connection` both parse out of a
 *  request body, before a secret is sealed or a probe is run. */
export interface ParsedCreateConnectorInput {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly url: string | null;
  readonly authType: McpAuthType;
  /** The raw credential value, present iff `authType !== 'none'`. Never stored verbatim — sealed
   *  as a secret (create) or used only in-memory for the duration of a probe (test-connection). */
  readonly credential: string | null;
  /** The identity opt-in (ADR-0142 D1); a `stdio` connector cannot carry one. */
  readonly identity?: ConnectorIdentity;
}

const NAME_PATTERN = /^.{1,200}$/u;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isConnectorTransport(value: string): value is McpTransport {
  return (CONNECTOR_TRANSPORTS as readonly string[]).includes(value);
}

function isConnectorAuthType(value: string): value is McpAuthType {
  return (CONNECTOR_AUTH_TYPES as readonly string[]).includes(value);
}

/**
 * Parse and validate a `POST` body against the same shape `mcp_servers`' CHECK constraints
 * enforce — stdio has a command and no url, http/sse have a url and no command, args belong to
 * stdio only, and every authenticated type carries a credential. Validating here means the
 * database's constraints are a backstop this code should never actually trigger, not the first
 * line of defence.
 */
export function parseCreateConnectorBody(
  raw: unknown,
):
  | { readonly ok: true; readonly value: ParsedCreateConnectorInput }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['the request body must be a JSON object'] };
  }
  const body = raw as Record<string, unknown>;

  const name = body['name'];
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    errors.push('"name" must be a non-empty string of at most 200 characters');
  }

  const transport = body['transport'];
  if (typeof transport !== 'string' || !isConnectorTransport(transport)) {
    errors.push(`"transport" must be one of ${CONNECTOR_TRANSPORTS.join(', ')}`);
  }

  const authTypeRaw = body['authType'];
  const authType = authTypeRaw ?? 'none';
  if (typeof authType !== 'string' || !isConnectorAuthType(authType)) {
    errors.push(`"authType" must be one of ${CONNECTOR_AUTH_TYPES.join(', ')}`);
  }

  let command: string | null = null;
  let args: string[] | null = null;
  let url: string | null = null;

  if (typeof transport === 'string' && isConnectorTransport(transport)) {
    const isStdio = transport === 'stdio';
    const commandRaw = body['command'];
    const urlRaw = body['url'];
    const argsRaw = body['args'];

    if (isStdio) {
      if (typeof commandRaw !== 'string' || commandRaw.trim() === '') {
        errors.push('"command" is required and must be non-blank for a stdio connector');
      } else {
        command = commandRaw;
      }
      if (argsRaw !== undefined) {
        if (!isStringArray(argsRaw)) errors.push('"args" must be an array of strings');
        else args = argsRaw;
      }
      if (urlRaw !== undefined) errors.push('"url" is not valid for a stdio connector');
    } else {
      const parsedUrl = ConnectorUrlSchema.safeParse(urlRaw);
      // The shape message is the one formal/AgentWorkspace/Concepts/Connector.lean pins; a URL of
      // the right shape that is host-less or carries a credential is refused with its own.
      if (typeof urlRaw !== 'string' || !/^https?:\/\//u.test(urlRaw)) {
        errors.push('"url" is required and must be an absolute http(s) URL for a remote connector');
      } else if (!parsedUrl.success) {
        errors.push(
          '"url" must have a host and carry no credential (a user name, password or credential query parameter) for a remote connector',
        );
      } else {
        url = parsedUrl.data;
      }
      if (commandRaw !== undefined) errors.push('"command" is not valid for a remote connector');
      if (argsRaw !== undefined) errors.push('"args" is not valid for a remote connector');
    }
  }

  let credential: string | null = null;
  if (typeof authType === 'string' && authType !== 'none') {
    const credentialRaw = body['credential'];
    if (typeof credentialRaw !== 'string' || credentialRaw.trim() === '') {
      errors.push(`"credential" is required when "authType" is ${JSON.stringify(authType)}`);
    } else {
      credential = credentialRaw;
    }
  } else if (body['credential'] !== undefined) {
    errors.push('"credential" must not be supplied when "authType" is "none"');
  }

  let identity: ConnectorIdentity | undefined;
  if (body['identity'] !== undefined) {
    const parsedIdentity = ConnectorIdentitySchema.safeParse(body['identity']);
    if (parsedIdentity.success) identity = parsedIdentity.data;
    else errors.push('"identity" must be { "secret": NAME }, the name of a workspace secret');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name: name as string,
      transport: transport as McpTransport,
      command,
      args,
      url,
      authType: authType as McpAuthType,
      credential,
      ...(identity === undefined ? {} : { identity }),
    },
  };
}

/** The one error a create body gets when its `kind` names no connector kind. */
export const KIND_ERROR = `"kind" must be one of ${CONNECTOR_KINDS.join(', ')}`;

/**
 * Which admission rule a create body takes (ADR-0113 C15): `kind` absent or `'mcp'` is the MCP
 * rule ({@link parseCreateConnectorBody}, unchanged); `'openapi'` or `'postgres'` is that kind's
 * contracts schema (`./tools.ts`); any other value, `null` included, is `null` (refused with
 * {@link KIND_ERROR}). A body that is not an object takes the MCP rule, which refuses it.
 */
export function connectorKindOfBody(raw: unknown): 'mcp' | ToolConnectorKind | null {
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) return 'mcp';
  const kind: unknown = (raw as Record<string, unknown>)['kind'];
  return kind === 'mcp' || kind === 'openapi' || kind === 'postgres' ? kind : null;
}
