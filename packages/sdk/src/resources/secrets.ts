import {
  SecretListResponseSchema,
  SecretResourceSchema,
  type CreateSecretInput,
  type ReplaceSecretInput,
  type SecretResource,
} from '@indx-workspace/contracts/secrets';

import { z } from 'zod';

import { ApiProblemError } from '../errors.js';
import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/**
 * `/api/secrets/**` — spec §5.5. Secrets are write-only: a value travels in a request body and
 * never in a response, so every method here returns metadata validated by a schema that has no
 * field the value could occupy. There is no read of a single secret.
 */
export class SecretsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Every secret of the caller's workspace, metadata only. With `name`, only the secret of that
   * exact name; `404 secret_not_found` when there is none (ADR-0114 S4).
   */
  public async list(
    options: RequestOptions & { readonly name?: string } = {},
  ): Promise<readonly SecretResource[]> {
    const response = await this.#http.json({
      operation: 'secrets.list',
      method: 'GET',
      path:
        options.name === undefined
          ? '/api/secrets'
          : `/api/secrets?name=${encodeURIComponent(options.name)}`,
      expect: [200],
      schema: SecretListResponseSchema,
      signal: options.signal,
    });
    return response.secrets;
  }

  /**
   * Store a new secret. `400 invalid_body` names each field the route refused (name shape, empty or
   * oversized value, unknown key); `409 secret_name_conflict` when the workspace already holds the
   * name.
   */
  public create(input: CreateSecretInput, options: RequestOptions = {}): Promise<SecretResource> {
    const body: CreateSecretInput = { name: input.name, value: input.value };
    return this.#http.json({
      operation: 'secrets.create',
      method: 'POST',
      path: '/api/secrets',
      body,
      expect: [201],
      schema: SecretResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Rotate a secret's value in place; its name and id stay. `400 invalid_secret_id` for a path id
   * that is not a UUID, `400 invalid_body` for an empty or oversized value, `404 secret_not_found`
   * for an id the workspace does not hold. `{ name }` resolves the exact name first (one extra
   * `GET /api/secrets?name=`), and the same `404` answers a name the workspace does not hold.
   */
  public async replace(
    secret: string | { readonly name: string },
    value: string,
    options: RequestOptions = {},
  ): Promise<SecretResource> {
    const body: ReplaceSecretInput = { value };
    // Select by exact name: an older server ignores `?name=` and returns every secret.
    const secretId =
      typeof secret === 'string'
        ? secret
        : (await this.list({ ...options, name: secret.name })).find(
            (entry) => entry.name === secret.name,
          )?.id;
    if (secretId === undefined) {
      throw new ApiProblemError({
        status: 404,
        problem: {
          code: 'secret_not_found',
          message: 'This workspace has no secret with that id or name.',
        },
      });
    }
    return this.#http.json({
      operation: 'secrets.replace',
      method: 'PUT',
      path: `/api/secrets/${segment(secretId)}`,
      body,
      expect: [200],
      schema: SecretResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Delete a secret nothing references. `409 secret_in_use` while a connector authenticates with
   * it or a model connection owns it — `details` name each as `connector:<id>` or
   * `model-connection:<id>` (`parseInUseReferrers`), and nothing is deleted. `404
   * secret_not_found` for an id the workspace does not hold; `403` for every role but Owner.
   */
  public async remove(secretId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'secrets.remove',
      method: 'DELETE',
      path: `/api/secrets/${segment(secretId)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}
