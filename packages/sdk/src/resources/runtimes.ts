import { z } from 'zod';

import {
  RuntimeConnectionListResponseSchema,
  RuntimeConnectionResourceSchema,
  RuntimeProfileListResponseSchema,
  RuntimeProfileResourceSchema,
  type CreateRuntimeConnectionInput,
  type CreateRuntimeProfileInput,
  type RuntimeConnectionResource,
  type RuntimeProfileResource,
  type UpdateRuntimeProfilePatch,
} from '@indx-workspace/contracts/runtimes';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/**
 * `/api/runtime-profiles/**` — spec §15.1. A profile is what an agent *references* for its
 * runtime; switching an agent to another profile is `agents.update(id, { runtimeProfileId })`.
 */
export class RuntimeProfilesClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(options: RequestOptions = {}): Promise<readonly RuntimeProfileResource[]> {
    const response = await this.#http.json({
      operation: 'runtimes.profiles.list',
      method: 'GET',
      path: '/api/runtime-profiles',
      expect: [200],
      schema: RuntimeProfileListResponseSchema,
      signal: options.signal,
    });
    return response.runtimeProfiles;
  }

  public async get(
    profileId: string,
    options: RequestOptions = {},
  ): Promise<RuntimeProfileResource> {
    return this.#http.json({
      operation: 'runtimes.profiles.get',
      method: 'GET',
      path: `/api/runtime-profiles/${segment(profileId)}`,
      expect: [200],
      schema: RuntimeProfileResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Create a profile. The server refuses, with `network_policy_not_enforceable` (422), a
   * `networkPolicy` the named driver cannot enforce in this deployment.
   */
  public create(
    input: CreateRuntimeProfileInput,
    options: RequestOptions = {},
  ): Promise<RuntimeProfileResource> {
    return this.#http.json({
      operation: 'runtimes.profiles.create',
      method: 'POST',
      path: '/api/runtime-profiles',
      body: input,
      expect: [201],
      schema: RuntimeProfileResourceSchema,
      signal: options.signal,
    });
  }

  public async update(
    profileId: string,
    patch: UpdateRuntimeProfilePatch,
    options: RequestOptions = {},
  ): Promise<RuntimeProfileResource> {
    return this.#http.json({
      operation: 'runtimes.profiles.update',
      method: 'PATCH',
      path: `/api/runtime-profiles/${segment(profileId)}`,
      body: patch,
      expect: [200],
      schema: RuntimeProfileResourceSchema,
      signal: options.signal,
    });
  }

  /** Delete a profile. An agent that referenced it falls back to no profile; nothing cascades. */
  public async remove(profileId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'runtimes.profiles.remove',
      method: 'DELETE',
      path: `/api/runtime-profiles/${segment(profileId)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/runtime-connections` — spec §14.9. A connection is an endpoint plus a credential, sealed
 * at creation; the API answers only with its existence, stored name and driver.
 */
export class RuntimeConnectionsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(options: RequestOptions = {}): Promise<readonly RuntimeConnectionResource[]> {
    const response = await this.#http.json({
      operation: 'runtimes.connections.list',
      method: 'GET',
      path: '/api/runtime-connections',
      expect: [200],
      schema: RuntimeConnectionListResponseSchema,
      signal: options.signal,
    });
    return response.runtimeConnections;
  }

  public create(
    input: CreateRuntimeConnectionInput,
    options: RequestOptions = {},
  ): Promise<RuntimeConnectionResource> {
    return this.#http.json({
      operation: 'runtimes.connections.create',
      method: 'POST',
      path: '/api/runtime-connections',
      body: input,
      expect: [201],
      schema: RuntimeConnectionResourceSchema,
      signal: options.signal,
    });
  }
}

/** Runtime profiles and connections — spec §5.4 `aw.runtimes`. */
export class RuntimesClient {
  public readonly profiles: RuntimeProfilesClient;
  public readonly connections: RuntimeConnectionsClient;

  public constructor(http: HttpClient) {
    this.profiles = new RuntimeProfilesClient(http);
    this.connections = new RuntimeConnectionsClient(http);
  }
}
