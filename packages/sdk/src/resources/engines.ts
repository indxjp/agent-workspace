import { EngineListResponseSchema, type EngineDescriptor } from '@indx-workspace/contracts/engines';

import type { HttpClient, RequestOptions } from '../http.js';

/**
 * `/api/engines` — spec §5.15 (ENG-02c, ADR-0065). The engines this deployment can run an agent
 * on, with what each one can honour of the platform's portable agent configuration.
 *
 * Read-only, and it has no `get(id)`: the catalogue is short, every field of a descriptor travels
 * in the list, and a route that answered one engine by id would be a second way to ask the same
 * question. An engine is installed by deploying an adapter, never through the API, so there is no
 * write method either.
 *
 * This is the call to make **before** putting an engine on an agent policy: an `engine` this
 * deployment does not register is refused by `agents.replacePolicy` with
 * `400 unsupported_engine`, and the list here is what that refusal is taken against.
 */
export class EnginesClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every registered engine, in the deployment's catalogue order. */
  public async list(options: RequestOptions = {}): Promise<readonly EngineDescriptor[]> {
    const response = await this.#http.json({
      operation: 'engines.list',
      method: 'GET',
      path: '/api/engines',
      expect: [200],
      schema: EngineListResponseSchema,
      signal: options.signal,
    });
    return response.engines;
  }
}
