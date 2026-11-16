import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { MemoryLeadStore } from '../../demo/adapters/leads/memory';

import type { EmailLinkCompositionDependencies } from '../../email-link/transport/composition';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { readWebSettings } from '../../settings';
import {
  demoDriverEnforcesNoNetwork,
  demoRuntimeDriverOf,
  demoSkillsOf,
  demoTemplatesOf,
  wireEmailLink,
} from './email-link';

const leads = new MemoryLeadStore();
const scopesOfNothing = createInMemoryWorkspaceScopeResolver([]);

/** A repository that holds nothing: wiring never calls it before a link is asked for. */
const repository: EmailLinkCompositionDependencies['loginTokens'] = {
  reserve: () => Promise.resolve(false),
  release: () => Promise.resolve(),
  consume: () => Promise.resolve(false),
};

function wire(settings: {
  emailLinkBaseUrl: string | null;
  emailLinkSender: string | null;
  emailLinkChallenge?: string | null;
}) {
  return wireEmailLink({
    root: { loginTokens: repository, storeLeads: leads, scopes: scopesOfNothing },
    directory: createMemoryDirectory(),
    domains: { agents: createInMemoryAgentStoreProvider(), connectors: null, files: {} },
    settings: {
      emailLinkChallenge: null,
      ...settings,
      demo: readWebSettings({}).demo,
      demoAnthropicApiKey: null,
    },
    clientIdentity: { trustedProxyHops: null, sessionSecret: null },
  });
}

describe('wireEmailLink', () => {
  it('stops start-up on a sender name no adapter provides, naming the variable', () => {
    expect(() =>
      wire({ emailLinkBaseUrl: 'https://store.example.test', emailLinkSender: 'nobody' }),
    ).toThrow(/AW_EMAIL_LINK_SENDER "nobody"/u);
  });

  it('stops start-up on a challenge name no adapter provides, naming the variable', () => {
    expect(() =>
      wire({
        emailLinkBaseUrl: 'https://store.example.test',
        emailLinkSender: null,
        emailLinkChallenge: 'nobody',
      }),
    ).toThrow(/AW_EMAIL_LINK_CHALLENGE "nobody"/u);
  });

  it('serves, but refuses to issue, when no sender or no base URL is configured', async () => {
    for (const settings of [
      { emailLinkBaseUrl: null, emailLinkSender: null },
      { emailLinkBaseUrl: 'https://store.example.test', emailLinkSender: null },
    ]) {
      const runtime = wire(settings);
      if (runtime.kind !== 'ready') throw new Error('expected a ready runtime');
      await expect(
        runtime.service.issue({
          email: 'a@example.test',
          challenge: 'answer',
          headers: new Headers(),
        }),
      ).resolves.toEqual({ kind: 'refused', code: 'email_link_unavailable' });
    }
  });
});

describe('demoTemplatesOf', () => {
  const agents = createInMemoryAgentStoreProvider();
  const entry = 'crm-sales';

  it('offers no demo, and copies nothing, where the deployment has no object storage', async () => {
    const templates = demoTemplatesOf(
      { agents, agentResources: undefined, agentGrants: undefined, connectors: null, files: {} },
      scopesOfNothing,
      createMemoryDirectory(),
    );
    expect(await templates.exists(entry)).toBe(false);
    await expect(
      templates.copyInto({
        entry,
        workspaceId: 'w',
        guestUserId: 'u',
        limits: { maxTurns: null, maxBudgetUsd: null },
        now: new Date(0),
      }),
    ).rejects.toThrow(/no demo templates/u);
  });
});

describe('demoSkillsOf', () => {
  const runtime = {
    resolveWorkspace: () => Promise.resolve({ kind: 'unauthenticated' as const, reason: 'none' }),
    store: {
      forWorkspace: () => {
        throw new Error('never read while wiring');
      },
    },
  };

  it('is none where the skills domain is not serving, or keeps no catalog', () => {
    expect(demoSkillsOf({ kind: 'unavailable' })).toBeNull();
    expect(demoSkillsOf({ kind: 'serving', runtime })).toBeNull();
  });
});

describe('demoRuntimeDriverOf', () => {
  it("is the runner manager's driver where one allocates the runtime, docker unless RUNTIME_DRIVER says", () => {
    expect(demoRuntimeDriverOf({ runnerManager: true, env: {} })).toBe('docker');
    expect(
      demoRuntimeDriverOf({ runnerManager: true, env: { RUNTIME_DRIVER: 'cloud-run-service' } }),
    ).toBe('cloud-run-service');
  });

  it('is none on the local driver, which cannot enforce no network, and where no runtime is configured', () => {
    expect(
      demoRuntimeDriverOf({ runnerManager: false, env: { RUNNER_URL: 'http://runner:8080' } }),
    ).toBeNull();
    expect(
      demoRuntimeDriverOf({ runnerManager: true, env: { RUNTIME_DRIVER: 'local' } }),
    ).toBeNull();
    expect(demoRuntimeDriverOf({ runnerManager: false, env: {} })).toBeNull();
  });
});

describe('demoDriverEnforcesNoNetwork', () => {
  it('is false for the local driver and true for a driver no registry restricts', async () => {
    expect(await demoDriverEnforcesNoNetwork('local')).toBe(false);
    expect(await demoDriverEnforcesNoNetwork('docker')).toBe(true);
  });
});
