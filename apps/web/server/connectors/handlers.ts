/**
 * The connector operations this task ships, as functions of a store and a parsed body — spec §8.
 *
 *   POST   /api/connectors                  {@link createConnector} (`dryRun: true` → Test Connection)
 *   GET    /api/connectors                  {@link listConnectors}
 *   GET    /api/connectors/:id              {@link getConnector}
 *   PATCH  /api/connectors/:id              {@link updateConnector} (`{ credential }` alone rotates)
 *   DELETE /api/connectors/:id              {@link deleteConnector}
 *   POST   /api/connectors/:id/test-connection  {@link testConnectionSaved}
 *
 * `GET`/`POST /api/connectors` are printed in spec §34's example list verbatim. `GET`/`DELETE
 * /api/connectors/:id` are not (§34's own introduction is "Examples:", not the closed set —
 * ADR-0026), so each carries a `mandate` in `tests/route-declarations/W2-CP-05.ts` citing §8.
 * `test-connection` under `:id` is additionally a sub-resource §34 does not print, so it is also
 * declared in `apps/web/server/rbac/declarations/W2-CP-05.ts` (ADR-0040).
 *
 * ## Why the wizard's PRE-save Test Connection is a flag on `POST /api/connectors`, not its own route
 *
 * `tests/route-inventory.test.ts`'s shape rule (ADR-0026 decision 3) admits only
 * `/api/<resource>`, `/api/<resource>/:id` and `/api/<resource>/:id/<sub>` — a literal second
 * segment with no id first (`/api/connectors/test-connection`, this file's first draft) is refused
 * as "a second resource... not named" the moment it carries a mandate rather than being printed by
 * §34. Declaring `test-connection` as a resource of its own would need four roles' grants written
 * into `apps/web/server/rbac/permissions.ts`'s `RESOURCES`/`POLICY` — W2-CP-06's file, not this
 * task's to add a resource to. So the wizard's pre-save probe rides the one route that is already
 * shape-legal and already gated on workspace membership: `createConnector` reads a `dryRun` flag
 * out of the SAME body `POST /api/connectors` already validates, and when it is `true`, runs the
 * probe and returns its outcome instead of writing a row. Nothing about the body's shape changes;
 * only whether it is persisted.
 *
 * Every value returned below is built from `toResource` in this file, whose input type has no
 * field a credential value could occupy. This file could not accidentally return a credential if
 * it tried to; the two probe results ({@link createConnector}'s dry-run branch and
 * {@link testConnectionSaved}) return `TestConnectionOutcome`, which carries
 * `serverName`/`serverVersion`/`toolCount` on success and a `kind`+`message` on failure — never the
 * credential either, because `test-connection.ts`'s own type has no field for one.
 */
import { ConnectorUpdateRequestSchema } from '@indx-workspace/contracts/connectors';

import {
  connectorKindOfBody,
  credentialFieldFor,
  credentialHeaderValue,
  KIND_ERROR,
  parseCreateConnectorBody,
  type ConnectorResource,
  type ParsedCreateConnectorInput,
  type ToolConnectorResource,
} from './contract';
import { restrictedBaseEnv } from './base-env';
import {
  admitToolConnector,
  defaultCheckConnectorEgress,
  type CheckConnectorEgress,
} from './tools';
import {
  testConnection,
  type TestConnectionConfig,
  type TestConnectionOutcome,
} from './test-connection';
import type {
  ConnectorFieldPatch,
  UpdateToolConnectorOutcome,
  WorkspaceConnectorsProbeSource,
  WorkspaceConnectorsStore,
} from './store';

/** A status and a body, before either becomes an HTTP response. `body: null` means "no content". */
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

export interface ApiProblem {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly string[];
  };
}

