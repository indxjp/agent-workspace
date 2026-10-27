/**
 * Pins every web-side list of runtime driver ids to the contracts' `RUNTIME_DRIVERS`. The pin
 * lives here because contracts may not import from the workspace and web may not import the runner;
 * the runner's own list is pinned in `apps/runner/src/manager-start.test.ts`.
 */
import type { RuntimeDriverId } from '@agent-workspace/runtime/driver';
import { RUNTIME_DRIVERS, type RuntimeDriver } from '@indx-workspace/contracts/runtimes';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { RUNTIME_OPTIONS } from '../../components/runtimes/model';
import { unavailableRuntimeRegistryEntries } from '../composition/services';
import { RESTRICTED_PROXY_DRIVERS, networkPolicyMapping } from './network-policy';

const CATALOGUE: readonly string[] = [...RUNTIME_DRIVERS].sort();

describe('runtime driver id lists', () => {
  it('packages/runtime spells the same union as the contracts', () => {
    expectTypeOf<RuntimeDriverId>().toEqualTypeOf<RuntimeDriver>();
  });

  it('the picker offers every driver', () => {
    expect(RUNTIME_OPTIONS.map((option) => option.id).sort()).toEqual(CATALOGUE);
  });

  it('the network-policy mapping names only catalogue drivers', () => {
    const drivers = networkPolicyMapping.map((row) => row.driver);
    expect(drivers.filter((driver) => !CATALOGUE.includes(driver))).toEqual([]);
  });

  it('the restricted-proxy drivers are catalogue drivers', () => {
    expect([...RESTRICTED_PROXY_DRIVERS].filter((driver) => !CATALOGUE.includes(driver))).toEqual(
      [],
    );
  });

  it('the static registry rows plus the drivers without one are the whole catalogue', () => {
    // `local` is the managed row here; the others have a live row or no static row of their own.
    const withoutStaticRow = ['local', 'docker', 'cloud-run-service', 'cloudflare-sandbox'];
    const ids = unavailableRuntimeRegistryEntries('local').map(([id]) => id);
    expect([...ids, ...withoutStaticRow].sort()).toEqual(CATALOGUE);
  });
});
