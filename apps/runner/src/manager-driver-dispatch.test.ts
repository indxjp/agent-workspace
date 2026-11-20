/**
 * `managerDriverOptions` for every runtime driver id (refactoring part 11, step 1): which builder
 * each id reaches, which ids the manager does not serve, and the stateless rule (ADR-0126), pinned
 * before the if-chain becomes a table. Each builder is recognised by what it refuses first when its
 * own settings are missing, or by returning options when it needs none beyond an engine image.
 */
import type { RuntimeDriverId } from '@agent-workspace/runtime/driver';
import { describe, expect, it } from 'vitest';

import { managerDriverOptions, RuntimeDriverConfigurationError } from './manager-settings.js';

/** Every id in the order of `RUNTIME_DRIVERS` (`@indx-workspace/contracts/runtimes`). */
const ALL_DRIVERS = [
  'local',
  'sandbox-runtime',
  'docker',
  'kubernetes',
  'gke-agent-sandbox',
  'aca-sessions',
  'aws-agentcore',
  'aws-ecs',
  'cloud-run-sandbox',
  'cloud-run-service',
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
] as const satisfies readonly RuntimeDriverId[];

/** A driver id added to `RuntimeDriverId` and left out of `ALL_DRIVERS` fails the typecheck. */
type Unlisted = Exclude<RuntimeDriverId, (typeof ALL_DRIVERS)[number]>;
const everyDriverListed: [Unlisted] extends [never] ? true : never = true;

const IMAGE = {
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: `example.test/runtime@sha256:${'a'.repeat(64)}`,
};
const STATELESS_REFUSAL =
  /RUNNER_MANAGER_STATELESS is served by the external and vercel-sandbox drivers only/u;

/** What each id reaches with only an engine image set: options, or its builder's first refusal. */
const SERVED: Readonly<Record<string, RegExp | 'options'>> = {
  '': 'options',
  docker: 'options',
  kubernetes: /RUNTIME_KUBERNETES_NAMESPACE must be set when RUNTIME_DRIVER is kubernetes/u,
  'aca-sessions': /ACA_SESSION_POOL_ENDPOINT must be set when RUNTIME_DRIVER is aca-sessions/u,
  'cloud-run-service':
    /RUNTIME_DRIVER=cloud-run-service needs RUNTIME_NETWORK and RUNTIME_SUBNETWORK/u,
  external: /EXTERNAL_PROVIDER must be e2b when RUNTIME_DRIVER is external/u,
  'vercel-sandbox': /VERCEL_TEAM_ID must be set when RUNTIME_DRIVER is vercel-sandbox/u,
  'cloudflare-sandbox': /CLOUDFLARE_SANDBOX_BRIDGE_URL must be an https URL/u,
};

/** The ids the stateless mode serves (ADR-0126). */
const STATELESS_SERVED = new Set(['external', 'vercel-sandbox']);

/** Options, never an error: an error for an unknown id also carries a `driver` property. */
function expectOptions(result: unknown): void {
  expect(result).not.toBeInstanceOf(Error);
  expect(result).toHaveProperty('driver');
}

function outcome(env: Readonly<Record<string, string>>): unknown {
  try {
    return managerDriverOptions(env);
  } catch (error) {
    return error;
  }
}

describe('managerDriverOptions for every driver id', () => {
  it('lists every RuntimeDriverId', () => {
    expect(everyDriverListed).toBe(true);
    expect(new Set(ALL_DRIVERS).size).toBe(13);
  });

  it.each([...ALL_DRIVERS, '', 'not-a-driver'])(
    'dispatches %j to its builder or refuses it',
    (id) => {
      const result = outcome({ ...IMAGE, RUNTIME_DRIVER: id });
      const expected = SERVED[id];
      if (expected === undefined) {
        expect(result).toBeInstanceOf(RuntimeDriverConfigurationError);
      } else if (expected === 'options') {
        expectOptions(result);
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(result).not.toBeInstanceOf(RuntimeDriverConfigurationError);
        expect((result as Error).message).toMatch(expected);
      }
    },
  );

  it('trims the id: " docker " is docker', () => {
    expectOptions(outcome({ ...IMAGE, RUNTIME_DRIVER: ' docker ' }));
  });

  it.each([...ALL_DRIVERS, '', 'not-a-driver'])(
    'with RUNNER_MANAGER_STATELESS set, %j is refused unless the stateless mode serves it',
    (id) => {
      const result = outcome({ ...IMAGE, RUNTIME_DRIVER: id, RUNNER_MANAGER_STATELESS: 'true' });
      expect(result).toBeInstanceOf(Error);
      const message = (result as Error).message;
      if (STATELESS_SERVED.has(id)) {
        expect(message).not.toMatch(STATELESS_REFUSAL);
        expect(message).toMatch(SERVED[id] as RegExp);
      } else {
        // Checked before the id is looked up, so an id the manager does not serve gets it too.
        expect(result).not.toBeInstanceOf(RuntimeDriverConfigurationError);
        expect(message).toMatch(STATELESS_REFUSAL);
      }
    },
  );

  it('ignores a blank RUNNER_MANAGER_STATELESS', () => {
    expectOptions(outcome({ ...IMAGE, RUNTIME_DRIVER: 'docker', RUNNER_MANAGER_STATELESS: '  ' }));
  });
});
