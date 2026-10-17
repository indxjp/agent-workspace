import {
  MintedApiKeyResponseSchema,
  type MintedApiKeyResponse,
} from '@indx-workspace/contracts/api-keys';
import {
  EndpointClientListResponseSchema,
  EndpointClientResponseSchema,
  type CreateEndpointClientRequest,
  type EndpointClientResource,
  type MintEndpointKeyRequest,
  type RotateEndpointClientSecretResponse,
  RotateEndpointClientSecretResponseSchema,
  type UpdateEndpointClientRequest,
} from '@indx-workspace/contracts/endpoint-clients';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/**
 * `/api/endpoint-clients/**` — issue #949, ADR-0134. An endpoint client names the one resource an
 * external platform may reach (an MCP project endpoint or one agent's A2A endpoint); its
 * endpoint-scoped API keys are the static bearer the platform presents.
 *
 * Problem codes: `endpoint_client_not_found` 404, `endpoint_client_name_taken` 409,
 * `endpoint_client_revoked` 409, `endpoint_client_agent_not_runnable` 403,
 * `endpoint_client_invalid` 400; `create` is also `403 api_key_not_permitted` for an API key.
 */
export class EndpointClientsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every endpoint client of the workspace, revoked ones included. */
  public async list(options: RequestOptions = {}): Promise<readonly EndpointClientResource[]> {
    const response = await this.#http.json({
      operation: 'endpointClients.list',
      method: 'GET',
      path: '/api/endpoint-clients',
      expect: [200],
      schema: EndpointClientListResponseSchema,
      signal: options.signal,
    });
    return response.endpointClients;
  }

  public async get(id: string, options: RequestOptions = {}): Promise<EndpointClientResource> {
    const response = await this.#http.json({
      operation: 'endpointClients.get',
      method: 'GET',
      path: `/api/endpoint-clients/${segment(id)}`,
      expect: [200],
      schema: EndpointClientResponseSchema,
      signal: options.signal,
    });
    return response.endpointClient;
  }

  /** Every listed agent must be runnable by the caller, else `403 endpoint_client_agent_not_runnable`. */
  public async create(
    input: CreateEndpointClientRequest,
    options: RequestOptions = {},
  ): Promise<EndpointClientResource> {
    const response = await this.#http.json({
      operation: 'endpointClients.create',
      method: 'POST',
      path: '/api/endpoint-clients',
      body: input,
      expect: [201],
      schema: EndpointClientResponseSchema,
      signal: options.signal,
    });
    return response.endpointClient;
  }

  public async update(
    id: string,
    patch: UpdateEndpointClientRequest,
    options: RequestOptions = {},
  ): Promise<EndpointClientResource> {
    const response = await this.#http.json({
      operation: 'endpointClients.update',
      method: 'PATCH',
      path: `/api/endpoint-clients/${segment(id)}`,
      body: patch,
      expect: [200],
      schema: EndpointClientResponseSchema,
      signal: options.signal,
    });
    return response.endpointClient;
  }

  /** Revoke the client and every key bound to it. Idempotent; the next request with a key is a `401`. */
  public async revoke(id: string, options: RequestOptions = {}): Promise<EndpointClientResource> {
    const response = await this.#http.json({
      operation: 'endpointClients.revoke',
      method: 'DELETE',
      path: `/api/endpoint-clients/${segment(id)}`,
      expect: [200],
      schema: EndpointClientResponseSchema,
      signal: options.signal,
    });
    return response.endpointClient;
  }

  /**
   * Mint an endpoint-scoped key. `key` in the answer is the whole credential and this is the only
   * time it exists outside the caller's hands. `409 endpoint_client_revoked` for a revoked client.
   */
  public mintKey(
    id: string,
    input: MintEndpointKeyRequest,
    options: RequestOptions = {},
  ): Promise<MintedApiKeyResponse> {
    return this.#http.json({
      operation: 'endpointClients.mintKey',
      method: 'POST',
      path: `/api/endpoint-clients/${segment(id)}/keys`,
      body: input,
      expect: [201],
      schema: MintedApiKeyResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Mint or rotate the OAuth client secret (ADR-0134 part 3). `clientSecret` in the answer is the
   * whole credential and this is the only time it exists outside the caller's hands; the old
   * secret stops working at once. `409 endpoint_client_revoked` for a revoked client,
   * `403 api_key_not_permitted` for an API key.
   */
  public rotateSecret(
    id: string,
    options: RequestOptions = {},
  ): Promise<RotateEndpointClientSecretResponse> {
    return this.#http.json({
      operation: 'endpointClients.rotateSecret',
      method: 'POST',
      path: `/api/endpoint-clients/${segment(id)}/secret`,
      expect: [201],
      schema: RotateEndpointClientSecretResponseSchema,
      signal: options.signal,
    });
  }
}