export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): ApiResult {
  const error =
    details === undefined || details.length === 0
      ? { code, message }
      : { code, message, details: [...details] };
  return { status, body: { error } satisfies ApiProblem };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function requireConnectorId(
  raw: unknown,
): { ok: true; id: string } | { ok: false; result: ApiResult } {
  if (typeof raw === 'string' && UUID_PATTERN.test(raw)) return { ok: true, id: raw };
  // Item routes conceal this branch as connector_not_found in their ownership resolver. The
  // typed 400 remains useful to direct handler callers, but is deliberately not a wire code.
  return {
    ok: false,
    result: problem(400, 'invalid_connector_id', 'The connector id in the path is not a UUID.'),
  };
}

export function connectorNotFound(): ApiResult {
  return problem(404, 'connector_not_found', 'This workspace has no connector with that id.');
}

/** `true` only for a body shaped `{ …, "dryRun": true }`. */
export function isDryRunBody(rawBody: unknown): boolean {
  return (
    typeof rawBody === 'object' &&
    rawBody !== null &&
    (rawBody as Record<string, unknown>)['dryRun'] === true
  );
}

/** Build the `TestConnectionConfig` for an unsaved (dry-run) connector body — the raw credential
 *  is used only for the duration of this one probe and is never persisted. */
function configFor(input: ParsedCreateConnectorInput): TestConnectionConfig {
  const field = credentialFieldFor(input.transport, input.authType);
  const credentialConfigured = field !== null && input.credential !== null;

  if (input.transport === 'stdio') {
    const env: Record<string, string> = {};
    if (field?.kind === 'env' && input.credential !== null) env[field.name] = input.credential;
    return {
      transport: 'stdio',
      command: input.command ?? '',
      args: input.args ?? [],
      env,
      credentialConfigured,
    };
  }
  const headers: Record<string, string> = {};
  if (field?.kind === 'header' && input.credential !== null) {
    headers[field.name] = credentialHeaderValue(input.authType, input.credential);
  }
  return { transport: input.transport, url: input.url ?? '', headers, credentialConfigured };
}

function testResultBody(outcome: TestConnectionOutcome): ApiResult {
  return { status: 200, body: outcome };
}

/**
 * `POST /api/connectors` — 201 with the created connector's metadata, or 400 / 409 — UNLESS the
 * body carries `"dryRun": true`, spec §8's wizard `[ Test Connection ]` button (driven before
 * `[ Save ]`): then nothing is stored, and a 200 carries the real probe's `TestConnectionOutcome`
 * instead. See this file's header for why the two share a route.
 */
export async function createConnector(
  store: WorkspaceConnectorsStore,
  rawBody: unknown,
  owner: { readonly principalId: string; readonly userId: string | null } | null,
  checkConnectorEgress: CheckConnectorEgress = defaultCheckConnectorEgress,
): Promise<ApiResult> {
  if (
    typeof rawBody === 'object' &&
    rawBody !== null &&
    'dryRun' in rawBody &&
    typeof (rawBody as Record<string, unknown>)['dryRun'] !== 'boolean'
  ) {
    return problem(400, 'invalid_body', '"dryRun" must be a boolean when supplied.');
  }
  const kind = connectorKindOfBody(rawBody);
  if (kind === null) {
    return problem(
      400,
      'connector_kind_unsupported',
      'This server does not create that kind of connector.',
      [KIND_ERROR],
    );
  }
  if (kind !== 'mcp') return createToolConnector(store, rawBody, owner, checkConnectorEgress);

  const parsed = parseCreateConnectorBody(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The connector could not be created from this body.',
      parsed.errors,
    );
  }

  if (isDryRunBody(rawBody)) {
    // `baseEnv` is REQUIRED and is never `process.env` — a caller-supplied stdio command must not
    // be spawned with this container's own secrets in its environment (B1, round 2). See
    // `./base-env.ts` and `test-connection.ts`'s header.
    const outcome = await testConnection(configFor(parsed.value), { baseEnv: restrictedBaseEnv() });
    return testResultBody(outcome);
  }

  if (owner === null) return ownerMissing();

  const outcome = await store.create(parsed.value, owner);
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: toResource(outcome.server) };
    case 'name-conflict':
      return nameConflict(outcome.name);
    case 'unknown-credential-secret':
      return problem(
        500,
        'credential_secret_missing',
        'The credential could not be sealed as a secret before the connector row was created.',
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

function ownerMissing(): ApiResult {
  return problem(
    500,
    'connector_owner_missing',
    'Persisting a connector requires an authenticated owner principal.',
  );
}

function nameConflict(name: string): ApiResult {
  return problem(
    409,
    'connector_name_conflict',
    `This workspace already has a connector named ${JSON.stringify(name)}.`,
  );
}

/**
 * `POST /api/connectors` for a tool kind (ADR-0113 C15). `admitToolConnector` produces every
 * refusal before it reads `dryRun`, so a dry run and a save of one body answer the same problem;
 * a dry run then answers the `TestConnectionOutcome` the route declares and writes nothing.
 */
async function createToolConnector(
  store: WorkspaceConnectorsStore,
  rawBody: unknown,
  owner: { readonly principalId: string; readonly userId: string | null } | null,
  checkConnectorEgress: CheckConnectorEgress,
): Promise<ApiResult> {
  const admitted = await admitToolConnector(rawBody, checkConnectorEgress);
  if (!admitted.ok) return admitted.result;
  if (admitted.dryRun) return admitted.dryRunResult;
  if (owner === null) return ownerMissing();
  const outcome = await store.createToolConnector(admitted.write, owner);
  return outcome.kind === 'created'
    ? { status: 201, body: outcome.connector }
    : nameConflict(outcome.name);
}

function toolUpdateResult(outcome: UpdateToolConnectorOutcome): ApiResult {
  switch (outcome.kind) {
    case 'updated':
      return { status: 200, body: outcome.connector };
    case 'not-found':
      return connectorNotFound();
    case 'name-conflict':
      return nameConflict(outcome.name);
    default: {
      const unreachable: never = outcome;
      return problem(500, 'unhandled_store_outcome', JSON.stringify(unreachable));
    }
  }
}

/**
 * `PATCH /api/connectors/:id` on a tool connector. A body with `kind` (equal to the connector's)
 * is a full replacement through the create admission, `dryRun` included, so a saved credential
 * never follows a new document or host (ADR-0077 D5). Without `kind` only `name` and `enabled`
 * change; a partial document or credential change would be a second validation path.
 */
async function updateToolConnector(
  store: WorkspaceConnectorsStore,
  existing: ToolConnectorResource,
  rawBody: unknown,
  checkConnectorEgress: CheckConnectorEgress,
): Promise<ApiResult> {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    return problem(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  const body = rawBody as Record<string, unknown>;
  if ('kind' in body) {
    if (body['kind'] !== existing.kind) {
      return problem(400, 'invalid_body', 'The connector could not be updated from this body.', [
        "kind: a connector's kind cannot change",
      ]);
    }
    const admitted = await admitToolConnector(body, checkConnectorEgress);
    if (!admitted.ok) return admitted.result;
    if (admitted.dryRun) return admitted.dryRunResult;
    return toolUpdateResult(await store.replaceToolConnector(existing.id, admitted.write));
  }
  const foreign = Object.keys(body).filter((key) => key !== 'name' && key !== 'enabled');
  const parsed = ConnectorUpdateRequestSchema.safeParse(body);
  const name = parsed.success ? parsed.data.name : undefined;
  if (
    foreign.length > 0 ||
    !parsed.success ||
    name?.trim() === '' ||
    (name !== undefined && TOOL_NAME_FORBIDDEN.test(name))
  ) {
    return problem(
      400,
      'invalid_body',
      'The connector could not be updated from this body.',
      foreign.length > 0
        ? foreign.map(
            (key) =>
              `${JSON.stringify(key)} is not valid for a ${existing.kind} connector; send the full ${existing.kind} body with kind`,
          )
        : [
            'name and enabled: send a non-blank name of at most 200 characters without control or bidirectional formatting characters, or a boolean',
          ],
    );
  }
  return toolUpdateResult(
    await store.replaceToolConnector(existing.id, {
      ...(name === undefined ? {} : { name }),
      ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
    }),
  );
}

/** The tool create path's name rule (contracts `ToolConnectorNameSchema`): no control or bidi character. */
const TOOL_NAME_FORBIDDEN = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function toResource(record: {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command: string | null;
  readonly args: readonly string[] | null;
  readonly url: string | null;
  readonly authType: 'none' | 'api-key' | 'bearer' | 'oauth';
  readonly credentialSecretId: string | null;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ConnectorResource {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    transport: record.transport,
    command: record.command,
    args: record.args,
    url: record.url,
    authType: record.authType,
    hasCredential: record.credentialSecretId !== null,
    enabled: record.enabled,
    createdBy: record.createdBy,
    ownerPrincipalId: record.ownerPrincipalId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** `GET /api/connectors` — this workspace's connectors. Never a credential value (§23). */
export async function listConnectors(store: WorkspaceConnectorsStore): Promise<ApiResult> {
  const connectors = await store.list();
  return { status: 200, body: { connectors } };
}

/** `GET /api/connectors/:id`. */
export async function getConnector(
  store: WorkspaceConnectorsStore,
  rawId: unknown,
): Promise<ApiResult> {
  const id = requireConnectorId(rawId);
  if (!id.ok) return id.result;
  const connector = await store.get(id.id);
  return connector === null ? connectorNotFound() : { status: 200, body: connector };
}

/** `DELETE /api/connectors/:id`. */
export async function deleteConnector(
  store: WorkspaceConnectorsStore,
  rawId: unknown,
): Promise<ApiResult> {
  const id = requireConnectorId(rawId);
  if (!id.ok) return id.result;
  const outcome = await store.delete(id.id);
  switch (outcome.kind) {
    case 'deleted':
      return { status: 204, body: null };
    case 'not-found':
      return connectorNotFound();
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** `PATCH /api/connectors/:id` rotates the saved credential without ever returning its value. */
export async function rotateConnectorCredential(
  store: WorkspaceConnectorsStore,
  rawId: unknown,
  rawBody: unknown,
): Promise<ApiResult> {
  const id = requireConnectorId(rawId);
  if (!id.ok) return id.result;
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    return problem(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  const body = rawBody as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'credential') {
    return problem(
      400,
      'invalid_body',
      'Credential rotation accepts exactly one field: a non-blank "credential" string.',
    );
  }
  const credential = body['credential'];
  if (typeof credential !== 'string' || credential.trim() === '') {
    return problem(400, 'invalid_credential', '"credential" must be a non-blank string.');
  }
  const outcome = await store.rotateCredential(id.id, credential);
  switch (outcome.kind) {
    case 'rotated':
      return { status: 200, body: outcome.connector };
    case 'not-found':
      return connectorNotFound();
    case 'credential-not-configured':
      return credentialNotConfigured();
    default: {
      const unreachable: never = outcome;
      return problem(500, 'unhandled_store_outcome', JSON.stringify(unreachable));
    }
  }
}

/** `true` for a body that is exactly `{ credential }` — the rotation shape the route kept. */
function isCredentialRotation(rawBody: unknown): boolean {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return false;
  const keys = Object.keys(rawBody);
  return keys.length === 1 && keys[0] === 'credential';
}

/** `true` when two argument lists differ; `null` and an empty list are the same empty list. */
function argsDiffer(current: readonly string[] | null, next: readonly string[] | null): boolean {
  const a = current ?? [];
  const b = next ?? [];
  return a.length !== b.length || a.some((value, index) => value !== b[index]);
}

/**
 * `true` when the patch changes where the saved credential would be sent: the `url` of a remote
 * connector, or the `command`/`args` of a stdio one (the process receives the credential as
 * `MCP_CREDENTIAL`). Nothing else a patch can carry moves the credential: the header or
 * environment variable it travels in is fixed by `(transport, authType)` (`credentialFieldFor`),
 * a caller cannot set a header or an environment variable, and the transport cannot change.
 * A value equal to the current one is not a retarget.
 */
function retargetsCredential(existing: ConnectorResource, patch: ConnectorFieldPatch): boolean {
  if (patch.url !== undefined && patch.url !== existing.url) return true;
  if (patch.command !== undefined && patch.command !== existing.command) return true;
  return patch.args !== undefined && argsDiffer(existing.args, patch.args);
}

type PatchRefusal =
  | { readonly kind: 'invalid'; readonly errors: readonly string[] }
  | { readonly kind: 'credential-not-configured' }
  | { readonly kind: 'credential-required-on-retarget' };

/** Why a patch cannot be applied to the connector it would change, or `null` when it can. */
function patchRefusal(
  existing: ConnectorResource,
  patch: ConnectorFieldPatch,
): PatchRefusal | null {
  const errors: string[] = [];
  if (existing.transport === 'stdio') {
    if (patch.url !== undefined) errors.push('"url" is not valid for a stdio connector');
  } else {
    if (patch.command !== undefined) errors.push('"command" is not valid for a remote connector');
    if (patch.args !== undefined) errors.push('"args" is not valid for a remote connector');
  }
  const nextAuthType = patch.authType ?? existing.authType;
  if (nextAuthType === 'none' && patch.credential !== undefined) {
    if (patch.authType === undefined && errors.length === 0) {
      return { kind: 'credential-not-configured' };
    }
    errors.push('"credential" must not be supplied when "authType" is "none"');
  }
  if (nextAuthType !== 'none' && !existing.hasCredential && patch.credential === undefined) {
    errors.push(
      `"credential" is required when "authType" changes from "none" to ${JSON.stringify(nextAuthType)}`,
    );
  }
  if (errors.length > 0) return { kind: 'invalid', errors };
  // ADR-0077 D5: a saved credential never follows its connector to a new destination. Secrets are
  // Owner-only, but `connectors: MANAGE` lets an Admin edit any member's connector — without this
  // rule an Admin could point a Builder's connector at a server of their own and collect the
  // Builder's credential on the next test-connection or run. The caller must supply the credential
  // the new destination receives.
  if (
    existing.hasCredential &&
    nextAuthType !== 'none' &&
    patch.credential === undefined &&
    retargetsCredential(existing, patch)
  ) {
    return { kind: 'credential-required-on-retarget' };
  }
  return null;
}

/**
 * `PATCH /api/connectors/:id` — a field update (S-20) or, for a body that is exactly
 * `{ credential }`, the credential rotation the route has always accepted. The body is
 * `ConnectorUpdateRequestSchema`: a key outside it — the owner, the workspace, the transport — is
 * `400 invalid_body`, so an update cannot move a connector's owner. The answer is the updated
 * connector, which says `hasCredential` and never carries the credential.
 */
export async function updateConnector(
  store: WorkspaceConnectorsStore,
  rawId: unknown,
  rawBody: unknown,
  checkConnectorEgress: CheckConnectorEgress = defaultCheckConnectorEgress,
): Promise<ApiResult> {
  const id = requireConnectorId(rawId);
  if (!id.ok) return id.result;
  const existing = await store.get(id.id);
  if (existing !== null && existing.transport === null) {
    return updateToolConnector(store, existing, rawBody, checkConnectorEgress);
  }
  if (isCredentialRotation(rawBody)) return rotateConnectorCredential(store, rawId, rawBody);
  const parsed = ConnectorUpdateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return problem(
      400,
      'invalid_body',
      'The connector could not be updated from this body.',
      parsed.error.issues.map((issue) =>
        issue.path.length === 0
          ? issue.message
          : `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    );
  }
  const data = parsed.data;
  const patch: ConnectorFieldPatch = {
    ...(data.name === undefined ? {} : { name: data.name }),
    ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
    ...(data.command === undefined ? {} : { command: data.command }),
    ...(data.args === undefined ? {} : { args: data.args }),
    ...(data.url === undefined ? {} : { url: data.url }),
    ...(data.authType === undefined ? {} : { authType: data.authType }),
    ...(data.credential === undefined ? {} : { credential: data.credential }),
  };
  if (existing === null) return connectorNotFound();
  const refusal = patchRefusal(existing, patch);
  if (refusal?.kind === 'credential-not-configured') return credentialNotConfigured();
  if (refusal?.kind === 'credential-required-on-retarget') {
    return problem(
      409,
      'credential_required_on_retarget',
      'This change moves where the connector sends its saved credential. Send a new "credential" ' +
        'in the same request; the saved one is never sent to a new destination.',
    );
  }
  if (refusal !== null) {
    return problem(
      400,
      'invalid_body',
      'The connector could not be updated from this body.',
      refusal.errors,
    );
  }
  const outcome = await store.update(id.id, patch);
  switch (outcome.kind) {
    case 'updated':
      return { status: 200, body: outcome.connector };
    case 'not-found':
      return connectorNotFound();
    case 'name-conflict':
      return nameConflict(outcome.name);
    default: {
      const unreachable: never = outcome;
      return problem(500, 'unhandled_store_outcome', JSON.stringify(unreachable));
    }
  }
}

function credentialNotConfigured(): ApiResult {
  return problem(
    409,
    'credential_not_configured',
    'This connector has no credential slot to rotate. Set an authenticated "authType" with the credential.',
  );
}

/**
 * `POST /api/connectors/:id/test-connection` — re-test a SAVED connector, resolving its stored
 * secret reference server-side. Never returns the resolved credential; `TestConnectionOutcome`
 * carries no field that could hold one.
 */
export async function testConnectionSaved(
  store: WorkspaceConnectorsProbeSource,
  rawId: unknown,
): Promise<ApiResult> {
  const id = requireConnectorId(rawId);
  if (!id.ok) return id.result;
  const config = await store.resolveForProbe(id.id);
  if (config === null) return connectorNotFound();
  // Same rule as `createConnector`'s dry-run branch above — never `process.env` (B1, round 2).
  const outcome = await testConnection(config, { baseEnv: restrictedBaseEnv() });
  return testResultBody(outcome);
}
