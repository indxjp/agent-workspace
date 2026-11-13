import {
  MODEL_PROVIDER_CONFIG_RULES,
  type ModelConnectionConfig,
} from '@indx-workspace/contracts/models';
import { ModelConnectionIncompleteError } from '../types.js';
import type { ModelProvider, RequestContext } from '../types.js';
import type { RegisteredProviderId } from './registry-ids.js';

/** A setting of the selected model connection, or `undefined` when it is absent or blank. */
export function optionalSetting(
  context: RequestContext,
  name: keyof ModelConnectionConfig,
): string | undefined {
  const value = context.settings[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function requiredSetting(
  context: RequestContext,
  name: keyof ModelConnectionConfig,
  providerId: RegisteredProviderId,
): string {
  const value = optionalSetting(context, name);
  if (value === undefined) throw new ModelConnectionIncompleteError(providerId, name);
  return value;
}

/**
 * Check `MODEL_PROVIDER_CONFIG_RULES[id].required` before an adapter is built, so a stored
 * connection that predates a rule (or a row that forgets to read a field) is a typed refusal
 * rather than an opaque 500.
 */
export function withRequiredConfig<Adapter extends ModelProvider>(
  id: RegisteredProviderId,
  create: (context: RequestContext) => Adapter,
): (context: RequestContext) => Adapter {
  return (context) => {
    for (const field of MODEL_PROVIDER_CONFIG_RULES[id].required) {
      if (optionalSetting(context, field) === undefined) {
        throw new ModelConnectionIncompleteError(id, field);
      }
    }
    return create(context);
  };
}
