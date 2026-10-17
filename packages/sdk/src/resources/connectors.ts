import { z } from 'zod';

import {
  ConnectorListResponseSchema,
  ConnectorResourceSchema,
  TestConnectionOutcomeSchema,
  type ConnectorAuthType,
  type ConnectorResource,
  type ConnectorTransport,
  type CreateConnectorInput,
  type RotateConnectorCredentialInput,
  type TestConnectionOutcome,
  type UpdateConnectorInput,
} from '@indx-workspace/contracts/connectors';
import type {
  CreateOpenApiConnectorInput,
  CreatePostgresConnectorInput,
} from '@indx-workspace/contracts/tool-connectors';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/**
 * The body `POST /api/connectors` parses. The optional keys are absent, never `undefined`, so the
 * JSON the route sees carries exactly the fields the caller gave. `dryRun: true` turns the same
 * body into a connection test that persists nothing.
 */
interface ConnectorWireBody {
  readonly name: string;
  readonly transport: ConnectorTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly authType?: ConnectorAuthType;
  readonly credential?: string;
  readonly dryRun?: true;
}

function connectorWireBody(input: CreateConnectorInput): ConnectorWireBody {
  const endpoint: Pick<ConnectorWireBody, 'command' | 'args' | 'url'> =
    input.transport === 'stdio'
      ? { command: input.command, ...(input.args === undefined ? {} : { args: input.args }) }
      : { url: input.url };
  return {
    name: input.name,
    transport: input.transport,
    ...endpoint,
    ...(input.authType === undefined ? {} : { authType: input.authType }),
    ...(input.credential === undefined ? {} : { credential: input.credential }),
  };
}

/** An MCP field update rebuilt key by key, so only the fields the caller gave are sent. */
function mcpPatchBody(patch: UpdateConnectorInput): UpdateConnectorInput {
  return {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.url === undefined ? {} : { url: patch.url }),
    ...(patch.command === undefined ? {} : { command: patch.command }),
    ...(patch.args === undefined ? {} : { args: patch.args === null ? null : [...patch.args] }),
    ...(patch.authType === undefined ? {} : { authType: patch.authType }),
    ...(patch.credential === undefined ? {} : { credential: patch.credential }),
  };
}

/**
 * The body that creates, or re-registers, an `openapi` or `postgres` connector (C15): the
 * contract's create body without `dryRun`.
 */
export type ToolConnectorBody =
  Omit<CreateOpenApiConnectorInput, 'dryRun'> | Omit<CreatePostgresConnectorInput, 'dryRun'>;

/**
 * The tool connector body the route parses, picked key by key like {@link connectorWireBody}: a
 * key the type does not name, `dryRun` included, is never sent, and an absent key stays absent.
 */
function toolWireBody(input: ToolConnectorBody): ToolConnectorBody {
  if (input.kind === 'openapi') {
    return {
      kind: input.kind,
      name: input.name,
      document: input.document,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      allow: input.allow,
      ...(input.auth === undefined ? {} : { auth: input.auth }),
      ...(input.credential === undefined ? {} : { credential: input.credential }),
    };
  }
  return {
    kind: input.kind,
    name: input.name,
    credential: input.credential,
    tables: input.tables,
    readOnly: input.readOnly,
    ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
  };
}

/**
 * `/api/connectors/**` — spec §5.8. A connector's credential is write-only: it travels in the
 * create body and in a rotation, and every response is validated by a schema that has no field
 * it could occupy. `update` changes fields; `rotateCredential` replaces only the credential.
 */
