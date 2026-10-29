/**
 * The hooks that provision the Builder again where its model connection and runtime profile come
 * into existence (#1848 slice 1d): a completed first-run setup, and a model connection created or
 * changed. A refused write provisions nothing.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ModelsRuntime } from '../models/runtime';
import type { WorkspaceModelsStore } from '../models/store';
import type { SetupInput, SetupResult } from '../setup/runtime';
import {
  provisioningAfterConnectionWrites,
  provisioningAfterSetup,
  type BuilderProvisioner,
} from './builder-provisioning';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';

function provisioner() {
  const provision = vi.fn<BuilderProvisioner['provision']>(() => Promise.resolve());
  const provisionAll = vi.fn(() => Promise.resolve());
  const builders: BuilderProvisioner = { provision, provisionAll };
  return { builders, provision, provisionAll };
}

describe('provisioningAfterSetup', () => {
  it.each([
    [{ ok: false, status: 422, code: 'provider_test_failed', message: 'no' }, 0],
    [{ ok: true } as unknown as SetupResult, 1],
  ] as const)('provisions every Builder only after a completed setup', async (result, calls) => {
    const { builders, provisionAll } = provisioner();
    const setup = provisioningAfterSetup(
      { kind: 'serving', runtime: { complete: () => Promise.resolve(result as SetupResult) } },
      builders,
    );
    if (setup.kind !== 'serving') throw new Error('the hook keeps a serving setup serving');
    expect(await setup.runtime.complete({} as SetupInput)).toBe(result);
    expect(provisionAll).toHaveBeenCalledTimes(calls);
  });
});

describe('provisioningAfterConnectionWrites', () => {
  it('provisions the workspace after a created or updated connection, and not after a refusal', async () => {
    const { builders, provision } = provisioner();
    const outcomes = [{ kind: 'name-conflict', name: 'default' }, { kind: 'created' }];
    const store = {
      create: () => Promise.resolve(outcomes.shift()),
      update: () => Promise.resolve({ kind: 'updated' }),
    } as unknown as WorkspaceModelsStore;
    const models = provisioningAfterConnectionWrites(
      {
        kind: 'serving',
        runtime: { models: { forWorkspace: () => store } } as unknown as ModelsRuntime,
      },
      builders,
    );
    if (models.kind !== 'serving') throw new Error('the hook keeps a serving API serving');
    const bound = models.runtime.models.forWorkspace(WORKSPACE);
    const input = { name: 'default', provider: 'anthropic' as const, apiKey: 'k', config: {} };

    await bound.create(input);
    expect(provision).not.toHaveBeenCalled();
    await bound.create(input);
    await bound.update('id', { name: 'default' });
    expect(provision.mock.calls).toEqual([[WORKSPACE], [WORKSPACE]]);
  });
});
