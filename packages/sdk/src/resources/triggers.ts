import {
  CreateTriggerResponseSchema,
  TriggerListResponseSchema,
  TriggerResponseSchema,
  TriggerSecretResponseSchema,
  type CreateTriggerRequest,
  type CreateTriggerResponse,
  type TriggerResource,
  type TriggerSecretResponse,
  type UpdateTriggerRequest,
} from '@indx-workspace/contracts/triggers';

import type { z } from 'zod';

import { segment, type HttpClient, type RequestOptions } from '../http.js';
import { wireOutputSchema } from './runs.js';

/** The schema a trigger's runs answer in: a Zod type, sent as JSON Schema 2020-12, or a JSON Schema object. */
type TriggerOutputSchema = z.ZodType | Readonly<Record<string, unknown>>;

/** What a caller supplies to create a trigger; `outputSchema` may be a Zod type (ADR-0154). */
export type CreateTriggerInput = CreateTriggerRequest extends infer Wire
  ? Wire extends unknown
    ? Omit<Wire, 'outputSchema'> & { readonly outputSchema?: TriggerOutputSchema }
    : never
  : never;

/** What a caller supplies to patch a trigger; `outputSchema: null` clears it (ADR-0154). */
export type UpdateTriggerInput = Omit<UpdateTriggerRequest, 'outputSchema'> & {
  readonly outputSchema?: TriggerOutputSchema | null;
};

function wireTriggerBody<Body extends { readonly outputSchema?: TriggerOutputSchema | null }>(
  input: Body,
): Omit<Body, 'outputSchema'> & {
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
} {
  const { outputSchema, ...rest } = input;
  if (outputSchema === undefined) return rest;
  return { ...rest, outputSchema: outputSchema === null ? null : wireOutputSchema(outputSchema) };
}

/**
 * `/api/triggers/**` — issue #1295, ADR-0144. A trigger starts a run of one agent without a person
 * at the keyboard: a `webhook` is a URL whose secret is its only authentication, a `schedule` is a
 * cron expression. A sender calls the `firePath` that `create` and `rotateSecret` return; there is
 * no SDK method for it, because the sender is a provider that holds no API key.
 *
 * Problem codes: `trigger_not_found` 404, `trigger_name_taken` 409,
 * `trigger_agent_not_runnable` 403, `trigger_owner_not_allowed` 403, `trigger_subject_not_allowed`
 * 403, `trigger_not_webhook` 409.
 */
export class TriggersClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every trigger of the workspace. No secret is in the answer, only `hasSecret`. */
  public async list(options: RequestOptions = {}): Promise<readonly TriggerResource[]> {
    const response = await this.#http.json({
      operation: 'triggers.list',
      method: 'GET',
      path: '/api/triggers',
      expect: [200],
      schema: TriggerListResponseSchema,
      signal: options.signal,
    });
    return response.triggers;
  }

  public async get(id: string, options: RequestOptions = {}): Promise<TriggerResource> {
    const response = await this.#http.json({
      operation: 'triggers.get',
      method: 'GET',
      path: `/api/triggers/${segment(id)}`,
      expect: [200],
      schema: TriggerResponseSchema,
      signal: options.signal,
    });
    return response.trigger;
  }

  /**
   * For a `webhook`, `secret` and `firePath` in the answer are the whole credential and this is the
   * only time they exist outside the caller's hands; narrow with `'secret' in answer`. A `schedule`
   * answers just `{ trigger }`, because it has no secret. `403 trigger_agent_not_runnable` when the
   * caller cannot run the agent, and `409 trigger_name_taken`. `outputSchema` makes every run the
   * trigger starts answer in that schema (ADR-0154); `422 engine_capability_unsupported` at firing
   * when the agent's engine cannot produce structured output. `subject` (1 to 256 characters) is
   * the caller every run the trigger starts acts for (ADR-0156): it becomes the `sub` of the identity
   * assertion a connector receives, and a webhook body never overrides it. Only a caller who may
   * create API keys may set it (`403 trigger_subject_not_allowed`).
   */
  public create(
    input: CreateTriggerInput,
    options: RequestOptions = {},
  ): Promise<CreateTriggerResponse> {
    return this.#http.json({
      operation: 'triggers.create',
      method: 'POST',
      path: '/api/triggers',
      body: wireTriggerBody(input),
      expect: [201],
      schema: CreateTriggerResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * `409 trigger_name_taken`; `zoomSecretToken` is write-only and `null` clears it. `outputSchema`
   * replaces the schema, `null` clears it, and leaving it out keeps it. `subject` works the same
   * way (ADR-0156). Setting it, or any change to a trigger that has one, needs a caller who may
   * create API keys (`403 trigger_subject_not_allowed`); anyone who may edit the trigger may clear it.
   */
  public async update(
    id: string,
    patch: UpdateTriggerInput,
    options: RequestOptions = {},
  ): Promise<TriggerResource> {
    const response = await this.#http.json({
      operation: 'triggers.update',
      method: 'PATCH',
      path: `/api/triggers/${segment(id)}`,
      body: wireTriggerBody(patch),
      expect: [200],
      schema: TriggerResponseSchema,
      signal: options.signal,
    });
    return response.trigger;
  }

  /** Delete the trigger; its URL stops answering at once. The answer is the trigger as it was. */
  public async remove(id: string, options: RequestOptions = {}): Promise<TriggerResource> {
    const response = await this.#http.json({
      operation: 'triggers.remove',
      method: 'DELETE',
      path: `/api/triggers/${segment(id)}`,
      expect: [200],
      schema: TriggerResponseSchema,
      signal: options.signal,
    });
    return response.trigger;
  }

  /**
   * Replace the URL secret. `secret` and `firePath` in the answer are shown once, and the old URL
   * stops working at once. Rotate when a URL may have reached an access log.
   * `409 trigger_not_webhook` for a `schedule` trigger, which has no secret.
   */
  public rotateSecret(id: string, options: RequestOptions = {}): Promise<TriggerSecretResponse> {
    return this.#http.json({
      operation: 'triggers.rotateSecret',
      method: 'POST',
      path: `/api/triggers/${segment(id)}/secret`,
      expect: [201],
      schema: TriggerSecretResponseSchema,
      signal: options.signal,
    });
  }
}