export class ConnectorsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every connector of the caller's workspace. */
  public async list(options: RequestOptions = {}): Promise<readonly ConnectorResource[]> {
    const response = await this.#http.json({
      operation: 'connectors.list',
      method: 'GET',
      path: '/api/connectors',
      expect: [200],
      schema: ConnectorListResponseSchema,
      signal: options.signal,
    });
    return response.connectors;
  }

  /** `404 connector_not_found`, including for malformed and cross-workspace ids. */
  public async get(connectorId: string, options: RequestOptions = {}): Promise<ConnectorResource> {
    return this.#http.json({
      operation: 'connectors.get',
      method: 'GET',
      path: `/api/connectors/${segment(connectorId)}`,
      expect: [200],
      schema: ConnectorResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Save a connector: an MCP one, or an `openapi` or `postgres` one when the body has `kind`
   * (C15). `400 invalid_body` names each refused field in `details`;
   * `409 connector_name_conflict` when the workspace already holds the name. The credential, when
   * given, is sealed as a secret and never returned.
   */
  public create(
    input: CreateConnectorInput | ToolConnectorBody,
    options: RequestOptions = {},
  ): Promise<ConnectorResource> {
    return this.#http.json({
      operation: 'connectors.create',
      method: 'POST',
      path: '/api/connectors',
      body: 'kind' in input ? toolWireBody(input) : connectorWireBody(input),
      expect: [201],
      schema: ConnectorResourceSchema,
      signal: options.signal,
    });
  }

  /** `404 connector_not_found` for an id the workspace does not hold; otherwise no body. */
  public async remove(connectorId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'connectors.remove',
      method: 'DELETE',
      path: `/api/connectors/${segment(connectorId)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }

  /**
   * Replace the saved credential in place; the connector's id and fields stay. `400
   * invalid_credential` for a blank value, `409 credential_not_configured` when the connector's
   * `authType` is `none`, `404 connector_not_found`.
   */
  public async rotateCredential(
    connectorId: string,
    credential: string,
    options: RequestOptions = {},
  ): Promise<ConnectorResource> {
    const body: RotateConnectorCredentialInput = { credential };
    return this.#http.json({
      operation: 'connectors.rotateCredential',
      method: 'PATCH',
      path: `/api/connectors/${segment(connectorId)}`,
      body,
      expect: [200],
      schema: ConnectorResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Change a connector's fields: `name`, `enabled`, `url` (remote) or `command`/`args` (stdio),
   * `authType` with `credential`. The owner and the transport cannot change — a body naming them
   * is `400 invalid_body`. A new `url`, `command` or `args` on a connector with a saved credential
   * must carry a new `credential`: the saved one never follows the connector to a new destination.
   * The answer says `hasCredential` and never carries the credential.
   * `409 connector_name_conflict`, `409 credential_not_configured`,
   * `409 credential_required_on_retarget`, `404 connector_not_found`.
   *
   * An `openapi` or `postgres` connector is updated with its whole create body, `kind` and
   * credential included, which registers it again in place (C15); there is no partial patch and no
   * credential-only rotation for those kinds.
   */
  public async update(
    connectorId: string,
    patch: UpdateConnectorInput | ToolConnectorBody,
    options: RequestOptions = {},
  ): Promise<ConnectorResource> {
    return this.#http.json({
      operation: 'connectors.update',
      method: 'PATCH',
      path: `/api/connectors/${segment(connectorId)}`,
      body: 'kind' in patch ? toolWireBody(patch) : mcpPatchBody(patch),
      expect: [200],
      schema: ConnectorResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Run the MCP handshake against a saved connector with its stored credential. A failed probe
   * is still a `200` whose `ok` is `false`; `404 connector_not_found` is the one refusal. A
   * `stdio` connector answers `stdio-probe-unavailable` (ADR-0045), never a fake success.
   */
  public async test(
    connectorId: string,
    options: RequestOptions = {},
  ): Promise<TestConnectionOutcome> {
    return this.#http.json({
      operation: 'connectors.test',
      method: 'POST',
      path: `/api/connectors/${segment(connectorId)}/test-connection`,
      expect: [200],
      schema: TestConnectionOutcomeSchema,
      signal: options.signal,
    });
  }

  /**
   * Test a connector before saving it: the create body with `dryRun: true`, which the route
   * validates exactly as a create (`400 invalid_body`) and then probes without persisting
   * anything. The credential is used for this one probe and discarded.
   */
  public testDraft(
    input: CreateConnectorInput,
    options: RequestOptions = {},
  ): Promise<TestConnectionOutcome> {
    const body: ConnectorWireBody = { ...connectorWireBody(input), dryRun: true };
    return this.#http.json({
      operation: 'connectors.testDraft',
      method: 'POST',
      path: '/api/connectors',
      body,
      expect: [200],
      schema: TestConnectionOutcomeSchema,
      signal: options.signal,
    });
  }

  /**
   * Check an `openapi` or `postgres` connector body without saving it (C15): the body with
   * `dryRun: true`, sent as `POST /api/connectors`, or as `PATCH /api/connectors/:id` when
   * `connectorId` names the connector it would replace. The server refuses it exactly as it would
   * the save — `422 connector_spec_invalid` names a document problem in `details` — and otherwise
   * answers a `TestConnectionOutcome` and writes nothing. The credential is checked and discarded.
   */
  public checkTool(
    input: ToolConnectorBody,
    options: RequestOptions & { readonly connectorId?: string | undefined } = {},
  ): Promise<TestConnectionOutcome> {
    const { connectorId } = options;
    return this.#http.json({
      operation: 'connectors.checkTool',
      method: connectorId === undefined ? 'POST' : 'PATCH',
      path:
        connectorId === undefined ? '/api/connectors' : `/api/connectors/${segment(connectorId)}`,
      body: { ...toolWireBody(input), dryRun: true },
      expect: [200],
      schema: TestConnectionOutcomeSchema,
      signal: options.signal,
    });
  }
}
