import { DEMO_WORKSPACE_LIFETIME_SECONDS } from '@indx-workspace/contracts/email-link';

import type { ClientIdentitySettings } from '../../client-identity';
import { systemClock } from '../../clock';
import { createDemoRunAdmissions } from '../../demo/caps/adapters/admissions/store';
import type { DemoCapsRepository } from '../../demo/caps/adapters/admissions/store';
import { createDemoAllowance } from '../../demo/caps/transport/allowance';
import { createLeadStore, type StoreLeadRepository } from '../../demo/adapters/leads/store';
import { createStoreLeadService } from '../../demo/storefront/leads';
import type { StoreRuntime } from '../../demo/storefront/transport/routes';
import { createChallengeVerifier } from '../../email-link/adapters/challenge/production';
import { createDisposableEmailList } from '../../email-link/adapters/disposable/disposable';
import type { WebSettings } from '../../settings';

const SECONDS_PER_HOUR = 60 * 60;

/**
 * The Agent Store's lead form, privacy facts and demo allowance, for the composition root to
 * install as `ApplicationContext.store`. The lead form uses the same challenge adapter as the
 * email-link sign-in (`AW_EMAIL_LINK_CHALLENGE`); with none configured it answers
 * `503 store_lead_unavailable`. The allowance counts in the table the run-start caps count in.
 */
export function wireStore(input: {
  readonly root: {
    readonly storeLeads: StoreLeadRepository;
    readonly demoCaps: DemoCapsRepository;
  };
  readonly settings: Pick<WebSettings, 'emailLinkBaseUrl' | 'emailLinkChallenge' | 'demo'>;
  readonly clientIdentity: ClientIdentitySettings;
}): StoreRuntime {
  const { root, settings } = input;
  const challenge = createChallengeVerifier(settings.emailLinkChallenge);
  return {
    baseUrl: settings.emailLinkBaseUrl,
    privacy: {
      leadRetentionDays: settings.demo.leadRetentionDays,
      demoWorkspaceHours: DEMO_WORKSPACE_LIFETIME_SECONDS / SECONDS_PER_HOUR,
    },
    leads:
      challenge === null
        ? null
        : createStoreLeadService({
            clock: systemClock,
            clientIdentity: input.clientIdentity,
            challenge,
            disposable: createDisposableEmailList(),
            leads: createLeadStore(root.storeLeads),
          }),
    allowance: createDemoAllowance({
      runsPerPersonPerDay: settings.demo.runsPerPersonPerDay,
      admissions: createDemoRunAdmissions(root.demoCaps),
      demoExpiresAt: (workspaceId) => root.demoCaps.demoExpiresAt(workspaceId),
      clock: systemClock,
    }),
  };
}
