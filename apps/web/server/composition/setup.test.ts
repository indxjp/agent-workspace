import { describe, expect, it } from 'vitest';

import {
  enforceableRuntimeNetworkPolicies,
  runtimeVerificationNetworkPolicy,
  setupRuntimeNetworkPolicy,
} from './config';
import {
  selectGeneralReconciliation,
  selectSetupSeededModel,
  selectWorkspaceDefaultReconciliation,
  type SetupConnectionView,
  type SetupProfileView,
} from './setup';

describe('selectSetupSeededModel', () => {
  it('uses the newest dated Anthropic release when discovery omits the stable alias', () => {
    expect(
      selectSetupSeededModel('anthropic', [
        'claude-opus-5',
        'claude-sonnet-4-5-20240929',
        'claude-sonnet-4-5-20250929',
      ]),
    ).toBe('claude-sonnet-4-5-20250929');
  });

  it('prefers the stable alias and rejects unrelated models', () => {
    expect(
      selectSetupSeededModel('anthropic', ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5']),
    ).toBe('claude-sonnet-4-5');
    expect(selectSetupSeededModel('anthropic', ['claude-sonnet-5'])).toBeNull();
  });
});

describe('the profile first-run setup creates', () => {
  /**
   * `setup.ts` seeds `<driver> default` with {@link setupRuntimeNetworkPolicy}, and the Runtimes
   * screen may later PATCH that same row. Both sides must agree, so the seeded policy has to be
   * one the registry reports as enforceable — otherwise setup itself would create the profile the
   * API now refuses (issue #220).
   */
  const seededPolicyIsEnforceable = (
    driver: string,
    env: Readonly<Record<string, string | undefined>>,
  ): boolean => {
    const enforceable = enforceableRuntimeNetworkPolicies(
      driver,
      runtimeVerificationNetworkPolicy(env),
      (env['AGENT_WORKSPACE_EGRESS_PROXY_IMAGE'] ?? '') !== '',
    );
    return enforceable === null || enforceable.includes(setupRuntimeNetworkPolicy(driver, env));
  };

  it('keeps the pool-wide policy on an egress-enabled ACA preview', () => {
    const env = { RUNTIME_VERIFICATION_NETWORK_POLICY: 'open' };
    expect(setupRuntimeNetworkPolicy('aca-sessions', env)).toBe('open');
    expect(enforceableRuntimeNetworkPolicies('aca-sessions', 'open', false)).toEqual(['open']);
    expect(seededPolicyIsEnforceable('aca-sessions', env)).toBe(true);
  });

  it('refuses to report restricted for an ACA pool, exactly as first-run setup does', () => {
    expect(() => enforceableRuntimeNetworkPolicies('aca-sessions', 'restricted', false)).toThrow(
      /restricted/u,
    );
    expect(enforceableRuntimeNetworkPolicies('kubernetes', 'restricted', false)).toBeNull();
  });

  it('accepts restricted on docker only with an egress proxy, so it is refused at save (BH061-030)', () => {
    expect(enforceableRuntimeNetworkPolicies('docker', 'none', false)).toEqual(['none', 'open']);
    expect(enforceableRuntimeNetworkPolicies('docker', 'none', true)).toBeNull();
  });

  it('seeds a policy the registry accepts for every driver and default environment', () => {
    for (const driver of ['local', 'docker', 'kubernetes', 'aca-sessions']) {
      expect(seededPolicyIsEnforceable(driver, {})).toBe(true);
      expect(
        seededPolicyIsEnforceable(driver, { AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: 'proxy@sha256:1' }),
      ).toBe(true);
    }
  });
});

const SETUP_CONNECTION: SetupConnectionView = {
  id: 'conn-setup',
  name: 'anthropic default',
  provider: 'anthropic',
  ready: true,
  credentialRejected: false,
};
const OLD_SETUP_CONNECTION: SetupConnectionView = {
  id: 'conn-old-setup',
  name: 'openai default',
  provider: 'openai',
  ready: true,
  credentialRejected: false,
};
const ADMIN_CONNECTION: SetupConnectionView = {
  id: 'conn-admin',
  name: 'Team Anthropic',
  provider: 'anthropic',
  ready: true,
  credentialRejected: false,
};
const CONNECTIONS = [SETUP_CONNECTION, OLD_SETUP_CONNECTION, ADMIN_CONNECTION];
const SETUP_SELECTION = { connectionId: 'conn-setup', model: 'claude-sonnet-4-5' };

describe('selectWorkspaceDefaultReconciliation (issue #393)', () => {
  it("writes setup's selection when the workspace has no default", () => {
    expect(selectWorkspaceDefaultReconciliation(null, CONNECTIONS, SETUP_SELECTION)).toEqual(
      SETUP_SELECTION,
    );
  });

  it('replaces a default whose connection is missing, not ready, or has its key rejected', () => {
    expect(
      selectWorkspaceDefaultReconciliation(
        { connectionId: 'conn-deleted', model: 'm' },
        CONNECTIONS,
        SETUP_SELECTION,
      ),
    ).toEqual(SETUP_SELECTION);
    expect(
      selectWorkspaceDefaultReconciliation(
        { connectionId: 'conn-admin', model: 'm' },
        [SETUP_CONNECTION, { ...ADMIN_CONNECTION, ready: false }],
        SETUP_SELECTION,
      ),
    ).toEqual(SETUP_SELECTION);
    expect(
      selectWorkspaceDefaultReconciliation(
        { connectionId: 'conn-admin', model: 'm' },
        [SETUP_CONNECTION, { ...ADMIN_CONNECTION, credentialRejected: true }],
        SETUP_SELECTION,
      ),
    ).toEqual(SETUP_SELECTION);
  });

  // PR #403 review: ownership is never decided by a row's name.
  it("keeps any working default, including one on a row named like setup's own", () => {
    for (const existing of [
      { connectionId: 'conn-admin', model: 'claude-opus-4-5' },
      { connectionId: 'conn-setup', model: 'claude-haiku-4-5' },
      { connectionId: 'conn-old-setup', model: 'gpt-5.1' },
    ]) {
      expect(
        selectWorkspaceDefaultReconciliation(existing, CONNECTIONS, SETUP_SELECTION),
      ).toBeNull();
    }
  });
});

describe('selectGeneralReconciliation (issue #393)', () => {
  const profiles: readonly SetupProfileView[] = [
    { id: 'profile-setup' },
    { id: 'profile-old-setup' },
    { id: 'profile-admin' },
  ];
  const setup = { runtimeProfileId: 'profile-setup', ...SETUP_SELECTION };
  const general = { name: 'General', runtimeProfileId: null, modelConnectionId: null } as const;

  it("gives an unconfigured General setup's runtime and leaves its model inheriting", () => {
    expect(selectGeneralReconciliation(general, profiles, CONNECTIONS, setup)).toEqual({
      runtimeProfileId: 'profile-setup',
    });
  });

  it('replaces a missing runtime profile and a broken model connection', () => {
    expect(
      selectGeneralReconciliation(
        { ...general, runtimeProfileId: 'profile-deleted', modelConnectionId: 'conn-deleted' },
        profiles,
        CONNECTIONS,
        setup,
      ),
    ).toEqual({
      runtimeProfileId: 'profile-setup',
      modelConnectionId: 'conn-setup',
      model: 'claude-sonnet-4-5',
    });
    expect(
      selectGeneralReconciliation(
        { ...general, runtimeProfileId: 'profile-admin', modelConnectionId: 'conn-admin' },
        profiles,
        [SETUP_CONNECTION, { ...ADMIN_CONNECTION, credentialRejected: true }],
        setup,
      ),
    ).toEqual({ modelConnectionId: 'conn-setup', model: 'claude-sonnet-4-5' });
  });

  it('preserves a working runtime and model whatever they are named, and ignores other agents', () => {
    expect(
      selectGeneralReconciliation(
        { ...general, runtimeProfileId: 'profile-admin', modelConnectionId: 'conn-admin' },
        profiles,
        CONNECTIONS,
        setup,
      ),
    ).toBeNull();
    // A different row named like setup's own ("local default", "openai default") is kept.
    expect(
      selectGeneralReconciliation(
        { ...general, runtimeProfileId: 'profile-old-setup', modelConnectionId: 'conn-old-setup' },
        profiles,
        CONNECTIONS,
        setup,
      ),
    ).toBeNull();
    expect(
      selectGeneralReconciliation({ ...general, name: 'Research' }, profiles, CONNECTIONS, setup),
    ).toBeNull();
  });
});
