import {
  DeleteModelConnectionResponseSchema,
  DiscoveredModelsResponseSchema,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
  type CreateModelConnectionInput,
  type DeleteModelConnectionResponse,
  type DiscoveredModelsResponse,
  type ModelConnectionResource,
  type ModelConnectionTestOutcome,
  type RotateModelConnectionCredentialInput,
  type UpdateModelConnectionPatch,
} from '@indx-workspace/contracts/models';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/** `/api/model-connections/**` — spec §5.3. The credential goes in and never comes out. */
export class ModelConnectionsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(options: RequestOptions = {}): Promise<readonly ModelConnectionResource[]> {
    const response = await this.#http.json({
      operation: 'models.connections.list',
      method: 'GET',
      path: '/api/model-connections',
      expect: [200],
      schema: ModelConnectionListResponseSchema,
      signal: options.signal,
    });
    return response.models;
  }

  public async get(
    connectionId: string,
    options: RequestOptions = {},
  ): Promise<ModelConnectionResource> {
    return this.#http.json({
      operation: 'models.connections.get',
      method: 'GET',
      path: `/api/model-connections/${segment(connectionId)}`,
      expect: [200],
      schema: ModelConnectionResourceSchema,
      signal: options.signal,
    });
  }

  /** Store a connection and its credential in one step; the answer never echoes the key. */
  public create(
    input: CreateModelConnectionInput,
    options: RequestOptions = {},
  ): Promise<ModelConnectionResource> {
    return this.#http.json({
      operation: 'models.connections.create',
      method: 'POST',
      path: '/api/model-connections',
      body: input,
      expect: [201],
      schema: ModelConnectionResourceSchema,
      signal: options.signal,
    });
  }

  /** Rename or reconfigure; the provider is immutable and the credential has its own route. */
  public async update(
    connectionId: string,
    patch: UpdateModelConnectionPatch,
    options: RequestOptions = {},
  ): Promise<ModelConnectionResource> {
    return this.#http.json({
      operation: 'models.connections.update',
      method: 'PATCH',
      path: `/api/model-connections/${segment(connectionId)}`,
      body: patch,
      expect: [200],
      schema: ModelConnectionResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Delete the connection. The server does not refuse while agents reference it: their
   * reference is cleared and they are named in `referencedBy`, so a caller can warn or reassign.
   */
  public async remove(
    connectionId: string,
    options: RequestOptions = {},
  ): Promise<DeleteModelConnectionResponse> {
    return this.#http.json({
      operation: 'models.connections.remove',
      method: 'DELETE',
      path: `/api/model-connections/${segment(connectionId)}`,
      expect: [200],
      schema: DeleteModelConnectionResponseSchema,
      signal: options.signal,
    });
  }

  /** Replace the stored credential (`204`, no body): the one write path to it after creation. */
  public async rotateCredential(
    connectionId: string,
    apiKey: string,
    options: RequestOptions = {},
  ): Promise<void> {
    const body: RotateModelConnectionCredentialInput = { apiKey };
    await this.#http.send({
      operation: 'models.connections.rotateCredential',
      method: 'POST',
      path: `/api/model-connections/${segment(connectionId)}/credential`,
      body,
      expect: [204],
      signal: options.signal,
    });
  }

  /**
   * Probe the provider with the stored credential. A failed probe is a `502` that carries the
   * same outcome shape (`ok: false`), so it resolves rather than throws; only a missing
   * connection or a refused request is an `ApiProblemError`.
   */
  public async test(
    connectionId: string,
    options: RequestOptions = {},
  ): Promise<ModelConnectionTestOutcome> {
    return this.#http.json({
      operation: 'models.connections.test',
      method: 'POST',
      path: `/api/model-connections/${segment(connectionId)}/test`,
      expect: [200, 502],
      schema: ModelConnectionTestOutcomeSchema,
      signal: options.signal,
    });
  }
}

/** `aw.models` — model connections and the models they offer (spec §5.3). */
export class ModelsClient {
  readonly #http: HttpClient;
  public readonly connections: ModelConnectionsClient;

  public constructor(http: HttpClient) {
    this.#http = http;
    this.connections = new ModelConnectionsClient(http);
  }

  /**
   * Every model every ready connection offers (`GET /api/models`), one row per
   * `(connectionId, providerModelId)`, plus `unavailable` when a discovery call failed.
   */
  public discover(options: RequestOptions = {}): Promise<DiscoveredModelsResponse> {
    return this.#http.json({
      operation: 'models.discover',
      method: 'GET',
      path: '/api/models',
      expect: [200],
      schema: DiscoveredModelsResponseSchema,
      signal: options.signal,
    });
  }
}
