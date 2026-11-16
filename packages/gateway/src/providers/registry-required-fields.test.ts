import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_PROVIDER_CONFIG_RULES,
  type ModelConnectionConfig,
} from '@indx-workspace/contracts/models';

import {
  ModelConnectionIncompleteError,
  PROVIDER_IDS,
  type RegisteredProviderId,
} from './registry.js';
import { context, LOCAL_ENDPOINT, providerOf } from './registry.test-support.js';

const FIXTURE_VALUES = {
  baseUrl: LOCAL_ENDPOINT,
  deployment: 'deployment-fixture',
  apiVersion: '2025-04-01-preview',
  projectId: 'my-project-123',
  location: 'global',
} satisfies Required<ModelConnectionConfig>;

type ConfigField = keyof ModelConnectionConfig;

/** Settings holding a fixture value for each of `fields`, and nothing else. */
function settingsWith(fields: readonly ConfigField[]): ModelConnectionConfig {
  return Object.fromEntries(fields.map((name) => [name, FIXTURE_VALUES[name]]));
}

/** What a registry row rejects with when asked to create a message under `settings`. */
async function rejectionFor(
  id: RegisteredProviderId,
  settings: ModelConnectionConfig,
): Promise<unknown> {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'fixture' }));
  const row = providerOf(id, { fetch: request, scripted: null });
  // Some rows refuse an incomplete connection by throwing before any promise exists.
  return Promise.resolve()
    .then(() =>
      row.createMessage({ model: 'model', max_tokens: 1, messages: [] }, context(id, settings)),
    )
    .then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
}

describe('registry rows against MODEL_PROVIDER_CONFIG_RULES', () => {
  it.each(PROVIDER_IDS)('%s requires exactly the fields the rules require', async (id) => {
    const required = MODEL_PROVIDER_CONFIG_RULES[id].required;

    for (const missing of required) {
      const others = required.filter((name) => name !== missing);
      const error = await rejectionFor(id, settingsWith(others));
      expect(error).toBeInstanceOf(ModelConnectionIncompleteError);
      expect(error).toMatchObject({ field: missing });
    }
    expect(await rejectionFor(id, settingsWith(required))).not.toBeInstanceOf(
      ModelConnectionIncompleteError,
    );
  });
});
