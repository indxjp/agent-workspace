import { describe, expect, it } from 'vitest';

import type { StoreLeadRepository } from '../../demo/adapters/leads/store';
import type { DemoCapsRepository } from '../../demo/caps/adapters/admissions/store';
import { readWebSettings } from '../../settings';
import { wireStore } from './store';

const root = {
  storeLeads: {} as StoreLeadRepository,
  demoCaps: { demoExpiresAt: () => Promise.resolve(null) } as unknown as DemoCapsRepository,
};
const identity = { trustedProxyHops: null, sessionSecret: null };

const wire = (env: Record<string, string>) =>
  wireStore({ root, settings: readWebSettings(env), clientIdentity: identity });

describe('wireStore', () => {
  it('states no retention period until the deployment sets one, and the demo lifetime in hours', () => {
    expect(wire({}).privacy).toEqual({ leadRetentionDays: null, demoWorkspaceHours: 24 });
    expect(wire({ AW_STORE_LEAD_RETENTION_DAYS: '90' }).privacy.leadRetentionDays).toBe(90);
  });

  it('names the store origin from the email-link base URL, none while unset', () => {
    expect(wire({}).baseUrl).toBeNull();
    expect(wire({ AW_EMAIL_LINK_BASE_URL: 'https://store.example.test/signin' }).baseUrl).toBe(
      'https://store.example.test/signin',
    );
  });

  it('takes no lead where no challenge is configured, and stops start-up on an unknown one', () => {
    expect(wire({}).leads).toBeNull();
    expect(() => wire({ AW_EMAIL_LINK_CHALLENGE: 'nobody' })).toThrow(/AW_EMAIL_LINK_CHALLENGE/u);
  });

  it('reads no allowance for a workspace that is not a demo workspace', async () => {
    const store = wire({ AW_DEMO_RUNS_PER_PERSON_PER_DAY: '7' });
    expect(await store.allowance?.read('w', 'u')).toBeNull();
  });
});
